import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { TransitionInfo } from "../api";
import type { Say } from "./useToast";
import { useLoadState } from "../stores/loadStateStore";

/** Render V2 转场层：转场挂在两个相邻镜头的接缝上。
 *
 * 与 useSubtitles 同构：一处拉取、一处刷新，时间轴与转场面板共用同一份数据。 */
export function useTransitions(projectId: string | null, say: Say) {
  const [transitions, setTransitions] = useState<TransitionInfo[]>([]);

  const refreshTransitions = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.listTransitions(id);
      setTransitions(r.transitions);
      useLoadState.getState().noteLoaded("transitions");
    } catch (e) {
      // 2.4：以前是静默 catch。转场没加载出来时接缝上不显示任何标记，
      // 用户会以为转场被删了 —— 而这时**再拖一个转场上去就是真的覆盖**
      // （后端按接缝 upsert），一次网络失败变成一次真实的数据丢失。
      if (useLoadState.getState().noteFailed("transitions", e)) {
        say(`⚠️ ${useLoadState.getState().failures.transitions?.message ?? "转场没能加载"}`);
      }
    }
  }, [projectId, say]);

  useEffect(() => { if (projectId) void refreshTransitions(projectId); },
    [projectId, refreshTransitions]);

  useEffect(() => useLoadState.getState().registerRetry(
    "transitions", () => { void refreshTransitions(); }), [refreshTransitions]);

  const clearTransitions = useCallback(() => setTransitions([]), []);

  return { transitions, refreshTransitions, clearTransitions };
}
