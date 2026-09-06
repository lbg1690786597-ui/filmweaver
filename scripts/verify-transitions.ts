/**
 * verify-transitions.ts — 转场的可见性与可编辑性（批次 3 / 3.6）
 *
 * ## 这个脚本要防的是"转场重新变回只进不出"
 *
 * 3.6 之前，转场的 API 调用方数量是这样的：
 *
 *   · `createTransition`  1 个（效果面板点一下）
 *   · `listTransitions`   1 个（拉下来只喂给导出）
 *   · `patchTransition`   **0 个**
 *   · `deleteTransition`  **0 个**
 *
 * 也就是说：加了看不见、加错了改不了也删不掉。唯一的补救是往同一条接缝上
 * 再加一个让后端 upsert 覆盖 —— 而"同一条接缝"用户根本看不见，只能靠数镜头猜。
 * ⑤ 段静态钉住这两个 API 现在有调用方：谁把编辑入口删了，这个脚本立刻转红。
 *
 * ## 第二件事：四类「加了但不会生效」的转场必须能被认出来
 *
 * 转场挂在两个 shot id 上，能否生效取决于导出时这两镜是否**仍然相邻**。
 * 加完之后用户完全可以再去删镜头、停用镜头、插新镜头、把镜头挪到叠加层：
 *
 *   | 情况 | 导出时的下场 | 报错吗 |
 *   |---|---|---|
 *   | 端点被删 | `normalize.ts` 找不到 clip，整条丢弃 | 否 |
 *   | 端点被停用 | 停用镜头不进 picked，同上 | 否 |
 *   | 中间插了别的镜头 | 编译器只在相邻两 clip 间找转场，静默硬切 | 否 |
 *   | 端点在叠加层 | 叠加层走 overlay 通路，不参与主轨串接 | 否 |
 *
 * 四种全都不报错，成片就是硬切，用户无从查起。① 段逐条钉住 `SeamState`
 * 认得出它们，② 段钉住每种都有一句说人话的解释（红点只说"有问题"，
 * 不说"怎么修"）。
 *
 * ## 第三件事：接缝位置不许再开第四套累加
 *
 * `shotToClip.ts` 末尾 `secToPosition` 的长注释记着：这条时间轴上曾同时存在
 * **三套**顺序累加算法，症状是"线画在一处、跳到的是另一处"。接缝是第五个
 * 需要绝对秒的地方。④ 段用真实数据核对接缝秒数与 `buildOrderOffsetMap`
 * 逐值相等，⑥ 段再静态钉住 `transitions.ts` 里没有自己的 `+=` 累加。
 *
 * ## 第四件事：时长夹持只能有一份
 *
 * `xfade` 吃掉的是两侧的**重叠**：短的那一镜决定上限，两侧还各要留下
 * `MIN_KEEP_SEC` 的纯画面。UI 若自己再推一遍上限，迟早和标记上写的那个对不上，
 * 用户会看到"填了显示的上限值却被弹回去"。③ 段钉住量化与边界，
 * ⑤ 段钉住 UI 走的是 `clampToSeam(…, m.maxSec)` 而不是自己拿镜头时长重推。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSeamMarkers, maxTransitionSec, clampToSeam, clampTransitionSec,
  foldedTotalSec, seamHint, seamSummary,
  MIN_TRANSITION_SEC, MAX_TRANSITION_SEC, MIN_KEEP_SEC,
} from "../src/features/timeline/transitions";
import { buildOrderOffsetMap } from "../src/adapters/shotToClip";
import type { ShotInfo, TransitionInfo } from "../src/api";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const okEq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okEq) failed++;
  console.log(`  ${okEq ? "✅" : "❌"} ${name}`);
  if (!okEq) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/** 造一个镜头。只填 `buildSeamMarkers` / `buildOrderOffsetMap` 会读的字段。 */
function shot(
  id: string, order: number, dur: number,
  o?: { disabled?: boolean; track?: number },
): ShotInfo {
  return {
    id, order, duration_sec: dur, clip_dur_sec: dur,
    disabled: o?.disabled ?? false,
    track_index: o?.track ?? 0,
  } as unknown as ShotInfo;
}

