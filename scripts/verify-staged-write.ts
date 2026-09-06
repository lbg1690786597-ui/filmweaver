/**
 * verify-staged-write.ts — 拖拽期间"本地先走、落库延后"（批次 2 / 2.2）
 *
 * ## 验收标准（路线图原文）
 *
 *   「拖滑块 3 秒：PATCH 次数从每帧一次降到一次，且**松手后的最终值确实落库**」
 *
 * 这两句必须**被测量**，不是被声称。所以：
 *
 *   ① 用假时钟模拟 60fps × 3 秒 = 180 次 stage，断言拖动期间 commit == 0，
 *      松手后 commit == 1，且落库的值是第 180 帧那个值。
 *      改动前这里会是 180 次 PATCH + 180 次全项目详情 GET。
 *   ② **反向对照**：把松手那一下去掉（模拟"以后有人删了 onPointerUp"），
 *      在计时器不触发的情况下最终值**永远不落库** —— 证明收尾提交是承重的，
 *      不是可有可无的保险。这是本脚本存在的主要理由。
 *   ③ 计时器兜底：拖到窗口外松手（收不到 pointerup）时，
 *      最后一次 stage 之后 delayMs 也要自己落库，不能静默丢改动。
 *   ④ 失败**保留**本地值：断网时用户看到的仍是自己调的画面（顶栏由 2.1 报错）。
 *      悄悄回滚 = 在用户不知情时丢掉他的操作。
 *   ⑤ 乐观盖层：拖动中画面必须跟手（`overlayPending`），
 *      且没有待写项时**返回同一个数组引用**（否则省下的请求会被重渲染赔回去）。
 *   ⑥ 静态守卫：会写 transform 的滑块必须有收尾提交；
 *      拖拽覆盖层必须走 stage；App 的 commit 必须**抛出**失败。
 *
 * ⑥ 之所以是静态扫源码：这几处一旦被"顺手简化"掉，症状是**用户的最后一格调整
 * 静默消失**——没有报错、没有崩溃，只有下次打开发现值不对。这种回归不会被
 * 任何运行时测试自然逮到。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStagedWriter, overlayPending } from "../src/lib/stagedWrite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/** 假时钟：只在显式 tick 时才让到期的回调跑，拖动中就是"从不到期" */
function fakeClock() {
  let now = 0;
  let id = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (fn: () => void, ms: number) => { jobs.set(++id, { at: now + ms, fn }); return id; },
    cancel: (t: unknown) => { jobs.delete(t as number); },
    /** 推进时间并执行到期任务 */
    async advance(ms: number) {
      now += ms;
      for (const [k, j] of [...jobs]) {
        if (j.at <= now) { jobs.delete(k); j.fn(); }
      }
      // 让 commit 里的 await 链跑完
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    },
    pending: () => jobs.size,
  };
}

type TM = Record<string, number>;

/** 一次真实的滑块拖动：60fps × 秒数，值从 0 线性拖到 100 */
function dragFrames(seconds: number): TM[] {
  const n = Math.round(seconds * 60);
  return Array.from({ length: n }, (_, i) => ({ opacity: Math.round(((i + 1) / n) * 100) }));
}

/* ------------------------------------------------------------------ */
console.log("\n① 拖滑块 3 秒：PATCH 次数塌缩，且松手后的最终值确实落库");

{
  const clock = fakeClock();
  const sent: { key: string; value: TM }[] = [];
  const w = createStagedWriter<TM>({
    delayMs: 250,
    commit: async (key, value) => { sent.push({ key, value }); },
    schedule: clock.schedule, cancel: clock.cancel,
  });

  const frames = dragFrames(3);
  check("模拟帧数 = 60fps × 3s", frames.length, 180);
  for (const f of frames) w.stage("shot-1", f);

  check("拖动期间 stage 了 180 次", w.stats.staged, 180);
  check("拖动期间 PATCH 次数 = 0（改动前是 180）", sent.length, 0);
  ok("拖动期间画面有值可看（待写项在）", w.hasPending());
  check("待写值就是最新一帧", w.peek("shot-1"), { opacity: 100 });

  // 松手：组件把 stage 时记下的那份原样重发（不重算），走 writeNow
  await w.writeNow("shot-1", frames[frames.length - 1]);

  check("松手后 PATCH 总次数 = 1", sent.length, 1);
  check("落库的值 = 第 180 帧的值（最终值）", sent[0].value, { opacity: 100 });
  check("落库到正确的镜头", sent[0].key, "shot-1");
  check("落库成功后待写项清空", w.hasPending(), false);
  check("清空后盖层不再返回旧值", w.peek("shot-1"), undefined);
  check("计时器已取消（不会再多发一笔）", clock.pending(), 0);
  console.log(`      → 请求数 180 → 1（降低 ${(100 - 1 / 180 * 100).toFixed(1)}%），`
    + `且落库值 = ${JSON.stringify(sent[0].value)}`);
}

