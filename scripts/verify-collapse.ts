/**
 * verify-collapse.ts — 停用镜头：导出不再静默丢字幕 · 时间轴不再画在同一个 startSec（7.2）
 *
 * ## 这两条 bug 是同一件事的两面
 *
 * 「停用」在两套坐标里的口径是一致的：**不产出画面、不占时间**。
 * `buildOrderOffsetMap` 是 `if (!s.disabled) acc += …`，`normalize` 是把它整个滤掉。
 * 麻烦出在"不占时间"的**后果**上，两边各自把它处理错了一半：
 *
 *   · **导出侧**：滤掉之后 `shotStartSec` 里没有它的条目，于是锚在它身上的音频与
 *     字幕撞上 `if (base === undefined) continue` —— **无声地**从成片里消失。
 *     时间轴上它们照常显示，用户只知道"导出来没有"，没有任何提示。
 *   · **时间轴侧**：`startSec` 与后继镜头相同（对的），`durationSec` 却仍是原时长
 *     （错的），于是整格画在后继镜头的位置上并被它盖住。看不见 → 点不到 →
 *     **右键菜单出不来 → 没法再启用**。停用是可逆操作，UI 上却成了单向的。
 *
 * ## 这个脚本为什么必须存在（不是"补个测试"）
 *
 * 7.2 的两处修改跑完 `verify:all` 之后 `✅` 出现次数**一个都没变**（2875 → 2875）——
 * 即在此之前，**没有任何一条既有断言碰过"停用镜头 + 锚定在它身上的字幕"这个组合**。
 * 全绿不代表被测过，只代表没人问过。这是「断言在装饰而非承重」的又一种形态：
 * 不是断言写松了，是这一整块**根本没有断言**。
 *
 * ## 两条不能碰的红线，逐条钉在下面
 *
 * ① **`buildOrderOffsetMap` 的返回值一个都不能变**。它是这条时间轴上唯一的
 *    "order → 绝对秒"真源：音频/字幕锚点、播放头边界（`buildEdgeSecs`）、接缝
 *    位置（`transitions.ts`）、`secToPosition` 全都由它派生，且 `verify-fold` /
 *    `verify-playhead` / `verify-transitions` 里钉着它的具体数值。所以"给停用镜头
 *    分配一点点秒数好腾出显示位置"这条路是封死的 —— 折叠只能发生在**像素层**。
 * ② **「不在导出范围内」仍然要丢**。7.2 放行的只有「停用」这一种情况；把 scope
 *    过滤也一并放行的话，一次"只导选中 3 镜"的导出会把全片的字幕都塞进去。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOrderOffsetMap, buildTimeline, collapseDisabled, shotToClip,
} from "../src/adapters/shotToClip";
import { normalize } from "../src/render/normalize";
import type { NormalizeInput } from "../src/render/normalize";
import type { RenderOutput } from "../src/render/model";
import type { Clip } from "../src/types/timeline";
// 只当类型用：`src/api.ts` 顶上读 `import.meta.env`，值导入会让本脚本在 node 下炸。
import type {
  ShotInfo, AudioClipInfo, SubtitleClipInfo, TransitionInfo,
} from "../src/api";

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

/* ---------- fixtures ---------- */

const OUT: RenderOutput = {
  width: 1080, height: 1920, fps: 30, vcodec: "libx264", crf: 23, withAudio: true,
};

/** 第 n 镜，默认 10 秒、已出片、启用、主轨 */
const shot = (order: number, over: Partial<ShotInfo> = {}): ShotInfo => ({
  id: `s${order}`, order, prompt: "", video_url: `/m/s${order}.mp4`,
  duration_sec: 10, disabled: false, characters: [], refs_stale: false,
  script_ref: null, is_special: false, status: "done",
  ...over,
} as unknown as ShotInfo);

const sub = (order: number, over: Partial<SubtitleClipInfo> = {}): SubtitleClipInfo => ({
  id: `sub${order}`, text: `字幕${order}`, kind: "normal",
  start_shot_order: order, start_offset_sec: 1, duration: 2,
  style: null, created_at: null, ...over,
});

