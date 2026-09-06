/**
 * 画面定位（缩放 / 位移 / 铺回画布）——**整数几何全部在 TS 里算一次**，
 * 滤镜串里只出现字面量，不留任何交给 ffmpeg 在配置期求值的表达式。
 *
 * ## 为什么要有这个文件（不是重构，是修 5 个真 bug）
 *
 * 在此之前，定位是 `clipVideoChain` 结尾的一句
 * `pad=W:H:(ow-iw)/2+(x):(oh-ih)/2+(y):black`。这一句同时挂掉五件事，
 * 全部实测复现（测量与倍速见 `docs/OPTIMIZATION-编辑侧全面优化.md` §10）：
 *
 * 1. **放大过 100% 直接硬失败**。`scale=W*s:H*s:force_original_aspect_ratio=decrease`
 *    在 s>1 时产出比画布大的帧，`pad` 报
 *    `Padded dimensions cannot be smaller than input dimensions`，**整段导出失败**。
 * 2. **位移在默认缩放下完全无效，且 EXIT=0 不报错**。`pad` 的偏移超出可用余量时
 *    会**静默居中**；而 s=1 时余量恰好为 0，于是 `水平`/`垂直` 两个 ±500px 的滑块
 *    对成片**永远**没有作用。s=0.7 时也只有 |x| ≤ 162 生效，200 是整个归零、
 *    不是钳到边界。而预览（`previewCss.ts`）是真在 translate 的 —— 典型的
 *    「预览对、导出错」。
 * 3. **叠加层的补边是不透明黑，会把下层整个盖住**。缩到 50% 的画中画，
 *    底层纯白实测采样全 0 —— 也就是说画中画这个功能结构上不成立。
 * 4. **非等比缩放被静默压成等比**。`force_original_aspect_ratio=decrease` 是
 *    「按比例装进这个框」，所以 scaleX=0.5 / scaleY=1 得到的是**均匀缩小 0.5**，
 *    单轴拉伸永远出不来。
 * 5. **`isIdentityTransform` 没看 scaleX/scaleY**（已在 `model.ts` 一并修）：
 *    只拉了单轴的镜头被判成"无变换" → 走 passthrough → 变换整个被丢掉。
 *
 * ## 做法：pad 到超尺寸中间画布，再 crop 取回画布
 *
 * ```
 *   scale=W:H:force_original_aspect_ratio=decrease   # 装进画布，比例不变
 *   pad=W:H:(ow-iw)/2:(oh-ih)/2:COLOR                # → 尺寸变成**已知**的 W×H
 *   scale=SW:SH                                      # 用户缩放，整数、可非等比
 *   pad=PW:PH:PX:PY:COLOR                            # 挪到目标位置（只往正向挪）
 *   crop=W:H:CX:CY                                   # 取回画布，出界部分自然被裁掉
 * ```
 *
 * 关键在第二句：`force_original_aspect_ratio=decrease` 的结果尺寸取决于**源素材的
 * 宽高比**，而源尺寸在编译期是未知的（`RenderClip` 不带宽高）。先无条件 pad 到
 * 画布，尺寸就此变成已知常量，后面所有偏移量都能在 TS 里算成整数。
 *
 * 这也是为什么**不**用 §10 spike 里推荐的 `color=black + overlay`：
 * overlay 要往滤镜图里加一路 `color` 源，passthrough 分支（单条 `-vf`，无
 * filter_complex）用不了，得写两套；而 pad+crop 是纯单输入，两条路径同一份代码。
 * 实测也更快：纯位移 **35.4×** vs overlay 的 **13.9×**（静态基线 39.8×）。
 * §10 的建议据此订正。
 *
 * ## 偏移取偶
 *
 * `ox`/`oy` 一律取到偶数。yuv420p 的色度是 2×2 抽样，`crop` 遇到奇数偏移会
 * **自己**把它对齐到偶数——那又是一次"静默改我给的值"。与其让 ffmpeg 决定，
 * 不如在这里定死：最大 1px 误差，但**行为是确定的、可断言的**。
 */

/** 定位所需的全部整数参数。全部是像素，全部已取偶。 */
export interface Placement {
  /** 用户缩放后的整数尺寸 */
  scaledW: number;
  scaledH: number;
  /** 中间画布（≥ 缩放后的画面，也 ≥ 取景窗） */
  padW: number;
  padH: number;
  /** 画面在中间画布上的落点 */
  padX: number;
  padY: number;
  /** 取景窗在中间画布上的落点 */
  cropX: number;
  cropY: number;
  /** 画面相对画布左上角的理论偏移（可为负；= padX - cropX） */
  offsetX: number;
  offsetY: number;
}

export interface PlacementInput {
  /** 相对画布的缩放，1 = 铺满 */
  scaleX: number;
  scaleY: number;
  /** 相对画布中心的像素偏移 */
  x: number;
  y: number;
}

const evenRound = (v: number): number => 2 * Math.round(v / 2);

