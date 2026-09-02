/**
 * 按集导出验证脚本（`npx tsx scripts/verify-episode-export.ts`）。
 *
 * 背景（2026-09-02 用户反馈）：只能整部导出，64 集的项目一次产出 1.7 小时的
 * 单文件，"并无意义且非常耗时"。改动是在导出对话框加「按集导出」，
 * 每集单独 normalize → 单独渲染成一个文件。
 *
 * 本脚本守住三件事：
 *  A. 分集切出来的时间轴**从 0 起算**且互不重叠、总和守恒（镜头/时长/音频不丢不重）
 *  B. 烧录字幕改由 plan 现算（planToSrt），不再用后端的全项目 SRT
 *     —— 后者从项目第一个镜头累加，按集导出会整体偏掉前面所有集的时长
 *  C. 文件名清洗（集标题里的非法字符不能把写盘搞挂）
 *
 * 数据来源：dev 库项目 9301（27fdcfbdbaa6）——64 集 / 601 镜全部已出片 /
 * 601 条真实音频段。**dev 库 subtitle_clips 为空**，故 B 组的字幕是本脚本
 * 按真实镜头 order 合成的（每镜一条），变速/分割镜头同理为合成注入——
 * 这两条路径没有真实数据可用，但正是最容易算错的地方，必须造数据覆盖。
 */
import { readFileSync } from "node:fs";
import { normalize } from "../src/render/normalize";
import { planToSrt } from "../src/render/srt";
import {
  safeFileName, episodeFileName, dirOf, baseOf, stripMp4,
} from "../src/lib/filename";
import type { ShotInfo } from "../src/api";
import type { AudioClipInfo, SubtitleClipInfo } from "../src/api";

const FIXTURE = process.env.FW_FIXTURE
  ?? "/private/tmp/claude-501/-root/"
     + "cf4983ca-b608-4da3-b06e-5c56c7449666/scratchpad/fx9301.json";

const fx = JSON.parse(readFileSync(FIXTURE, "utf-8")) as {
  projectId: string; shots: ShotInfo[]; audio: AudioClipInfo[];
};

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

// ---- 合成字幕：每个已出片镜头一条，镜内偏移固定 0.5s ----
// dev 库没有真实字幕数据，但字幕正是本次改动的风险点，必须造。
const subtitleClips: SubtitleClipInfo[] = fx.shots
  .filter((s) => s.video_url && !s.disabled)
  .map((s, i) => ({
    id: `sub_${s.id}`,
    text: `第${s.episode ?? 1}集-第${i + 1}条`,
    kind: "subtitle",
    start_shot_order: s.order,
    start_offset_sec: 0.5,
    duration: 2,
    style: null,
    created_at: null,
  }));

const episodes = [...new Set(fx.shots.map((s) => s.episode ?? 1))].sort((a, b) => a - b);
const planOf = (shots: ShotInfo[]) => normalize({
  projectId: fx.projectId, shots, audioClips: fx.audio, subtitleClips,
  transitions: [], output: OUTPUT, scope: "generated",
});

const whole = planOf(fx.shots);
const perEp = episodes.map((ep) => ({
  ep, plan: planOf(fx.shots.filter((s) => (s.episode ?? 1) === ep)),
}));

console.log(`=== 素材：${episodes.length} 集 / ${fx.shots.length} 镜 / `
  + `${fx.audio.length} 音频段；整部 ${whole.totalSec.toFixed(1)}s `
  + `(${(whole.totalSec / 60).toFixed(1)} 分) ===\n`);

const vclips = (p: typeof whole) =>
  p.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
const aclips = (p: typeof whole) =>
  p.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);

// ---- A. 时间轴切分 ----
check("1 每集都从 0s 起算",
  perEp.every(({ plan }) => {
    const c = vclips(plan).sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    return c.length > 0 && near(c[0].timelineStartSec, 0);
  }),
  `最长一集 ${Math.max(...perEp.map((e) => e.plan.totalSec)).toFixed(1)}s`);

const sumSec = perEp.reduce((a, e) => a + e.plan.totalSec, 0);
check("2 各集时长之和 == 整部时长", near(sumSec, whole.totalSec, 1e-6),
  `${sumSec.toFixed(3)} vs ${whole.totalSec.toFixed(3)}`);