function tr(id: string, from: string, to: string, dur = 0.5): TransitionInfo {
  return { id, type: "fade", duration: dur, from_shot_id: from, to_shot_id: to, params: null };
}

/* ================================================================== *
 * ① 四类「不会生效」的转场都要被认出来
 * ================================================================== */
console.log("① 状态判定：加了但导出时不生效的四种情况");

const base = [shot("a", 1, 3), shot("b", 2, 3), shot("c", 3, 3)];

check("相邻主轨 → ok",
  buildSeamMarkers(base, [tr("t", "a", "b")]).map((m) => m.state), ["ok"]);

check("端点被删 → missing",
  buildSeamMarkers([shot("a", 1, 3)], [tr("t", "a", "gone")]).map((m) => m.state),
  ["missing"]);

check("端点被停用 → disabled",
  buildSeamMarkers([shot("a", 1, 3), shot("b", 2, 3, { disabled: true })],
    [tr("t", "a", "b")]).map((m) => m.state),
  ["disabled"]);

check("中间插了一镜 → notAdjacent",
  buildSeamMarkers(base, [tr("t", "a", "c")]).map((m) => m.state), ["notAdjacent"]);

check("端点在叠加层 → offMain",
  buildSeamMarkers([shot("a", 1, 3), shot("b", 2, 3, { track: 1 })],
    [tr("t", "a", "b")]).map((m) => m.state),
  ["offMain"]);

check("时长超过两侧余量 → tooLong",
  buildSeamMarkers([shot("a", 1, 3), shot("b", 2, 0.4)],
    [tr("t", "a", "b", 2)]).map((m) => m.state),
  ["tooLong"]);

// 停用的下场比"不相邻"更根本（整条被丢弃），所以停用优先于相邻性判定 ——
// 否则一个"既被停用又不相邻"的转场会被报成"不相邻"，用户去调顺序也没用。
check("既停用又不相邻 → 报 disabled（更根本的那个原因）",
  buildSeamMarkers([shot("a", 1, 3), shot("b", 2, 3), shot("c", 3, 3, { disabled: true })],
    [tr("t", "a", "c")]).map((m) => m.state),
  ["disabled"]);

check("端点被删优先于一切（连时长都无从算起）",
  buildSeamMarkers([shot("b", 2, 3, { disabled: true })],
    [tr("t", "gone", "b")]).map((m) => m.state),
  ["missing"]);

// 编译器两个方向都认（`ffmpegCompiler.ts` 在相邻两 clip 间双向查找），
// 所以 b→a 与 a→b 同样有效。判成 notAdjacent 会把好转场标黄，是虚警。
check("反向（后→前）也算相邻，不是 notAdjacent",
  buildSeamMarkers(base, [tr("t", "b", "a")]).map((m) => m.state), ["ok"]);

/* ================================================================== *
 * ② 折叠：成片会比时间轴短多少
 * ================================================================== */
console.log("\n② 折叠：xfade 重叠两镜，成片比时间轴短");

const foldSet = buildSeamMarkers(base, [tr("t1", "a", "b", 0.5), tr("t2", "b", "c", 0.8)]);
check("两条生效转场各折叠自己的时长", foldSet.map((m) => m.foldSec), [0.5, 0.8]);
check("9s 的时间轴 → 成片 7.7s", Number(foldedTotalSec(9, foldSet).toFixed(2)), 7.7);

check("不生效的转场不折叠（导出时整条被丢弃）",
  buildSeamMarkers(base, [tr("t", "a", "c")]).map((m) => m.foldSec), [0]);

// tooLong 不是"不生效"：编译器照样跑 xfade，只是把 offset 夹到 0，
// 画面糊成一团但时长照样折叠。少算这一份会让"成片 −X.Xs"偏小。
check("tooLong 仍然折叠（它是照跑的，只是难看）",
  buildSeamMarkers([shot("a", 1, 3), shot("b", 2, 0.4)],
    [tr("t", "a", "b", 2)]).map((m) => m.foldSec),
  [2]);

