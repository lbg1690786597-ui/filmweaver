/**
 * render/encoderArgs.ts — 编码器族 → 质量参数（批次 4 / 4.4）
 *
 * ## 修的是两个都「不报错、但结果是错的」的缺陷
 *
 * **缺陷 A：画质三档在硬件编码下完全相同。**
 * 导出对话框给了「高质量 CRF 20 / 标准 CRF 23 / 小体积 CRF 28」，编译器三处
 * 一律拼 `-crf N`。可 `-crf` **只有 libx264/libx265 认**。nvenc / qsv / amf
 * 拿到它既不报错也不生效（ffmpeg 把无法识别的私有选项按 AVCodecContext 通用
 * 选项吞掉），于是在有显卡的机器上——也就是绝大多数用户——三档编出来的文件
 * 一模一样。用户拉了「小体积」，文件没变小；拉了「高质量」，画质没变好。
 * 没有任何报错，只能靠比对文件大小才发现。
 *
 * **缺陷 B：选了 H.265 仍然产出 H.264。**
 * `plan.output.vcodec` 从对话框一路存进 RenderPlan，**却没有任何一处读它**
 * （4.4 之前全仓 grep：只有 model.ts 的声明、App.tsx 的透传、ExportDialog
 * 的写入）。真正决定编码器的是 `pickEncoder(caps, "auto")` → `hwEncoders[0]`，
 * 而候选清单里当时**一个 HEVC 都没有**，所以选 H.265 的结果必然是 H.264。
 *
 * ## 为什么单独一个纯函数模块
 *
 * 质量参数要在三处拼（分段的 passthrough / composite、尾段的烧字幕），
 * 编码器候选要在探测和挑选两处用。写在编译器里就会变成第三份「各抄一遍」的
 * 漂移源（4.2/4.3 刚清掉两处）。这里全是纯函数，node 下可直接断言，
 * 不需要 Tauri。
 *
 * ## 为什么**不**下发 `-preset`
 *
 * 路线图原话是「按族传对参数（`-cq`/`-qp`/`-preset`）」。前两个是必需的，
 * `-preset` 我**刻意不发**，理由是风险收益不对称：
 *
 *   · 三家的 preset 取值互不相同，且**随 ffmpeg 版本改名**——nvenc 的
 *     `p1..p7` 是新版才有的，老版只有 `slow/medium/fast/hq/ll…`；amf 根本
 *     没有 `-preset`，它叫 `-quality`。而 sidecar 版本在 CI 构建期注入，
 *     本仓不掌握。
 *   · 发错的后果不是「preset 没生效」，而是**编码器整个被判为不可用**
 *     （见下面 encoderWorks 的实编探测），于是有显卡的用户静默掉回软件编码，
 *     慢一个数量级。为了一点点可调的速度/画质权衡去冒这个险不值得。
 *   · 三家的默认 preset 都是厂商标定的均衡档（nvenc p4、qsv medium、
 *     amf balanced），不发就是用默认，本来也是我们想要的。
 *
 * 本机无 GPU，硬件路径**无法在此实测**（路线图要求「必须在真实 N 卡/核显
 * 机器上实测」）。这正是下面那条设计的由来：**探测时用的就是这里产出的
 * 同一份参数**，所以哪怕某个厂商在某个版本上拒绝我们的写法，结果也只是
 * 「该编码器不可用 → 回落软件编码」，而不是「导出跑到一半失败」。
 */

/** 编码器家族。决定用哪个质量旋钮，与 H.264/H.265 无关（同族两个 codec 一致）。 */
export type EncoderFamily =
  | "software" | "nvenc" | "qsv" | "amf" | "videotoolbox";

/** 硬件候选：每族 H.264 与 HEVC 各一个，**H.264 在前**（见 HW_PAIRS 的顺序含义）。 */
export const HW_PAIRS: { h264: string; hevc: string }[] = [
  { h264: "h264_nvenc", hevc: "hevc_nvenc" },
  { h264: "h264_qsv", hevc: "hevc_qsv" },
  { h264: "h264_amf", hevc: "hevc_amf" },
  { h264: "h264_videotoolbox", hevc: "hevc_videotoolbox" },
];

/** 软件编码候选。也要探测：sidecar 未必编进了 libx265，
 *  编不出来时得**提前**知道并回落 libx264，而不是让导出跑到最后一道才炸。 */
