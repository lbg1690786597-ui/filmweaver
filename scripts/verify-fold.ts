/**
 * verify-fold.ts — 转场折叠：成片坐标只有一套（批次 4 / 4.0）
 *
 * ## 这个脚本要防的是「画面折叠了、声音和字幕没折叠」再次发生
 *
 * `xfade` 是**重叠**两段而不是插入一段。`ffmpegCompiler.ts` 那行
 *
 *     baseDur = baseDur - tr.durationSec + cur.c.durationSec
 *
 * 让画面每遇一条生效转场就短一个转场时长。而 4.0 之前 `normalize.ts` 的 cursor
 * **从不减这一份**，音频的 `adelay`、字幕的 SRT 时间码、叠加层的起点又全都锚在
 * 这个 cursor 上 —— 于是每多一条生效转场，后面所有旁白与字幕就相对画面再晚一个
 * 转场时长。5 条 0.5s 的转场 = 尾部错位 2.5s。
 *
 * 这个 bug 的可怕之处在于**它完全静默**：不报错、不掉帧、导出退出码 0，
 * 只是嘴型对不上。用户多半会去怪配音、怪素材，不会怀疑导出。所以它只能靠
 * 断言守住，不能靠"下次注意"。① ~ ④ 段逐条钉住四个受害者
 * （主轨起点 / 音频锚点 / 字幕时间码 / 叠加层起点）都落在**同一套成片坐标**上。
 *
 * ## 第二件事：「哪条转场真的会折叠」只能有一份判据
 *
 * 3.6 的 `buildSeamMarkers` 要用它算工具条上那句「成片 −X.Xs」，4.0 的
 * `normalize` 要用它算真正的折叠。两处各写一遍必然漂移，而漂移的表现是
 * 「标签上写着成片会短 2.5s、实际短了 2.0s」这种没人查得出的偏差。
 * 判据因此下沉到 `lib/transitionFold.ts`，⑦ 段用同一批数据核对两条路径的
 * 总折叠量逐值相等，⑧ 段再静态钉住两边都没有偷偷再写一份相邻判定。
 *
 * ⚠️ **同源的是规则，不是输入**：`buildSeamMarkers` 喂编辑态的链（主轨 + 未停用），
 * `normalize` 喂导出态的链（再加 scope 过滤 + 必须真有 `video_url`）。⑥ 段专门
 * 钉住这个差异是**对的**：默认档不导未出片的镜头，跨过它们的两镜在成片里才相邻。
 *
 * ## 第三件事：折叠必须跟着本机 ffmpeg 走
 *
 * 编译器只在 `hasFilter(caps,"xfade") && hasTransition(caps,type)` 时才走 xfade，
 * 否则降级硬切、**画面不折叠**。折叠预测若不带这个条件，在缺某个转场类型的老
 * ffmpeg 上会反过来把音频/字幕锚**早**一个转场时长 —— 同一个 bug 换个方向，
 * 而且更难查（用户会觉得"新版本更不对了"）。⑤ 段钉住谓词真的会否决折叠，
 * ⑧ 段钉住 `App.tsx` 确实把 caps 传了进去（漏传就退化成"一律折叠"）。
 *
 * ## 第四件事：时间轴故意**不**折叠，这是决定不是遗漏
 *
 * 折叠时间轴坐标会让相邻两镜真的重叠 `foldSec` 秒，而 `secToPosition` 那套
 * 「绝对秒 → 第几镜」的反查在重叠区里就成了多值的 —— 播放头、吸附、框选、修剪
 * 全都建立在"镜头互不重叠"之上。⑨ 段把这个决定钉成断言：时间轴仍是未折叠坐标，
 * 两套坐标之间的换算就是 `foldTime`，而不是"哪天顺手也折一下"。
 *
 * 跑法：npx tsx scripts/verify-fold.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chainIndex, isAdjacent, foldingLinks, foldTime,
} from "../src/lib/transitionFold";
import type { ChainLink, Seam } from "../src/lib/transitionFold";
import { normalize } from "../src/render/normalize";
import { buildSeamMarkers } from "../src/features/timeline/transitions";
import { buildOrderOffsetMap } from "../src/adapters/shotToClip";
import { planToSrt } from "../src/render/srt";
import type {
  ShotInfo, TransitionInfo, AudioClipInfo, SubtitleClipInfo,
} from "../src/api";
import type { RenderOutput } from "../src/render/model";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown, detail = "") {
  const okEq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okEq) failed++;
  console.log(`  ${okEq ? "✅" : "❌"} ${name}`);
  if (!okEq) {
    console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
    if (detail) console.log(`      ${detail}`);
  }
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/* ================================================================== */
/* 测试数据：主轨 4 镜各 3s，三条 0.5s fade 串成一条链                    */
/* ================================================================== */

