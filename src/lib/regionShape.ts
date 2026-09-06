/**
 * regionShape — 马赛克区域的**唯一形状描述层**（批次 5 · 5.1）
 *
 * ## 为什么要有这一层
 *
 * 在此之前，"一个笔刷点有多大"这件事在三个地方各算了一遍：
 *
 *   1. `MosaicOverlay` 的预览 SVG —— `strokeWidth = brushSize * 预览框宽`，
 *      `strokeLinecap="round"`，画出来是**像素意义上的正圆**
 *   2. `MosaicOverlay` 的 `strokeBounds` —— `ry = r * aspect`，
 *      同样是像素正圆（换算正确）
 *   3. `ffmpegCompiler` 的 geq 表达式 —— `rRelY = rRel * (m.w / m.h)`
 *
 * 第 3 条**是错的**，而且不是理论推断，是量出来的：1080×1920 画布、
 * `brushSize=0.1`（预期直径 108px）、单点笔迹，实跑 ffmpeg 后测覆盖区域得到
 * **109 × 193 px** —— 纵向被拉长 1.771 倍，正好是画布宽高比 1920/1080 = 1.778。
 * 原注释说"Y 方向半径要按小图宽高比换算，否则笔刷会被拉成椭圆"，
 * 方向是对的，但只换算了**小图**的宽高比，漏了**画布**的宽高比：
 *
 *   小图内 x 半径（像素）= rRel * (m.w * canvasW) = (bs/2) * canvasW      ✓
 *   小图内 y 半径（像素）= rRelY * (m.h * canvasH) = (bs/2) * canvasH     ✗ 应为 (bs/2)*canvasW
 *
 * 所以正确的 `rRelY = (bs/2) / m.h * (canvasW / canvasH)`，即比原式多一个画布宽高比。
 * 用户看到的是：**画的时候是圆的，导出来是竖着的椭圆**。
 *
 * 本文件把这套几何收成一份，预览与导出都从这里取值，
 * 上面那种"三处各算一遍、其中一处悄悄错了"的漂移就没有生长空间了。
 *
 * ## 约束
 *
 * - **纯函数、无副作用、不 import `api` / Tauri**：`ffmpegCompiler` 和跑在 node
 *   下的 verify 脚本都要用它（`src/api.ts:9` 读 `import.meta.env`，
 *   任何运行期 import 到 api 的模块在 tsx 下都加载不了）。
 * - 坐标一律是**比例**：x/w 相对画面宽，y/h 相对画面高，与 `MosaicParams` 一致。
 */

import type { MosaicParams, MosaicShape } from "../render/model";
import { regionBoxAt } from "../render/maskGroups";

export interface Pt { x: number; y: number }

/** 区域包围盒，比例坐标 0..1 */
export interface Box { x: number; y: number; w: number; h: number }

/** 区域最小边长（比例）。拉得再小也不让它退化成 0，否则 crop 会拿到 0 宽高。 */
export const MIN_REGION_SIZE = 0.02;

/**
 * geq 表达式的笔迹点数上限。
 * 表达式过长时 ffmpeg 会直接拒绝解析，故按需抽稀。
 * ⚠️ 这个值参与生成导出参数，改动会移动黄金基线 —— 不是可以随手调的常数。
 */
export const BRUSH_MAX_PTS = 60;

/** 形状描述：预览画什么、导出光栅化什么，都以它为准 */
export type RegionShape =
  | { kind: "rect"; box: Box }
  | { kind: "ellipse"; box: Box }
  | { kind: "brush"; box: Box; stroke: Pt[]; brushSize: number };

/** 缺省笔刷直径（相对画面宽度）。老数据可能没有 brushSize 字段。 */
export const DEFAULT_BRUSH_SIZE = 0.08;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 从持久态 `MosaicParams` 取出形状描述。
 *
 * 老数据没有 `shape` 字段 → 一律当矩形（与现有编译器的 `m.shape ?? "rect"` 同义）。
 * 画笔但笔迹为空 → 也降为矩形：编译器对空笔迹是整区跳过，
 * 而调用方拿到 `kind:"brush"` 却画不出东西更容易埋 bug。
 */