/**
 * 算出定位所需的整数参数。纯函数，无副作用，可单测。
 *
 * @param width  画布宽（成片输出宽）
 * @param height 画布高
 */
export function planPlacement(
  width: number, height: number, t: PlacementInput,
): Placement {
  // 缩放后的尺寸：取偶且至少 2px（scale 到 0 会让整条链失败）
  const scaledW = Math.max(2, evenRound(width * t.scaleX));
  const scaledH = Math.max(2, evenRound(height * t.scaleY));

  // 画面左上角相对画布左上角的偏移：居中 + 用户位移。可以为负（画面比画布大，
  // 或被推出左/上边界），负值正是既有实现表达不了、于是静默居中的那一类。
  const offsetX = evenRound((width - scaledW) / 2 + t.x);
  const offsetY = evenRound((height - scaledH) / 2 + t.y);

  // pad 的落点必须 ≥ 0，crop 的落点也必须 ≥ 0。
  // 于是把偏移拆成"画面往正向挪"与"取景窗往正向挪"两半，各取一边。
  const padX = Math.max(0, offsetX);
  const cropX = Math.max(0, -offsetX);
  const padY = Math.max(0, offsetY);
  const cropY = Math.max(0, -offsetY);

  // 中间画布要同时装得下「挪过的画面」和「挪过的取景窗」
  const padW = evenRound(Math.max(scaledW + padX, width + cropX));
  const padH = evenRound(Math.max(scaledH + padY, height + cropY));

  return { scaledW, scaledH, padW, padH, padX, padY, cropX, cropY, offsetX, offsetY };
}

/**
 * 这个变换需不需要走新的定位路径。
 *
 * 返回 false 时调用方**必须**原样输出既有的那两句滤镜 —— 那是导出基线
 * （12 场景 / 44150 字节）逐字节不变的依据，不是"顺便优化一下"。
 *
 * 快路径保留的条件，逐条都是"老写法在这一档确实是对的"：
 *   · 非叠加层 —— 叠加层即使变换恒等也需要**透明**补边，否则源比例与画布不同时
 *     那圈黑边会盖掉下层（缺陷 3）；
 *   · 无位移 —— 有位移时老写法的 `pad` 偏移超出余量会**静默居中**（缺陷 2）；
 *   · 等比（scaleX === scaleY）—— 不等比时 `foar=decrease` 会压成等比（缺陷 4）；
 *   · 不放大（≤ 1）—— 放大时 `pad` 直接报 `Padded dimensions cannot be smaller
 *     than input dimensions`，整段导出失败（缺陷 1）。
 *
 * 缩小（s < 1）**留在快路径上不是偷懒，是画质**：新链要先把源铺到画布再缩到
 * 目标尺寸，比老写法多一次重采样。既然这一档老写法本来就是对的，就别为了
 * 代码整齐去多糊一层。
 */
export function needsPlacement(t: PlacementInput, isOverlay: boolean): boolean {
  return isOverlay
    || t.x !== 0 || t.y !== 0
    || t.scaleX !== t.scaleY
    || t.scaleX > 1 || t.scaleY > 1;
}

/**
 * 定位链的**前半段**：把任意尺寸的源装进画布，并把尺寸钉死成已知的 W×H。
 * 必须排在 mirror/rotate/特效**之前**（与既有链同一位置）。
 */
export function fitFilters(
  width: number, height: number, transparent: boolean,
): string[] {
  const out = [`scale=${width}:${height}:force_original_aspect_ratio=decrease`];
  // 透明补边要求带 alpha 的像素格式；不加这句 pad 的 @0 会被当成不透明黑。
  if (transparent) out.push("format=yuva420p");
  out.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${transparent ? "black@0" : "black"}`);
  return out;
}

/**
 * 定位链的**后半段**：用户缩放 + 位移 + 取回画布。
 * 排在特效/留黑/不透明度**之后**（与既有链里 pad 的位置一致）。
 */
export function placeFilters(
  width: number, height: number, p: Placement, transparent: boolean,
): string[] {
  const color = transparent ? "black@0" : "black";
  const out: string[] = [];
  if (p.scaledW !== width || p.scaledH !== height) {
    // 刻意**不带** force_original_aspect_ratio：这里要的就是能单轴拉伸（缺陷 4）。
    // 上一步已经把画面钉成 W×H，所以这句是精确的整数缩放，不依赖源比例。
    out.push(`scale=${p.scaledW}:${p.scaledH}`);
  }
  // 三者全为 no-op 时整段省掉（叠加层的恒等变换会走到这里）
  if (p.padW !== p.scaledW || p.padH !== p.scaledH || p.padX || p.padY) {
    out.push(`pad=${p.padW}:${p.padH}:${p.padX}:${p.padY}:${color}`);
  }
  if (p.padW !== width || p.padH !== height || p.cropX || p.cropY) {
    out.push(`crop=${width}:${height}:${p.cropX}:${p.cropY}`);
  }
  return out;
}
