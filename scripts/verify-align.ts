/**
 * verify-align.ts — 字幕本地强制对齐的离线验证
 *
 * 跑真家伙：对 `filmweaver-data/generated/tts_2a2ea04085fe.flac`
 * （205 字 / 34.663673s，库里最长的一段旁白，文本取自 dev 库同一条记录）
 * 走完整流程
 *   ffmpeg silencedetect → parseSilence → splitIntoCues → alignCues
 * 并断言产物可用。
 *
 * 为什么必须有这个脚本：对齐算法的输出是**时间**，肉眼看代码看不出
 * "会不会有两条字幕重叠""末条会不会超出音频"。这些正是会毁掉成片的错误。
 *
 * 音频缺失时**跳过而不是失败**——CI 机器上没有 filmweaver-data。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  parseSilence, splitIntoCues, alignCues, alignText, DEFAULT_SPLIT,
} from "../src/features/subtitles/align";
import { stripScriptMarkup } from "../src/features/subtitles/markup";
import { srtForceStyle } from "../src/lib/subtitleStyle";

/** 真音频 + 真文案的固件。两者都只存在于开发机上，**不进仓库**：
 *  `desktop/` 会被 release.py 推到**公开**仓，用户的剧本原文不能跟着出去。
 *  缺任一项时端到端那一节自动跳过——纯函数的断言不受影响。 */
const AUDIO = process.env.FW_ALIGN_AUDIO
  || "/root/filmweaver-data/generated/tts_2a2ea04085fe.flac";
const FIXTURE = process.env.FW_ALIGN_TEXT
  || new URL(".align-fixture.txt", import.meta.url).pathname;
/** 该条旁白的时长（秒），与固件音频对应。 */
const TOTAL = Number(process.env.FW_ALIGN_SEC || 34.663673);
const NOISE_DB = -32, MIN_SIL = 0.18;

const hasFixture = existsSync(AUDIO) && existsSync(FIXTURE);
/** 固件里的**原文**（含 △/【】/(OS)）。符号的分布密度直接影响剥离后的
 *  字符比例，所以对齐这一节必须拿真文案跑，手写样例验不出真实边界。 */
const TEXT = hasFixture ? readFileSync(FIXTURE, "utf8").trim() : "";

