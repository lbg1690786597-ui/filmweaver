/**
 * 按片段导出验证脚本（`npx tsx scripts/verify-clip-export.ts`）。
 *
 * 背景（2026-09-09 用户需求）：单个镜头是投流/送审/二次剪辑的最小交付单位，
 * 此前只能整部或整集导出。改动是把旧的「仅选中」档换成「按片段导出」——
 * **一个镜头一个文件**；要导哪些**在导出对话框里勾选**（同日第二轮需求：
 * 与按集导出同一套交互，不再读时间轴选中态）。
 *
 * 本脚本守住四件事：
 *  A. 选片规则：`planClipJobs`（限定 id / 空 = 全部）与对话框口径
 *     `planPickedClipJobs`（null = 全部、[] = 一个都不导）；没出片、停用的不产文件
 *  B. 文件名唯一且按名排序 = 剧情顺序（600+ 镜的项目补 2 位就乱序了）
 *  C. 每个片段的时间轴**从 0 起算**、只含自己那一段音频与字幕
 *     —— 这是按集导出踩过的坑（用后端全项目 SRT 会整体偏掉前面所有集的时长）
 *  D. 一个片段渲染失败**不带走**其余片段（与按集导出同一条规则）
 *
 * 与 `verify-episode-export.ts` 不同，本脚本**不依赖任何 fixture 文件**：
 * 数据全部就地合成。按集那份脚本的 fixture 落在临时目录里，机器一换就跑不了，
 * 而这几条规则是纯逻辑，没有非造不可的真实数据。
 */
import { normalize } from "../src/render/normalize";
import { planToSrt } from "../src/render/srt";
import { safeFileName, clipFileName, pad3 } from "../src/lib/filename";
import {
  planClipJobs, planPickedClipJobs, summarizeExportRun, type JobOutcome,
} from "../src/features/export/exportRun";
import type { ShotInfo, AudioClipInfo, SubtitleClipInfo } from "../src/api";

const FAILS: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) FAILS.push(name);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const OUTPUT = {
  width: 1080, height: 1920, fps: 30,
  vcodec: "libx264", crf: 20, withAudio: true,
};

/** 合成镜头：3 集 × 4 镜 = 12 镜，order 全局连续（与后端一致）。
 *  故意掺进「没出片」与「已停用」两种镜头——它们不该产出文件。 */
const shots: ShotInfo[] = Array.from({ length: 12 }, (_, i) => {
  const order = i + 1;
  const episode = Math.floor(i / 4) + 1;
  const noVideo = order === 5;        // 未生成
  const disabled = order === 9;       // 已停用
  return {
    id: `s${order}`,
    order,
    episode,
    script_ref: `第${episode}集 第${order}镜`,
    link_to_prev: "cut",
    characters: [],
    location: null,
    video_url: noVideo ? null : `/media/v${order}.mp4`,
    duration_sec: 4 + (order % 3),    // 4/5/6 秒交替，别让时长全一样掩盖累加错误
    status: "done",
    disabled,
  } as unknown as ShotInfo;
});

const alive = shots.filter((s) => s.video_url && !s.disabled);   // 10 个

// 每镜一条旁白（起点锚在该镜 order + 0.5s 偏移）与一条字幕。
const audio: AudioClipInfo[] = alive.map((s) => ({
  id: `a${s.order}`, kind: "narration", text: `旁白 ${s.order}`,
  url: `/media/a${s.order}.mp3`, duration: 2,
  start_shot_order: s.order, start_offset_sec: 0.5,
  voice_ref_url: null, status: "done", error: null,
}));
const subs: SubtitleClipInfo[] = alive.map((s) => ({
  id: `t${s.order}`, text: `字幕 ${s.order}`, kind: "subtitle",
  start_shot_order: s.order, start_offset_sec: 0.5, duration: 2,
  style: null, created_at: null,
}));

// ---------------------------------------------------------------- A. 选片规则
console.log("\n── A. planClipJobs 选片规则 ──");

