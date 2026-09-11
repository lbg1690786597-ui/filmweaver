/**
 * ProjectCards — 项目卡片网格（PLAN §17，Phase 6）
 *
 * 卡片要显示：缩略图 / 名称 / 比例 / 时长 / AI 生产进度 / 待处理镜头数。
 *
 * TB-11 已落地：`GET /v2/projects` 直接返回 shots_total / shots_done /
 * total_sec / thumb_url，原先"每个项目再拉一次 detail"的 N+1 补拉已删除
 * （21 个项目 = 21 个请求 → 1 个请求）。
 *
 * ## 排序 / 检索 / 改名 / 删除（2026-09-10）
 *
 * 排序与过滤的**规则**全在 `projectSort.ts`（纯函数，被
 * `scripts/verify-project-list.ts` 钉住），本文件只负责接线与交互。
 *
 * 删除是**两段式**（用户 2026-09-10 裁定）：删除 = 移入回收站（打墓碑，
 * 数据与磁盘文件一个不动，可一键恢复）；回收站里再点「彻底删除」才真删库行 +
 * 清该项目独占的文件。中间隔一次视图切换是刻意的——不可逆操作只靠一个
 * 确认框挡不住手快。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search, Film, Clock, Pencil, Trash2, RotateCcw, ArrowUp, ArrowDown, X,
} from "lucide-react";
import { api } from "../../api";
import type { ProjectInfo } from "../../api";
import { fmtSec } from "../../types/timeline";
import { productionModeLabel } from "../../lib/modelLabels";
import { tauriSnapshotIO } from "../../lib/persistIO";
import { removeProjectCache } from "../../lib/mediaCache";
import { IS_TAURI } from "../../lib/isTauri";
import {
  SORT_KEYS, filterProjects, fmtBytes, sortProjects,
  type SortDir, type SortKey,
} from "./projectSort";
import "./ProjectCards.css";

interface Props {
  projects: ProjectInfo[];
  onOpen: (id: string) => void;
  /** 改名/删除/恢复后重新拉列表。ProjectList 持有数据，这里只发号施令。 */
  onRefresh?: () => void;
}

/** 排序偏好记在本地：用户挑了"按创建时间"，下次进来不该被打回默认。 */
const SORT_LS = "fw_proj_sort";

function loadSort(): { key: SortKey; dir: SortDir } {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_LS) || "null");
    const key = SORT_KEYS.find((s) => s.key === raw?.key)?.key;
    if (key) return { key, dir: raw.dir === "asc" ? "asc" : "desc" };
  } catch { /* 本地值坏了就用默认，不值得报错打扰用户 */ }
  return { key: "active", dir: "desc" };
}