let failed = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`);
}

/** 只留"能读出来的字"（汉字/字母/数字）。
 *
 * 自动字幕**洗掉标点**之后（2026-09-07 用户要求），"拆条不增不减一个字"
 * 这条不变量不能再拿整串比——标点是**故意**没了的。真正要守的是
 * **可读字符逐字一致**：一个汉字都不许丢、不许多、不许换顺序。 */
const readable = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "");
/** 洗过之后画面上不该再出现的符号（与 align.ts 的 DROP_PUNCT 同集） */
const PUNCT_RE = /[。！？!?…‥，、；：,;:—～﹏“”‘’"'「」『』《》〈〉【】〔〕（）()[\]{}]/u;

// ---------------------------------------------------------------- 纯函数部分
console.log("\n[1] 拆条规则（不依赖音频）");
{
  const t = "他扶着栏杆，一步步走上舞台。灯光打下来的那一刻，"
          + "他听见台下有人倒吸一口凉气，然后是掌声，很稀疏。";
  const cues = splitIntoCues(t);
  ok(cues.every((c) => c.length <= DEFAULT_SPLIT.maxChars),
     `每条 ≤${DEFAULT_SPLIT.maxChars} 字`,
     `最长 ${Math.max(...cues.map((c) => c.length))}`);
  ok(readable(cues.join("")) === readable(t),
     "拆条不增不减一个可读的字",
     `${readable(cues.join("")).length} vs ${readable(t).length}`);
  ok(cues.length > 1, "确实拆开了", `${cues.length} 条`);
  ok(!cues.some((c) => PUNCT_RE.test(c)),
     "自动字幕不带标点（想要标点的用户自己手动加）", JSON.stringify(cues));
  ok(cues.some((c) => c.includes(" ")),
     "句中标点洗成空格，停顿感留住（不是粘成一坨）", JSON.stringify(cues));
}

console.log("\n[1.5] 小说体旁白：引号不能独占一条，短条不能一闪而过");
{
  // ── 6.10 的两个真实缺陷，各一条回归 ──
  //
  // 第 5 集是第一人称小说体，满篇 `"……。"` 引语。这两个 bug 就是在它身上
  // 现形的：78 段旁白产出 504 条字幕，里面有只写着一个 `"` 的条，
  // 还有 23 条短于 0.5s（最短 0.10s）。
  const quoted = "他冷冷地说：“你不配。”我没有回答。";
  const cues = splitIntoCues(quoted);
  ok(cues.every((c) => /[\p{L}\p{N}]/u.test(c)),
     "没有任何一条是纯标点（`”` 独占一条是 6.10 之前的真实产物）",
     JSON.stringify(cues));
  ok(readable(cues.join("")) === readable(quoted),
     "并标点不吞字：拆条后可读字符仍逐字一致", `${cues.join("|")}`);
  // 原来这里断言「句末引号跟着上一句走」（`c.endsWith("”")`）。洗标点之后
  // 引号根本不出现在画面上，那个断言已无对象；它要防的"`”` 独占一条"
  // 由上面那条纯标点检查继续守着。这里改守**洗完的最终形态**：
  // 引号消失，但引号里那句和后面那句没有被粘成一条。
  ok(!cues.some((c) => PUNCT_RE.test(c)), "引号/冒号/句号全部洗掉",
     JSON.stringify(cues));
  ok(cues.some((c) => c.includes("你不配")) && readable(cues.join("")).endsWith("我没有回答"),
     "引语与后文各自成句，顺序不乱", JSON.stringify(cues));

  // 开头就是引号的段落：无前一条可并，必须并进后一条而不是独立成条
  const lead = splitIntoCues("“我回来了。”她说。");
  ok(lead.every((c) => /[\p{L}\p{N}]/u.test(c)) && lead[0].startsWith("我回来了"),
     "整段以引号开头时并进后一条（洗完就从开头消失）", JSON.stringify(lead));

  // ⚠️ 这一条只有"纯标点折叠"能救，CLOSERS 吸收救不了：`…` 自己就在
  // HARD_STOPS 里，所以 `……` 会被断成**两个都是纯标点**的句子。库里那条
  // 只写着一个 `…` 的字幕就是这么来的。
  //
  // 洗标点**不能**顶替这一步：折叠发生在洗之前，若不折叠，那条纯标点会在
  // 洗完变成空串被丢掉 —— 字幕虽不脏，但它占掉的那段时间会连带丢掉。
  const ell = splitIntoCues("他沉默了。……然后转身走了。");
  ok(ell.every((c) => /[\p{L}\p{N}]/u.test(c)),
     "连续省略号不产出纯标点条（`…` 本身是句末标点，吸收收尾符号管不到它）",
     JSON.stringify(ell));
  ok(readable(ell.join("")) === "他沉默了然后转身走了", "折叠省略号不丢字", ell.join("|"));
  // 破折号收尾同理：它不在 CLOSERS 里，也不是句末标点
  const dash = splitIntoCues("你怎么能——");
  ok(dash.length === 1 && dash[0] === "你怎么能",
     "破折号跟着正文，不另起一条（且洗完不留尾巴）", JSON.stringify(dash));

  // minSec：构造一组会被吸出极短条的边界 —— 静音点紧贴前一个边界
  const shortCues = ["很长的一句话在这里", "短", "后面还有一段话"];
  const aligned = alignCues(shortCues, [{ start: 4.30, end: 4.40 }], 10);
  ok(aligned.every((c) => c.end - c.start >= DEFAULT_SPLIT.minSec - 1e-6),
     `每条 ≥${DEFAULT_SPLIT.minSec}s（minSec 在 6.10 之前是个从未被读取的参数）`,
     aligned.map((c) => `${(c.end - c.start).toFixed(2)}s`).join(" "));
  ok(readable(aligned.map((c) => c.text).join("")) === shortCues.join(""),
     "合并短条不丢字、不改顺序", aligned.map((c) => c.text).join("|"));
  // 合并处要补空格：字幕已无标点，直接相加会粘成「短后面还有一段话」
  ok(aligned.length === shortCues.length || aligned.some((c) => c.text.includes(" ")),
     "确实发生了合并时，两句之间补了分隔（不粘成一坨）",
     `${aligned.length} 条: ${aligned.map((c) => c.text).join("|")}`);
  // 反向承重：正常间距的一组**不该**被合并掉
  const normal = alignCues(["第一句话在这里啊", "第二句话在这里啊"], [], 10);
  ok(normal.length === 2, "间距正常时不合并（不是把所有条都并成一条）",
     `${normal.length} 条`);
  // 极端：总时长撑不起 minSec 时收敛到 1 条，而不是死循环或产出负长
  const tiny = alignCues(["甲", "乙", "丙"], [], 0.5);
  ok(tiny.length >= 1 && tiny.every((c) => c.end > c.start),
     "总时长不足时收敛而不是死循环", `${tiny.length} 条`);
  ok(readable(tiny.map((c) => c.text).join("")) === "甲乙丙", "收敛后仍不丢字");
}

