/**
 * render/ffmpegCompiler.ts — RenderSegment → ffmpeg 参数
 *
 * 唯一产出 ffmpeg 命令行的地方（PLAN §11）。UI 不碰、Renderer 不碰。
 * 换渲染实现（比如将来上 GPU 合成）只改这个文件。
 *
 * 两条路径，对应分段器的两种段：
 *   passthrough → 只做归一化（scale/pad/fps），无 filter_complex，内存最低
 *   composite   → filter_complex 图：逐输入变换 → 叠加/转场 → 音频 mix
 *
 * 参数链沿用现有 media.py 已验证过的那套（yuv420p / anullsrc 补静音轨），
 * 不另起炉灶——那套是踩过坑调出来的。
 *
 * ⚠️ 唯一**不**照抄的是 `+faststart`：media.py 出的是单个成品文件，无脑加是对的；
 * 这里是一条多道工序的流水线，中间产物加了纯属白做全文件重写。故它由调用方
 * 逐道决定，见下方 `TailOpts`（4.2）。
 */

import type { RenderClip, RenderEffect } from "./model";
import { clipMosaics } from "./model";
import { srtForceStyle } from "../lib/subtitleStyle";
import type { SubtitleStyleLike } from "../lib/subtitleStyle";
import type { RenderPlan } from "./model";
import type { RenderSegment } from "./segment";
import type { Capabilities } from "./capabilities";
import { hasFilter, hasTransition } from "./capabilities";
import { regionShapeOf, brushRadiiInBox, decimateStroke } from "../lib/regionShape";
import { planMaskGroups, isNoOpRegion, isAnimated } from "./maskGroups";
import { planPlacement, needsPlacement, fitFilters, placeFilters } from "./placement";
import type { PlacementInput } from "./placement";
import type { MaskGroup } from "./maskGroups";
import { qualityArgs } from "./encoderArgs";

export interface CompileCtx {
  plan: RenderPlan;
  caps: Capabilities;
  /** mediaId → 本地绝对路径（由调用方缓存/下载后提供） */
  localPath: (mediaId: string) => string;
  /** mediaId → 该素材是否含音轨（由调用方在缓存后探测一次）。
   *
   *  必须由外部提供：编译器只拼参数、不执行 ffmpeg，无法自行探测。
   *  缺省视为**有音轨**——AI 生成的视频绝大多数带声音，猜错的代价也不对称：
   *  当作没有 → 静音成片（用户以为生成环节坏了）；
   *  当作有   → 该输入缺音轨时 `0:a:0?` 的 `?` 会让映射为空，由 amix/-shortest 兜住。 */
  hasAudio?: (mediaId: string) => boolean;
  /** 已经过 `pickEncoder` 挑选的编码器名（可能是硬件的）。
   *  ⚠️ 别直接跟着它拼 `-crf`：`-crf` **只有 libx264/libx265 认**，
   *  nvenc/qsv/amf 拿到它既不报错也不生效（4.4 之前三档画质因此完全相同）。
   *  质量参数一律经 `qualityArgs(encoder, crf)` 按族产出。 */
  encoder: string;
  /** 目标恒定质量，量纲取 CRF（20 高质量 / 23 标准 / 28 小体积）。
   *  硬件编码器会由 `qualityArgs` 换算成各自的旋钮（`-cq` / `-global_quality` / `-qp_*`）。 */
  crf: number;
  /**
   * (clipIdx, groupIdx) → 该**组**蒙版文件的绝对路径；没有蒙版返回 null。
   *
   * 与 `localPath` / `hasAudio` 同理：编译器只拼参数、不产生文件。
   *
   * ⚠️ **键是「组」下标，不是计划书原型写的「区域」下标。** 蒙版与滤镜链一一对应，
   * 而链的单位是 `planMaskGroups` 的**组**（一组可能含多个区域，一个动画区域也可能
   * 独占一组）。调用方用同一个纯函数 `planMaskGroups(regions, canvas)` 算出组、
   * 按 `groupIdx` 光栅化 —— 两侧调的是同一个**确定性**函数（5.3 专门钉了这一条），
   * 故必然对齐；不需要编译器把分组结果回传给调用方。
   *
   * 不提供（或返回 null）时**整段回落到旧代码路径**，逐字节与改动前相同：
   * 4 个自建 `CompileCtx` 的验证脚本因此一行都不用改。
   */
  maskPath?: (clipIdx: number, groupIdx: number) => string | null;
  /**
   * 6.4：mediaId → 效果资源文件的本地绝对路径；拿不到返回 null。
   *
   * 与 `maskPath` 完全同一个模式（可选、返回 null 即降级），只是它服务的是
   * `RenderEffect.assetMediaId`（当前只有 LUT）。**为什么不直接用 `localPath`**：
   * `localPath` 拿不到就 `throw`，而 LUT 是**装饰性**的——下载失败时正确的行为是
   * 少一层调色、片子照出，不是让整段导出崩掉。所以这里要一个能说「没有」的接口。
   */
  assetPath?: (mediaId: string) => string | null;
}

/**
 * 把**本机绝对路径**转义成能安全嵌进 filtergraph 的形式（不含外层的 `'`，由调用方加）。
 *
 * ⚠️ 这个函数看着琐碎，但它的每一条规则都是在真 ffmpeg 4.4.2 上打出来的，
 * 别凭直觉改。ffmpeg 的转义是**两级**的（filtergraph 描述一级、filter 参数一级），
 * 所以这里的反斜杠数量不符合任何一种 shell 直觉：
 *
 * | 字符 | 规则 | 不这么写会怎样（实测） |
 * |---|---|---|
 * | `\`  | 换成 `/` | Windows 分隔符会被当转义符吃掉 |
 * | `:`  | 写成 `\:` | **即使在 `'…'` 里也必须转义**，引号不保护冒号：`C:\…` 会被参数分割器切开，报 `Error setting option interp to value dir/x.cube` |
 * | `'`  | 写成 `'\\\''`（收引号→三个反斜杠→引号→开引号） | 单引号被**静默丢掉**：`O'Brien` 变 `OBrien`，于是打开的是一个不存在的路径。shell 里惯用的 `'\''`（一个反斜杠）在这里**不管用**——因为要穿过两级转义 |
 *
 * 顺序也是承重的：`\`→`/` 必须在最前，否则后面插进去的反斜杠会被一起换成斜杠。
 *
 * ## 为什么这不是"过度防御"
 *
 * 这些路径来自 `appDataDir()`，Windows 下形如
 * `C:\Users\<用户名>\AppData\Roaming\…` —— **用户名里带撇号是完全正常的**
 * （O'Brien、D'Angelo）。也就是说 6.4 之前烧字幕这条路（`srtPath` 同样在
 * AppData 下）对这批用户**本来就是坏的**，只是没人报上来。
 * 6.4 让 LUT 也走本机路径，等于把同一个坑再挖一遍，所以收成一份并修对。
 */
export function escFilterPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\\\\\''");
}

/**
 * LUT 效果最终要喂给 `lut3d=file=` 的本机路径；拿不到返回 null（调用方跳过该滤镜）。
 *
 * **`assetMediaId` 存在时绝不回退 `assetUrl`。** 这一条是本函数存在的全部理由：
 * `assetUrl` 是 `/fw/media/uploads/x.cube` 这种服务器地址，把它拼进滤镜的后果
 * 实测是**整段导出失败**（`Error initializing filter 'lut3d' with args`
 * → `Conversion failed!`，退出码 1），而不是"少一层调色"。宁可无声少一层，
 * 也不能让用户点一次导出、等半小时、拿到一个失败。
 *
 * 反过来，`assetMediaId` **不存在**时用 `assetUrl` 是对的：那是手工构造 plan 的
 * 老调用点（6 个 verify 脚本 + 导出基线的 11 个场景），它们给的本来就是本机路径。
 */
export function lutFilePath(
  e: RenderEffect,
  assetPath?: (mediaId: string) => string | null,
): string | null {
  if (e.assetMediaId) return assetPath?.(e.assetMediaId) ?? null;
  return e.assetUrl || null;
}

