/**
 * verify-undo.ts — 撤销/重做的覆盖面（批次 3 / 3.7）
 *
 * ## 这个脚本要防的是"编辑器里又冒出一个改了回不去的操作"
 *
 * 3.7 之前，撤销栈只盖住了**镜头轻剪辑**那一小块：改时长、改顺序、停用、
 * 修剪窗口、分割、以及 3.6 刚加的转场三件套。而下面这些**同样改项目内容**
 * 的操作，做完就回不去了：
 *
 *   | 操作 | 入口 | 做错了怎么办（3.7 之前） |
 *   |---|---|---|
 *   | 素材库插入镜头轨 | `App.addToTimeline` | 手动找到它、确认删除 |
 *   | Ctrl+V 粘贴 | `App.doPaste` | 粘了 5 个就删 5 次 |
 *   | 删外部素材 | `App.deleteSpecialShot` | **没办法**，后端硬删 |
 *   | 主轨 ↔ 叠加层 | `App.doMoveTrack` | 记得原来的层号和起点，手动改回 |
 *   | 画面/调色/特效/马赛克 | `App.commitTransform` | 凭记忆把滑块拨回去 |
 *   | 轨道锁定/隐藏/静音/独奏 | `timelineStore` | 找到那条轨再点一次 |
 *
 * 其中「删外部素材」那条最狠：确认框当时明写着「此操作不可撤销」。
 *
 * ## 三个容易写错、且错了不会报错的地方，逐条钉住
 *
 * ① **撤销闭包不能走会再次入栈的那个入口。**
 *    轨道开关如果撤销时再调一次 `toggleTrackX`，就会再推一条记录 ——
 *    Ctrl+Z 变成在两个状态之间来回横跳，且栈无限增长。所以有
 *    `setTrackFlag`（写定值、不入栈）这一层，② 段实跑验证撤销后栈**不增长**。
 *    同理 transform 有 `writeTransform` / `commitTransform` 两层。
 *
 * ② **重建换主键。** 被删的镜头是重新 `addSpecialShot` 插回来的，
 *    新 id 与旧 id 不同。撤销闭包里若继续拿旧 id 去 delete，第二次撤销/重做
 *    就 404。3.6 在转场上踩过一次，本次三处新增全部沿用 `curId = 新 id` 的写法。
 *
 * ③ **一次手势只进一条。** transform 的中间帧走 `stage()` 不落库，
 *    尾防抖把整段拖动收敛成一次 commit。若按每帧入栈，拖 3 秒能往深度 50 的
 *    栈里塞满同一镜头的中间值，把此前所有真正的编辑记录挤掉 —— 比没有撤销更坏。
 *
 * ## 顺带钉住"按钮说的和它做的一致"
 *
 * 3.7 时静音/独奏在全项目没有任何读取方（导出侧 `normalize.ts` 把每条
 * RenderTrack 的 muted/hidden 写死成 false），⑤ 段于是把「当前仅为标记」的
 * 文案与那三处写死值绑在一起 —— **它按设计在 4.6 转红了**，逼着连文案一起改。
 * 现在三处都读 `input.trackFlags`，⑤ 段改成钉住反向的不变式：
 * 没有任何一处退回写死 false，且文案如实说明它会影响成片。
 * 折算逻辑本身（3 轨 : 4 kind、独奏、隐藏只对视频轨）归 `verify-trackflags.ts`。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { useTimelineStore } from "../src/stores/timelineStore";
import { describeTransform } from "../src/lib/transformLabel";
import type { Timeline, Track } from "../src/types/timeline";

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

/* ================================================================== *
 * ① 标签：Ctrl+Z 之前用户唯一能看到的线索
 * ================================================================== */
console.log("① 撤销标签：说得出「退的是哪一步」");

check("调色字段 → 调色", describeTransform({ exposure: 12, saturation: -5 }), "调色");
check("几何字段 → 画面", describeTransform({ scale: 120, x: 3 }), "画面");
check("逐帧特效 → 特效", describeTransform({ glow: 40 }), "特效");
check("马赛克单列（它是区域级编辑，混进「特效」里就找不着了）",
  describeTransform({ mosaics: [] as unknown[] }), "马赛克");
check("两组并列", describeTransform({ scale: 120, glow: 40 }), "画面+特效");
// 三组以上就不再逐个列：标签长过顶栏会被 CSS 截断成「…（画…」，反而什么都看不出
check("三组以上收敛成「X+Y 等 N 项」",
  describeTransform({ scale: 1, exposure: 1, glow: 1 }), "画面+调色 等 3 项");
