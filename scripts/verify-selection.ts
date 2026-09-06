/**
 * verify-selection.ts — 选中态的单一真源（批次 3 / 3.5）
 *
 * ## 这个脚本要防的是"第二套选中态复活"
 *
 * 3.5 之前，"哪些片段被选中"在代码里有两个互不相认的答案：
 *
 *   · `useEditorStore.selectedClipId` —— 单选，**唯一被画成高亮**的那个
 *   · `useTimelineStore.selection.clipIds` —— 多选，**Delete / 复制 / 剪切
 *     真正作用**的那个
 *
 * 于是 Ctrl+A（只写后者）的现象是：**按下去界面上什么也没变**，用户以为
 * 快捷键没生效，随手再按一下 Delete —— 整集镜头被停用。审计里这是 E4。
 *
 * 这类 bug 不会被"再仔细一点"避免：只要两个真源并存，下一个写入点就会
 * 忘记同步另一边（在被发现时，`selectedClipId` 已经有 5 处写入、1 处读取）。
 * 所以 3.5 的修法是**删掉一边**，让高亮直接读操作用的那个集合，把
 * 「高亮 ≡ 将被操作的集合」变成结构性事实。下面第 ⑤ 段静态钉住这一点：
 * 谁再往 editorStore 里加一个 `selectedClipId`，这个脚本立刻转红。
 *
 * ## 第二件事：高亮不许承诺做不到的操作
 *
 * 收敛真源之后立刻暴露出第二个问题 —— 三处批量选中的判据各不相同：
 *
 *   | 入口 | 跳过 locked/hidden 轨 | 只选有 shotId 的 |
 *   |---|---|---|
 *   | Ctrl+A（App）      | ❌ | ❌（直接灌 `detail.shots`） |
 *   | `[` `]`（commands）| ✅ | ❌ |
 *   | `[` `]`（Timeline）| ✅ | ❌（同源重复实现） |
 *   | 框选（Timeline）   | ❌ | ❌ |
 *
 * 没有 `shotId` 的是音频/字幕/资产段，而 Delete / 复制 / 剪切 / 停用**全部**
 * 要经 `shotId` 才能落到后端 —— 选中它们必然是空操作。高亮既然承诺"这些会
 * 被操作"，就不能把它们点亮。现在四个入口共用 `selection.ts` 的
 * `isSelectable`，① ~ ④ 段逐条钉住它的边界。
 *
 * ## 🔀 6.9：本脚本有一批断言**期望值被翻转**了，理由如下
 *
 * 3.5 当时把「音频轨上框选选不中任何东西」写成了用例（②③④④' 各一条），
 * 并在 `selection.ts` 里同时写下了兑现条件：
 *
 *   > 音频/字幕片段的可拖可修剪排在批次 6，届时它们会拿到 `shotId` 之外的
 *   > 操作通路，再把判据放开。
 *
 * 6.9 兑现了它：音频/字幕有了自己的 PATCH（修剪/拖动）与 DELETE 端点，
 * Delete 落得到后端。所以「选不中」这个期望**不再是正确行为的描述，
 * 而是旧限制的化石**，必须跟着翻。
 *
 * **为什么这个 diff 是预期的**：翻的是"能不能进选中集"，钉住的那条不变式
 * （高亮 ≡ 将被操作的集合）**一个字没松**。放开的同时，三个消费选中集的
 * 操作被逐一改过并在 ⑥' 段新钉住：
 *
 *   · Delete → 真支持（三种实体三种删法）
 *   · 复制/剪切 → **明确不支持**（粘贴只会插镜头），`copySelection` 只收镜头、
 *     Ctrl+X 明说跳过了几个 —— 不是默默剪掉一段永远粘不回来的音频
 *   · 停用 → **不适用**，按 D 明说"音频/字幕没有停用，请按 Delete"
 *
 * 也就是说，如果有人只放开 `isSelectable` 而不动这三处，⑥' 会转红。
 * 翻转期望值本身不降低这个脚本的承重力，这正是必须新增 ⑥' 的原因。
 *
 * ## 第三件事：不许再冒出第二份"一侧全选"
 *
 * `selectSide` 曾经有**两份**逐行几乎相同的实现（快捷键一份、工具条按钮
 * 一份），差异只在"有没有 toast"和"顺手写了哪套选中态"。这正是两套真源
 * 长期漂移的成因。⑤ 段钉住：全项目只有 App 里那一处调 `sideIds`。
 *
 * ## 明确**不**改的东西（也钉住）
 *
 * 导出对话框的「所选」范围读的是 `App.selectedShot`（Inspector 里那一镜），
 * **不是**时间轴选中集。这是有意为之：Ctrl+A 之后按导出，用户要的不是
 * "把刚才全选的几百镜当作所选范围"。⑥ 段钉住这一行不被顺手改掉。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSelectable, allSelectableIds, sideIds, marqueeIds,
  rectIds, rangeIds, RANGE_HINT,
} from "../src/features/timeline/selection";
import type { SelectableTrack } from "../src/features/timeline/selection";
import type { ClipEntity } from "../src/types/timeline";
import { useTimelineStore } from "../src/stores/timelineStore";

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

/** 造一条轨：`clips` 里每项是 [id, startSec, durationSec, entity?, 有没有 shotId?]
 *
 *  第 4 项 6.9 起从布尔（有没有 shotId）换成 `entity` —— 判据要分的是三种
 *  实体，布尔只能分两种。第 5 项单独留着，是为了造出"镜头但没有 shotId"
 *  这种**坏数据**（adapter 一定会写 shotId，真出现说明上游坏了）。 */
