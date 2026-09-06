/**
 * verify-encoder.ts — 编码器族与质量参数（批次 4 / 4.4）
 *
 * ## 这一条钉的是两个「不报错、但结果是错的」缺陷
 *
 * 1. **画质三档在硬件编码下完全相同。** 三处编译点一律拼 `-crf N`，而 `-crf`
 *    只有 libx264/libx265 认。nvenc/qsv/amf 拿到它既不报错也不生效，于是
 *    在**有显卡的机器上**——也就是绝大多数用户——「高质量 / 标准 / 小体积」
 *    编出来的文件一模一样。
 * 2. **选了 H.265 仍然产出 H.264。** `plan.output.vcodec` 一路存进 RenderPlan
 *    却没有任何一处读它；真正决定编码器的是 `hwEncoders[0]`，而候选清单里
 *    当时一个 HEVC 都没有。
 *
 * 两个缺陷的共同点：**成片能出、退出码为 0、日志里什么都没有**。只有把文件
 * 拿去比大小、或者拿 mediainfo 看编码格式才发现。所以这里必须钉的是
 * 「三档真的不同」和「HEVC 真的走 HEVC」，而不是「代码里有 -cq 这个字符串」。
 *
 * ## 本机没有 GPU —— 哪些能测、哪些不能，说清楚
 *
 * 路线图要求「必须在真实 N 卡/核显机器上实测」。开发机没有独显也没有核显，
 * **这一半做不到**，不假装做到了。能做到的是三层：
 *
 *   · 纯函数层：族归类、三档互不相同、软编码路径逐字不变 —— 全量断言
 *   · 本机 ffmpeg 层：软件三档**真的编出三个不同大小的文件**（③）；
 *     本机 build 里编进了的硬件编码器，逐个核对我们下发的每个选项名
 *     **确实存在于该编码器的选项表**（⑤）—— 这是"没有硬件"能做到的最接近实测
 *   · 设计层：探测口径与下发口径同源（`encoderWorks` 带着 `qualityArgs` 一起探），
 *     所以万一某个厂商在某个版本上拒绝我们的写法，后果是"回落软件编码"
 *     而不是"导出跑到最后一道才炸"（⑥）
 *
 * 跑法：npx tsx scripts/verify-encoder.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  qualityArgs, encoderFamily, isHevc, softwareEncoderFor, probeHwEncoders,
  videotoolboxQuality, HW_PAIRS, SW_CANDIDATES,
} from "../src/render/encoderArgs";
import { pickEncoder } from "../src/render/capabilities";
import { compileSegment, compileBurnSubtitles } from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type { RenderPlan, RenderClip } from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}
function check(name: string, actual: unknown, expected: unknown, detail = "") {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!eq) failed++;
  console.log(`  ${eq ? "✅" : "❌"} ${name}`);
  if (!eq) {
    console.log(`      期望 ${JSON.stringify(expected)}`);
    console.log(`      实际 ${JSON.stringify(actual)}`);
    if (detail) console.log(`      ${detail}`);
  }
}

/** 全部候选编码器（硬件 8 + 软件 2） */
const ALL = [...HW_PAIRS.flatMap((p) => [p.h264, p.hevc]), ...SW_CANDIDATES];

/* ================================================================== */
console.log("\n① 族归类与 codec 判定");
/* ================================================================== */

check("四族各自认得出来",
  ["h264_nvenc", "hevc_qsv", "h264_amf", "hevc_videotoolbox", "libx264", "libx265"]
    .map(encoderFamily),
  ["nvenc", "qsv", "amf", "videotoolbox", "software", "software"]);

check("陌生编码器名按软件处理（宁可发 -crf 也不发厂商私有选项）",
  encoderFamily("some_future_encoder"), "software",
  "发错私有选项 = 该编码器被判不可用；发 -crf 给不认识的编码器最多是被忽略");

check("HEVC 判定", ALL.map(isHevc),
  [false, true, false, true, false, true, false, true, false, true]);
check("每一对候选都是「H.264 在前、HEVC 在后」",
  HW_PAIRS.every((p) => !isHevc(p.h264) && isHevc(p.hevc)), true,
  "probeHwEncoders 的短路依赖这个顺序");

check("vcodec → 软件编码器", ["libx264", "libx265", ""].map(softwareEncoderFor),
  ["libx264", "libx265", "libx264"]);

