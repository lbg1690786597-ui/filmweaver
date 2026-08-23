import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { TransitionInfo } from "../api";

/** Render V2 转场层：转场挂在两个相邻镜头的接缝上。
 *
 * 与 useSubtitles 同构：一处拉取、一处刷新，时间轴与转场面板共用同一份数据。 */
export function useTransitions(projectId: string | null) {
  const [transitions, setTransitions] = useState<TransitionInfo[]>([]);

  const refreshTransitions = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.listTransitions(id);
      setTransitions(r.transitions);
    } catch { /* 旧后端无此接口时静默 */ }
  }, [projectId]);

  useEffect(() => { if (projectId) void refreshTransitions(projectId); },
    [projectId, refreshTransitions]);

  const clearTransitions = useCallback(() => setTransitions([]), []);

  return { transitions, refreshTransitions, clearTransitions };
}