const audio = (order: number, over: Partial<AudioClipInfo> = {}): AudioClipInfo => ({
  id: `a${order}`, kind: "narration", text: null, url: `/m/a${order}.mp3`,
  duration: 4, start_shot_order: order, start_offset_sec: 1,
  voice_ref_url: null, status: "done", error: null, ...over,
} as unknown as AudioClipInfo);

/** normalize 之后，字幕 id → 绝对起点 */
const subStarts = (
  shots: ShotInfo[], subs: SubtitleClipInfo[],
  // 只放开这三个：把整个 Partial<NormalizeInput> 摊进来会让 projectId/output
  // 在类型上变成可选，反而把必填项的保护拆掉。
  extra: Pick<Partial<NormalizeInput>, "scope" | "selectedShotIds" | "transitions"> = {},
) => Object.fromEntries(
  normalize({ projectId: "p", shots, subtitleClips: subs, output: OUT, ...extra })
    .subtitles.map((s) => [s.id, s.startSec]));

/** normalize 之后，音频 id → 绝对起点 */
const audioStarts = (shots: ShotInfo[], as: AudioClipInfo[]) => Object.fromEntries(
  normalize({ projectId: "p", shots, audioClips: as, output: OUT })
    .tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips)
    .map((c) => [c.id, c.timelineStartSec]));

/* ================================================================== */
console.log("\n① collapseDisabled：折叠是像素层的事，时长置 0 才是真话");
// 停用镜头在成片里一帧都不出现，`durationSec` 写原时长是在描述一个不存在的东西。
// 置 0 顺带修掉一串"把它当成有长度的格子"的地方：播放头落在哪一镜
// （App.tsx `ph >= startSec && ph < startSec + durationSec`，今天会先命中这个
// 看不见的停用镜头）、框选范围、吸附点、在播放头处分割。

const mk = (id: string, startSec: number, disabled: boolean): Clip => ({
  id, trackId: "t1", startSec, durationSec: 10, entity: "shot", shotId: id,
  label: id, disabled, isSpecial: false, status: "done",
  refsStale: false, characters: [],
});

{
  const src = [mk("a", 0, false), mk("b", 10, true), mk("c", 10, false)];
  const out = collapseDisabled(src);
  check("停用格的时长置 0", out[1].durationSec, 0);
  check("停用格拿到折叠下标", out[1].collapsedIndex, 0);
  check("启用格的时长不动", [out[0].durationSec, out[2].durationSec], [10, 10]);
  ok("启用格连 collapsedIndex 字段都不该有（有值 = 会被当折叠标记画）",
     out[0].collapsedIndex === undefined && out[2].collapsedIndex === undefined);
  ok("启用格原样透传（同一个对象）—— 无谓地复制会让 ClipView 的 memo 全部落空",
     out[0] === src[0] && out[2] === src[2]);
  ok("停用格是**新对象**，没有就地改掉调用方的数据",
     out[1] !== src[1] && src[1].durationSec === 10);
  check("startSec 一律不动（折叠不改秒坐标，那是 buildOrderOffsetMap 的事）",
        out.map((c) => c.startSec), [0, 10, 10]);
}
{
  // 连续停用是本条最容易漏的形态：三个标记的 startSec 一模一样，只给布尔的话
  // 它们会叠在同一个像素上 —— 还是"看不见 = 启用不回来"，只是从被后继盖住
  // 变成被同伴盖住。
  const out = collapseDisabled([
    mk("a", 0, false), mk("b", 10, true), mk("c", 10, true), mk("d", 10, true),
    mk("e", 10, false),
  ]);
  check("连续三个停用镜头依次错开", out.slice(1, 4).map((c) => c.collapsedIndex), [0, 1, 2]);
  check("遇到启用镜头后计数归零",
        collapseDisabled([mk("a", 0, true), mk("b", 0, false), mk("c", 10, true)])
          .map((c) => c.collapsedIndex), [0, undefined, 0]);
}
check("整轨都停用时下标仍然连号（否则全叠在 0 号位）",
      collapseDisabled([mk("a", 0, true), mk("b", 0, true)]).map((c) => c.collapsedIndex),
      [0, 1]);