const all = planClipJobs(shots);
check("空选中 = 全部已出片且未停用的镜头", all.length === 10,
  `${all.length} 个（12 镜里 1 未生成、1 已停用）`);
check("未生成的镜头不产文件", !all.some((j) => j.order === 5));
check("已停用的镜头不产文件", !all.some((j) => j.order === 9));
check("按 order 升序", all.every((j, i) => i === 0 || all[i - 1].order < j.order),
  all.map((j) => j.order).join(","));
check("一个镜头一个 job（不合并）",
  new Set(all.map((j) => j.shot.id)).size === all.length);

const picked = planClipJobs(shots, ["s3", "s7", "s11"]);
check("勾选限定范围", picked.length === 3 && picked.map((j) => j.order).join(",") === "3,7,11");

const pickedDirty = planClipJobs(shots, ["s5", "s9", "s2"]);
check("勾选里的未生成/已停用镜头被静默跳过",
  pickedDirty.length === 1 && pickedDirty[0].order === 2,
  "勾了 3 个，其中 s5 未生成、s9 已停用");

check("勾选顺序打乱也按剧情顺序产出",
  planClipJobs(shots, ["s11", "s3", "s7"]).map((j) => j.order).join(",") === "3,7,11");

// 对话框口径（planPickedClipJobs）：三态。空数组这条是新增需求的要命之处——
// 用户在导出页把勾选清空，若退化成 planClipJobs 的"空 = 全部"，
// 点一下导出就是 601 个文件。
check("对话框口径：未动过勾选（null）= 全部",
  planPickedClipJobs(shots, null).length === 10);
check("对话框口径：主动清空勾选（[]）= 一个都不导，不是全部",
  planPickedClipJobs(shots, []).length === 0);
check("对话框口径：非空勾选只导勾的那些",
  planPickedClipJobs(shots, ["s2", "s12"]).map((j) => j.order).join(",") === "2,12");
check("对话框口径：只勾了未生成/已停用的镜头 → 0 个文件（不退化成全部）",
  planPickedClipJobs(shots, ["s5", "s9"]).length === 0);

check("集号取自镜头（缺省算第 1 集）",
  all.find((j) => j.order === 1)?.episode === 1
  && all.find((j) => j.order === 12)?.episode === 3);

const emptyProject = planClipJobs([]);
check("空项目产出 0 个 job（不是 1 个空文件）", emptyProject.length === 0);

// ---------------------------------------------------------------- B. 文件名
console.log("\n── B. 文件名 ──");