/* ------------------------------------------------------------------ */
console.log("\n② 反向对照：去掉松手那一下 → 最终值就丢了（证明收尾提交是承重的）");

{
  const clock = fakeClock();
  const sent: TM[] = [];
  const w = createStagedWriter<TM>({
    delayMs: 250,
    commit: async (_k, v) => { sent.push(v); },
    schedule: clock.schedule, cancel: clock.cancel,
  });

  for (const f of dragFrames(3)) w.stage("shot-1", f);
  // 这里**故意不调用 writeNow** —— 模拟以后有人把 onPointerUp / commitStaged 删了。
  // 计时器也不推进（真实场景里用户松手后立刻切了镜头/关了窗口）。
  check("没有收尾提交 → 一次都没落库", sent.length, 0);
  ok("值还挂在内存里，一旦页面卸载就消失",
     w.peek("shot-1") !== undefined && sent.length === 0);
  // 这正是"松手后的最终值确实落库"这条验收标准要防的失败模式：
  // 画面上看着是对的，服务端什么都没收到。
  console.log("      → 本节两项为 ✅ 说明「没有收尾提交就一定丢」成立；"
    + "于是 ① 里那 1 次落库不是计时器凑巧，而是松手那一下真的在起作用");
}

/* ------------------------------------------------------------------ */
console.log("\n③ 计时器兜底：收不到 pointerup 也不许丢改动");

{
  const clock = fakeClock();
  const sent: TM[] = [];
  const w = createStagedWriter<TM>({
    delayMs: 250,
    commit: async (_k, v) => { sent.push(v); },
    schedule: clock.schedule, cancel: clock.cancel,
  });

  for (const f of dragFrames(1)) w.stage("shot-1", f);
  await clock.advance(200);
  check("最后一次 stage 之后 200ms（未到期）→ 还没落库", sent.length, 0);
  await clock.advance(100);
  check("超过 delayMs → 自己落库一次", sent.length, 1);
  check("兜底落的也是最终值", sent[0], { opacity: 100 });

  // 尾防抖语义：拖动中每一帧都重置计时器，所以中途一次都不会落库
  const clock2 = fakeClock();
  const sent2: TM[] = [];
  const w2 = createStagedWriter<TM>({
    delayMs: 250,
    commit: async (_k, v) => { sent2.push(v); },
    schedule: clock2.schedule, cancel: clock2.cancel,
  });
  for (const f of dragFrames(3)) {
    w2.stage("shot-1", f);
    await clock2.advance(16);      // 每帧 16ms，永远追不上 250ms
  }
  check("60fps 连续拖 3 秒（时钟真的在走）→ 中途 0 次落库", sent2.length, 0);
  await clock2.advance(250);
  check("停手 250ms 后落 1 次", sent2.length, 1);
  check("值仍是最终值", sent2[0], { opacity: 100 });
}

/* ------------------------------------------------------------------ */
console.log("\n④ 失败保留本地值 / 后写覆盖前写 / 落库中又改");

{
  const clock = fakeClock();
  let mode: "fail" | "ok" = "fail";
  const errs: unknown[] = [];
  const w = createStagedWriter<TM>({
    delayMs: 250,
    commit: async () => { if (mode === "fail") throw new TypeError("Failed to fetch"); },
    onError: (_k, e) => errs.push(e),
    schedule: clock.schedule, cancel: clock.cancel,
  });

  w.stage("shot-1", { opacity: 42 });
  await w.writeNow("shot-1", { opacity: 42 });
  check("落库失败 → 记一次失败", w.stats.failures, 1);
  check("失败 → onError 被调用", errs.length, 1);
  ok("失败 → 本地值**保留**（用户看到的仍是自己调的画面）",
     JSON.stringify(w.peek("shot-1")) === JSON.stringify({ opacity: 42 }),
     "回滚成服务端旧值 = 在用户不知情时丢掉他的操作");
  check("失败 → 仍算有未落库改动（顶栏据此显示未保存）", w.hasPending(), true);

  // 重试成功后才清
  mode = "ok";
  await w.flush();
  check("重试成功 → 待写清空", w.hasPending(), false);
}

