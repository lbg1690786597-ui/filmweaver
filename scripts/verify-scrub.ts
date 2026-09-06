/**
 * verify-scrub.ts — 拖播放头的节流 + `preload="metadata"`（批次 3 / 3.4）
 *
 * ## 验收标准（路线图原文）
 *
 *   「scrub 节流 + `preload="metadata"`；⚠️ `Player.tsx` 的 `key` 保留（§0.5(g)）」
 *
 * ## 被节流的到底是什么（决定了怎么测）
 *
 * 不是"计算量"—— 挪一条线是几乎零成本的。真正昂贵的是**换预览源**：
 * `previewUrl` 一变，`<video>` 就按 `key` 重建，新元素重新去拉整个素材文件。
 * 默认 12px/s 下拖过 1200px 会扫过约 20 个镜头 = 20 次元素重建 + 20 个几十毫秒
 * 后就作废的整片下载。所以本脚本测的是 **commit（换源）的次数**，
 * 而不是"函数被调了几次"。
 *
 * 与 2.2 同一套办法：注入假时钟与假 rAF，模拟一整串真实 mousemove 再断言次数，
 * 而不是跑真实时间去赌。
 *
 *   ① 拖 180 帧（3 秒 @60fps）只换 **1 次**源；线仍每帧都跟手。
 *   ② 单击必须**同步**见效 —— `start` 不排 rAF，否则点一下刻度尺要等一帧。
 *   ③ 松手时先把压着的那一帧补画完再提交，否则线停在上一帧、画面跳到松手处。
 *   ④ 停稳 120ms 也提交 —— 只在松手时提交的话，慢慢拖着找镜头的用户全程看不到
 *      画面变化（"拖动时预览是瞎的"）。
 *   ⑤ 停稳提交过之后松手**不重复提交**（同一位置提交两次 = 白重建一遍 `<video>`）。
 *   ⑥ `dispose` 不提交：组件卸载时换源没有意义，还会往已卸载的树里写状态。
 *   ⑦ 静态守卫：`Player.tsx` 的 `key` 与 `preload` **必须同时在**；
 *      `App.movePlayheadTo` 必须认 `crossShot:false`；
 *      `Timeline` 不许再退回"每个 mousemove 都 seek"。
 *
 * ⑦ 之所以是静态扫源码：这几处被"顺手简化"掉之后**功能完全正常**，
 * 只是每拖一次播放头多打几十兆流量、多建几十个解码器 —— 没有报错、没有崩溃，
 * 任何运行时断言都逮不到。§0.5(g) 记的 `key` 尤其如此：删掉它连播照样"能用"，
 * 只是不再自动播；那种回归要靠人肉点才能发现。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createScrubber, SCRUB_SETTLE_MS } from "../src/features/timeline/scrub";
import type { ScrubPhase } from "../src/features/timeline/scrub";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const okv = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okv) failed++;
  console.log(`  ${okv ? "✅" : "❌"} ${name}`);
  if (!okv) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/** 假时钟：只有显式 advance 才让到期回调跑。拖动中就是"从不到期"。 */
function fakeClock() {
  let now = 0, id = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (fn: () => void, ms: number) => { jobs.set(++id, { at: now + ms, fn }); return id; },
    cancel: (t: unknown) => { jobs.delete(t as number); },
    advance(ms: number) {
      now += ms;
      for (const [k, j] of [...jobs]) if (j.at <= now) { jobs.delete(k); j.fn(); }
    },
    pending: () => jobs.size,
  };
}

/** 假 rAF：攒着不跑，`flush()` 才画一帧 —— 浏览器每 16ms 做一次的那件事。 */
function fakeRaf() {
  let h = 0;
  const q = new Map<number, () => void>();
  return {
    raf: (fn: () => void) => { q.set(++h, fn); return h; },
    cancelRaf: (id: number) => { q.delete(id); },
    flush() { const all = [...q.values()]; q.clear(); all.forEach((f) => f()); },
    pending: () => q.size,
  };
}

