/**
 * DesubOverlay — 在预览窗口上标注/编辑「烧录字幕」的位置（去字幕功能，第一期）
 *
 * ## 这是在解决什么
 *
 * seedance 等视频模型偶尔会把台词**烧进成片画面**（全库抽样约 5.5%）。
 * 这不是织影自己的软字幕轨（那个随时可关），而是已经进了像素、只能送去第三方
 * 擦掉的污染。本覆盖层负责其中**空间**那一半：框出画面上要擦的那块。
 * **时间**那一半在时间轴的「去字幕」轨道上（同一份数据的另一个视图）。
 *
 * ## 与 MosaicOverlay 的关系
 *
 * 拖拽状态机、8 手柄、resize 四向夹紧、toRatio、staged-write 全部照抄
 * `MosaicOverlay.tsx`，因为它们要的就是同一种手感。三处刻意的差异：
 *
 *   ① 配色走蓝 —— 与马赛克/取景框一眼分得开，且用户点名要「蓝色半透明框」；
 *   ② **不支持关键帧** —— 烧录字幕的位置在一个镜头里是固定的，加关键帧只会
 *      多一个永远用不到的状态，还得在后端提交时想办法把它压回一个静态框；
 *   ③ **只画 `t0 ≤ tSec < t1` 的块** —— 否则播放头走到哪都糊着一堆别的时间段
 *      的框，完全看不出"现在这一刻要擦的是哪块"。
 *
 * ## 新建块的时间语义（用户指名）
 *
 *   t0 = max(0, 当前帧 − 1s)      t1 = 当前片段终点
 *
 * 用户是**看到字幕出现之后**才动手标的，反应加确认约 1s，真实起点必然早于标注帧；
 * 终点取片段末是因为字幕通常持续到切镜头。两头都是刻意的过量覆盖 —— 实测遮罩
 * 盖住无文字区域几乎无损（1.20x 基线 MAE、可察像素 0.012%），用这点代价换"不漏擦"
 * 是划算的；而 API 按时长计费，所以时间边界才是那个真正要省的旋钮。
 *
 * ## 落库时机
 *
 * 与马赛克同一条规矩：移动/缩放期间每个 pointermove 只 `{staged:true}`（本地即时
 * 生效），松手那一下才真落库。不这么做，拖 3 秒会打出上百组 PATCH + 详情 GET。
 */

import { useRef, useState, useCallback, useEffect } from "react";
import { X } from "lucide-react";
import type { TransformMeta, TransformPatchOpts } from "../../api";
import type { DesubRegion } from "../../types/desub";
import { useCanvasToolStore } from "../../stores/canvasToolStore";
import { MIN_REGION_SIZE } from "../../lib/regionShape";
import { manualDesubSpan } from "../timeline/desubGesture";
import type { Box } from "../../lib/regionShape";
import "./DesubOverlay.css";

interface Props {
  vrect: { left: number; top: number; width: number; height: number };
  transform: TransformMeta | null;
  /** 落库回调。拖动中的中间值传 `{ staged: true }`，松手时不带 opts 再发一次做真落库。 */
  onPatchTransform: (
    tm: TransformMeta | Record<string, never>, opts?: TransformPatchOpts,
  ) => void;
  active: boolean;
  /** 播放头在该镜头内的秒数（**输出时间**，与马赛克关键帧同一基准） */
  tSec: number;
  /** 当前片段的输出总时长；新建块的终点取它（"擦到片段末"） */
  shotDurSec: number;
  onToast: (m: string) => void;
}

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type DragState =
  | { kind: "draw"; startX: number; startY: number }
  | { kind: "move"; startX: number; startY: number; id: string; box: Box }
  | { kind: "resize"; startX: number; startY: number; id: string; box: Box; handle: HandleId }
  | null;

const HANDLE_SIZE = 9;
/** 区域最小边长。与马赛克/导出侧同一个常量，不再各写一份。 */
const MIN_SIZE = MIN_REGION_SIZE;

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** 生成稳定 id。用下标会在排序/合并后漂到别的块上（见 api.ts DesubRegion.id）。 */
function newId() {
  return `ds-${Math.random().toString(36).slice(2, 10)}`;
}

