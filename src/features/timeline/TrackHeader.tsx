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

/** 只有视频/叠加轨的"隐藏"会影响导出，判据与 `render/trackFlags.ts` 同源 */
const hidesFromExport = (k: Track["kind"]) => k === "video" || k === "overlay";

/**
 * ⚠️ 4.6 起，静音 / 独奏 / 隐藏**真的会影响导出**，文案必须如实。
 *
 * 4.6 之前它们只是标记：`normalize.ts` 把每条 RenderTrack 的 `muted/hidden`
 * 写死成 `false`，store 里的标志到不了导出计划，于是"静音了 BGM 还在成片里"。
 * 现在 `render/trackFlags.ts` 把它们折算成 RenderTrack id 交给 `normalize`，
 * 下游（`renderer.ts` 筛 `!t.muted`、`segment.ts` 筛 `!t.hidden`）本来就在读。
 *
 * 三条各自的边界，改文案前先看清楚：
 *   · **静音**：只对音频轨，本轨音频不进成片。
 *   · **独奏**：只对音频轨，导出时只保留独奏轨（其余视作静音）。剪映的 solo
 *     是纯监听不进成片，这里没照抄——我们的预览播的是单个镜头的 `<video>`，
 *     根本读不到轨道开关，标成"仅预览"等于换个说法继续骗人。改为进导出 +
 *     导出前把影响念给用户听（`App.tsx` 的轨道开关确认框）。
 *   · **隐藏**：只对**视频/叠加**轨进导出。音频轨与字幕轨上的眼睛保持纯编辑器
 *     语义（变暗、不可选中、不参与吸附）——音频要不出声有静音按钮，
 *     两个开关做同一件事只会让人猜不透哪个算数；字幕走 `plan.subtitles`，
 *     压根不经过轨道模型。所以下面的眼睛文案**按轨型分开写**。
 *
 * 文案与 `verify-trackflags.ts` ⑤ 段、`verify-undo.ts` ⑤ 段成对绑定：
 * 谁把语义改回去，那两条断言就转红。
 */
const MUTE_TITLE = "静音本轨（导出时本轨音频不进成片）";
const SOLO_TITLE = "独奏（导出时只保留本轨音频，其余音频轨视作静音）";
/** 隐藏只对视频/叠加轨影响导出，其余轨型只是编辑器内的变暗 */
const HIDE_TITLE_EXPORT = "隐藏轨道（变暗、不可选中、不参与吸附；导出时本轨画面不进成片）";
const HIDE_TITLE_EDITOR = "隐藏轨道（仅编辑器内变暗、不可选中、不参与吸附；不影响导出。音频要不出声请用静音）";

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
            title={t.hidden ? "显示轨道" : (hidesFromExport(t.kind) ? HIDE_TITLE_EXPORT : HIDE_TITLE_EDITOR)}>
            {t.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
          {isAudioKind(t.kind) && (
            <>
              <button className={`fw-th-btn ${t.muted ? "on danger" : ""}`} onClick={p.onToggleMuted}
                title={t.muted ? "取消静音（本轨音频将重新进成片）" : MUTE_TITLE}>
                {t.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
              </button>
              <button className={`fw-th-btn ${t.solo ? "on accent" : ""}`} onClick={p.onToggleSolo}
                title={SOLO_TITLE}>
                <Headphones size={11} />
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}