interface Emit { sec: number; phase: ScrubPhase }
function rig(settleMs?: number) {
  const clock = fakeClock(), frames = fakeRaf();
  const emits: Emit[] = [];
  const s = createScrubber({
    emit: (sec, phase) => emits.push({ sec, phase }),
    settleMs,
    raf: frames.raf, cancelRaf: frames.cancelRaf,
    schedule: clock.schedule, cancel: clock.cancel,
  });
  const of = (p: ScrubPhase) => emits.filter((e) => e.phase === p);
  return { s, clock, frames, emits, of };
}

/* ------------------------------------------------------------------ */
console.log("\n① 拖 3 秒 180 帧：线每帧都跟手，但只换 1 次预览源");
{
  const { s, clock, frames, emits, of } = rig();
  s.start(0);
  // 真实 mousemove 比 rAF 密（鼠标常见 125~1000Hz），所以每帧塞 3 个事件。
  // 拖动全程时钟不推进 —— 手一直在动，settle 永远不到期。
  for (let f = 0; f < 60; f++) {
    for (let k = 0; k < 3; k++) s.move((f * 3 + k + 1) * 0.05);
    frames.flush();
  }
  check("收到 180 次 mousemove", s.stats.moves, 180);
  check("只画了 60 帧（每帧最多挪一次线）", s.stats.frames, 61);   // 60 帧 + start 那次同步的
  check("拖动全程 0 次换源", of("commit").length, 0);
  check("拖动中最后一次挪线在终点", of("move").at(-1)!.sec, 9);

  s.end();
  check("松手换源 1 次", of("commit").length, 1);
  check("换源换到的是松手处", of("commit")[0].sec, 9);
  check("整场拖动 commit 总数 = 1", s.stats.commits, 1);
  check("末尾没有多余的挂起帧", frames.pending(), 0);
  check("松手后不再留计时器", clock.pending(), 0);
  ok("emit 序列以 start 开头", emits[0].phase === "start" && emits[0].sec === 0);
}

/* ------------------------------------------------------------------ */
console.log("\n② 单击刻度尺：同步见效，不等一帧");
{
  const { s, frames, emits } = rig();
  s.start(4.2);
  // 注意：**还没有 flush 任何帧**
  check("按下即已挪线（不排 rAF）",
        emits.map((e) => e.phase), ["start", "move"]);
  check("挪到的就是点击处", emits[1].sec, 4.2);
  check("没有挂起的 rAF", frames.pending(), 0);
  s.end();
  check("松手换源到点击处", emits.filter((e) => e.phase === "commit").map((e) => e.sec), [4.2]);
}

/* ------------------------------------------------------------------ */
console.log("\n③ 松手时先补画压着的那一帧，再提交");
{
  const { s, frames, emits } = rig();
  s.start(0);
  s.move(1); s.move(2); s.move(3);      // 一帧都没 flush，rAF 还压着
  check("确实压着一帧", frames.pending(), 1);
  s.end();
  const tail = emits.slice(-2);
  check("先 move 到终点、再 commit（顺序不能反）",
        tail.map((e) => `${e.phase}@${e.sec}`), ["move@3", "commit@3"]);
  check("补画后不留挂起帧", frames.pending(), 0);
  ok("线与画面落在同一处", tail[0].sec === tail[1].sec,
     "commit 在补画之前发生的话，线停在上一帧、画面跳到松手处，两者对不上");
}

/* ------------------------------------------------------------------ */
console.log("\n④ 停稳 120ms 就提交：慢慢拖着找镜头时预览不是瞎的");
{
  const { s, clock, frames, of } = rig();
  s.start(0);
  s.move(5); frames.flush();
  clock.advance(SCRUB_SETTLE_MS - 1);
  check("差 1ms 还不提交", of("commit").length, 0);
  clock.advance(1);
  check("停稳即提交", of("commit").map((e) => e.sec), [5]);

  // 继续拖到别处，再停稳一次 —— 第二个位置也要能看到
  s.move(9); frames.flush();
  clock.advance(SCRUB_SETTLE_MS);
  check("拖到新位置再停稳会再提交一次", of("commit").map((e) => e.sec), [5, 9]);
  ok("settle 时长在人手可感区间内（50~200ms）",
     SCRUB_SETTLE_MS >= 50 && SCRUB_SETTLE_MS <= 200,
     `SCRUB_SETTLE_MS=${SCRUB_SETTLE_MS}：太短会退化成不节流，太长会让人以为预览坏了`);
}

