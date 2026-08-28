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

  // 请求序号：并发的 refreshDetail（refreshSoon 合并刷新、SSE 触发、各 patch 后的
  // 刷新会同时在飞）返回顺序不保证，先发的可能后到并**覆盖新数据** ——
  // 表现为刚拖完的时长/顺序又跳回旧值。只接受最后一次发出的那个响应。
  const seq = useRef(0);

  const refreshDetail = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    const my = ++seq.current;
    try {
      const d = await api.projectDetail(id);
      // 期间又发起了新请求 → 本次结果已过期，丢弃
      if (my !== seq.current) return;
      // 切项目时上一项目的 in-flight 请求也会走到这里，
      // clearDetail() 清不掉飞行中的 promise，所以再确认一次归属
      if (id !== (pid ?? projectId)) return;
      setDetail(d);
    } catch (e) {
      if (my !== seq.current) return;
      // ⚠️ 只有"项目确实不存在"才清场。
      // 原来是无差别 catch —— 一次 5xx 或断网就 setProjectId(null) +
      // 删 localStorage，把正在工作的用户直接弹回项目列表，未保存的
      // 选中态/预览全没了。网络抖动比项目被删常见得多。
      const status = (e as { status?: number })?.status;
      const notFound = status === 404 || status === 410;
      if (notFound) {
        setProjectId(null);
        localStorage.removeItem("fw_project");
      } else {
        // 其余错误保持现状，让用户可以重试；detail 仍是上一次的可用快照
        console.warn("[useProject] 刷新失败，保留当前项目:", e);
      }
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
