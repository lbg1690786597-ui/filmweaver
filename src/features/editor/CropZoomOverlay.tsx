/**
 * CropZoomOverlay — 在预览窗口里直接操作**视频画面**（V2.3，对齐剪映）
 *
 * ## 心智模型（这一版修正了上一版的方向性错误）
 *
 * 取景框 = 导出画布，**固定不动**（就是那个 16:9 / 9:16 的白框）。
 * 用户拖动/缩放的是**视频画面本身**：
 *
 *   - 拖画面 → 画面在画布里平移（x / y）
 *   - 拖角点 → 画面等比放大缩小（scale），默认以画面中心为锚点
 *   - 画面可以**放大到超出画布**，超出的部分导出时自然被裁掉 ——
 *     这正是"只显示画面某一部分并让它铺满"的实现方式，
 *     不需要额外的 crop 字段（上一版引入 crop 是多余且反直觉的）。
 *
 * 画布外的区域用暗色蒙版压暗，让用户一眼看出哪些内容会被裁掉。
 *
 * ## 坐标系
 *  - vrect = <video> 元素在播放器里的实际矩形（letterbox 之外那块）
 *    它就是 scale=100%、x=y=0 时画面的位置，也即**画布**本身
 *  - scale：100 = 铺满画布；200 = 放大两倍（溢出画布）
 *  - x / y：画面中心相对画布中心的偏移，单位是**画布宽/高的百分比**
 *    （不是屏幕像素 —— 编辑期不知道导出分辨率，存像素等于把预览窗口大小
 *    腌进数据里，理由见 api.ts 的 TransformMeta.x）
 */

import { useRef, useState, useCallback } from "react";
import { Crop, Move } from "lucide-react";
import type { TransformMeta, TransformPatchOpts } from "../../api";
import { useCanvasToolStore } from "../../stores/canvasToolStore";
import "./CropZoomOverlay.css";

interface Props {
  /** 画布矩形（= 导出画面范围），也是 scale=100/x=0/y=0 时视频的位置 */
  vrect: { left: number; top: number; width: number; height: number };
  transform: TransformMeta | null;
  /** 落库回调。拖动中的中间值传 `{ staged: true }`（本地即时生效、落库延后），
   *  松手时用组件内的 `commitStaged()` 补一次真落库。见 lib/stagedWrite.ts */
  onPatchTransform: (
    tm: TransformMeta | Record<string, never>, opts?: TransformPatchOpts,
  ) => void;
}

/** 角点用于等比缩放；边中点用于单轴拉伸；move 用于平移；rotate 旋转 */
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate" | "move";

interface DragState {
  handle: Handle;
  startX: number;
  startY: number;
  orig: { scale: number; x: number; y: number; rotate: number };
  /** 按下时画面的像素尺寸，用于把拖拽距离换算成 scale 增量 */
  startW: number;
  startH: number;
}

const HANDLE_SIZE = 10;
const MIN_SCALE = 10;
const MAX_SCALE = 800;
/** 裁剪框最小边长（像素），防止拖成一条线 */
const MIN_CROP_PX = 24;

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** x/y 存储量取到 0.01%（1080 宽画布上约 0.1px）。
 *  不取整会让 transform_meta 里堆满 17 位小数，`transformRev` 的内容哈希
 *  于是每一帧都在变，乐观锁会把正常拖拽误判成并发冲突。 */
function pct(v: number): number { return Math.round(v * 100) / 100; }

interface Box { x0: number; y0: number; x1: number; y1: number }

/**
 * 把裁剪框按锁定比例修正。
 *
 * 像素比即成片比 —— vrect 就是源画面按原比例摆出来的矩形，所以
 * 框的**像素宽高比**等于裁出来的画面的宽高比，直接按 r 约束像素即可，
 * 不需要再乘源画面比例（这一步搞错会让 9:16 裁出来是斜的）。
 *
 * 锚点取被拖手柄的对侧：拖右下角时左上角钉死，拖边中点时另一轴居中不动，
 * 与画面缩放手柄的手感保持一致。
 */
