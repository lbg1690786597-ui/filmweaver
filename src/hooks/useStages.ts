import { useCallback, useEffect, useState } from "react";
import { api, LocationInfo, StageInfo } from "../api";
import type { Say } from "./useToast";

/** G4 状态分层 · 资产层：R1 人物阶段 + P1-3 场景（时间轴轨道数据）。 */
export function useStages(projectId: string | null, say: Say) {
  const [stages, setStages] = useState<StageInfo[]>([]);
  const [locations, setLocations] = useState<LocationInfo[]>([]);  // P1-3 场景轨
  const [drafting, setDrafting] = useState(false);

  const refreshStages = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.listStages(id);
      setStages(r.stages);
      setLocations(r.locations ?? []);  // 旧后端无此字段时回退空
    } catch { /* 后端旧版无此接口时静默 */ }
  }, [projectId]);
  useEffect(() => { if (projectId) refreshStages(projectId); }, [projectId, refreshStages]);

  const doStagesDraft = async () => {
    if (!projectId) return;
    setDrafting(true);
    try {
      const r = await api.stagesDraft(projectId);
      await refreshStages();
      say(`✨ 识别完成：新增 ${r.created} 个阶段草稿${r.skipped_confirmed.length ? `（已确认角色保留：${r.skipped_confirmed.join("、")}）` : ""}`);
    } catch (e) { say(String(e)); }
    finally { setDrafting(false); }
  };

  /** 切项目：清空轨道数据 */
  const clearStages = useCallback(() => { setStages([]); setLocations([]); }, []);

  return { stages, locations, drafting, refreshStages, doStagesDraft, clearStages };
}