/** 调色参数 → ffmpeg 滤镜片段。范围与前端滑块一致（-100..100）。 */
function effectFilters(
  effects: RenderEffect[],
  caps: Capabilities,
  assetPath?: (mediaId: string) => string | null,
): string[] {
  if (!effects.length) return [];
  const out: string[] = [];
  const get = (t: RenderEffect["type"]) =>
    effects.find((e) => e.type === t)?.value ?? 0;

  // ---- 调色（V2.1）----
  const bright = get("brightness") / 200;      // -0.5..0.5
  const contrast = 1 + get("contrast") / 100;
  const satur = 1 + get("saturation") / 100;
  const gamma = 1 + get("highlights") / 300;
  if (bright || contrast !== 1 || satur !== 1 || gamma !== 1) {
    if (hasFilter(caps, "eq")) {
      out.push(`eq=brightness=${bright.toFixed(4)}:contrast=${contrast.toFixed(4)}`
        + `:saturation=${satur.toFixed(4)}:gamma=${gamma.toFixed(4)}`);
    }
  }
  const temp = get("temperature") / 200;
  const tint = get("tint") / 200;
  if ((temp || tint) && hasFilter(caps, "colorbalance")) {
    out.push(`colorbalance=rm=${temp.toFixed(4)}:bm=${(-temp).toFixed(4)}`
      + `:gm=${tint.toFixed(4)}`);
  }
  const shadows = get("shadows");
  if (shadows && hasFilter(caps, "eq")) {
    out.push(`eq=gamma=${(1 + shadows / 200).toFixed(4)}:gamma_weight=0.35`);
  }
  const sharpen = get("sharpen");
  if (sharpen > 0 && hasFilter(caps, "unsharp")) {
    out.push(`unsharp=5:5:${(sharpen / 100 * 1.5).toFixed(3)}`);
  }

  // ---- 逐帧特效（V2.2）----
  // 每个实现都在真实 ffmpeg 上验证过，不是照文档写的。
  const blur = get("blur");
  if (blur > 0) {
    // gblur 质量优于 boxblur；老版本没有时回退
    if (hasFilter(caps, "gblur")) out.push(`gblur=sigma=${(blur / 100 * 12).toFixed(2)}`);
    else if (hasFilter(caps, "boxblur")) out.push(`boxblur=${Math.max(1, Math.round(blur / 10))}:1`);
  }
  const vig = get("vignette");
  if (vig > 0 && hasFilter(caps, "vignette")) {
    // angle 越大暗角越强；PI/5 ~ PI/2.2 是肉眼舒适区间
    out.push(`vignette=angle=PI/${(5 - (vig / 100) * 2.8).toFixed(2)}`);
  }
  const grain = get("grain");
  if (grain > 0 && hasFilter(caps, "noise")) {
    // allf=t+u：时域+均匀分布，看起来才像胶片颗粒而非固定噪点
    out.push(`noise=alls=${Math.round(grain / 100 * 30)}:allf=t+u`);
  }
  const glitch = get("glitch");
  if (glitch > 0 && hasFilter(caps, "rgbashift")) {
    const px = Math.max(1, Math.round(glitch / 100 * 12));
    out.push(`rgbashift=rh=${px}:bh=${-px}`);
  }
  const shake = get("shake");
  if (shake > 0 && hasFilter(caps, "crop")) {
    // 按时间摆动裁切窗口再放大回原尺寸。两个不同频率的正弦让抖动不呆板。
    // 注意 crop 的 x/y 表达式里 t 是秒——这是 ffmpeg 的逐帧求值变量。
    const amp = Math.max(2, Math.round(shake / 100 * 14));
    const m = amp * 2;
    out.push(`crop=iw-${m}:ih-${m}:${amp}+${amp}*sin(2*PI*t*7):${amp}+${amp}*cos(2*PI*t*9)`);
  }
  const zp = get("zoomPulse");
  if (zp > 0 && hasFilter(caps, "crop")) {
    // 不用 zoompan：实测串在滤镜链里会报 "Error while processing the decoded data"。
    // 也不能用 h=-1：eval=frame 下每帧尺寸变化会触发滤镜重初始化并炸掉
    // （"Error reinitializing filters! Failed to inject frame"）。
    // 两个维度都给显式表达式，再 crop 回画布尺寸。
    const a = (zp / 100 * 0.06).toFixed(4);
    const z = `(1.06+${a}*sin(2*PI*t*1.2))`;
    out.push(`scale=w='iw*${z}':h='ih*${z}':eval=frame`);
    // 放大后裁回画布：后续的 pad 会把它对齐到目标尺寸
    out.push(`crop='min(iw,${"iw/1.06"})':'min(ih,ih/1.06)'`);
  }
  const flash = get("flash");
  if (flash > 0 && hasFilter(caps, "curves")) {
    // 抬黑场 = 整体提亮泛白
    out.push(`curves=all='0/${(flash / 100 * 0.35).toFixed(3)} 1/1'`);
  }

  // LUT 放最后：它是最终色彩查找，应作用于全部调色之后
  const lut = effects.find((e) => e.type === "lut");
  if (lut && hasFilter(caps, "lut3d")) {
    const file = lutFilePath(lut, assetPath);
    if (file) out.push(`lut3d=file='${escFilterPath(file)}'`);
  }
  return out;
}

/** 需要双路合成的特效（主链 + 一条处理链，再 blend 回去） */
export function needsDualPath(effects: RenderEffect[]): boolean {
  return effects.some((e) => e.type === "glow" && (e.value ?? 0) > 0);
}

/**
 * 效果本体（作用在已裁出的区域上），**旧路径与蒙版路径共用同一份**。
 *
 * 抽出来的理由不是省几行：`blockSize` / `sigma` 的量化规则若在两条路径各写一份，
 * 就会出现"同一个 intensity 在有蒙版和没蒙版时糊的程度不一样"，而且没有任何
 * 断言会自然发现 —— 正是 5.3 里 `effectKey` 那条注释说的"跨文件隐式耦合"的同类。
 *
 * `needsRestore`：只有 `pixel` 的两级 `scale` 会各截断一次整数、把区域缩水
 * （实测 100×100 → 96×96），必须补一句 `scale=BW:BH` 复原。
 * 旧路径只对 pixel 补（保持逐字节不变）；蒙版路径**无条件**补 —— 蒙版按 BW×BH
 * 光栅化，尺寸差一个像素就是 `Input frame sizes do not match` 整段导出失败，
 * 那里不能靠"只有 pixel 需要"这种知识性判断兜底。
 */
function effectCore(m: import("./model").MosaicParams): { chain: string; needsRestore: boolean } {
  if (m.style === "gaussblur") {
    const sigma = Math.max(1, Math.round(m.intensity / 100 * 30));
    return { chain: `gblur=sigma=${sigma}`, needsRestore: false };
  }
  if (m.style === "blackbox") {
    // 纯黑：把区域画成黑色（配合形状蒙版可得到圆形/笔迹遮挡）
    return { chain: `drawbox=x=0:y=0:w=iw:h=ih:color=black@1.0:t=fill`, needsRestore: false };
  }
  // pixel（默认）：缩小到方块网格大小，再用 neighbor 插值放大，得到像素块效果。
  // blockSize 4 = 精细马赛克，32 = 粗犷马赛克；用户滑到 100 时约 28px 方块。
  const blockSize = Math.max(4, Math.round(m.intensity / 100 * 28) + 4);
  return {
    chain: `scale=iw/${blockSize}:-1:flags=fast_bilinear,scale=iw*${blockSize}:-1:flags=neighbor`,
    needsRestore: true,
  };
}

/** 5.4：蒙版路径的编译输入。不传 = 整段走旧代码，逐字节不变。 */
export interface MaskCompileOpts {
  /** `planMaskGroups(mosaics, canvas)` 的结果。调用方与编译器**必须**用同一份。 */
  groups: MaskGroup[];
  /** groupIdx → 该组蒙版的 ffmpeg 输入下标；null = 没拿到蒙版，该组整体回落旧路径 */
  inputIdx: (groupIdx: number) => number | null;
}

