import { useCallback, useEffect, useRef, useState } from "react";
import { api, ProjectDetail } from "../api";

/** G4 状态分层 · 项目层：当前项目 + detail 快照 + 刷新（含 800ms 合并刷新）。
 *
 * T-R0-07 状态云端化：projectId 记 localStorage，启动恢复现场；
 * detail 是全部视图的唯一数据源（镜头/分集/资产），刷新统一走这里。 */
export function useProject() {
  const [projectId, setProjectId] = useState<string | null>(
    () => localStorage.getItem("fw_project") || null,
  );
  const [detail, setDetail] = useState<ProjectDetail | null>(null);

  const refreshDetail = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      setDetail(await api.projectDetail(id));
    } catch {
      setProjectId(null);
      localStorage.removeItem("fw_project");
    }
  }, [projectId]);

  // P2-5：事件可能连发（多镜并发流转），800ms 合并一次全量刷新，避免 detail 请求风暴
  const refreshTimer = useRef<number | null>(null);
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshDetail();
    }, 800);
  }, [refreshDetail]);

  /** 切/关项目时清 detail 与待执行的合并刷新（防旧项目延迟刷新串到新项目） */
  const clearDetail = useCallback(() => {
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    setDetail(null);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (projectId) refreshDetail(projectId); }, []); // 启动恢复现场

  return { projectId, setProjectId, detail, refreshDetail, refreshSoon, clearDetail };
}
