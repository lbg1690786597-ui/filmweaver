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
 */

import { useRef, useState, useCallback, useEffect } from "react";
import { X, Square, Circle, Brush } from "lucide-react";
import type { TransformMeta } from "../../api";
import "./MosaicOverlay.css";

type Style = "pixel" | "gaussblur" | "blackbox";
type Shape = "rect" | "ellipse" | "brush";

interface MosaicRegion {
  x: number; y: number; w: number; h: number;
  style: Style;
  intensity: number;
  shape?: Shape;
  stroke?: { x: number; y: number }[];
  brushSize?: number;
}

interface Props {
  vrect: { left: number; top: number; width: number; height: number };
  transform: TransformMeta | null;
  onPatchTransform: (tm: TransformMeta | Record<string, never>) => void;
  active: boolean;
}

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type DragState =
  | { kind: "draw"; startX: number; startY: number }
  | { kind: "paint" }
  | { kind: "move"; startX: number; startY: number; idx: number; orig: MosaicRegion }
  | { kind: "resize"; startX: number; startY: number; idx: number; orig: MosaicRegion; handle: HandleId }
  | null;

const HANDLE_SIZE = 9;
const MIN_SIZE = 0.02;

const STYLE_LABEL: Record<Style, string> = {
  pixel: "马赛克", gaussblur: "模糊", blackbox: "遮挡",
};

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** 由笔迹点集算出包围盒（含笔刷半径外扩） */
function strokeBounds(stroke: { x: number; y: number }[], brushSize: number, aspect: number) {
  const r = brushSize / 2;
  const ry = r * aspect;   // Y 方向半径按宽高比换算，保证笔刷是圆的
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of stroke) {
    x0 = Math.min(x0, p.x - r); y0 = Math.min(y0, p.y - ry);
    x1 = Math.max(x1, p.x + r); y1 = Math.max(y1, p.y + ry);
  }
  x0 = clamp(x0, 0, 1); y0 = clamp(y0, 0, 1);
  x1 = clamp(x1, 0, 1); y1 = clamp(y1, 0, 1);
  return { x: x0, y: y0, w: Math.max(x1 - x0, MIN_SIZE), h: Math.max(y1 - y0, MIN_SIZE) };
}

