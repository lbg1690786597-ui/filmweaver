/**
 * Player — 中央播放器（PLAN §13）
 *
 * Phase 1：把 App.tsx 里内联的 <video> + 播控条抽成独立组件，播放逻辑
 * （usePlayer hook）保持不动。前一帧/后一帧/循环/清晰度等专业播控按 PLAN
 * 已在工具条上留位，逐帧步进需要知道 fps——Phase 2 接入 Timeline 后再实装。
 */

import { RefObject, useEffect, useRef, useState } from "react";
import {
  SkipBack, Play, Pause, Rewind, Crosshair, Maximize2, Repeat,
  Scissors, Blend,
} from "lucide-react";
import { fmtSec } from "../../types/timeline";
import "./Player.css";
import type { TransformMeta, SubtitleClipInfo } from "../../api";
import { transformToFilter, transformToTransform, vignetteOverlay,
         unpreviewableEffects } from "../../render/previewCss";
import { useGradePreview } from "../../hooks/useGradePreview";
import { styleToCss } from "../../lib/subtitleStyle";
import type { SubtitleStyleLike } from "../../lib/subtitleStyle";
import CropZoomOverlay from "./CropZoomOverlay";
import MosaicOverlay from "./MosaicOverlay";
import "./CropZoomOverlay.css";
import "./MosaicOverlay.css";

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
  /** 当前镜头的调色/变换参数，用于实时预览（CSS 近似） */
  transform?: TransformMeta | null;

  /** 字幕轨。按播放头时间取当前 cue 叠在画面上（所见即所得）。 */
  subtitles?: SubtitleClipInfo[];
  /** 项目级默认字幕样式。单条 clip 的 style 优先，为空时继承这里。 */
  subtitleStyle?: SubtitleStyleLike | null;

  // ---- V2.3 画布交互覆盖层 ----
  /** 当前激活的覆盖层模式：null=不激活, "cropzoom"=取景框, "mosaic"=马赛克 */
  overlayMode?: "cropzoom" | "mosaic" | null;
  onSetOverlayMode?: (mode: "cropzoom" | "mosaic" | null) => void;
  onPatchTransform?: (tm: TransformMeta | Record<string, never>) => void;
}

/** 画面在播放器里的实际矩形（letterbox 之外的那块）。
 *  .fw-pl-video 是 width/height:auto + max-*:100%，元素盒**就是**画面盒，
 *  所以直接读 offsetLeft/Top/Width/Height 即可，不用自己按宽高比反算。 */
interface VideoRect { left: number; top: number; width: number; height: number }

