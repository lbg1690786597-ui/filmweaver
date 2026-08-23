import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { SubtitleClipInfo } from "../api";

/** TB-02 字幕层：字幕段落（时间轴字幕轨 + 文本面板共用同一份数据）。
 *
 * 与 useAudioTrack 同构：一处拉取、一处刷新，避免面板和时间轴各拉一遍
 * 导致两边显示不一致。 */
export function useSubtitles(projectId: string | null) {
  const [subtitles, setSubtitles] = useState<SubtitleClipInfo[]>([]);

  const refreshSubtitles = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.listSubtitleClips(id);
      setSubtitles(r.clips);
    } catch { /* 旧后端无此接口时静默 */ }
  }, [projectId]);

  useEffect(() => { if (projectId) void refreshSubtitles(projectId); },
    [projectId, refreshSubtitles]);

  /** 切项目：清空（防上一项目的字幕串到新项目的时间轴） */
  const clearSubtitles = useCallback(() => setSubtitles([]), []);

  return { subtitles, refreshSubtitles, clearSubtitles };
}