function track(
  id: string,
  clips: [string, number, number, ClipEntity?, boolean?][],
  o?: { locked?: boolean; hidden?: boolean },
): SelectableTrack {
  return {
    id,
    locked: o?.locked ?? false,
    hidden: o?.hidden ?? false,
    clips: clips.map(([cid, s, d, entity = "shot", hasShot = true]) => ({
      id: cid, startSec: s, durationSec: d, entity,
      ...(entity === "shot" && hasShot ? { shotId: `sh-${cid}` } : {}),
    })),
  };
}

// 主轨：三镜顺排，各 4 秒（中点 2 / 6 / 10）
const video = track("v", [["c1", 0, 4], ["c2", 4, 4], ["c3", 8, 4]]);
// 音频轨：与主轨完全重叠。6.9 起它**可选**（有了自己的写通路）
const audio = track("a", [["a1", 0, 12, "audio"]]);
// 坏数据：镜头格子却没有 shotId。adapter 不会产出这种，但判据要挡住它
const broken = track("bad", [["b1", 0, 4, "shot", false]]);

/* ================================================================== */
console.log("\n① isSelectable：全项目唯一的「能不能进选中集」判据");

ok("普通轨上的镜头可选", isSelectable(video, video.clips[0]));
ok("锁定轨上的镜头不可选",
  !isSelectable({ ...video, locked: true }, video.clips[0]),
  "锁轨的意思就是「别动我」，选中它等于邀请用户去按 Delete");
ok("隐藏轨上的镜头不可选",
  !isSelectable({ ...video, hidden: true }, video.clips[0]),
  "看不见的东西被高亮，用户无从得知自己选了什么");
ok("🔀 6.9：音频段现在可选（它有了自己的 DELETE / PATCH 通路）",
  isSelectable(audio, audio.clips[0]),
  "3.5 这里是 !isSelectable，理由是「选中它必然是空操作」；"
  + "6.9 让这句话不再成立，期望值必须跟着翻——见文件头 🔀 一节");
ok("锁定轨上的音频段仍不可选（放开的是实体，不是轨道状态）",
  !isSelectable({ ...audio, locked: true }, audio.clips[0]));
ok("隐藏轨上的音频段仍不可选",
  !isSelectable({ ...audio, hidden: true }, audio.clips[0]));
ok("镜头但没有 shotId → 仍不可选（坏数据，别让 Delete 拿 undefined 去 PATCH）",
  !isSelectable(broken, broken.clips[0]),
  "PATCH /v2/shots/undefined 要么 404 要么更糟：撞上一个 id 恰好相同的镜头");

/* ================================================================== */
console.log("\n② allSelectableIds（Ctrl+A）：只选真能被操作的");

check("按轨道序、轨内按时间序", allSelectableIds([video]), ["c1", "c2", "c3"]);
check("🔀 6.9：音频轨整条纳入（3.5 那条「有意排除」的代价已兑现兑掉）",
  allSelectableIds([video, audio]), ["c1", "c2", "c3", "a1"]);
check("坏数据（镜头缺 shotId）仍被排除",
  allSelectableIds([video, broken]), ["c1", "c2", "c3"]);
