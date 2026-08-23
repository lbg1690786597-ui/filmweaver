/**
 * features/timeline/snap.ts — 时间轴吸附
 *
 * 成熟剪辑器最影响手感的交互之一：拖 Clip 时自动贴到"有意义的时刻"，
 * 避免留下 3 帧的缝或压掉 2 帧。
 *
 * ## 阈值必须用像素而不是秒
 *
 * 用秒的话缩放后手感完全变样：阈值定 0.2s，在 10px/s 下是 2px（几乎吸不上），
 * 在 200px/s 下是 40px（离老远就被吸走）。用像素则任何缩放下手感一致。
 *
 * ## 为什么不吸附到"所有整秒"
 *
 * 整秒不是有意义的时刻——用户在意的是"和上一段接上""对齐播放头"，
 * 而不是"落在第 7 秒整"。吸附点太密等于没有吸附。
 */

import type { Timeline } from "../../types/timeline";

/** 一个吸附点：位置 + 它是什么（用于 guide 线的 tooltip / 调试） */
export interface SnapPoint {
  sec: number;
  kind: "playhead" | "cursor" | "clip-start" | "clip-end" | "zero";
}

/**
 * 收集当前时间轴上所有可吸附位置。
 *
 * `excludeClipId` 是正在拖的那个 clip——它自己的首尾不能作为吸附点，
 * 否则永远吸在原地动不了。
 */
export function collectSnapPoints(
  timeline: Timeline,
  playheadSec: number,
  cursorSec: number | null,
  excludeClipId?: string,
): SnapPoint[] {
  const pts: SnapPoint[] = [{ sec: 0, kind: "zero" }];
  pts.push({ sec: playheadSec, kind: "playhead" });
  if (cursorSec != null) pts.push({ sec: cursorSec, kind: "cursor" });

  for (const track of timeline.tracks) {
    // 锁定/隐藏的轨道不参与吸附：用户看不到的东西不该影响拖拽落点
    if (track.locked || track.hidden) continue;
    for (const c of track.clips) {
      if (c.id === excludeClipId) continue;
      pts.push({ sec: c.startSec, kind: "clip-start" });
      pts.push({ sec: c.startSec + c.durationSec, kind: "clip-end" });
    }
  }
  return pts;
}

export interface SnapResult {
  /** 吸附后的秒数（未命中时等于输入值） */
  sec: number;
  /** 命中的吸附点；null = 没吸上 */
  hit: SnapPoint | null;
}

/**
 * 把 `sec` 吸附到最近的吸附点。
 *
 * @param thresholdPx 吸附半径（屏幕像素）。8px 约等于半个手指抖动，
 *                    实测比 12px 更少误吸、比 5px 更容易吸上。
 */
export function snapTo(
  sec: number,
  points: SnapPoint[],
  pxPerSec: number,
  thresholdPx = 8,
): SnapResult {
  if (!points.length || pxPerSec <= 0) return { sec, hit: null };

  const thresholdSec = thresholdPx / pxPerSec;
  let best: SnapPoint | null = null;
  let bestDist = Infinity;

  for (const p of points) {
    const d = Math.abs(p.sec - sec);
    if (d < bestDist) { bestDist = d; best = p; }
  }

  if (best && bestDist <= thresholdSec) return { sec: best.sec, hit: best };
  return { sec, hit: null };
}

/**
 * 吸附一个**区间**（拖动整个 clip 时用）：首尾都试，取更近的那个。
 *
 * 只吸首或只吸尾都不够——用户既可能想让它接上前一段的尾，
 * 也可能想让它的尾对齐下一段的头。
 */
export function snapRange(
  startSec: number,
  durationSec: number,
  points: SnapPoint[],
  pxPerSec: number,
  thresholdPx = 8,
): SnapResult {
  const head = snapTo(startSec, points, pxPerSec, thresholdPx);
  const tail = snapTo(startSec + durationSec, points, pxPerSec, thresholdPx);

  const headDist = head.hit ? Math.abs(head.sec - startSec) : Infinity;
  const tailDist = tail.hit ? Math.abs(tail.sec - (startSec + durationSec)) : Infinity;

  if (headDist <= tailDist && head.hit) return head;
  // 吸尾时要把结果换算回"起点应该在哪"
  if (tail.hit) return { sec: Math.max(0, tail.sec - durationSec), hit: tail.hit };
  return { sec: startSec, hit: null };
}