export default function MosaicOverlay({ vrect, transform, onPatchTransform, active }: Props) {
  const tm = transform ?? {};
  const mosaics: MosaicRegion[] = (tm.mosaics as MosaicRegion[] | undefined) ?? [];

  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>(null);

  const [tool, setTool] = useState<Shape>("rect");
  const [style, setStyle] = useState<Style>("pixel");
  const [intensity, setIntensity] = useState(60);
  const [brushSize, setBrushSize] = useState(0.10);

  const [drawBox, setDrawBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [paintPts, setPaintPts] = useState<{ x: number; y: number }[]>([]);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  /** 新建后自动展开设置气泡 */
  const [popover, setPopover] = useState(false);

  const aspect = vrect.width / Math.max(vrect.height, 1);

  const save = useCallback((next: MosaicRegion[]) => {
    onPatchTransform({ ...tm, mosaics: next } as TransformMeta);
  }, [tm, onPatchTransform]);

  /** 屏幕坐标 → 画面比例坐标 */
  const toRatio = useCallback((clientX: number, clientY: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    return {
      x: clamp((clientX - r.left) / vrect.width, 0, 1),
      y: clamp((clientY - r.top) / vrect.height, 0, 1),
    };
  }, [vrect]);

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
      const o = d.orig;
      const moved: MosaicRegion = {
        ...o,
        x: clamp(o.x + dx, 0, 1 - o.w),
        y: clamp(o.y + dy, 0, 1 - o.h),
        // 笔迹要跟着整体平移
        stroke: o.stroke?.map((s) => ({ x: s.x + dx, y: s.y + dy })),
      };
      save(mosaics.map((m, i) => (i === d.idx ? moved : m)));
      return;
    }

    if (d.kind === "resize") {
      const dx = p.x - d.startX, dy = p.y - d.startY;
      const o = d.orig;
      let { x, y, w, h } = o;
      if (d.handle.includes("n")) { y = clamp(o.y + dy, 0, o.y + o.h - MIN_SIZE); h = o.h - (y - o.y); }
      if (d.handle.includes("s")) { h = clamp(o.h + dy, MIN_SIZE, 1 - o.y); }
      if (d.handle.includes("w")) { x = clamp(o.x + dx, 0, o.x + o.w - MIN_SIZE); w = o.w - (x - o.x); }
      if (d.handle.includes("e")) { w = clamp(o.w + dx, MIN_SIZE, 1 - o.x); }
      // 笔迹按包围盒等比缩放，保持形状
      const sx = w / Math.max(o.w, 1e-6), sy = h / Math.max(o.h, 1e-6);
      const stroke = o.stroke?.map((s) => ({
        x: x + (s.x - o.x) * sx,
        y: y + (s.y - o.y) * sy,
      }));
      save(mosaics.map((m, i) => (i === d.idx ? { ...o, x, y, w, h, stroke } : m)));
    }
  }, [toRatio, tool, aspect, brushSize, mosaics, save]);

  const onCanvasUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;

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
  }, [drawBox, paintPts, style, intensity, tool, brushSize, aspect, mosaics, save]);

  // ---- 选中区域上按下：移动 ----
  function onRegionDown(e: React.PointerEvent, idx: number) {
    if (!active) return;
    e.stopPropagation();
    const p = toRatio(e.clientX, e.clientY);
    dragRef.current = { kind: "move", startX: p.x, startY: p.y, idx, orig: { ...mosaics[idx] } };
    setSelIdx(idx);
    setPopover(true);
    boxRef.current!.setPointerCapture(e.pointerId);
  }

  function onHandleDown(e: React.PointerEvent, idx: number, handle: HandleId) {
    e.stopPropagation();
    const p = toRatio(e.clientX, e.clientY);
    dragRef.current = { kind: "resize", startX: p.x, startY: p.y, idx, orig: { ...mosaics[idx] }, handle };
    setSelIdx(idx);
    boxRef.current!.setPointerCapture(e.pointerId);
  }

  /** 改当前选中区域的样式/强度；没选中就只改"下次新建"的默认值 */
  function patchSel(patch: Partial<MosaicRegion>) {
    if (patch.style !== undefined) setStyle(patch.style);
    if (patch.intensity !== undefined) setIntensity(patch.intensity);
    if (selIdx === null) return;
    save(mosaics.map((m, i) => (i === selIdx ? { ...m, ...patch } : m)));
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
  }, [active, selIdx, mosaics, save]);

  // ---- 滚轮调笔刷大小 ----
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!active || tool !== "brush") return;
    e.preventDefault();
    setBrushSize((s) => clamp(s + (e.deltaY < 0 ? 0.01 : -0.01), 0.02, 0.4));
  }, [active, tool]);

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
      onWheel={onWheel}
    >
      {/* ---- 已有区域 ---- */}
      {mosaics.map((r, idx) => {
        const sel = selIdx === idx;
        const shape = r.shape ?? "rect";
        const L = px(r.x), T = py(r.y), W = px(r.w), H = py(r.h);

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
                // 画笔：用 SVG mask 把预览裁成笔迹形状。
                // ⚠️ 必须用 mask 不能用 clipPath —— clipPath 只取路径的**填充**区域，
                // 完全忽略 stroke/strokeWidth；而笔迹是 fill:none 的描边路径，
                // 于是裁剪区退化成路径自身轮廓，自我重叠处还会按 fill-rule 被挖空
                // （用户实测："画笔轨迹重叠处马赛克失效"）。
                // mask 走的是亮度通道，白色描边即可见，重叠只会更白，不会互相抵消。
                ...(shape === "brush" && r.stroke
                  ? { mask: `url(#fw-mso-mask-${idx})`, WebkitMask: `url(#fw-mso-mask-${idx})` }
                  : {}),
              }}
            />

            {/* 画笔形状的裁剪路径 */}
            {shape === "brush" && r.stroke && (
              <svg className="fw-mso-svg" width={W} height={H}>
                <defs>
                  <mask id={`fw-mso-mask-${idx}`} maskUnits="userSpaceOnUse"
                        x={0} y={0} width={W} height={H}>
                    {/* 白 = 保留。描边宽度即笔刷直径，圆头圆角保证笔迹平滑，
                        重叠处仍是白色，不会像 clipPath 那样被挖空。 */}
                    <path
                      d={r.stroke.map((p, i) =>
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
            {(["pixel", "gaussblur", "blackbox"] as Style[]).map((s) => (
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
        const L = px(r.x), T = py(r.y), W = px(r.w);
        // 气泡放区域下方；贴近画面底部时翻到上方
        const below = T + py(r.h) + 92 < vrect.height;
        return (
          <div className="fw-mso-popover"
            style={{
              left: clamp(L + W / 2 - 108, 4, Math.max(4, vrect.width - 220)),
              top: below ? T + py(r.h) + 10 : Math.max(4, T - 88),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="fw-mso-pop-row">
              {(["pixel", "gaussblur", "blackbox"] as Style[]).map((s) => (
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
                  onChange={(e) => patchSel({ intensity: Number(e.target.value) })} />
                <span className="fw-mso-pop-val">{r.intensity}</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* 空态提示。key 绑 tool：切换工具时重挂元素，淡出动画重新播一遍 */}
      {active && mosaics.length === 0 && !drawBox && paintPts.length === 0 && (
        <div className="fw-mso-hint" key={tool}>
          {tool === "brush" ? "按住鼠标涂抹（滚轮调笔刷）" : `拖拽绘制${tool === "ellipse" ? "圆形" : "矩形"}遮罩`}
        </div>
      )}
    </div>
  );
}
