/**
 * Player — 中央播放器（PLAN §13）
 *
 * Phase 1：把 App.tsx 里内联的 <video> + 播控条抽成独立组件，播放逻辑
 * （usePlayer hook）保持不动。前一帧/后一帧/循环/清晰度等专业播控按 PLAN
 * 已在工具条上留位，逐帧步进需要知道 fps——Phase 2 接入 Timeline 后再实装。
 */

import { RefObject } from "react";
import {
  SkipBack, Play, Pause, Rewind, Crosshair, Maximize2, Repeat,
} from "lucide-react";
import { fmtSec } from "../../types/timeline";
import "./Player.css";

export interface PlayerProps {
  videoRef: RefObject<HTMLVideoElement>;
  previewUrl: string | null;
  previewLabel: string;
  previewShot: { id: string; order: number } | null;
  playhead: { order: number; offsetSec: number } | null;
  cursor: { order: number; offsetSec: number } | null;
  autoNext: boolean;
  setAutoNext: (v: boolean) => void;
  baseAspect?: string;

  onLoadedMetadata: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
  onTimeUpdate: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
  onEnded: () => void;

  onPlayFromStart: () => void;
  onPlayFromCursor: () => void;
  onSeekToCursor: () => void;
  onCursorToPlayhead: () => void;
  onToggleMaximize: () => void;

  /** 空态提示信息（可导出段数 / 总时长） */
  emptyHint?: string;
  playing: boolean;
}

export default function Player(p: PlayerProps) {
  return (
    <>
      <div className="fw-pl-stage">
        {p.previewUrl ? (
          <div className="fw-pl-box">
            <video key={p.previewUrl} src={p.previewUrl} controls autoPlay
              className="fw-pl-video"
              ref={p.videoRef}
              onLoadedMetadata={p.onLoadedMetadata}
              onTimeUpdate={p.onTimeUpdate}
              onEnded={p.onEnded} />
          </div>
        ) : (
          <div className="fw-pl-empty">
            <div className="fw-pl-empty-icon">🎬</div>
            <div className="fw-pl-empty-main">
              导入剧本 → AI 分镜 → 生成，点击镜头即可预览
            </div>
            {p.emptyHint && <div className="fw-pl-empty-sub">{p.emptyHint}</div>}
          </div>
        )}
      </div>

      {/* 播控工具条：常驻底端，不被时间轴挤压 */}
      <div className="fw-pl-toolbar">
        <button className="fw-pl-btn" title="从头播放（Shift+Space）"
          onClick={p.onPlayFromStart}>
          <SkipBack size={15} />
        </button>
        <button className="fw-pl-btn primary"
          title="从定位线开始播放；同镜播放中 = 暂停（Space）"
          disabled={!p.cursor} onClick={p.onPlayFromCursor}>
          {p.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="fw-pl-btn" title="播放头跳回定位线但不播放（对比帧用）"
          disabled={!p.cursor} onClick={p.onSeekToCursor}>
          <Rewind size={15} />
        </button>
        <button className="fw-pl-btn" title="把定位线吸到当前播放位置（S）"
          disabled={!p.playhead} onClick={p.onCursorToPlayhead}>
          <Crosshair size={15} />
        </button>

        <div className="fw-pl-time" title="定位线位置（单击时间轴刻度尺放置 / 移动）">
          {p.cursor
            ? `#${p.cursor.order} · ${p.cursor.offsetSec.toFixed(1)}s`
            : "未放置定位线"}
        </div>

        <div className="fw-pl-spacer" />

        {p.previewLabel && (
          <span className="fw-pl-label" title={p.previewLabel}>{p.previewLabel}</span>
        )}

        {p.previewShot && (
          <label className="fw-pl-toggle" title="本镜播完自动切到下一个已生成镜头">
            <input type="checkbox" checked={p.autoNext}
              onChange={(e) => p.setAutoNext(e.target.checked)} />
            <Repeat size={13} /> 连播
          </label>
        )}

        {p.baseAspect && <span className="fw-pl-meta">{p.baseAspect}</span>}

        <button className="fw-pl-btn" title="最大化播放器" onClick={p.onToggleMaximize}>
          <Maximize2 size={14} />
        </button>
      </div>
    </>
  );
}

export { fmtSec };
