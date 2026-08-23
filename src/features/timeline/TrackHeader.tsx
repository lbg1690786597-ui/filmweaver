/**
 * TrackHeader — 轨道头（PLAN §8：Track Lock / Hide / Mute / Solo）
 *
 * sticky 固定在左侧，横向滚动时不动——否则滚到片尾就不知道哪条轨是哪条了。
 * 按钮只在 hover 或已激活时显示，避免十几条轨的轨头变成按钮墙。
 */

import { Lock, Unlock, Eye, EyeOff, Volume2, VolumeX, Headphones, ChevronDown, ChevronRight } from "lucide-react";
import type { Track } from "../../types/timeline";
import "./TrackHeader.css";

const KIND_COLOR: Record<string, string> = {
  "asset-char": "var(--c-asset-char)",
  "asset-loc": "var(--c-asset-loc)",
  "asset-ref": "var(--c-asset-ref)",
  video: "var(--c-accent)",
  overlay: "var(--c-warning)",
  subtitle: "var(--c-info)",
  voice: "var(--c-success)",
  audio: "var(--c-success)",
  music: "var(--c-success)",
};

/** 音频类轨才显示 mute/solo；资产轨没有"静音"的概念 */
const isAudioKind = (k: Track["kind"]) => k === "voice" || k === "audio" || k === "music";

interface Props {
  track: Track;
  width: number;
  itemCount: number;
  onToggleLock: () => void;
  onToggleHidden: () => void;
  onToggleMuted: () => void;
  onToggleSolo: () => void;
  onToggleCollapsed: () => void;
}

export default function TrackHeader(p: Props) {
  const t = p.track;
  return (
    <div className={`fw-th ${t.hidden ? "hidden" : ""} ${t.collapsed ? "collapsed" : ""}`}
      style={{ width: p.width, height: t.collapsed ? 18 : t.height }}>
      <span className="fw-th-color" style={{ background: KIND_COLOR[t.kind] ?? "var(--c-border)" }} />

      <button className="fw-th-caret" onClick={p.onToggleCollapsed}
        title={t.collapsed ? "展开轨道" : "折叠轨道"}>
        {t.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
      </button>

      <span className="fw-th-label" title={`${t.label} · ${p.itemCount} 项`}>
        {t.label}
      </span>

      {!t.collapsed && (
        <span className="fw-th-btns">
          <button className={`fw-th-btn ${t.locked ? "on" : ""}`} onClick={p.onToggleLock}
            title={t.locked ? "解锁轨道" : "锁定轨道（禁止编辑）"}>
            {t.locked ? <Lock size={11} /> : <Unlock size={11} />}
          </button>
          <button className={`fw-th-btn ${t.hidden ? "on" : ""}`} onClick={p.onToggleHidden}
            title={t.hidden ? "显示轨道" : "隐藏轨道（不参与预览）"}>
            {t.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
          {isAudioKind(t.kind) && (
            <>
              <button className={`fw-th-btn ${t.muted ? "on danger" : ""}`} onClick={p.onToggleMuted}
                title={t.muted ? "取消静音" : "静音本轨"}>
                {t.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
              </button>
              <button className={`fw-th-btn ${t.solo ? "on accent" : ""}`} onClick={p.onToggleSolo}
                title="独奏（只听本轨）">
                <Headphones size={11} />
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}