// PATCH 是整体替换，面板会把当前全部非默认字段一起发上来。
// 判据是"字段在不在"，不是"值变没变"，所以 undefined/null 都不算数。
check("undefined 不算数（面板清掉某项后不该还显示它）",
  describeTransform({ exposure: undefined, glow: 3 }), "特效");
check("null 不算数", describeTransform({ lut: null, glow: 3 }), "特效");
check("一个都认不出时给「其他」，不给空串（标签里一对空括号像是程序崩了）",
  describeTransform({ someFutureField: 1 }), "其他");

/* ================================================================== *
 * ② 轨道开关：真跑一遍 store，确认撤销/重做对称且栈不膨胀
 * ================================================================== */
console.log("\n② 轨道开关：撤销回得去，且撤销本身不再入栈");

function track(id: string, label: string, kind: Track["kind"] = "voice"): Track {
  return {
    id, kind, label, height: 40,
    locked: false, hidden: false, muted: false, solo: false, collapsed: false,
    clips: [], assetSegments: [],
  };
}
const fixture: Timeline = {
  tracks: [track("t-v", "视频 1", "video"), track("t-voice", "旁白")],
  totalDurationSec: 30,
};

const st = () => useTimelineStore.getState();
function reset() {
  st().clearUndo();
  st().setTimeline(fixture);
  // setTimeline 会**沿用**上一份同 id 轨道的开关（见 store 里的注释），
  // 所以清场必须显式把标志写回 false，否则用例之间会互相串味。
  for (const t of fixture.tracks) {
    for (const k of ["locked", "hidden", "muted", "solo"] as const) {
      st().setTrackFlag(t.id, k, false);
    }
  }
  st().clearUndo();
}
const flagOf = (id: string, k: "locked" | "hidden" | "muted" | "solo") =>
  !!st().findTrack(id)?.[k];

for (const [name, toggle, key] of [
  ["锁定", () => st().toggleTrackLock("t-voice"), "locked"],
  ["隐藏", () => st().toggleTrackHidden("t-voice"), "hidden"],
  ["静音", () => st().toggleTrackMuted("t-voice"), "muted"],
  ["独奏", () => st().toggleTrackSolo("t-voice"), "solo"],
] as const) {
  reset();
  toggle();
  check(`${name}：点一下就生效`, flagOf("t-voice", key), true);
  check(`${name}：进了撤销栈`, st().undoStack.length, 1);
}

// 撤销/重做的对称性 + 栈不膨胀，用锁定这一路走完整流程
reset();
st().toggleTrackLock("t-voice");
const label = st().undoStack[0]?.label;
// 标签得能认出「是哪条轨」——十几条轨的项目里，一句「轨道设置」等于没说
ok("标签形如「锁定轨道『旁白』」，带轨道名与动作词",
  !!label && label.includes("旁白") && label.includes("锁定"), String(label));

await st().undo();
check("撤销后回到 false", flagOf("t-voice", "locked"), false);
// 这一条是本段的重点：撤销闭包若走 toggleTrackLock 而不是 setTrackFlag，
// 这里会变成 1（撤销自己又推了一条），Ctrl+Z 就再也退不出去了。
check("撤销不再往栈里推新记录", st().undoStack.length, 0);
check("撤销后可重做", st().redoStack.length, 1);

await st().redo();
check("重做回到 true", flagOf("t-voice", "locked"), true);
check("重做把记录还回撤销栈", st().undoStack.length, 1);
check("重做不再往 redo 栈里推新记录", st().redoStack.length, 0);

// 折叠**刻意**不入栈：它会被 setTimeline 自动改写（空轨自动折叠、
// 有内容自动展开），入栈的话撤销和自动规则会互相打架，表现为"撤了但没撤"。
reset();
st().toggleTrackCollapsed("t-voice");
check("折叠改变了状态", !!st().findTrack("t-voice")?.collapsed, true);
check("折叠**不**进撤销栈（它会被 setTimeline 自动改写）", st().undoStack.length, 0);

reset();
st().setTrackFlag("t-voice", "muted", true);
check("setTrackFlag 是给撤销闭包用的底层写入，自己不入栈", st().undoStack.length, 0);

reset();
st().toggleTrackLock("t-不存在");
check("轨道不存在时什么都不做，不推一条撤不了的空记录", st().undoStack.length, 0);