check("空轨不炸", collapseDisabled([]), []);

/* ================================================================== */
console.log("\n② 红线一：buildOrderOffsetMap 的值一个都不能变");
// 它是"order → 绝对秒"的唯一真源，音频/字幕锚点、播放头边界、接缝位置、
// secToPosition 全由它派生，且 verify-fold / verify-playhead / verify-transitions
// 里钉着具体数值。"给停用镜头分配一点点秒数好腾出显示位置"这条路因此是封死的。

const proj = [shot(1), shot(2, { disabled: true }), shot(3), shot(4, { disabled: true })];
check("停用镜头占位但不推进；后继镜头与它同起点",
      [...buildOrderOffsetMap(proj).entries()], [[1, 0], [2, 10], [3, 10], [4, 20]]);
check("末尾停用镜头落在成片结尾（后面已经没有镜头了）",
      buildOrderOffsetMap(proj).get(4), 20);
check("整轨都停用 → 全部落在 0",
      [...buildOrderOffsetMap([shot(1, { disabled: true }), shot(2, { disabled: true })])
        .entries()], [[1, 0], [2, 0]]);
check("叠加层从来就不在这张表里（它的位置由 overlay_start_sec 决定）",
      [...buildOrderOffsetMap([shot(1), shot(2, { track_index: 1 })]).keys()], [1]);

/* ================================================================== */
console.log("\n③ buildTimeline：主轨折叠，叠加层不折叠");

{
  const tl = buildTimeline({ shots: proj });
  const v = tl.tracks.find((t) => t.id === "track-video-1")!;
  check("四格都还在轨上（折叠不是删除 —— 删了就更没法启用回来了）",
        v.clips.map((c) => c.id), ["s1", "s2", "s3", "s4"]);
  check("停用格被折叠", v.clips.map((c) => c.collapsedIndex), [undefined, 0, undefined, 0]);
  check("停用格不占时长", v.clips.map((c) => c.durationSec), [10, 0, 10, 0]);
  check("起点仍与 buildOrderOffsetMap 逐个相等",
        v.clips.map((c) => c.startSec), [0, 10, 10, 20]);
}
{
  // 叠加层的位置由 overlay_start_sec 决定，从不与谁共用起点，也就没有被盖住
  // 的问题；把它一并折叠只会让用户看不出叠加层上那一段有多长。
  const tl = buildTimeline({
    shots: [shot(1), shot(2, { track_index: 1, overlay_start_sec: 3, disabled: true })],
  });
  const ov = tl.tracks.find((t) => t.id === "track-video-2")!;
  check("叠加层上的停用镜头不折叠", ov.clips[0].collapsedIndex, undefined);
  check("叠加层上的停用镜头保留原时长", ov.clips[0].durationSec, 10);
}
ok("shotToClip 本身不管折叠（它只翻译一个镜头，看不到前后文）",
   shotToClip(shot(1, { disabled: true }), 0, "t").collapsedIndex === undefined);

/* ================================================================== */
console.log("\n④ 导出：停用镜头上的字幕/旁白不再被静默丢弃");
// 7.2 之前这里是 0 条字幕出去，且**没有任何提示** —— 时间轴上看得见、
// 成片里没有，用户只能自己发现。

