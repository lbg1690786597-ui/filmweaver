import { useCallback, useEffect, useRef, useState } from "react";
import { api, JobOut } from "../api";
import type { Say } from "./useToast";

/** G4 状态分层 · 任务层：生产 job 轮询 + P2-3 服务端接回 + P2-5 SSE 订阅。
 *
 * 多 job 并行（单镜/批量互不阻塞，全局并发由后端池控制）；SSE 在线时轮询
 * 降频为 15s 兜底；打开项目从服务端接回进行中任务（localStorage 仅旧后端兜底）。 */
export function useProdJobs(opts: {
  projectId: string | null;
  say: Say;
  refreshDetail: () => Promise<void> | void;
  refreshSoon: () => void;
  refreshAudio: () => Promise<void> | void;
}) {
  const { projectId, say, refreshDetail, refreshSoon, refreshAudio } = opts;
  const [prodJobs, setProdJobs] = useState<Record<string, JobOut>>({});
  const prodTimers = useRef<Record<string, number>>({});
  const sseUp = useRef(false);

  /** job 收尾（轮询与 SSE 共用）：停轮询、清 localStorage、toast、出列、刷 detail */
  const finishJob = useCallback((jobId: string, status: string, error?: string | null) => {
    if (prodTimers.current[jobId]) {
      clearInterval(prodTimers.current[jobId]);
      delete prodTimers.current[jobId];
    }
    const j = JSON.parse(localStorage.getItem("fw_jobs") || "{}");
    if (j[jobId]) { delete j[jobId]; localStorage.setItem("fw_jobs", JSON.stringify(j)); }
    setProdJobs((prev) => {
      if (!(jobId in prev)) return prev;   // 已收尾过（SSE 与轮询竞态去重）
      say(status === "done" ? "✅ 一批生产完成" : `❌ 有任务失败: ${(error || "").slice(0, 100)}`);
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
    void refreshDetail();
  }, [say, refreshDetail]);

  const watchJob = useCallback((jobId: string, kind: string) => {
    const saved = JSON.parse(localStorage.getItem("fw_jobs") || "{}");
    saved[jobId] = { kind, project: projectId };
    localStorage.setItem("fw_jobs", JSON.stringify(saved));
    if (prodTimers.current[jobId]) clearInterval(prodTimers.current[jobId]);
    let tick = 0;
    prodTimers.current[jobId] = window.setInterval(async () => {
      tick += 1;
      if (sseUp.current && tick % 5 !== 0) return;  // SSE 在线：轮询降为 15s 兜底
      try {
        const s = await api.jobStatus(jobId);
        setProdJobs((prev) => ({ ...prev, [jobId]: s }));
        refreshSoon();  // 看板状态色刷新（与 SSE 事件共用 800ms 合并）
        if (s.status === "done" || s.status === "failed") finishJob(jobId, s.status, s.error);
      } catch { /* 网络抖动忽略，下轮再试 */ }
    }, 3000);
  }, [projectId, refreshSoon, finishJob]);

  // 启动/切项目时接回进行中的任务（P2-3 修 F4：以服务端为准，localStorage 仅兜底，
  // 换设备/清缓存后也能接回其他会话提交的 job）
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.listProjectJobs(projectId).then((r) => {
      if (cancelled) return;
      let resumed = 0;
      for (const j of r.jobs) {
        if (prodTimers.current[j.id]) continue;  // 已在轮询
        setProdJobs((prev) => ({ ...prev, [j.id]: { ...j, result: null, error: null } }));
        watchJob(j.id, j.kind);
        resumed += 1;
      }
      if (resumed > 0) say(`已接回 ${resumed} 个进行中的生产任务`);
    }).catch(() => {
      // 旧后端无此接口：退回 localStorage 兜底
      const saved = JSON.parse(localStorage.getItem("fw_jobs") || "{}") as Record<string, { kind: string; project: string }>;
      Object.entries(saved).forEach(([id, info]) => {
        if (info.project !== projectId || prodTimers.current[id]) return;
        api.jobStatus(id).then((s) => {
          if (s.status === "pending" || s.status === "running") {
            setProdJobs((prev) => ({ ...prev, [id]: s }));
            watchJob(id, info.kind);
          } else {
            const j = JSON.parse(localStorage.getItem("fw_jobs") || "{}");
            delete j[id];
            localStorage.setItem("fw_jobs", JSON.stringify(j));
          }
        }).catch(() => {});
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // P2-5 SSE 订阅（修 G3/F2）：打开项目即订阅事件流，状态变更亚秒级到达；
  // 连接期间 job 轮询自动降频为 15s 兜底，断线/旧后端自动回退纯轮询
  useEffect(() => {
    if (!projectId) return;
    const close = api.openEvents(projectId, (ev, data) => {
      if (ev === "job") {
        const j = data as unknown as { id: string; kind: string; status: string; progress: number; error?: string | null };
        // tts/拆解 job 有各自的专属追踪（ttsJobId/bdProgress 轮询），只顺带刷数据，
        // 不进生产 job 队列（否则进度条与 toast 语义会串）
        if (j.kind === "tts_batch") { void refreshAudio(); return; }
        if (j.kind === "breakdown_all") { refreshSoon(); return; }
        if (j.status === "done" || j.status === "failed") {
          finishJob(j.id, j.status, j.error);
        } else {
          setProdJobs((prev) => ({
            ...prev, [j.id]: { ...j, result: null, error: j.error ?? null },
          }));
          // 其他会话刚提交的 job：立即挂兜底轮询（SSE 断线也不失联）
          if (!prodTimers.current[j.id]) watchJob(j.id, j.kind);
          refreshSoon();
        }
      } else if (ev === "shot") {
        refreshSoon();          // 镜头状态流转 → 看板/轨道合并刷新
      } else if (ev === "audio") {
        void refreshAudio();    // 旁白段逐段点亮
      }
    }, {
      onUp: () => { sseUp.current = true; },
      onDown: () => { sseUp.current = false; },
    });
    return () => { close(); sseUp.current = false; };
  }, [projectId, watchJob, finishJob, refreshSoon, refreshAudio]);

  /** 新提交的 job 入列并挂轮询 */
  const trackJob = useCallback((job: JobOut, kind: string) => {
    setProdJobs((prev) => ({ ...prev, [job.id]: job }));
    watchJob(job.id, kind);
  }, [watchJob]);

  /** 切项目：停掉上一项目的全部 job 轮询（新项目打开时从服务端重新接回） */
  const clearJobs = useCallback(() => {
    Object.values(prodTimers.current).forEach((t) => clearInterval(t));
    prodTimers.current = {};
    setProdJobs({});
  }, []);

  //: 是否有任一 job 在跑（仅用于展示进度条与一键成片互斥；不再禁用单镜/批量按钮）
  const jobList = Object.values(prodJobs);
  const generating = jobList.length > 0;
  const prodJob = jobList[0] ?? null;  // 进度条取第一个（多 job 时显示数量角标）

  return { prodJobs, jobList, generating, prodJob, trackJob, clearJobs };
}
