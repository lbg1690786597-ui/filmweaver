/**
 * ProjectCards — 项目卡片网格（PLAN §17，Phase 6）
 *
 * 卡片要显示：缩略图 / 名称 / 比例 / 时长 / AI 生产进度 / 待处理镜头数。
 *
 * TB-11 已落地：`GET /v2/projects` 直接返回 shots_total / shots_done /
 * total_sec / thumb_url，原先"每个项目再拉一次 detail"的 N+1 补拉已删除
 * （21 个项目 = 21 个请求 → 1 个请求）。
 */

import { useMemo, useState } from "react";
import { Search, Film, Clock } from "lucide-react";
import { api } from "../../api";
import type { ProjectInfo } from "../../api";
import { fmtSec } from "../../types/timeline";
import { productionModeLabel } from "../../lib/modelLabels";
import "./ProjectCards.css";

interface Props {
  projects: ProjectInfo[];
  onOpen: (id: string) => void;
}

export default function ProjectCards({ projects, onOpen }: Props) {
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return projects;
    return projects.filter((p) => p.title.toLowerCase().includes(kw));
  }, [projects, q]);

  return (
    <>
      <div className="fw-pc-bar">
        <div className="fw-pc-search">
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="搜索项目名…" spellCheck={false} />
        </div>
        <span className="fw-pc-count">
          {shown.length} / {projects.length} 个项目
        </span>
      </div>

      <div className="fw-pc-grid">
        {shown.map((proj) => {
          const total = proj.shots_total ?? 0;
          const done = proj.shots_done ?? 0;
          const pct = total ? Math.round((done / total) * 100) : null;
          const pending = total ? total - done : null;
          return (
            <button key={proj.id} className="fw-pc-card" onClick={() => onOpen(proj.id)}>
              <div className="fw-pc-thumb">
                {proj.thumb_url
                  ? <img src={api.mediaUrl(proj.thumb_url)} alt="" loading="lazy" />
                  : <span className="fw-pc-thumb-ph"><Film size={22} /></span>}
                <span className="fw-pc-aspect">{proj.base_aspect}</span>
                {pct !== null && pct === 100 && (
                  <span className="fw-pc-badge done">已完成</span>
                )}
              </div>

              <div className="fw-pc-info">
                <div className="fw-pc-title">{proj.title}</div>
                <div className="fw-pc-meta">
                  <Clock size={10} /> {fmtSec(proj.total_sec ?? 0)}
                  {proj.episodes_count ? ` · ${proj.episodes_count} 集` : ""}
                </div>

                {pct !== null && (
                  <>
                    <div className="fw-pc-bar-track">
                      <div className="fw-pc-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="fw-pc-prog">
                      <span className={pct === 100 ? "ok" : ""}>AI 生产 {pct}%</span>
                      {pending! > 0 && (
                        <span className="fw-pc-pending">{pending} 个镜头待处理</span>
                      )}
                    </div>
                  </>
                )}

                <div className="fw-pc-mode">{productionModeLabel(proj.production_mode)}</div>
              </div>
            </button>
          );
        })}

        {!shown.length && (
          <div className="fw-pc-empty">
            {projects.length
              ? "没有匹配的项目"
              : "还没有项目，点右上角「新建项目」开始"}
          </div>
        )}
      </div>
    </>
  );
}
