/**
 * TasksDrawer — 任务中心（PLAN §21，Phase 6）
 *
 * 列出当前项目的所有 job：
 *   - 正在跑：进度条 + 阶段说明 + 取消
 *   - 已完成：耗时
 *   - 失败：错误摘要 + 一键重试（重发相同 job kind）
 *
 * 设计原则：不让用户看到 job id / model id 等内部 token，
 * 只看"在出首帧 12/20"这种对业务有意义的描述。
 *
 * ⚠️ 之前这里调 listProjectJobs 走的是默认 active=true，只回 pending/running，
 * 于是「已完成 / 失败」两组永远是空的——失败回溯这条路等于没通。
 * 现在显式取全量历史（后端按 created_at 倒序）。
 */

import { useEffect, useState } from "react";
import {
  Loader2, Check, AlertTriangle, RefreshCw, ChevronDown, ChevronRight, X,
  Ban, CircleSlash, Crosshair,
} from "lucide-react";
import { api } from "../../api";
import type { JobBrief } from "../../api";
import "./TasksDrawer.css";

const KIND_LABEL: Record<string, string> = {
  shot_videos: "生成视频片段",
  first_frames: "生成首帧",
  first_frame_pipeline: "一键成片流水线",
  tts_batch: "旁白合成",
  compose: "成片拼接",
  breakdown: "拆解剧本",
  breakdown_all: "拆解全部剧集",
  costume_scan: "识别全剧服装",
  reprompt: "重写提示词",
  asset_gen: "资产生图",
  asset_batch: "资产批量生图",
  asset_candidates: "资产候选图",
  one_click_film: "一键成片",
  auto_subtitles: "自动字幕（语音识别）",
  replace: "替换素材",
};

const STATUS_ICON = {
  pending: <Loader2 size={13} className="fw-spin muted" />,
  running: <Loader2 size={13} className="fw-spin accent" />,
  done: <Check size={13} className="ok" />,
  failed: <AlertTriangle size={13} className="bad" />,
  cancelled: <CircleSlash size={13} className="muted" />,
};

