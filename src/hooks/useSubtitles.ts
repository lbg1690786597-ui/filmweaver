import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { SubtitleClipInfo } from "../api";
import type { Say } from "./useToast";
import { useLoadState } from "../stores/loadStateStore";

/** TB-02 字幕层：字幕段落（时间轴字幕轨 + 文本面板共用同一份数据）。
 *
 * 与 useAudioTrack 同构：一处拉取、一处刷新，避免面板和时间轴各拉一遍
 * 导致两边显示不一致。 */
export function useSubtitles(projectId: string | null, say: Say) {
  const [subtitles, setSubtitles] = useState<SubtitleClipInfo[]>([]);

  const refreshSubtitles = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.listSubtitleClips(id);
      setSubtitles(r.clips);
      useLoadState.getState().noteLoaded("subtitles");
    } catch (e) {
      // 2.4：以前是静默 catch。失败后字幕轨空着，与"这个项目还没有字幕"
      // 在界面上无法区分 —— 用户会以为字幕丢了，然后重新对齐/重新生成一遍。
      if (useLoadState.getState().noteFailed("subtitles", e)) {
        say(`⚠️ ${useLoadState.getState().failures.subtitles?.message ?? "字幕没能加载"}`);
      }
    }
  }, [projectId, say]);

  useEffect(() => { if (projectId) void refreshSubtitles(projectId); },
    [projectId, refreshSubtitles]);

  useEffect(() => useLoadState.getState().registerRetry(
    "subtitles", () => { void refreshSubtitles(); }), [refreshSubtitles]);

  /** 切项目：清空（防上一项目的字幕串到新项目的时间轴） */
  const clearSubtitles = useCallback(() => setSubtitles([]), []);

  return { subtitles, refreshSubtitles, clearSubtitles };
}
