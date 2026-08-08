import { useMemo, useState } from "react";
import { api, ShotInfo } from "../api";

interface Props {
  shots: ShotInfo[];
  episodes: { order: number; title: string }[];
  selectedShotId: string | null;
  onSelect: (shot: ShotInfo) => void;
  onGenerate: (shotIds: string[]) => void;   // 生成/重生成
  onAdopt: (shot: ShotInfo) => void;
  onAdvanced: (shot: ShotInfo) => void;      // R1: 打开高级面板
  generating: boolean;                        // 有 job 在跑
}

const STATUS_META: Record<ShotInfo["status"], { label: string; cls: string }> = {
  pending:    { label: "待生成", cls: "st-pending" },
  prompting:  { label: "提示词", cls: "st-prompting" },
  generating: { label: "生成中", cls: "st-generating" },
  review:     { label: "待审核", cls: "st-review" },
  adopted:    { label: "已采用", cls: "st-adopted" },
  failed:     { label: "失败", cls: "st-failed" },
};

/** 生产看板时间轴一期（T-R0-08）+ 批量覆盖（T-R1-05）：按集分组的镜头状态块。 */
export default function ProductionBoard(p: Props) {
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());

  const byEpisode = useMemo(() => {
    const map = new Map<number, ShotInfo[]>();
    for (const s of p.shots) {
      const arr = map.get(s.episode) ?? [];
      arr.push(s);
      map.set(s.episode, arr);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [p.shots]);

  const pendingIds = p.shots.filter((s) => !s.video_url).map((s) => s.id);

  const toggleSel = (id: string) => {
    setMultiSel((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectEpisode = (ep: number) => {
    const ids = p.shots.filter((s) => s.episode === ep).map((s) => s.id);
    setMultiSel((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((i) => next.has(i));
      ids.forEach((i) => (allIn ? next.delete(i) : next.add(i)));
      return next;
    });
  };

  return (
    <section className="board">
      <div className="board-head">
        <span className="tl-title">生产看板</span>
        <span className="muted">
          {p.shots.length} 镜 ·
          已采用 {p.shots.filter((s) => s.status === "adopted").length} ·
          待审核 {p.shots.filter((s) => s.status === "review").length} ·
          失败 {p.shots.filter((s) => s.status === "failed").length}
        </span>
        <span style={{ flex: 1 }} />
        {multiSel.size > 0 && (
          <>
            <span className="muted">已选 {multiSel.size} 镜</span>
            <button className="btn tiny" disabled={p.generating}
              onClick={() => { p.onGenerate([...multiSel]); setMultiSel(new Set()); }}>
              ▶ 批量重生成
            </button>
            <button className="btn tiny ghost" onClick={() => setMultiSel(new Set())}>清空</button>
          </>
        )}
        <button className="btn primary" disabled={p.generating || !pendingIds.length}
          title="只补未出片的镜头"
          onClick={() => p.onGenerate(pendingIds)}>
          {p.generating ? "生产中…" : `▶ 全部生成 (${pendingIds.length})`}
        </button>
      </div>

      <div className="board-scroll">
        {byEpisode.map(([ep, shots]) => (
          <div key={ep} className="board-ep">
            <div className="board-ep-label" title="点击全选/取消本集（批量覆盖）"
              style={{ cursor: "pointer" }} onClick={() => selectEpisode(ep)}>
              {p.episodes.find((e) => e.order === ep)?.title ?? `第${ep}集`}
              {shots.some((s) => multiSel.has(s.id)) && " ☑"}
            </div>
            <div className="board-row">
              {shots.map((s) => {
                const meta = STATUS_META[s.status];
                return (
                  <div key={s.id}
                    className={`board-shot ${meta.cls} ${p.selectedShotId === s.id ? "sel" : ""} ${multiSel.has(s.id) ? "msel" : ""}`}
                    title={`${s.script_ref}${s.profile_override ? "\n(本镜有策略覆盖)" : ""}\nCtrl+点击=多选`}
                    onClick={(e) => (e.ctrlKey || e.metaKey) ? toggleSel(s.id) : p.onSelect(s)}>
                    {s.video_url ? (
                      <video src={api.mediaUrl(s.video_url)} muted preload="metadata" />
                    ) : (
                      <div className="board-shot-empty">#{s.order}</div>
                    )}
                    <div className="board-shot-info">
                      <span>#{s.order}</span>
                      <span className="board-shot-status">{meta.label}</span>
                    </div>
                    <div className="board-shot-ops">
                      <button title="高级设置（模型/模式/时长/首尾帧）"
                        onClick={(e) => { e.stopPropagation(); p.onAdvanced(s); }}>⚙</button>
                      {s.status === "review" && (
                        <button title="采用" onClick={(e) => { e.stopPropagation(); p.onAdopt(s); }}>✓</button>
                      )}
                      {(s.status === "failed" || s.status === "review" || s.status === "adopted") && (
                        <button title="重新生成" disabled={p.generating}
                          onClick={(e) => { e.stopPropagation(); p.onGenerate([s.id]); }}>↻</button>
                      )}
                      {s.status === "pending" && (
                        <button title="生成本镜" disabled={p.generating}
                          onClick={(e) => { e.stopPropagation(); p.onGenerate([s.id]); }}>▶</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!p.shots.length && (
          <div className="muted pad">先导入剧本并拆解，镜头会出现在这里</div>
        )}
      </div>
    </section>
  );
}
