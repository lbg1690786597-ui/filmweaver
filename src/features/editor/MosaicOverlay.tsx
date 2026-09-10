/**
 * MosaicOverlay — 在预览窗口上创建/编辑马赛克区域（V2.3，对齐剪映）
 *
 * ## 三种绘制工具
 *   矩形  拖拽拉出矩形
 *   圆形  拖拽拉出椭圆（按住 Shift 锁正圆）
 *   画笔  按住涂抹，笔迹自动生成遮罩（滚轮调笔刷大小）
 *
 * ## 交互
 *   - 工具栏浮在画面左上角，切换工具 / 调样式 / 调笔刷
 *   - 新建区域后**自动选中并弹出设置气泡**（样式 + 强度），不用去侧边栏
 *   - 已有区域：点选 → 8 个控制点缩放 + 拖动移动 + 右上角删除
 *   - Delete/Backspace 删除选中；Escape 取消选中或退出绘制
 *
 * ## 落库时机（2.2）
 *
 * 移动 / 缩放区域、拖强度滑块这三条是**每个 pointermove 一次**的路径，
 * 改动前每一次都发一笔 PATCH（外加一次全项目详情 GET），拖 3 秒上百组请求。
 * 现在拖动中只 `staged` —— 本地即时生效（画面照旧跟手，App 会把未落库的值
 * 盖回 detail.shots），真正的落库在松手那一下。见 `lib/stagedWrite.ts`。
 * 新建区域（拖框 / 涂抹）本来就只在松手时写一次，不属于这条路径。
 */

import { useRef, useState, useCallback, useEffect } from "react";
import { X, Square, Circle, Brush } from "lucide-react";
import type { TransformMeta, TransformPatchOpts } from "../../api";
import type { MosaicParams, MosaicStyle } from "../../render/model";
import { useCanvasToolStore } from "../../stores/canvasToolStore";
import { strokeBounds, MIN_REGION_SIZE, regionShapeAt } from "../../lib/regionShape";
import type { Box } from "../../lib/regionShape";
import { regionBoxAt, featherPxOf } from "../../render/maskGroups";
import { featherSigma } from "../../render/maskRaster";
import { applyRegionBox, kfCount } from "../../lib/keyframeEdit";
import "./MosaicOverlay.css";

/** 区域类型来自 render/model.ts（唯一一份），本文件不再自抄一遍 */
type MosaicRegion = MosaicParams;

interface Props {
  vrect: { left: number; top: number; width: number; height: number };
  transform: TransformMeta | null;
  /** 落库回调。拖动中的中间值传 `{ staged: true }`（本地即时生效、落库延后），
   *  松手时不带 opts 再发一次做真落库。 */
  onPatchTransform: (
    tm: TransformMeta | Record<string, never>, opts?: TransformPatchOpts,
  ) => void;
  active: boolean;
  /**
   * 播放头在**该镜头内**的秒数（输出时间）。
   *
   * 有关键帧的区域按这个时刻插值出当帧的框来画 —— 走的是
   * `lib/regionShape.regionShapeAt`，**与导出的光栅化器同一个函数**。
   * 在这里另写一份插值就会回到「预览对、导出错」那条老路，而且两边各自看都自洽，
   * 没有任何断言会自然发现（见 `verify-kfedit.ts` 第 [8] 节）。
   */
  tSec: number;
  onToast: (m: string) => void;
}

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type DragState =
  | { kind: "draw"; startX: number; startY: number }
  | { kind: "paint" }
  /** `box` 是**按下那一刻画面上的框**（动画区域即当帧插值结果，静态区域即 x/y/w/h）；
   *  `kfToast` 保证一次拖动只提示一次，而不是每个 pointermove 都弹。 */
  | { kind: "move"; startX: number; startY: number; idx: number; orig: MosaicRegion; box: Box; kfToast?: boolean }
  | { kind: "resize"; startX: number; startY: number; idx: number; orig: MosaicRegion; box: Box; handle: HandleId; kfToast?: boolean }
  | null;

const HANDLE_SIZE = 9;
/** 区域最小边长。与导出侧同一个常量（`lib/regionShape`），不再各写一份。 */
const MIN_SIZE = MIN_REGION_SIZE;

