/**
 * render/maskRaster.ts —— 形状 → 灰度 alpha 蒙版（批次 5 · 5.2）
 *
 * 输出 **raw gray**（每像素 1 字节，255=遮挡、0=保留），直接喂给 ffmpeg：
 *
 *   -f rawvideo -pix_fmt gray -s ${boxW}x${boxH} -i mask_....gray
 *
 * ## 为什么是纯 TS 而不是 canvas
 *
 * 计划书原本写的是 `canvas.toBlob('image/png')`。但**验证脚本跑在 node（tsx）下，
 * 没有 DOM、没有 canvas** —— 照那个写法，"真导出冒烟"这条最关键的验证根本跑不起来，
 * 只能拿预制蒙版糊弄。而预览侧本来也不是 canvas（`MosaicOverlay` 用的是 `<svg>`），
 * canvas 在这里没有任何既有代码可复用。
 *
 * 于是改成纯 TS 光栅化：浏览器与 node **同一份代码**，不依赖 DOM，
 * 也省掉 PNG 编码（否则要在 `CompressionStream` 与 `zlib` 之间分叉）。
 *
 * ## 与 5.1 `coversPoint` 的关系（**刻意不同，不要"对齐"它们**）
 *
 * `coversPoint` 描述的是**现有 geq 表达式**的语义：抽稀到 ≤60 个点的**离散圆**并集。
 * 本文件描述的是**蒙版路径**的语义：**逐段胶囊**（线段 + 圆头）并集，**不抽稀**。
 *
 * 后者严格更好 —— 表达式长度上限没了，笔迹涂多细就是多细，且相邻点之间不再靠
 * "点距小于半径"碰运气连上。二者的可检查关系是**包含**：
 *
 *   geq 覆盖的像素 ⊆ 蒙版覆盖的像素
 *
 * 验证脚本钉的是这条包含关系，而不是逐像素相等 —— 相等本来就不该成立。
 *
 * ## 羽化
 *
 * 三次可分离 box blur 近似高斯。**边界按 0 补**（不是复制边缘）：
 * 这样矩形区域才会真的产生软边，而不是"糊了个寂寞"仍是硬边。
 * 代价是 50% 等值线落在原始形状边界上，即羽化是**向内外各半**地展开 ——
 * 这也是各家羽化工具的通行语义。
 *
 * ⚠️ **调用方的责任**：羽化要有地方渲染，包围盒必须**预先外扩** featherPx。
 * 本文件只负责填满交给它的那个盒子，不会自作主张改盒子尺寸 ——
 * 因为盒子尺寸同时也是 `crop` 的字面量，两边必须由**同一个整数**决定
 * （§0.5 那条 `Input frame sizes do not match` 的教训）。
 */

import type { RegionShape } from "../lib/regionShape";
import { brushRadiiInBox, regionShapeAt } from "../lib/regionShape";
import { isNoOpRegion, featherPxOf } from "./maskGroups";
import type { MosaicParams } from "./model";

export interface BoxPx { w: number; h: number }

/**
 * 由羽化宽度算 box blur 半径。
 *
 * 三次 box blur 的总方差 = 3 × ((2r+1)² − 1)/12 = ((2r+1)² − 1)/4，
 * 令其等于 σ² 解出 **r = (√(1+4σ²) − 1)/2**。
 *
 * σ 与"羽化宽度"的换算：高斯的 10%→90% 过渡带宽 ≈ 2.563σ，而 `featherPx`
 * 对用户的含义就是那条软边有多宽，故取 **σ = featherPx / 2.563**。
 * 验证脚本实测这条带宽并钉住，不靠这段推导自证。
 */
/**
 * 羽化宽度 → 高斯 σ。**全工程只有这一处**定这个换算。
 *
 * 高斯的 10%→90% 过渡带宽 ≈ 2.563σ，而 `featherPx` 对用户的含义就是那条软边
 * 有多宽，故 **σ = featherPx / 2.563**。
 *
 * 提成导出函数是因为编辑器的**画面预览**也要用它（`MosaicOverlay` 的 SVG
 * feGaussianBlur 直接吃 σ）。预览与导出各写一个系数的话，用户拉到 20 的羽化
 * 在画面上和成片里宽度就是两回事——而羽化这种"看着调"的参数，预览不准
 * 等于没有。
 */
export function featherSigma(featherPx: number): number {
  return featherPx <= 0 ? 0 : featherPx / 2.563;
}

