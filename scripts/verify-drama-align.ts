/**
 * verify-drama-align.ts — 真人剧「已有文本 → 本地对齐字幕」的离线验证
 *
 * 验的是 `align.ts` 里为真人剧新增的那一段（`speechRegions` / `clipSilences` /
 * `alignCuesInSpeech` / `alignLinesInSpeech`）与 `sources.ts:dramaSources`。
 *
 * 为什么必须单独有这个脚本：真人剧与旁白的差别不在"分条"而在**时间分配**——
 * 一镜是「▲动作 3 秒 → 台词 → ▲动作 2 秒」，按墙上时间线性摊会让字幕
 * 早出晚退好几秒，而这种错位**看代码看不出来，只看得出时间数字**。
 * 另外剪过的镜头（clip_in/clip_dur）若不裁停顿，字幕会全错且不报错。
 *
 * 端到端那一节跑真视频（`FW_DRAMA_VIDEO` + `FW_DRAMA_LINES`），
 * 两者都只在开发机上、**不进仓库**（desktop/ 会被推到公开仓，
 * 用户的剧本原文与素材不能跟着出去）。缺任一项时该节自动跳过。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  parseSilence, parseMeanVolume, adaptiveNoiseDb, speechRegions, clipSilences,
  alignCuesInSpeech, alignLinesInSpeech,
  ADAPTIVE_MIN_DB, ADAPTIVE_MAX_DB, type Silence,
} from "../src/features/subtitles/align";
import { dramaSources } from "../src/features/subtitles/sources";

const VIDEO = process.env.FW_DRAMA_VIDEO || "";
const LINES_FILE = process.env.FW_DRAMA_LINES || "";
/** 该镜实际用到的秒数（片窗口长度）。 */
const TOTAL = Number(process.env.FW_DRAMA_SEC || 0);
const NOISE_DB = -32, MIN_SIL = 0.18;

let failed = 0;
function ok(cond: boolean, msg: string, extra?: unknown) {
  if (cond) { console.log(`  ✓ ${msg}`); return; }
  failed++;
  console.log(`  ✗ ${msg}`);
  if (extra !== undefined) console.log("      ", extra);
}

// ---------------------------------------------------------------------------
console.log("\n[1] speechRegions —— 静音的补集");
{
  // 一镜 10s：0~3 动作静音、3~6 说话、6~10 动作静音
  const r = speechRegions([{ start: 0, end: 3 }, { start: 6, end: 10 }], 10);
  ok(r.length === 1 && Math.abs(r[0].start - 3) < 1e-6 && Math.abs(r[0].end - 6) < 1e-6,
     "首尾静音被排除，只剩中间的有声区间", r);

  const none = speechRegions([], 10);
  ok(none.length === 1 && none[0].start === 0 && none[0].end === 10,
     "探不到静音时，整镜都算有声（退化为原行为）", none);

  // 重叠/相接的静音块必须先合并，否则补集里会冒出零宽或负宽区间
  const merged = speechRegions(
    [{ start: 0, end: 2 }, { start: 1.5, end: 3 }, { start: 3, end: 4 }], 10);
  ok(merged.length === 1 && Math.abs(merged[0].start - 4) < 1e-6,
     "重叠与首尾相接的静音先合并再取补集", merged);

  // 碎片过滤：语气词/呼吸处切出的 0.05s 小块承不起一条字幕
  const frag = speechRegions(
    [{ start: 0, end: 3 }, { start: 3.05, end: 6 }, { start: 6.05, end: 10 }], 10);
  ok(frag.length === 0, "短于 minSec 的碎片有声区间被丢掉", frag);

  const all = speechRegions([{ start: 0, end: 10 }], 10);
  ok(all.length === 0, "整镜静音 → 没有有声区间", all);
}