/* ------------------------------------------------------------------ */
console.log("\n⑤ 停稳提交过之后松手不重复提交");
{
  const { s, clock, frames, of } = rig();
  s.start(0);
  s.move(7); frames.flush();
  clock.advance(SCRUB_SETTLE_MS);
  check("停稳提交 1 次", of("commit").length, 1);
  s.end();
  check("松手不再提交同一个位置", of("commit").length, 1);

  // 但换一次拖动就该重新算：同一个位置再点一下也要提交
  // （上一次拖动提交在哪儿，与这一次能不能省掉提交无关）
  s.start(7);
  s.end();
  check("新一次拖动到同一位置仍会提交", of("commit").map((e) => e.sec), [7, 7]);
}

/* ------------------------------------------------------------------ */
console.log("\n⑥ dispose 不提交、也不留下待办");
{
  const { s, clock, frames, of } = rig();
  s.start(0);
  s.move(3);
  s.dispose();
  check("dispose 后无挂起帧", frames.pending(), 0);
  check("dispose 后无挂起计时器", clock.pending(), 0);
  clock.advance(10_000);
  frames.flush();
  check("卸载后不会再换源", of("commit").length, 0);
}

/* ------------------------------------------------------------------ */
console.log("\n⑦ 静态守卫：省掉这些不会报错，只会静默变慢");

const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/* Player：key 与 preload 必须同时在 */
{
  const s = src("src/features/editor/Player.tsx");
  const i = s.indexOf("<video key={p.previewUrl}");
  ok("Player 的 <video> 仍带 key={p.previewUrl}（§0.5(g)：删了连播不再自动播）", i > 0);
  const tag = s.slice(i, s.indexOf("/>", i));
  ok("同一个 <video> 上有 preload=\"metadata\"",
     /preload="metadata"/.test(tag),
     "缺省是 preload=\"auto\"：每换一次镜头就尽力下整片，而拖动时它们几乎都会被 abort");
  ok("autoPlay 仍在（preload 只是提示，播放请求会覆盖它）",
     /autoPlay/.test(tag));
}

/* 所有 JSX 里的 <video> 都要有 preload —— 每一个都是 key 挂的换源点 */
{
  /** 去掉注释再扫。App.tsx 的注释里就写着 `<video autoPlay>`（讲的正是这件事），
   *  不去注释会把它当成一处漏网的真标签。逐字符扫是为了不误伤字符串里的 `//`
   *  （URL）和模板串。 */
  const stripComments = (s: string) => {
    let out = "", i = 0;
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") {
        i += 2;
        while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
        i += 2; continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        out += c; i++;
        while (i < s.length && s[i] !== c) { if (s[i] === "\\") { out += s[i]; i++; } out += s[i]; i++; }
        out += s[i] ?? ""; i++; continue;
      }
      out += c; i++;
    }
    return out;
  };

  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".tsx")) files.push(p);
    }
  };
  walk(join(ROOT, "src"));
  const missing: string[] = [];
  let total = 0;
  for (const f of files) {
    const s = stripComments(readFileSync(f, "utf8"));
    // JSX 开标签：`<video` 后面直接跟属性名
    for (const m of s.matchAll(/<video\s+[a-zA-Z]/g)) {
      total++;
      const end = s.indexOf("/>", m.index!);
      if (!/preload="metadata"/.test(s.slice(m.index!, end < 0 ? m.index! + 800 : end))) {
        missing.push(`${f.slice(ROOT.length + 1)}:${s.slice(0, m.index!).split("\n").length}`);
      }
    }
  }
  ok(`全部 ${total} 处 <video> 都声明了 preload="metadata"`,
     missing.length === 0, missing.join(", "));
  ok("确实扫到了 <video>（正则失配会让本项假绿）", total >= 4);
}