const OUT: RenderOutput = {
  width: 1080, height: 1920, fps: 30, vcodec: "libx264", crf: 20, withAudio: true,
};

function shot(i: number, over: Partial<ShotInfo> = {}): ShotInfo {
  return {
    id: `s${i}`, order: i, episode: 1, script_ref: `镜${i}`,
    link_to_prev: "cut", characters: [], location: null,
    video_url: `/fw/media/v${i}.mp4`, thumb_url: null, status: "adopted",
    adopted_version: 1, is_special: false, gen_prompt: null, stale: false,
    prompt_state: null, duration_sec: 3, clip_dur_sec: 3, disabled: false,
    special_name: null, ref_overrides: null, refs_stale: false,
    first_frame_url: null, profile_override: null, track_index: 0, ...over,
  } as unknown as ShotInfo;
}

function tr(
  id: string, from: number, to: number, dur = 0.5, type = "fade",
): TransitionInfo {
  return {
    id, type, duration: dur,
    from_shot_id: `s${from}`, to_shot_id: `s${to}`, params: null,
  } as unknown as TransitionInfo;
}

/** 主轨 4 镜 + 一个叠加层镜头（未折叠绝对秒 7.0） */
const SHOTS: ShotInfo[] = [
  shot(1), shot(2), shot(3), shot(4),
  shot(9, { track_index: 1, overlay_start_sec: 7.0 }),
];
const TRS: TransitionInfo[] = [tr("t1", 1, 2), tr("t2", 2, 3), tr("t3", 3, 4)];

const AUDIO: AudioClipInfo[] = [
  {
    id: "a1", kind: "narration", url: "/fw/media/a1.mp3", status: "done",
    duration: 2, start_shot_order: 3, start_offset_sec: 0, source_shot_id: null,
  } as unknown as AudioClipInfo,
];
const SUBS: SubtitleClipInfo[] = [
  {
    id: "sub1", text: "第四镜的台词", duration: 2,
    start_shot_order: 4, start_offset_sec: 0, style: null,
  } as unknown as SubtitleClipInfo,
];

const plan = normalize({
  projectId: "p", shots: SHOTS, transitions: TRS,
  audioClips: AUDIO, subtitleClips: SUBS, output: OUT, scope: "generated",
});

const mainClips = plan.tracks.find((t) => t.id === "v1")!.clips;
const overlayClips = plan.tracks.find((t) => t.id === "v2")!.clips;
const audioClips = plan.tracks.find((t) => t.kind === "audio")!.clips;

/* ================================================================== */
console.log("\n① 主轨：每条生效转场都让后面所有镜头前移一个转场时长");
/* ================================================================== */

// 未折叠是 0 / 3 / 6 / 9；三条 0.5s 转场逐条累积前移
check("四镜起点按折叠后的成片秒",
  mainClips.map((c) => c.timelineStartSec), [0, 2.5, 5, 7.5],
  "若得到 [0,3,6,9] 说明 cursor 又不减重叠了，正是 4.0 修掉的那个 bug");
check("时长不受折叠影响（xfade 吃的是重叠，不是素材）",
  mainClips.map((c) => c.durationSec), [3, 3, 3, 3]);
check("totalSec 是成片时长，不是时间轴时长", plan.totalSec, 10.5,
  "时间轴 12s − 3×0.5s = 10.5s；这个差正是 3.6 工具条上的「成片 −1.5s」");

/* ================================================================== */
console.log("\n② 音频：锚点跟着画面走，不再整体偏晚");
/* ================================================================== */

