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
  Scissors, Blend, Volume2, VolumeX,
} from "lucide-react";
import { fmtSec } from "../../types/timeline";
import "./Player.css";
import type { TransformMeta, TransformPatchOpts, SubtitleClipInfo } from "../../api";
import { transformToFilter, transformToTransform, transformToClipPath,
         vignetteOverlay, unpreviewableEffects } from "../../render/previewCss";
import { useGradePreview } from "../../hooks/useGradePreview";
import { useCanvasToolStore } from "../../stores/canvasToolStore";
import { styleToCss } from "../../lib/subtitleStyle";
import type { SubtitleStyleLike } from "../../lib/subtitleStyle";
import CropZoomOverlay from "./CropZoomOverlay";
import MosaicOverlay from "./MosaicOverlay";
import SeamTransition from "./SeamTransition";
import { transitionDef } from "../effects/transitionCatalog";
import type { TransitionDef } from "../effects/transitionCatalog";
import { outputSec } from "../../lib/keyframeEdit";
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
  /** 3.9 本镜**之后**那条接缝上的转场（没有则为 null）。
   *  播完本镜时用它在画面上演一次转场预览 —— 在此之前转场只有导出才看得见。 */
  seamAtEnd?: { type: string; durationSec: number } | null;

  onPlayFromStart: () => void;
  onPlayFromCursor: () => void;
  onSeekToCursor: () => void;
  onCursorToPlayhead: () => void;
  onToggleMaximize: () => void;

  /** 空态提示信息（可导出段数 / 总时长） */
  emptyHint?: string;
  /** 3.1 当前镜头的取片窗口 `[inSec, inSec+durSec)`（秒，相对素材开头）。
   *  null = 整段使用。有值时进度条、时间读数、播放终点全部按窗口走 ——
   *  用户剪掉的那段不该还能在预览器里播出来。 */
  previewWindow?: { inSec: number; durSec: number } | null;
  playing: boolean;
  /** 3.3 J/K/L 的当前倍速：>1 快进，<0 快退（由 App 用定时器实现，播放器只显示），
   *  0/1 = 常速。与本镜变速相乘后写进 `playbackRate`（唯一写入点）。 */
  shuttleRate?: number;
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
  onPatchTransform?: (
    tm: TransformMeta | Record<string, never>, opts?: TransformPatchOpts,
  ) => void;
  /** 5.6：马赛克覆盖层要在拖动写进关键帧时说一声（"已在 1.2s 记录关键帧"）。 */
  onToast: (m: string) => void;
}

/** 画面在播放器里的实际矩形（letterbox 之外的那块）。
 *  .fw-pl-video 是 width/height:auto + max-*:100%，元素盒**就是**画面盒，
 *  所以直接读 offsetLeft/Top/Width/Height 即可，不用自己按宽高比反算。 */
interface VideoRect { left: number; top: number; width: number; height: number }