export function featherBoxRadius(featherPx: number): number {
  if (featherPx <= 0) return 0;
  const sigma = featherSigma(featherPx);
  const r = Math.round((Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2);
  return Math.max(1, r);
}

/**
 * 中间缓冲。用工厂 + `ReturnType` 推出类型，而不是写字面的 `Float32Array<...>`：
 * 新版 TS/@types/node 给 TypedArray 加了 buffer 类型参数，写死会在两处 tsconfig
 * （app 与 scripts）之间不一致。
 */
function makeBuf(n: number) { return new Float32Array(n); }
type Buf = ReturnType<typeof makeBuf>;

/**
 * 一维 box blur，**零补边**，用前缀和做到 O(n)。
 * 除的始终是完整核宽 (2r+1)，靠边处少掉的那部分就当成 0 —— 这正是"零补边"。
 */
function blurRows(src: Buf, dst: Buf, w: number, h: number, r: number): void {
  const k = 2 * r + 1;
  const pre = makeBuf(w + 1);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    pre[0] = 0;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[off + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w, x + r + 1);
      dst[off + x] = (pre[hi] - pre[lo]) / k;
    }
  }
}

/** 转置，好让列方向复用 `blurRows` —— 少一份几乎相同的代码 */
function transpose(src: Buf, w: number, h: number): Buf {
  const out = makeBuf(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = src[y * w + x];
  return out;
}

/** 到线段的距离是否 ≤ 1（坐标已按 rx/ry 归一化，所以判的是单位胶囊） */
function inCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey <= 1;
}

/**
 * 把一个区域光栅化成灰度蒙版。
 *
 * @param shape      形状描述（`lib/regionShape` 的唯一来源）
 * @param boxPx      蒙版尺寸，**必须与 `crop` 的整数宽高逐像素一致**
 * @param featherPx  羽化宽度（像素），0 = 硬边
 * @param canvasAspect 画布宽高比 canvasW/canvasH，用于笔刷半径换算
 */
export function rasterRegionMask(
  shape: RegionShape, boxPx: BoxPx, featherPx: number, canvasAspect: number,
): Uint8Array {
  const w = Math.max(1, Math.floor(boxPx.w));
  const h = Math.max(1, Math.floor(boxPx.h));
  const out = new Uint8Array(w * h);

  if (shape.kind === "rect") {
    out.fill(255);
  } else if (shape.kind === "ellipse") {
    // 内切椭圆：中心 (w/2, h/2)，半径 (w/2, h/2)，像素取中心点采样
    const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
    for (let y = 0; y < h; y++) {
      const dy = (y + 0.5 - cy) / ry;
      const dy2 = dy * dy;
      if (dy2 > 1) continue;
      // 解出该行的 x 范围，避免逐像素开方判断
      const half = Math.sqrt(1 - dy2) * rx;
      const x0 = Math.max(0, Math.ceil(cx - half - 0.5));
      const x1 = Math.min(w - 1, Math.floor(cx + half - 0.5));
      out.fill(255, y * w + x0, y * w + x1 + 1);
    }
  } else {
    // 画笔：逐段胶囊（线段 + 圆头）。**不抽稀** —— 蒙版路径没有表达式长度上限。
    const { rx, ry } = brushRadiiInBox(shape.box, shape.brushSize, canvasAspect);
    const rxPx = Math.max(rx * w, 1e-6);
    const ryPx = Math.max(ry * h, 1e-6);
    const pts = shape.stroke.map((p) => ({
      x: ((p.x - shape.box.x) / Math.max(shape.box.w, 1e-6)) * w,
      y: ((p.y - shape.box.y) / Math.max(shape.box.h, 1e-6)) * h,
    }));
    // 单点也要画出圆头：退化成 A==B 的胶囊
    const segs = pts.length === 1
      ? [[pts[0], pts[0]] as const]
      : pts.slice(0, -1).map((p, i) => [p, pts[i + 1]] as const);

    for (const [a, b] of segs) {
      // 只遍历这一段的包围盒，别扫整幅
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - rxPx - 1));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + rxPx + 1));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - ryPx - 1));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + ryPx + 1));
      const ax = a.x / rxPx, ay = a.y / ryPx, bx = b.x / rxPx, by = b.y / ryPx;
      for (let y = y0; y <= y1; y++) {
        const py = (y + 0.5) / ryPx;
        const row = y * w;
        for (let x = x0; x <= x1; x++) {
          if (out[row + x] === 255) continue;
          if (inCapsule((x + 0.5) / rxPx, py, ax, ay, bx, by)) out[row + x] = 255;
        }
      }
    }
  }

  return featherMask(out, w, h, featherPx);
}

/**
 * 对**任意**灰度缓冲做羽化（三次可分离 box blur，零补边）。原地返回同一个数组。
 *
 * 从 `rasterRegionMask` 里原样提出来，一行未改 —— 提出来的理由是
 * `rasterGroupMask` 必须先把硬边形状放进**加了边距**的缓冲再模糊，
 * 否则羽化的外半边会被盒子边缘直接切掉（"糊了个寂寞"）。
 * 两条路径共用同一份模糊，`verify-maskraster` 的羽化断言因此仍然守着它。
 */
