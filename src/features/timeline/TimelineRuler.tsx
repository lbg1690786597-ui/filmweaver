/**
 * TimelineRuler — 时间刻度尺（Phase 2）
 *
 * 刻度步长按当前缩放自适应：始终挑一个"标签间距 ≥ 56px"的整齐秒数档位，
 * 否则放大到 60px/s 时每秒一个标签会糊成一片，缩小到 4px/s 时又一个标签都看不见。
 *
 * 交互：单击放置定位线，拖动移动播放头（与专业 NLE 一致——刻度尺是 scrub 区）。
 */

import { useCallback } from "react";
import "./TimelineRuler.css";

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
const MIN_LABEL_GAP = 56;

export function pickTickStep(pxPerSec: number): number {
  return TICK_STEPS.find((s) => s * pxPerSec >= MIN_LABEL_GAP)
    ?? TICK_STEPS[TICK_STEPS.length - 1];
}

function tickLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

interface Props {
  totalSec: number;
  pxPerSec: number;
  /** 轨道头宽度（刻度尺要跟轨道内容左对齐） */
  gutterW: number;
  onScrub: (sec: number) => void;
  onPlaceCursor: (sec: number) => void;
}

export default function TimelineRuler(p: Props) {
  const step = pickTickStep(p.pxPerSec);
  const width = Math.max(200, p.totalSec * p.pxPerSec);
  const count = Math.floor(p.totalSec / step) + 1;
  // 次级刻度：主刻度之间再等分 5 段（步长本身 <2s 时不再细分，否则成毛刺）
  const subDiv = step >= 2 ? 5 : 1;

  const secAt = useCallback((clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / p.pxPerSec);
  }, [p.pxPerSec]);

  /** 按下即 scrub，拖动持续更新（松手结束）——刻度尺的标准行为 */
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    p.onScrub(secAt(e.clientX, el));
    const onMove = (ev: MouseEvent) => p.onScrub(secAt(ev.clientX, el));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="fw-tl-ruler-row">
      <div className="fw-tl-ruler-gutter" style={{ width: p.gutterW }} />
      <div className="fw-tl-ruler" style={{ width }}
        onMouseDown={onMouseDown}
        onDoubleClick={(e) => p.onPlaceCursor(secAt(e.clientX, e.currentTarget))}
        title="单击/拖动移动播放头 · 双击放置定位线">
        {Array.from({ length: count }, (_, i) => {
          const sec = i * step;
          return (
            <div key={i} className="fw-tl-tick" style={{ left: sec * p.pxPerSec }}>
              <span className="fw-tl-tick-label">{tickLabel(sec)}</span>
            </div>
          );
        })}
        {subDiv > 1 && Array.from({ length: count * subDiv }, (_, i) => {
          if (i % subDiv === 0) return null;
          const sec = (i / subDiv) * step;
          if (sec > p.totalSec) return null;
          return (
            <div key={`s${i}`} className="fw-tl-subtick"
              style={{ left: sec * p.pxPerSec }} />
          );
        })}
      </div>
    </div>
  );
}
