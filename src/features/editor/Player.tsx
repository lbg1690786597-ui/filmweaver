/**
 * Player — 中央播放器（PLAN §13）
 *
 * Phase 1：把 App.tsx 里内联的 <video> + 播控条抽成独立组件，播放逻辑
 * （usePlayer hook）保持不动。前一帧/后一帧/循环/清晰度等专业播控按 PLAN
 * 已在工具条上留位，逐帧步进需要知道 fps——Phase 2 接入 Timeline 后再实装。
 */

import { RefObject, useEffect } from "react";
import {
  SkipBack, Play, Pause, Rewind, Crosshair, Maximize2, Repeat,
} from "lucide-react";
import { fmtSec } from "../../types/timeline";
import "./Player.css";
import type { TransformMeta } from "../../api";
import { transformToFilter, transformToTransform, vignetteOverlay,
         unpreviewableEffects } from "../../render/previewCss";
import { useGradePreview } from "../../hooks/useGradePreview";

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
}

export default function Player(p: PlayerProps) {
  // 调色实时预览。优先 WebGL —— CSS filter **表达不了 LUT**（能力缺失，
  // 不是精度问题），且色温/高光只能靠 sepia 之类硬凑，跟 ffmpeg 差得远。
  // WebGL 这条路的运算逐条对齐 media.py，所见即所得。
  // 拿不到 WebGL2（旧显卡/远程桌面）时自动退回 CSS 近似，不会黑屏。
  const { canvasRef, gpuActive } = useGradePreview(p.videoRef, p.transform);

  // CSS 降级路径：GPU 生效时就不要再叠一层 filter，否则调色被应用两次
  const filter = gpuActive ? "" : transformToFilter(p.transform);
  const transform = transformToTransform(p.transform);
  const vignette = gpuActive ? "" : vignetteOverlay(p.transform);
  const unpreviewable = unpreviewableEffects(p.transform, gpuActive);

  // 变速预览：渲染端早有完整实现（ffmpeg setpts + atempo），预览端却一直没接，
  // 用户把镜头调成 2× 后预览仍按原速播，只能靠导出验证。
  // playbackRate 是 <video> 原生能力，与渲染端同一个 speed 值，行为天然一致。
  // 注意要在 src 变化后重设 —— 换片源会把 playbackRate 复位成 1。
  const speed = Math.max(0.25, Math.min(4, p.transform?.speed ?? 1));
  useEffect(() => {
    const v = p.videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed, p.previewUrl, p.videoRef]);

  return (
    <>
      <div className="fw-pl-stage">
        {p.previewUrl ? (
          <div className="fw-pl-box">
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
            {/* 预览体现不出来的效果要明说，否则用户会以为没生效 */}
            {unpreviewable.length > 0 && (
              <div className="fw-pl-approx" title="这些效果需要导出后才能看到实际结果">
                {unpreviewable.join(" / ")} 仅渲染时生效
              </div>
            )}
            {/* 只有 CSS 降级路径才需要"近似"免责说明。
                GPU 路径的运算逐条对齐 ffmpeg，标它反而会让用户不敢信预览。 */}
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

        {/* 变速状态要能一眼看到：预览已按此倍速播放，与导出一致。
            不显示的话，用户看到画面比记忆中快/慢会怀疑是卡顿。 */}
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