/** 一次"发射"：要么是旧路径的单个区域，要么是蒙版路径的一整组。 */
type EmitUnit =
  | { kind: "legacy"; regionIdx: number }
  | { kind: "mask"; groupIdx: number; group: Extract<MaskGroup, { kind: "mask" }>; inputIdx: number };

/**
 * 把分组结果摊平成**实际会发射东西**的单元序列。
 *
 * 为什么要先摊平再发射，而不是边遍历边判断"是不是最后一个"：滤镜链的
 * `outLabel` 必须由**真正发射了滤镜的最后一条**产出。旧实现把"是否最后"挂在
 * `mosaics` 的下标上，于是一个**什么都不发射**的区域（空笔迹画笔）若排在末尾，
 * `outLabel` 就没人定义 —— 实测 ffmpeg 报
 * `Output with label 'v0' does not exist in any defined filter graph`，
 * **整段导出失败**。先摊平就没有这个类别的错误可犯。
 */
function buildEmitUnits(
  groups: MaskGroup[],
  mosaics: import("./model").MosaicParams[],
  inputIdx: (groupIdx: number) => number | null,
): EmitUnit[] {
  const units: EmitUnit[] = [];
  groups.forEach((g, gi) => {
    if (g.kind === "mask") {
      const k = inputIdx(gi);
      if (k !== null) { units.push({ kind: "mask", groupIdx: gi, group: g, inputIdx: k }); return; }
      // 拿不到蒙版（能力缺失 / 调用方没提供）→ 该组的每个区域各自回落旧路径。
      // 旧路径对椭圆/画笔用 geq，形状仍然保住；这正是 §5.3.1 定的降级顺序。
    }
    for (const r of g.regionIdxs) {
      // 旧路径对空笔迹画笔是"整区跳过"，摊平时就不要把它算成一个单元
      if (isNoOpRegion(mosaics[r])) continue;
      units.push({ kind: "legacy", regionIdx: r });
    }
  });
  return units;
}

/**
 * 为一个 clip 的视频流追加区域马赛克滤镜链。
 *
 * 每个马赛克区域需要"剪出区域 → 处理 → 叠回原图"的三段式结构，
 * 这在 ffmpeg filter_complex 里需要 split/crop/overlay，不能用简单的链式滤镜。
 *
 * 这里用 ffmpeg 的 [split] → crop → process → [overlay] 方式：
 *   [src]split=2[bg][fg0];
 *   [fg0]crop=boxW:boxH:X:Y,<处理>[fgp0];
 *   [bg][fgp0]overlay=X:Y[out]
 *
 * 对多个区域串联 overlay，每个区域一个 crop+process+overlay 三元组。
 *
 * 由于 passthrough 路径用 -vf 不支持 split/overlay，
 * 有马赛克时强制走 composite 路径 —— 判定在 `model.ts` 的 `clipHasMosaic()`
 * （旧注释写的是「segment.ts 的 needsComposite」，**没有这个函数**）。
 *
 * @param inLabel  当前视频流的输入标签（如 "[v0]"）
 * @param outLabel 最终输出标签
 * @param mosaics  马赛克参数数组
 * @param clipIdx  当前 clip 在段内的序号（用于标签去重）
 * @param segIdx   当前段序号（用于标签去重）
 * @param canvasW  画布宽（马赛克作用在 pad 之后的画布尺寸流上）
 * @param canvasH  画布高
 * @returns 追加到 filter_complex 的 filter 片段数组
 *
 * ⚠️ **区域的整数像素宽高只在这里算一次**（boxW/boxH），crop 用它的字面量、
 * pixel 效果末尾也用它复原。绝不在两处各自 Math.round —— 两处各算一次正是
 * 「蒙版尺寸对不上视频流尺寸」这类硬失败的来源（见 §5 的蒙版方案）。
 *
 * ---
 *
 * ## 批次 5.4：蒙版路径（`mask` 参数）
 *
 * 传入 `mask` 时改走 §5「缺陷 4 已结案」定下的**统一滤镜图**，蒙版与画面共用
 * 同一句 `crop`：
 *
 *   [cur]split=2[bg][fg];
 *   [fg]crop=BW:BH:BX:BY,{effect},scale=BW:BH,format=yuva420p[p];
 *   [K:v]format=gray[m];
 *   [p][m]alphamerge[pa];
 *   [bg][pa]overlay=BX:BY[next]
 *
 * **不传 `mask` 时逐字节退回上面那套旧实现**——这不是"尽量兼容"，是**结构性**的：
 * 旧代码整段原封不动留在 `emitLegacyRegion` 里，蒙版路径是**另加**的分支，
 * 不是把旧代码改写成"蒙版的特例"。§5.3.1 的零回归条款只有这样才是可证的，
 * 导出基线（11 场景 / 40275 字节）也因此一个字节都不动。
 *
 * 降级顺序（`caps` 里缺滤镜时）：
 *   `alphamerge` 不可用 → 椭圆/画笔回落 `geq`（**形状保住**）
 *   `geq` 也不可用     → 才退成矩形，且必须由调用方给**用户可见**提示
 * 所以 `geq` 分支不能删，`NEEDED_FILTERS` 也仍要探测 `geq`。
 */