check("锚在第 3 镜的旁白落在第 3 镜的**折叠后**起点", audioClips[0].timelineStartSec, 5,
  "偏晚的那一版会给出 6（=未折叠的 6.0），成片里旁白比画面晚 1.0s");
ok("音频锚点与主轨第 3 镜起点逐值相等",
  audioClips[0].timelineStartSec === mainClips[2].timelineStartSec,
  "两者必须是同一个数，不是「接近」——它们读的就该是同一个 shotStartSec");

/* ================================================================== */
console.log("\n③ 字幕：SRT 时间码同样落在成片坐标上");
/* ================================================================== */

check("锚在第 4 镜的字幕起点", plan.subtitles[0].startSec, 7.5);
ok("SRT 首条时间码是 00:00:07,500 而不是 00:00:09,000",
  /00:00:07,500 --> 00:00:09,500/.test(planToSrt(plan)),
  `实际：\n${planToSrt(plan)}`);

/* ================================================================== */
console.log("\n④ 叠加层：overlay_start_sec 是时间轴秒，必须换算");
/* ================================================================== */

// 未折叠 7.0 = 第 3 镜内 1.0s；第 3 镜折叠后起点 5.0 → 6.0
check("叠加层起点由 foldTime 换算到成片坐标", overlayClips[0].timelineStartSec, 6,
  "compileSegment 里 st = timelineStartSec − seg.startSec，段起点已折叠，"
  + "这里不换算就会整体偏晚——和音频字幕是同一个错位，只是换了条轨");
ok("叠加层仍在它原本对齐的那一镜之内",
  overlayClips[0].timelineStartSec >= mainClips[2].timelineStartSec
  && overlayClips[0].timelineStartSec < mainClips[3].timelineStartSec,
  "换算错了的典型症状是它漂到了下一镜");

/* ================================================================== */
console.log("\n⑤ caps：本机跑不了的转场不会折叠（否则错位方向反过来）");
/* ================================================================== */

const planNoZoom = normalize({
  projectId: "p", shots: SHOTS, output: OUT, scope: "generated",
  transitions: [tr("t1", 1, 2), tr("t2", 2, 3, 0.5, "zoomin"), tr("t3", 3, 4)],
  foldsTransition: (type) => type !== "zoomin",
});
check("不被支持的那条降级硬切、不折叠",
  planNoZoom.tracks.find((t) => t.id === "v1")!.clips.map((c) => c.timelineStartSec),
  [0, 2.5, 5.5, 8],
  "第 2 条不折叠 → 第 3 镜起点是 2.5+3=5.5，只有 t1/t3 各扣 0.5");
check("totalSec 相应只短 1.0s", planNoZoom.totalSec, 11);
check("缺省不传谓词时一律视作会执行（拿不到 caps 时最接近现实）",
  normalize({
    projectId: "p", shots: SHOTS, transitions: TRS, output: OUT, scope: "generated",
  }).totalSec, 10.5);

/* ================================================================== */
console.log("\n⑥ 链是**导出态**的链：跨过未出片镜头的两镜在成片里就是相邻的");
/* ================================================================== */

const holed: ShotInfo[] = [shot(1), shot(2, { video_url: null }), shot(3), shot(4)];
const planHoled = normalize({
  projectId: "p", shots: holed, output: OUT, scope: "generated",
  transitions: [tr("tx", 1, 3)],   // 编辑器上隔着 #2，导出时 #2 不存在
});
check("默认档下 #1→#3 折叠生效",
  planHoled.tracks.find((t) => t.id === "v1")!.clips.map((c) => c.timelineStartSec),
  [0, 2.5, 5.5],
  "拿编辑态的镜头列表判相邻会得出「不相邻、不折叠」，与编译器不符");

const planAll = normalize({
  projectId: "p", shots: holed, output: OUT, scope: "all",
  transitions: [tr("tx", 1, 3)],
});
check("scope=all 时占位镜头仍不参与串接，#1→#3 照旧折叠",
  planAll.tracks.find((t) => t.id === "v1")!.clips.map((c) => c.timelineStartSec),
  [0, 5.5, 8.5],
  "链只由**真会产出 clip** 的镜头组成——编译器串的就是这些，占位镜头不在其中。"
  + "（占位镜头仍推进 3s 的既有「幽灵空档」是另一个问题，与折叠无关）");

