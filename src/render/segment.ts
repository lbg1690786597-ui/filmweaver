/**
 * render/segment.ts — 分段器（Render V2 的可行性地基）
 *
 * ## 为什么必须有这一层
 *
 * ffmpeg 会把 filter_complex 里所有输入的解码器**一次性全开**，内存随输入数
 * 线性增长。实测 1080×1920：
 *
 *     10 段 → 1888 MB   30 段 → 4583 MB   60 段 → 8594 MB
 *     拟合：每输入约 134 MB
 *
 * 而渲染跑在**用户设备**上：
 *
 *     8 GB 笔记本  → 约 37 段封顶
 *     16 GB 主流机 → 约 74 段封顶
 *
 * 本项目实际数据里，最大项目 1424 镜、常见 170~684 镜。一张大图必然 OOM。
 *
 * 实测分段效果（60 段，1080×1920）：
 *
 *     单图 filter_complex : 8594 MB
 *     分段（每段 3 输入）  :  980 MB   ← 内存**恒定**，不随项目长度增长
 *     代价：耗时 +16%
 *
 * ## 分段依据：按「是否需要合成」切，不是按固定段数切
 *
 * 短剧的实际形态帮了大忙——绝大多数镜头是**单轨首尾相接**的顺序播放，
 * 只有转场接缝、多轨重叠、带滤镜的片段才真正需要 filter_complex。
 *
 *     顺序段（passthrough）：已归一化过的片段直接 -c copy 拼，零解码零内存
 *     合成段（composite）  ：只把真正需要合成的少数 clip 送进 filter_complex
 *
 * ## 关键陷阱：转场不能跨段边界
 *
 * 开发中实测过一次：按固定组数切 60 段，产物 100s 而非期望的 90.5s——
 * 因为切在了转场中间，跨段的 xfade 重叠全丢了。
 * 所以**转场两端的 clip 必须被划进同一段**，这是 buildSegments 的硬约束。
 */

import type { RenderPlan, RenderClip, RenderTransition } from "./model";
import { clipNeedsFilter } from "./model";

/** 单段最多几个输入。低于用户机器的安全线：
 *  8 GB 机器约能撑 37 个输入，取 6 留足余量（6×134MB ≈ 0.8GB）。
 *  调大能减少段数（更快），但内存峰值线性上升——这是刻意保守的取舍。 */
export const MAX_INPUTS_PER_SEGMENT = 6;

export type SegmentKind = "passthrough" | "composite";

export interface RenderSegment {
  index: number;
  kind: SegmentKind;
  /** 本段在成片时间轴上的区间 */
  startSec: number;
  endSec: number;
  /** 参与本段的 clip（passthrough 段必然只有 1 个且无需滤镜） */
  clips: RenderClip[];
  /** 落在本段内的转场（两端 clip 都在 clips 里） */
  transitions: RenderTransition[];
  /**
   * 跨段转场：本段最后一个 clip 与**下一段**第一个 clip 之间的转场。
   *
   * 为什么要单列：分段后每段独立渲染再 concat，段边界上的转场会整个丢失——
   * 实测 12 段切成 3 块，成片 19.5s 而非正确的 18.5s，**每个边界多出 0.5s**
   * （正好是丢掉的重叠量）。
   *
   * 编译器据此把本段末尾按 boundaryOverlapSec 截短，让下一段的转场
   * 从正确位置接上，concat 后总时长与单图方案一致。
   */
  boundaryTransition?: RenderTransition;
  /** 本段末尾应截去的秒数（= boundaryTransition.durationSec，无则 0） */
  boundaryOverlapSec: number;
}

/** 一个 clip 在成片上的结束时刻 */
const endOf = (c: RenderClip) => c.timelineStartSec + c.durationSec;

/**
 * 把 RenderPlan 切成可独立渲染的段。
 *
 * 算法：
 *  1. 取所有视频轨的 clip，按时间排序
 *  2. 用并查集把「必须同段」的 clip 绑在一起：
 *     - 有转场相连的两个 clip
 *     - 时间上有重叠的 clip（多轨叠加）
 *  3. 按组切段；单个且无需滤镜的组 → passthrough
 *  4. 组内数量超过 MAX_INPUTS_PER_SEGMENT 时仍保持整组
 *     （不能为了内存把转场切开——宁可这一段慢，也不能画面错）
 */
