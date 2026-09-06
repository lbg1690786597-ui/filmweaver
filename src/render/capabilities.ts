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
 *
 * ## 探测结果落盘（4.1）
 *
 * 模块级缓存只活一个会话：**每次冷启动后的第一次导出都要白等 1.2~4s**
 * （四个硬件编码器各实编一帧，每个 0.3~1s），而这段时间界面上什么都没有。
 * 所以结果要落到磁盘，下次直接读。
 *
 * 难点全在**什么时候必须作废**，缓存到过期数据比不缓存更糟：
 *
 *   · **ffmpeg 换版本** → 滤镜集与转场集都可能变。故键里带 version 串。
 *     代价是每次冷启动仍要跑一次 `-version`（一个进程、几十毫秒），
 *     省不掉——不实跑就拿不到版本，拿不到版本就没法判断缓存该不该信。
 *   · **我们自己改了探测口径** → 比如给 `NEEDED_FILTERS` 加一个滤镜，
 *     旧缓存里没有它，`hasFilter()` 会永远返回 false，正是本文件开头警告的
 *     那类静默失效。故键里带**清单指纹**：清单一改键就变，
 *     **不需要谁记得去手动 +1**（手动版本号必然被忘，本项目已记过多次同类事故）。
 *     只有解析逻辑本身变了（正则、字段含义）才动 `CACHE_SCHEMA`。
 *   · **驱动装上了** → 用户装完 N 卡驱动，`h264_nvenc` 从不可用变可用，
 *     而 ffmpeg 版本一个字都没变。版本键兜不住这种，只能靠 TTL：
 *     7 天。仍然省掉 99.9% 的重探。
 *
 * 另外两条谨慎处理：
 *   · **滤镜集为空的结果不落盘**。一个能跑的 ffmpeg 不可能没有 `scale`；
 *     空集意味着 `-filters` 那次调用失败了，把它写进缓存等于把一次偶发失败
 *     变成这个版本生命周期内的永久失效。（`hwEncoders` 为空则是正常结果——
 *     纯软件编码的机器多得是，照常落盘。）
 *   · 落盘走 `.part` → `rename` 的原子写。半截 JSON 会让此后每次启动都解析
 *     失败、白白重探，而这种失败是完全静默的。
 */

import { Command } from "@tauri-apps/plugin-shell";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  exists, mkdir, readTextFile, writeTextFile, remove, rename,
} from "@tauri-apps/plugin-fs";
import {
  HW_PAIRS, SW_CANDIDATES, qualityArgs, probeHwEncoders, softwareEncoderFor, isHevc,
} from "./encoderArgs";
import { fnv1a } from "../lib/fnv1a";

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
  /**
   * 实跑验证通过的**软件**编码器（4.4）。
   *
   * 为什么软件编码也要探：`libx265` 不是必然编进 sidecar 的。不探的话，
   * 用户选了「H.265」→ 我们老老实实把 `libx265` 传下去 → 直到最后一道
   * ffmpeg 才报 "Unknown encoder"，那时几十分钟的分段渲染已经跑完了。
   * 提前知道就能回落 H.264，代价只是探测时多两次进程启动（软件编码器
   * 不依赖硬件，每次约几十毫秒，与四个硬件候选的实编不是一个量级）。
   *
   * 可选：4.4 之前写的 5 个自建 Capabilities 的验证脚本不必因此改动；
   * 缺省（undefined / 空）一律按「不知道，照用户选的来」处理，不做降级。
   */
  swEncoders?: string[];
  probedAt: number;
}

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
  // 字幕对齐（features/subtitles/probeSilence.ts）——探测不到时对齐会退化成
  // 纯字符比例分配，不失败，但用户该被告知精度下降。
  "silencedetect",
  // 区域马赛克（V2.3）——**这三个一直在用但从没被探测过**，正是本文件上面
  // 那段注释警告过的静默失效：compileMosaicFilters 无保护地拼 drawbox（:194）
  // 与 geq+format（:272），机器上没有就是导出直接报错，而不是优雅降级。
  //   drawbox  blackbox 样式的整个实现
  //   geq      椭圆/画笔形状的蒙版表达式（批次 5 后降为兼容路径，仍需探测）
  //   format   geq 前的像素格式归一
  "drawbox", "geq", "format",
  // 蒙版合成（批次 5）——alphamerge 不可用时按 §5.3.1 的降级顺序回落到 geq，
  // 形状仍然保住；两个都没有才退成矩形，且必须给用户可见提示。
  "alphamerge",
];