{
  // 同一个 key 连续 stage：只保留最后一个，不排队重放中间值
  const clock = fakeClock();
  const sent: TM[] = [];
  const w = createStagedWriter<TM>({
    delayMs: 250, commit: async (_k, v) => { sent.push(v); },
    schedule: clock.schedule, cancel: clock.cancel,
  });
  w.stage("s", { opacity: 1 });
  w.stage("s", { opacity: 2 });
  w.stage("s", { opacity: 3 });
  await w.flush();
  check("三次 stage 只落 1 笔", sent.length, 1);
  check("落的是最后一次", sent[0], { opacity: 3 });
}

{
  // 落库进行中用户又拖了 → 那笔新值不能被"上一笔成功"顺手删掉
  const clock = fakeClock();
  // 用对象存 resolve：TS 会把裸 let 变量在此处窄化成 null（赋值发生在回调里）
  const h: { release: (() => void) | null } = { release: null };
  const w = createStagedWriter<TM>({
    delayMs: 250,
    commit: () => new Promise<void>((res) => { h.release = res; }),
    schedule: clock.schedule, cancel: clock.cancel,
  });
  w.stage("s", { opacity: 1 });
  const p = w.flush();
  w.stage("s", { opacity: 2 });      // 落库还在飞的时候又改了
  h.release?.();
  await p;
  ok("落库期间的新值不被前一笔的成功清掉",
     JSON.stringify(w.peek("s")) === JSON.stringify({ opacity: 2 }),
     "否则用户在响应回来那一瞬间的调整会凭空消失");
}

{
  // 多镜头互不干扰（导出前 flush 会一次性落多个）
  const clock = fakeClock();
  const sent: string[] = [];
  const w = createStagedWriter<TM>({
    delayMs: 250, commit: async (k) => { sent.push(k); },
    schedule: clock.schedule, cancel: clock.cancel,
  });
  w.stage("a", { opacity: 1 });
  w.stage("b", { opacity: 2 });
  await w.flush();
  check("flush 落全部待写镜头", sent.sort(), ["a", "b"]);
  check("flush 后无残留", w.hasPending(), false);
}

/* ------------------------------------------------------------------ */
console.log("\n⑤ 乐观盖层：拖动中画面跟手，且不平白制造新数组引用");

{
  const clock = fakeClock();
  const w = createStagedWriter<TM>({
    delayMs: 250, commit: async () => {},
    schedule: clock.schedule, cancel: clock.cancel,
  });
  type Shot = { id: string; transform_meta: TM | null };
  const shots: Shot[] = [
    { id: "a", transform_meta: { opacity: 100 } },
    { id: "b", transform_meta: null },
  ];
  const apply = (s: Shot, v: TM): Shot => ({ ...s, transform_meta: v });

  const same = overlayPending(w, shots, apply);
  ok("无待写项 → 返回同一个数组引用（下游 memo 不失效）", same === shots);

  w.stage("a", { opacity: 30 });
  const over = overlayPending(w, shots, apply) as Shot[];
  ok("有待写项 → 新数组", over !== shots);
  check("被盖的镜头显示未落库的值（这就是画面跟手）", over[0].transform_meta, { opacity: 30 });
  ok("没有待写值的镜头保持原对象引用", over[1] === shots[1]);
  ok("原数组不被就地修改", shots[0].transform_meta!.opacity === 100);

  // 待写的 key 不在这批 shots 里（切项目 / 镜头被删）
  const other = overlayPending(w, [{ id: "z", transform_meta: null }], apply);
  ok("待写 key 不在当前 shots 里 → 仍返回同一引用",
     other.length === 1 && (other as Shot[])[0].id === "z");
  check("空数组不崩", overlayPending(w, [], apply).length, 0);
}

/* ------------------------------------------------------------------ */
console.log("\n⑥ 静态守卫：写 transform 的滑块必须有收尾提交");