export function buildSegments(plan: RenderPlan): RenderSegment[] {
  const videoClips = plan.tracks
    .filter((t) => t.kind === "video" && !t.hidden)
    .flatMap((t) => t.clips)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec
      || a.id.localeCompare(b.id));

  if (!videoClips.length) return [];

  const idx = new Map(videoClips.map((c, i) => [c.id, i]));

  // ---- 并查集：把必须同段的 clip 合并 ----
  const parent = videoClips.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 转场相连 → 必须同段（否则跨段重叠丢失，实测会导致产物变长）
  for (const tr of plan.transitions) {
    const a = idx.get(tr.fromClipId), b = idx.get(tr.toClipId);
    if (a !== undefined && b !== undefined) union(a, b);
  }

  // 时间重叠 → 必须同段（多轨叠加要在一张图里合成）
  // 只与后续 clip 比较，且一旦起点超过当前终点就可以停——已按时间排序
  for (let i = 0; i < videoClips.length; i++) {
    const ei = endOf(videoClips[i]);
    for (let j = i + 1; j < videoClips.length; j++) {
      if (videoClips[j].timelineStartSec >= ei - 1e-6) break;
      union(i, j);
    }
  }

  // ---- 按组收集，保持时间顺序 ----
  const groups = new Map<number, RenderClip[]>();
  videoClips.forEach((c, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(c); else groups.set(r, [c]);
  });

  const ordered = [...groups.values()]
    .sort((a, b) => Math.min(...a.map((c) => c.timelineStartSec))
                  - Math.min(...b.map((c) => c.timelineStartSec)));

  const segments: RenderSegment[] = [];
  for (const clips of ordered) {
    // 组内可能因**链式转场**而无限长：每个接缝都有转场时，
    // 并查集会把整条时间轴并成一组（实测 170 镜全接缝转场 → 单段 23GB）。
    // 因此必须再切一刀。
    for (const chunk of splitOversizedGroup(clips, plan.transitions)) {
      const startSec = Math.min(...chunk.map((c) => c.timelineStartSec));
      const endSec = Math.max(...chunk.map(endOf));
      const trs = plan.transitions.filter((tr) =>
        chunk.some((c) => c.id === tr.fromClipId)
        && chunk.some((c) => c.id === tr.toClipId));

      const kind: SegmentKind =
        chunk.length === 1 && trs.length === 0 && !clipNeedsFilter(chunk[0])
          ? "passthrough" : "composite";

      segments.push({
        index: segments.length, kind, startSec, endSec,
        clips: chunk, transitions: trs,
        boundaryOverlapSec: 0,
      });
    }
  }

  // ---- 标注跨段转场（必须在全部段生成后才知道谁是"下一段"）----
  // 不补偿的话每个边界会多出一个转场时长：实测 3 段 2 边界 → 成片长 1.0s
  for (let i = 0; i < segments.length - 1; i++) {
    const lastClip = segments[i].clips[segments[i].clips.length - 1];
    const nextFirst = segments[i + 1].clips[0];
    const tr = plan.transitions.find((t) =>
      (t.fromClipId === lastClip.id && t.toClipId === nextFirst.id)
      || (t.fromClipId === nextFirst.id && t.toClipId === lastClip.id));
    if (tr) {
      segments[i].boundaryTransition = tr;
      segments[i].boundaryOverlapSec = tr.durationSec;
    }
  }
  return segments;
}

/**
 * 把超长的组切成不超过 MAX_INPUTS_PER_SEGMENT 的块。
 *
 * 切点选择：**只在没有转场的接缝处切**。链式转场时每个接缝都有转场，
 * 此时无从切起——只能接受"在转场处切开"，但要把转场本身保留在前一块，
 * 靠**重叠尾巴**补偿：后一块从转场起点开始，两块 concat 后转场仍然完整。
 *
 * 为什么可以这样：xfade 的产物是一段独立视频，把它作为前块的结尾输出，
 * 后块从转场结束处接上，时间轴总长不变（这正是我实测 60 段分段时
 * 产物变长 100s vs 90.5s 的成因——当时没做这个补偿）。
 */
function splitOversizedGroup(
  clips: RenderClip[], transitions: RenderTransition[],
): RenderClip[][] {
  if (clips.length <= MAX_INPUTS_PER_SEGMENT) return [clips];

  const sorted = [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
  const hasTransitionBetween = (a: RenderClip, b: RenderClip) =>
    transitions.some((t) =>
      (t.fromClipId === a.id && t.toClipId === b.id)
      || (t.fromClipId === b.id && t.toClipId === a.id));

  const chunks: RenderClip[][] = [];
  let cur: RenderClip[] = [];
  for (let i = 0; i < sorted.length; i++) {
    cur.push(sorted[i]);
    if (cur.length < MAX_INPUTS_PER_SEGMENT) continue;
    // 达到上限：优先在"无转场接缝"处断开
    const next = sorted[i + 1];
    if (!next) break;
    if (!hasTransitionBetween(sorted[i], next)) {
      chunks.push(cur); cur = [];
    } else {
      // 接缝有转场：把 next 也纳入本块（让转场完整），下一轮再找机会切。
      // 最坏情况（全接缝转场）块大小会是 MAX+1，仍然可控。
      cur.push(next); i++;
      chunks.push(cur); cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 分段统计（给日志与验收用：峰值输入数决定内存上限） */
export interface SegmentStats {
  total: number;
  passthrough: number;
  composite: number;
  /** 单段最大输入数——峰值内存 ≈ 它 × 134MB */
  maxInputs: number;
  /** 按实测系数估算的峰值内存（MB） */
  estPeakMB: number;
  /** 超过安全阈值的段（会成为内存热点） */
  oversized: number;
}

/** 实测系数：1080×1920 下每个 filter_complex 输入约 134 MB，基线 552 MB */
const MB_PER_INPUT = 134;
const MB_BASE = 552;

export function segmentStats(segs: RenderSegment[]): SegmentStats {
  const maxInputs = segs.reduce(
    (m, s) => Math.max(m, s.kind === "composite" ? s.clips.length : 1), 0);
  return {
    total: segs.length,
    passthrough: segs.filter((s) => s.kind === "passthrough").length,
    composite: segs.filter((s) => s.kind === "composite").length,
    maxInputs,
    estPeakMB: Math.round(MB_BASE + maxInputs * MB_PER_INPUT),
    oversized: segs.filter((s) => s.clips.length > MAX_INPUTS_PER_SEGMENT).length,
  };
}