const base = safeFileName("重逢：第一部/试看", 60);
check("非法字符被清洗", !/[\\/:*?"<>|]/.test(base), base);

const names = all.map((j) => clipFileName(base, j.order, j.episode));
check("文件名唯一", new Set(names).size === names.length);
check("按名排序 = 剧情顺序",
  [...names].sort().join("|") === names.join("|"),
  names[0]);
check("镜号补零到 3 位（600+ 镜项目不乱序）",
  pad3(7) === "007" && pad3(120) === "120" && pad3(1424) === "1424");
check("文件名含集号与镜号",
  names[0] === `${base}_第01集_镜001.mp4`, names[0]);
check("缺集号时只带镜号",
  clipFileName(base, 3) === `${base}_镜003.mp4`);
check("每个文件都是 .mp4", names.every((n) => n.endsWith(".mp4")));

// 600+ 镜的排序回归：pad2 时代 `镜10` 会排到 `镜9` 前面
const big = Array.from({ length: 200 }, (_, i) => clipFileName("x", i + 1, 1));
check("200 个片段按名排序仍等于镜号顺序",
  [...big].sort().join("|") === big.join("|"));

// ---------------------------------------------------------------- C. 单片段时间轴
console.log("\n── C. 每个片段的时间轴从 0 起算 ──");

let cFrom0 = true, cOneShot = true, cAudioOwn = true, cSubOwn = true, cSrtFrom0 = true;
let cSrtOne = true;
let secSum = 0;
for (const j of all) {
  const plan = normalize({
    projectId: "p1",
    shots: [j.shot],                  // App 里每个 job 就是这样只带自己那一镜
    audioClips: audio,                // 故意把**全项目**的音频与字幕都递进去：
    subtitleClips: subs,              // 真实调用方也是这么传的，范围外的必须被丢掉
    transitions: [],
    output: OUTPUT,
    scope: "generated",
    selectedShotIds: [],
  });
  const vClips = plan.tracks.filter((t) => t.kind === "video")
    .flatMap((t) => t.clips);
  if (vClips.length !== 1) cOneShot = false;
  if (vClips[0] && !near(vClips[0].timelineStartSec, 0)) cFrom0 = false;
  secSum += plan.totalSec;

  // 音频：只该留锚在这一镜上的那一条，且偏移相对本片段起点
  const urlOf = (id: string) => plan.media.find((m) => m.id === id)?.url ?? "";
  const auds = plan.tracks.filter((t) => t.kind === "audio")
    .flatMap((t) => t.clips);
  const mine = auds.filter((c) => urlOf(c.mediaId) === `/media/a${j.order}.mp3`);
  if (auds.length !== 1 || mine.length !== 1) cAudioOwn = false;
  if (mine[0] && !near(mine[0].timelineStartSec, 0.5)) cAudioOwn = false;

  const st = plan.subtitles;
  if (st.length !== 1 || st[0].text !== `字幕 ${j.order}`) cSubOwn = false;
  if (st[0] && !near(st[0].startSec, 0.5)) cSubOwn = false;

  // 烧录 SRT 的时间码必须是 00:00:00,500 —— 用后端那份全项目 SRT 就会是
  // "从项目第一镜累加"的偏移值，那正是按集导出踩过的坑（见 srt.ts 文件头）。
  const srt = planToSrt(plan);
  if (!srt.includes("00:00:00,500 --> 00:00:02,500")) cSrtFrom0 = false;
  if (srt.split("\n\n").filter((b) => b.trim()).length !== 1) cSrtOne = false;
}
check("每个片段只含 1 个镜头", cOneShot);
check("每个片段的画面从 0 秒起算", cFrom0);
check("范围外的音频被丢弃，本镜那条偏移保留（0.5s）", cAudioOwn);
check("范围外的字幕被丢弃，本镜那条偏移保留（0.5s）", cSubOwn);
check("烧录 SRT 时间码从 0 起算（不带前序片段的累计偏移）", cSrtFrom0);
check("烧录 SRT 只含本片段那一条字幕", cSrtOne);

const wholeSec = alive.reduce((a, s) => a + (s.duration_sec ?? 5), 0);
check("各片段时长之和 = 整片时长（不丢不重）", near(secSum, wholeSec),
  `${secSum} vs ${wholeSec}`);

// ---------------------------------------------------------------- D. 失败不连坐
console.log("\n── D. 单个片段失败不带走其余片段 ──");

const outcomes: JobOutcome[] = all.map((j, i) => (
  i === 3
    ? { label: `第 ${j.episode} 集 · 镜 ${j.order}`, ok: false, error: "ffmpeg exit 1" }
    : { label: `第 ${j.episode} 集 · 镜 ${j.order}`, ok: true }
));
const sum = summarizeExportRun(outcomes, false, "/out", "（合计）");
check("9 个成功 1 个失败仍算部分完成", sum.okCount === 9 && sum.failed.length === 1);
check("失败原因进结果面板而不是只有一条 toast",
  sum.notices.length === 1 && sum.notices[0].includes("ffmpeg exit 1"));
check("toast 明说几成几败", (sum.toast ?? "").includes("9/10"), sum.toast ?? "");
check("有文件落盘就切结果面板", sum.showResult);

const aborted = summarizeExportRun(outcomes.slice(0, 4), true, "/out", "");
check("用户取消时已落盘的片段要说清楚",
  (aborted.toast ?? "").includes("3"), aborted.toast ?? "");

// ----------------------------------------------------------------
console.log(FAILS.length
  ? `\n❌ ${FAILS.length} 项失败：\n  · ${FAILS.join("\n  · ")}`
  : "\n✅ 全部通过");
process.exit(FAILS.length ? 1 : 0);