// 多条轨互不干扰：撤销只该影响当初被点的那一条
reset();
st().toggleTrackHidden("t-v");
st().toggleTrackHidden("t-voice");
await st().undo();
check("撤销只回滚最后那条轨", [flagOf("t-v", "hidden"), flagOf("t-voice", "hidden")],
  [true, false]);

/* ================================================================== *
 * ③ 静态：五个新增入口不许再消失
 * ================================================================== */
console.log("\n③ 静态：改项目内容的入口都得进撤销栈");

const app = read("src/App.tsx");
const store = read("src/stores/timelineStore.ts");
const asset = read("src/features/assets/AssetTrack.tsx");
const injectAsset = read("src/features/assets/injectAsset.ts");
const th = read("src/features/timeline/TrackHeader.tsx");
const norm = read("src/render/normalize.ts");

// 光数 pushUndo 的总数不够：新增一处、删掉一处，总数不变照样绿。
// 所以逐个入口按**它自己的标签**钉死。
for (const [what, pat] of [
  ["素材库插入镜头轨", /pushUndo\(`插入外部素材/],
  ["Ctrl+V 粘贴", /pushUndo\(`粘贴 \$\{buf\.length\} 个片段`/],
  ["删除外部素材", /pushUndo\(`移除外部素材/],
  ["主轨 ↔ 叠加层", /pushUndo\(trackIndex > 0 \? `镜头 #\$\{old\.order\} 移到叠加层`/],
  ["画面/调色/特效调整", /pushUndo\(label,\n\s+async \(\) => \{ await writeTransform/],
] as const) {
  ok(`「${what}」有撤销记录`, pat.test(app));
}

ok("删外部素材的确认框不再写「此操作不可撤销」",
  !/此操作不可撤销/.test(app),
  "3.7 之前这句话是对的（后端硬删）；现在能撤了，留着会让用户白白放弃一次编辑");
ok("被删的镜头是连修剪窗口/画面调整/叠加层位置一起还原的",
  /restoreSpecialShot/.test(app)
  && /clipInSec: old\.clip_in_sec/.test(app)
  && /transformMeta: old\.transform_meta/.test(app),
  "只还原名字和时长的话，撤销回来的是个空壳，比删掉更难发现");

// ② 号陷阱：重建换主键
ok("插入/粘贴/删除的撤销闭包都跟着新主键走",
  /curId = again\.shot_id/.test(app)
  && /createdIds = again;/.test(app)
  && /curId = await restoreSpecialShot\(old\)/.test(app),
  "拿旧 id 去 delete 会 404，撤销从第二次起就坏");
ok("粘贴撤销删的是**整批**，不是只删第一个",
  /for \(const id of \[\.\.\.createdIds\]\.reverse\(\)\) await api\.deleteShot\(id\)/.test(app),
  "一次 Ctrl+V 粘 5 个，只撤掉 1 个的话另外 4 个就永久留在轨上了");

// ③ 号陷阱：一次手势一条
ok("transform 分成 writeTransform（只写）/ commitTransform（写+入栈）两层",
  /const writeTransform = async \(/.test(app) && /await writeTransform\(shotId, tm\);/.test(app),
  "合成一层的话，撤销时的那次写又会推一条新记录");
ok("值没变就不入栈（松手时防抖可能已经写过同样的值）",
  /const same = JSON\.stringify\(prev\) === JSON\.stringify\(tm\);/.test(app)
  && /if \(same\) return;/.test(app),
  "空记录会让用户按两下 Ctrl+Z 才看见画面变，第一下像是撤销坏了");
ok("撤销闭包走 writeTransform，不走 stagedTransform.patch",
  !/undo[\s\S]{0,80}stagedTransform\.patch/.test(app));

ok("轨道开关的撤销闭包走 setTrackFlag（写定值），不再调 toggleTrackX",
  /undo: \(\) => \{ get\(\)\.setTrackFlag\(trackId, key, prev\); \}/.test(store)
  && /redo: \(\) => \{ get\(\)\.setTrackFlag\(trackId, key, next\); \}/.test(store));
ok("折叠没有被顺手塞进 toggleFlagWithUndo",
  !/toggleTrackCollapsed: \(id\) => toggleFlagWithUndo/.test(store));

/* ================================================================== *
 * ④ 重做不再是"暂不支持"
 * ================================================================== */
console.log("\n④ 重做：五个资产轨入口补齐 redo");

// 类型上把 redo 变成必传，tsc 就会替我们盯住每一个调用点 ——
// 比在这里数闭包个数可靠得多（数闭包会被格式化改动搞坏）。
ok("AssetTrack 的 onPushUndo 把 redo 声明成**必传**",
  /onPushUndo: \(\s*\n?\s*label: string, undo: \(\) => Promise<void>, redo: \(\) => Promise<void>,/
    .test(asset),
  "声明成可选的话，useUndo 会塞一个只弹「暂不支持重做」的桩，"
  + "重做按钮亮着却点了没反应");
ok("五个资产轨入口一个不少",
  ((asset + injectAsset).match(/(?:p|a)\.onPushUndo\(/g) ?? []).length === 5,
  "第 5 个（拖资产卡进轨道）已挪进 injectAsset.ts，与镜头轨那条 lane 共用同一份实现，"
  + "所以要合起来数；数少了说明真丢了一个入口");

/* ================================================================== *
 * ⑤ 轨道开关的说明必须与它实际做的事一致
 * ================================================================== */
console.log("\n⑤ 轨道开关的说明必须与它实际做的事一致");

// 3.7~4.5 期间这里钉的是「三处都写死 false」+「文案说仅为标记」。4.6 把开关
// 接进了导出，那两条**按设计转红**，于是改成钉住反向的不变式。
//
// ⚠️ 两个坑仍然成立，都是变异测试实测撞出来的：
// 1. `normalize.ts` 里有**三处** RenderTrack 构造（主视频轨、叠加轨、音频轨）。
//    只把其中一处接成真值，"有一句"这种写法照样绿；而"只有视频轨认隐藏、
//    音频轨不认静音"恰恰是最可能发生的半截实现。所以要逐个查 + 数个数。
// 2. 也不能笼统地查所有 `muted:` —— 镜头级原声静音（`muted: !!tm.muted` /
//    `muted: true`）是另一码事，本来就不是轨道标志。轨道级的判据是
//    **三处都用同一个 `flagsFor(id)` 展开**，clip 上永远没有 hidden。
const flagCalls = [...norm.matchAll(/\.\.\.flagsFor\(/g)];
ok("导出计划里三处轨道都从 trackFlags 取值（不是只接了其中一处）",
  flagCalls.length === 3,
  `实际 ${flagCalls.length} 处 ...flagsFor(...)，期望 3（主视频轨 / 叠加轨 / 音频轨）`);
ok("没有任何一处轨道标志退回写死 false",
  !/\bmuted:\s*false,\s*hidden:\s*false/.test(norm),
  "又写死 false 就等于按钮重新变成摆设，且文案会当场变成谎话");
ok("flagsFor 读的是 input.trackFlags 的两个集合",
  /const mutedIds = new Set\(input\.trackFlags\?\.muted \?\? \[\]\)/.test(norm)
  && /const hiddenIds = new Set\(input\.trackFlags\?\.hidden \?\? \[\]\)/.test(norm),
  "不传 trackFlags 时必须落回「都不静音、都不隐藏」，否则既有调用方全部受影响");
ok("solo 仍然没有进 RenderTrack 模型",
  !/\bsolo\b/.test(norm),
  "独奏是在 trackFlags.ts 里折算成「其余轨 muted」的，"
  + "导出模型不该多出一个只有一处消费者的字段");
ok("静音按钮如实说明它会影响成片",
  /MUTE_TITLE = "静音本轨（导出时本轨音频不进成片）"/.test(th),
  "4.6 起它真的管用了，还写「仅为标记」就是反过来骗人");
ok("独奏按钮说清它进导出（剪映是纯监听，我们不是）",
  /SOLO_TITLE = "独奏（导出时只保留本轨音频，其余音频轨视作静音）"/.test(th),
  "语义与剪映不同，必须写明白，否则用户按剪映的习惯独奏完就导出，成片会少 BGM");
ok("隐藏按钮按轨型分开说：只有视频/叠加轨影响导出",
  !/不参与预览/.test(th)
  && /HIDE_TITLE_EXPORT = "[^"]*导出时本轨画面不进成片/.test(th)
  && /HIDE_TITLE_EDITOR = "[^"]*不影响导出/.test(th),
  "音频轨上的眼睛不影响导出（那是静音的活），字幕轨压根不经过轨道模型");

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 撤销覆盖全部通过：插入/粘贴/删除/移轨/画面调整/轨道开关都能 Ctrl+Z；"
    + "撤销闭包不再自我入栈、重建跟着新主键走、一次拖拽只进一条；"
    + "资产轨五个入口补齐重做；静音/独奏/隐藏的文案与它实际的作用一致"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
