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
 *  - x / y：画面中心相对画布中心的像素偏移
 */

import { useRef, useState, useCallback } from "react";
import type { TransformMeta } from "../../api";
import "./CropZoomOverlay.css";

interface Props {
  /** 画布矩形（= 导出画面范围），也是 scale=100/x=0/y=0 时视频的位置 */
  vrect: { left: number; top: number; width: number; height: number };
  transform: TransformMeta | null;
  onPatchTransform: (tm: TransformMeta | Record<string, never>) => void;
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

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

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

  // 画面矩形（相对 vrect 左上角）。scale=100 且无偏移时正好等于画布。
  const fw = vrect.width  * (scaleX / 100);
  const fh = vrect.height * (scaleY / 100);
  const fl = (vrect.width  - fw) / 2 + ox;
  const ft = (vrect.height - fh) / 2 + oy;

  // 拖拽期间把最新的 transform 存进 ref。
  // ⚠️ 不能在 onMove 里直接用闭包捕获的 tm ——
  // onMove 是 pointerdown 那一刻创建的，整个拖拽过程中它看到的 tm 永远是
  // 按下时的旧值。父组件每次 patch 后重渲染，新的 tm 进不到这个闭包里，
  // 于是"基于旧 tm 展开 + 新 scale"被反复提交，视觉上就是越拖越飞。
  const tmRef = useRef(tm);
  tmRef.current = tm;

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
        onPatchTransform({ ...base, x: Math.round(o.x + dx), y: Math.round(o.y + dy) } as TransformMeta);
        return;
      }

      // ---- 旋转 ----
      if (d.handle === "rotate") {
        const cx = vrect.left + vrect.width / 2 + o.x;
        const cy = vrect.top + vrect.height / 2 + o.y;
        const a0 = Math.atan2(d.startY - cy, d.startX - cx);
        const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        let deg = o.rotate + (a1 - a0) * 180 / Math.PI;
        // 按住 Shift 吸附到 15° 档
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        onPatchTransform({ ...base, rotate: Math.round(deg * 10) / 10 } as TransformMeta);
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
      const newX = o.x + signX * (finalW - oSX) / 2;
      const newY = o.y + signY * (finalH - oSY) / 2;

      onPatchTransform({
        ...base,
        // 等比时三个字段保持一致，避免下次读取时 scaleX/scaleY 与 scale 打架
        scale: nsx,
        scaleX: nsx,
        scaleY: nsy,
        x: Math.round(newX),
        y: Math.round(newY),
      } as TransformMeta);
    };

    const onUp = () => {
      dragRef.current = null;
      setActiveHandle(null);
      setShowGrid(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // 依赖里不放 tm —— 它已走 tmRef，放进来会让回调在拖拽中被重建
  }, [scale, scaleX, scaleY, ox, oy, rotate, vrect, onPatchTransform]);

  /** 双击画面：还原为铺满画布 */
  const onReset = useCallback(() => {
    onPatchTransform({ ...tm, scale: 100, scaleX: 100, scaleY: 100, x: 0, y: 0, rotate: 0 } as TransformMeta);
  }, [tm, onPatchTransform]);

  const overflowing = scaleX > 100.5 || scaleY > 100.5 || ox !== 0 || oy !== 0 || rotate !== 0;

  return (
    <div className="fw-czo" style={{ width: vrect.width, height: vrect.height }}>
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
    </div>
  );
}