{
  const shots = [shot(1), shot(2, { disabled: true }), shot(3)];
  const st = subStarts(shots, [sub(1), sub(2), sub(3)]);
  check("三条字幕全部进了成片（第 2 条正是 7.2 之前被丢掉的那条）",
        Object.keys(st).sort(), ["sub1", "sub2", "sub3"]);
  check("停用镜头上的字幕合拢到后继镜头的起点 + 自己的镜内偏移",
        st.sub2, 11);
  check("它与后继镜头自己的字幕在同一段时间里（这正是「合拢」的含义）",
        st.sub3, 11);
  check("前后两镜的字幕位置不受影响", [st.sub1, st.sub3], [1, 11]);
}
{
  const shots = [shot(1), shot(2, { disabled: true }), shot(3)];
  check("旁白同理 —— 停用的是画面，不是声音",
        audioStarts(shots, [audio(2)]), { a_a2: 11 });
}
{
  // 末尾几镜被停用时，前面的 flush 永远等不到"后继镜头"。不补最后一次 flush
  // 的话这几镜上的字幕又回到静默丢弃，只是换了个位置发生。
  const shots = [shot(1), shot(2), shot(3, { disabled: true })];
  check("末尾停用镜头上的字幕合拢到成片结尾", subStarts(shots, [sub(3)]).sub3, 21);
}
{
  const shots = [shot(1, { disabled: true }), shot(2)];
  check("首镜停用 → 合拢到 0", subStarts(shots, [sub(1)]).sub1, 1);
}
{
  const shots = [shot(1), shot(2, { disabled: true }), shot(3, { disabled: true }), shot(4)];
  const st = subStarts(shots, [sub(2), sub(3)]);
  check("连续两个停用镜头的字幕合拢到同一处", [st.sub2, st.sub3], [11, 11]);
}
{
  const shots = [shot(1, { disabled: true }), shot(2, { disabled: true })];
  check("整片都停用：字幕合拢到 0，且不崩",
        subStarts(shots, [sub(1), sub(2)]), { sub1: 1, sub2: 1 });
}

console.log("\n  停用镜头本身仍然不产出画面、不占时间");
{
  const plan = normalize({
    projectId: "p", shots: [shot(1), shot(2, { disabled: true }), shot(3)],
    subtitleClips: [sub(2)], output: OUT,
  });
  check("视频轨上只有两个 clip", plan.tracks[0].clips.map((c) => c.id), ["c_s1", "c_s3"]);
  check("成片总长 20s（停用那一镜的 10s 没有被算进去）", plan.totalSec, 20);
}

/* ================================================================== */
console.log("\n⑤ 红线二：「不在导出范围内」仍然要丢");
// 7.2 放行的只有「停用」这一种。把 scope 过滤一并放行的话，一次"只导选中 3 镜"
// 的导出会把全片的字幕都塞进去 —— 而且全都锚到 0 秒附近，因为它们的镜头
// 根本没参与累加。这比丢字幕更糟。

{
  const shots = [shot(1), shot(2), shot(3)];
  check("scope=selection：只有选中镜头上的字幕出去",
        subStarts(shots, [sub(1), sub(2), sub(3)],
                  { scope: "selection", selectedShotIds: ["s2"] }),
        { sub2: 1 });
}
{
  // 「选中范围」与「停用」仍然是两件事，在 selection 档下也不许合并判断：
  // 用户圈了 3 镜导出、其中一镜是停用的，那一镜上的字幕该合拢到下一镜继续播，
  // 而不是又一次无声消失（那正是本条要修的 bug，只是发生在另一个档里）。
  const shots = [shot(1), shot(2, { disabled: true }), shot(3)];
  check("选中范围里含停用镜头 → 它的字幕合拢到范围内的后继镜头",
        subStarts(shots, [sub(2), sub(3)],
                  { scope: "selection", selectedShotIds: ["s2", "s3"] }),
        { sub2: 1, sub3: 1 });
  check("没被选中的那一镜仍然整个不在这次导出里",
        Object.keys(subStarts(shots, [sub(1), sub(2)],
                              { scope: "selection", selectedShotIds: ["s2", "s3"] })),
        ["sub2"]);
}
{
  // 默认档只导已出片。未出片的镜头不在范围内，它的字幕跟着不导 ——
  // 这与「停用」不同：停用是"这一镜我不要了"，未出片是"这一镜还没做好"。
  const shots = [shot(1), shot(2, { video_url: null })];
  check("默认档：未出片镜头上的字幕仍然丢弃",
        Object.keys(subStarts(shots, [sub(1), sub(2)])), ["sub1"]);
  check("scope=all 下它就在范围内了，于是照常导出",
        subStarts(shots, [sub(2)], { scope: "all" }).sub2, 11);
}
{
  // 停用 + 不在范围内（未出片）：两个条件都成立时，"不在范围内"优先。
  const shots = [shot(1), shot(2, { video_url: null, disabled: true })];
  check("停用且未出片 → 仍然丢（它整个不在这次导出里）",
        Object.keys(subStarts(shots, [sub(2)])), []);
  check("同一镜在 scope=all 下就只剩「停用」一个条件 → 合拢导出",
        subStarts(shots, [sub(2)], { scope: "all" }).sub2, 11);
}
{
  // 叠加层的镜头从来就不在 shotStartSec 里（位置由 overlay_start_sec 决定），
  // 7.2 前后都一样跳过。折叠逻辑不许顺手把它塞进去。
  const shots = [shot(1), shot(2, { track_index: 1, disabled: true })];
  check("锚定在叠加层停用镜头上的字幕仍然跳过",
        Object.keys(subStarts(shots, [sub(2)], { scope: "all" })), []);
}

