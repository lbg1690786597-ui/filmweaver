import { useCallback, useEffect, useState } from "react";
import { api, LocationInfo, StageInfo } from "../api";
import type { Say } from "./useToast";
import { useLoadState } from "../stores/loadStateStore";

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
      useLoadState.getState().noteLoaded("stages");
    } catch (e) {
      // 2.4：以前是静默 catch。人物阶段没加载出来时轨道是空的，用户会去点
      // 「AI 识别服装」重跑一遍 —— 那是要花钱出图的操作，而且它的语义是
      // "已出图的阶段一律保留、只做增量"，在一份空快照上跑等于凭空多出一批草稿。
      if (useLoadState.getState().noteFailed("stages", e)) {
        say(`⚠️ ${useLoadState.getState().failures.stages?.message ?? "人物与场景没能加载"}`);
      }
    }
  }, [projectId, say]);
  useEffect(() => { if (projectId) refreshStages(projectId); }, [projectId, refreshStages]);

  useEffect(() => useLoadState.getState().registerRetry(
    "stages", () => { void refreshStages(); }), [refreshStages]);

  const doStagesDraft = async () => {
    if (!projectId) return;
    setDrafting(true);
    try {
      const r = await api.stagesDraft(projectId);
      await refreshStages();
      // 语义：已出图的阶段一律保留（不删不改区间），本次只做增量。所以这里报的是
      // "新增"与"服装变体"，而不是"跳过了哪些角色"。
      const extra = [
        r.episodes_scanned ? `逐集扫描 ${r.episodes_scanned} 集` : "",
        r.scenes ? `归一场景 ${r.scenes} 个` : "",
        r.variants ? `含服装变体 ${r.variants} 个` : "",
        // 场景决定型服装：人物再次进入同一场景且剧本没写衣着时沿用同一张图
        r.scene_bound ? `场景沿用 ${r.scene_bound} 件` : "",
        r.followers ? `同衣复用 ${r.followers} 段（不额外出图）` : "",
        r.reused_images ? `复用已有定妆图 ${r.reused_images} 张` : "",
        r.skipped_with_image?.length
          ? `已出图阶段保留：${r.skipped_with_image.join("、")}` : "",
      ].filter(Boolean).join("，");
      say(`✨ 识别完成：新增 ${r.created} 个阶段草稿${extra ? `（${extra}）` : ""}`);
    } catch (e) { say(String(e)); }
    finally { setDrafting(false); }
  };

  /** 切项目：清空轨道数据 */
  const clearStages = useCallback(() => { setStages([]); setLocations([]); }, []);

  return { stages, locations, drafting, refreshStages, doStagesDraft, clearStages };
}