export function compileMosaicFilters(
  inLabel: string,
  outLabel: string,
  mosaics: import("./model").MosaicParams[],
  clipIdx: number,
  segIdx: number,
  canvasW: number,
  canvasH: number,
  mask?: MaskCompileOpts,
): string[] {
  if (!mosaics.length) return [];
  const parts: string[] = [];
  let cur = inLabel;

  /** 旧路径：逐区域 split/crop/overlay（+ geq 形状蒙版）。**一行未改**。 */
  const emitLegacyRegion = (m: import("./model").MosaicParams, mi: number, next: string) => {
    const pfx = `ms${segIdx}_${clipIdx}_${mi}`;
    const shape = m.shape ?? "rect";

    // 区域坐标表达式。
    // ⚠️ crop / drawbox 用 iw·ih（输入宽高），但 overlay **不认识 iw/ih** ——
    // 它的变量是 W/H（主输入宽高）、w/h（叠加层宽高）。写成 iw 会报
    // "Undefined constant or missing '(' in 'iw*0.3)'"，实测 ffmpeg 4.4.2 必现。
    const xExpr = `(iw*${m.x.toFixed(5)})`;
    const yExpr = `(ih*${m.y.toFixed(5)})`;
    const wExpr = `(iw*${m.w.toFixed(5)})`;
    const hExpr = `(ih*${m.h.toFixed(5)})`;
    // overlay 专用（主输入宽高用 W/H）
    const ovX = `(W*${m.x.toFixed(5)})`;
    const ovY = `(H*${m.y.toFixed(5)})`;

    // ---- 区域的整数像素宽高：**全函数只算这一次** ----
    //
    // 为什么不继续用 `(iw*0.30000)` 这种表达式当 crop 的宽高：
    //   ① crop 会把 w/h **向下对齐到色度取样格**（vf_crop 的 `w &= ~((1<<hsub)-1)`）。
    //      实测 4.4.2：`crop=101:101` 在 yuv420p 下出来是 **100×100**。
    //      也就是说真实裁切尺寸取决于**运行时的 pix_fmt**（yuv420p 对齐到偶数、
    //      yuv444p 不对齐），表达式写法下我们在 TS 里根本不知道最终是多少。
    //   ② 而下面 pixel 分支要把尺寸"复原"，复原目标必须**等于**实际裁切尺寸。
    // 所以这里直接算成 floor-to-even 的字面量：与 crop 的对齐规则一致，
    // 且不再随 pix_fmt 漂移 —— 无论何种取样，`crop=100:100` 就是 100×100。
    //
    // `& ~1` 即向下取偶；`Math.max(2, …)` 兜住极小区域（crop 宽高为 0 会直接报错）。
    const boxW = Math.max(2, Math.floor(canvasW * m.w) & ~1);
    const boxH = Math.max(2, Math.floor(canvasH * m.h) & ~1);

    // ---- 效果滤镜（作用在裁出的区域上）----
    // 效果本体与「尺寸复原」由 `effectCore` 统一产出（蒙版路径也用同一份，
    // 保证两条路径的 blockSize / sigma 量化规则**只有一处**，不会各自漂移）。
    const core = effectCore(m);
    const processFilter = core.chain + (core.needsRestore ? `,scale=${boxW}:${boxH}` : "");

    // ---- 矩形 + 纯黑：drawbox 一条滤镜就够，最省 ----
    // 这条**刻意保持用 iw/ih 表达式**：它不裁切、不缩放，没有尺寸对齐问题，
    // 也是批次 5 明确要求一字不变的零回归基准（§5.3.1）。
    if (shape === "rect" && m.style === "blackbox") {
      parts.push(
        `${cur}drawbox=x=${xExpr}:y=${yExpr}:w=${wExpr}:h=${hExpr}:color=black@1.0:t=fill${next}`,
      );
      cur = next;
      return;
    }

    // ---- 矩形：裁剪 → 处理 → 贴回 ----
    if (shape === "rect") {
      parts.push(
        `${cur}split=2[${pfx}bg][${pfx}fg]`,
        `[${pfx}fg]crop=${boxW}:${boxH}:${xExpr}:${yExpr},${processFilter}[${pfx}proc]`,
        `[${pfx}bg][${pfx}proc]overlay=${ovX}:${ovY}${next}`,
      );
      cur = next;
      return;
    }

    // ---- 椭圆 / 画笔：用 alpha 蒙版把处理结果按形状贴回 ----
    //
    // 做法：裁出包围盒 → 施加效果 → geq 生成 alpha 通道（形状内 255，形状外 0）
    // → overlay 时按 alpha 混合。这样非矩形区域的边界之外保持原图。
    //
    // geq 的 alpha 表达式里坐标 X/Y 是**相对裁出小图**的像素坐标，
    // W/H 是小图宽高，所以形状参数要换算成小图内的相对位置。
    let alphaExpr: string;

    if (shape === "ellipse") {
      // 标准椭圆方程：((X-cx)/rx)² + ((Y-cy)/ry)² <= 1
      // 小图内椭圆正好内切于包围盒，故 cx=W/2, cy=H/2, rx=W/2, ry=H/2
      alphaExpr = `if(lte(pow((X-W/2)/(W/2)\\,2)+pow((Y-H/2)/(H/2)\\,2)\\,1)\\,255\\,0)`;
    } else {
      // brush：笔迹是一串圆点，alpha = 任一圆内即 255。
      // 笔迹抽稀与笔刷半径都取自 `lib/regionShape` —— 预览的 SVG 用的是同一份几何。
      // ⚠️ 这里曾经自己推导 Y 半径（`rRel * (m.w/m.h)`），漏了**画布**宽高比，
      // 导致导出的笔刷被纵向拉长：1080×1920 下实测覆盖 109×193px，
      // 而预览画的是 108×108px 的正圆。详见 regionShape.ts 顶部。
      const rsBrush = regionShapeOf(m);
      // 空笔迹 → regionShapeOf 会降成 rect，此处整区跳过（与改动前同义）
      if (rsBrush.kind !== "brush") { cur = next; return; }

      const { rx: rRel, ry: rRelY } =
        brushRadiiInBox(rsBrush.box, rsBrush.brushSize, canvasW / canvasH);

      const terms = decimateStroke(rsBrush.stroke).map((p) => {
        // 点在小图内的相对位置 0..1
        const rx = (p.x - m.x) / Math.max(m.w, 1e-6);
        const ry = (p.y - m.y) / Math.max(m.h, 1e-6);
        // 圆：((X/W - rx)/rRel)² + ((Y/H - ry)/rRelY)² <= 1
        return `lte(pow((X/W-${rx.toFixed(4)})/${rRel.toFixed(4)}\\,2)`
             + `+pow((Y/H-${ry.toFixed(4)})/${rRelY.toFixed(4)}\\,2)\\,1)`;
      });
      // 任一圆命中即不透明。
      // 用 max 链而不是相加：相加在重叠处会得到 2、3…，虽然 gt(…,0) 仍成立，
      // 但项数一多容易触到 geq 的表达式复杂度上限；max 始终是 0/1，更稳。
      const anyHit = terms.reduce((acc, t) => acc ? `max(${acc}\\,${t})` : t, "");
      alphaExpr = `if(gt(${anyHit}\\,0)\\,255\\,0)`;
    }

    parts.push(
      `${cur}split=2[${pfx}bg][${pfx}fg]`,
      `[${pfx}fg]crop=${boxW}:${boxH}:${xExpr}:${yExpr},${processFilter},`
        + `format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'[${pfx}proc]`,
      `[${pfx}bg][${pfx}proc]overlay=${ovX}:${ovY}${next}`,
    );
    cur = next;
  };

  // ---- 旧路径（未传 mask）：逐区域发射 ----
  //
  // 与批次 5 之前**逐字节相同**，只有一处例外，而那一处是修 bug：
  // 「是否最后一条」原本挂在 `mosaics` 的下标上，但空笔迹画笔区域是**什么都不发射**地
  // 把 `cur` 推到下一个标签的（见上面 brush 分支的 early return）。于是只要区域里有
  // 一个空笔迹画笔，它后面那条链的输入标签就没人定义 —— 实测 ffmpeg 报
  // `Output with label 'v0' does not exist in any defined filter graph, or was already
  // used elsewhere.`，**整段导出失败**（不是画面不对，是导不出来）。
  //
  // 改成先滤掉 no-op 再判"最后"。中间标签仍用**区域下标** `ms…_${mi}out`，
  // 所以不含空笔迹的项目（即导出基线的全部 11 个场景）产出的字符串一个字节都不变。
  if (!mask) {
    const live = mosaics.map((m, mi) => ({ m, mi })).filter(({ m }) => !isNoOpRegion(m));
    if (!live.length) return mosaics.length ? [`${inLabel}null${outLabel}`] : [];
    live.forEach(({ m, mi }, k) => {
      emitLegacyRegion(m, mi, k === live.length - 1 ? outLabel : `[ms${segIdx}_${clipIdx}_${mi}out]`);
    });
    return parts;
  }

  // ---- 蒙版路径：按组发射 ----
  //
  // 「最后一条」的判定必须落在**真正会发射东西**的那一条上，否则 outLabel 无人定义。
  // 这不是理论顾虑：旧实现把 isLast 挂在 `mosaics` 的下标上，而空笔迹 brush 区域
  // 会**什么都不发射**地把 cur 推成 outLabel —— 于是"最后一个区域是空笔迹画笔"的镜头
  // 会让整段导出失败（实测 ffmpeg 报 `Output with label 'v0' does not exist`，
  // 不是画面不对，是导不出来）。见文件末尾 `emitUnits` 的收尾兜底。
  const units = buildEmitUnits(mask.groups, mosaics, mask.inputIdx);
  if (!units.length) {
    // 所有区域都是 no-op（如只有一个空笔迹画笔）：必须仍然把 outLabel 接出来，
    // 否则下游引用它就是硬失败。`null` 是零成本直通。
    return [`${inLabel}null${outLabel}`];
  }
  units.forEach((u, ui) => {
    const next = ui === units.length - 1 ? outLabel : `[mu${segIdx}_${clipIdx}_${ui}out]`;
    if (u.kind === "legacy") { emitLegacyRegion(mosaics[u.regionIdx], u.regionIdx, next); return; }

    // 统一蒙版滤镜图。box 的四个整数**直接来自 planMaskGroups**，
    // 蒙版就是按这同一组整数光栅化的 —— 这正是"整数只算一次"落地的地方。
    const g = u.group;
    const pfx = `mg${segIdx}_${clipIdx}_${u.groupIdx}`;
    const { x: bx, y: by, w: bw, h: bh } = g.box;
    const head = mosaics[g.regionIdxs[0]];        // 同组共用 effectKey，取首个即可
    const eff = effectCore(head).chain;
    parts.push(
      `${cur}split=2[${pfx}bg][${pfx}fg]`,
      `[${pfx}fg]crop=${bw}:${bh}:${bx}:${by},${eff},scale=${bw}:${bh},format=yuva420p[${pfx}p]`,
      `[${u.inputIdx}:v]format=gray[${pfx}m]`,
      `[${pfx}p][${pfx}m]alphamerge[${pfx}pa]`,
      `[${pfx}bg][${pfx}pa]overlay=${bx}:${by}${next}`,
    );
    cur = next;
  });

  return parts;
}

