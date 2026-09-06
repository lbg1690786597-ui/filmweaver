/**
 * verify-prefetch.ts — AI 产物即时落盘：基线不下、增量才下、导出优先（批次 6 / 6.2）
 *
 * ## 这条为什么必须真跑，而不是 grep 几行接线
 *
 * 6.2 的全部风险都在**语义**上，而语义是 grep 看不见的东西。三条最贵的：
 *
 * 1. **「打开老项目 = 静默拉几十 GB」**。前端得知 URL 的唯一途径是整份
 *    `ProjectDetail` 快照，它不带「哪几个是新出的」。照直理解成"detail 里有的都下"，
 *    用户点开一个 601 镜的旧项目、只想看眼分镜，后台就开始吃他的带宽和硬盘。
 *    所以基线那一条（**第一次见到只记账、一件都不下**）是本条目最承重的性质，
 *    ② 段全部在钉它。
 * 2. **两条通道共用一个桶**。镜头视频走 `useProject`、旁白走 `useAudioTrack`，
 *    各调各的 `warmNew`。基线若只按 projectId 分桶，先到的那条建桶、
 *    后到的那条就 `firstSight === false` → 把自己的 URL **全部**当成新出炉的 ——
 *    正好触发风险 1，而且是静默的。③ 段专钉这个。
 *    （这个 bug 是接第二个调用点时才发现的，说明"想清楚了"不等于"测过了"。）
 * 3. **预取抢导出的带宽**。④ 段钉并发恒 1、pause 掐当前件、resume 接着跑。
 *
 * ## 与 6.1 的接缝：pause 为什么不会伤到导出
 *
 * `pause()` 会 abort 当前预取件。这在 6.1 的**引用计数**取消模型下是安全的——
 * 两边要同一个 URL 时挂在同一次飞行上，预取撤走只是等待者减一。
 * 但这是**跨模块**的性质，光看 `prefetch.ts` 看不出来，所以 ⑤ 段把真的
 * `makeEnsureCached` 接上真的 `makePrefetcher` 跑一遍，证明这条接缝成立。
 * 不接就等于把最关键的那句话留在注释里当声称。
 *
 * ## 注入的是什么
 *
 * `lib/prefetch.ts` 不 import 任何东西（除了 `Aborted` 和一个 type），
 * 与 `cacheName.ts` / `cacheFetch.ts` 同一个理由：`mediaCache.ts` 必须
 * `import { api }`，而 `api.ts` 顶层读 `import.meta.env`，node 下 import 即抛。
 * 所以这里 import 到的是**产品里真正在跑的那一份规则**，只是把 `ensureCached`
 * 换成了一个可控的假货。
 *
 * 跑法：npx tsx scripts/verify-prefetch.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Aborted } from "../src/lib/aborted";
import { makePrefetcher, type Prefetcher } from "../src/lib/prefetch";
import { makeEnsureCached, type CacheIO } from "../src/lib/cacheFetch";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

const PREFETCH = read("lib/prefetch.ts");
const MEDIACACHE = read("lib/mediaCache.ts");
const USEPROJECT = read("hooks/useProject.ts");
const USEAUDIO = read("hooks/useAudioTrack.ts");
const APP = read("App.tsx");

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`   ✅ ${msg}`); }
  else { fail++; console.log(`   ❌ ${msg}`); }
}
/** 钉**取值**而不是钉"性质"：数量错了要能一眼看出错成了什么样子 */
function check(msg: string, actual: unknown, expected: unknown, detail = "") {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { pass++; console.log(`   ✅ ${msg}`); return; }
  fail++;
  console.log(`   ❌ ${msg}`);
  console.log(`      期望 ${JSON.stringify(expected)}`);
  console.log(`      实际 ${JSON.stringify(actual)}`);
  if (detail) console.log(`      ${detail}`);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * 假的 `ensureCached`：记录每一次调用、可控放行、可控失败、可观测并发峰值。
 *
 * `gate` 为真时每一件都要等 `release()` 才结束 —— 「并发恒为 1」这条性质
 * 只有在"有东西卡着"的时候才测得出来，一路顺畅跑完的话峰值永远是 1，
 * 那种绿是假绿。
 */
function fakeEnsure(o: { gate?: boolean; failOn?: (url: string) => boolean } = {}) {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  let live = 0, peak = 0;
  const aborts: string[] = [];

  const ensure = (projectId: string, url: string, signal?: AbortSignal) => {
    calls.push(`${projectId}|${url}`);
    live++; peak = Math.max(peak, live);
    const settle = <T,>(v: T | Promise<T>) => { live--; return v; };
    return new Promise<string>((resolve, reject) => {
      const done = () => {
        if (o.failOn?.(url)) { settle(0); reject(new Error(`boom ${url}`)); return; }
        settle(0); resolve(`/cache/${url}`);
      };
      if (signal) {
        signal.addEventListener("abort", () => {
          aborts.push(url); settle(0); reject(new Aborted());
        }, { once: true });
      }
      if (o.gate) pending.push(done);
      else setTimeout(done, 0);
    });
  };

  return {
    ensure,
    calls,
    aborts,
    peak: () => peak,
    /** 放行队列里已经发出的那些（gate 模式） */
    release() { const ps = pending.splice(0); for (const p of ps) p(); },
  };
}

const P = "proj-1";
const V = (n: number) => `/fw/media/${P}/shot-${String(n).padStart(3, "0")}/output.mp4`;

/** 建一个已经过了基线的预取器：项目已见过，之后进来的才算新的。 */
function primed(f: ReturnType<typeof fakeEnsure>, base: string[] = [V(1), V(2)]) {
  const pf = makePrefetcher(f.ensure, { enabled: () => true, onError: () => {} });
  pf.warmNew(P, "shots", base);
  return pf;
}

// ───────────────────────────────────────────────────────────── ①
console.log("\n① 空输入与开关：不该下的时候一件都不下");

{
  const f = fakeEnsure();
  const off = makePrefetcher(f.ensure, { enabled: () => false });
  // 浏览器（`/fw/app/`）里 appDataDir() 调了必抛，落盘整条路不存在。
  check("enabled()===false 时 warmNew 返回 0", off.warmNew(P, "shots", [V(1)]), 0);
  check("  且一次都没调 ensureCached", f.calls.length, 0);
  check("  连基线都不建（白占内存）", off.stats().projects, 0);
}

{
  const f = fakeEnsure();
  const pf = makePrefetcher(f.ensure, { enabled: () => true });
  check("projectId 为空串时直接返回 0", pf.warmNew("", "shots", [V(1)]), 0);
  check("  没有留下任何桶", pf.stats().projects, 0);
}

{
  const f = fakeEnsure();
  const pf = primed(f, []);
  // 镜头还没出片时 video_url 是 null；调用方不该被迫自己过滤。
  check("null / undefined / 空串一律跳过",
    pf.warmNew(P, "shots", [null, undefined, "", null]), 0);
  check("  没有排队", pf.stats().queued, 0);
}

// ───────────────────────────────────────────────────────────── ②
console.log("\n② 基线：第一次见到只记账，一件都不下 ★ 本条目最承重的性质");

{
  const f = fakeEnsure();
  const pf = makePrefetcher(f.ensure, { enabled: () => true });

  // ★ 打开一个 601 镜的老项目。照"detail 里有的都下"写，这里就是几十 GB。
  const old = Array.from({ length: 601 }, (_, i) => V(i));
  check("首次见到项目：601 个 URL，入队 0 件", pf.warmNew(P, "shots", old), 0);
  check("  ensureCached 一次都没被调用", f.calls.length, 0);
  check("  但全部记进了基线", pf.stats().urls, 601);

  // 用户什么都没干，只是又刷新了一次（SSE / 800ms 合并刷新会打很多次）
  check("原样再报一次：仍然 0 件", pf.warmNew(P, "shots", old), 0);
  check("  重复刷新不会把基线里的东西再排一遍", f.calls.length, 0);

  // ★ 一个 AI 任务完成了 → detail 里多出一个 URL
  check("多出 1 个新 URL：入队恰好 1 件", pf.warmNew(P, "shots", [...old, V(999)]), 1);
  check("  入队的是新的那一个，不是全部", pf.stats().queued + pf.stats().inFlight, 1);
}

{
  const f = fakeEnsure();
  const pf = primed(f, [V(1)]);
  pf.warmNew(P, "shots", [V(1), V(2)]);
  await pf.idle();
  check("新 URL 真的被下了，且只下它一个", f.calls, [`${P}|${V(2)}`]);
}

{
  const f = fakeEnsure();
  const pf = primed(f, [V(1)]);
  // 同一次快照里同一个 URL 出现两次（不同镜头指向同一素材是合法的）
  check("同一次调用内的重复项只算一次", pf.warmNew(P, "shots", [V(2), V(2), V(2)]), 1);
}

{
  const f = fakeEnsure();
  const pf = primed(f, [V(1)]);
  pf.warmNew(P, "shots", [V(1), V(2)]);
  await pf.idle();
  // 下完之后又刷新一次 —— 已经在基线里，不该再下一遍
  check("已下过的 URL 不会因为再次出现而重下",
    pf.warmNew(P, "shots", [V(1), V(2)]), 0);
  check("  累计调用数不变", f.calls.length, 1);
}

{
  // 切走再切回来：**不该**重新建基线（那会让整个项目重新排一次队）
  const f = fakeEnsure();
  const pf = primed(f, [V(1), V(2)]);
  pf.warmNew("proj-2", "shots", ["/fw/media/proj-2/a.mp4"]);   // 去了别的项目
  check("回到旧项目：仍是增量语义，不重新基线",
    pf.warmNew(P, "shots", [V(1), V(2)]), 0);
  check("  两个项目各自记账", pf.stats().projects, 2);
}

{
  // ⚠️ 必须用 gate 卡住：不卡的话 `warmNew` 里的 `wake()` 会同步把队头取走开跑，
  // 等走到 `forget()` 时队列**本来就是空的** —— 那条"排队项也一并清掉"就成了
  // 对着空气的断言（变异测试逮到过：把清队列那几行整个删掉，它照样绿）。
  const f = fakeEnsure({ gate: true });
  const pf = makePrefetcher(f.ensure, { enabled: () => true, onError: () => {} });
  pf.warmNew(P, "shots", [V(1)]);
  pf.warmNew("proj-2", "shots", ["/fw/media/proj-2/a.mp4"]);
  pf.warmNew(P, "shots", [V(1), V(2), V(3), V(4)]);
  pf.warmNew("proj-2", "shots", ["/fw/media/proj-2/a.mp4", "/fw/media/proj-2/b.mp4"]);
  await tick();
  check("forget 前队里确实有东西（否则下一条断言测不到东西）", pf.stats().queued, 3);

  pf.forget(P);
  check("forget 之后该项目回到未见过状态", pf.stats().projects, 1);
  check("  该项目的排队项一并清掉", pf.stats().queued, 1);
  check("  再报一次是重新建基线（0 件）", pf.warmNew(P, "shots", [V(1), V(2)]), 0);

  // 剩下的那 1 件必须是**别的项目**的：forget 是按项目切的，不是清空队列。
  f.release(); await tick(); f.release(); await pf.idle();
  check("  别的项目的排队项不受牵连（被清掉的是 V3/V4，活下来的是 proj-2 的 b）",
    f.calls, [`${P}|${V(2)}`, "proj-2|/fw/media/proj-2/b.mp4"]);
}

// ───────────────────────────────────────────────────────────── ③
console.log("\n③ 通道隔离：两条通道不能共用一个桶（接第二个调用点时才发现的 bug）");

{
  const f = fakeEnsure();
  const pf = makePrefetcher(f.ensure, { enabled: () => true });
  const audio = ["/fw/media/proj-1/tts/a.mp3", "/fw/media/proj-1/tts/b.mp3"];
  const shots = Array.from({ length: 601 }, (_, i) => V(i));

  // 打开老项目：音频那条先跑（真实顺序不定，两边都要能扛）
  check("audio 通道首次：0 件", pf.warmNew(P, "audio", audio), 0);
  // ★ 若基线只按 projectId 分桶，这里会返回 601 —— 静默拉几十 GB
  check("shots 通道首次：仍然 0 件（桶按 项目×通道 分）",
    pf.warmNew(P, "shots", shots), 0);
  check("  ensureCached 一次都没被调用", f.calls.length, 0);

  // 反过来的顺序也要成立
  const pf2 = makePrefetcher(f.ensure, { enabled: () => true });
  check("反序：shots 先、audio 后，也都是 0 件",
    pf2.warmNew(P, "shots", shots) + pf2.warmNew(P, "audio", audio), 0);

  // 两条通道各自的增量互不干扰
  check("audio 增量：只入队新旁白", pf.warmNew(P, "audio", [...audio, "/fw/media/proj-1/tts/c.mp3"]), 1);
  check("shots 增量：只入队新镜头", pf.warmNew(P, "shots", [...shots, V(999)]), 1);
  check("  两条通道分别记账", pf.stats().projects, 1);
}

{
  const f = fakeEnsure();
  const pf = makePrefetcher(f.ensure, { enabled: () => true });
  pf.warmNew(P, "shots", [V(1)]);
  pf.warmNew(P, "audio", ["/a.mp3"]);
  pf.forget(P);
  // 只 delete(projectId) 会留下 `<pid>\naudio` 这种孤儿桶 → 该通道从此永远
  // "见过"，forget 等于没生效。
  check("forget 按前缀整片删，不留孤儿桶", pf.stats().urls, 0);
  check("  两条通道都回到未见过", pf.warmNew(P, "audio", ["/a.mp3"]), 0);
}

// ───────────────────────────────────────────────────────────── ④
console.log("\n④ 泳道：并发恒 1，导出优先，失败不拖累后面的");

{
  const f = fakeEnsure({ gate: true });
  const pf = primed(f, [V(0)]);
  pf.warmNew(P, "shots", [V(0), V(1), V(2), V(3), V(4)]);
  await tick();
  // ★ 卡住不放行时才测得出峰值；一路顺畅跑完的话峰值永远是 1，那是假绿。
  check("排了 4 件，同时在飞的只有 1 件", f.calls.length, 1);
  check("  并发峰值 = 1", f.peak(), 1);
  check("  其余 3 件在队里等着", pf.stats().queued, 3);
  f.release(); await tick();
  check("放行 1 件后接着下一件（不是一次全放）", f.calls.length, 2);
  check("  峰值仍是 1", f.peak(), 1);
  f.release(); await tick(); f.release(); await tick(); f.release();
  await pf.idle();
  check("最终 4 件全部下完", f.calls.length, 4);
  check("  统计里 done=4 / failed=0", [pf.stats().done, pf.stats().failed], [4, 0]);
}

{
  // 一件失败不能带走整条泳道 —— 用户没发起这件事，更不该因此少下另外几百件
  const errs: string[] = [];
  const f = fakeEnsure({ failOn: (u) => u === V(2) });
  const pf = makePrefetcher(f.ensure, {
    enabled: () => true, onError: (u) => { errs.push(u); },
  });
  pf.warmNew(P, "shots", [V(0)]);
  pf.warmNew(P, "shots", [V(0), V(1), V(2), V(3)]);
  await pf.idle();
  check("失败件之后的都照常下完", f.calls.length, 3);
  check("  done=2 / failed=1", [pf.stats().done, pf.stats().failed], [2, 1]);
  check("  onError 收到了那一件", errs, [V(2)]);
}

{
  // onError 自己炸了也不能带走泳道（回调是外部代码，不能假设它不抛）
  const f = fakeEnsure({ failOn: (u) => u === V(1) });
  const pf = makePrefetcher(f.ensure, {
    enabled: () => true, onError: () => { throw new Error("回调自己炸了"); },
  });
  pf.warmNew(P, "shots", [V(0)]);
  pf.warmNew(P, "shots", [V(0), V(1), V(2)]);
  await pf.idle();
  check("onError 抛错后泳道继续", f.calls.length, 2);
}

{
  const f = fakeEnsure({ gate: true });
  const pf = primed(f, [V(0)]);
  pf.warmNew(P, "shots", [V(0), V(1), V(2), V(3)]);
  await tick();
  check("pause 前：1 件在飞", pf.stats().inFlight, 1);

  pf.pause();
  await tick();
  // ★ 掐断当前件，不是"等它下完再停"：慢网下那可能是几十秒的继续抢带宽
  check("pause 掐断了当前这一件", f.aborts, [V(1)]);
  check("  被掐的那件放回队列（不算失败）", pf.stats().failed, 0);
  check("  队列里仍是 3 件（掐掉的那件回来了）", pf.stats().queued, 3);
  check("  paused 状态可见", pf.stats().paused, true);

  const before = f.calls.length;
  await pf.idle();     // paused 时 idle 立刻返回，不会挂死
  check("pause 期间不再取新件", f.calls.length, before);

  pf.resume();
  await tick();
  check("resume 后接着跑，且从被掐的那件重来", f.calls[f.calls.length - 1], `${P}|${V(1)}`);
  f.release(); await tick(); f.release(); await tick(); f.release();
  await pf.idle();
  check("  最终 3 件都下完", pf.stats().done, 3);
}

{
  const f = fakeEnsure();
  const pf = primed(f, [V(0)]);
  pf.pause(); pf.pause();          // 可重入
  pf.warmNew(P, "shots", [V(0), V(1)]);
  await tick();
  check("paused 时新件只排队不开跑", f.calls.length, 0);
  pf.resume(); pf.resume();        // 可重入
  await pf.idle();
  check("resume 后补上", f.calls.length, 1);
}

{
  // 队列上限：内存护栏。丢最老的 —— 新出炉的 AI 产物才是用户下一步最可能要的
  const f = fakeEnsure({ gate: true });
  const pf = makePrefetcher(f.ensure, { enabled: () => true, max: 3, onError: () => {} });
  pf.warmNew(P, "shots", [V(0)]);
  pf.warmNew(P, "shots", [V(0), V(1), V(2), V(3), V(4), V(5), V(6)]);
  await tick();
  // 6 件新的、上限 3 → 丢掉最老的 3 件；随后泳道取走 1 件开跑，故队里剩 2。
  check("超上限时队列被裁到 max", pf.stats().queued + pf.stats().inFlight, 3);
  check("  丢弃数可见", pf.stats().dropped, 3);
  // 丢的必须是**最老的**：新出炉的 AI 产物才是用户下一步最可能要的
  check("  丢的是队头（最老的那几件）", f.calls[0], `${P}|${V(4)}`);
}

// ───────────────────────────────────────────────────────────── ⑤
console.log("\n⑤ 与 6.1 的接缝：pause 掐预取，不能掐到导出头上");

{
  // 真的 makeEnsureCached + 真的 makePrefetcher，中间只有一个内存假盘。
  // 这一段证明的是**跨模块**的性质：光看 prefetch.ts 看不出来。
  const disk = new Map<string, Uint8Array>();
  let fetches = 0;
  // 用对象持有而不是裸 let：TS 的控制流分析看不见「回调里会赋值」，
  // 裸 let 会被窄化成 null，到调用处就成了 never。
  const rel: { fn: (() => void) | null } = { fn: null };
  const io: CacheIO = {
    dirFor: async (pid) => `/app/cache/${pid}`,
    join: async (d, n) => `${d}/${n}`,
    exists: async (p) => disk.has(p),
    size: async (p) => disk.get(p)?.length ?? 0,
    remove: async (p) => { disk.delete(p); },
    write: async (p, d) => { disk.set(p, d); },
    rename: async (a, b) => {
      const v = disk.get(a);
      if (!v) throw new Error(`rename: 源不存在 ${a}`);
      disk.delete(a); disk.set(b, v);
    },
    fetch: (_url, signal) => {
      fetches++;
      return new Promise<Uint8Array>((resolve, reject) => {
        rel.fn = () => resolve(new Uint8Array([1, 2, 3]));
        signal.addEventListener("abort", () => reject(new Aborted()), { once: true });
      });
    },
  };
  const ensureCached = makeEnsureCached(io);
  const pf: Prefetcher = makePrefetcher(ensureCached, { enabled: () => true, onError: () => {} });

  const HOT = V(42);
  pf.warmNew(P, "shots", [V(0)]);
  pf.warmNew(P, "shots", [V(0), HOT]);
  await tick();
  check("预取已经在下这个素材", fetches, 1);

  // 导出这时候也要同一个素材 → 6.1 的单飞让它挂上**同一次飞行**
  const exportWants = ensureCached(P, HOT);
  await tick();
  check("导出没有另起一次下载（单飞合流）", fetches, 1);

  // ★ 导出开始 → App.tsx 调 pause() → 预取撤走
  pf.pause();
  await tick();
  check("预取撤走后 fetch 仍未被 abort（还有导出在等）", fetches, 1);

  rel.fn?.();
  const got = await exportWants.then((v) => v, (e) => `拒绝：${String(e)}`);
  check("导出照常拿到本地路径，没被预取的取消殃及",
    typeof got === "string" && got.startsWith("/app/cache/"), true,
    `实际 ${String(got)}`);
  check("  全程只下了一次", fetches, 1);
}

{
  // 反面：没人在等的时候，pause 就该真的把 fetch 掐掉（否则 pause 白搭）
  let aborted = false;
  const io: CacheIO = {
    dirFor: async (pid) => `/app/cache/${pid}`,
    join: async (d, n) => `${d}/${n}`,
    exists: async () => false,
    size: async () => 0,
    remove: async () => {},
    write: async () => {},
    rename: async () => {},
    fetch: (_url, signal) => new Promise<Uint8Array>((_res, rej) => {
      signal.addEventListener("abort", () => { aborted = true; rej(new Aborted()); },
        { once: true });
    }),
  };
  const pf = makePrefetcher(makeEnsureCached(io), { enabled: () => true, onError: () => {} });
  pf.warmNew(P, "shots", [V(0)]);
  pf.warmNew(P, "shots", [V(0), V(7)]);
  await tick();
  pf.pause();
  await tick();
  check("只有预取在等时，pause 真的掐到了 fetch", aborted, true);
}

// ───────────────────────────────────────────────────────────── ⑥
console.log("\n⑥ 接线：规则住在纯模块里，且真的被接到了三个调用点上");

ok(!/from "\.\.\/api"/.test(PREFETCH) && !/@tauri-apps/.test(PREFETCH),
  "prefetch.ts 不 import api / tauri（否则 node 下加载即抛，本脚本就跑不了）");
// 注释里说得出这些名字（文件头正是在解释「为什么不能碰它们」），所以断言必须
// 先把注释剥掉再看 —— 否则这条会被自己的文档判红，然后有人把文档删掉了事。
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok(!/import\.meta\.env/.test(codeOf(PREFETCH)),
  "prefetch.ts 的代码里不读 import.meta.env");
// 规则一旦在接线层再写一遍，验证证明的就是"我抄得对"而不是"产品跑的是什么"。
ok(!/firstSight|inflight|new Set\(\)/.test(
  MEDIACACHE.slice(MEDIACACHE.indexOf("export const prefetcher"))),
  "mediaCache.ts 里只有 makePrefetcher 接线，没有第二份预取规则");
ok(/makePrefetcher\(ensureCached, \{/.test(MEDIACACHE),
  "注入的是**真的** ensureCached（于是与导出共用 6.1 的单飞）");
ok(/enabled: \(\) => IS_TAURI/.test(MEDIACACHE),
  "enabled 是 IS_TAURI：浏览器里 appDataDir() 调了必抛，那里一件都不排");
ok(/from "\.\/isTauri"/.test(MEDIACACHE),
  "IS_TAURI 取自 lib/isTauri.ts，不再从 ExportDialog 拖一个 CSS 进来");

// 调用点：钉的是**调用**，不是 import 那一行（只 grep 函数名会被 import 顶掉，
// 这在 4.5 的变异测试里逮到过一次）。
ok(/prefetcher\.warmNew\(d\.id, "shots", d\.shots\.map\(\(s\) => s\.video_url\)\)/.test(USEPROJECT),
  "useProject 在 setDetail 之后报一次 shots 通道");
ok(USEPROJECT.indexOf("setDetail(d)") < USEPROJECT.indexOf("prefetcher.warmNew"),
  "  且排在 setDetail 之后（先让画面更新，预取是背景噪音）");
ok(/prefetcher\.warmNew\(id, "audio", r\.clips\.map\(\(c\) => c\.url\)\)/.test(USEAUDIO),
  "useAudioTrack 在拿到 clips 之后报一次 audio 通道");
ok(/prefetcher\.pause\(\);/.test(APP) && /prefetcher\.resume\(\);/.test(APP),
  "App.tsx 在导出前后 pause / resume");

{
  // pause 必须在 try 内、resume 必须在 finally —— 否则某条收场路径上泳道
  // 会永远停着，预取从此再也不发生，而且没有任何报错。
  const iTry = APP.indexOf("prefetcher.pause();");
  const iFin = APP.indexOf("prefetcher.resume();");
  const fin = APP.lastIndexOf("} finally {", iFin);
  ok(iTry > 0 && iFin > iTry && fin > iTry && fin < iFin,
    "resume 在 finally 里（成功 / 失败 / 取消三条路都会恢复）");
  const tryAt = APP.lastIndexOf("try {", iTry);
  ok(tryAt > 0 && APP.slice(tryAt, iTry).trim().split("\n").every((l) => !l.includes("await")),
    "pause 是 try 的第一句实质语句（与 finally 的 resume 严格成对）");
}

check("prefetcher.pause() 只有一处调用点",
  (APP.match(/prefetcher\.pause\(\)/g) ?? []).length, 1);
check("prefetcher.resume() 只有一处调用点",
  (APP.match(/prefetcher\.resume\(\)/g) ?? []).length, 1);

// ─────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} AI 产物即时落盘：${pass} ✅ / ${fail} ❌`);
if (fail > 0) process.exit(1);
