/**
 * ClipView — 时间轴上的单个 Clip（Phase 2）
 *
 * 三种交互区：
 *   中间   点击选中 / 按住拖动换位
 *   右边缘 拖拽改时长（吸附整数秒，钳 1-15s，与后端 patch_shot_timeline 一致）
 *   右键   上下文菜单
 *
 * 拖动过程只更新本地状态（父组件的 dragState），松手才 PATCH——
 * 否则拖一次会发几十个请求，而且中途失败会留下半截状态。
 */

import { memo } from "react";
import { AlertTriangle, RefreshCw, EyeOff, Loader2, Film } from "lucide-react";
import type { Clip } from "../../types/timeline";
import { api } from "../../api";
import Waveform from "./Waveform";
import "./ClipView.css";

interface Props {
  clip: Clip;
  /** 分割工具激活：光标变刀形，且不响应拖拽 */
  splitMode?: boolean;
  pxPerSec: number;
  selected: boolean;
  /** 渲染形态：视频轨挂缩略图，音频轨画波形，字幕轨显示文字 */
  variant?: "video" | "audio" | "subtitle";
  /** 所在轨道高度（波形按它画） */
  height?: number;
  /** 拖动预览：非 null 时用它覆盖真实值 */
  previewStartSec?: number;
  previewDurationSec?: number;
  /** 拖动中（半透明 + 不响应 hover） */
  dragging?: boolean;
  /** 作为拖动落点高亮 */
  dropTarget?: boolean;
  trackLocked: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onBeginMove: (e: React.MouseEvent) => void;
  onBeginTrim: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}

function ClipViewInner(p: Props) {
  const { clip: c } = p;
  const start = p.previewStartSec ?? c.startSec;
  const dur = p.previewDurationSec ?? c.durationSec;
  const left = start * p.pxPerSec;
  const width = Math.max(18, dur * p.pxPerSec);
  const height = p.height ?? 64;
  // 窄槽下不渲染文字/角标——40px 宽的槽里塞标签只会变成一团噪点
  const compact = width < 56;

  const cls = [
    "fw-clip",
    `st-${c.status}`,
    p.selected ? "selected" : "",
    c.disabled ? "disabled" : "",
    c.isSpecial ? "special" : "",
    p.dragging ? "dragging" : "",
    p.dropTarget ? "drop-target" : "",
    p.trackLocked ? "locked" : "",
    p.splitMode ? "split-mode" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cls}
      style={{ left, width }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        p.onSelect(e);
        // 分割模式下不启动拖拽——否则点一下既切开又把它拖走了
        if (!p.trackLocked && !p.splitMode) p.onBeginMove(e);
      }}
      onContextMenu={p.onContextMenu}
      onDoubleClick={p.onDoubleClick}
      title={`${c.label}${c.scriptRef ? ` · ${c.scriptRef.slice(0, 40)}` : ""} · ${dur.toFixed(1)}s`}>

      {/* 音频/字幕轨用波形或文字，视频轨用缩略图 —— 音频挂 <img> 没有意义 */}
      {p.variant === "audio" && c.mediaUrl ? (
        <div className="fw-clip-wave">
          <Waveform url={c.mediaUrl} width={width - 2} height={height - 10} />
        </div>
      ) : p.variant === "subtitle" ? (
        <div className="fw-clip-subtext" title={c.label}>{c.label}</div>
      ) : c.thumbUrl ? (
        <img className="fw-clip-thumb" src={api.mediaUrl(c.thumbUrl)}
          alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="fw-clip-thumb ph">
          {c.status === "generating"
            ? <Loader2 size={14} className="fw-spin" />
            : <Film size={14} />}
        </div>
      )}

      {!compact && p.variant !== "subtitle" && (
        <div className="fw-clip-info">
          <span className="fw-clip-label">{c.label}</span>
          <span className="fw-clip-dur">{dur.toFixed(1)}s</span>
        </div>
      )}

      {/* 状态角标 */}
      <div className="fw-clip-badges">
        {c.disabled && <span className="fw-clip-badge dim" title="已停用，不参与导出"><EyeOff size={9} /></span>}
        {c.refsStale && <span className="fw-clip-badge warn" title="参考图已变更，可重新生成"><RefreshCw size={9} /></span>}
        {c.status === "failed" && <span className="fw-clip-badge bad" title="生成失败"><AlertTriangle size={9} /></span>}
      </div>

      {/* 右缘 trim 手柄 */}
      {!p.trackLocked && (
        <div className="fw-clip-trim" title="拖动调整时长（1-15s）"
          onMouseDown={(e) => { e.stopPropagation(); p.onBeginTrim(e); }} />
      )}
    </div>
  );
}

export default memo(ClipViewInner);