/* ================================================================== */
console.log("\n⑥ 与转场折叠的相互作用：合拢点取**后继镜头折叠后**的起点");
// 遇到停用镜头就当场写 cursor 是不对的：下一镜若带生效转场，cursor 还要往回退
// 一个转场时长。先写就会让这些字幕比它们该合拢到的那一镜**晚**一个转场时长
// ——4.0 修掉的正是同一类错位，只是换了个来源。所以攒着，落位那一刻才写。

const tr = (from: string, to: string, d: number): TransitionInfo => ({
  id: `t_${from}_${to}`, from_shot_id: from, to_shot_id: to,
  type: "fade", duration: d,
} as unknown as TransitionInfo);

{
  const shots = [shot(1), shot(2, { disabled: true }), shot(3)];
  // 链上相邻的是 s1 与 s3（停用镜头不进 mainChainIds），转场折叠 2 秒
  const st = subStarts(shots, [sub(2), sub(3)], { transitions: [tr("s1", "s3", 2)] });
  check("后继镜头因转场提前到 8s", st.sub3, 9);
  check("停用镜头上的字幕跟着提前到同一处（不是停在折叠前的 11s）",
        st.sub2, 9);
  ok("两者严格相等 —— 差一个转场时长就是 4.0 那类静默错位",
     st.sub2 === st.sub3);
}

/* ================================================================== */
console.log("\n⑦ 时间轴与导出**同口径**（同一个项目，两边算出的合拢点必须相等）");
// 这两个数各自算一遍是本条最容易复发的地方：一边改了另一边没改，症状是
// "时间轴上字幕在这儿、成片里在那儿"，两边都不报错。

for (const shots of [
  [shot(1), shot(2, { disabled: true }), shot(3)],
  [shot(1, { disabled: true }), shot(2), shot(3, { disabled: true })],
  [shot(1), shot(2, { disabled: true }), shot(3, { disabled: true }), shot(4)],
]) {
  const map = buildOrderOffsetMap(shots);
  const st = subStarts(shots, shots.map((s) => sub(s.order)));
  const disabledOrders = shots.filter((s) => s.disabled).map((s) => s.order);
  ok(`停用镜头 ${JSON.stringify(disabledOrders)}：两侧起点逐个相等`,
     shots.every((s) => st[`sub${s.order}`] === (map.get(s.order)! + 1)),
     `时间轴 ${JSON.stringify([...map])} / 导出 ${JSON.stringify(st)}`);
}

/* ================================================================== */
console.log("\n⑧ 静态钉：折叠只发生在像素层，且标记点得到");

const cv = read("src/features/timeline/ClipView.tsx");
ok("折叠标记宽度是**固定像素**，不是折算出来的秒数",
   /const COLLAPSED_PX = \d+;/.test(cv)
     && /width = collapsed \? COLLAPSED_PX/.test(cv),
   "折算成秒 = 推动 buildOrderOffsetMap = 时间轴与成片当场分家");
