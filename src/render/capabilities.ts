/**
 * render/capabilities.ts — 运行时能力探测
 *
 * ## 为什么必须实跑而不能查列表
 *
 * 开发机实测：`ffmpeg -encoders` **列出了** h264_nvenc，但真跑就报
 *
 *     [h264_nvenc] Cannot load libcuda.so.1
 *     Conversion failed!
 *
 * 因为编码器是**编译进去的**，能不能用取决于运行时有没有对应驱动/硬件。
 * 只查列表必然误判——尤其我们要分发到成千上万台配置各异的 Windows 机器。
 *
 * 所以本模块的判定标准是：**真的编一帧出来**。探测一次缓存住，
 * 每次导出重新探测太浪费（每个编码器约 0.3~1s）。
 *
 * ## 用户端 ffmpeg 版本不可控
 *
 * sidecar 二进制在构建期注入，不同版本编进的滤镜集不同。
 * xfade / lut3d / blend 都不是必然存在的，用前先问这里。
 */

import { Command } from "@tauri-apps/plugin-shell";

export interface Capabilities {
  /** ffmpeg 版本串；空 = sidecar 不可用（网页预览环境） */
  version: string;
  available: boolean;
  /** 实跑验证通过的硬件编码器，按优先级排序；空数组 = 只能用软件编码 */
  hwEncoders: string[];
  /** 可用滤镜集合（查列表即可——滤镜不依赖运行时硬件） */
  filters: Set<string>;
  /**
   * xfade 支持的转场名。**必须探测**：转场类型随 ffmpeg 版本增删，
   * 本机 4.4.2 就没有 `zoomin`（报 "Error setting option transition"），
   * 而较新版本有。硬编码一份清单必然在某些用户机器上出错。
   */
  transitions: Set<string>;
  probedAt: number;
}

/** 候选硬件编码器，按画质/兼容性优先级。Windows 上三家 GPU 各一个。 */
const HW_CANDIDATES = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"];

/** 我们真正会用到的滤镜——探测时只关心这些，不必解析全表 */
const NEEDED_FILTERS = [
  // 基础几何/编排
  "xfade", "overlay", "blend", "split", "scale", "pad", "rotate", "crop",
  "setpts", "trim", "concat",
  // 调色（V2.1）
  "eq", "colorbalance", "unsharp", "lut3d", "curves", "colorchannelmixer",
  // 逐帧特效（V2.2）——漏了这几个会让对应特效在真机上被静默跳过：
  // hasFilter() 恒 false → effectFilters() 直接不 push，用户拉了滑块却毫无变化。
  // verify-effects 发现不了，因为它的 mock 直接塞了完整集合、绕过探测。
  "gblur", "boxblur", "vignette", "noise", "rgbashift",
  // 音频
  "atempo", "afade", "amix", "volume", "anull", "anullsrc",
  // 字幕
  "subtitles",
];

let cache: Capabilities | null = null;

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const cmd = Command.sidecar("binaries/ffmpeg", args);
  const r = await cmd.execute();
  return { code: r.code ?? -1, out: `${r.stdout || ""}\n${r.stderr || ""}` };
}

/** 真编一帧：能出文件才算这个编码器可用 */
async function encoderWorks(name: string): Promise<boolean> {
  try {
    const { code, out } = await run([
      "-hide_banner", "-f", "lavfi",
      "-i", "testsrc=size=320x240:rate=30:duration=0.1",
      "-c:v", name, "-frames:v", "1", "-f", "null", "-",
    ]);
    // ffmpeg 对 -f null 成功时返回 0；驱动缺失会出现在 stderr
    return code === 0 && !/Cannot load|not supported|Error initializing/i.test(out);
  } catch {
    return false;
  }
}

export async function probeCapabilities(force = false): Promise<Capabilities> {
  if (cache && !force) return cache;

  const empty: Capabilities = {
    version: "", available: false, hwEncoders: [],
    filters: new Set(), transitions: new Set(), probedAt: Date.now(),
  };

  let version = "";
  try {
    const { code, out } = await run(["-hide_banner", "-version"]);
    if (code !== 0) { cache = empty; return empty; }
    version = (out.split("\n")[0] || "").trim();
  } catch {
    // 网页预览环境没有 Tauri sidecar —— 这是正常情况，不是错误
    cache = empty;
    return empty;
  }

  // 滤镜：查列表足够（不依赖运行时硬件）
  const filters = new Set<string>();
  try {
    const { out } = await run(["-hide_banner", "-filters"]);
    for (const line of out.split("\n")) {
      // 形如 " TS. xfade  VV->V  Cross fade one video with another"
      const m = line.match(/^\s*[A-Z.]{3,}\s+(\w+)\s/);
      if (m && NEEDED_FILTERS.includes(m[1])) filters.add(m[1]);
    }
  } catch { /* 拿不到就当没有，编译器会退回软件实现 */ }

  // xfade 支持的转场：从 `-h filter=xfade` 的选项枚举里解析。
  // 格式形如 "     wipeleft        1     ..FV....... wipe left transition"
  const transitions = new Set<string>();
  try {
    const { out } = await run(["-hide_banner", "-h", "filter=xfade"]);
    for (const line of out.split("\n")) {
      const m = line.match(/^\s{5,}(\w+)\s+-?\d+\s+\.\.[A-Z.]+\s/);
      if (m) transitions.add(m[1]);
    }
  } catch { /* 解析不到就留空，编译器会降级为硬切 */ }

  // 硬件编码器：逐个实跑
  const hwEncoders: string[] = [];
  for (const name of HW_CANDIDATES) {
    if (await encoderWorks(name)) hwEncoders.push(name);
  }

  cache = { version, available: true, hwEncoders, filters, transitions,
            probedAt: Date.now() };
  return cache;
}

/** 选编码器：有可用硬件编码就用（本地渲染的最大收益点），否则回落 libx264 */
export function pickEncoder(caps: Capabilities, preferred?: string): string {
  if (preferred && preferred !== "auto") return preferred;
  return caps.hwEncoders[0] ?? "libx264";
}

export function hasFilter(caps: Capabilities, name: string): boolean {
  return caps.filters.has(name);
}

/** 该转场本机 ffmpeg 是否支持。探测失败（集合为空）时保守放行 fade 系，
 *  它们从 xfade 诞生起就存在。 */
export function hasTransition(caps: Capabilities, name: string): boolean {
  if (caps.transitions.size === 0) {
    return name === "fade" || name === "fadeblack" || name === "fadewhite";
  }
  return caps.transitions.has(name);
}

/** 仅供测试注入 */
export function __setCapabilitiesForTest(c: Capabilities | null): void {
  cache = c;
}