// ---------------------------------------------------------------------------
console.log("\n[2] clipSilences —— 把文件时间裁进片窗口");
{
  // 探的是整个视频文件（0~20s），这一镜只用 5~13s 这一段
  const raw: Silence[] = [
    { start: 0, end: 2 },      // 完全在窗口前 → 丢
    { start: 4, end: 6 },      // 跨左边界 → 裁成 0~1
    { start: 8, end: 9 },      // 完全在窗口内 → 3~4
    { start: 12, end: 18 },    // 跨右边界 → 7~8
    { start: 19, end: 20 },    // 完全在窗口后 → 丢
  ];
  const c = clipSilences(raw, 5, 8);
  ok(c.length === 3, "窗口外的整段被丢掉", c);
  ok(Math.abs(c[0].start - 0) < 1e-6 && Math.abs(c[0].end - 1) < 1e-6,
     "跨左边界的裁到窗口起点并平移为 0", c[0]);
  ok(Math.abs(c[1].start - 3) < 1e-6 && Math.abs(c[1].end - 4) < 1e-6,
     "窗口内的整体平移 -winStart", c[1]);
  ok(Math.abs(c[2].end - 8) < 1e-6, "跨右边界的裁到窗口末尾", c[2]);
  ok(c.every((s) => s.end > s.start && s.start >= 0 && s.end <= 8),
     "结果全部落在 [0, winDur] 内且非零宽", c);

  // 没剪过的镜头：winStart=0，应当原样通过
  const same = clipSilences(raw, 0, 20);
  ok(same.length === 5 && Math.abs(same[3].end - 18) < 1e-6,
     "未剪过的镜头（winStart=0, winDur=全长）原样通过", same.length);
}

// ---------------------------------------------------------------------------
console.log("\n[3] alignCuesInSpeech —— 时间只在有声区间里分配");
{
  // 这一节是整个真人剧路径的**核心断言**：
  // 一镜 10s，只有 3~6s 有人声，两条字幕必须落在 3~6 之内，
  // 而不是被摊到 0~10（那就是"字幕早出 3 秒、说完还挂 4 秒"）。
  const sil = [{ start: 0, end: 3 }, { start: 6, end: 10 }];
  const cues = alignCuesInSpeech(["你到底是谁", "我是楚家的人"], sil, 10);
  ok(cues.length === 2, "两条 cue 都在", cues.length);
  ok(cues[0].start >= 3 - 1e-6, "首条不早于人声起点（不再提前 3 秒出现）", cues[0]);
  ok(cues[cues.length - 1].end <= 6 + 1e-6,
     "末条不晚于人声终点（说完就走，不挂到镜头结束）", cues[cues.length - 1]);
  ok(cues.every((c, i) => i === 0 || c.start >= cues[i - 1].end - 1e-6),
     "相邻字幕不重叠", cues);
  ok(cues.every((c) => c.end > c.start), "没有零长/负长字幕", cues);

  // 对照：同样的输入交给墙上时间线性分配会怎样 —— 用来证明上面那条断言
  // 不是自证。线性分配的首条必然从 0 附近开始。
  const linear = alignCuesInSpeech(["你到底是谁", "我是楚家的人"], [], 10);
  ok(linear[0].start < 1,
     "（对照）没有静音数据时退化为线性分配，首条从 0 附近开始", linear[0]);

  // 多段有声区间：跨区间的边界要落在区间内，不能落进静音里
  const multi = alignCuesInSpeech(
    ["第一句话在这里", "第二句话在那里", "第三句收个尾"],
    [{ start: 0, end: 1 }, { start: 4, end: 7 }, { start: 11, end: 12 }], 12);
  const inSpeech = (t: number) =>
    (t >= 1 - 1e-6 && t <= 4 + 1e-6) || (t >= 7 - 1e-6 && t <= 11 + 1e-6);
  ok(multi.every((c) => inSpeech(c.start)),
     "多段有声区间时，每条起点都落在有声区间内、不落进静音", multi);

  // 几乎整镜静音（音轨极轻）：有声区间不可信，必须退回线性分配而不是
  // 把所有字幕挤进那 0.5 秒里
  const quiet = alignCuesInSpeech(
    ["这一镜的音轨几乎是静音", "但台词还是得排出来"],
    [{ start: 0, end: 9.5 }], 10);
  ok(quiet.length === 2 && (quiet[1].end - quiet[0].start) > 2,
     "整镜近乎静音时退回线性分配，不把字幕挤成一团", quiet);

  ok(alignCuesInSpeech([], [], 10).length === 0, "空 cue 列表返回空");
  ok(alignCuesInSpeech(["有字但没时长"], [], 0).length === 0, "时长为 0 返回空");
}