/** 相对时间：任务列表里"3 分钟前"比绝对时间戳好扫 */
function ago(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 耗时（created→updated）。跑完的任务给出总时长，用于判断值不值得再跑一次。 */
function elapsed(j: JobBrief): string {
  if (!j.created_at || !j.updated_at) return "";
  const d = (Date.parse(j.updated_at) - Date.parse(j.created_at)) / 1000;
  if (!Number.isFinite(d) || d < 1) return "";
  if (d < 60) return `耗时 ${Math.round(d)} 秒`;
  return `耗时 ${Math.floor(d / 60)} 分 ${Math.round(d % 60)} 秒`;
}

interface Props {
  projectId: string;
  onRetry: (kind: string, shotIds: string[]) => void;
  /** 定位到该任务涉及的镜头（仅定向任务有 shot_ids） */
  onLocateShot?: (shotId: string) => void;
  onClose: () => void;
}

export default function TasksDrawer({ projectId, onRetry, onLocateShot, onClose }: Props) {
  const [jobs, setJobs] = useState<JobBrief[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = async () => {
    try {
      // active=false：要全量历史，否则失败/已完成两组永远为空
      const r = await api.listProjectJobs(projectId, false, 80);
      setJobs(r.jobs);
    } catch { setJobs([]); }
  };

  useEffect(() => { void load(); }, [projectId]);

  // 有任务在跑时定时刷新，跑完自动停——不然用户得手动点刷新才知道结束了
  useEffect(() => {
    const active = jobs?.some((j) => j.status === "running" || j.status === "pending");
    if (!active) return;
    const t = window.setInterval(load, 4000);
    return () => clearInterval(t);
  }, [jobs, projectId]);

  const doCancel = async (id: string) => {
    setCancelling(id);
    try { await api.cancelJob(id); await load(); }
    catch { /* 取消失败就保持原状，下一次轮询会纠正 */ }
    finally { setCancelling(null); }
  };

  const running = jobs?.filter((j) => j.status === "running" || j.status === "pending") ?? [];
  const done = jobs?.filter((j) => j.status === "done") ?? [];
  const failed = jobs?.filter((j) => j.status === "failed") ?? [];
  const cancelled = jobs?.filter((j) => j.status === "cancelled") ?? [];

  const rowProps = (j: JobBrief) => ({
    job: j,
    expanded: expandedId === j.id,
    onToggle: () => setExpandedId(expandedId === j.id ? null : j.id),
    onLocateShot,
  });

  return (
    <aside className="fw-tasks">
      <header className="fw-tasks-head">
        <span>任务中心</span>
        <div className="fw-tasks-head-acts">
          <button className="fw-tasks-ico" title="刷新" onClick={load}>
            <RefreshCw size={13} />
          </button>
          <button className="fw-tasks-ico" title="关闭" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
      </header>

      {jobs === null ? (
        <div className="fw-tasks-loading">
          <Loader2 size={14} className="fw-spin" /> 加载中…
        </div>
      ) : (
        <div className="fw-tasks-body">
          {running.length > 0 && (
            <Group title="正在执行" accent>
              {running.map((j) => (
                <TaskRow key={j.id} {...rowProps(j)}>
                  <button className="fw-tasks-cancel" title="取消任务"
                    disabled={cancelling === j.id}
                    onClick={(e) => { e.stopPropagation(); void doCancel(j.id); }}>
                    {cancelling === j.id
                      ? <Loader2 size={11} className="fw-spin" />
                      : <><Ban size={11} /> 取消</>}
                  </button>
                </TaskRow>
              ))}
            </Group>
          )}

          {failed.length > 0 && (
            <Group title="失败" danger>
              {failed.map((j) => (
                <TaskRow key={j.id} {...rowProps(j)}>
                  <button className="fw-tasks-retry"
                    onClick={(e) => { e.stopPropagation(); onRetry(j.kind, j.shot_ids); }}>
                    <RefreshCw size={11} /> 重试
                  </button>
                </TaskRow>
              ))}
            </Group>
          )}

          {cancelled.length > 0 && (
            <Group title={`已取消（${cancelled.length}）`}>
              {cancelled.slice(0, 8).map((j) => (
                <TaskRow key={j.id} {...rowProps(j)}>
                  <button className="fw-tasks-retry"
                    onClick={(e) => { e.stopPropagation(); onRetry(j.kind, j.shot_ids); }}>
                    <RefreshCw size={11} /> 重新发起
                  </button>
                </TaskRow>
              ))}
            </Group>
          )}

          {done.length > 0 && (
            <Group title={`已完成（${done.length}）`}>
              {done.slice(0, 12).map((j) => <TaskRow key={j.id} {...rowProps(j)} />)}
              {done.length > 12 && (
                <div className="fw-tasks-more">另有 {done.length - 12} 条已完成</div>
              )}
            </Group>
          )}

          {!jobs.length && (
            <div className="fw-tasks-empty">本项目还没有任务记录</div>
          )}
        </div>
      )}
    </aside>
  );
}

function Group({ title, accent, danger, children }: {
  title: string; accent?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <div className={`fw-tasks-group ${accent ? "accent" : ""} ${danger ? "danger" : ""}`}>
      <div className="fw-tasks-group-title">{title}</div>
      {children}
    </div>
  );
}

function TaskRow({ job: j, onToggle, expanded, onLocateShot, children }: {
  job: JobBrief;
  expanded: boolean;
  onToggle: () => void;
  onLocateShot?: (shotId: string) => void;
  children?: React.ReactNode;
}) {
  const label = KIND_LABEL[j.kind] ?? j.kind;
  const phase = j.phase;
  const live = j.status === "running" || j.status === "pending";
  return (
    <div className={`fw-tasks-row ${j.status}`}>
      <button className="fw-tasks-row-head" onClick={onToggle}>
        <span className="fw-tasks-row-ico">
          {STATUS_ICON[j.status as keyof typeof STATUS_ICON] ?? <Loader2 size={13} />}
        </span>
        <span className="fw-tasks-row-label">{label}</span>
        {live && phase && (
          <span className="fw-tasks-row-phase">{phase.label}
            {phase.total > 0 && ` ${phase.done}/${phase.total}`}
          </span>
        )}
        {live
          ? <span className="fw-tasks-row-pct">{j.progress}%</span>
          : <span className="fw-tasks-row-time">{ago(j.updated_at ?? j.created_at)}</span>}
        {children}
        <span className="fw-tasks-row-caret">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>

      {live && (
        <div className="fw-tasks-bar">
          <div style={{ width: `${j.progress}%` }} />
        </div>
      )}

      {expanded && (
        <div className="fw-tasks-detail">
          {j.error && <div className="fw-tasks-err">{j.error}</div>}
          {j.status === "done" && (
            <div className="fw-tasks-done-note">已完成 · {elapsed(j) || "—"}</div>
          )}
          {j.shot_ids.length > 0 && (
            <div className="fw-tasks-shots">
              <span className="fw-tasks-shots-lab">
                涉及 {j.shot_ids.length} 个镜头
              </span>
              {onLocateShot && (
                <button className="fw-tasks-locate"
                  onClick={() => onLocateShot(j.shot_ids[0])}>
                  <Crosshair size={10} /> 定位首个
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
