/**
 * TimelineRuler — 时间刻度尺（Phase 2）
 *
 * 刻度步长按当前缩放自适应：始终挑一个"标签间距 ≥ 56px"的整齐秒数档位，
 * 否则放大到 60px/s 时每秒一个标签会糊成一片，缩小到 4px/s 时又一个标签都看不见。
 *
 * 交互：单击放置定位线，拖动移动播放头（与专业 NLE 一致——刻度尺是 scrub 区）。
 *
 * ⚠️ 3.4：拖动**不再**每个 mousemove 都调 `onScrub`。跨镜的 scrub 会换掉
 * `previewUrl` → `<video>` 按 `key` 重建 → 重新下载整个素材，拖过 20 个镜头
 * 就是 20 次重建 + 20 个作废的下载。节流策略（每帧最多挪一次线、停稳/松手
 * 才换源）全在 `./scrub.ts` 里，本组件只负责把 down/move/up 三个事件转成
 * `start` / `move` / `end` 三次调用。
 */

import { useCallback } from "react";
import { tickIndexRange } from "./virtual";
import type { SpanRange } from "./virtual";
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
  /** 3.4 拖动播放头的三个阶段。`start`/`move` 廉价（只挪线），
   *  `end` 才允许换预览源。节流由调用方注入的 `Scrubber` 负责。 */
  /** 3.10：可见区间（lane 内像素）。刻度尺与轨道共用同一套坐标，故直接收 span。 */
  span: SpanRange;
  onScrubStart: (sec: number) => void;
  onScrubMove: (sec: number) => void;
  onScrubEnd: () => void;
  onPlaceCursor: (sec: number) => void;
}

export default function TimelineRuler(p: Props) {
  const step = pickTickStep(p.pxPerSec);
  const width = Math.max(200, p.totalSec * p.pxPerSec);
  const count = Math.floor(p.totalSec / step) + 1;
  // 次级刻度：主刻度之间再等分 5 段（步长本身 <2s 时不再细分，否则成毛刺）
  const subDiv = step >= 2 ? 5 : 1;
  // 3.10：只画视口内的刻度。7120 秒的片子在最大缩放下 step=1s → 7121 根主刻度
  // （外加 5 倍的次级刻度），和片段是同一个量级的问题。
  const [t0, t1] = tickIndexRange(p.span, step * p.pxPerSec, count);
  const [s0, s1] = tickIndexRange(
    p.span, (step / subDiv) * p.pxPerSec, count * subDiv);

  const secAt = useCallback((clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / p.pxPerSec);
  }, [p.pxPerSec]);

  /** 按下即 scrub，拖动持续更新（松手结束）——刻度尺的标准行为 */
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    p.onScrubStart(secAt(e.clientX, el));
    const onMove = (ev: MouseEvent) => p.onScrubMove(secAt(ev.clientX, el));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      p.onScrubEnd();
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
        {Array.from({ length: t1 - t0 }, (_, k) => {
          const i = t0 + k;
          const sec = i * step;
          return (
            // key 用刻度**序号**而不是数组下标：虚拟化后下标随滚动而变，
            // 用下标会让 React 在滚动时把每一根刻度都当成"内容变了"重挂一遍。
            <div key={i} className="fw-tl-tick" style={{ left: sec * p.pxPerSec }}>
              <span className="fw-tl-tick-label">{tickLabel(sec)}</span>
            </div>
          );
        })}
        {subDiv > 1 && Array.from({ length: s1 - s0 }, (_, k) => {
          const i = s0 + k;
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