check("折叠不会把总时长压成负数", foldedTotalSec(0.3, foldSet), 0);

/* ================================================================== *
 * ③ 时长上限与夹持
 * ================================================================== */
console.log("\n③ 时长上限：短的那一镜说了算，两侧还得各留一点画面");

// 上限值写死在断言里，不写 `MAX_TRANSITION_SEC` —— 拿常量去核对常量是句同义反复，
// 把 5s 改成 3s 一样绿。5s 以上已经不是"转场"而是"叠化段落"了。
check("两侧都很长 → 吃满全局上限 5s", maxTransitionSec(10, 10), 5);
check("全局上限确实是 5s", MAX_TRANSITION_SEC, 5);
check("最短转场是 0.1s", MIN_TRANSITION_SEC, 0.1);
check("两侧各留 0.1s 纯画面", MIN_KEEP_SEC, 0.1);
check("短的那一镜说了算（3s / 10s）", maxTransitionSec(3, 10), 2.9);
check("对称：谁在前不影响", maxTransitionSec(10, 3), 2.9);
check("刚好留下 MIN_KEEP_SEC", maxTransitionSec(0.2, 5), MIN_TRANSITION_SEC);
check("比最短转场还挤 → 0（放不下）", maxTransitionSec(0.15, 5), 0);
check("零长镜头（脏数据）→ 0，不返回负数", maxTransitionSec(0, 5), 0);
// 量化到 0.1s 格：UI 的滑块、后端存的值、这里的上限必须同格，
// 否则会出现"把滑块拉到显示的最大值，却被判 tooLong"。
check("上限落在 0.1s 格上（向下取整，不四舍五入）", maxTransitionSec(1.37, 9), 1.2);
check("浮点余量不把 1.0 抖成 0.9", maxTransitionSec(1.1, 9), 1.0);

check("夹持到上限", clampToSeam(9, 2.9), 2.9);
check("夹持到下限", clampToSeam(0.01, 2.9), MIN_TRANSITION_SEC);
check("量化到 0.1s", clampToSeam(0.44, 2.9), 0.4);
check("上限为 0 时夹成 0（这条缝放不下）", clampToSeam(1, 0), 0);
// 负上限只可能来自脏数据，但没有守卫的话 `Math.min` 会原样把负数放出去，
// 写进后端就是一个负时长的转场。守卫必须是真的在挡，不是摆设。
check("上限为负（脏数据）也夹成 0，不把负数放出去", clampToSeam(1, -3), 0);
check("NaN 不写进数据（退回默认 0.5）", clampToSeam(NaN, 2.9), 0.5);
check("NaN 且余量不足 0.5 → 退到余量", clampToSeam(NaN, 0.3), 0.3);

check("clampTransitionSec 与 clampToSeam 同源（同一组镜头得同一个值）",
  clampTransitionSec(9, 3, 10), clampToSeam(9, maxTransitionSec(3, 10)));

/* ================================================================== *
 * ④ 接缝位置：必须与 buildOrderOffsetMap 逐值相等
 * ================================================================== */
console.log("\n④ 位置：与画线用的那套累加同源（不许再写第四套）");

const mixed = [
  shot("a", 1, 3),
  shot("b", 2, 2, { disabled: true }),   // 停用：占位但不推进时间
  shot("c", 3, 4),
  shot("d", 4, 1, { track: 1 }),         // 叠加层：完全不参与顺序累加
  shot("e", 5, 2),
];
const offs = buildOrderOffsetMap(mixed);

check("接缝定位在「后一镜的起点」",
  buildSeamMarkers(mixed, [tr("t", "a", "c")]).map((m) => m.atSec),
  [offs.get(3)]);

check("停用镜头不推进时间：c 起点仍是 3（不是 5）", offs.get(3), 3);

check("跨过停用镜头的 a→c 判为相邻（导出串接里它俩确实挨着）",
  buildSeamMarkers(mixed, [tr("t", "a", "c")]).map((m) => m.state), ["ok"]);

