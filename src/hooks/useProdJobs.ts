import { useCallback, useEffect, useRef, useState } from "react";
import { api, JobOut, JobPhase } from "../api";
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
  /** TB-08：自动字幕 job 收尾后刷新字幕轨 */
  refreshSubtitles?: () => Promise<void> | void;
}) {
  const { projectId, say, refreshDetail, refreshSoon, refreshAudio, refreshSubtitles } = opts;
  const [prodJobs, setProdJobs] = useState<Record<string, JobOut>>({});
  const prodTimers = useRef<Record<string, number>>({});
  const sseUp = useRef(false);
  const framesWarned = useRef<Set<string>>(new Set());

  /** 批量首帧收尾提示两类需要人工介入的镜头（SSE 与轮询都可能先到，用 ref 去重）：
   *  - bare_shots：refs=0，没有定妆图可注入，人物长相由模型自由发挥（场景锚点只保场景不保人）
   *  - blocked_shots：全渠道内容审核拒绝。**重试无效**——同一提示词判定一致，
   *    只能改写提示词或换生图模型（各厂商审核口径不同），所以要单独说清楚，
   *    不能混进"失败了再点一次"的通用失败提示里 */
  const warnFrameIssues = useCallback((jobId: string, result: string | null | undefined) => {
    if (!result || framesWarned.current.has(jobId)) return;
    framesWarned.current.add(jobId);
    try {
      const r = JSON.parse(result) as { bare_shots?: number[]; blocked_shots?: number[] };
      const bare = r.bare_shots ?? [];
      const blocked = r.blocked_shots ?? [];
      if (bare.length) {
        say(`⚠️ ${bare.length} 个镜头无定妆图可注入（#${bare.slice(0, 8).join(" #")}`
          + `${bare.length > 8 ? " …" : ""}），这些首帧的人物一致性无保障，`
          + "建议补齐定妆图后重生");
      }
      if (blocked.length) {
        say(`🚫 ${blocked.length} 个镜头的提示词被内容审核拒绝（#${blocked.slice(0, 8).join(" #")}`
          + `${blocked.length > 8 ? " …" : ""}）。重试无效——请展开这些镜头，`
          + "用「换模型重试」换个厂商的生图模型，或弱化提示词中的敏感描写");
      }
    } catch { /* 老 job 无此字段，忽略 */ }
  }, [say]);

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
        if (s.status === "done" || s.status === "failed") {
          if (kind === "first_frames") warnFrameIssues(jobId, s.result);
          finishJob(jobId, s.status, s.error);
        }
      } catch { /* 网络抖动忽略，下轮再试 */ }
    }, 3000);
  }, [projectId, refreshSoon, finishJob, warnFrameIssues]);

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
        const j = data as unknown as { id: string; kind: string; status: string; progress: number; error?: string | null; phase?: JobPhase | null };
        // tts/拆解 job 有各自的专属追踪（ttsJobId/bdProgress 轮询），只顺带刷数据，
        // 不进生产 job 队列（否则进度条与 toast 语义会串）
        if (j.kind === "tts_batch") { void refreshAudio(); return; }
        // TB-08 自动字幕：与 tts 同理，只刷字幕数据，不进生产 job 队列
        if (j.kind === "auto_subtitles") {
          if (j.status === "done" || j.status === "failed") void refreshSubtitles?.();
          return;
        }
        if (j.kind === "breakdown_all") { refreshSoon(); return; }
        if (j.status === "done" || j.status === "failed") {
          // SSE 的 job 事件不带 result，批量首帧另拉一次读「裸生/被审核拒绝」清单。
          // failed 也要拉：全批都被审核拒绝时 job 即为 failed，而那正是最需要
          // 告诉用户"换模型/改提示词"的时候（轮询此时已被 SSE 抢先收尾，指望不上）
          if (j.kind === "first_frames") {
            api.jobStatus(j.id)
              .then((s) => warnFrameIssues(j.id, s.result))
              .catch(() => { /* 读不到就算了，弹窗与步骤条已提前警告过 */ });
          }
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
  }, [projectId, watchJob, finishJob, refreshSoon, refreshAudio, refreshSubtitles, warnFrameIssues]);

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

  //: 是否有任一 job 在跑（用于展示进度条、互斥一键成片，以及禁用批量提交按钮
  //  ——后端已有提交去重兜底，前端禁用只是别让用户白点）
  const jobList = Object.values(prodJobs);
  const generating = jobList.length > 0;
  const prodJob = jobList[0] ?? null;  // 进度条取第一个（多 job 时显示数量角标）
  //: 阶段标签取**任一带阶段的** job，而不是 jobList[0]——单镜重生等无阶段的 job
  //  很可能排在前面，取第一个会让"正在出首帧 32/170"莫名消失
  const jobPhase = jobList.find((j) => j.phase)?.phase ?? null;

  return { prodJobs, jobList, generating, prodJob, jobPhase, trackJob, clearJobs };
}