// ---------------------------------------------------------------------------
console.log("\n[4] alignLinesInSpeech —— 行边界必须硬断开");
{
  // 一镜里相邻两行常常是不同人说的。**不以句末标点收尾**的行是关键用例：
  // 拼成一段再按标点切，就会把两个人的话并进同一条字幕。
  const cues = alignLinesInSpeech(
    ["谁碰掉的", "我没碰过"],
    [{ start: 0, end: 1 }, { start: 9, end: 10 }], 10);
  ok(cues.length >= 2, "两行至少产出两条，没有被并成一条", cues.map((c) => c.text));
  ok(!cues.some((c) => c.text.includes("谁碰掉的") && c.text.includes("我没碰过")),
     "不同说话人的话没有被塞进同一条字幕", cues.map((c) => c.text));

  // 长行仍按标点/字数继续分条
  const long = alignLinesInSpeech(
    ["说了多少次，标签全给我朝前！间距必须是一厘米！差一点都不行！听懂没有？！"],
    [{ start: 0, end: 0.5 }], 12);
  ok(long.length >= 3, "长台词继续分条", long.map((c) => c.text));
  ok(long.every((c) => c.text.length <= 16),
     "分条后没有超长条（竖屏一行约 15 字）", long.map((c) => c.text.length));
  ok(!long.some((c) => /[。！？，、；：]/.test(c.text)),
     "出字幕已洗掉标点", long.map((c) => c.text));
}

// ---------------------------------------------------------------------------
console.log("\n[5] dramaSources —— 挑得对才不会错位");
{
  const base = {
    id: "x", project_id: "p", episode: 1, scene: "", location: "",
    script_ref: "", duration_sec: 5,
  } as unknown as Parameters<typeof dramaSources>[0][number];
  const mk = (o: Record<string, unknown>) =>
    ({ ...base, ...o }) as Parameters<typeof dramaSources>[0][number];

  const lines = new Map([[1, ["甲"]], [2, ["乙"]], [3, ["丙"]], [4, ["丁"]], [5, ["戊"]]]);
  const got = dramaSources([
    mk({ order: 3, video_url: "u3" }),
    mk({ order: 1, video_url: "u1" }),
    mk({ order: 2, video_url: "u2", disabled: true }),
    mk({ order: 4, video_url: "u4", track_index: 1 }),
    mk({ order: 5 }),                                  // 没出片
  ], lines);
  ok(got.map((s) => s.order).join(",") === "1,3",
     "排除 disabled / 叠加层 / 未出片，并按镜序排序", got.map((s) => s.order));

  // 没台词的镜头（纯 ▲ 画面描写）不该有字幕
  ok(dramaSources([mk({ order: 9, video_url: "u9" })], new Map()).length === 0,
     "没台词的镜头被排除");

  // 片窗口口径：clip_dur_sec 优先于 duration_sec（与 shotToClip.shotDuration 一致）
  const clipped = dramaSources(
    [mk({ order: 1, video_url: "u1", duration_sec: 10, clip_in_sec: 2, clip_dur_sec: 6 })],
    lines);
  ok(clipped[0].winStart === 2 && clipped[0].winDur === 6,
     "剪过的镜头取 (clip_in_sec, clip_dur_sec) 作为片窗口", clipped[0]);
  const uncut = dramaSources([mk({ order: 1, video_url: "u1", duration_sec: 10 })], lines);
  ok(uncut[0].winStart === 0 && uncut[0].winDur === 10,
     "未剪过的取 (0, duration_sec)", uncut[0]);
}

// ---------------------------------------------------------------------------
console.log("\n[6] 自适应静音阈值 —— 音乐床下唯一能探到停顿的办法");
{
  ok(parseMeanVolume("[Parsed_volumedetect_0 @ 0x1] mean_volume: -14.0 dB") === -14,
     "解析得到 mean_volume");
  ok(parseMeanVolume("max_volume: -4.4 dB") === null,
     "只有 max_volume 时返回 null（不能拿峰值当均值）");
  ok(parseMeanVolume("") === null, "空输出返回 null");

  // 真人剧实测形状：平均 -14dB 的音乐床 → 阈值应落在 -20dB
  ok(adaptiveNoiseDb(-14) === -20, "平均 -14dB → 阈值 -20dB", adaptiveNoiseDb(-14));
  // 量不到时必须回落固定值，而不是拿 NaN 去拼 ffmpeg 参数
  ok(adaptiveNoiseDb(null) === -32, "量不到平均音量时回落 -32dB");
  ok(adaptiveNoiseDb(Number.NaN) === -32, "NaN 同样回落，不会产出非法阈值");
  // 上下界：极静的音轨不能把整条判成静音，极吵的不能把说话声判成静音
  ok(adaptiveNoiseDb(-70) === ADAPTIVE_MIN_DB,
     "极静音轨被下界钳住", adaptiveNoiseDb(-70));
  ok(adaptiveNoiseDb(-3) === ADAPTIVE_MAX_DB,
     "极吵音轨被上界钳住", adaptiveNoiseDb(-3));
  ok(adaptiveNoiseDb(-14) < 0 && Number.isFinite(adaptiveNoiseDb(-14)),
     "阈值恒为有限负数（可直接拼进 ffmpeg 参数）");
}

