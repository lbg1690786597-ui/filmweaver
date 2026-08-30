import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { SubtitleStyleLike } from "../lib/subtitleStyle";

/** 项目级默认字幕样式（存在 `Project.default_profile.subtitle_style`）。
 *
 * 为什么必须有"项目级"这一层：烧录是把**一个** SRT 配**一套** force_style
 * 交给 ffmpeg 的 subtitles 滤镜——它没有"逐条不同样式"这回事。所以导出时
 * 必须存在一个确定的"这个项目的字幕长什么样"，不能随便挑某条 cue 的 style
 * 去代表全体。单条 `SubtitleClip.style` 仍然保留，它决定的是编辑器里的预览
 * 覆写与将来的 ASS 导出。
 *
 * 与 useSubtitles 同构：一处拉取一处写回，Player 预览、TextPanel 编辑、
 * 导出三方读同一份，避免"预览一套、烧出来另一套"。
 */
export function useSubtitleStyle(projectId: string | null) {
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyleLike | null>(null);

  const refreshSubtitleStyle = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.getSubtitleStyle(id);
      setSubtitleStyle((r.style as SubtitleStyleLike | null) ?? null);
    } catch {
      // 旧后端没有这个接口 / 项目从没设过样式：留 null，
      // 由 srtForceStyle 与 styleToCss 各自的短剧默认值兜底。
      setSubtitleStyle(null);
    }
  }, [projectId]);

  useEffect(() => { if (projectId) void refreshSubtitleStyle(projectId); },
    [projectId, refreshSubtitleStyle]);

  /** 写回项目级样式。**先落库再更新本地** —— 反过来的话写失败时
   *  UI 显示的是没存住的样式，用户下次进来发现改动没了。 */
  const saveSubtitleStyle = useCallback(async (style: SubtitleStyleLike | null) => {
    if (!projectId) return;
    await api.setSubtitleStyle(projectId, style as Record<string, unknown> | null);
    setSubtitleStyle(style);
  }, [projectId]);

  const clearSubtitleStyle = useCallback(() => setSubtitleStyle(null), []);

  return { subtitleStyle, refreshSubtitleStyle, saveSubtitleStyle, clearSubtitleStyle };
}