let cache: Capabilities | null = null;

/* ------------------------------------------------------------------ *
 * 4.1 磁盘缓存：纯函数部分（无 Tauri 依赖，可在 node 下直接断言）        *
 * ------------------------------------------------------------------ */

/**
 * 缓存文件的 schema 版本。**只在解析/序列化逻辑本身变化时手动 +1**
 * （改了字段含义、改了 `-filters` 的解析正则……）。
 * 探测**清单**的变化由下面的指纹自动覆盖，不要为了加一个滤镜来动这里。
 */
const CACHE_SCHEMA = 1;

/**
 * 缓存最长寿命。ffmpeg 版本没变、能力却变了的情况是真实存在的：
 * 用户装上显卡驱动，`h264_nvenc` 从"实编报 Cannot load libcuda"变成可用。
 * 版本键对此完全无感，只能靠时间兜底。7 天：既能让新驱动在一周内自动被发现，
 * 又仍然省掉 99.9% 的重探。
 */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 缓存文件在 appDataDir 下的位置（与素材缓存同一个 cache 目录） */
const CACHE_DIR = "cache";
const CACHE_NAME = "capabilities.json";

/** FNV-1a，32 位。只用来做"清单变没变"的指纹，不需要抗碰撞。
 *  4.5 起与 `lib/mediaCache.ts` 的缓存文件名共用同一份实现（`lib/fnv1a.ts`）——
 *  同一个哈希算法在仓里存两份是纯粹的漂移源。**取值一字未变**，
 *  故全网已有的能力缓存不会因此作废。 */
const fingerprint = fnv1a;

/**
 * 缓存键 = schema | ffmpeg 版本串 | 探测口径指纹。
 *
 * 三段缺一不可，各自挡住一类作废场景，见文件头。指纹从**清单本身**算出来，
 * 所以给 `NEEDED_FILTERS` 加一项就自动让全网旧缓存失效——这正是为了避免
 * "加了滤镜、忘了 bump 版本号、于是 `hasFilter` 在老用户机器上永远 false"。
 *
 * 4.4 起指纹里还带上**质量参数本身**：探测用的就是这份参数（见 encoderWorks），
 * 所以改了 `-cq` 的写法而不换键，等于拿旧写法的探测结论去背书新写法。
 * 一并带上候选清单，加 HEVC 候选时旧缓存自动作废。
 */
export function probeCacheKey(version: string): string {
  const enc = [...HW_PAIRS.flatMap((p) => [p.h264, p.hevc]), ...SW_CANDIDATES];
  const spec = `${NEEDED_FILTERS.join(",")}#${enc.join(",")}`
    + `#${enc.map((e) => qualityArgs(e, 23).join(" ")).join("|")}`;
  return `${CACHE_SCHEMA}|${version}|${fingerprint(spec)}`;
}

/** 落盘形态。`Set` 不能直接 JSON 化，存数组并排序（便于人工 diff）。 */
interface CachedCaps {
  key: string;
  version: string;
  hwEncoders: string[];
  swEncoders: string[];
  filters: string[];
  transitions: string[];
  probedAt: number;
}

/**
 * 这份探测结果值不值得写进磁盘。
 *
 * 滤镜集为空 = `-filters` 那次调用失败了（能跑的 ffmpeg 不可能没有 `scale`），
 * 写进去就等于把一次偶发失败固化成这个版本生命周期内的永久失效。
 * `hwEncoders` 为空则是**正常结果**（纯软件编码的机器），照常落盘。
 */
export function shouldPersist(caps: Capabilities): boolean {
  return caps.available && !!caps.version && caps.filters.size > 0;
}