/**
 * 单个 clip 的视频滤镜链。
 *
 * 顺序有讲究（与后端 build_transform_filters 保持一致）：
 *   变速 → 裁切 → 缩放 → 镜像 → 旋转 → 调色 → 不透明度 → pad 到画布
 * 变速必须最先：放在几何变换之后会被重采样两次，边缘出锯齿。
 * 位移靠 pad 的偏移实现，超出画布的部分自然被裁掉，不需要额外 crop。
 */
/**
 * P2-7 留黑：把整幅画面填成不透明黑。
 *
 * 用 `drawbox ... t=fill` 而不是换成 `color=black` 输入源，是刻意的取舍：
 * 换输入源意味着这一镜不再需要素材，听着更省，但它会**改变段的流结构**
 * （音轨要另接、时长要另算、passthrough 的 `-shortest` 语义要跟着变），
 * 而留黑的定义恰恰是「除画面外一切照旧」。填一层黑则是纯滤镜改动：
 * 时长、音轨、字幕锚点、concat 的参数一致性全部原样不动。
 *
 * `drawbox` 已在 `capabilities.ts` 的 `NEEDED_FILTERS` 里（blackbox 样式的
 * 马赛克一直在用），所以不新增探测项，也不引入新的降级分支。
 */
const BLACKOUT_FILTER = "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill";

function clipVideoChain(c: RenderClip, ctx: CompileCtx, isOverlay = false): string[] {
  const { width, height, fps } = ctx.plan.output;
  const t = c.transform;
  const chain: string[] = [];

  if (c.speed !== 1) chain.push(`setpts=${(1 / c.speed).toFixed(6)}*PTS`);

  if (t.crop) {
    const w = `iw*${(1 - t.crop.left - t.crop.right).toFixed(4)}`;
    const h = `ih*${(1 - t.crop.top - t.crop.bottom).toFixed(4)}`;
    chain.push(`crop=${w}:${h}:iw*${t.crop.left.toFixed(4)}:ih*${t.crop.top.toFixed(4)}`);
  }

  // 非等比缩放：边中点单轴拉伸会让 X/Y 缩放不同，缺省跟随 scale
  const pin: PlacementInput = {
    scaleX: t.scaleX ?? t.scale, scaleY: t.scaleY ?? t.scale, x: t.x, y: t.y,
  };
  // 叠加层的补边必须透明，否则它会把下层整个盖住（`placement.ts` 缺陷 3）。
  // 主轨补边保持不透明黑：主轨下面没有东西，透明只会白白多一次像素格式转换。
  const transparent = isOverlay;
  const placed = needsPlacement(pin, isOverlay);
  const p = placed ? planPlacement(width, height, pin) : null;

  if (placed) {
    // 先无条件铺回画布 → 尺寸变成已知常量，后面的偏移才能是整数字面量
    chain.push(...fitFilters(width, height, transparent));
  } else {
    // ⚠️ 这两句（连同结尾那句 pad）是**导出基线逐字节不变的依据**。
    // 恒等缩放 + 零位移 + 主轨 —— 也就是绝大多数镜头 —— 必须一个字符都不变。
    const iw = Math.max(2, Math.round(width * pin.scaleX));
    const ih = Math.max(2, Math.round(height * pin.scaleY));
    chain.push(`scale=${iw}:${ih}:force_original_aspect_ratio=decrease`);
  }

  if (t.mirrorH) chain.push("hflip");
  if (t.mirrorV) chain.push("vflip");
  if (Math.abs(t.rotate) > 0.01) {
    // 叠加层旋转出来的四角同样要透明，否则又是一圈盖住下层的黑
    chain.push(`rotate=${(t.rotate * Math.PI / 180).toFixed(6)}`
      + `:fillcolor=${transparent ? "black@0" : "black"}`);
  }

  // P2-7：留黑时整幅会被填成不透明黑，任何调色/特效都不可能透出来
  // （`effectFilters` 产出的全是逐像素颜色运算，**没有一个会改变画面尺寸**，
  //  所以跳过它们不影响后面的 pad/scale 口径——这是"可以跳过"的依据，
  //  不是"看着应该没事"）。顺带把 LUT 也一并省了：留黑的镜头不再需要下载 .cube。
  if (!c.blackout) {
    chain.push(...effectFilters(c.effects, ctx.caps, ctx.assetPath));
  }

  // P2-7 留黑：插在**几何之后、不透明度之前**，这个位置是推导出来的，不是随手放的。
  //
  //   · 排在几何（crop/scale/mirror/rotate）之后 → 黑的**形状与位置**仍由这一镜
  //     自己的画面决定。叠加层留黑时黑的是它那一块，不是整张画布。
  //   · 排在不透明度之前 → `opacity` 仍然作用在这块黑上。留黑的叠加层拉到 50%
  //     就是半透明的黑，这与用户对这两个旋钮的预期一致。
  //   · 排在 effectFilters 之后本来也行（整幅填充会盖掉一切调色），
  //     但那样等于白算一遍。所以下面直接**跳过**特效，而不是算完再盖 —— 见 if。
  if (c.blackout) chain.push(BLACKOUT_FILTER);

  if (t.opacity < 0.999) {
    chain.push(`format=yuva420p,colorchannelmixer=aa=${t.opacity.toFixed(3)}`);
  }

  if (p) {
    // 新定位路径：用户缩放 → 挪到目标位置 → 取回画布。全是整数字面量。
    chain.push(...placeFilters(width, height, p, transparent));
  } else {
    // 既有路径，一字不改（基线依据，见上面的 ⚠️）
    chain.push(`pad=${width}:${height}:(ow-iw)/2+(${t.x}):(oh-ih)/2+(${t.y}):black`);
  }
  chain.push(`setsar=1`, `fps=${fps}`);
  return chain;
}

/** 单个 clip 的音频滤镜链 */
function clipAudioChain(c: RenderClip): string[] {
  const a = c.audio;
  const chain: string[] = [];
  if (a.muted) { chain.push("volume=0"); return chain; }
  if (a.volume !== 1) chain.push(`volume=${a.volume.toFixed(3)}`);
  if (c.speed !== 1) {
    // atempo 单次仅接受 0.5~2.0，超出要串联多级（0.25 = 0.5×0.5）
    let remain = c.speed;
    const steps: number[] = [];
    while (remain > 2.000001) { steps.push(2); remain /= 2; }
    while (remain < 0.499999) { steps.push(0.5); remain *= 2; }
    steps.push(remain);
    chain.push(...steps.map((s) => `atempo=${s.toFixed(6)}`));
  }
  if (a.fadeInSec > 0.01) chain.push(`afade=t=in:st=0:d=${a.fadeInSec.toFixed(2)}`);
  if (a.fadeOutSec > 0.01) {
    const dur = c.durationSec;
    if (dur > a.fadeOutSec) {
      chain.push(`afade=t=out:st=${(dur - a.fadeOutSec).toFixed(2)}:d=${a.fadeOutSec.toFixed(2)}`);
    }
  }
  return chain;
}

/** 输入侧 seek：-ss/-t 必须放在 -i 之前，否则要解码整段再丢弃 */
function inputArgs(c: RenderClip, path: string): string[] {
  const a: string[] = [];
  if (c.sourceInSec > 0) a.push("-ss", String(c.sourceInSec));
  if (c.sourceDurationSec > 0) a.push("-t", String(c.sourceDurationSec));
  a.push("-i", path);
  return a;
}