check("锁定轨被整条跳过",
  allSelectableIds([{ ...video, locked: true }]), []);
check("隐藏轨被整条跳过",
  allSelectableIds([{ ...video, hidden: true }]), []);
check("空时间轴 → 空集（调用方据此提示「没有可选的片段」而不是静默）",
  allSelectableIds([]), []);
check("多轨合并：可选轨的照选，锁定轨的不掺进来",
  allSelectableIds([video, { ...audio }, { ...video, id: "v2", locked: true }]),
  ["c1", "c2", "c3", "a1"]);

/* ================================================================== */
console.log("\n③ sideIds（[ / ]）：以播放头为界，判据是 clip 中点");

// 三镜中点：c1=2 / c2=6 / c3=10
check("播放头 5s：左侧只有 c1（c2 中点 6 还在右边）",
  sideIds([video], 5, "left"), ["c1"]);
check("播放头 5s：右侧是 c2 + c3", sideIds([video], 5, "right"), ["c2", "c3"]);
check("播放头 7s（仍在 c2 内部）：c2 改归左侧",
  sideIds([video], 7, "left"), ["c1", "c2"]);
check("播放头 7s：右侧只剩 c3", sideIds([video], 7, "right"), ["c3"]);
// 中点判据的意义：c2 占 [4,8)，播放头 5s 时它已经开始了，但主体在右边
ok("判据是中点而不是起点：at=5 时 c2 已起始（4<5）却归右",
  sideIds([video], 5, "right").includes("c2")
  && !sideIds([video], 5, "left").includes("c2"),
  "用起点判据会把「刚露头的那一镜」算进左侧，用户看着它在播放头右边却被选走");
check("中点恰好等于播放头 → 两侧都不选（否则连按 [ ] 会看到它左右横跳）",
  [sideIds([video], 6, "left"), sideIds([video], 6, "right")],
  [["c1"], ["c3"]]);
check("播放头在 0：左侧空（调用方据此提示，而不是静默无事发生）",
  sideIds([video], 0, "left"), []);
check("播放头在末尾之后：右侧空", sideIds([video], 999, "right"), []);
check("锁定轨不参与一侧全选",
  sideIds([{ ...video, locked: true }], 5, "left"), []);
check("🔀 6.9：音频段按自己的中点参与一侧全选（a1 中点 6 < 7）",
  sideIds([video, audio], 7, "left"), ["c1", "c2", "a1"]);
check("音频段中点在右侧时不被左选（判据对三种实体是同一条）",
  sideIds([video, audio], 5, "left"), ["c1"]);

/* ================================================================== */
console.log("\n④ marqueeIds（框选）：重叠即命中，不要求完全包含");

check("框住 c1 一部分即选中 c1（不要求拖过它的右端）",
  marqueeIds(video, 1, 2), ["c1"]);
check("跨三镜的大框全中", marqueeIds(video, 0.5, 11), ["c1", "c2", "c3"]);
check("反向拖（from > to）等价", marqueeIds(video, 11, 0.5), ["c1", "c2", "c3"]);
check("零宽度框选不中任何东西（点一下不算框选）", marqueeIds(video, 4, 4), []);
check("端点严格不等：框的右端恰好贴 c2 起点，不把 c2 捎上",
  marqueeIds(video, 1, 4), ["c1"]);
check("端点严格不等：框的左端恰好贴 c1 终点，不把 c1 捎上",
  marqueeIds(video, 4, 6), ["c2"]);
check("🔀 6.9：音频轨上框选选得中了（这正是 3.5 记下的那笔代价的兑现）",
  marqueeIds(audio, 0, 12), ["a1"]);
check("锁定的音频轨上框选仍为空",
  marqueeIds({ ...audio, locked: true }, 0, 12), []);
check("锁定轨上框选 → 空",
  marqueeIds({ ...video, locked: true }, 0, 12), []);

/* ================================================================== *
 * ④' 跨轨框选（3.8）：同一个矩形，纵向多了一维「哪几条轨」
 * ================================================================== */
console.log("\n④' rectIds（3.8 跨轨框选）：时间 × 轨道的矩形");

// 叠加层：与主轨错开半镜，用来验证跨轨时"各轨按自己的时间命中"
const overlay = track("o", [["o1", 2, 3], ["o2", 9, 3]]);
const all = [video, overlay, audio];