/* App：拖动中的帧不许换源 */
{
  const s = src("src/App.tsx");
  const i = s.indexOf("const movePlayheadTo");
  ok("App 有 movePlayheadTo", i > 0);
  const body = s.slice(i, s.indexOf("const [shuttle", i));
  ok("movePlayheadTo 接受 crossShot 选项",
     /movePlayheadTo = \(sec: number, opts\?: \{ crossShot\?: boolean \}\)/.test(body));
  ok("crossShot:false 时直接返回，不走 seekTo",
     /crossShot === false\) \{ setPlayhead\(null\); return; \}/.test(body),
     "这一支是 3.4 的全部收益所在：少了它，拖动仍是每帧重建 <video>");
  ok("crossShot:false 那一支把 playhead 置空",
     body.indexOf("crossShot === false") < body.indexOf("seekTo(shot, pos!.offsetSec"),
     "不置空的话播放器停在别的镜头上，它的 timeupdate 会把线拽回去");
  ok("同镜内仍然 seek（换源才贵，改 currentTime 不贵）",
     /previewShot\?\.id === shot\.id[\s\S]{0,400}v\.currentTime = toMediaTime/.test(body));

  const j = s.indexOf("const onScrub = (sec: number, phase: ScrubPhase)");
  ok("App 有 onScrub 处理器", j > 0);
  const h = s.slice(j, j + 260);
  ok("start 阶段停掉快进/快退并暂停",
     /phase === "start"\) stopShuttle\(\)/.test(h),
     "边播边拖：timeupdate 与拖动会轮流写播放头，线在两个位置之间跳");
  ok("只有 move 阶段禁止换源（start/commit 都要跟）",
     /crossShot: phase !== "move"/.test(h));
  ok("Timeline 挂的是 onScrub", /onScrub=\{onScrub\}/.test(s));
  ok("Timeline 不再挂 onSeek（那是 3.4 之前每帧换源的老路）",
     !/<Timeline[\s\S]{0,3000}onSeek=/.test(s));
}

/* Timeline / Ruler：三个阶段都要接上，且共用同一个 scrubber */
{
  const s = src("src/features/timeline/Timeline.tsx");
  ok("Timeline 的 prop 是 onScrub(sec, phase)",
     /onScrub: \(sec: number, phase: ScrubPhase\) => void/.test(s));
  ok("不再有 onRulerScrub 这类每帧 seek 的中转",
     !/onRulerScrub/.test(s));
  ok("scrubber 惰性建一次（useRef(createScrubber(…)) 每次渲染都白建一个）",
     /useRef<Scrubber \| null>\(null\)[\s\S]{0,200}if \(!scrubber\.current\)/.test(s));
  ok("emit 经 ref 转发到最新的 onScrub",
     /scrubRef\.current = p\.onScrub/.test(s)
     && /emit: \(sec, phase\) => scrubRef\.current\(sec, phase\)/.test(s),
     "直接闭包 p.onScrub 的话，拖动期间来一次 refreshDetail 就按旧 detail 算了");
  ok("卸载时 dispose", /return \(\) => s\?\.dispose\(\)/.test(s));
  const grip = s.slice(s.indexOf("scrubber.current?.start(s0)") - 400);
  ok("播放头把手与刻度尺共用同一个 scrubber",
     /scrubber\.current\?\.start\(s0\)/.test(grip)
     && /scrubber\.current\?\.move\(/.test(grip)
     && /scrubber\.current\?\.end\(\)/.test(grip),
     "两个拖动入口各自实现的话，手感必然漂移");

  const r = src("src/features/timeline/TimelineRuler.tsx");
  ok("Ruler 把 down/move/up 转成 start/move/end 三个阶段",
     /p\.onScrubStart\(secAt/.test(r)
     && /onMove = \(ev: MouseEvent\) => p\.onScrubMove\(secAt/.test(r)
     && /p\.onScrubEnd\(\)/.test(r));
  ok("onScrubEnd 在摘掉监听之后调（漏调 = 松手后永不换源）",
     r.indexOf('removeEventListener("mouseup"') < r.indexOf("p.onScrubEnd()"));
}

/* ------------------------------------------------------------------ */
console.log(failed === 0
  ? "\n✅ 3.4 通过：拖 3 秒 180 帧 → 60 帧跟手、只换 1 次预览源；<video> 全部 preload=metadata"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