check("后一镜没了 → 退到前一镜的结尾（仍然定位得到，用户才删得掉）",
  buildSeamMarkers(mixed, [tr("t", "a", "gone")]).map((m) => m.atSec),
  [offs.get(1)! + 3]);

check("两端都没了 → atSec 为 null（画不出来，但仍要出现在汇总里）",
  buildSeamMarkers(mixed, [tr("t", "x", "y")]).map((m) => m.atSec), [null]);

check("按时间排序，定位不到的排最后",
  buildSeamMarkers(mixed, [
    tr("t3", "x", "y"), tr("t2", "c", "e"), tr("t1", "a", "c"),
  ]).map((m) => m.id),
  ["t1", "t2", "t3"]);

check("端点被停用时仍定位得到（否则失效的转场删不掉）",
  buildSeamMarkers(mixed, [tr("t", "a", "b")]).map((m) => m.atSec !== null), [true]);

// 叠加层镜头在 offsetMap 里根本没有条目（它的位置由 overlay_start_sec 决定），
// 所以定位退到前一镜的结尾——仍然画得出来，用户才有地方点它、删它。
check("端点在叠加层时也定位得到（退到前一镜结尾）",
  buildSeamMarkers(mixed, [tr("t", "c", "d")]).map((m) => m.atSec), [3 + 4]);

/* ================================================================== *
 * ⑤ 文案与汇总：说清"为什么不生效"，不是一个红点
 * ================================================================== */
console.log("\n⑤ 文案：每种失效都给一句能照着修的话");

const hints = (["missing", "disabled", "notAdjacent", "offMain", "tooLong"] as const).map((want) => {
  const sets: Record<string, ShotInfo[]> = {
    missing: [shot("a", 1, 3)],
    disabled: [shot("a", 1, 3), shot("b", 2, 3, { disabled: true })],
    notAdjacent: base,
    offMain: [shot("a", 1, 3), shot("b", 2, 3, { track: 1 })],
    tooLong: [shot("a", 1, 3), shot("b", 2, 0.4)],
  };
  const t = want === "missing" ? tr("t", "a", "gone")
    : want === "notAdjacent" ? tr("t", "a", "c")
    : tr("t", "a", "b", want === "tooLong" ? 2 : 0.5);
  const m = buildSeamMarkers(sets[want], [t])[0];
  return { want, state: m.state, hint: seamHint(m) };
});

for (const h of hints) {
  ok(`${h.state} 的说明不空、且不只是"无效"两个字`,
    h.hint.length > 12 && !/^无效/.test(h.hint), h.hint);
}
ok("tooLong 的说明里带上了这条缝的实际上限（用户才知道该改成多少）",
  /0\.3s/.test(hints.find((h) => h.want === "tooLong")!.hint),
  hints.find((h) => h.want === "tooLong")!.hint);
ok("ok 的说明里写明「成片会缩短」（这是转场唯一会让人意外的副作用）",
  /缩短/.test(seamHint(buildSeamMarkers(base, [tr("t", "a", "b")])[0])));

check("没有转场 → 汇总不占地方", seamSummary([]), null);
ok("有转场 → 汇总里带上折叠秒数",
  /成片 −1\.3s/.test(seamSummary(foldSet)!.text), seamSummary(foldSet)!.text);
ok("有失效转场 → 汇总里报个数",
  /1 无效/.test(seamSummary(buildSeamMarkers(base, [tr("t", "a", "c")]))!.text));
ok("汇总的 title 里逐条列出每个接缝（悬停就能查，不用一个个点）",
  seamSummary(foldSet)!.title.split("\n").length === 3);

/* ================================================================== *
 * ⑥ 静态钉子：编辑入口不许再消失
 * ================================================================== */
console.log("\n⑥ 静态：可见之外还要可改可删");

const app = read("src/App.tsx");
const tl = read("src/features/timeline/Timeline.tsx");
const mod = read("src/features/timeline/transitions.ts");