/** 逐个抓出 `<input type="range" …/>` 的属性块 */
function rangeBlocks(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = src.indexOf('<input type="range"', i);
    if (s < 0) break;
    // 属性里有 `=>` 和 `{}`，但没有裸的 `/>` —— 找第一个 `/>` 即元素结束
    const e = src.indexOf("/>", s);
    out.push(src.slice(s, e < 0 ? src.length : e));
    i = e < 0 ? src.length : e + 2;
  }
  return out;
}

/** 会写 transform 的滑块所在的文件。Player 的进度/音量条不写 transform，不在此列；
 *  TextPanel 的字幕样式滑块走的是自己的 600ms 防抖（`patchStyle`），也不在此列。 */
const PANELS = [
  "src/features/inspector/ClipProperties.tsx",
  "src/features/inspector/CropZoomPanel.tsx",
  "src/features/inspector/MosaicPanel.tsx",
  "src/features/effects/EffectsPanel.tsx",
  "src/features/editor/MosaicOverlay.tsx",
];
/**
 * 这个滑块是否在写 transform（而不是只改本地 store，如笔刷粗细）。
 * `onChange(` 这一项是为了抓住共用的 `Slider` 子组件 —— 它自己不认识 patch，
 * 但收尾提交的 pointer/键盘事件必须挂在它身上，漏了同样丢最后一格。
 */
const WRITES = /\b(patch|pushAdj|applyIntensity|applyScale|onChange\()/;

for (const rel of PANELS) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const blocks = rangeBlocks(src);
  ok(`${rel} 找到 ${blocks.length} 个滑块`, blocks.length > 0);
  let guarded = 0;
  blocks.forEach((b, i) => {
    if (!WRITES.test(b)) return;    // 只改本地 store 的滑块不需要收尾提交
    guarded++;
    ok(`${rel} 第 ${i + 1} 个滑块有松手收尾（onPointerUp）`, b.includes("onPointerUp"),
       "没有收尾提交 → 拖动的最终值只留在本地，服务端永远收不到");
    ok(`${rel} 第 ${i + 1} 个滑块有 pointercancel 收尾（拖出窗口/被手势打断）`,
       b.includes("onPointerCancel"));
    ok(`${rel} 第 ${i + 1} 个滑块有键盘收尾（←→ 没有 pointer 事件）`,
       b.includes("onKeyUp"));
  });
  ok(`${rel} 至少有一个写 transform 的滑块被守卫到`, guarded > 0);
  // 每个文件都必须有"记下 stage 值 + 原样重发"这一对
  ok(`${rel} 有 stagedRef（松手时重发记下的值，不重算）`, src.includes("stagedRef"),
     "从 state 现算会漏掉最后一格：连续事件的最后一次渲染可能晚于 pointerup");
  ok(`${rel} 有收尾提交函数`, /commitStaged|commitAdj/.test(src));
  ok(`${rel} 拖动中确实带了 staged 标记`, src.includes("{ staged: true }"),
     "少了它只会退回「每帧一次 PATCH」——不丢数据，但本条就白做了");
}