export function serializeCaps(caps: Capabilities): string {
  const o: CachedCaps = {
    key: probeCacheKey(caps.version),
    version: caps.version,
    hwEncoders: [...caps.hwEncoders],
    swEncoders: [...(caps.swEncoders ?? [])],
    filters: [...caps.filters].sort(),
    transitions: [...caps.transitions].sort(),
    probedAt: caps.probedAt,
  };
  return JSON.stringify(o, null, 2);
}

/**
 * 反序列化 + 全部作废判定。**任何一处不对就返回 null（= 重探）**，绝不抛。
 *
 * 这个文件是用户可以手改、也可能被断电写成半截的，而它的消费者是导出主链路：
 * 解析崩一次就是导出崩一次，代价远大于多花 1.2~4s 重探一遍。
 */
export function deserializeCaps(
  text: string, expectKey: string, now = Date.now(),
): Capabilities | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Partial<CachedCaps>;

  if (o.key !== expectKey) return null;          // 版本/清单/schema 任一变了
  if (typeof o.version !== "string" || !o.version) return null;

  const strs = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!strs(o.hwEncoders) || !strs(o.filters) || !strs(o.transitions)) return null;
  // swEncoders 是 4.4 新增的。它不像 filters 那样有「空集必是失败」的判据
  // （一台只编进 libx264 的 sidecar 会正常地只报一个），所以缺失/非法一律
  // 当成"没探到"→ 空数组 → pickEncoder 走"不知道，照用户选的来"。
  const sw = strs(o.swEncoders) ? [...o.swEncoders] : [];

  // 空滤镜集只会来自一次失败的探测（见 shouldPersist）；真读到就说明
  // 磁盘上那份是脏的，不如重探。
  if (o.filters.length === 0) return null;

  if (typeof o.probedAt !== "number" || !Number.isFinite(o.probedAt)) return null;
  if (now - o.probedAt > CACHE_TTL_MS) return null;
  // 未来时间戳：改过系统时钟，或整个 AppData 从别的机器拷过来的。
  // 不作废的话它能"活"到时钟追上为止，而那台机器的硬件根本不是这台。
  if (o.probedAt > now + 60_000) return null;

  return {
    version: o.version,
    available: true,
    hwEncoders: [...o.hwEncoders],
    swEncoders: sw,
    filters: new Set(o.filters),
    transitions: new Set(o.transitions),
    probedAt: o.probedAt,
  };
}

/* ---- 4.1 磁盘缓存：IO 部分（失败一律吞掉，最坏退回每次重探）---- */

async function readDiskCache(expectKey: string): Promise<Capabilities | null> {
  try {
    const p = await join(await appDataDir(), CACHE_DIR, CACHE_NAME);
    if (!(await exists(p))) return null;
    return deserializeCaps(await readTextFile(p), expectKey);
  } catch {
    return null;
  }
}

async function writeDiskCache(caps: Capabilities): Promise<void> {
  if (!shouldPersist(caps)) return;
  try {
    const dir = await join(await appDataDir(), CACHE_DIR);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    const p = await join(dir, CACHE_NAME);
    // 与 cacheMedia 同一套原子落地：半截 JSON 会让此后每次启动都解析失败、
    // 白白重探，而这种失败完全静默。
    const part = `${p}.part`;
    await writeTextFile(part, serializeCaps(caps));
    if (await exists(p)) await remove(p);
    await rename(part, p);
  } catch {
    // 磁盘写不进去不该影响导出——它只是个加速，不是正确性依赖
  }
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const cmd = Command.sidecar("binaries/ffmpeg", args);
  const r = await cmd.execute();
  return { code: r.code ?? -1, out: `${r.stdout || ""}\n${r.stderr || ""}` };
}

/**
 * 真编一帧：能出文件才算这个编码器可用。
 *
 * 4.4 起**带上真正会下发的质量参数一起探**。这条不是顺手加的，是整个
 * 硬件质量参数改动的安全网：三家厂商的私有选项名随版本变，而 sidecar 的
 * ffmpeg 版本由 CI 注入、本仓不掌握，我们也没有 N 卡/核显可以实测
 * （路线图要求的「真实硬件实测」在开发机上做不到）。
 *
 * 探测口径与下发口径一致之后，"我们把某个厂商的写法写错了"这件事的后果
 * 就从「导出跑到最后一道才炸」降级为「该编码器判为不可用 → 回落软件编码」。
 * 慢，但出得了片。—— 这也是 encoderArgs.ts 里决定不下发 `-preset` 的同一条理由。
 */