export interface CompiledSegment {
  args: string[];
  /** 该段预计的 filter_complex 输入数（内存估算用） */
  inputCount: number;
}

/** 编译一个段为完整的 ffmpeg 参数 */
export function compileSegment(
  seg: RenderSegment, ctx: CompileCtx, outPath: string,
): CompiledSegment {
  const { width, height, fps } = ctx.plan.output;
  const args: string[] = ["-y"];

  // ---- passthrough：单 clip 无需合成，只做归一化 ----
  if (seg.kind === "passthrough") {
    const c = seg.clips[0];
    args.push(...inputArgs(c, ctx.localPath(c.mediaId)));
    // 素材自带音轨时**必须**用它（输入 0），只有确实没有音轨的素材
    // 才回落到 anullsrc（输入 1）补静音。
    //
    // ⚠️ 这里原本无条件写死 `-map 1:a:0?` —— 即永远取 anullsrc 那路静音，
    // 把素材自己的声音整个丢掉。AI 生成的视频基本都带音轨（实测 -14 dB），
    // 而绝大多数镜头都走 passthrough（单 clip、无转场无叠加），
    // 于是"导出的视频没有声音"。composite 分支映射的是 [i:a]，一直是对的，
    // 这也是为什么加了转场/叠加的片段反而有声（实测 2026-08-29）。
    //
    // anullsrc 不能省：concat 要求各段流结构一致，
    // 真无音轨的素材若不补静音轨，拼接会失败。
    const useOwnAudio = ctx.hasAudio ? ctx.hasAudio(c.mediaId) : true;
    // P2-7 留黑：passthrough 有**自己独立的一条 -vf**，不走 clipVideoChain。
    // 漏掉这里的后果非常隐蔽：留黑对「加了转场/叠加」的镜头生效、对普通单镜头
    // 不生效 —— 而普通单镜头恰恰是绝大多数（segment.ts:154 的判据）。
    // 这与 8 月 29 日那个「passthrough 没应用音频链」是同一类漏，故一并写死在
    // 这里，并由 verify-blackout.ts 的两路对照钉住。
    const pvChain = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      "setsar=1", `fps=${fps}`,
    ];
    // 插在 scale 之后：与 clipVideoChain 同一口径（黑的是画面，不是补边）。
    if (c.blackout) pvChain.splice(1, 0, BLACKOUT_FILTER);
    args.push(
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-map", "0:v:0", "-map", useOwnAudio ? "0:a:0?" : "1:a:0?",
      "-vf", pvChain.join(","),
    );
    // 音量/静音/淡入淡出：passthrough 此前完全没应用这条链，
    // 用户把某个镜头调成静音或降了音量，导出后依然原样播放。
    // 用 -af（单输入，无需 filter_complex）即可，代价可忽略。
    const paChain = clipAudioChain(c);
    if (useOwnAudio && paChain.length) args.push("-af", paChain.join(","));
    // 跨段转场补偿（同 composite 分支；透传段也可能是段边界）
    if (seg.boundaryOverlapSec > 0) {
      const keep = Math.max(0.04, (seg.endSec - seg.startSec) - seg.boundaryOverlapSec);
      args.push("-t", keep.toFixed(3));
    }
    args.push(
      "-c:v", ctx.encoder, ...qualityArgs(ctx.encoder, ctx.crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      "-shortest", outPath,
    );
    return { args, inputCount: 1 };
  }

  // ---- composite：filter_complex ----
  const parts: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];
  /**
   * 全部 clip 输入之后**追加**的输入（补静音的 anullsrc、5.4 的蒙版文件）。
   *
   * ⚠️ 下标由 `nextInput++` 在遍历过程中分配，而 args 是遍历完之后统一 push 的，
   * 所以**这个数组的顺序必须与分配顺序严格一致**——错一位，某个 clip 就会拿到
   * 别人的静音轨（时长对不上、成片被截断或拖长），或者蒙版张冠李戴。
   * 统一收在这一个数组里就是为了让"分配顺序 = push 顺序"成为结构性事实，
   * 而不是两处各自维护、靠人记得同步。
   */
  const extraInputs: { idx: number; args: string[] }[] = [];
  let nextInput = seg.clips.length;
  const allocInput = (a: string[]): number => {
    const idx = nextInput++;
    extraInputs.push({ idx, args: a });
    return idx;
  };

  /**
   * 5.4：为一个 clip 的马赛克区域规划分组、登记蒙版输入。
   *
   * 蒙版拿不到（`ctx.maskPath` 未提供、返回 null、或 `alphamerge` 不可用）时返回
   * `undefined` → `compileMosaicFilters` 整段走旧路径，逐字节与改动前相同。
   */
  const planMasks = (mosaics: import("./model").MosaicParams[], i: number): MaskCompileOpts | undefined => {
    if (!ctx.maskPath || !mosaics.length) return undefined;
    // 降级顺序第一档：没有 alphamerge 就别生成蒙版路径，让椭圆/画笔回落 geq
    if (!hasFilter(ctx.caps, "alphamerge")) return undefined;
    const groups = planMaskGroups(mosaics, { w: width, h: height });
    const idxByGroup = new Map<number, number>();
    groups.forEach((g, gi) => {
      if (g.kind !== "mask") return;
      const p = ctx.maskPath!(i, gi);
      if (!p) return;
      // 蒙版是 raw gray，尺寸即组的整数框——**同一组整数**同时是 crop 的字面量。
      // 动画组的蒙版是把每帧顺序拼进同一个 .gray 文件，rawvideo demuxer 按 -s 自动切帧，
      // 故需要 -framerate 告诉它节奏；静态组只有一帧，framesync 会自动重复末帧
      // （实测：不加 -loop 1 / -shortest 也正常终止，见 §5「顺带」一节）。
      const anim = g.regionIdxs.some((r) => isAnimated(mosaics[r]));
      const a = ["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${g.box.w}x${g.box.h}`];
      if (anim) a.push("-framerate", String(fps));
      a.push("-i", p);
      idxByGroup.set(gi, allocInput(a));
    });
    if (!idxByGroup.size) return undefined;   // 一张蒙版都没拿到 → 与不传等价
    return { groups, inputIdx: (gi) => idxByGroup.get(gi) ?? null };
  };

  /**
   * 主轨 clip 的 id 集合。**必须在 forEach 之前算好**：`clipVideoChain` 要靠它
   * 判断这一路是不是叠加层，进而决定补边透明还是不透明黑。
   *
   * ⚠️ 这里原本算了两遍同样的东西（一份在下面「视频合成」那段），现在只算一次
   * 并被两处共用——正是本文档反复点名的那类「同一事实两处各算一遍、迟早漂移」。
   */
  const mainIds = new Set(
    ctx.plan.tracks.filter((t) => t.kind === "video" && t.layer <= 1)
      .flatMap((t) => t.clips.map((c) => c.id)));

  seg.clips.forEach((c, i) => {
    args.push(...inputArgs(c, ctx.localPath(c.mediaId)));
    const chain = clipVideoChain(c, ctx, !mainIds.has(c.id)).join(",");
    const glow = c.effects.find((e) => e.type === "glow")?.value ?? 0;
    // ⚠️ 提取口径与蒙版产出器（`maskFiles.ts`）**共用同一个函数**：
    // `planMaskGroups` 的 groupIdx / regionIdxs 全是这个数组的下标，
    // 两边各写一遍 filter/map 就是给下标错位留门（见 model.ts 的注释）。
    const mosaics = clipMosaics(c);

    if (glow > 0 && hasFilter(ctx.caps, "gblur") && hasFilter(ctx.caps, "blend")) {
      // 发光 = 自身 与 自身的模糊版 做 screen 混合。
      // 必须 split 成两路——同一个流不能被消费两次（ffmpeg 会报
      // "Filter has an unconnected output"）。
      const sigma = (glow / 100 * 14).toFixed(2);
      if (mosaics.length) {
        // glow + mosaic：先做 glow，再串马赛克
        const glowOut = `[gw${i}]`;
        const mk = planMasks(mosaics, i);
        parts.push(`[${i}:v]${chain},split=2[g${i}a][g${i}b]`);
        parts.push(`[g${i}b]gblur=sigma=${sigma}[g${i}blur]`);
        parts.push(`[g${i}a][g${i}blur]blend=all_mode=screen:all_opacity=`
          + `${(glow / 100 * 0.8).toFixed(2)}${glowOut}`);
        parts.push(...compileMosaicFilters(glowOut, `[v${i}]`, mosaics, i, seg.clips.indexOf(c), width, height, mk));
      } else {
        parts.push(`[${i}:v]${chain},split=2[g${i}a][g${i}b]`);
        parts.push(`[g${i}b]gblur=sigma=${sigma}[g${i}blur]`);
        parts.push(`[g${i}a][g${i}blur]blend=all_mode=screen:all_opacity=`
          + `${(glow / 100 * 0.8).toFixed(2)}[v${i}]`);
      }
    } else if (mosaics.length) {
      // 先跑基本链，再串马赛克区域
      const afterChain = `[vc${i}]`;
      const mk = planMasks(mosaics, i);
      parts.push(`[${i}:v]${chain}${afterChain}`);
      parts.push(...compileMosaicFilters(afterChain, `[v${i}]`, mosaics, i, seg.clips.indexOf(c), width, height, mk));
    } else {
      parts.push(`[${i}:v]${chain}[v${i}]`);
    }
    vLabels.push(`v${i}`);
    const ac = clipAudioChain(c);
    // 无音轨素材必须走补静音的路，不能直接写 [i:a]。
    //
    // ⚠️ 原注释写的是「无音轨的输入用 a? 可选映射，缺失时由 amix 的 dropout
    // 处理」——**与代码不符，且两半都不成立**：
    //   ① 代码写的是 `[${i}:a]`，根本没有 `?`；素材真没音轨时 ffmpeg 直接报
    //      "Stream specifier ':a' in filtergraph description matches no streams"，
    //      **整段导出失败**（不是没声音，是导不出来）；
    //   ② 就算补上 `?`，也只是让该标签不存在，下游 anull/amix 立刻变成
    //      unconnected input，同样是硬失败——amix 的 inputs=N 在解析期就固定了，
    //      dropout_transition 管的是"某路先结束"，不是"某路压根不存在"。
    //
    // 正确做法与 passthrough 分支（:385-388）一致：补一路 anullsrc 静音。
    // 这里用**追加输入**而不是 filter_complex 里的源滤镜，是为了不引入
    // atrim/asetpts 这类未在 NEEDED_FILTERS 声明的滤镜（正是 0.3 刚修的那类问题）。
    // `-t` 必须有：anullsrc 是无限流，而 composite 分支没有 `-shortest`，
    // 不钳时长会让编码永不终止。
    const silent = ctx.hasAudio ? !ctx.hasAudio(c.mediaId) : false;
    let aSrc = `${i}:a`;
    if (silent) {
      aSrc = `${allocInput(["-f", "lavfi", "-t", c.durationSec.toFixed(3),
        "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"])}:a`;
    }
    parts.push(`[${aSrc}]${ac.length ? ac.join(",") : "anull"}[a${i}]`);
    aLabels.push(`a${i}`);
  });

  // 追加输入（静音轨 + 5.4 的蒙版）统一在所有 clip 输入之后 push，
  // 顺序 = 上面 allocInput 的分配顺序（数组本身保证），故下标必然对得上。
  for (const e of extraInputs) args.push(...e.args);

  // ---- 视频合成 ----
  // 必须区分两类同段 clip，混为一谈会算错时长：
  //   ① 主轨内相邻（时间首尾相接）→ 转场 xfade 或直接顺序衔接
  //   ② 叠加层（来自 Overlay 轨，时间上盖在主轨之上）→ overlay 滤镜
  //
  // 判据：主轨 clip 的 timelineStart 单调递增且互不重叠；
  // 叠加层在 RenderPlan 里属于 layer>1 的轨，其时间区间与主轨重叠。
  const mainClips: { c: RenderClip; label: string }[] = [];
  const overlayClips: { c: RenderClip; label: string }[] = [];
  {
    // 按 layer 分组：plan.tracks 里 layer=1 是主轨
    seg.clips.forEach((c, i) => {
      (mainIds.has(c.id) ? mainClips : overlayClips).push({ c, label: `v${i}` });
    });
  }

  // ① 主轨：按转场串接；无转场则顺序 concat（在滤镜图里用 concat filter）
  let vOut = (mainClips[0] ?? { label: vLabels[0] }).label;
  let baseDur = mainClips[0]?.c.durationSec ?? 0;
  for (let i = 1; i < mainClips.length; i++) {
    const prev = mainClips[i - 1].c, cur = mainClips[i];
    const tr = seg.transitions.find(
      (t) => (t.fromClipId === prev.id && t.toClipId === cur.c.id)
          || (t.toClipId === prev.id && t.fromClipId === cur.c.id));
    // 本机不支持的转场类型降级为硬切（concat），而不是让 ffmpeg 报错整段失败。
    // 实测 ffmpeg 4.4.2 没有 zoomin，较新版本才有——所以必须按运行时能力判断。
    if (tr && hasFilter(ctx.caps, "xfade") && hasTransition(ctx.caps, tr.type)) {
      const off = Math.max(0, baseDur - tr.durationSec);
      parts.push(`[${vOut}][${cur.label}]xfade=transition=${tr.type}`
        + `:duration=${tr.durationSec.toFixed(3)}:offset=${off.toFixed(3)}[m${i}]`);
      baseDur = baseDur - tr.durationSec + cur.c.durationSec;
    } else {
      // 无转场的相邻主轨 clip：用 concat 拼接（不是 overlay！
      // 用 overlay 会让两段叠在一起播，总时长塌成较长的那一段）
      parts.push(`[${vOut}][${cur.label}]concat=n=2:v=1:a=0[m${i}]`);
      baseDur += cur.c.durationSec;
    }
    vOut = `m${i}`;
  }

  // ② 叠加层：按 layer 顺序盖上去。
  // enable 限定它只在自己的时间窗口出现，否则会从 0 秒一直盖到结尾；
  // shortest=0 保证主轨长度不被叠加层截短（叠加层通常比主轨短）。
  overlayClips.forEach((o, k) => {
    const st = o.c.timelineStartSec - seg.startSec;
    const en = st + o.c.durationSec;
    const enable = `:enable='between(t,${st.toFixed(3)},${en.toFixed(3)})'`;
    // setpts 把叠加层平移到它该出现的时刻
    parts.push(`[${o.label}]setpts=PTS+${st.toFixed(3)}/TB[o${k}]`);

    const mode = o.c.blendMode ?? "normal";
    if (mode !== "normal" && hasFilter(ctx.caps, "blend")
        && hasFilter(ctx.caps, "split")) {
      // blend 要两路同尺寸同时长，且不支持 enable 时间窗，
      // 所以先 overlay 定位、再把结果与底层混合。
      //
      // ⚠️ 底层流要被消费两次（一次进 overlay、一次进 blend），
      // 必须先 split——直接写两次同一个标签，ffmpeg 会报
      // "Stream specifier 'x' in filtergraph description matches no streams"
      // （实测踩过）。
      parts.push(`[${vOut}]split=2[bs${k}a][bs${k}b]`);
      parts.push(`[bs${k}a][o${k}]overlay=shortest=0${enable}[pre${k}]`);
      // trim 钳到底层时长：blend 不认 shortest，叠加层若伸出底层末尾会把
      // 成片拉长（实测底层 2s、叠加层从 0.5s 起 → 产物 2.5s）。
      parts.push(`[bs${k}b][pre${k}]blend=all_mode=${mode},`
        + `trim=duration=${baseDur.toFixed(3)},setpts=PTS-STARTPTS[ov${k}]`);
    } else {
      parts.push(`[${vOut}][o${k}]overlay=shortest=0${enable}[ov${k}]`);
    }
    vOut = `ov${k}`;
  });

  // 音频：多路 mix
  let aOut = aLabels[0];
  if (aLabels.length > 1 && hasFilter(ctx.caps, "amix")) {
    parts.push(`[${aLabels.join("][")}]amix=inputs=${aLabels.length}`
      + `:duration=longest:dropout_transition=0[amixed]`);
    aOut = "amixed";
  }

  args.push(
    "-filter_complex", parts.join(";"),
    "-map", `[${vOut}]`, "-map", `[${aOut}]`,
  );
  // 跨段转场补偿：本段末尾截去一个转场时长，让下一段从正确位置接上。
  // 不截的话每个段边界都会多出该转场的完整时长（实测 2 边界多 1.0s）。
  if (seg.boundaryOverlapSec > 0) {
    const keep = Math.max(0.04, (seg.endSec - seg.startSec) - seg.boundaryOverlapSec);
    args.push("-t", keep.toFixed(3));
  }
  args.push(
    "-c:v", ctx.encoder, ...qualityArgs(ctx.encoder, ctx.crf), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
    outPath,
  );
  return { args, inputCount: nextInput };
}