export function regionShapeOf(m: MosaicParams): RegionShape {
  const box: Box = { x: m.x, y: m.y, w: m.w, h: m.h };
  const shape: MosaicShape = m.shape ?? "rect";
  if (shape === "ellipse") return { kind: "ellipse", box };
  if (shape === "brush") {
    const stroke = m.stroke ?? [];
    if (stroke.length === 0) return { kind: "rect", box };
    return { kind: "brush", box, stroke, brushSize: m.brushSize ?? DEFAULT_BRUSH_SIZE };
  }
  return { kind: "rect", box };
}

/**
 * 把笔迹从一个包围盒**仿射映射**到另一个包围盒（平移 + 各轴独立缩放）。
 *
 * 全工程只有这一处定义「框动了、笔迹怎么跟着动」。三个调用方：
 *  - 预览拖动（`MosaicOverlay` 的 move / resize）
 *  - `regionShapeAt`（关键帧动画的当帧形状）
 *  - 光栅化 `rasterGroupMask`（经 `regionShapeAt`）
 *
 * ⚠️ 拖动那条路原先是**两个式子**：move 写 `p.x + dx`（dx 是**指针**位移）、
 * resize 写 `x + (p.x - o.x) * sx`。前者在框被夹到画面边缘时会分叉 ——
 * 框停住了、笔迹还在跟着指针走，笔迹当场跑出包围盒
 * （导出按「笔迹相对包围盒」算 alpha，于是遮的不是用户看到的那块）。
 * 统一成仿射映射后，「框到哪笔迹到哪」是结构性的，不靠两处各自小心。
 */
export function remapStroke(stroke: Pt[] | undefined, from: Box, to: Box): Pt[] | undefined {
  if (!stroke) return undefined;
  const sx = to.w / Math.max(from.w, 1e-6);
  const sy = to.h / Math.max(from.h, 1e-6);
  return stroke.map((p) => ({
    x: to.x + (p.x - from.x) * sx,
    y: to.y + (p.y - from.y) * sy,
  }));
}

/**
 * 区域在 **t 时刻**的形状描述。关键帧动画下框按 `regionBoxAt` 插值，
 * 笔迹按 `remapStroke` 跟着走。
 *
 * ⚠️ 预览（`MosaicOverlay` 的 SVG）与导出（`rasterGroupMask` 的光栅化器）
 * **必须都走这里**。5.4 时这段仿射映射是内联在光栅化器里的，5.6 接预览时
 * 若在组件里再抄一份，就又回到「预览对、导出错」那条老路 —— 而且那种错
 * 没有任何断言会自然发现（两边各自看都是自洽的）。
 *
 * 无关键帧（<2 条）时 `regionBoxAt` 返回静态框，本函数即**恒等**于
 * `regionShapeOf`，逐点不变 —— 老数据零影响。
 */
export function regionShapeAt(m: MosaicParams, tSec: number): RegionShape {
  const base = regionShapeOf(m);
  const box = regionBoxAt(m, tSec);
  if (box.x === base.box.x && box.y === base.box.y
      && box.w === base.box.w && box.h === base.box.h) return base;
  if (base.kind === "brush") {
    return { ...base, box, stroke: remapStroke(base.stroke, base.box, box)! };
  }
  return { ...base, box };
}

/**
 * 笔刷半径，**画布归一化**：`rx` 相对画面宽，`ry` 相对画面高。
 *
 * 笔刷在屏幕上是正圆，所以两个方向的**像素**半径必须相等：
 *
 *   rx * canvasW === ry * canvasH
 *
 * `brushSize` 定义为相对画面**宽度**的直径比例，于是 `rx = bs/2`，
 * 代入得 `ry = (bs/2) * (canvasW / canvasH)` —— 即乘画布宽高比。
 *
 * @param canvasAspect 画布宽高比 canvasW / canvasH（1080×1920 → 0.5625）
 */