const sumClips = perEp.reduce((a, e) => a + vclips(e.plan).length, 0);
check("3 镜头不丢不重", sumClips === vclips(whole).length,
  `${sumClips} vs ${vclips(whole).length}`);

const sumAudio = perEp.reduce((a, e) => a + aclips(e.plan).length, 0);
check("4 音频段不丢不重（锚定镜头在哪集就跟到哪集）",
  sumAudio === aclips(whole).length, `${sumAudio} vs ${aclips(whole).length}`);

check("5 音频/字幕都不越出本集时长",
  perEp.every(({ plan }) =>
    aclips(plan).every((c) => c.timelineStartSec < plan.totalSec + 1e-6)
    && plan.subtitles.every((s) => s.startSec < plan.totalSec + 1e-6)));

// 每集的镜头集合两两不相交
const seen = new Set<string>();
let overlap = 0;
for (const { plan } of perEp) {
  for (const c of vclips(plan)) { if (seen.has(c.id)) overlap++; seen.add(c.id); }
}
check("6 集与集之间无重复镜头", overlap === 0, `重复 ${overlap} 个`);

// ---- B. 字幕时间码：新口径 vs 旧口径（后端全项目 SRT）----
const sumSubs = perEp.reduce((a, e) => a + e.plan.subtitles.length, 0);
check("7 字幕条数不丢不重", sumSubs === whole.subtitles.length,
  `${sumSubs} vs ${whole.subtitles.length}`);

check("8 每集字幕都相对本集起点（第一条 ≈ 0.5s）",
  perEp.every(({ plan }) => {
    const first = [...plan.subtitles].sort((a, b) => a.startSec - b.startSec)[0];
    return first && near(first.startSec, 0.5, 1e-6);
  }));

// 旧口径 = 整部 plan 里同一条字幕的时间码（后端 subtitles.srt 就是这个累加方式）
const wholeById = new Map(whole.subtitles.map((s) => [s.id, s.startSec]));
let maxDrift = 0;
for (const { plan } of perEp) {
  for (const s of plan.subtitles) {
    maxDrift = Math.max(maxDrift, (wholeById.get(s.id) ?? 0) - s.startSec);
  }
}
check("9 旧口径（后端全项目 SRT）确实会漂移 —— 本次改动的理由", maxDrift > 60,
  `最末一集最大漂移 ${(maxDrift / 60).toFixed(1)} 分钟`);

// ---- planToSrt 本身 ----
const srt = planToSrt(perEp[perEp.length - 1].plan);
const blocks = srt.trim().split(/\n\s*\n/);
check("10 SRT 序号从 1 连续",
  blocks.every((b, i) => b.split("\n")[0] === String(i + 1)), `${blocks.length} 条`);
check("11 SRT 时间码格式合法",
  blocks.every((b) => /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/
    .test(b.split("\n")[1])), blocks[0]?.split("\n")[1]);
check("12 末集 SRT 从 00:00:00 附近开始（不带前 63 集的偏移）",
  blocks[0]?.split("\n")[1]?.startsWith("00:00:00,5"), blocks[0]?.split("\n")[1]);
check("13 空字幕不产出条目",
  planToSrt({ ...whole, subtitles: [{ id: "x", text: "  ", startSec: 0, durationSec: 2 }] })
  === "");
check("14 SRT 按时间升序", (() => {
  const ts = blocks.map((b) => b.split("\n")[1].slice(0, 12));
  return ts.every((t, i) => i === 0 || t >= ts[i - 1]);
})());

// ---- 变速 / 分割镜头：与后端 effective_shot_sec 同口径 ----
// 真实数据里没有变速与取片窗口，但这正是时间码最容易算歪的地方，故注入。
const epX = episodes[1];
const tweaked = fx.shots.map((s) => (s.episode ?? 1) === epX && s.video_url
  ? { ...s, clip_dur_sec: 4, transform_meta: { ...(s.transform_meta ?? {}), speed: 2 } }
  : s);
const planX = planOf(tweaked.filter((s) => (s.episode ?? 1) === epX));
const nX = vclips(planX).length;
check("15 变速+取片窗口按 clip_dur/speed 计入（4s÷2 = 2s/镜）",
  near(planX.totalSec, nX * 2, 1e-6), `${planX.totalSec.toFixed(2)}s / ${nX} 镜`);