ok("标记画在接缝**左侧**（画右侧会压住后继镜头的左缘 trim 手柄）",
   /start \* p\.pxPerSec - \(c\.collapsedIndex! \+ 1\) \* COLLAPSED_PX/.test(cv));
ok("贴着时间轴开头时退化为从 0 往右排开，仍各占各的格子",
   /Math\.max\(c\.collapsedIndex! \* COLLAPSED_PX,/.test(cv),
   "钳到 0 的话，开头连续几个停用镜头又叠回同一个像素");
ok("折叠标记不渲染两个 trim 手柄（14px 里铺满手柄就没有可点的中间区域了）",
   /\{!collapsed && !p\.trackLocked && p\.onBeginTrimIn/.test(cv)
     && /\{!collapsed && !p\.trackLocked && \(/.test(cv));
ok("折叠标记仍然保留 EyeOff 角标（它是「这是什么」的唯一线索）",
   /\{c\.disabled && <span className="fw-clip-badge dim"/.test(cv));
ok("折叠标记不发缩略图请求（为一个不参与导出的镜头白下一张图）",
   /\{!collapsed && \(p\.variant === "audio"/.test(cv));
ok("title 说清了「为什么这么窄」和「怎么恢复」",
   cv.includes("已停用：不占时间轴、不参与导出。右键可重新启用"),
   "折叠标记里放不下任何文字，所有信息只能靠 title");

const css = read("src/features/timeline/ClipView.css");
ok("折叠标记的 z-index 高于普通片段（被盖住就又回到「点不到」）",
   /\.fw-clip\.collapsed \{[\s\S]{0,300}?z-index: 3;/.test(css));
ok("折叠标记只占下半格，让邻居整格高的 trim 手柄上半段仍然点得到",
   /\.fw-clip\.collapsed \{[\s\S]{0,300}?top: 50%;/.test(css));

const tl = read("src/features/timeline/Timeline.tsx");
check("两个 trim 入口都挡住折叠标记（键盘/程序触发的路径不经过 DOM）",
      (tl.match(/if \(clip\.collapsedIndex !== undefined\) return;/g) ?? []).length, 2);

const ad = read("src/adapters/shotToClip.ts");
ok("只有主轨走 collapseDisabled",
   /collapseDisabled\(mainShots\.map\(/.test(ad)
     && !/collapseDisabled\(byIndex/.test(ad));
ok("buildOrderOffsetMap 仍然是「停用不推进、但保留条目」",
   /map\.set\(s\.order, acc\);\s*\n\s*if \(!s\.disabled\) acc \+= shotDuration\(s\);/.test(ad),
   "改成 continue 就等于把停用镜头从时间轴上抹掉，字幕锚点全部落空");

const nz = read("src/render/normalize.ts");
ok("范围与停用**分开判**（合在一个 filter 里正是静默丢字幕的根）",
   /const inScope = \(s: ShotInfo\): boolean/.test(nz)
     && /const picked = scoped\.filter\(\(s\) => !s\.disabled\);/.test(nz));
ok("主循环遍历的是 scoped（含停用），不是 picked",
   /for \(const s of scoped\) \{/.test(nz),
   "遍历 picked 就看不到停用镜头，也就无从给它留起点");
ok("停用分支不推进 cursor（推进了就等于停用镜头仍占成片时间）",
   /if \(s\.disabled\) \{[\s\S]{0,200}?pendingDisabled\.push\(s\.order\);\s*\n\s*continue;/.test(nz));
ok("循环结束后还有一次 flush（末尾几镜停用时没有「后继镜头」可等）",
   (nz.match(/flushDisabled\(cursor\)/g) ?? []).length === 2);
ok("转场折叠仍只按 picked 建链（停用镜头不该出现在转场链上）",
   /const mainChainIds = picked/.test(nz));

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 停用镜头全部通过：锚在它身上的字幕/旁白合拢到后继镜头继续播、不再静默丢弃；"
    + "时间轴上折叠成看得见点得到的标记，而秒坐标一格都没动"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
