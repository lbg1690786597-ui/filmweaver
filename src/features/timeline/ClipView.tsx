/**
 * ClipView — 时间轴上的单个 Clip（Phase 2）
 *
 * 四种交互区：
 *   中间   点击选中 / 按住拖动换位
 *   左边缘 拖拽修剪**入点**（3.1，仅已出片的镜头有）
 *   右边缘 拖拽改时长（0.1s 步进，钳 1s ~ 项目模型单镜上限）
 *   右键   上下文菜单
 *
 * 拖动过程只更新本地状态（父组件的 dragState），松手才 PATCH——
 * 否则拖一次会发几十个请求，而且中途失败会留下半截状态。
 */

import { memo } from "react";
import { AlertTriangle, RefreshCw, EyeOff, Loader2, Film, Scissors, Square } from "lucide-react";
import type { Clip } from "../../types/timeline";
import { api } from "../../api";
import Waveform from "./Waveform";
import { canTrimIn } from "./trim";
import "./ClipView.css";

/** 与 Timeline.tsx 的 MIN_CLIP_SEC 同值；这里只用于提示文案 */
const MIN_TRIM_SEC = 1;

/**
 * 7.2：停用镜头折叠标记的固定宽度（像素）。
 *
 * 固定像素而非秒数是刻意的：停用镜头**不占时间**，它在秒坐标里没有宽度可言，
 * 任何"折算成 X 秒"的写法都会让时间轴与导出对不上（见 `collapseDisabled`）。
 * 取 14 是因为它要装得下 9px 的 EyeOff 角标还留一点边——再窄就点不准了，
 * 而"点不准"正好是本条要修的那个毛病的轻量版。
 */
const COLLAPSED_PX = 14;

interface Props {
  clip: Clip;
  /** Alt+按下：交给时间轴统一处理（点=在此分割，拖=框选）。
   *  片段自己不判断到底是点还是拖 —— 那要等 mouseup，而框选的整套
   *  mousemove/mouseup 生命周期在 Timeline 的 `beginMarquee` 里，
   *  这里再写一份必然与它漂移。 */
  onAltMouseDown?: (e: React.MouseEvent) => void;
  pxPerSec: number;
  selected: boolean;
  /** 单镜时长上限（秒），仅用于 trim 手柄的提示文案。
   *  写死 15 会在 seedance-2.5（30s）项目上骗人。 */
  maxDurSec?: number;
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
  /** 3.1：拖左边缘修剪入点。只有已出片的镜头会渲染这个手柄。 */
  onBeginTrimIn?: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}