check("只覆盖主轨 → 与单轨框选完全一致",
  rectIds(all, 0.5, 11, ["v"]), marqueeIds(video, 0.5, 11));
check("覆盖两条轨 → 两条轨各自按时间命中（不是并集时间区间）",
  rectIds(all, 3, 5, ["v", "o"]), ["c1", "c2", "o1"]);
check("轨道集合为空 → 一个也不选（纵向没扫到任何 lane）",
  rectIds(all, 0, 99, []), []);
check("传了不存在的轨 id 不炸也不误伤", rectIds(all, 0, 99, ["nope"]), []);
check("顺序稳定：先按 tracks 顺序、再按轨内 clip 顺序",
  rectIds(all, 0, 99, ["o", "v"]), ["c1", "c2", "c3", "o1", "o2"]);
check("🔀 6.9：扫过音频轨不再白扫",
  rectIds(all, 0, 99, ["v", "a"]), ["c1", "c2", "c3", "a1"]);
check("扫过锁定轨也白扫",
  rectIds([{ ...video, locked: true }, overlay], 0, 99, ["v", "o"]), ["o1", "o2"]);
// ⚠️ 零宽时间区间**不是**"一定选不中"。3.5 那条用例（`marqueeIds(video, 4, 4)` → []）
// 之所以是空，只因为 4 恰好压在 c1/c2 的交界上；只要有片段**跨过**这个瞬间，
// 严格不等仍然成立（start < t < end），它就会被选中。
// 也就是说"点一下不算框选"这件事**完全由调用方的 3px 阈值承重**，判据本身兜不住。
// 这条用例把这个事实钉下来，免得以后有人看到 3.5 那行就以为判据自己防住了。
check("纵向扫很多轨、横向零宽 → 跨过这个瞬间的片段仍会命中（不是空）",
  rectIds(all, 4, 4, ["v", "o"]), ["o1"]);
check("零宽且正好压在交界上才是空（3.5 那条用例的真正成因）",
  rectIds(all, 4, 4, ["v"]), []);

/* ================================================================== *
 * ④'' Shift 范围选择（3.8）
 * ================================================================== */
console.log("\n④'' rangeIds（Shift+点击）：锚点到目标的包围盒");

check("同轨相邻：两端点都在里面", rangeIds([video], "c1", "c2"),
  { ok: true, ids: ["c1", "c2"] });
check("同轨跨过中间那一镜：中间的一起选上（这就是「选 12~40 镜」）",
  rangeIds([video], "c1", "c3"), { ok: true, ids: ["c1", "c2", "c3"] });
check("反向（从后往前 Shift 点）等价", rangeIds([video], "c3", "c1"),
  { ok: true, ids: ["c1", "c2", "c3"] });
check("锚点 = 目标 → 就它自己一个", rangeIds([video], "c2", "c2"),
  { ok: true, ids: ["c2"] });
// 跨轨：包围盒是 [c1.start, o2.end] × [轨 v .. 轨 o]
check("跨轨：矩形覆盖两条轨的整个时间跨度",
  rangeIds(all, "c1", "o2"), { ok: true, ids: ["c1", "c2", "c3", "o1", "o2"] });
check("跨轨但时间跨度小：只选落在里面的",
  rangeIds(all, "c1", "o1"), { ok: true, ids: ["c1", "c2", "o1"] });
// ⚠️ 端点必在结果里，是本函数的**承诺**：用户 Shift 点了 A 和 B，
// 结果里没有 B 会让人以为点漏了。这条对每个用例都成立，单独再钉一次。
for (const [a, b] of [["c1", "c3"], ["c3", "c1"], ["c1", "o2"]] as const) {
  const r = rangeIds(all, a, b);
  ok(`两个端点都在结果里（${a} → ${b}）`,
    r.ok && r.ids.includes(a) && r.ids.includes(b));
}
check("还没有锚点（本次会话第一下就按了 Shift）", rangeIds([video], null, "c2"),
  { ok: false, reason: "no-anchor" });
check("锚点那一镜已不在时间轴上（被删/被移走/切了项目）",
  rangeIds([video], "已经没了", "c2"), { ok: false, reason: "anchor-gone" });
check("目标在锁定轨上 → 不做范围（否则端点自己不在结果里，是个怪结果）",
  rangeIds([{ ...video, locked: true }], "c1", "c2"),
  { ok: false, reason: "target-unselectable" });