function fitRatio(box: Box, handle: Handle, r: number, W: number, H: number): Box {
  let w = box.x1 - box.x0;
  let h = box.y1 - box.y0;
  // 左右边/角点由宽度主导，上下边由高度主导
  const primaryX = handle.includes("e") || handle.includes("w");
  if (primaryX) h = w / r; else w = h * r;

  const fixX = handle.includes("w") ? "x1" : handle.includes("e") ? "x0" : "cx";
  const fixY = handle.includes("n") ? "y1" : handle.includes("s") ? "y0" : "cy";
  const ax = fixX === "x0" ? box.x0 : fixX === "x1" ? box.x1 : (box.x0 + box.x1) / 2;
  const ay = fixY === "y0" ? box.y0 : fixY === "y1" ? box.y1 : (box.y0 + box.y1) / 2;

  // 锚点固定的前提下，框在画面内还能有多大 —— 超了就等比缩回来，
  // 否则锁比例时拖到边缘会把框推出画面
  const maxW = fixX === "x0" ? W - ax : fixX === "x1" ? ax : Math.min(ax, W - ax) * 2;
  const maxH = fixY === "y0" ? H - ay : fixY === "y1" ? ay : Math.min(ay, H - ay) * 2;
  const k = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6));
  w *= k; h *= k;

  const x0 = fixX === "x0" ? ax : fixX === "x1" ? ax - w : ax - w / 2;
  const y0 = fixY === "y0" ? ay : fixY === "y1" ? ay - h : ay - h / 2;
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