/* ================================================================== */
console.log("\n② 质量参数：软编码逐字不变、硬编码绝不出现 -crf、三档必须分得开");
/* ================================================================== */

check("libx264 的参数与 4.4 之前**逐字相同**", qualityArgs("libx264", 23), ["-crf", "23"],
  "导出基线（scripts/__baseline__）正是用 libx264 生成的：这里多一个选项，"
  + "基线就整体漂移，之后再也分不清「预期差异」与「改坏了」");
check("libx265 同样只发 -crf", qualityArgs("libx265", 28), ["-crf", "28"]);

for (const e of HW_PAIRS.flatMap((p) => [p.h264, p.hevc])) {
  const args = qualityArgs(e, 23);
  ok(`${e}：不含 -crf，且带得动质量旋钮 → ${args.join(" ")}`,
    !args.includes("-crf") && args.length >= 2 && args.includes("23")
      === (encoderFamily(e) !== "videotoolbox"),
    "硬件编码器收到 -crf 既不报错也不生效——这正是三档相同的成因");
}

check("nvenc 的 -cq 必须与 `-rc vbr` `-b:v 0` 同时下发",
  qualityArgs("h264_nvenc", 20), ["-rc", "vbr", "-cq", "20", "-b:v", "0"],
  "只发 -cq 的话 nvenc 仍按默认码率上限压，高质量档拿不到高质量");
check("qsv 走 ICQ", qualityArgs("hevc_qsv", 20), ["-global_quality", "20"]);
check("amf 走 CQP，I/P/B 三个量化参数给同一个值",
  qualityArgs("h264_amf", 28), ["-rc", "cqp", "-qp_i", "28", "-qp_p", "28", "-qp_b", "28"]);
check("videotoolbox 的 -q:v 与 CRF **反向**（越大越好）",
  [20, 23, 28].map(videotoolboxQuality), [64, 59, 50],
  "直接把 CRF 当 q:v 传下去，「高质量」会变成最差的那一档");

// 这一条就是「三档相同」那个 bug 本身
for (const e of ALL) {
  const tiers = [20, 23, 28].map((c) => qualityArgs(e, c).join(" "));
  ok(`${e}：高质量/标准/小体积是三份**不同**的参数`,
    new Set(tiers).size === 3, tiers.join("  |  "));
}

/* ================================================================== */
console.log("\n③ 本机实跑：软件三档真的编出三个不同大小的文件");
/* ================================================================== */