export default function DesubOverlay({
  vrect, transform, onPatchTransform, active, tSec, shotDurSec, onToast,
}: Props) {
  const tm = transform ?? {};
  const regions: DesubRegion[] = tm.desub ?? [];

  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>(null);

  // 选中态放 store，和马赛克同理：面板里的清单与画面上的框是同一个编辑器的两个
  // 视图，面板点一条要能让画面高亮。区别是这里存 **id** 不存下标。
  const selId = useCanvasToolStore((s) => s.desubSel);
  const setSelId = useCanvasToolStore((s) => s.setDesubSel);

  const [drawBox, setDrawBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  /** 拖动中最后一次 stage 出去的值；松手时原样重发做真落库。
   *  ⚠️ 不在松手回调里从 regions 现算：那时 dragRef 已清空，且 React 可能把最后
   *  一次渲染推迟到 pointerup 之后，重算会漏掉最后一格。 */
  const stagedRef = useRef<TransformMeta | Record<string, never> | null>(null);

  const save = useCallback((next: DesubRegion[], staged = false) => {
    const payload = { ...tm, desub: next };
    stagedRef.current = staged ? payload : null;
    onPatchTransform(payload, staged ? { staged: true } : undefined);
  }, [tm, onPatchTransform]);

  /** 松手 / 拖动被打断：把 stage 的值真正落库一次 */
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

  /** 把新框写回某个块。已应用的块不再可改（文件已经擦过了，改框没有意义）。 */
  const commitBox = useCallback((id: string, box: Box) => {
    save(regions.map((r) => (r.id === id ? { ...r, ...box } : r)), true);
  }, [regions, save]);

  /** 当前播放头落在区间内的块 —— 画面上只画这些 */
  const visible = regions.filter((r) => tSec >= r.t0 && tSec < r.t1);

  // ---- 在空白处按下：拉新框 ----
  const onCanvasDown = useCallback((e: React.PointerEvent) => {
    if (!active) return;
    e.preventDefault();
    const p = toRatio(e.clientX, e.clientY);
    setSelId(null);
    boxRef.current!.setPointerCapture(e.pointerId);
    dragRef.current = { kind: "draw", startX: p.x, startY: p.y };
    setDrawBox({ x: p.x, y: p.y, w: 0, h: 0 });
  }, [active, toRatio, setSelId]);

  const onCanvasMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toRatio(e.clientX, e.clientY);

    if (d.kind === "draw") {
      setDrawBox({
        x: Math.min(p.x, d.startX), y: Math.min(p.y, d.startY),
        w: Math.abs(p.x - d.startX), h: Math.abs(p.y - d.startY),
      });
      return;
    }

    if (d.kind === "move") {
      const dx = p.x - d.startX, dy = p.y - d.startY;
      const o = d.box;
      commitBox(d.id, {
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
      commitBox(d.id, { x, y, w, h });
    }
  }, [toRatio, commitBox]);

  const onCanvasUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;

    // 移动 / 缩放：拖动期间只 stage 了，这一下才真正落库
    if (d?.kind === "move" || d?.kind === "resize") commitStaged();

    if (d?.kind === "draw" && drawBox && drawBox.w > MIN_SIZE && drawBox.h > MIN_SIZE) {
      // 时间语义见 `manualDesubSpan`：起点回退 1s（夹在镜头开头），终点 = 片段末。
      const { t0, t1 } = manualDesubSpan(tSec, shotDurSec);
      const r: DesubRegion = { id: newId(), ...drawBox, t0, t1, src: "manual" };
      save([...regions, r]);
      setSelId(r.id);
      onToast(`已标记 ${t0.toFixed(1)}s – ${t1.toFixed(1)}s，可在轨道上调整区间`);
    }

    setDrawBox(null);
  }, [drawBox, tSec, shotDurSec, regions, save, setSelId, commitStaged, onToast]);

  // ---- 在已有块上按下：移动 ----
  function onRegionDown(e: React.PointerEvent, r: DesubRegion) {
    if (!active) return;
    e.stopPropagation();
    setSelId(r.id);
    if (r.appliedVersion !== undefined) {
      // 已经擦过的块：文件都换了，再改框只会让 UI 和成片对不上
      onToast("这一段已擦除，如需重做请先删除该标记");
      return;
    }
    const p = toRatio(e.clientX, e.clientY);
    dragRef.current = {
      kind: "move", startX: p.x, startY: p.y, id: r.id,
      box: { x: r.x, y: r.y, w: r.w, h: r.h },
    };
    boxRef.current!.setPointerCapture(e.pointerId);
  }

  function onHandleDown(e: React.PointerEvent, r: DesubRegion, handle: HandleId) {
    e.stopPropagation();
    const p = toRatio(e.clientX, e.clientY);
    dragRef.current = {
      kind: "resize", startX: p.x, startY: p.y, id: r.id,
      box: { x: r.x, y: r.y, w: r.w, h: r.h }, handle,
    };
    setSelId(r.id);
    boxRef.current!.setPointerCapture(e.pointerId);
  }

  const remove = useCallback((id: string) => {
    save(regions.filter((r) => r.id !== id));
    setSelId(null);
  }, [regions, save, setSelId]);

  // ---- 键盘 ----
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selId) remove(selId);
      if (e.key === "Escape") { setSelId(null); setDrawBox(null); dragRef.current = null; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selId, remove, setSelId]);

  if (!active && visible.length === 0) return null;

  const px = (v: number) => v * vrect.width;
  const py = (v: number) => v * vrect.height;

  return (
    <div
      ref={boxRef}
      className={`fw-dso${active ? " active" : ""}`}
      style={{ width: vrect.width, height: vrect.height, cursor: active ? "crosshair" : "default" }}
      onPointerDown={onCanvasDown}
      onPointerMove={onCanvasMove}
      onPointerUp={onCanvasUp}
      // 拖出窗口、被系统手势打断：同样要收尾，否则 dragRef 卡住、
      // 且这次移动/缩放的最终值只剩本地（要等 250ms 兜底计时器才落库）
      onPointerCancel={onCanvasUp}
    >
      {visible.map((r) => {
        const sel = selId === r.id;
        const done = r.appliedVersion !== undefined;
        return (
          <div key={r.id}
            className={`fw-dso-region${sel ? " selected" : ""}${done ? " done" : ""}`}
            style={{ left: px(r.x), top: py(r.y), width: px(r.w), height: py(r.h) }}
            onPointerDown={(e) => onRegionDown(e, r)}
          >
            {/* 标签：模型读到的文字（识别得到的）或"手工标记"。
                字幕框通常很扁，标签挂在框上沿外侧才不会把框里的内容盖住。 */}
            <div className="fw-dso-tag">
              {done ? "✓ 已擦除" : (r.text?.slice(0, 18) || (r.src === "auto" ? "识别结果" : "手工标记"))}
            </div>

            {sel && active && !done && <>
              {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as HandleId[]).map((h) => (
                <div key={h}
                  className={`fw-dso-handle fw-dso-h-${h}`}
                  style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
                  onPointerDown={(e) => onHandleDown(e, r, h)}
                />
              ))}
            </>}

            {sel && active && (
              <button className="fw-dso-del" title="删除这个标记"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); remove(r.id); }}>
                <X size={10} />
              </button>
            )}
          </div>
        );
      })}

      {/* ---- 拉框中的预览 ---- */}
      {drawBox && drawBox.w > 0.004 && (
        <div className="fw-dso-drawing"
          style={{ left: px(drawBox.x), top: py(drawBox.y), width: px(drawBox.w), height: py(drawBox.h) }} />
      )}

      {active && visible.length === 0 && !drawBox && (
        <div className="fw-dso-hint">
          在字幕上拖一个框 —— 时间段自动取「当前帧前 1 秒 → 片段末」，可在轨道上再调
        </div>
      )}
    </div>
  );
}