export function brushRadii(brushSize: number, canvasAspect: number): { rx: number; ry: number } {
  const rx = brushSize / 2;
  return { rx, ry: rx * canvasAspect };
}

/**
 * 笔刷半径，**包围盒归一化**：相对小图宽/高的比例，供 geq 的 X/W、Y/H 坐标系使用。
 *
 * 这是上面那条 bug 的落点。由 `brushRadii` 除以盒子边长得到，
 * 不再单独推导一遍 —— 只有一个来源就不会再各错各的。
 */
export function brushRadiiInBox(
  box: Box, brushSize: number, canvasAspect: number,
): { rx: number; ry: number } {
  const { rx, ry } = brushRadii(brushSize, canvasAspect);
  return { rx: rx / Math.max(box.w, 1e-6), ry: ry / Math.max(box.h, 1e-6) };
}

/**
 * 由笔迹点集算出包围盒（含笔刷半径外扩）。
 * 原在 `MosaicOverlay.tsx:64`，行为逐字保持不变，只是搬到这里并改用 `brushRadii`
 * ——原来的 `ry = r * aspect` 与 `brushRadii` 的 `ry` 是同一个式子。
 */
export function strokeBounds(stroke: Pt[], brushSize: number, canvasAspect: number): Box {
  const { rx: r, ry } = brushRadii(brushSize, canvasAspect);
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of stroke) {
    x0 = Math.min(x0, p.x - r); y0 = Math.min(y0, p.y - ry);
    x1 = Math.max(x1, p.x + r); y1 = Math.max(y1, p.y + ry);
  }
  x0 = clamp(x0, 0, 1); y0 = clamp(y0, 0, 1);
  x1 = clamp(x1, 0, 1); y1 = clamp(y1, 0, 1);
  return {
    x: x0, y: y0,
    w: Math.max(x1 - x0, MIN_REGION_SIZE),
    h: Math.max(y1 - y0, MIN_REGION_SIZE),
  };
}

/**
 * 笔迹抽稀。等距取样并**始终保留最后一点**（否则笔迹末端会被截掉）。
 * 行为与原 `ffmpegCompiler` 内联的那段逐字相同。
 */
export function decimateStroke(stroke: Pt[], maxPts: number = BRUSH_MAX_PTS): Pt[] {
  const step = Math.max(1, Math.ceil(stroke.length / maxPts));
  return stroke.filter((_, i) => i % step === 0 || i === stroke.length - 1);
}

/**
 * 点是否落在形状内。坐标是**包围盒归一化**的 `u = X/W`、`v = Y/H`，
 * 与 geq 表达式里的坐标系一致 —— 这样这个谓词才能拿来核对导出表达式的语义，
 * 而不是"另写一份差不多的判断"。
 *
 * ⚠️ 与 `ffmpegCompiler` 的 alpha 表达式必须同义。5.1 的验证脚本在网格上逐点比对，
 * 且比对的是**同一组参数**算出来的两样东西（表达式字符串里的数字 / 这里的谓词），
 * 任何一边改了另一边没跟上都会红。
 */
export function coversPoint(
  shape: RegionShape, u: number, v: number, canvasAspect: number,
): boolean {
  if (shape.kind === "rect") return u >= 0 && u <= 1 && v >= 0 && v <= 1;

  if (shape.kind === "ellipse") {
    // 椭圆内切于包围盒：cx=cy=0.5，rx=ry=0.5（归一化后）
    const dx = (u - 0.5) / 0.5;
    const dy = (v - 0.5) / 0.5;
    return dx * dx + dy * dy <= 1;
  }

  const { box, stroke, brushSize } = shape;
  const { rx, ry } = brushRadiiInBox(box, brushSize, canvasAspect);
  for (const p of decimateStroke(stroke)) {
    const cx = (p.x - box.x) / Math.max(box.w, 1e-6);
    const cy = (p.y - box.y) / Math.max(box.h, 1e-6);
    const dx = (u - cx) / rx;
    const dy = (v - cy) / ry;
    if (dx * dx + dy * dy <= 1) return true;
  }
  return false;
}