function ClipViewInner(p: Props) {
  const { clip: c } = p;
  const start = p.previewStartSec ?? c.startSec;
  const dur = p.previewDurationSec ?? c.durationSec;
  // 7.2：停用镜头折叠成标记。它的 startSec 与后继镜头**必然相同**（停用不占
  // 时间），折叠前是按原时长整格画出来、再被后继镜头整块盖住——看不见、点不到、
  // 也就没法再启用。理由与"为什么不能给它分配秒数"见 adapters/shotToClip.ts
  // 的 `collapseDisabled`。
  //
  // 画在接缝**左侧**：停用的这一镜在顺序上排在后继之前，标记贴着它该在的那条
  // 边界；画右侧会压住后继的左缘 trim 手柄（那是 3.1 的修剪入点）。
  // 连续多个停用镜头按 collapsedIndex 依次往左错开，否则叠成一个。
  // 贴着时间轴开头时（第一镜就停用）没有左侧空间可退，退化为从 0 往右排开，
  // 仍然各占各的格子——宁可压住后继一点，也不能重新叠回一个像素。
  const collapsed = c.collapsedIndex !== undefined;
  const left = collapsed
    ? Math.max(c.collapsedIndex! * COLLAPSED_PX,
               start * p.pxPerSec - (c.collapsedIndex! + 1) * COLLAPSED_PX)
    : start * p.pxPerSec;
  const width = collapsed ? COLLAPSED_PX : Math.max(18, dur * p.pxPerSec);
  const height = p.height ?? 64;
  // 窄槽下不渲染文字/角标——40px 宽的槽里塞标签只会变成一团噪点
  const compact = width < 56;

  const cls = [
    "fw-clip",
    `st-${c.status}`,
    p.selected ? "selected" : "",
    c.disabled ? "disabled" : "",
    // P2-7：留黑与停用**不能长得像**。停用整格压到 0.4 透明度（"这一镜不在了"），
    // 留黑则是格子照常在、只有画面那一块变黑（"这一镜在，只是不给看"）——
    // 两者若共用一套灰化样式，用户在时间轴上就分不出自己按的是哪一个。
    c.blackout ? "blackout" : "",
    collapsed ? "collapsed" : "",
    c.isSpecial ? "special" : "",
    p.dragging ? "dragging" : "",
    p.dropTarget ? "drop-target" : "",
    p.trackLocked ? "locked" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cls}
      style={{ left, width }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Alt 一律交给时间轴统一处理：点 = 在此切一刀，拖 = 框选。
        // 这里**不能**再走 onSelect/onBeginMove —— 否则 Alt+拖会变成
        // "选中并把这个片段拖走"，用户想框选却把素材挪了位置。
        if (e.altKey && p.onAltMouseDown) { p.onAltMouseDown(e); return; }
        p.onSelect(e);
        if (!p.trackLocked) p.onBeginMove(e);
      }}
      onContextMenu={p.onContextMenu}
      onDoubleClick={p.onDoubleClick}
      title={collapsed
        // 折叠标记里放不下任何文字，所有信息只能靠 title。要说清三件事：
        // 它是谁、为什么这么窄、怎么恢复——否则用户只看到一条不明所以的竖条。
        ? `${c.label} 已停用：不占时间轴、不参与导出。右键可重新启用`
        : `${c.label}${c.scriptRef ? ` · ${c.scriptRef.slice(0, 40)}` : ""} · ${dur.toFixed(1)}s`}>

      {/* 折叠标记只画角标：14px 宽里塞缩略图既看不清，还要为一个"不参与导出的
          镜头"白发一次网络请求。 */}
      {!collapsed && (p.variant === "audio" && c.mediaUrl ? (
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
      ))}

      {!compact && p.variant !== "subtitle" && (
        <div className="fw-clip-info">
          <span className="fw-clip-label">{c.label}</span>
          <span className="fw-clip-dur">{dur.toFixed(1)}s</span>
        </div>
      )}

      {/* 状态角标 */}
      <div className="fw-clip-badges">
        {c.disabled && <span className="fw-clip-badge dim" title="已停用，不参与导出"><EyeOff size={9} /></span>}
        {/* P2-7：角标的 title 是用户唯一能看到的「留黑 ≠ 停用」的说明，
            所以把三件事一次说全——占不占时间、有没有声音、怎么撤销。
            只写「已留黑」的话，用户会以为它和停用一样把这一镜拿掉了。 */}
        {!collapsed && c.blackout && (
          <span className="fw-clip-badge black"
            title="已留黑：画面全黑，但仍占原时长、声音与字幕照常。右键可取消留黑">
            <Square size={9} fill="currentColor" />
          </span>
        )}
        {!collapsed && c.refsStale && <span className="fw-clip-badge warn" title="参考图已变更，可重新生成"><RefreshCw size={9} /></span>}
        {!collapsed && c.status === "failed" && <span className="fw-clip-badge bad" title="生成失败"><AlertTriangle size={9} /></span>}
        {/* 3.1：入点 > 0 说明这一镜掐掉了素材开头。不标出来的话，
            用户看到的只是"这格比别的短"，无从知道短在哪、也想不起还能拖回去。 */}
        {!collapsed && !!c.clipInSec && c.clipInSec > 0 && (
          <span className="fw-clip-badge cut"
            title={`已修剪：从素材第 ${c.clipInSec.toFixed(1)}s 起，取 ${c.durationSec.toFixed(1)}s`}>
            <Scissors size={9} />
          </span>
        )}
      </div>

      {/* 左缘 trim 手柄（3.1 修剪入点）。
          镜头：未出片的不渲染 —— 它没有"素材开头"可掐，设了入点只会让
          duration_sec 不再是生成目标（判据与 Timeline.beginTrimIn 同源）。
          6.9 音频：同理要有 url（还在合成的旁白掐不了开头）。
          6.9 字幕：**恒有** —— 字幕没有素材，拖左边缘是"晚点出现、短一点"，
          不依赖任何文件。照搬 canTrimIn 会因为它没有 mediaUrl 而永远不渲染，
          那就成了"能拖右边不能拖左边"的莫名其妙。 */}
      {!collapsed && !p.trackLocked && p.onBeginTrimIn
        && (c.entity === "subtitle" || canTrimIn({ video_url: c.mediaUrl ?? null })) && (
        <div className="fw-clip-trim-in"
          title={c.entity === "shot"
            ? `拖动裁掉素材开头（已裁掉 ${(c.clipInSec ?? 0).toFixed(1)}s，每格 0.1s）`
            : c.entity === "audio"
              ? `拖动裁掉开头（已裁掉 ${(c.clipInSec ?? 0).toFixed(1)}s；这一段会晚一点开始放）`
              : "拖动让字幕晚点出现（同时缩短显示时长）"}
          onMouseDown={(e) => { e.stopPropagation(); p.onBeginTrimIn!(e); }} />
      )}

      {/* 右缘 trim 手柄。
          ⚠️ 提示文案要按实体分：三种实体的上下限**依据互不相干**
          （见 features/timeline/clipEdit.ts 的表）。对一段 3 分钟的 BGM
          说"1–15s"是纯粹的谎话，而这个手柄在 6.9 之前就已经画在音频段上、
          且拖了没反应——文案再骗一次就是两重误导。
          7.2：折叠标记整格只有 14px，两个手柄一铺就没有可点的中间区域了，
          而"点得中"正是折叠要买的东西；何况停用镜头修剪时长毫无意义。 */}
      {!collapsed && !p.trackLocked && (
        <div className="fw-clip-trim"
          title={c.entity === "shot"
            ? `拖动调整时长（${MIN_TRIM_SEC}–${p.maxDurSec ?? "?"}s，每格 0.1s）`
            : c.entity === "audio"
              ? `拖动裁掉结尾（最长 ${(c.sourceDurSec ?? dur).toFixed(1)}s，就是素材总长；每格 0.1s）`
              : "拖动调整字幕显示时长（每格 0.1s）"}
          onMouseDown={(e) => { e.stopPropagation(); p.onBeginTrim(e); }} />
      )}
    </div>
  );
}

export default memo(ClipViewInner);