export default function Player(p: PlayerProps) {
  const { canvasRef, gpuActive } = useGradePreview(p.videoRef, p.transform);

  const filter = gpuActive ? "" : transformToFilter(p.transform);
  const transform = transformToTransform(p.transform);
  const vignette = gpuActive ? "" : vignetteOverlay(p.transform);
  const unpreviewable = unpreviewableEffects(p.transform, gpuActive);

  const speed = Math.max(0.25, Math.min(4, p.transform?.speed ?? 1));
  useEffect(() => {
    const v = p.videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed, p.previewUrl, p.videoRef]);

  const boxRef = useRef<HTMLDivElement>(null);
  const [vrect, setVrect] = useState<VideoRect | null>(null);
  useEffect(() => {
    const v = p.videoRef.current;
    if (!v || !p.previewUrl) { setVrect(null); return; }
    const measure = () => setVrect({
      left: v.offsetLeft, top: v.offsetTop,
      width: v.offsetWidth, height: v.offsetHeight,
    });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(v);
    if (boxRef.current) ro.observe(boxRef.current);
    v.addEventListener("loadedmetadata", measure);
    return () => { ro.disconnect(); v.removeEventListener("loadedmetadata", measure); };
  }, [p.previewUrl, p.videoRef]);

  const order = p.previewShot?.order;
  const t = p.playhead && p.playhead.order === order ? p.playhead.offsetSec : null;
  const cue = (t === null || order === undefined) ? null
    : (p.subtitles ?? []).find(
        (c) => c.start_shot_order === order
            && t >= c.start_offset_sec
            && t < c.start_offset_sec + (c.duration || 0));
  const ovr = cue?.style && Object.keys(cue.style).length
    ? (cue.style as SubtitleStyleLike) : null;
  const cueStyle = ovr ?? p.subtitleStyle ?? null;

  const overlayMode = p.overlayMode ?? null;

  return (
    <>
      <div className="fw-pl-stage">
        {p.previewUrl ? (
          <div className="fw-pl-box" ref={boxRef}>
            <video key={p.previewUrl} src={p.previewUrl} controls autoPlay
              className={`fw-pl-video${gpuActive ? " gpu" : ""}`}
              style={{
                filter: filter || undefined,
                transform: transform || undefined,
              }}
              ref={p.videoRef}
              onLoadedMetadata={p.onLoadedMetadata}
              onTimeUpdate={p.onTimeUpdate}
              onEnded={p.onEnded} />
            {/* WebGL 输出层。<video> 不能移除 —— 它仍是解码源、音频源和播控 UI，
                只是画面部分被 canvas 盖住（.gpu 让 video 的像素透明但保留控件）。
                canvas 用 pointer-events:none，点击穿透到下面的原生播控条。 */}
            {gpuActive && (
              <canvas ref={canvasRef} className="fw-pl-canvas"
                style={{ transform: transform || undefined }} />
            )}
            {/* 暗角没法用 filter 表达，叠一层渐变（GPU 路径已在 shader 里做了）。
                pointer-events:none 保证不挡住 <video> 自带的播控条 */}
            {vignette && (
              <div className="fw-pl-vignette" style={{ background: vignette }} />
            )}
            {/* 字幕层 */}
            {cue && vrect && (
              <div className="fw-pl-subtitle"
                style={{
                  left: vrect.left, top: vrect.top,
                  width: vrect.width, height: vrect.height,
                }}>
                <div style={styleToCss(cueStyle, vrect.height)}>{cue.text}</div>
              </div>
            )}

            {/* V2.3 取景框覆盖层（选中镜头且激活 cropzoom 模式时显示） */}
            {overlayMode === "cropzoom" && vrect && p.onPatchTransform && (
              <div style={{ position: "absolute", left: vrect.left, top: vrect.top }}>
                <CropZoomOverlay
                  vrect={vrect}
                  transform={p.transform ?? null}
                  onPatchTransform={p.onPatchTransform}
                />
              </div>
            )}

            {/* V2.3 马赛克覆盖层（激活 mosaic 模式或已有马赛克区域时显示） */}
            {vrect && p.onPatchTransform && (
              <div style={{ position: "absolute", left: vrect.left, top: vrect.top }}>
                <MosaicOverlay
                  vrect={vrect}
                  transform={p.transform ?? null}
                  onPatchTransform={p.onPatchTransform}
                  active={overlayMode === "mosaic"}
                />
              </div>
            )}

            {/* 预览体现不出来的效果要明说 */}
            {unpreviewable.length > 0 && (
              <div className="fw-pl-approx" title="这些效果需要导出后才能看到实际结果">
                {unpreviewable.join(" / ")} 仅渲染时生效
              </div>
            )}
            {!gpuActive && (filter || vignette) && (
              <div className="fw-pl-approx alt"
                title="当前设备不支持 WebGL2，预览用 CSS 近似，最终以导出成片为准">
                预览为近似效果
              </div>
            )}
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

        {/* V2.3 画布工具按钮 */}
        {p.onPatchTransform && p.previewShot && <>
          <button
            className={`fw-pl-btn${overlayMode === "cropzoom" ? " active" : ""}`}
            title="取景框：在画面上直接拖拽裁切/平移/缩放"
            onClick={() => p.onSetOverlayMode?.(overlayMode === "cropzoom" ? null : "cropzoom")}>
            <Scissors size={14} />
          </button>
          <button
            className={`fw-pl-btn${overlayMode === "mosaic" ? " active" : ""}`}
            title="马赛克：在画面上拖拽绘制遮罩区域"
            onClick={() => p.onSetOverlayMode?.(overlayMode === "mosaic" ? null : "mosaic")}>
            <Blend size={14} />
          </button>
        </>}

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

        {speed !== 1 && (
          <span className="fw-pl-meta speed" title="该镜头已变速，预览与导出同步">
            {speed}× 变速
          </span>
        )}

        <button className="fw-pl-btn" title="最大化播放器" onClick={p.onToggleMaximize}>
          <Maximize2 size={14} />
        </button>
      </div>
    </>
  );
}

export { fmtSec };