// 光 grep 函数名不够：撤销闭包里也会调这两个 API，把用户那条入口删掉、
// 只留撤销里的调用，"有调用方"照样成立。所以连**用户入口那一句**一起钉死。
ok("`api.patchTransition` 有调用方（3.6 之前是 0 个）",
  /api\.patchTransition\(/.test(app),
  "转场只能加不能改的话，加错了唯一的补救是往同一条缝再加一个覆盖");
ok("改时长的用户入口还在（不是只剩撤销里那两句）",
  /await api\.patchTransition\(id, \{ duration: durationSec \}\);/.test(app));
ok("`api.deleteTransition` 有调用方（3.6 之前是 0 个）",
  /api\.deleteTransition\(/.test(app),
  "加错了删不掉");
ok("删转场的用户入口还在",
  /await api\.deleteTransition\(m\.id\);/.test(app));

ok("Timeline 收到 transitions 数据",
  /transitions=\{transitions\}/.test(app));
ok("改/删两个回调都接上了",
  /onPatchTransition=\{/.test(app) && /onDeleteTransition=\{/.test(app));

// 3.10 在 kind 判断与 .map 之间插了一层可见性 .filter，故这里钉的是**判据本身**
// （video 轨才画），而不是当时那条链的形状——否则每加一层过滤都要来改一次。
ok("接缝标记只画在视频轨上",
  /track\.kind === "video" && drawableSeams\b/.test(tl),
  "音频/字幕轨上画接缝没有意义——转场作用的是主轨画面串接");
ok("定位不到的接缝不进绘制列表（left 会算成 NaN）",
  /drawableSeams = seams\.filter\(\(s\) => s\.atSec !== null\)/.test(tl));

ok("UI 夹持走 clampToSeam(…, m.maxSec)，不自己拿镜头时长重推一遍",
  /clampToSeam\(Number\(e\.target\.value\), seamEdit\.m\.maxSec\)/.test(tl),
  "重推的那一遍迟早和标记上写的上限对不上，用户会看到「填了显示的上限却被弹回去」");
ok("拖动过程中不落库（松手/离开/键盘调完才 PATCH）",
  !/onChange=\{[^}]*onPatchTransition/.test(tl)
  && /onPointerUp=\{\(\) => p\.onPatchTransition/.test(tl),
  "每帧一次 PATCH 会把后端打满，且撤销栈里堆满几十条一模一样的记录");

ok("加转场时挑「下一镜」已排除叠加层",
  /\(s\.track_index \?\? 0\) === 0 && !s\.disabled/.test(app),
  "叠加层镜头走 overlay 通路，转场挂上去导出时静默丢弃");
ok("加转场时长按接缝余量夹持，不再硬编码 0.5",
  /clampTransitionSec\(0\.5, shotDuration\(selectedShot\), shotDuration\(next\)\)/.test(app),
  "0.4s 的空镜会被 0.5s 的转场整个吃光");
ok("放不下时直说，而不是加一条注定难看的转场",
  /放不下转场/.test(app));

ok("转场的增删改都进撤销栈",
  (app.match(/pushUndo\(`(加转场|转场时长|删除转场)/g) ?? []).length === 3,
  "3.6 之前转场是全项目唯一一处「改了就回不去」的编辑操作");
ok("撤销后重建会更新主键（后端重建换 id，拿旧 id 去删会 404）",
  /curId = again\.id/.test(app));

ok("接缝位置取自 buildOrderOffsetMap，模块里没有自己的顺序累加",
  /buildOrderOffsetMap/.test(mod) && !/acc \+=|cursor \+=/.test(mod),
  "这条时间轴上曾同时存在三套累加算法，症状是「线画在一处、跳到的是另一处」");
ok("挑主轨串接的口径与编译器一致（主轨 + 未停用 + 按 order）",
  /\(s\.track_index \?\? 0\) === 0 && !s\.disabled/.test(mod));
ok("transitions.ts 是纯函数模块：不 import store / React",
  !/from "(zustand|react)"/.test(mod) && !/stores\//.test(mod),
  "它要能被本脚本在 node 下直接跑");

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 转场全部通过：接缝画在时间轴上、时长能改、加错能删能撤销；"
    + "四类「加了不生效」的转场都会标黄并说明原因；"
    + "「成片比时间轴短多少」如实显示；位置与画线同源，夹持只有一份"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
