/**
 * types/transform — `Shot.transform_meta` 的契约（画面 / 音频 / 后期标记）
 *
 * ## 为什么从 api.ts 搬出来
 *
 * `api.ts` 是后端契约的手工镜像，架构守卫按「只许减」钉着它的行数，而它已经
 * 顶到上限 —— 再加一个字段就会红。`TransformMeta` 恰好是最会长的那一个：
 * 它是「不新增数据库列就能加功能」的公共口袋（`mosaics` / `crop` / `blackout` /
 * `desub` 都是这么进来的，后端 `routes_v2.py` 收 `Optional[dict]` 原样透传），
 * 所以它**注定还会长**。把它留在 api.ts 里，等于让每一个新后期功能都先去
 * 撞一次预算闸门 —— 闸门想挡的是"往巨石里塞"，不是这件事本身。
 *
 * `api.ts` 仍然 re-export 这两个类型，所以**所有既有的
 * `import type { TransformMeta } from "../../api"` 一行都不用改**。
 */

import type { MosaicParams } from "../render/model";
import type { DesubRegion } from "./desub";

/**
 * 写 transform_meta 时的落库时机（2.2）。
 *
 * `staged: true` —— 拖动/滑动**过程中**的中间值：本地立即生效（画面跟手），
 * 真正的 PATCH 按尾防抖延后，见 `lib/stagedWrite.ts`。
 * 缺省（或 `staged: false`）—— 离散操作（点按钮、选下拉、双击还原）与
 * 松手时的收尾提交：立即落库。
 *
 * ⚠️ 默认是**立即落库**，所以忘了传 `staged` 只会退化成"和以前一样每帧一次
 * PATCH"，不会丢数据；反过来把离散操作标成 staged 才是错的（用户点完就
 * 可能立刻关窗口，得不到 250ms 的宽限）。
 */
export interface TransformPatchOpts { staged?: boolean }

/** TB-03/TB-10：与后端 Shot.transform_meta 同构；缺键 = 该项不处理 */
export interface TransformMeta {
  scale?: number; rotate?: number;
  /**
   * 画面中心相对画布中心的偏移，单位是**画布宽/高的百分比**（不是像素）。
   *
   * ⚠️ 这里必须是分辨率无关的量，原因是硬的：**编辑期根本不知道画布分辨率**——
   * 导出宽高是在 ExportDialog 里当场选的（`App.tsx:588`），同一个项目可以
   * 一会儿导 720p 一会儿导 1080p。若存像素，同一次拖拽在两种分辨率下会把画面
   * 挪到不同的相对位置。
   *
   * 早先这里存的是**预览窗口的屏幕像素**（`CropZoomOverlay` 直接把鼠标位移
   * `dx` 写进来），于是同一个拖动在大窗口和小窗口下存出不同的数——而导出侧
   * 又按画布像素解释它。两头单位都不对，且互不相同。
   */
  x?: number; y?: number;
  /**
   * V2.3：非等比缩放（百分比，缺省跟随 scale）。
   * 拖边中点做单轴拉伸时才会写入；角点等比缩放只写 scale。
   * 渲染/预览取值一律用 `scaleX ?? scale`，老数据没有这两个字段也能正常工作。
   */
  scaleX?: number; scaleY?: number;
  opacity?: number; mirrorH?: boolean; mirrorV?: boolean;
  speed?: number;
  volume?: number; muted?: boolean; fadeIn?: number; fadeOut?: number;
  /** 调色（滤镜面板手动调节，范围 -100..100） */
  exposure?: number; contrast?: number; saturation?: number;
  temperature?: number; tint?: number; highlights?: number; shadows?: number;
  sharpen?: number;
  /** TB-09：.cube LUT 文件的素材 URL */
  lut?: string;
  /** V2.2 逐帧特效（0..100 强度）；未列出的项 = 不启用 */
  blur?: number; vignette?: number; grain?: number; glitch?: number;
  shake?: number; zoomPulse?: number; flash?: number; glow?: number;
  /**
   * V2.3 区域马赛克（数组，允许多个区域）。
   * 类型直接复用 render 层的 MosaicParams —— normalize.ts 就是原样铺进去的，
   * 两边同构是硬约束，各写一份只会静默漂移（见 model.ts 的说明）。
   * model.ts 零依赖、纯类型，这里是 type-only import，不产生运行时耦合。
   */
  mosaics?: MosaicParams[];
  /** V2.3 取景框裁切（相对原始画面的比例 0..1）；未设 = 不裁 */
  crop?: { left: number; top: number; right: number; bottom: number };
  /** V2.2 混合模式（仅叠加层生效） */
  blendMode?: "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten";
  /**
   * P2-7 留黑：画面变黑，**时长与声音照旧**。
   * 与 `ShotTimelineIn.disabled`（停用：不占时间、不出画面、字幕合拢）是
   * 两件不同的事，语义对照表见 `render/model.ts` 的 `RenderClip.blackout`。
   *
   * 放在 `transform_meta` 里而不是新加一列：后端 `routes_v2.py` 的
   * `transform_meta: Optional[dict]` 原样透传，**零迁移**；代价是它会参与
   * `transform_rev` 的内容哈希 —— 这恰恰是想要的，留黑本来就该受乐观锁保护。
   */
  blackout?: boolean;
  /** 去字幕标记：视频模型（seedance 等）偶尔会把台词**烧进成片画面**，
   *  这里记下"哪一段时间、画面的哪一块"要送去第三方擦掉。
   *  为什么住在 transform_meta 里、以及「传 `{}` 清空时必须保留它」这条，
   *  都写在 types/desub.ts 的头注释里。 */
  desub?: DesubRegion[];
}