async function encoderWorks(name: string): Promise<boolean> {
  try {
    const { code, out } = await run([
      "-hide_banner", "-f", "lavfi",
      "-i", "testsrc=size=320x240:rate=30:duration=0.1",
      "-c:v", name, ...qualityArgs(name, 23), "-frames:v", "1", "-f", "null", "-",
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

  // 4.1：版本串是缓存键的一部分，所以这一次 `-version` 省不掉——不实跑就
  // 拿不到版本，拿不到版本就没法判断磁盘上那份该不该信。好在它只是一次
  // 进程启动（几十毫秒），真正贵的是下面四个编码器的实编。
  const key = probeCacheKey(version);
  if (!force) {
    const disk = await readDiskCache(key);
    if (disk) { cache = disk; return disk; }
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

  // 硬件编码器：逐个实跑。每族先 H.264、成了才探 HEVC（短路依据见 probeHwEncoders），
  // 所以没有独显的机器仍然只白探 4 次，不因为 4.4 加了 HEVC 候选而把冷启动翻倍。
  const hwEncoders = await probeHwEncoders(encoderWorks);

  // 软件编码器：libx265 未必编进 sidecar。探两次（各几十毫秒），
  // 换来「选了 H.265 却在最后一道才报 Unknown encoder」这类失败提前到探测期。
  const swEncoders: string[] = [];
  for (const name of SW_CANDIDATES) {
    if (await encoderWorks(name)) swEncoders.push(name);
  }

  cache = { version, available: true, hwEncoders, swEncoders, filters, transitions,
            probedAt: Date.now() };
  // 落盘是**加速**不是正确性依赖：写失败、权限不足、磁盘满，都只是回到
  // "每次冷启动重探一遍"，不影响本次导出。故不 await 出错、不上报。
  await writeDiskCache(cache);
  return cache;
}

/**
 * 选编码器：有可用硬件编码就用（本地渲染的最大收益点），否则回落软件编码。
 *
 * ## 4.4：必须**先看用户选的 codec，再看硬件**
 *
 * 此前这里是 `caps.hwEncoders[0] ?? "libx264"`，而候选清单里一个 HEVC 都没有
 * ——于是「H.265（体积小，兼容性差）」这个选项**从来没生效过**，选它拿到的
 * 一直是 H.264。修法不是在挑完之后再纠正，而是把候选先按 codec 过一遍：
 * 用户要 HEVC 就只在 HEVC 编码器里挑，挑不到才落 `libx265`。
 *
 * ⚠️ 由此带来一个**用户会感知到的行为变化**，必须说清楚：没有 HEVC 硬件
 * 编码的机器上选 H.265，会真的走 `libx265` 软件编码——比 h264_nvenc 慢一个
 * 数量级。这是用户显式选择的结果，不该被我们悄悄"优化"回 H.264（那正是
 * 4.4 之前的 bug）。成片提示与导出完成态都会报出实际用的编码器名，
 * 导出对话框的说明里也写了这条权衡。
 *
 * @param o.preferred 显式指定编码器（非 "auto"）时原样返回，最高优先级。
 * @param o.vcodec    用户在导出对话框选的 `libx264` / `libx265`。
 */
export function pickEncoder(
  caps: Capabilities, o: { preferred?: string; vcodec?: string } = {},
): string {
  if (o.preferred && o.preferred !== "auto") return o.preferred;

  const wantHevc = isHevc(o.vcodec ?? "libx264");
  const hw = caps.hwEncoders.find((e) => isHevc(e) === wantHevc);
  if (hw) return hw;

  const sw = softwareEncoderFor(o.vcodec ?? "libx264");
  // swEncoders 为空 = 没探到（老缓存 / 验证脚本的 mock）→ 不做降级，
  // 照用户选的来。只有**确知**这台机器编不出 libx265 时才回落 H.264。
  const known = caps.swEncoders ?? [];
  if (known.length && !known.includes(sw)) return "libx264";
  return sw;
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