/**
 * 尾段编译（concat / 混音 / 烧字幕）的公共选项。
 *
 * ## 为什么 `faststart` 必填、且**不给默认值**
 *
 * `+faststart` 的做法是把 moov 原子挪到文件头，而挪的手段是**整个文件再读写
 * 一遍**。它只对「边下边播」有意义：播放器拿不到文件头的 moov 就得先把整个文件
 * 拉完才能起播。
 *
 * 而这条流水线上的中间产物（`seg_*.mp4` / `merged.mp4` / `mixed.mp4`）**没有一个
 * 会被播放器打开** —— 它们只是下一道 ffmpeg 的输入，而 ffmpeg 读本地文件根本不在乎
 * moov 在哪。给它们加 faststart 等于白白多做若干次全文件读写：一部 4K 长片的
 * 分段产物动辄几 GB，段数越多亏得越多。
 *
 * 反过来，**最后那一道必须加**：用户拿到的就是它，去掉了就等于把成片做成
 * 「必须整包下完才能播」。
 *
 * 所以「是不是最后一道」由调用方的流水线形状决定，这里刻意**不给默认值**——
 * 给了默认值就等于允许"忘了想"，而忘了想的两个方向都不会报错：
 * 中间产物多做几次全文件读写（只是慢，没人会归因到这里），
 * 或成片少了 moov 前置（只有网页边下边播的用户会遇到，本地播放完全正常）。
 * 必填能让 tsc 在每个调用点上逼一次决定。
 */