let hasFfmpeg = true;
try {
  execFileSync(FFMPEG, ["-hide_banner", "-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

const W = 320, H = 240, FPS = 10;
const work = mkdtempSync(join(tmpdir(), "fwenc-"));

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    version: "test", available: true, hwEncoders: [], swEncoders: [],
    filters: new Set(["scale", "pad", "setpts", "anullsrc", "crop", "rotate"]),
    transitions: new Set(), probedAt: Date.now(), ...over,
  };
}

if (!hasFfmpeg) {
  console.log("  ⚠️  本机没有 ffmpeg，跳过实跑段（纯函数断言不受影响）");
} else {
  const src = join(work, "src.mp4");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=${FPS}:duration=2`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", src]);

  const clip: RenderClip = {
    id: "c0", mediaId: "m0", timelineStartSec: 0, durationSec: 2,
    sourceInSec: 0, sourceDurationSec: 2, speed: 1,
    transform: { ...DEFAULT_TRANSFORM }, effects: [], audio: { ...DEFAULT_AUDIO },
  };
  const mkPlan = (crf: number): RenderPlan => ({
    projectId: "t",
    media: [{ id: "m0", url: src, kind: "video", durationSec: 2 }],
    tracks: [{ id: "v1", kind: "video", layer: 1, muted: false, hidden: false,
               clips: [clip] }],
    transitions: [], subtitles: [],
    output: { width: W, height: H, fps: FPS, vcodec: "libx264", crf, withAudio: true },
    totalSec: 2,
  });

  const sizes: number[] = [];
  for (const crf of [20, 23, 28]) {
    const plan = mkPlan(crf);
    const outPath = join(work, `t${crf}.mp4`);
    const segs = buildSegments(plan);
    const { args } = compileSegment(segs[0], {
      plan, caps: caps(), encoder: "libx264", crf,
      localPath: () => src, hasAudio: () => true,
    }, outPath);
    execFileSync(FFMPEG, [...args, "-loglevel", "error"], { stdio: "pipe" });
    sizes.push(statSync(outPath).size);
  }
  console.log(`      CRF 20/23/28 的成片体积：${sizes.join(" / ")} 字节`);
  ok("三档真的产出三个不同大小的文件（而不是同一个）",
    new Set(sizes).size === 3 && sizes[0] > sizes[1] && sizes[1] > sizes[2],
    "这就是用户能验证的那件事：拉「小体积」文件要变小。硬件编码路径上"
    + "4.4 之前这三个数字是完全相同的");

  // 烧字幕那一道走的是另一个函数、另一处 -crf，必须单独确认它也换成了 qualityArgs
  const burn = compileBurnSubtitles("in.mp4", "s.srt", "o.mp4", "h264_nvenc", 23, {
    faststart: true,
  });
  ok("烧字幕这一道同样按族发参数（它是独立的第三处编译点）",
    burn.includes("-cq") && !burn.includes("-crf"),
    burn.join(" "));
}

/* ================================================================== */
console.log("\n④ pickEncoder：先看用户选的 codec，再看硬件");
/* ================================================================== */

const bothNvenc = caps({ hwEncoders: ["h264_nvenc", "hevc_nvenc"] });
const onlyH264 = caps({ hwEncoders: ["h264_nvenc"] });

check("选 H.264 + 有 N 卡 → h264_nvenc",
  pickEncoder(bothNvenc, { vcodec: "libx264" }), "h264_nvenc");
check("选 H.265 + 有 HEVC 硬件 → hevc_nvenc",
  pickEncoder(bothNvenc, { vcodec: "libx265" }), "hevc_nvenc");
check("选 H.265 + 只有 H.264 硬件 → libx265（**不是** h264_nvenc）",
  pickEncoder(onlyH264, { vcodec: "libx265" }), "libx265",
  "这就是缺陷 B 本身：4.4 之前这里返回 h264_nvenc，用户选的 H.265 静默变成 H.264。"
  + "Kepler 一代 N 卡（有 H.264 NVENC、无 HEVC NVENC）正是这个形状");
check("选 H.264 + 只有 HEVC 硬件 → libx264（不拿 HEVC 顶 H.264）",
  pickEncoder(caps({ hwEncoders: ["hevc_qsv"] }), { vcodec: "libx264" }), "libx264",
  "「通用兼容」是用户选 H.264 的全部理由，拿 HEVC 顶就把这个理由抹掉了");
check("没有任何硬件 → 对应的软件编码器",
  ["libx264", "libx265"].map((v) => pickEncoder(caps(), { vcodec: v })),
  ["libx264", "libx265"]);
check("显式指定编码器时原样返回（最高优先级，调试/兜底用）",
  pickEncoder(bothNvenc, { preferred: "libx264", vcodec: "libx265" }), "libx264");
check("preferred=auto 等同于不指定",
  pickEncoder(bothNvenc, { preferred: "auto", vcodec: "libx265" }), "hevc_nvenc");
check("不传 vcodec 时按 H.264（老调用点的行为不变）",
  pickEncoder(bothNvenc), "h264_nvenc");

check("**确知**本机编不出 libx265 时回落 H.264",
  pickEncoder(caps({ swEncoders: ["libx264"] }), { vcodec: "libx265" }), "libx264",
  "不这么做的话，几十分钟分段渲染跑完才在最后一道报 Unknown encoder");
check("swEncoders 为空 = 没探到，不做降级（照用户选的来）",
  pickEncoder(caps({ swEncoders: [] }), { vcodec: "libx265" }), "libx265",
  "老缓存和验证脚本的 mock 都是空的；把「不知道」当成「不支持」会让所有"
  + "旧缓存用户的 H.265 选项失效");

/* ================================================================== */
console.log("\n⑤ 探测：短路顺序，以及本机 build 里的选项名核对");
/* ================================================================== */

{
  const asked: string[] = [];
  const list = await probeHwEncoders(async (n) => { asked.push(n); return false; });
  check("H.264 探失败就不再探同族 HEVC（无独显的机器仍只探 4 次）",
    asked, HW_PAIRS.map((p) => p.h264));
  check("一个都不可用时返回空数组", list, []);
}
{
  const asked: string[] = [];
  const list = await probeHwEncoders(async (n) => {
    asked.push(n); return n === "h264_nvenc";
  });
  check("H.264 可用则继续探 HEVC（Kepler 那种只有一半的卡必须真探）",
    asked.slice(0, 2), ["h264_nvenc", "hevc_nvenc"]);
  check("只收可用的那些", list, ["h264_nvenc"]);
}
{
  const list = await probeHwEncoders(async (n) => n.endsWith("_qsv"));
  check("整族可用时 H.264 排在 HEVC 前面（pickEncoder 靠这个顺序挑）",
    list, ["h264_qsv", "hevc_qsv"]);
}

if (!hasFfmpeg) {
  console.log("  ⚠️  本机没有 ffmpeg，跳过选项名核对");
} else {
  // 本机没有 GPU，**编不出来**；但只要这个 build 编进了该编码器，
  // 就能从它的选项表里核对我们下发的每个选项名是否真的存在。
  // 这是"没有硬件"条件下能做到的最接近实测的一层。
  const GENERIC = new Set(["-b:v", "-q:v", "-global_quality"]);  // AVCodecContext 通用选项
  let checked = 0;
  for (const e of HW_PAIRS.flatMap((p) => [p.h264, p.hevc])) {
    let help = "";
    try {
      help = execFileSync(FFMPEG, ["-hide_banner", "-h", `encoder=${e}`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch { continue; }
    if (!/AVOptions/.test(help)) continue;   // 这个 build 没编进该编码器
    checked++;
    const opts = qualityArgs(e, 23).filter((a) => a.startsWith("-"));
    // 通用选项（AVCodecContext 级）不出现在每个编码器的私有选项表里，
    // 核对不到 —— 如实分开说，不把"没查"写成"查过了"。
    const priv = opts.filter((o) => !GENERIC.has(o));
    const gen = opts.filter((o) => GENERIC.has(o));
    const missing = priv.filter((o) => !new RegExp(`^\\s+${o}\\s`, "m").test(help));
    ok(`${e}：私有选项 ${priv.join(" ") || "（无）"} 在本机 build 的选项表里存在`
      + (gen.length ? `（${gen.join(" ")} 是通用选项，不在私有表里，未核对）` : ""),
      missing.length === 0, `缺：${missing.join(" ")}`);
  }
  console.log(`      本机 build 编进了 ${checked} 个硬件编码器（无 GPU，只能核对选项名，`
    + `无法实编）`);
}

/* ================================================================== */
console.log("\n⑥ 结构：三处编译点都改完了，且探测口径与下发口径同源");
/* ================================================================== */

const COMPILER = read("src/render/ffmpegCompiler.ts");
const CAPS = read("src/render/capabilities.ts");
const RENDERER = read("src/render/renderer.ts");

check("编译器里不再有任何硬编码的 -crf",
  (COMPILER.match(/"-crf"/g) ?? []).length, 0,
  "漏一处就意味着那条链路上三档仍然相同——而三处分属 passthrough / composite / "
  + "烧字幕，恰恰是「只测了一条就以为都改了」的经典形状");
check("三处 `-c:v` 后面跟的都是 qualityArgs(...)",
  (COMPILER.match(/"-c:v", \w+(\.\w+)?, \.\.\.qualityArgs\(/g) ?? []).length, 3);

ok("探测用的就是下发的那份参数（写错了只会回落软件编码，不会跑到最后才炸）",
  /"-c:v", name, \.\.\.qualityArgs\(name, 23\)/.test(CAPS),
  "这是本项没有 GPU 也敢改硬件参数的全部依据，去掉它整条推理就断了");
ok("缓存键里带上了质量参数本身",
  /qualityArgs\(e, 23\)/.test(CAPS),
  "改了 -cq 的写法却不换键 = 拿旧写法的探测结论去背书新写法");
ok("renderer 把 plan.output.vcodec 真的传给了 pickEncoder",
  /pickEncoder\(caps, \{[\s\S]{0,120}vcodec: plan\.output\.vcodec/.test(RENDERER),
  "缺陷 B 的成因就是这个字段一路存下来却没有任何一处读它");

rmSync(work, { recursive: true, force: true });

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 编码器参数全部通过：软编码路径逐字不变；四族各按自己的旋钮下发；"
    + "三档真的分得开（本机实测三种体积）；H.265 真的走 HEVC；"
    + "⚠️ 硬件编码的**实编**需要真实 N 卡/核显，开发机无法完成"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