console.log("\n[2] 符号剥离（只删符号，一个汉字都不删）");
{
  const cases: [string, string][] = [
    ["△他扶着栏杆走上舞台", "他扶着栏杆走上舞台"],
    ["【冷笑】你也配", "冷笑你也配"],
    ["甲(OS)：我早就知道了", "甲：我早就知道了"],
    ["※※重点※※内容", "重点内容"],
  ];
  for (const [src, want] of cases) {
    const got = stripScriptMarkup(src);
    ok(got === want, `「${src}」→「${got}」`, got === want ? "" : `期望「${want}」`);
  }
  // 硬边界：汉字数不能变少。对**真实旁白全文**跑一遍，不只是手写样例。
  const cn = (s: string) => (s.match(/[一-龥]/g) || []).length;
  if (!hasFixture) {
    console.log("  … 跳过真实旁白校验：没有本地固件（见文件头 FW_ALIGN_TEXT）");
  } else {
    ok(cn(stripScriptMarkup(TEXT)) === cn(TEXT),
       "真实旁白剥离后汉字数不变",
       `${cn(stripScriptMarkup(TEXT))} vs ${cn(TEXT)}`);
    ok(!/[△▲【】]|\(OS\)/.test(stripScriptMarkup(TEXT)),
       "真实旁白里的 △ /【】/(OS) 全部消失");
  }
}

// ------------------------------------------------------------ 真音频端到端
console.log("\n[3] 端到端对齐（真音频）");
if (!hasFixture) {
  console.log(`  … 跳过：缺音频或文案固件（${AUDIO} / ${FIXTURE}）`);
} else {
  // silencedetect 的结果打在 **stderr** 上，`-f null -` 正常退出码是 0。
  // 用 spawnSync 一次拿到 stderr，不需要 try/catch 去接非零退出。
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", AUDIO,
    "-af", `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SIL}`,
    "-f", "null", "-",
  ], { encoding: "utf8" });
  ok(r.status === 0, "ffmpeg silencedetect 正常退出", `status=${r.status}`);

  const silences = parseSilence(r.stderr || "");
  ok(silences.length >= 15, "探到足够多的停顿", `${silences.length} 段`);
  ok(silences.every((s) => s.end > s.start), "每段静音 end > start");

  const cues = alignText(stripScriptMarkup(TEXT), silences, TOTAL);

  ok(cues.length >= 8 && cues.length <= 30, "cue 数量在合理区间", `${cues.length} 条`);
  ok(cues.every((c) => c.text.length <= DEFAULT_SPLIT.maxChars),
     `每条 ≤${DEFAULT_SPLIT.maxChars} 字`,
     `最长 ${Math.max(...cues.map((c) => c.text.length))}`);
  ok(cues[0].start < 0.35, "首条几乎从头开始", `${cues[0].start.toFixed(3)}s`);
  ok(cues[cues.length - 1].end <= TOTAL + 1e-6,
     "末条不超出音频总长",
     `${cues[cues.length - 1].end.toFixed(3)} vs ${TOTAL}`);

  let mono = true, overlap = false, zero = false;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].end <= cues[i].start) zero = true;
    if (i > 0) {
      if (cues[i].start < cues[i - 1].start) mono = false;
      if (cues[i].start < cues[i - 1].end - 1e-6) overlap = true;
    }
  }
  ok(mono, "起点严格单调递增");
  ok(!overlap, "相邻 cue 不重叠");
  ok(!zero, "没有零长/负长 cue");
  ok(cues.every((c) => c.end - c.start <= DEFAULT_SPLIT.maxSec + 1e-6),
     `单条不超过 ${DEFAULT_SPLIT.maxSec}s`,
     `最长 ${Math.max(...cues.map((c) => c.end - c.start)).toFixed(2)}s`);
  // 文本完整性：对齐这一步不该动一个字。标点是**故意**洗掉的
  // （见 align.ts 的 washPunct），所以只比可读字符。
  ok(readable(cues.map((c) => c.text).join("")) === readable(stripScriptMarkup(TEXT)),
     "对齐后的可读字符与剥离后原文逐字一致",
     `${readable(cues.map((c) => c.text).join("")).length} vs ${readable(stripScriptMarkup(TEXT)).length}`);
  ok(!cues.some((c) => PUNCT_RE.test(c.text)),
     "真实旁白产出的字幕一条也不带标点",
     JSON.stringify(cues.filter((c) => PUNCT_RE.test(c.text)).map((c) => c.text)));

  console.log("\n  对齐结果预览：");
  for (const c of cues) {
    console.log(`    ${c.start.toFixed(2).padStart(6)} → ${c.end.toFixed(2).padStart(6)}  ${c.text}`);
  }
}