const planFar = normalize({
  projectId: "p", shots: [shot(1), shot(2), shot(3), shot(4)],
  output: OUT, scope: "generated",
  transitions: [tr("tx", 1, 3)],   // 中间真的隔着一镜
});
check("两镜之间真的隔着别的镜头时不折叠（编译器只在相邻两 clip 间找转场）",
  planFar.tracks.find((t) => t.id === "v1")!.clips.map((c) => c.timelineStartSec),
  [0, 3, 6, 9],
  "这一条不生效、成片是硬切，折叠量必须为 0，否则音频字幕会反过来偏早");

/* ================================================================== */
console.log("\n⑦ 判据同源：normalize 与 buildSeamMarkers 给出同一个折叠量");
/* ================================================================== */

const markers = buildSeamMarkers(SHOTS, TRS);
const offsets = buildOrderOffsetMap(SHOTS);
const rawTotal = SHOTS.filter((s) => (s.track_index ?? 0) === 0)
  .reduce((a, s) => a + (s.duration_sec ?? 0), 0);
check("时间轴总时长（未折叠）", rawTotal, 12);
check("工具条预测的总折叠量", markers.reduce((a, m) => a + m.foldSec, 0), 1.5);
ok("预测值 = 时间轴总时长 − 成片总时长（逐值相等，不是近似）",
  Math.abs((rawTotal - plan.totalSec) - markers.reduce((a, m) => a + m.foldSec, 0)) < 1e-9,
  "两处各写一份判据的漂移，症状就是这两个数差一点点");
ok("接缝位置仍取自 buildOrderOffsetMap（未折叠坐标）",
  markers[1].atSec === offsets.get(3),
  "标记画在时间轴上，时间轴不折叠——见 ⑨");

// 同一条缝上的第二条转场：编译器用 `.find`，只跑一条。工具条若按"状态是 ok
// 就计入"来算，就会比画面多扣一份——这正是把判据下沉到 lib 才修掉的那类漂移。
const DUP: TransitionInfo[] = [...TRS, tr("t2b", 3, 2)];
const dupMarkers = buildSeamMarkers(SHOTS, DUP);
const dupPlan = normalize({
  projectId: "p", shots: SHOTS, transitions: DUP, output: OUT, scope: "generated",
});
check("重复转场的两条状态都是 ok（它们本身没毛病，是同一条缝上撞车了）",
  dupMarkers.filter((m) => m.state === "ok").length, 4);
check("但只有一条计入折叠", dupMarkers.reduce((a, m) => a + m.foldSec, 0), 1.5,
  "按「state === ok」直接计入会得到 2.0，比画面多扣 0.5s");
ok("重复转场下预测值仍 = 时间轴 − 成片",
  Math.abs((rawTotal - dupPlan.totalSec)
    - dupMarkers.reduce((a, m) => a + m.foldSec, 0)) < 1e-9,
  `成片 ${dupPlan.totalSec}s，预测折叠 ${dupMarkers.reduce((a, m) => a + m.foldSec, 0)}s`);

/* ================================================================== */
console.log("\n⑧ lib/transitionFold.ts 纯函数");
/* ================================================================== */

const ids = ["a", "b", "c", "d"];
const pos = chainIndex(ids);
ok("相邻不要求方向：b→a 与 a→b 同样有效",
  isAdjacent(pos, "a", "b") && isAdjacent(pos, "b", "a"),
  "编译器 seg.transitions.find 两个方向都认，判成不相邻是虚警");
ok("隔一个不算相邻", !isAdjacent(pos, "a", "c"));
ok("链外的 id 不算相邻", !isAdjacent(pos, "a", "zzz"));

const L = (id: string, f: string, t: string, d = 0.5, ty = "fade"): ChainLink =>
  ({ id, fromId: f, toId: t, durationSec: d, type: ty });

check("只留相邻的，并按链上位置排序",
  foldingLinks(ids, [L("l3", "c", "d"), L("lx", "a", "c"), L("l1", "a", "b")])
    .map((l) => [l.id, l.atIndex]),
  [["l1", 1], ["l3", 3]]);