check("16 变速后字幕仍锚在各自镜头起点上",
  planX.subtitles.every((s, i) => i === 0
    || near(s.startSec - planX.subtitles[i - 1].startSec, 2, 1e-6)));

// ---- 选了一部分集 ----
const pick = [episodes[0], episodes[5], episodes[9]];
const picked = pick.map((ep) => planOf(fx.shots.filter((s) => (s.episode ?? 1) === ep)));
check("17 挑选若干集：各自独立成片，条数等于所选集数",
  picked.length === 3 && picked.every((p) => vclips(p).length > 0
    && near(vclips(p).sort((a, b) => a.timelineStartSec - b.timelineStartSec)[0]
      .timelineStartSec, 0)));

// ---- C. 文件名清洗 ----
// 注意：全角「：」在 Windows 上是合法文件名字符，不该被替换（只有半角 : 才非法）——
// 中文剧集标题里几乎全是全角标点，一并替换会把标题打得满目疮痍。
check("18 半角非法字符被替换、全角标点保留",
  safeFileName('第1集：真相/揭晓?"<>|', 40) === "第1集：真相_揭晓_____",
  safeFileName('第1集：真相/揭晓?"<>|', 40));
check("19 结尾的点与空格被去掉（Windows 会静默吞）",
  safeFileName("片名... ", 40) === "片名");
check("20 超长集标题被截断", safeFileName("标".repeat(200), 40).length === 40);
check("21 空标题返回空串（调用方据此不拼后缀）", safeFileName("", 40) === "");
// 换行属控制字符，先被  - 那条替成 _（早于空白压缩），这是期望行为
check("22 换行被替换掉而不是留在文件名里",
  safeFileName("上\n下", 40) === "上_下", safeFileName("上\n下", 40));

// ---- D. 保存路径拆分（导出对话框里当场选位置）----
// 系统 save() 回的是完整路径，要拆成「记住的目录」+「回填到输入框的文件名」。
// Windows 上分隔符是反斜杠，只认 `/` 会把整条路径当文件名，
// 于是记住的导出目录变成垃圾、下次导出全落到错地方 —— 故两种分隔符都要覆盖。
check("23 POSIX 路径拆分",
  dirOf("C:/Users/x/影片/片名.mp4") === "C:/Users/x/影片"
  && baseOf("C:/Users/x/影片/片名.mp4") === "片名.mp4");
check("24 Windows 路径拆分",
  dirOf("C:\\Users\\alex\\影片\\片名.mp4") === "C:\\Users\\alex\\影片"
  && baseOf("C:\\Users\\alex\\影片\\片名.mp4") === "片名.mp4");
check("25 根目录下的文件不会把目录截成空串",
  dirOf("/片名.mp4") === "/片名.mp4" && baseOf("/片名.mp4") === "片名.mp4");
check("26 回填输入框时去掉扩展名（含大写 .MP4），避免再导一次变成 .mp4.mp4",
  stripMp4("片名.mp4") === "片名" && stripMp4("片名.MP4") === "片名"
  && stripMp4("片名") === "片名");
check("27 中间的 .mp4 不被误删（只截结尾）",
  stripMp4("片名.mp4.备份.mp4") === "片名.mp4.备份");

// ---- E. 对话框的路径预览 == 实际落盘路径 ----
// 用户是照着预览去文件夹里找文件的；预览与真正拼盘若各写一份规则，迟早对不上。
// 两边都调 episodeFileName，这里守住"同一批入参得到同一个文件名"。
const epTitle = "真相/揭晓：第一幕";
check("28 按集导出的文件名规则唯一（预览与落盘同源）",
  episodeFileName("我的片子", 3, epTitle) === "我的片子_第03集_真相_揭晓：第一幕.mp4",
  episodeFileName("我的片子", 3, epTitle));
check("29 集号补零到两位（文件管理器按名排序 == 集号顺序）",
  episodeFileName("x", 7).startsWith("x_第07集")
  && episodeFileName("x", 64).startsWith("x_第64集"));
check("30 无集标题时不留多余的下划线",
  episodeFileName("x", 1) === "x_第01集.mp4"
  && episodeFileName("x", 1, "   ") === "x_第01集.mp4");

console.log();
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} 项失败: ${FAILS.join(" / ")}`);
  process.exit(1);
}
console.log("✅ 全部通过");