const STYLE_LABEL: Record<MosaicStyle, string> = {
  pixel: "马赛克", gaussblur: "模糊", blackbox: "遮挡",
};

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export default function MosaicOverlay({
  vrect, transform, onPatchTransform, active, tSec, onToast,
}: Props) {
  const tm = transform ?? {};
  const mosaics: MosaicRegion[] = tm.mosaics ?? [];

  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>(null);

  // 工具 / 样式 / 强度 / 笔刷 / 选中 —— 这些原本是本组件的 useState，
  // 于是侧边栏的 MosaicPanel 既看不见也改不了（用户："预设几何形、画笔都没在这里展示"）。
  // 提到 canvasToolStore 后，面板与画面成为同一个编辑器的两个视图：
  // 面板点「圆形」画面立刻切到圆形，画面上选中区域面板同步高亮。
  const tool = useCanvasToolStore((s) => s.mosaicTool);
  const setTool = useCanvasToolStore((s) => s.setMosaicTool);
  const style = useCanvasToolStore((s) => s.mosaicStyle);
  const setStyle = useCanvasToolStore((s) => s.setMosaicStyle);
  const intensity = useCanvasToolStore((s) => s.mosaicIntensity);
  const setIntensity = useCanvasToolStore((s) => s.setMosaicIntensity);
  const brushSize = useCanvasToolStore((s) => s.brushSize);
  const setBrushSize = useCanvasToolStore((s) => s.setBrushSize);
  const selIdx = useCanvasToolStore((s) => s.mosaicSel);
  const setSelIdx = useCanvasToolStore((s) => s.setMosaicSel);

  const [drawBox, setDrawBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [paintPts, setPaintPts] = useState<{ x: number; y: number }[]>([]);
  /** 新建后自动展开设置气泡 */
  const [popover, setPopover] = useState(false);

  const aspect = vrect.width / Math.max(vrect.height, 1);

  /** 拖动中最后一次 stage 出去的值；松手时原样重发一遍做真落库（2.2）。
   *  ⚠️ 不在松手回调里从 mosaics 现算：拖动结束时 dragRef 已清空、
   *  且 React 可能把最后一次渲染推迟到 pointerup 之后，重算会漏掉最后一格。 */
  const stagedRef = useRef<TransformMeta | Record<string, never> | null>(null);

  const save = useCallback((next: MosaicRegion[], staged = false) => {
    const payload = { ...tm, mosaics: next };
    stagedRef.current = staged ? payload : null;
    onPatchTransform(payload, staged ? { staged: true } : undefined);
  }, [tm, onPatchTransform]);

  /** 松手 / 拖动被打断 / 滑块失焦：把 stage 的值真正落库一次 */
  const commitStaged = useCallback(() => {
    const v = stagedRef.current;
    stagedRef.current = null;
    // 只点了一下没拖动 → 没有待落库的值，不平白多发一笔 PATCH
    if (v) onPatchTransform(v);
  }, [onPatchTransform]);

  /** 屏幕坐标 → 画面比例坐标 */
  const toRatio = useCallback((clientX: number, clientY: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    return {
      x: clamp((clientX - r.left) / vrect.width, 0, 1),
      y: clamp((clientY - r.top) / vrect.height, 0, 1),
    };
  }, [vrect]);

  /**
   * 拖动 / 缩放的落点：把新框交给 `applyRegionBox`，由它决定这是
   * 「改静态框」还是「在播放头处写一条关键帧」。
   *
   * 这两种情况在**组件里不分岔**是有意的：分岔一旦写在这儿，
   * 「什么时候算动画」就有了第二个定义，迟早与 `regionBoxAt`/`kfExpr` 漂移。
   * 组件只负责算出"用户把框拖到哪了"，语义全在 `lib/keyframeEdit`（有单测）。
   */
  const commitBox = useCallback((
    d: { idx: number; orig: MosaicRegion; kfToast?: boolean }, box: Box,
  ) => {
    const cur = mosaics[d.idx] ?? d.orig;
    // 有关键帧的区域，这一拖是在播放头处记一笔 —— 必须说出来，
    // 否则用户会以为自己"把整个区域挪走了"，而实际只改了这一个时刻。
    if (!d.kfToast && kfCount(cur) > 0) {
      d.kfToast = true;
      onToast(`已在 ${tSec.toFixed(1)}s 记录关键帧`);
    }
    save(mosaics.map((m, i) => (i === d.idx ? applyRegionBox(d.orig, tSec, box) : m)), true);
  }, [mosaics, save, tSec, onToast]);

  // ---- 在空白处按下：开始绘制 ----
  const onCanvasDown = useCallback((e: React.PointerEvent) => {
    if (!active) return;
    e.preventDefault();
    const p = toRatio(e.clientX, e.clientY);
    setSelIdx(null);
    setPopover(false);
    boxRef.current!.setPointerCapture(e.pointerId);

    if (tool === "brush") {
      dragRef.current = { kind: "paint" };
      setPaintPts([p]);
    } else {
      dragRef.current = { kind: "draw", startX: p.x, startY: p.y };
      setDrawBox({ x: p.x, y: p.y, w: 0, h: 0 });
    }
  }, [active, tool, toRatio]);

  const onCanvasMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toRatio(e.clientX, e.clientY);

    if (d.kind === "paint") {
      setPaintPts((prev) => {
        const last = prev[prev.length - 1];
        // 抽稀：距离太近的点不记，避免笔迹点爆炸
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < brushSize * 0.18) return prev;
        return [...prev, p];
      });
      return;
    }

    if (d.kind === "draw") {
      let w = Math.abs(p.x - d.startX);
      let h = Math.abs(p.y - d.startY);
      // 圆形工具按住 Shift 锁正圆（按画面宽高比换算，视觉上才是正圆）
      if (tool === "ellipse" && e.shiftKey) { h = w * aspect; }
      setDrawBox({
        x: Math.min(p.x, d.startX), y: Math.min(p.y, d.startY), w, h,
      });
      return;
    }

    if (d.kind === "move") {
      const dx = p.x - d.startX, dy = p.y - d.startY;
      const o = d.box;
      // ⚠️ 笔迹**不再**单独写 `s.x + dx`。那条式子与上面的 clamp 会分叉：
      // 框被夹到画面边缘停住了，笔迹还在跟着指针走，当场跑出包围盒 ——
      // 而导出是按「笔迹相对包围盒」算 alpha 的，遮的就不是用户看到的那块。
      // 现在统一交给 `applyRegionBox` → `remapStroke` 做仿射映射。
      commitBox(d, {
        x: clamp(o.x + dx, 0, 1 - o.w),
        y: clamp(o.y + dy, 0, 1 - o.h),
        w: o.w, h: o.h,
      });
      return;
    }

    if (d.kind === "resize") {
      const dx = p.x - d.startX, dy = p.y - d.startY;
      const o = d.box;
      let { x, y, w, h } = o;
      if (d.handle.includes("n")) { y = clamp(o.y + dy, 0, o.y + o.h - MIN_SIZE); h = o.h - (y - o.y); }
      if (d.handle.includes("s")) { h = clamp(o.h + dy, MIN_SIZE, 1 - o.y); }
      if (d.handle.includes("w")) { x = clamp(o.x + dx, 0, o.x + o.w - MIN_SIZE); w = o.w - (x - o.x); }
      if (d.handle.includes("e")) { w = clamp(o.w + dx, MIN_SIZE, 1 - o.x); }
      commitBox(d, { x, y, w, h });
    }
  }, [toRatio, tool, aspect, brushSize, commitBox]);

  const onCanvasUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;

    // 移动 / 缩放：拖动期间只 stage 了，这一下才真正落库（2.2）
    if (d?.kind === "move" || d?.kind === "resize") commitStaged();

    if (d?.kind === "draw" && drawBox && drawBox.w > MIN_SIZE && drawBox.h > MIN_SIZE) {
      const r: MosaicRegion = {
        ...drawBox, style, intensity, shape: tool === "ellipse" ? "ellipse" : "rect",
      };
      const next = [...mosaics, r];
      save(next);
      setSelIdx(next.length - 1);
      setPopover(true);           // 新建即弹设置
    }

    if (d?.kind === "paint" && paintPts.length > 1) {
      const b = strokeBounds(paintPts, brushSize, aspect);
      const r: MosaicRegion = {
        ...b, style, intensity, shape: "brush", stroke: paintPts, brushSize,
      };
      const next = [...mosaics, r];
      save(next);
      setSelIdx(next.length - 1);
      setPopover(true);
    }

    setDrawBox(null);
    setPaintPts([]);
  }, [drawBox, paintPts, style, intensity, tool, brushSize, aspect, mosaics, save, commitStaged]);

  // ---- 选中区域上按下：移动 ----
  function onRegionDown(e: React.PointerEvent, idx: number) {
    if (!active) return;
    e.stopPropagation();
    const p = toRatio(e.clientX, e.clientY);
    // 起始框取**画面上看到的那个**：动画区域是当帧插值结果，静态区域就是 x/y/w/h。
    // 拿 orig.x 当起点的话，动画区域一按下就会跳回静态框的位置。
    dragRef.current = {
      kind: "move", startX: p.x, startY: p.y, idx,
      orig: { ...mosaics[idx] }, box: regionBoxAt(mosaics[idx], tSec),
    };
    setSelIdx(idx);
    setPopover(true);
    boxRef.current!.setPointerCapture(e.pointerId);
  }

  function onHandleDown(e: React.PointerEvent, idx: number, handle: HandleId) {
    e.stopPropagation();
    const p = toRatio(e.clientX, e.clientY);
    dragRef.current = {
      kind: "resize", startX: p.x, startY: p.y, idx,
      orig: { ...mosaics[idx] }, box: regionBoxAt(mosaics[idx], tSec), handle,
    };
    setSelIdx(idx);
    boxRef.current!.setPointerCapture(e.pointerId);
  }

  /** 改当前选中区域的样式/强度；没选中就只改"下次新建"的默认值。
   *  `staged`：强度是滑块，拖动中的中间值只在本地生效，松手由 commitStaged 落库。 */
  function patchSel(patch: Partial<MosaicRegion>, staged = false) {
    if (patch.style !== undefined) setStyle(patch.style);
    if (patch.intensity !== undefined) setIntensity(patch.intensity);
    if (selIdx === null) return;
    save(mosaics.map((m, i) => (i === selIdx ? { ...m, ...patch } : m)), staged);
  }

  // ---- 键盘 ----
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selIdx !== null) {
        save(mosaics.filter((_, i) => i !== selIdx));
        setSelIdx(null); setPopover(false);
      }
      if (e.key === "Escape") { setSelIdx(null); setPopover(false); setDrawBox(null); setPaintPts([]); dragRef.current = null; }
      if (e.key === "1") setTool("rect");
      if (e.key === "2") setTool("ellipse");
      if (e.key === "3") setTool("brush");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selIdx, mosaics, save, setSelIdx, setTool]);

  // ---- 滚轮调笔刷大小 ----
  // store 的 setBrushSize 只收具体数值（没有函数式更新），上下限也在 store 里统一夹紧，
  // 这里直接按当前值算增量即可。
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!active || tool !== "brush") return;
    e.preventDefault();
    setBrushSize(brushSize + (e.deltaY < 0 ? 0.01 : -0.01));
  }, [active, tool, brushSize, setBrushSize]);

  if (!active && mosaics.length === 0) return null;

  const px = (v: number) => v * vrect.width;
  const py = (v: number) => v * vrect.height;

  /** 笔迹渲染成 SVG path（圆点连成的粗线） */
  const strokePath = (s: { x: number; y: number }[]) =>
    s.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join("");

  return (
    <div
      ref={boxRef}
      className={`fw-mso${active ? " active" : ""}`}
      style={{ width: vrect.width, height: vrect.height, cursor: active ? (tool === "brush" ? "none" : "crosshair") : "default" }}
      onPointerDown={onCanvasDown}
      onPointerMove={onCanvasMove}
      onPointerUp={onCanvasUp}
      // 拖出窗口、被系统手势打断：同样要收尾，否则 dragRef 卡住、
      // 且这次移动/缩放的最终值只剩本地（要等 250ms 兜底计时器才落库）
      onPointerCancel={onCanvasUp}
      onWheel={onWheel}
    >
      {/* ---- 已有区域 ---- */}
      {mosaics.map((r, idx) => {
        const sel = selIdx === idx;
        const shape = r.shape ?? "rect";
        // 当帧形状：与导出的光栅化器共用 `regionShapeAt`（见 Props.tSec 的注释）。
        // 静态区域下它逐点恒等于 `regionShapeOf(r)`，老数据零影响。
        const shp = regionShapeAt(r, tSec);
        const b = shp.box;
        const drawStroke = shp.kind === "brush" ? shp.stroke : null;
        const L = px(b.x), T = py(b.y), W = px(b.w), H = py(b.h);

        // ---- 羽化预览（3.9）----
        //
        // 在此之前羽化**只在导出时存在**：滑块拉到 40，画面上的遮挡块边缘
        // 依旧是刀切一样的硬边，用户据此判断"这软件没有羽化功能"。
        //
        // 用 SVG mask + feGaussianBlur 而不是 CSS 渐变遮罩：
        //   · 导出走的就是高斯（σ = featherPx / 2.563），SVG 用**同一个 σ**，
        //     预览宽度与成片一致；CSS 的 linear-gradient 是线性衰减，对不上。
        //   · 矩形要四边同时软化，CSS 得靠 mask-composite 叠多层渐变，
        //     而椭圆/画笔又各是一套；SVG 一套写法覆盖三种形状。
        //
        // 软边要向**外**扩散，所以预览层比区域盒四周各大 pad；
        // 与导出的包围盒外扩同一个理由（见 maskRaster 的 `pad = 3r+1`）。
        const fpx = featherPxOf(r, { w: vrect.width, h: vrect.height });
        const sigma = featherSigma(fpx);
        const pad = fpx > 0 ? Math.ceil(3 * sigma) + 1 : 0;
        const featherId = `fw-mso-feather-${idx}`;

        return (
          <div key={idx}
            className={`fw-mso-region${sel ? " selected" : ""}`}
            style={{ left: L, top: T, width: W, height: H }}
            onPointerDown={(e) => onRegionDown(e, idx)}
          >
            {/* 效果预览：按形状裁出 */}
            <div
              className={`fw-mso-preview fw-mso-${r.style}`}
              style={{
                ...(r.style === "gaussblur"
                  ? { backdropFilter: `blur(${r.intensity / 100 * 16}px)`, WebkitBackdropFilter: `blur(${r.intensity / 100 * 16}px)` }
                  : {}),
                ...(shape === "ellipse" ? { borderRadius: "50%" } : {}),
                // 羽化：把预览层向外扩 pad，再套高斯 mask，软边才有地方渲染。
                // 没有羽化时保持 inset:0 原样，老数据零变化。
                ...(pad > 0
                  ? { inset: `${-pad}px`, borderRadius: undefined,
                      mask: `url(#${featherId})`, WebkitMask: `url(#${featherId})` }
                  : {}),
                // 画笔：用 SVG mask 把预览裁成笔迹形状。
                // ⚠️ 必须用 mask 不能用 clipPath —— clipPath 只取路径的**填充**区域，
                // 完全忽略 stroke/strokeWidth；而笔迹是 fill:none 的描边路径，
                // 于是裁剪区退化成路径自身轮廓，自我重叠处还会按 fill-rule 被挖空
                // （用户实测："画笔轨迹重叠处马赛克失效"）。
                // mask 走的是亮度通道，白色描边即可见，重叠只会更白，不会互相抵消。
                //
                // ⚠️ 顺序：笔迹 mask 必须压在羽化 mask **之后** —— 画笔本身就带
                // 一个形状 mask，两个 mask 属性只能留一个，故笔迹形状 + 羽化
                // 合并进同一个 SVG mask（见下方 defs：有羽化时给 path 挂滤镜）。
                ...(shape === "brush" && drawStroke && pad === 0
                  ? { mask: `url(#fw-mso-mask-${idx})`, WebkitMask: `url(#fw-mso-mask-${idx})` }
                  : {}),
              }}
            />

            {/* 画笔形状的裁剪路径（无羽化时用；有羽化时走下面那个合并 mask） */}
            {shape === "brush" && drawStroke && pad === 0 && (
              <svg className="fw-mso-svg" width={W} height={H}>
                <defs>
                  <mask id={`fw-mso-mask-${idx}`} maskUnits="userSpaceOnUse"
                        x={0} y={0} width={W} height={H}>
                    {/* 白 = 保留。描边宽度即笔刷直径，圆头圆角保证笔迹平滑，
                        重叠处仍是白色，不会像 clipPath 那样被挖空。 */}
                    <path
                      d={drawStroke.map((p, i) =>
                        `${i ? "L" : "M"}${(px(p.x) - L).toFixed(1)},${(py(p.y) - T).toFixed(1)}`).join("")}
                      stroke="#fff"
                      strokeWidth={px(r.brushSize ?? 0.1)}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </mask>
                </defs>
              </svg>
            )}

            {/* 羽化 mask：形状 + 高斯软边合成一个 mask。
                三种形状共用一套写法，唯一的差别是里面画什么白色图形。
                坐标系原点在**扩展后**的左上角（即区域盒左上角减 pad），
                与被遮罩的预览层 inset:-pad 完全对齐。 */}
            {pad > 0 && (
              <svg className="fw-mso-svg"
                   width={W + 2 * pad} height={H + 2 * pad}>
                <defs>
                  <filter id={`${featherId}-blur`}
                          x="-50%" y="-50%" width="200%" height="200%">
                    {/* 与导出同一个 σ（featherSigma），预览宽度才与成片一致 */}
                    <feGaussianBlur stdDeviation={sigma.toFixed(2)} />
                  </filter>
                  <mask id={featherId} maskUnits="userSpaceOnUse"
                        x={0} y={0} width={W + 2 * pad} height={H + 2 * pad}>
                    <g filter={`url(#${featherId}-blur)`}>
                      {shape === "ellipse" ? (
                        <ellipse cx={pad + W / 2} cy={pad + H / 2}
                                 rx={W / 2} ry={H / 2} fill="#fff" />
                      ) : shape === "brush" && drawStroke ? (
                        <path
                          d={drawStroke.map((p, i) =>
                            `${i ? "L" : "M"}${(px(p.x) - L + pad).toFixed(1)},`
                            + `${(py(p.y) - T + pad).toFixed(1)}`).join("")}
                          stroke="#fff"
                          strokeWidth={px(r.brushSize ?? 0.1)}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      ) : (
                        <rect x={pad} y={pad} width={W} height={H} fill="#fff" />
                      )}
                    </g>
                  </mask>
                </defs>
              </svg>
            )}

            {/* 未选中时给个虚线轮廓，让用户知道这儿有东西 */}
            {!sel && <div className={`fw-mso-outline${shape === "ellipse" ? " ellipse" : ""}`} />}

            {sel && active && <>
              {(["nw","n","ne","e","se","s","sw","w"] as HandleId[]).map((h) => (
                <div key={h}
                  className={`fw-mso-handle fw-mso-h-${h}`}
                  style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
                  onPointerDown={(e) => onHandleDown(e, idx, h)}
                />
              ))}
              <button className="fw-mso-del"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  save(mosaics.filter((_, i) => i !== idx));
                  setSelIdx(null); setPopover(false);
                }}>
                <X size={10} />
              </button>
            </>}
          </div>
        );
      })}

      {/* ---- 绘制中的预览 ---- */}
      {drawBox && drawBox.w > 0.004 && (
        <div
          className={`fw-mso-drawing${tool === "ellipse" ? " ellipse" : ""}`}
          style={{ left: px(drawBox.x), top: py(drawBox.y), width: px(drawBox.w), height: py(drawBox.h) }}
        />
      )}

      {/* 画笔笔迹实时预览 */}
      {paintPts.length > 1 && (
        <svg className="fw-mso-paint-live" width={vrect.width} height={vrect.height}>
          <path d={strokePath(paintPts)}
            stroke="oklch(100% 0 0 / 0.55)"
            strokeWidth={px(brushSize)}
            strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      )}

      {/* ---- 工具栏 ---- */}
      {active && (
        <div className="fw-mso-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <div className="fw-mso-tools">
            {([["rect", Square, "矩形"], ["ellipse", Circle, "圆形"], ["brush", Brush, "画笔"]] as const)
              .map(([id, Icon, label]) => (
                <button key={id}
                  className={`fw-mso-tool${tool === id ? " on" : ""}`}
                  title={`${label}（快捷键 ${id === "rect" ? 1 : id === "ellipse" ? 2 : 3}）`}
                  onClick={() => setTool(id)}>
                  <Icon size={13} />
                </button>
              ))}
          </div>

          <div className="fw-mso-sep" />

          <div className="fw-mso-styles">
            {(["pixel", "gaussblur", "blackbox"] as MosaicStyle[]).map((s) => (
              <button key={s}
                className={`fw-mso-style${(selIdx !== null ? mosaics[selIdx]?.style : style) === s ? " on" : ""}`}
                onClick={() => patchSel({ style: s })}>
                {STYLE_LABEL[s]}
              </button>
            ))}
          </div>

          {tool === "brush" && <>
            <div className="fw-mso-sep" />
            <label className="fw-mso-slider-wrap" title="笔刷大小（画面上滚轮也可调）">
              <Brush size={11} />
              <input type="range" min={2} max={40} value={Math.round(brushSize * 100)}
                onChange={(e) => setBrushSize(Number(e.target.value) / 100)} />
            </label>
          </>}
        </div>
      )}

      {/* ---- 选中区域的设置气泡（新建后自动弹出）---- */}
      {active && popover && selIdx !== null && mosaics[selIdx] && (() => {
        const r = mosaics[selIdx];
        // 气泡跟着**画面上的**框走，动画区域随播放头移动，否则气泡会停在静态框那儿
        const pb = regionBoxAt(r, tSec);
        const L = px(pb.x), T = py(pb.y), W = px(pb.w);
        // 气泡放区域下方；贴近画面底部时翻到上方
        const below = T + py(pb.h) + 92 < vrect.height;
        return (
          <div className="fw-mso-popover"
            style={{
              left: clamp(L + W / 2 - 108, 4, Math.max(4, vrect.width - 220)),
              top: below ? T + py(pb.h) + 10 : Math.max(4, T - 88),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="fw-mso-pop-row">
              {(["pixel", "gaussblur", "blackbox"] as MosaicStyle[]).map((s) => (
                <button key={s}
                  className={`fw-mso-style${r.style === s ? " on" : ""}`}
                  onClick={() => patchSel({ style: s })}>
                  {STYLE_LABEL[s]}
                </button>
              ))}
              <button className="fw-mso-pop-close" onClick={() => setPopover(false)}>
                <X size={11} />
              </button>
            </div>
            {r.style !== "blackbox" && (
              <div className="fw-mso-pop-row">
                <span className="fw-mso-pop-label">强度</span>
                <input type="range" min={10} max={100} step={5} value={r.intensity}
                  onChange={(e) => patchSel({ intensity: Number(e.target.value) }, true)}
                  onPointerUp={commitStaged}
                  onPointerCancel={commitStaged}
                  // 键盘调节（←→）没有 pointer 事件，靠 keyup / blur 收尾
                  onKeyUp={commitStaged}
                  onBlur={commitStaged} />
                <span className="fw-mso-pop-val">{r.intensity}</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* 空态提示。key 绑 tool：切换工具时重挂元素，淡出动画重新播一遍 */}
      {active && mosaics.length === 0 && !drawBox && paintPts.length === 0 && (
        <div className="fw-mso-hint" key={tool}>
          {tool === "brush" ? "按住鼠标涂抹（滚轮调笔刷）" : `拖拽画出${tool === "ellipse" ? "圆形" : "矩形"}遮挡`}
        </div>
      )}
    </div>
  );
}