export const SW_CANDIDATES = ["libx264", "libx265"];

export function encoderFamily(encoder: string): EncoderFamily {
  if (encoder.endsWith("_nvenc")) return "nvenc";
  if (encoder.endsWith("_qsv")) return "qsv";
  if (encoder.endsWith("_amf")) return "amf";
  if (encoder.endsWith("_videotoolbox")) return "videotoolbox";
  return "software";
}

/** 这个编码器出的是 HEVC 吗。未知名字按 H.264 处理（保守：兼容性更好的那个）。 */
export function isHevc(encoder: string): boolean {
  return encoder === "libx265"
    || encoder.startsWith("hevc_")
    || encoder.startsWith("libx265");
}

/**
 * videotoolbox 没有 CRF 概念，用的是 `-q:v` 1..100（**越大越好**，与 CRF 反向）。
 *
 * crf 20 → 64、23 → 59、28 → 50：三档仍然分得开，且落在厂商建议的中高区间。
 * ⚠️ ffmpeg 4.x 的 videotoolbox 会**静默忽略** `-q:v`（它是通用选项，不会报错），
 * 那种机器上三档仍然相同——但 macOS 不是本项目的分发目标（只打 Windows 包，
 * 见 localRender.ts 头部），保留它只是为了 mac 上的开发构建不至于没有硬件编码。
 */
export function videotoolboxQuality(crf: number): number {
  return Math.max(1, Math.min(100, Math.round(100 - crf * 1.8)));
}

/**
 * 该编码器的「恒定质量」参数。这是本文件的全部要点。
 *
 * ⚠️ software 分支**必须**恰好是 `["-crf", N]`，一个字都不能多：
 * 它是 4.4 之前三处硬编码的原样，导出基线（scripts/__baseline__）正是用
 * libx264 生成的。多发一个 `-preset` 都会让基线整体漂移，那样就分不清
 * 「本次改动的预期差异」和「不小心改坏了」——而基线的全部价值就在这一点。
 */
export function qualityArgs(encoder: string, crf: number): string[] {
  const q = String(crf);
  switch (encoderFamily(encoder)) {
    case "nvenc":
      // `-cq` 只在 VBR 下生效，且必须把目标码率显式清零，否则 nvenc 会用
      // 默认的 2M 码率上限把高质量档一起压掉。三个选项是一套，不能拆。
      return ["-rc", "vbr", "-cq", q, "-b:v", "0"];
    case "qsv":
      // QSV 的恒定质量叫 ICQ，旋钮是通用选项 `-global_quality`，量纲与 CRF 同向。
      return ["-global_quality", q];
    case "amf":
      // AMF 用 CQP：I/P/B 三个量化参数分开给。给同一个值 = 恒定质量。
      return ["-rc", "cqp", "-qp_i", q, "-qp_p", q, "-qp_b", q];
    case "videotoolbox":
      return ["-q:v", String(videotoolboxQuality(crf))];
    case "software":
      return ["-crf", q];
  }
}

/**
 * 用户选的 vcodec（libx264 / libx265）对应的软件编码器。
 * 未知值一律回落 libx264：宁可编出兼容性最好的那个，也不要把一个拼错的
 * 名字直接塞给 ffmpeg 让导出在最后一道炸掉。
 */
export function softwareEncoderFor(vcodec: string): string {
  return isHevc(vcodec) ? "libx265" : "libx264";
}

/**
 * 探测顺序：每族先探 H.264，**只有 H.264 成了才探 HEVC**。
 *
 * 短路是有依据的、不是为了省事：这四族的 HEVC 支持都晚于 H.264，
 * 驱动/硬件缺失时两个必然一起失败。反过来则是**真实存在**的
 * （Kepler 一代 N 卡有 H.264 NVENC、没有 HEVC NVENC），所以那一半必须真探。
 *
 * 收益：没有独显的机器（今天已经要白探 4 次）仍然只探 4 次，
 * 不因为加了 HEVC 候选就把冷启动等待翻倍。
 *
 * @param works 注入点：真实实现是「实编一帧」，验证脚本传一张表。
 */
export async function probeHwEncoders(
  works: (name: string) => Promise<boolean>,
): Promise<string[]> {
  const out: string[] = [];
  for (const p of HW_PAIRS) {
    if (!(await works(p.h264))) continue;
    out.push(p.h264);
    if (await works(p.hevc)) out.push(p.hevc);
  }
  return out;
}