// -------------------------------------------------- 退化路径：一段静音都没有
console.log("\n[4] 退化路径（探不到停顿时按字数比例分配）");
{
  const cues = alignCues(["第一句话", "第二句话在这里", "第三句"], [], 10);
  ok(cues.length === 3, "条数不变");
  ok(cues[0].start === 0, "从 0 开始");
  ok(Math.abs(cues[2].end - 10) < 1e-6, "末条正好收在总时长",
     `${cues[2].end}`);
  ok(cues.every((c, i) => i === 0 || c.start >= cues[i - 1].end - 1e-6),
     "仍然不重叠");
}

// ----------------------------------------------- 样式 → force_style 的尺寸模型
console.log("\n[5] force_style 字号模型（libass PlayResY=288）");
{
  const style = {
    fontSize: 48, color: "#ffffff", stroke: "#000000", strokeWidth: 3,
    bold: false, position: "bottom" as const, marginV: 60,
  };
  const fs = srtForceStyle(style, 1920);
  // 期望：48px@1920 → 48×288/1920 = 7.2
  ok(/FontSize=7\.2\b/.test(fs), "48px@1920 → FontSize=7.2", fs);
  ok(/MarginV=9\b/.test(fs), "marginV=60 → MarginV=9", fs);
  // **同一套样式在任何分辨率下都该产出同一串** —— 缩放由 libass 按
  // videoH/288 完成，我们再乘一次就是双重缩放（历史 bug：52 烧成 347px）
  ok(srtForceStyle(style, 1080) === fs && srtForceStyle(style, 720) === fs,
     "force_style 与成片分辨率无关（不得二次缩放）");
  ok(!/FontSize=(4[0-9]|5[0-9])\b/.test(fs),
     "没有把 1920 基准像素直接当 FontSize 发出去", fs);

  const boxed = srtForceStyle({ ...style, bg: "rgba(0,0,0,0.6)" }, 1920);
  ok(/BorderStyle=3/.test(boxed) && /BackColour=&H66000000/.test(boxed),
     "底框走 BorderStyle=3 + 正确的 ASS 透明度", boxed);

  const font = srtForceStyle({ ...style, fontFamily: "Noto Sans, CJK'SC" }, 1920);
  ok(/FontName=Noto Sans CJKSC/.test(font),
     "FontName 里的逗号/引号被清掉（否则截断 -vf）", font);
}

console.log(failed === 0
  ? "\n✅ verify-align: 全部通过\n"
  : `\n❌ verify-align: ${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);