// ---------------------------------------------------------------------------
console.log("\n[7] 端到端：真镜头视频 + 真台词");
if (!VIDEO || !existsSync(VIDEO) || !LINES_FILE || !existsSync(LINES_FILE) || !(TOTAL > 0)) {
  console.log("  – 跳过（未提供 FW_DRAMA_VIDEO / FW_DRAMA_LINES / FW_DRAMA_SEC）");
} else {
  const lines = readFileSync(LINES_FILE, "utf8").split("\n")
    .map((s) => s.trim()).filter((s) => !!s);

  // 与 probeSilence({ adaptive: true }) 同款两趟：先量音量再定阈值。
  // 固定阈值那一趟也跑，用来在日志里坐实"绝对阈值在真人剧上探不到停顿"。
  const vol = spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", VIDEO, "-af", "volumedetect", "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const meanDb = parseMeanVolume(vol.stderr || "");
  const noise = adaptiveNoiseDb(meanDb, NOISE_DB);

  const detect = (t: number) => parseSilence(spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", VIDEO,
    "-af", `silencedetect=noise=${t}dB:d=${MIN_SIL}`, "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).stderr || "");

  const fixed = detect(NOISE_DB);
  const sil = detect(noise);
  console.log(`  · ${lines.length} 行台词 / ${TOTAL.toFixed(2)}s`);
  console.log(`  · 平均音量 ${meanDb}dB → 自适应阈值 ${noise}dB`);
  console.log(`  · 固定 ${NOISE_DB}dB 探到 ${fixed.length} 段；自适应探到 ${sil.length} 段`);
  ok(meanDb !== null, "量到了平均音量（volumedetect 输出可解析）", meanDb);
  ok(sil.length >= fixed.length,
     "自适应阈值探到的停顿不少于固定阈值", { fixed: fixed.length, adaptive: sil.length });

  const regions = speechRegions(clipSilences(sil, 0, TOTAL), TOTAL);
  const speech = regions.reduce((a, x) => a + (x.end - x.start), 0);
  console.log(`  · 有声 ${speech.toFixed(2)}s（${(speech / TOTAL * 100).toFixed(0)}%），`
    + `区间 ${regions.map((x) => `${x.start.toFixed(1)}~${x.end.toFixed(1)}`).join(" ")}`);

  const cues = alignLinesInSpeech(lines, clipSilences(sil, 0, TOTAL), TOTAL);
  for (const c of cues) {
    console.log(`     ${c.start.toFixed(2)}→${c.end.toFixed(2)}  ${c.text}`);
  }
  ok(cues.length > 0, "真视频上产出了字幕");
  ok(cues.every((c) => c.end > c.start), "没有零长/负长字幕");
  ok(cues.every((c, i) => i === 0 || c.start >= cues[i - 1].end - 1e-6),
     "相邻字幕不重叠");
  ok(cues.every((c) => c.start >= 0 && c.end <= TOTAL + 1e-6),
     "全部落在镜头时长内（不会溢出到下一镜）");
  // 字幕文本必须是台词原文的逐字重排（洗标点后），一个字都不能多也不能少
  const wash = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
  ok(wash(cues.map((c) => c.text).join("")) === wash(lines.join("")),
     "字幕逐字等于台词原文（洗掉标点后完全一致）",
     { got: wash(cues.map((c) => c.text).join("")).slice(0, 60),
       want: wash(lines.join("")).slice(0, 60) });
}

console.log(failed === 0
  ? "\n✅ verify-drama-align: 全部通过\n"
  : `\n❌ verify-drama-align: ${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