export default function ProjectCards({ projects, onOpen, onRefresh }: Props) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(loadSort);
  /** 回收站视图。它的数据是**另拉一次**的（后端 trash 与在用列表互斥）。 */
  const [inTrash, setInTrash] = useState(false);
  const [trashed, setTrashed] = useState<ProjectInfo[]>([]);
  /** 正在就地改名的项目 id */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    try { localStorage.setItem(SORT_LS, JSON.stringify(sort)); } catch { /* 隐私模式下写不了，无所谓 */ }
  }, [sort]);

  const loadTrash = useCallback(() => {
    api.listProjects(true)
      .then((r) => setTrashed(r.projects))
      .catch((e) => setErr(String(e)));
  }, []);

  // 回收站条数常驻显示（不进回收站也看得见"里面有 3 个"），
  // 否则用户删完项目就再也想不起来它去哪了。
  useEffect(() => { loadTrash(); }, [loadTrash, projects]);

  const shown = useMemo(
    () => sortProjects(filterProjects(projects, q), sort.key, sort.dir),
    [projects, q, sort],
  );

  const refresh = useCallback(() => {
    onRefresh?.();
    loadTrash();
  }, [onRefresh, loadTrash]);

  const startRename = (proj: ProjectInfo) => {
    setEditing(proj.id);
    setDraft(proj.title);
  };

  const commitRename = async (id: string) => {
    const title = draft.trim();
    setEditing(null);
    const before = projects.find((p) => p.id === id)?.title;
    if (!title || title === before) return;   // 没改就当没发生，不打一次空请求
    setBusy(id); setErr("");
    try {
      await api.renameProject(id, title);
      refresh();
    } catch (e) { setErr(`改名失败：${e}`); }
    finally { setBusy(null); }
  };

  const doTrash = async (proj: ProjectInfo) => {
    if (!window.confirm(
      `将「${proj.title}」移入回收站？\n\n` +
      `项目会从列表里消失，但数据与已生成的图/视频一个不动，随时可以恢复。`)) return;
    setBusy(proj.id); setErr("");
    try {
      await api.trashProject(proj.id);
      refresh();
    } catch (e) { setErr(`删除失败：${e}`); }
    finally { setBusy(null); }
  };

  const doRestore = async (proj: ProjectInfo) => {
    setBusy(proj.id); setErr("");
    try {
      await api.restoreProject(proj.id);
      refresh();
    } catch (e) { setErr(`恢复失败：${e}`); }
    finally { setBusy(null); }
  };

  /** 彻底删除：先拉预演，把确切的文件数与体积写进确认框再问。 */
  const doPurge = async (proj: ProjectInfo) => {
    setBusy(proj.id); setErr("");
    try {
      const pv = await api.purgePreview(proj.id);
      const rows = Object.entries(pv.rows)
        .map(([t, n]) => `${t} ${n}`).join(" / ") || "无数据行";
      const shared = pv.shared_skipped
        ? `\n另有 ${pv.shared_skipped} 个文件被其它项目共用，将保留。` : "";
      if (!window.confirm(
        `彻底删除「${proj.title}」？\n\n` +
        `· 将永久删除 ${pv.files} 个文件，释放约 ${fmtBytes(pv.bytes)}\n` +
        `· 将删除数据行：${rows}${shared}\n` +
        `· 导出成片（outputs）不在清理范围内，请用设置里的「清理缓存」\n\n` +
        `此操作不可恢复。`)) { setBusy(null); return; }

      const r = await api.purgeProject(proj.id);

      // 本机残留：不清的话客户端上会永久留一份指向已不存在项目的孤儿缓存，
      // 而且用户再没有任何界面能定位到它。
      if (localStorage.getItem("fw_project") === proj.id) {
        localStorage.removeItem("fw_project");
      }
      if (IS_TAURI) {
        await tauriSnapshotIO.remove(proj.id).catch(() => {});
        await removeProjectCache(proj.id);
      }
      refresh();
      setErr(`已彻底删除「${proj.title}」：${r.files_deleted} 个文件，释放 ${fmtBytes(r.bytes_freed)}`);
    } catch (e) { setErr(`彻底删除失败：${e}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="fw-pc-wrap">
      <div className="fw-pc-bar">
        <div className="fw-pc-search">
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="搜索项目名 / 模式 / 画幅…" spellCheck={false} />
          {!!q && (
            <button className="fw-pc-clear" title="清空" onClick={() => setQ("")}>
              <X size={12} />
            </button>
          )}
        </div>

        <select className="fw-pc-sort" value={sort.key}
          title="排序方式"
          onChange={(e) => setSort((s) => ({ ...s, key: e.target.value as SortKey }))}>
          {SORT_KEYS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <button className="fw-pc-dir"
          title={sort.dir === "desc" ? "当前：由大到小（点击切换）" : "当前：由小到大（点击切换）"}
          onClick={() => setSort((s) => ({ ...s, dir: s.dir === "desc" ? "asc" : "desc" }))}>
          {sort.dir === "desc" ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
        </button>

        <button className={`fw-pc-trashbtn ${inTrash ? "on" : ""}`}
          title="回收站"
          onClick={() => { setInTrash((v) => !v); setEditing(null); }}>
          <Trash2 size={13} />
          回收站{trashed.length ? ` ${trashed.length}` : ""}
        </button>

        <span className="fw-pc-count">
          {inTrash ? `${trashed.length} 个已删除` : `${shown.length} / ${projects.length} 个项目`}
        </span>
      </div>

      {!!err && (
        <div className="fw-pc-err" onClick={() => setErr("")} title="点击关闭">{err}</div>
      )}

      {inTrash ? (
        <div className="fw-pc-scroll">
          <div className="fw-pc-trashlist">
            {trashed.map((proj) => (
              <div key={proj.id} className="fw-pc-trashrow">
                <div className="fw-pc-trashinfo">
                  <div className="fw-pc-title">{proj.title}</div>
                  <div className="fw-pc-meta">
                    删除于 {proj.deleted_at?.replace("T", " ").replace(/(\+.*|Z)$/, "") ?? "未知"}
                    {" · "}{productionModeLabel(proj.production_mode)}
                    {proj.shots_total ? ` · ${proj.shots_total} 镜` : ""}
                  </div>
                </div>
                <button className="btn ghost" disabled={busy === proj.id}
                  onClick={() => doRestore(proj)}>
                  <RotateCcw size={12} /> 恢复
                </button>
                <button className="btn danger" disabled={busy === proj.id}
                  onClick={() => doPurge(proj)}>
                  <Trash2 size={12} /> 彻底删除
                </button>
              </div>
            ))}
            {!trashed.length && (
              <div className="fw-pc-empty">回收站是空的。删除项目会先放进这里，可随时恢复。</div>
            )}
          </div>
        </div>
      ) : (
      <div className="fw-pc-scroll">
        <div className="fw-pc-grid">
        {shown.map((proj) => {
          const total = proj.shots_total ?? 0;
          const done = proj.shots_done ?? 0;
          const pct = total ? Math.round((done / total) * 100) : null;
          const pending = total ? total - done : null;
          const isEditing = editing === proj.id;
          return (
            // 外层是 div 而不是 button：卡片里要放"改名/删除"两个按钮，
            // <button> 套 <button> 是非法 HTML（React 也会警告），且点内层
            // 必然冒泡到打开项目。换成 role=button + tabIndex 后要自己补
            // 键盘可达性——回车/空格打开项目，与原生按钮行为对齐。
            <div key={proj.id} className="fw-pc-card" role="button" tabIndex={0}
              onClick={() => { if (!isEditing) onOpen(proj.id); }}
              onKeyDown={(e) => {
                if (isEditing) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(proj.id);
                }
              }}>
              <div className="fw-pc-thumb">
                {proj.thumb_url
                  ? <img src={api.mediaUrl(proj.thumb_url)} alt="" loading="lazy" />
                  : <span className="fw-pc-thumb-ph"><Film size={22} /></span>}
                <span className="fw-pc-aspect">{proj.base_aspect}</span>
                {pct !== null && pct === 100 && (
                  <span className="fw-pc-badge done">已完成</span>
                )}
                {/* 常显（半透明），hover 才变亮 —— 藏进 hover 的按钮在用户
                    眼里等于不存在，这个项目已经栽过一次。 */}
                <div className="fw-pc-acts" onClick={(e) => e.stopPropagation()}>
                  <button title="重命名" disabled={busy === proj.id}
                    onClick={(e) => { e.stopPropagation(); startRename(proj); }}>
                    <Pencil size={12} />
                  </button>
                  <button title="移入回收站" className="danger" disabled={busy === proj.id}
                    onClick={(e) => { e.stopPropagation(); doTrash(proj); }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              <div className="fw-pc-info">
                {isEditing ? (
                  <div className="fw-pc-rename" onClick={(e) => e.stopPropagation()}>
                    <input value={draft} autoFocus spellCheck={false}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(proj.id)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitRename(proj.id);
                        if (e.key === "Escape") setEditing(null);
                      }} />
                    <span className="fw-pc-hint">
                      改名只影响此后新生成内容的语境，已生成的图与视频不变
                    </span>
                  </div>
                ) : (
                  <div className="fw-pc-title">{proj.title}</div>
                )}
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
            </div>
          );
        })}

        {!shown.length && (
          <div className="fw-pc-empty">
            {projects.length
              ? "没有匹配的项目"
              : "还没有项目，点右上角「新建项目」开始"}
          </div>
        )}
        </div>{/* .fw-pc-grid */}
      </div>
      )}
    </div>  /* .fw-pc-wrap */
  );
}