check("🔀 6.9：目标是音频段 → 范围成立（跨到音频轨，包围盒照算）",
  rangeIds(all, "c1", "a1"),
  { ok: true, ids: ["c1", "c2", "c3", "o1", "o2", "a1"] });
check("目标是坏数据（镜头缺 shotId）→ 仍不做范围",
  rangeIds([video, broken], "c1", "b1"),
  { ok: false, reason: "target-unselectable" });
// 失败态与提示语一一对应：漏一个就是 undefined 弹到用户脸上
for (const reason of ["no-anchor", "anchor-gone", "target-unselectable"] as const) {
  ok(`失败态「${reason}」有对应的人话提示`,
    typeof RANGE_HINT[reason] === "string" && RANGE_HINT[reason].length > 0);
}

/* ================================================================== */
console.log("\n⑤ 静态钉：单一真源 + 单一实现");

const store = read("src/stores/editorStore.ts");
const tl = read("src/features/timeline/Timeline.tsx");
const cmds = read("src/commands/index.ts");
const app = read("src/App.tsx");
const sel = read("src/features/timeline/selection.ts");

ok("editorStore 不再持有 selectedClipId（第二套真源不许复活）",
  !/selectedClipId/.test(store.replace(/\/\*[\s\S]*?\*\//g, "")),
  "留着它，下一个写入点就会忘记同步 timelineStore.selection —— E4 原样重现");
ok("editorStore 不再持有 selectedAssetSegmentId（同上，且它零读取）",
  !/selectedAssetSegmentId/.test(store.replace(/\/\*[\s\S]*?\*\//g, "")));
ok("全项目再无 selectedClipId 的读写",
  !/selectedClipId/.test(tl + app + cmds));
ok("Timeline 不再 import editorStore（选中态不从那里来）",
  !/from "\.\.\/\.\.\/stores\/editorStore"/.test(tl));
ok("高亮读的是操作用的选中集：selected={store.isClipSelected(clip.id)}",
  /selected=\{store\.isClipSelected\(clip\.id\)\}/.test(tl),
  "这一行就是「高亮 ≡ 将被操作的集合」本身");

ok("commands 里没有本地 selectSide 实现（曾与 Timeline 各写一份）",
  !/function selectSide/.test(cmds));
ok("[ 走 h.selectSide(\"left\")", /run: \(\) => h\.selectSide\("left"\)/.test(cmds));
ok("] 走 h.selectSide(\"right\")", /run: \(\) => h\.selectSide\("right"\)/.test(cmds));
ok("CommandHandlers 声明了 selectSide", /selectSide: \(side: "left" \| "right"\) => void;/.test(cmds));
ok("listCommandKeys 的 dummy 覆盖 selectSide（否则设置页快捷键表会漏）",
  /selectSide: noop/.test(cmds));

ok("Timeline 里没有本地 selectSide 实现", !/const selectSide = /.test(tl));
ok("工具条的 [ ] 按钮走 p.onSelectSide（与快捷键同一个实现）",
  /onClick=\{\(\) => p\.onSelectSide\("left"\)\}/.test(tl)
  && /onClick=\{\(\) => p\.onSelectSide\("right"\)\}/.test(tl));
// 唯一实现：sideIds 只在 App 里被调用一次
check("全项目只有一处调 sideIds（App）",
  [(tl.match(/sideIds\(/g) ?? []).length,
   (cmds.match(/sideIds\(/g) ?? []).length,
   (app.match(/sideIds\(/g) ?? []).length],
  [0, 0, 1]);

ok("Ctrl+A 走 allSelectableIds（不再是 detail.shots.map）",
  /selectAll: \(\) => \{[\s\S]{0,200}allSelectableIds\(tlStore\(\)\.timeline\.tracks\)/.test(app),
  "旧实现既不看轨道状态、也不管那一镜在不在时间轴上");
ok("Ctrl+A 选不到东西时有提示，不静默",
  /selectAll: \(\) => \{[\s\S]{0,400}没有可选的片段/.test(app));
// ⚠️ 3.8 迁移：框选从 `marqueeIds(tk, …)`（单轨、先 find 出那条轨）改成
// `rectIds(tracks, …, trackIds)`（跨轨）。**不是放宽，是跟着实现下移** ——
// 同时补了两条 3.8 才可能错的：轨 id 必须来自 DOM 命中、以及矩形不能只认横向。
ok("框选走 rectIds 且轨道集合来自本次拖动的命中结果",
  /rectIds\(useTimelineStore\.getState\(\)\.timeline\.tracks,\s*\n?\s*latest\.fromSec, latest\.toSec, latest\.trackIds\)/.test(tl));
ok("纵向命中靠 lane 上的 data-track-id（折叠轨/资产轨天然不参与）",
  /querySelectorAll<HTMLElement>\("\.fw-tl-lane\[data-track-id\]"\)/.test(tl)
  && /data-track-id=\{track\.id\}/.test(tl),
  "改成按 tracks 下标猜的话，折叠轨与资产轨会把纵向对应关系整体错位");
ok("「算不算拖动」横纵都算（否则纯纵向拖是静默返回）",
  /Math\.abs\(q\.x - x0\) > 3 \|\| Math\.abs\(q\.y - y0\) > 3/.test(tl));
ok("lane 矩形只在按下时量一次，之后用滚动增量校正",
  /const s0 = \{ left: sc\?\.scrollLeft \?\? 0, top: sc\?\.scrollTop \?\? 0 \};/.test(tl)
  && /ev\.clientX \+ \(\(sc\?\.scrollLeft \?\? 0\) - s0\.left\)/.test(tl),
  "每帧对十几条 lane 调 getBoundingClientRect 会强制同步布局；"
  + "而拖动中容器确实可能滚，不校正就会错位");
ok("框选浮层按轨 id 集合逐条画（不再是单个 trackId 相等）",
  /marquee\.trackIds\.includes\(track\.id\)/.test(tl));
ok("浮层宽度有 2px 兜底：纯纵向拖会选中却画不出来",
  /width: Math\.max\(2,/.test(tl)
  && !/marquee\.toSec > marquee\.fromSec/.test(tl),
  "零宽时间区间**不代表选不中**（判据是 start < t < end，跨过那一瞬间的都算），"
  + "旧的 toSec > fromSec 渲染条件会让这种拖法「选中了但没画框」");
ok("扫过锁定/隐藏轨时浮层画成 off 变体（不画=以为拖歪了，实心=撒谎）",
  /track\.locked \|\| track\.hidden \? " fw-tl-marquee-off" : ""/.test(tl));
ok("框选落空时有提示（旧实现在这里静默 return）",
  /框选范围内没有可操作的片段/.test(tl));

/* ================================================================== */
console.log("\n⑥ 静态钉：Ctrl+A 之后按下去不会出事的那几个操作");

ok("工具条 🗑 走 App 的 removeSelectedClips（不再逐个硬删）",
  /const deleteSelected = useCallback\(\(\) => p\.onRemoveSelected\(\)/.test(tl),
  "旧实现对每个选中镜头直接调 api.deleteShot；后端拒删 AI 镜头，"
  + "Ctrl+A 后按一下就是几百条报错 toast");
ok("Timeline 里没有残留的批量 onDeleteShot 循环",
  !/for \(const sid of shotIds\) await p\.onDeleteShot/.test(tl));
ok("D（停用/启用）作用于全部选中，不再是 clipIds[0]",
  !/const id = tlStore\(\)\.selection\.clipIds\[0\]/.test(app)
  && /toggleDisabled: \(\) => \{[\s\S]{0,600}for \(const c of clips\)/.test(app),
  "全选后按 D 只有一格变灰，看起来就是坏的——与 removeSelectedClips 当初"
  + "修掉的是同一个毛病：选中集说 N 个，操作只做 1 个");
ok("D 的方向按第一个选中镜头定，整批同向（不是逐个各自取反）",
  /const to = !clips\[0\]\.disabled/.test(app));

// ⚠️ 3.8 迁移：`additive` 的来源从 `e.shiftKey || e.ctrlKey || e.metaKey`
// 变成 `toggle`（只有 Ctrl/Cmd）。3.5 那条断言把两个键写死在一起，
// 而 3.8 恰恰要把它们分开 —— 断言随实现下移，**并且加了下面一整段
// 「Shift 现在是范围」的钉**，否则"分开"这件事本身没人守。
ok("加选（Ctrl/Cmd+click）不换预览源，也不触发外部选中 effect 清空加选",
  /const additive = toggle;[\s\S]{0,600}if \(additive\) return;/.test(tl),
  "否则 onSelectShot → selectedShotId 变 → effect 把刚加选的几个清成单选");
ok("Shift 与 Ctrl/Cmd 分工：Ctrl/Cmd 才是逐个加减",
  /const toggle = e\.ctrlKey \|\| e\.metaKey;/.test(tl)
  && !/const additive = e\.shiftKey \|\| e\.ctrlKey \|\| e\.metaKey;/.test(tl),
  "3.8 之前 Shift 与 Ctrl 完全等价，范围语义无处可去："
  + "想选第 12~40 镜只能点 29 下");
ok("Shift 走 rangeIds，锚点取自 store", /rangeIds\(st\.timeline\.tracks,\s*\n?\s*st\.selectionAnchor, clip\.id\)/.test(tl));
ok("范围选择把**原锚点原样传回**（否则范围只会越滚越大、缩不回去）",
  /st\.selectClips\(ids, st\.selectionAnchor\);/.test(tl),
  "锚点跟着走的话，第二次 Shift+点击变成「从上次终点再连一段」");
ok("Ctrl+Shift = 范围并进已选中的（去重）",
  /\[\.\.\.new Set\(\[\.\.\.st\.selection\.clipIds, \.\.\.r\.ids\]\)\]/.test(tl));
ok("范围选择不换预览源（与加选同理）",
  /p\.onToast\(`已选中 \$\{ids\.length\} 个片段`\);\s*\n\s*return;/.test(tl));
ok("范围失败时说明原因**并落回单选**（按住 Shift 点一下什么也没发生最糟）",
  /p\.onToast\(RANGE_HINT\[r\.reason\]\);/.test(tl)
  && /RANGE_HINT\[r\.reason\]\);[\s\S]{0,200}store\.selectClip\(clip\.id, additive\)/.test(tl));
ok("外部选中 effect 有 isClipSelected 守卫（加选的活路）",
  /if \(!st\.isClipSelected\(shot\.id\)\) st\.selectClips\(\[shot\.id\]\)/.test(tl));

ok("导出「所选」范围仍读 App.selectedShot，未被改成时间轴选中集",
  /selectedShotIds: selectedShot \? \[selectedShot\.id\] : \[\]/.test(app),
  "Ctrl+A 之后按导出，用户要的不是把刚全选的几百镜当作所选范围——"
  + "这一行是 3.5 明确不动的");

ok("selection.ts 是纯函数模块：不 import 任何 store / React",
  !/from "(zustand|react)"/.test(sel) && !/stores\//.test(sel),
  "它要能被本脚本在 node 下直接跑，也要能被三个入口共用");

/* ================================================================== *
 * ⑥' 6.9：放开判据的**对价** —— 三个消费选中集的操作都得有交代
 *
 * 这一段是文件头 🔀 那笔翻转的承重处。只放开 isSelectable 而不动下面
 * 三处，就正好回到 3.5 要根除的那个形态：高亮说"这 N 个会被操作"，
 * 按下去只有一部分真的动了，其余无声无息。
 * ================================================================== */
console.log("\n⑥' 6.9：音频/字幕进了选中集之后，Delete / Ctrl+X / D 各有交代");

const tlStoreSrc = read("src/stores/timelineStore.ts");

ok("Delete：removeSelectedClips 真的删音频/字幕（不是过滤掉了事）",
  /const others = o\?\.shotsOnly \? \[\]/.test(app)
  && /for \(const c of others\) await deleteTimelineClip\(c\);/.test(app),
  "过滤掉的话，选中一段音频按 Delete 会是彻底的静默——正是 3.5 修掉的形态");
ok("Delete：音频/字幕逐条串行删，各占一条撤销记录",
  /for \(const c of others\) await deleteTimelineClip\(c\);/.test(app),
  "并行发的话撤销栈顺序跟着网络先后走，Ctrl+Z 撤回来的顺序不确定");
ok("复制：copySelection 只收镜头（音频粘不成镜头）",
  /selection\.clipIds\.includes\(c\.id\) && c\.entity === "shot"/.test(tlStoreSrc),
  "收进剪贴板 = Ctrl+X 剪了却永远粘不回来，是无声的数据丢失");
ok("剪切：Ctrl+X 明说跳过了几个音频/字幕段，且不删它们",
  /removeSelectedClips\(\{ silent: true, shotsOnly: true \}\)/.test(app)
  && /跳过 \$\{skipped\} 个音频\/字幕段/.test(app));
ok("剪切：全是音频/字幕时说人话，而不是「先选中时间轴上的片段」",
  /音频\/字幕段不能剪切/.test(app),
  "用户明明选中了，说他没选中就是撒谎");
ok("剪切：clipboard 计数在 copySelection **之后**重新 getState",
  /st\.copySelection\(\);[\s\S]{0,400}const n = tlStore\(\)\.clipboard\.length;/.test(app),
  "zustand 的 set 换新对象，拿旧快照读到的是上一次复制的内容："
  + "第一次 Ctrl+X 会误报「先选中片段」");
ok("停用：选中的全是音频/字幕时说「没有停用，请按 Delete」",
  /音频\/字幕段没有「停用」/.test(app),
  "音频没有 disabled 这一列，也没有「留在轨上但不导出」的语义");
ok("停用：仍然只对镜头下手（别拿 undefined 去 PATCH /v2/shots/）",
  /const clips = sel\.filter\(\(c\) => c\.entity === "shot" && !!c\.shotId\);/.test(app));

/* ================================================================== *
 * ⑦ 锚点的生命周期（3.8）—— 真跑 store
 * ================================================================== */
console.log("\n⑦ Shift 锚点：该动的时候动，该清的时候清");

const tls = useTimelineStore.getState;
const fixture = {
  tracks: [
    { id: "v", kind: "video" as const, label: "视频 1", height: 40,
      locked: false, hidden: false, muted: false, solo: false, collapsed: false,
      clips: [
        { id: "c1", trackId: "v", startSec: 0, durationSec: 4, label: "1", shotId: "s1" },
        { id: "c2", trackId: "v", startSec: 4, durationSec: 4, label: "2", shotId: "s2" },
        { id: "c3", trackId: "v", startSec: 8, durationSec: 4, label: "3", shotId: "s3" },
      ],
      assetSegments: [] },
  ],
  totalDurationSec: 12,
};
tls().setTimeline(fixture as never);

tls().selectClip("c1");
check("单击移动锚点", tls().selectionAnchor, "c1");
tls().selectClip("c3", true);
check("Ctrl+单击也移动锚点（最后指过的那个就是下次量起的点）",
  tls().selectionAnchor, "c3");
tls().selectClip("c3", true);       // 再点一次 = 取消选中它
check("Ctrl+单击取消选中，锚点仍留在它身上（用户刚指过它）",
  [tls().selection.clipIds, tls().selectionAnchor], [["c1"], "c3"]);

tls().selectClips(["c2", "c3"]);
check("整批替换：锚点默认落到第一个", tls().selectionAnchor, "c2");
tls().selectClips(["c1", "c2", "c3"], "c3");
check("显式传锚点 → 保持不动（Shift 范围选择走这条）",
  tls().selectionAnchor, "c3");
tls().selectClips(["c1"], null);
check("显式传 null → 清掉锚点", tls().selectionAnchor, null);

tls().selectClip("c2");
tls().clearSelection();
check("点空白清空选中 → 锚点一起作废",
  [tls().selection.clipIds, tls().selectionAnchor], [[], null]);
tls().selectClip("c2");
tls().resetForProjectSwitch();
check("切项目 → 锚点清掉（旧项目的 clip id 留着必然指向空）",
  tls().selectionAnchor, null);

// 端到端：模拟"点 c1 → Shift 点 c3 → Shift 改点 c2"这串真实操作，
// 确认第三下**缩小**了范围而不是接着往外长 —— 这就是锚点必须钉住的全部理由。
tls().setTimeline(fixture as never);
tls().selectClip("c1");
const r1 = rangeIds(tls().timeline.tracks, tls().selectionAnchor, "c3");
if (r1.ok) tls().selectClips(r1.ids, tls().selectionAnchor);
check("Shift 点 c3 → 选中三个", tls().selection.clipIds, ["c1", "c2", "c3"]);
const r2 = rangeIds(tls().timeline.tracks, tls().selectionAnchor, "c2");
if (r2.ok) tls().selectClips(r2.ids, tls().selectionAnchor);
check("再 Shift 点 c2 → **缩小**到两个（锚点没动）",
  tls().selection.clipIds, ["c1", "c2"]);
check("锚点全程停在 c1", tls().selectionAnchor, "c1");

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 选中态全部通过：只有一套真源（timelineStore.selection），"
    + "高亮读的就是将被操作的集合；四个入口共用同一条「能不能选」判据；"
    + "一侧全选只有一份实现；Ctrl+A 之后按 Delete / D / 导出都不会出意外"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