export default function Player(p: PlayerProps) {
  const { canvasRef, gpuActive } = useGradePreview(
    p.videoRef, p.transform, p.previewUrl);

  // 裁剪框编辑中：预览要显示**原始整幅**画面，否则裁剪框的坐标和眼前的画面
  // 对不上（画面已被 clip-path 切掉一块又放大铺满，框却还画在原坐标系里）。
  // 剪映进入裁剪时也是先还原整幅再叠框，退出后才显示裁剪结果。
  const cropTool = useCanvasToolStore((s) => s.cropTool);
  const cropEditing = p.overlayMode === "cropzoom" && cropTool === "frame";

  const filter = gpuActive ? "" : transformToFilter(p.transform);
  const transform = cropEditing ? "" : transformToTransform(p.transform);
  const clipPath = cropEditing ? "" : transformToClipPath(p.transform);
  const vignette = gpuActive ? "" : vignetteOverlay(p.transform);
  const unpreviewable = unpreviewableEffects(p.transform, gpuActive);

  // GPU 路径下 <video> 被隐藏、filter 被清空，opacity 会随之丢失（§0.5(f) 条件 4）。
  // 补在 canvas 元素上：元素级 opacity 与 filter:opacity() 的合成语义一致，
  // 且 canvas 之下已无可见的 <video>，不会与未调色画面叠加。
  const gpuOpacity = gpuActive && p.transform?.opacity != null && p.transform.opacity !== 1
    ? p.transform.opacity : undefined;

  const speed = Math.max(0.25, Math.min(4, p.transform?.speed ?? 1));
  // 3.3：J/L 的快进倍速在这里与本镜变速**合成**，而不是在 App 里另写一次
  // playbackRate —— 同一个属性两处写必然打架（谁最后 render 谁说了算，
  // 表现为"改了变速之后快进失效"这种查不出的怪现象）。
  // 只取正值：快退是负的，那条路不走 playbackRate（浏览器不支持负速率），
  // 由 App 用定时器回退播放头实现。
  const shuttleRate = Math.max(1, p.shuttleRate ?? 1);
  useEffect(() => {
    const v = p.videoRef.current;
    // 上限 16：Chromium 超过 16 直接抛 NotSupportedError，会打断整个 effect
    if (v) v.playbackRate = Math.min(16, speed * shuttleRate);
  }, [speed, shuttleRate, p.previewUrl, p.videoRef]);

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

  // ---- 自带播控：进度 + 音量（§0.5(f) 条件 1）----
  //
  // GPU 调色路径下 <video> 的画面由上层 canvas 接管，原生播控条会被盖住/隐藏，
  // 「能看见并拖动进度」这件事必须由我们自己提供，否则就是拿播放条换调色。
  // 顺带也摆脱了对原生 UI 的依赖：CSS 路径下这套控件同样在，两条路径手感一致。
  const [dur, setDur] = useState(0);
  const [cur, setCur] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);

  // <video> 是 key={previewUrl} 挂的，换源就是换元素，音量会重置成默认值。
  // 所以每次 loadedmetadata 都把用户设定的音量重新写回去。
  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    setDur(Number.isFinite(v.duration) ? v.duration : 0);
    setCur(v.currentTime);
    v.volume = vol;
    v.muted = muted;
    endedFired.current = false;   // 换源 = 新的一段，出点终止标记重置
    p.onLoadedMetadata(e);
  };

  /** 本次播放是否已因"到达窗口出点"而收尾过。
   *  timeupdate 只有 ~4Hz，出点附近会连着触发几次，没有这个标记会重复 onEnded
   *  （连播时表现为"一下跳过两个镜头"）。 */
  const endedFired = useRef(false);

  /* ---- 3.9 转场预览 ----
   *
   * 一镜播完的那一刻，如果这条接缝上挂着转场，就把 `<video>` 当前显示的
   * 那一帧抓成位图，交给 SeamTransition 盖在下一镜上面演完退场。
   *
   * 必须在 `onEnded` 里抓：播放器的 `<video>` 是 `key={previewUrl}` 挂的，
   * previewUrl 一变元素就被销毁重建，之后再想拿末帧已经没有源了。
   */
  const [seam, setSeam] = useState<
    { snapshot: string | null; def: TransitionDef; durationSec: number } | null>(null);

  /** 抓当前帧。跨域素材会让 canvas 被污染、toDataURL 抛 SecurityError ——
   *  抓不到就返回 null，由 SeamTransition 决定还能不能演（闪色能，其余不能）。
   *  绝不让一次取帧失败把播放流程带崩。 */
  const grabFrame = (v: HTMLVideoElement): string | null => {
    try {
      if (!v.videoWidth || !v.videoHeight) return null;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.82);
    } catch {
      return null;
    }
  };

  /** 播完一镜：先起转场预览，再把"该换下一镜了"交回 App。
   *  顺序很重要 —— 反过来的话 previewUrl 已经变了，`<video>` 也换了元素，
   *  抓到的会是新镜头的第一帧（表现为"转场把下一镜叠给了下一镜自己"）。 */
  const handleEnded = () => {
    const tr = p.seamAtEnd;
    if (tr) {
      const def = transitionDef(tr.type);
      if (def) {
        const v = p.videoRef.current;
        seamJustSet.current = true;
        setSeam({ snapshot: v ? grabFrame(v) : null,
                  def, durationSec: tr.durationSec });
      }
    }
    p.onEnded();
  };

  /* 换镜头时清掉还没演完的转场层 —— 用户中途点了别的镜头，不该还有一层
   * 旧画面糊在上面最长 5 秒。
   *
   * 但**连播换镜正是转场开始的那一刻**：它同样会让 previewShot.id 变化，
   * 不加区分就会把刚设上的转场层立刻清掉（表现为"转场依然看不到"）。
   * 故用一个一次性标记跳过这一次。 */
  const seamJustSet = useRef(false);
  useEffect(() => {
    if (seamJustSet.current) { seamJustSet.current = false; return; }
    setSeam(null);
  }, [p.previewShot?.id]);

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    setCur(v.currentTime);
    p.onTimeUpdate(e);
    // 3.1：修剪过出点的镜头，素材后面还有内容，<video> 不会自己停。
    // 到点手动暂停并复用 onEnded —— 连播、播放态标记都挂在它上面，
    // 只 pause 不通知的话，修剪过的镜头会成为连播的终点。
    // ⚠️ timeupdate 最多 4Hz，实际停点可能晚 ~250ms；这是浏览器的采样率，
    // 不是可以靠 setInterval 修掉的东西（真正的精确裁切在导出侧做）。
    const w = p.previewWindow;
    if (w && !endedFired.current && v.currentTime >= w.inSec + w.durSec) {
      endedFired.current = true;
      v.pause();
      handleEnded();
    }
  };
  const seekTo = (sec: number) => {
    const v = p.videoRef.current;
    if (!v) return;
    v.currentTime = sec;
    setCur(sec);            // 立刻跟手，不等 timeupdate（拖动时它最多 4Hz）
  };

  // 3.1 进度条/读数的取值范围：有取片窗口就按窗口，否则就是整段素材。
  // 拖到窗口外没有意义——那些内容不会出现在成片里。
  const winIn = p.previewWindow?.inSec ?? 0;
  const winOut = p.previewWindow ? winIn + p.previewWindow.durSec : dur;

  const applyVolume = (nv: number) => {
    const v = p.videoRef.current;
    setVol(nv);
    if (v) { v.volume = nv; if (nv > 0 && v.muted) { v.muted = false; setMuted(false); } }
    if (nv > 0) setMuted(false);
  };
  const toggleMute = () => {
    const v = p.videoRef.current;
    const nm = !muted;
    setMuted(nm);
    if (v) v.muted = nm;
  };

  const order = p.previewShot?.order;  const t = p.playhead && p.playhead.order === order ? p.playhead.offsetSec : null;
  const cue = (t === null || order === undefined) ? null
    : (p.subtitles ?? []).find(
        (c) => c.start_shot_order === order
            && t >= c.start_offset_sec
            && t < c.start_offset_sec + (c.duration || 0));
  const ovr = cue?.style && Object.keys(cue.style).length
    ? (cue.style as SubtitleStyleLike) : null;
  const cueStyle = ovr ?? p.subtitleStyle ?? null;

  const overlayMode = p.overlayMode ?? null;

  // 5.6 马赛克关键帧的时间基准。
  // 优先用时间轴播放头（拖动时它比 `timeupdate` 的 ~4Hz 跟手），本镜没有播放头
  // 时退回 `<video>` 自己的进度。两者都是**镜内素材秒**，要经 outputSec 换成
  // 关键帧存的输出秒 —— 面板那边（Inspector）用的是同一个函数，不能各算各的。
  const mosaicTSec = outputSec(t ?? Math.max(0, cur - winIn), p.transform?.speed);

  return (
    <>
      <div className="fw-pl-stage">
        {p.previewUrl ? (
          <div className="fw-pl-box" ref={boxRef}>
            <video key={p.previewUrl} src={p.previewUrl} controls autoPlay
              /* 3.4 `preload="metadata"`：不写的话默认是 `auto`，浏览器会
                 尽力把整个文件下下来。而这个 `<video>` 是 `key={previewUrl}`
                 挂的（`key` 必须保留，见 §0.5(g)：它是连播能自动播放的唯一
                 原因），换镜头 = 换元素 = 又一次整片下载。拖播放头扫过一串
                 镜头时，这些下载绝大多数在几十毫秒内就被 abort 掉了。
                 `metadata` 只取头部的时长/尺寸，真要播时浏览器自己会续下去 ——
                 `autoPlay` 与 `metadata` 不冲突，播放请求会覆盖预加载策略。 */
              preload="metadata"
              className={`fw-pl-video${gpuActive ? " gpu" : ""}`}
              style={{
                filter: filter || undefined,
                transform: transform || undefined,
                clipPath: clipPath || undefined,
              }}
              ref={p.videoRef}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded} />
            {/* WebGL 输出层。
                ⚠️ **必须无条件挂载**，不能写成 `{gpuActive && <canvas …/>}` ——
                那样会形成自举死锁：canvas 要等 gpuActive，gpuActive 要等
                GradePreview.create(canvas) 成功，而 create 要等 canvas 存在。
                详见 hooks/useGradePreview.ts 开头。可见性交给 CSS 的 .off。

                <video> 不能移除 —— 它仍是解码源与音频源；GPU 路径下用
                `.gpu`（visibility:hidden）让它只出层不出画，播控由上面那条
                自带工具条提供。canvas 的 pointer-events:none 保证画面上的
                取景框/马赛克覆盖层仍能收到鼠标事件。

                位置直接钉在 vrect（<video> 的 offset 盒）上，而不是靠
                max-width:100% 让它"碰巧"缩放成一样大 —— 字幕/取景框/马赛克
                三个覆盖层用的都是同一个 vrect，钉死才能保证逐像素对齐。 */}
            <canvas ref={canvasRef}
              className={`fw-pl-canvas${gpuActive ? "" : " off"}`}
              style={{
                transform: transform || undefined,
                clipPath: clipPath || undefined,
                // 不透明度不进 shader（canvas 是 alpha:false 上下文），
                // 在元素层做 —— 与 CSS 路径的 filter:opacity() 合成结果等价。
                // 见 gradePreview.ts 的 needsGpuPreview 注释。
                opacity: gpuOpacity,
                ...(vrect ? {
                  left: vrect.left, top: vrect.top,
                  width: vrect.width, height: vrect.height,
                } : null),
              }} />
            {/* 暗角没法用 filter 表达，叠一层渐变（GPU 路径已在 shader 里做了）。
                pointer-events:none 保证不挡住 <video> 自带的播控条 */}
            {vignette && (
              <div className="fw-pl-vignette" style={{ background: vignette }} />
            )}
            {/* P2-7 留黑的预览。
                盖一层不透明黑，而不是给 <video> 加 `filter: brightness(0)` ——
                后者在 GPU 路径下会被整块清掉（`filter` 只在 CSS 路径下有值，
                见上面 93 行），于是"开了留黑但预览照常有画面"，而这恰恰是
                用户唯一能判断留黑生效了没有的地方。盖一层则**两条路径都盖得住**。

                钉在 vrect 上而不是 `inset: 0`：黑的范围必须是画面那一块，
                连 letterbox 黑边一起盖会让人以为整个播放器坏了。

                z 序（CSS 里 z-index:1，DOM 上排在 canvas 之后）也是推导出来的：
                压住 canvas(1) 与 <video>，但**低于字幕层(2)** —— 导出时字幕是在
                段合成之后才烧上去的，成片里字幕本来就浮在黑上面，预览要一致。 */}
            {p.transform?.blackout && vrect && (
              <div className="fw-pl-blackout"
                style={{
                  left: vrect.left, top: vrect.top,
                  width: vrect.width, height: vrect.height,
                }} />
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

            {/* V2.3 取景框覆盖层（选中镜头且激活 cropzoom 模式时显示）
                zIndex 必须高于 .fw-pl-canvas(1) 与字幕层(2)：GPU 路径下
                canvas 是不透明的，不抬 z 序这两个交互层会被整块盖住。 */}
            {overlayMode === "cropzoom" && vrect && p.onPatchTransform && (
              <div style={{ position: "absolute", left: vrect.left, top: vrect.top, zIndex: 3 }}>
                <CropZoomOverlay
                  vrect={vrect}
                  transform={p.transform ?? null}
                  onPatchTransform={p.onPatchTransform}
                />
              </div>
            )}

            {/* V2.3 马赛克覆盖层（激活 mosaic 模式或已有马赛克区域时显示） */}
            {vrect && p.onPatchTransform && (
              <div style={{ position: "absolute", left: vrect.left, top: vrect.top, zIndex: 3 }}>
                <MosaicOverlay
                  vrect={vrect}
                  transform={p.transform ?? null}
                  onPatchTransform={p.onPatchTransform}
                  active={overlayMode === "mosaic"}
                  tSec={mosaicTSec}
                  onToast={p.onToast}
                />
              </div>
            )}

            {/* 3.9 转场预览层：钉在 <video> 的 offset 盒上（与字幕/取景框/
                马赛克同一个 vrect），否则画面是 contain 缩放过的、转场会
                盖到黑边上去。 */}
            {seam && vrect && (
              <div style={{ position: "absolute", left: vrect.left, top: vrect.top,
                            width: vrect.width, height: vrect.height, zIndex: 6,
                            pointerEvents: "none" }}>
                <SeamTransition
                  snapshot={seam.snapshot}
                  motion={seam.def.motion}
                  name={seam.def.name}
                  durationSec={seam.durationSec}
                  onDone={() => setSeam(null)} />
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

        <input type="range" className="fw-pl-seek"
          title={winIn > 0
            ? `拖动定位播放位置（本镜取素材 ${winIn.toFixed(1)}–${winOut.toFixed(1)}s）`
            : "拖动定位播放位置"}
          min={winIn} max={winOut || 1} step={0.01}
          value={Math.min(Math.max(cur, winIn), winOut || 1)}
          disabled={!p.previewUrl || !dur}
          onChange={(e) => seekTo(Number(e.target.value))} />
        <span className="fw-pl-time"
          title={winIn > 0
            ? `本镜位置 / 本镜时长（已修剪：取素材第 ${winIn.toFixed(1)}s 起）`
            : "当前播放位置 / 本段总时长"}>
          {/* 读数按**镜内**时间显示：用户认的是"这一镜的第几秒"，
              素材里的绝对秒对他没有意义（还会和时间轴对不上）。 */}
          {fmtSec(Math.max(0, cur - winIn))} / {fmtSec(Math.max(0, winOut - winIn))}
        </span>

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

        {/* 3.3：J/L 的倍速必须看得见 —— 4× 快进时画面本身看不出是几倍速，
            没有这个徽标用户只知道"跑得很快"，不知道按 K 能停、按几次能回常速。
            1× 快退也要显示（倒着走 1× 同样是个非常态，且画面倒放不一定一眼看出）。
            复用 .fw-pl-meta.speed 的样式（verify-css-coverage 不允许新 class
            没有对应 CSS，而这里"快进中"与"已变速"视觉上本就该同一档）。 */}
        {((p.shuttleRate ?? 0) < 0 || (p.shuttleRate ?? 0) > 1) && (
          <span className="fw-pl-meta speed" title="J 快退 / K 停 / L 快进">
            {p.shuttleRate! < 0 ? "◀◀ " : "▶▶ "}{Math.abs(p.shuttleRate!)}×
          </span>
        )}

        <button className="fw-pl-btn" title={muted ? "取消静音" : "静音"}
          onClick={toggleMute}>
          {muted || vol === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        <input type="range" className="fw-pl-vol" title="音量"
          min={0} max={1} step={0.02}
          value={muted ? 0 : vol}
          onChange={(e) => applyVolume(Number(e.target.value))} />

        <button className="fw-pl-btn" title="最大化播放器" onClick={p.onToggleMaximize}>
          <Maximize2 size={14} />
        </button>
      </div>
    </>
  );
}

export { fmtSec };