check("反向连接的 atIndex 仍取靠后那个",
  foldingLinks(ids, [L("lr", "c", "b")]).map((l) => l.atIndex), [2]);
check("同一条缝上的第二条被丢弃，且**先到先得**（与编译器的 .find 同序）",
  foldingLinks(ids, [L("first", "a", "b", 0.5), L("second", "b", "a", 0.7)])
    .map((l) => [l.id, l.durationSec]),
  [["first", 0.5]],
  "重复计入会让折叠比画面多扣一份——又是那种「差一点点、查不出来」的错位");
check("caps 谓词能否决折叠",
  foldingLinks(ids, [L("l1", "a", "b"), L("l2", "b", "c", 0.5, "zoomin")],
    (l) => l.type !== "zoomin").map((l) => l.id),
  ["l1"]);

const seams: Seam[] = [{ atSec: 3, foldSec: 0.5 }, { atSec: 6, foldSec: 0.5 }];
check("foldTime 累减所有 ≤ t 的接缝", [2, 3, 5, 6, 9].map((t) => foldTime(t, seams)),
  [2, 2.5, 4.5, 5, 8]);
check("空接缝表恒等", foldTime(7.25, []), 7.25);
check("兜 0：脏数据不该产出负时间码",
  foldTime(0.1, [{ atSec: 0, foldSec: 99 }]), 0);
ok("接缝处**故意**不单调（叠化区天然对应两个成片秒，掰单调只会让叠加层后移）",
  foldTime(2.9, seams) > foldTime(3, seams),
  "这条断言是把「不掰」钉成决定，防止哪天有人顺手加个 running max");

/* ================================================================== */
console.log("\n⑨ 静态钉：规则只有一份，caps 真的传进去了，时间轴仍不折叠");
/* ================================================================== */

const norm = read("src/render/normalize.ts");
const tmod = read("src/features/timeline/transitions.ts");
const app = read("src/App.tsx");

ok("normalize.ts 用的是 lib/transitionFold，没有自己的相邻判定",
  /from "\.\.\/lib\/transitionFold"/.test(norm) && !/Math\.abs\(/.test(norm));
ok("transitions.ts 用的是 lib/transitionFold，没有自己的相邻判定",
  /from "\.\.\/\.\.\/lib\/transitionFold"/.test(tmod) && !/Math\.abs\(ia/.test(tmod));
ok("normalize.ts 对折叠后的 cursor 兜了 0",
  /Math\.max\(0, cursor - fold\)/.test(norm),
  "tooLong 的脏数据（转场比前面整条链还长）不该产出负的时间码");
ok("foldTime 在 normalize 里只用于叠加层（锚定镜头的走 shotStartSec，更准）",
  (norm.match(/foldTime\(/g) ?? []).length === 1);
// 只 grep 全文会被那句 `const foldsTransition = …` 蒙混过去（算出来了却没传）。
// 这里只看 normalizeRenderPlan 的那对括号里。
const callTail = app.slice(app.indexOf("normalizeRenderPlan({"));
const callArgs = callTail.slice(0, callTail.indexOf("});"));
ok("App.tsx 把 caps 判据**传进了** normalize 的调用",
  /foldsTransition/.test(callArgs)
  && /hasFilter\(caps, "xfade"\) && hasTransition\(caps, type\)/.test(app),
  "漏传就退化成「一律折叠」，在缺某个转场类型的机器上把锚点提早一个转场时长");
ok("时间轴坐标仍**不**折叠（buildOrderOffsetMap 未被改成折叠版）",
  !/transitionFold/.test(read("src/adapters/shotToClip.ts")),
  "折叠时间轴会让相邻两镜真的重叠，secToPosition 的反查随之变成多值——"
  + "播放头/吸附/框选/修剪全都建立在「镜头互不重叠」之上");

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 转场折叠全部通过：主轨/音频/字幕/叠加层落在同一套成片坐标；"
    + "「会不会折叠」的判据只有一份且带 caps；导出态与编辑态各喂各的链；"
    + "时间轴仍是未折叠坐标，换算由 foldTime 显式承担"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