export function featherMask(out: Uint8Array, w: number, h: number, featherPx: number): Uint8Array {
  const r = featherBoxRadius(featherPx);
  if (r === 0) return out;

  // 三次 box blur ≈ 高斯。横三次 + 竖三次（可分离）。
  let buf = makeBuf(w * h);
  buf.set(out);
  let tmp = makeBuf(w * h);
  for (let i = 0; i < 3; i++) { blurRows(buf, tmp, w, h, r); [buf, tmp] = [tmp, buf]; }
  let col = transpose(buf, w, h);
  let ctmp = makeBuf(w * h);
  for (let i = 0; i < 3; i++) { blurRows(col, ctmp, h, w, r); [col, ctmp] = [ctmp, col]; }
  buf = transpose(col, h, w);

  for (let i = 0; i < out.length; i++) {
    const v = buf[i];
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  }
  return out;
}

/**
 * 把一个**合成组**在 t 时刻的全部区域光栅化进该组的整数框（批次 5 · 5.4）。
 *
 * ## 为什么不能直接 `rasterRegionMask(shape, group.box, …)`
 *
 * 这是接 5.4 时才暴露出来的**真缺口**：`rasterRegionMask` 把 `shape.box`
 * **铺满**交给它的盒子（矩形 `fill(255)`、椭圆按 `w/2,h/2` 内切、画笔按
 * `(p - box)/box.w` 归一化）。而 5.3 的组框**不等于**区域框——它是
 * 「向外取偶 + 羽化外扩 + 可能是多区域并集 + 可能是整段时间的并集」。
 * 照直传进去，圆会被拉成椭圆、多区域组只剩第一个区域被拉满整框、
 * 羽化越宽形状被撑得越大。**不报错，画面静默错**。
 *
 * 所以这里改成在**组框的像素坐标系里**摆放每个区域：逐区域按自己的真实像素尺寸
 * 光栅化 → 需要羽化的先放进带边距的缓冲再模糊 → 按 `max` 合成进组框。
 * `max` 而非相加：两个区域重叠处仍是 255，不会溢出成亮斑。
 *
 * @param tSec 输出时间（秒）。静态区域忽略之；动画区域按 `regionBoxAt` 取当帧的框。
 *             动画组的蒙版是逐帧调用本函数、把结果顺序拼进同一个 .gray 文件。
 */
export function rasterGroupMask(
  regions: MosaicParams[],
  group: { box: { x: number; y: number; w: number; h: number }; regionIdxs: number[] },
  canvas: { w: number; h: number },
  tSec = 0,
): Uint8Array {
  const { x: gx, y: gy, w: gw, h: gh } = group.box;
  const out = new Uint8Array(gw * gh);
  const aspect = canvas.w / canvas.h;

  for (const ri of group.regionIdxs) {
    const m = regions[ri];
    if (!m || isNoOpRegion(m)) continue;

    // 形状随框刚体平移/缩放（笔迹按仿射映射跟着走）——**与预览共用同一个函数**，
    // 5.6 起 `MosaicOverlay` 画的也是 `regionShapeAt(m, t)`。
    // 静态区域下它恒等于 `regionShapeOf(m)`，逐点不变。
    const shape: RegionShape = regionShapeAt(m, tSec);
    const rel = shape.box;

    const rw = Math.max(1, Math.round(rel.w * canvas.w));
    const rh = Math.max(1, Math.round(rel.h * canvas.h));
    let sub = rasterRegionMask(shape, { w: rw, h: rh }, 0, aspect);
    let sw = rw, sh = rh;
    let ox = Math.round(rel.x * canvas.w), oy = Math.round(rel.y * canvas.h);

    const fpx = featherPxOf(m, canvas);
    if (fpx > 0) {
      // 边距要够整条软边展开：模糊核半宽 3r，再留 1px 余量
      const pad = 3 * featherBoxRadius(fpx) + 1;
      const pw = rw + 2 * pad, ph = rh + 2 * pad;
      const padded = new Uint8Array(pw * ph);
      for (let y = 0; y < rh; y++) padded.set(sub.subarray(y * rw, (y + 1) * rw), (y + pad) * pw + pad);
      sub = featherMask(padded, pw, ph, fpx);
      sw = pw; sh = ph; ox -= pad; oy -= pad;
    }

    for (let y = 0; y < sh; y++) {
      const dy = oy + y - gy;
      if (dy < 0 || dy >= gh) continue;
      const srow = y * sw, drow = dy * gw;
      for (let x = 0; x < sw; x++) {
        const dx = ox + x - gx;
        if (dx < 0 || dx >= gw) continue;
        const v = sub[srow + x];
        if (v > out[drow + dx]) out[drow + dx] = v;
      }
    }
  }
  return out;
}