export interface TailOpts {
  /** 该产物是否是用户最终拿到的那个文件 */
  faststart: boolean;
}

function faststartArgs(o: TailOpts): string[] {
  return o.faststart ? ["-movflags", "+faststart"] : [];
}

/** 把音频轨（旁白 / 配乐 / 镜头原声）混进已拼好的成片。
 *
 *  ⚠️ 为什么需要这一步：buildSegments 只收 `kind === "video"` 的轨，
 *  音频轨的 clip **从来没有进过分段渲染**。也就是说在此之前，
 *  本机渲染的产物里根本不含旁白和配乐——尽管导出对话框写着
 *  "完整成片请用桌面版本机渲染"。这是个一直存在的缺口。
 *
 *  实现：每条音频 adelay 到自己的绝对起点，再与成片原音轨 amix。
 *    · normalize=0 是必须的：amix 默认会按输入数等比缩小各路音量，
 *      加一条旁白就能让画面原声直接减半，听感上像"声音变小了"。
 *    · duration=first 让输出跟随视频长度，避免尾部多出一段静音。
 *
 *  audioClips 为空时返回 null —— 调用方据此跳过这一趟重编码。 */
export function compileAudioMix(
  inPath: string,
  clips: { path: string; startSec: number; volume: number; muted: boolean }[],
  outPath: string,
  o: TailOpts,
): string[] | null {
  const usable = clips.filter((c) => !c.muted && c.volume > 0 && c.path);
  if (!usable.length) return null;

  const args: string[] = ["-y", "-i", inPath];
  const parts: string[] = [];
  const labels: string[] = [];
  usable.forEach((c, i) => {
    args.push("-i", c.path);
    const ms = Math.max(0, Math.round(c.startSec * 1000));
    // adelay 要给每个声道各写一个延迟值；all=1 省去声道数判断
    const chain = [`adelay=${ms}:all=1`];
    if (c.volume !== 1) chain.push(`volume=${c.volume.toFixed(3)}`);
    parts.push(`[${i + 1}:a]${chain.join(",")}[ma${i}]`);
    labels.push(`ma${i}`);
  });
  // [0:a] 是成片自身的音轨（各段归一化时已保证一定存在）
  parts.push(`[0:a][${labels.join("][")}]amix=inputs=${labels.length + 1}`
    + `:duration=first:dropout_transition=0:normalize=0[aout]`);

  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",              // 画面不动，只重编音频
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k",
    ...faststartArgs(o), outPath,
  );
  return args;
}


/** 段产物 concat 成最终文件（各段编码参数一致，-c copy 安全）。
 *
 *  withAudio=false 时在这里加 -an 剥掉音轨，而不是在分段阶段跳过音频：
 *  concat 要求各段流结构一致，中途缺音轨会拼接失败。
 *  放在 -c copy 这一步也不需要重编码，几乎零成本。
 *
 *  ⚠️ 这个参数此前**整个 compiler 都没读过** —— model.ts 声明了
 *  withAudio、导出对话框也有开关，但本机渲染这条路完全忽略它，
 *  用户取消勾选「包含音轨」导出后仍然有声音。
 *  （这段说明此前**贴错了位置**，挂在 compileAudioMix 头上，4.2 顺手归位。） */
export function compileConcat(
  listPath: string, outPath: string, o: TailOpts & { withAudio?: boolean },
): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listPath,
          "-fflags", "+genpts", "-c", "copy",
          ...((o.withAudio ?? true) ? [] : ["-an"]),
          ...faststartArgs(o), outPath];
}

/** 烧字幕（最后一道，避免每段各烧一次导致时间码错位） */
export function compileBurnSubtitles(
  inPath: string, srtPath: string, outPath: string, encoder: string, crf: number,
  o: TailOpts & {
    /** 字幕样式预设。缺省时用短剧默认（48px 白字黑描边底部居中）。
     *  此前这里写死 FontSize=18 —— TextPanel 的 6 个预设从未生效，
     *  而 18px 在 1080×1920 上小到几乎看不见。 */
    style?: SubtitleStyleLike | null;
    videoH?: number;
    /** 内置字体目录。传了就把随包字体加进 fontconfig 的搜索路径 ——
     *  用户机器上没装思源黑体也照样能用，成片字形不受本机字体影响。
     *  实测 fontsdir 是**追加**而非限定路径；只在 fontSource==="bundled"
     *  时传，免得 libass 去挨个打开目录里的 README/LICENSE 报错刷屏。 */
    fontsDir?: string | null;
  },
): string[] {
  // 转义规则见 `escFilterPath`：AppData 路径含用户名，撇号是正常的，
  // 而此前这里那份 2 行版本会把撇号静默吃掉 → 打开一个不存在的路径。
  const opts = [`subtitles='${escFilterPath(srtPath)}'`];
  if (o.fontsDir) opts.push(`fontsdir='${escFilterPath(o.fontsDir)}'`);
  opts.push(`force_style='${srtForceStyle(o.style, o.videoH ?? 1920)}'`);
  return ["-y", "-i", inPath,
          "-vf", opts.join(":"),
          "-c:v", encoder, ...qualityArgs(encoder, crf), "-c:a", "copy",
          ...faststartArgs(o), outPath];
}