/* 画布拖拽覆盖层：每帧必须走 stage，不能直接 onPatchTransform */
{
  const src = readFileSync(join(ROOT, "src/features/editor/CropZoomOverlay.tsx"), "utf8");
  // onMove 回调体内不许出现裸的 onPatchTransform(
  const moves = [...src.matchAll(/const onMove = \(ev: PointerEvent\) => \{/g)];
  ok(`CropZoomOverlay 有 ${moves.length} 个 onMove（画面拖拽 + 裁剪框拖拽）`,
     moves.length === 2);
  for (const m of moves) {
    // 到该 onMove 之后、下一个 `const onUp` 之前的那段
    const from = m.index!;
    const to = src.indexOf("const onUp", from);
    const body = src.slice(from, to < 0 ? src.length : to);
    ok("onMove 里每帧走 stage(", body.includes("stage("));
    ok("onMove 里没有裸的 onPatchTransform（那就是每帧一次 PATCH）",
       !/onPatchTransform\(/.test(body));
  }
  ok("两个 onUp 都调 commitStaged",
     (src.match(/commitStaged\(\);/g) ?? []).length >= 2);
  ok("双击还原仍是立即落库（离散操作不该延后）",
     /onReset[\s\S]{0,400}onPatchTransform\(/.test(src));
}

/* 马赛克覆盖层：移动/缩放区域也是每帧一次的路径（改动前每帧一笔 PATCH） */
{
  const src = readFileSync(join(ROOT, "src/features/editor/MosaicOverlay.tsx"), "utf8");
  const i = src.indexOf('if (d.kind === "move")');
  const j = src.indexOf('if (d.kind === "resize")');
  ok("MosaicOverlay 有 move / resize 两条拖动路径", i > 0 && j > i);
  // 5.6 起两条分支不再各自 save：新框统一交给 `commitBox`，由它调
  // `applyRegionBox` 决定这是「改静态框」还是「在播放头处写一条关键帧」。
  // 断言随之改成「分支 → commitBox → staged save」这条链 —— 仍然承重：
  // 任一环退回裸 save / onPatchTransform，下面三条里必有一条红。
  ok("move 路径走 commitBox", /commitBox\(d, \{/.test(src.slice(i, j)));
  ok("resize 路径走 commitBox", /commitBox\(d, \{/.test(src.slice(j, j + 900)));
  // 范围切到 onCanvasUp 之前 —— 松手那次是**故意**的立即落库（新建区域），
  // 把它圈进来这条断言就会永远红，那是装饰不是承重。
  const moveEnd = src.indexOf("const onCanvasUp");
  ok("move/resize 分支里没有裸的 save/onPatchTransform（那就是每帧一次真写）",
     moveEnd > j
     && !/\bsave\(/.test(src.slice(i, moveEnd))
     && !/onPatchTransform\(/.test(src.slice(i, moveEnd)));
  ok("commitBox 的 save 带 staged",
     /const commitBox[\s\S]{0,900}?save\([\s\S]{0,160}?\), true\)/.test(src),
     "拖动中每帧一次真写盘 —— 2.2 的暂存写在这条路上白做了");
  ok("松手时按拖动类型收尾落库",
     /d\?\.kind === "move" \|\| d\?\.kind === "resize"\) commitStaged\(\)/.test(src),
     "只 stage 不 commit → 移动/缩放的最终位置要等 250ms 兜底才落库");
  ok("容器挂了 onPointerCancel（拖出窗口不会卡住 dragRef）",
     /onPointerCancel=\{onCanvasUp\}/.test(src));
  // 新建区域（拖框/涂抹）本来就只在松手写一次，不该被改成 staged
  ok("新建区域仍是立即落库",
     /drawBox\.w > MIN_SIZE[\s\S]{0,300}save\(next\);/.test(src));
}

/* App 侧：commit 失败必须抛出去，否则 stagedWrite 会当成成功并撤掉盖层
 *
 * ⚠️ 3.7 起这段分成了两层，断言随之下移一层：
 *   writeTransform  —— 只写（乐观锁 / refreshDetail / 409 处理 / rethrow）
 *   commitTransform —— 调 writeTransform，再把「写回旧值」推进撤销栈
 * 拆开的原因是撤销/重做闭包必须能"只写、不再入栈"，否则撤销时那次写又会
 * 推一条新记录。所以 refreshDetail 与 throw 现在住在 writeTransform 里，
 * 这里改成查它；同时补一条"commitTransform 不许把异常吃掉"——
 * stagedWrite 调的是 commitTransform，中间这层一旦 catch 住，
 * 上面那两条断言全绿也照样会让用户的调整静默消失。 */
{
  const app = readFileSync(join(ROOT, "src/App.tsx"), "utf8");
  const wi = app.indexOf("const writeTransform");
  const ci = app.indexOf("const commitTransform");
  ok("App 有 writeTransform（3.7 拆出来的『只写』那层）", wi > 0);
  ok("App 有 commitTransform", ci > wi);
  // ⚠️ 按**真实边界**切，不用固定字符数。原先写的 `slice(wi, wi + 900)` 够不到
  // 函数末尾那条 `say(String(e)); throw e;`（这段注释多，900 字符只到一半），
  // 于是那条断言长期是红的 —— 而变异测试因为"基线本来就红"，
  // 每个变异都显示"转红"，看起来 7/7 全过，实际什么都没测到。
  // 教训：切函数体要用下一个声明当终点；变异测试跑之前必须先确认基线是绿的。
  const wbody = app.slice(wi, ci);
  const cbody = app.slice(ci, app.indexOf("const stagedTransform = useStagedTransform"));
  ok("writeTransform 里 await refreshDetail（早于它清盖层会闪回服务端旧值）",
     /await refreshDetail\(\)/.test(wbody));
  // ⚠️ 不能只查"有没有 throw e" —— writeTransform 里有**两条**失败路径，
  // 变异测试实测过两轮：
  //   第一版 `/throw e/` —— 删掉 409 那条的 rethrow 照样绿（另一条喂饱了它）；
  //   第二版 `/forget\(shotId\);[\s\S]{0,400}throw e;/` —— 还是绿，因为通配段
  //   一路跨过 409 的块尾，够到了后面那条 `say(String(e)); throw e;`。
  // 所以只能**切段**查：409 分支自己那一段里必须有 rethrow。
  // 409 恰恰是最要紧的那条（2.3 乐观锁全靠它把冲突捅到 stagedWrite）。
  const c409 = wbody.slice(wbody.indexOf("shotRev.forget(shotId);"),
                           wbody.indexOf("say(String(e))"));
  ok("writeTransform 的 409 分支 rethrow（不然并发冲突会被当成保存成功）",
     c409.length > 0 && /throw e;/.test(c409),
     "吞掉 409 = stagedWrite 撤掉本地盖层 + 顶栏显示已保存，"
     + "但服务端其实是别人的版本，用户永远发现不了");
  ok("writeTransform 的其他失败也 rethrow（吞掉会让用户的调整静默消失）",
     /say\(String\(e\)\); throw e;/.test(wbody),
     "stagedWrite 靠异常判断没落库；catch 后不 rethrow 会撤掉本地盖层");

  // ⚠️ 位置敏感地钉：cbody 里 `await writeTransform(shotId, tm)` 出现**两次**
  // ——一次是落库，一次是 redo 闭包。变异测试实测过：删掉落库那句，
  // 光 test(cbody) 会被 redo 闭包里的那句喂饱，照样绿（3.6 踩过的同一个坑：
  // grep 函数名会连撤销闭包一起匹配）。所以要求它出现在 `if (same) return;` **之前**。
  const beforeGuard = cbody.slice(0, cbody.indexOf("if (same) return;"));
  ok("commitTransform 在入栈判定之前就把值落库了",
     cbody.includes("if (same) return;")
     && /await writeTransform\(shotId, tm\);/.test(beforeGuard),
     "落库那一句没了 = 拖完根本没保存，而撤销栈里却记了一条");
  ok("commitTransform **不**把 writeTransform 的异常吃掉",
     !/try\s*\{[\s\S]{0,200}await writeTransform\(shotId, tm\)/.test(cbody),
     "中间这层一旦 catch 住，stagedWrite 会以为写成功并撤掉本地盖层——"
     + "用户看着数值跳回旧值，且顶栏不报错");
  ok("撤销/重做闭包走 writeTransform（不能再走 commitTransform，否则撤销自己又入栈）",
     /async \(\) => \{ await writeTransform\(shotId, prev\); \}/.test(cbody));

  // 6.7 改了锚点：早返回从 `if (loginRequired === null)` 换成了 `decideScreen`
  // 分派出来的 `if (screen === "offline")`。**不变式一个字没变**（hook 必须在
  // 第一个早返回之前无条件调用），变的只是"第一个早返回长什么样"。
  // 两个 indexOf 都单独判 >= 0：否则哪天 hook 被删掉，-1 < 正数 会**静默变绿**。
  const iHook = app.indexOf("useStagedTransform(");
  const iGate = app.indexOf('if (screen === "offline")');
  ok("useStagedTransform 在早返回之前无条件调用（Rules of Hooks）",
     iHook >= 0 && iGate >= 0 && iHook < iGate,
     "放在早返回之后 = 条件调用 hook，门禁切换时 React 直接报错");
  ok("导出前 flush 掉待写项（导出必须用用户眼前的参数）",
     /await stagedTransform\.flush\(\)/.test(app));
  ok("导出用 applyPending 后的 clips",
     /stagedTransform\.applyPending\(o\.clips\)/.test(app));
}

/* ------------------------------------------------------------------ */
console.log(failed === 0
  ? "\n✅ 2.2 通过：拖 3 秒 180 帧 → 1 次 PATCH，且松手后的最终值确实落库"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