export default function CropZoomOverlay({ vrect, transform, onPatchTransform }: Props) {
  const tm = transform ?? {};
  const scale = tm.scale ?? 100;
  // 非等比缩放：缺省跟随 scale（老数据没有这两个字段）
  const scaleX = tm.scaleX ?? scale;
  const scaleY = tm.scaleY ?? scale;
  const ox = tm.x ?? 0;
  const oy = tm.y ?? 0;
  const rotate = tm.rotate ?? 0;

  const dragRef = useRef<DragState | null>(null);
  const [showGrid, setShowGrid] = useState(false);
  const [activeHandle, setActiveHandle] = useState<Handle | null>(null);

  // ---- 裁剪子模式 ----
  // 剪映把「裁剪」和「画面」分成两件事：裁剪决定从素材里取哪一块，
  // 画面决定取出来的那块怎么摆。此前本组件只做了后者，crop 字段完全没有
  // 画面上的操作入口，只能去侧边栏拖四个滑块（而那时滑块还没有预览反馈）。
  const cropTool = useCanvasToolStore((s) => s.cropTool);
  const setCropTool = useCanvasToolStore((s) => s.setCropTool);
  const cropRatio = useCanvasToolStore((s) => s.cropRatio);
  const cropping = cropTool === "frame";

  const crop = tm.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  // 裁剪框在 vrect 像素空间里的位置
  const cx0 = (crop.left || 0) * vrect.width;
  const cy0 = (crop.top || 0) * vrect.height;
  const cx1 = (1 - (crop.right || 0)) * vrect.width;
  const cy1 = (1 - (crop.bottom || 0)) * vrect.height;
  const hasCrop = (crop.left || 0) > 0 || (crop.top || 0) > 0
    || (crop.right || 0) > 0 || (crop.bottom || 0) > 0;

  // 画面矩形（相对 vrect 左上角）。scale=100 且无偏移时正好等于画布。
  const fw = vrect.width  * (scaleX / 100);
  const fh = vrect.height * (scaleY / 100);
  // ox/oy 是画布百分比，画到屏幕上要先换算成 vrect 像素（vrect ≡ 画布）
  const fl = (vrect.width  - fw) / 2 + (ox / 100) * vrect.width;
  const ft = (vrect.height - fh) / 2 + (oy / 100) * vrect.height;

  // 拖拽期间把最新的 transform 存进 ref。
  // ⚠️ 不能在 onMove 里直接用闭包捕获的 tm ——
  // onMove 是 pointerdown 那一刻创建的，整个拖拽过程中它看到的 tm 永远是
  // 按下时的旧值。父组件每次 patch 后重渲染，新的 tm 进不到这个闭包里，
  // 于是"基于旧 tm 展开 + 新 scale"被反复提交，视觉上就是越拖越飞。
  const tmRef = useRef(tm);
  tmRef.current = tm;

  /* ---------------------------------------------------------------- *
   * 落库时机（2.2）
   *
   * 改动前：**每个 pointermove 都发一次 PATCH**，而父组件每次 PATCH 后还要
   * 重拉一遍整个项目详情。拖 3 秒能打出上百组请求，其中任何一个乱序返回
   * 都会让画面跳回中途的值。
   *
   * 现在拖动中走 `stage()` —— 值立刻在本地生效（画面照旧跟手，因为
   * App 会把未落库的值盖回 detail.shots），PATCH 延后；松手时
   * `commitStaged()` 把**最后那个值**真正落库一次。
   *
   * ⚠️ 松手时不从 `tmRef.current` 取值，而是重发 stage 时记下的那份：
   * tmRef 依赖父组件已经重渲染过，而 pointermove 是连续事件、
   * React 有可能把最后一次渲染推迟到 pointerup 之后。差一格就意味着
   * "松手后的值没落库"，那正是本条要修的东西。
   * ---------------------------------------------------------------- */
  const stagedRef = useRef<TransformMeta | Record<string, never> | null>(null);
  const stage = useCallback((next: TransformMeta | Record<string, never>) => {
    stagedRef.current = next;
    onPatchTransform(next, { staged: true });
  }, [onPatchTransform]);
  const commitStaged = useCallback(() => {
    const v = stagedRef.current;
    stagedRef.current = null;
    // 只按了一下没拖动 → 没有待落库的值，不平白多发一笔 PATCH
    if (v) onPatchTransform(v);
  }, [onPatchTransform]);

  const onHandleDown = useCallback((e: React.PointerEvent, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    // 防重入：上一次拖拽还没收尾就再次进来，会用**已被放大的 scale**
    // 建立新快照，于是每一轮都在上一轮结果上再乘一次 —— 指数放大。
    // （实测：每帧 +2px 拖到 20px，正确应到 105%，重入累加会到 125%。）
    if (dragRef.current) return;

    dragRef.current = {
      handle,
      startX: e.clientX, startY: e.clientY,
      orig: { scale, x: ox, y: oy, rotate },
      startW: vrect.width * (scaleX / 100),
      startH: vrect.height * (scaleY / 100),
    };
    setActiveHandle(handle);
    setShowGrid(true);

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      const o = d.orig;          // 按下瞬间的快照，全程不变 —— 这是正确基准
      const base = tmRef.current; // 最新的完整 transform（含其它字段）

      // ---- 平移：直接跟手 ----
      if (d.handle === "move") {
        // 鼠标位移是屏幕像素，存储量是画布百分比 —— 这一除不能省，
        // 省掉就等于"同一个拖动在不同窗口大小下存出不同的数"。
        stage({
          ...base,
          x: pct(o.x + (dx / vrect.width) * 100),
          y: pct(o.y + (dy / vrect.height) * 100),
        } as TransformMeta);
        return;
      }

      // ---- 旋转 ----
      if (d.handle === "rotate") {
        const cx = vrect.left + vrect.width / 2 + (o.x / 100) * vrect.width;
        const cy = vrect.top + vrect.height / 2 + (o.y / 100) * vrect.height;
        const a0 = Math.atan2(d.startY - cy, d.startX - cx);
        const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        let deg = o.rotate + (a1 - a0) * 180 / Math.PI;
        // 按住 Shift 吸附到 15° 档
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        stage({ ...base, rotate: Math.round(deg * 10) / 10 } as TransformMeta);
        return;
      }

      // ---- 缩放 ----
      //
      // 锚点 = 被拖手柄的**对侧**：拖右下角，左上角钉住不动；
      // 拖右边中点，只有右边缘移动，左/上/下三边不动。
      // （中心锚点会让四条边同时向外扩，与用户预期相反。）
      //
      // 实现：先算出新的宽高，再反推 x/y —— 因为画面是按中心定位的
      // （left = (canvasW - w)/2 + x），锚点固定意味着 x 要补偿宽度变化的一半。
      const signX = d.handle.includes("w") ? -1 : d.handle.includes("e") ? 1 : 0;
      const signY = d.handle.includes("n") ? -1 : d.handle.includes("s") ? 1 : 0;

      const oSX = d.startW;   // 按下时画面像素宽
      const oSY = d.startH;   // 按下时画面像素高

      let newW = oSX;
      let newH = oSY;

      if (signX !== 0 && signY !== 0) {
        // 角点：等比。把位移投影到对角线，保证 1px 鼠标 = 1px 角点位移。
        const diag = Math.hypot(oSX, oSY);
        const ux = (signX * oSX) / diag;
        const uy = (signY * oSY) / diag;
        const proj = dx * ux + dy * uy;
        const k = (diag + proj) / diag;      // 对角锚点：不再 ×2
        newW = oSX * k;
        newH = oSY * k;
      } else if (signX !== 0) {
        // 左右边中点：只改宽度，高度不动
        newW = oSX + signX * dx;
      } else {
        // 上下边中点：只改高度
        newH = oSY + signY * dy;
      }

      // 下限保护：不允许翻转或缩到看不见
      const minPx = 16;
      newW = Math.max(minPx, newW);
      newH = Math.max(minPx, newH);

      // ⚠️ 顺序很重要：先把 scale 取整定死，再用**取整后的**宽高反推 x/y。
      // 若先用未取整的宽高算 x/y、再单独取整 scale，两者对不上，
      // 锚定的那条边每次拖动都会漂移约 1px（实测拖 40px 漂 0.8px，会累积）。
      const nsx = clamp(Math.round((newW / vrect.width) * 100), MIN_SCALE, MAX_SCALE);
      const nsy = clamp(Math.round((newH / vrect.height) * 100), MIN_SCALE, MAX_SCALE);
      const finalW = vrect.width * (nsx / 100);
      const finalH = vrect.height * (nsy / 100);

      // 锚点补偿：保持对侧边缘不动。
      // 画面左边 = (canvasW - w)/2 + x，要让左边不动（拖 e/se/ne 时）：
      //   (cw - oldW)/2 + oldX == (cw - newW)/2 + newX  ⇒  newX = oldX + (newW - oldW)/2
      // 拖 w 侧则相反，符号取 signX。signX=0（纯上下拉伸）时 x 不动。
      // 宽高差是屏幕像素，补偿量要换成画布百分比再累加到 o.x 上
      const newX = o.x + (signX * (finalW - oSX) / 2 / vrect.width) * 100;
      const newY = o.y + (signY * (finalH - oSY) / 2 / vrect.height) * 100;

      stage({
        ...base,
        // 等比时三个字段保持一致，避免下次读取时 scaleX/scaleY 与 scale 打架
        scale: nsx,
        scaleX: nsx,
        scaleY: nsy,
        x: pct(newX),
        y: pct(newY),
      } as TransformMeta);
    };

    const onUp = () => {
      dragRef.current = null;
      setActiveHandle(null);
      setShowGrid(false);
      commitStaged();          // 松手：把最后那个值真正落库
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // 依赖里不放 tm —— 它已走 tmRef，放进来会让回调在拖拽中被重建
  }, [scale, scaleX, scaleY, ox, oy, rotate, vrect, stage, commitStaged]);

  /** 双击画面：还原为铺满画布 */
  const onReset = useCallback(() => {
    onPatchTransform({ ...tm, scale: 100, scaleX: 100, scaleY: 100, x: 0, y: 0, rotate: 0 } as TransformMeta);
  }, [tm, onPatchTransform]);

  /**
   * 拖裁剪框。
   *
   * 与画面拖拽共用那三条来之不易的经验：用 tmRef 取最新 transform（闭包里的
   * tm 是按下那一刻的旧值，会越拖越飞）、防重入、先定死像素再换算成比例。
   */
  const onCropDown = useCallback((e: React.PointerEvent, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragRef.current) return;

    const W = vrect.width, H = vrect.height;
    const orig: Box = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };
    // 复用同一把锁，避免裁剪拖拽与画面拖拽同时进行
    dragRef.current = {
      handle, startX: e.clientX, startY: e.clientY,
      orig: { scale, x: ox, y: oy, rotate }, startW: 0, startH: 0,
    };
    setActiveHandle(handle);
    setShowGrid(true);

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - e.clientX;
      const dy = ev.clientY - e.clientY;
      let box: Box = { ...orig };

      if (handle === "move") {
        const w = orig.x1 - orig.x0, h = orig.y1 - orig.y0;
        const nx = clamp(orig.x0 + dx, 0, W - w);
        const ny = clamp(orig.y0 + dy, 0, H - h);
        box = { x0: nx, y0: ny, x1: nx + w, y1: ny + h };
      } else {
        if (handle.includes("w")) box.x0 = clamp(orig.x0 + dx, 0, orig.x1 - MIN_CROP_PX);
        if (handle.includes("e")) box.x1 = clamp(orig.x1 + dx, orig.x0 + MIN_CROP_PX, W);
        if (handle.includes("n")) box.y0 = clamp(orig.y0 + dy, 0, orig.y1 - MIN_CROP_PX);
        if (handle.includes("s")) box.y1 = clamp(orig.y1 + dy, orig.y0 + MIN_CROP_PX, H);
        if (cropRatio) box = fitRatio(box, handle, cropRatio, W, H);
      }

      const r4 = (v: number) => Math.round(v * 10000) / 10000;
      stage({
        ...tmRef.current,
        crop: {
          left:   r4(clamp(box.x0 / W, 0, 1)),
          top:    r4(clamp(box.y0 / H, 0, 1)),
          right:  r4(clamp(1 - box.x1 / W, 0, 1)),
          bottom: r4(clamp(1 - box.y1 / H, 0, 1)),
        },
      } as TransformMeta);
    };

    const onUp = () => {
      dragRef.current = null;
      setActiveHandle(null);
      setShowGrid(false);
      commitStaged();          // 松手：把最后那个裁剪框真正落库
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [cx0, cy0, cx1, cy1, cropRatio, vrect, scale, ox, oy, rotate, stage, commitStaged]);

  /** 双击裁剪框：取消裁剪 */
  const onResetCrop = useCallback(() => {
    onPatchTransform({
      ...tmRef.current,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    } as TransformMeta);
  }, [onPatchTransform]);

  const overflowing = scaleX > 100.5 || scaleY > 100.5 || ox !== 0 || oy !== 0 || rotate !== 0;

  return (
    <div className="fw-czo" style={{ width: vrect.width, height: vrect.height }}>
      {/* 裁剪 / 画面 —— 两件事分开，和剪映一致。
          合在一起时用户分不清自己是在裁素材还是在挪画面。 */}
      <div className="fw-czo-mode-bar">
        <button className={`fw-czo-mode-btn${cropping ? " on" : ""}`}
          title="裁剪：从素材里框出要保留的部分"
          onClick={() => setCropTool("frame")}>
          <Crop size={12} /> 裁剪
        </button>
        <button className={`fw-czo-mode-btn${!cropping ? " on" : ""}`}
          title="画面：调整画面在成片画布上的位置与大小"
          onClick={() => setCropTool("picture")}>
          <Move size={12} /> 画面
        </button>
      </div>

      {cropping ? <>
        {/* 裁剪模式：框外压暗，框内即保留区。
            此时预览层会临时关掉 crop 的裁切与放大（见 Player），
            画面显示的是**原始整幅**，否则框的坐标和看到的画面对不上。 */}
        <div className="fw-czo-crop-dim"
          style={{ left: cx0, top: cy0, width: cx1 - cx0, height: cy1 - cy0 }} />

        {showGrid && <>
          <div className="fw-czo-grid-h" style={{ top: cy0 + (cy1 - cy0) / 3 }} />
          <div className="fw-czo-grid-h" style={{ top: cy0 + (cy1 - cy0) * 2 / 3 }} />
          <div className="fw-czo-grid-v" style={{ left: cx0 + (cx1 - cx0) / 3 }} />
          <div className="fw-czo-grid-v" style={{ left: cx0 + (cx1 - cx0) * 2 / 3 }} />
        </>}

        <div className={`fw-czo-crop-frame${activeHandle ? " dragging" : ""}`}
          style={{ left: cx0, top: cy0, width: cx1 - cx0, height: cy1 - cy0 }}>
          <div className="fw-czo-move"
            onPointerDown={(e) => onCropDown(e, "move")}
            onDoubleClick={onResetCrop}
            title="拖动移动裁剪框 · 双击取消裁剪" />
          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).map((h) => (
            <div key={h}
              className={`fw-czo-handle fw-czo-h-${h}`}
              style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
              onPointerDown={(e) => onCropDown(e, h)} />
          ))}
        </div>

        <div className="fw-czo-badge">
          {hasCrop
            ? `保留 ${Math.round((1 - (crop.left || 0) - (crop.right || 0)) * 100)}%×`
              + `${Math.round((1 - (crop.top || 0) - (crop.bottom || 0)) * 100)}%`
            : "未裁剪"}
          {cropRatio && <span className="fw-czo-badge-hint">比例已锁定</span>}
          <span className="fw-czo-badge-hint">裁剪中：显示原始画面</span>
        </div>
      </> : <>
      {/* 画布边界（导出范围）：始终显示，提示"这里之外的都会被裁掉" */}
      <div className="fw-czo-canvas-edge" />

      {/* 画面溢出画布的部分压暗。用四条挡板围住画布外侧 ——
          画布本身不能被压暗，否则用户看不清最终成片长什么样。 */}
      {overflowing && <div className="fw-czo-outside" />}

      {/* 三分线（拖拽时可见，辅助构图） */}
      {showGrid && <>
        <div className="fw-czo-grid-h" style={{ top: `${100 / 3}%` }} />
        <div className="fw-czo-grid-h" style={{ top: `${200 / 3}%` }} />
        <div className="fw-czo-grid-v" style={{ left: `${100 / 3}%` }} />
        <div className="fw-czo-grid-v" style={{ left: `${200 / 3}%` }} />
      </>}

      {/* ---- 视频画面框：这才是用户操作的对象 ---- */}
      <div
        className={`fw-czo-frame${activeHandle ? " dragging" : ""}`}
        style={{
          left: fl, top: ft, width: fw, height: fh,
          transform: rotate ? `rotate(${rotate}deg)` : undefined,
        }}
      >
        {/* 画面内部任意位置都可拖动平移；双击还原 */}
        <div
          className="fw-czo-move"
          onPointerDown={(e) => onHandleDown(e, "move")}
          onDoubleClick={onReset}
          title="拖动移动画面 · 双击还原"
        />

        {/* 旋转手柄 */}
        <div className="fw-czo-rotate-stem" />
        <div
          className="fw-czo-handle fw-czo-rotate"
          onPointerDown={(e) => onHandleDown(e, "rotate")}
          title="拖动旋转（按住 Shift 吸附 15°）"
        />

        {/* 8 个控制点：角点等比缩放，边中点单轴缩放 */}
        {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).map((h) => (
          <div
            key={h}
            className={`fw-czo-handle fw-czo-h-${h}`}
            style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
            onPointerDown={(e) => onHandleDown(e, h)}
          />
        ))}
      </div>

      {/* 状态角标：把当前数值摆出来，用户不用去侧边栏对照 */}
      <div className="fw-czo-badge">
        {scaleX === scaleY ? `${scaleX}%` : `${scaleX}%×${scaleY}%`}
        {(ox !== 0 || oy !== 0) && ` · ${ox > 0 ? "+" : ""}${ox},${oy > 0 ? "+" : ""}${oy}`}
        {rotate !== 0 && ` · ${rotate}°`}
        {(scaleX > 100.5 || scaleY > 100.5) && <span className="fw-czo-badge-hint">超出画布部分导出时裁掉</span>}
      </div>
      </>}
    </div>
  );
}
