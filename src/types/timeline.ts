/**
 * types/timeline.ts — 前端时间轴数据模型
 *
 * 关键约束（PLAN §5）：后端 Shot 不能直接当时间轴数据结构用。
 * 后端字段一改，UI 就跟着炸；且 Shot 只有 order 没有绝对时间坐标，
 * 时间轴要的是"第几秒到第几秒"。所以这里定义独立模型，
 * 由 adapters/shotToClip.ts 做单向转换（后端 → 前端）。
 *
 * 反向（前端编辑 → 后端）不走这层，直接调对应 Service 的 patch 方法。
 */

export type TrackKind =
  | "video"        // 主视频轨（AI 镜头 + 外部素材，当前唯一真源）
  | "overlay"      // 叠加层（Phase 3 预留）
  | "subtitle"     // 字幕（Phase 3）
  | "voice"        // 旁白/TTS
  | "audio"        // 音效（Phase 3 预留）
  | "music"        // 配乐（Phase 3 预留）
  | "asset-char"   // 人物资产轨（Phase 5）
  | "asset-loc"    // 场景资产轨（Phase 5）
  | "asset-ref";   // 参考资产轨（Phase 5）

export type ClipStatus = "pending" | "generating" | "done" | "failed";

/** 提示词来源状态（对应后端 Shot.prompt_state） */
export type PromptState = "draft" | "aligned" | "sent" | "manual";

export interface Clip {
  id: string;
  trackId: string;
  /** 绝对起始秒（由 adapter 累加前序镜头时长得出） */
  startSec: number;
  durationSec: number;

  // ---- 关联后端数据 ----
  shotId?: string;         // 对应 Shot.id
  shotOrder?: number;      // 对应 Shot.order（拖动换位时回写用）
  episode?: number;
  mediaUrl?: string;       // 当前采用版本的视频
  thumbUrl?: string;
  label: string;           // 展示名（AI 镜头 = #order，外部素材 = special_name）

  // ---- 状态 ----
  disabled: boolean;       // 保留在轨但不参与导出
  isSpecial: boolean;      // 外部素材（可删；AI 镜头只能停用）
  status: ClipStatus;

  // ---- AI 信息（Inspector 用）----
  currentVersion?: number;
  modelId?: string;
  promptState?: PromptState;
  refsStale: boolean;      // 参考图变过、尚未重新生成
  firstFrameUrl?: string;
  scriptRef?: string;      // 剧本原文片段
  characters: string[];    // effective 注入角色
  location?: string;       // effective 注入场景
}

export interface AssetSegment {
  id: string;
  trackId: string;
  startSec: number;
  durationSec: number;

  assetId: string;
  assetName: string;
  assetKind: "character" | "location" | "custom";
  imageUrl?: string;
  /** 服装/造型阶段名（面向用户的自然语言，不暴露 stage_id） */
  stageName?: string;
  stageId?: string;
  /** 受影响的镜头 order 列表（Inspector 里用自然语言展示） */
  affectedShotOrders: number[];
  locked: boolean;
}

export interface Track {
  id: string;
  kind: TrackKind;
  label: string;
  locked: boolean;
  hidden: boolean;
  muted: boolean;          // 仅音频轨有意义
  solo: boolean;
  height: number;          // px
  collapsed: boolean;
  clips: Clip[];
  assetSegments: AssetSegment[];  // 仅 asset-* 轨使用
}

export interface Timeline {
  tracks: Track[];
  totalDurationSec: number;
}

export interface Selection {
  clipIds: string[];
  assetSegmentIds: string[];
}

/** 时间轴缩放边界（px per second） */
export const ZOOM_MIN = 4;      // 全局俯瞰：几百镜一屏看完
export const ZOOM_MAX = 60;     // 精修：单镜可辨识
export const ZOOM_DEFAULT = 12;

/** 秒 → mm:ss */
export function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 秒 → mm:ss.f（时间轴刻度用） */
export function fmtSecPrecise(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
