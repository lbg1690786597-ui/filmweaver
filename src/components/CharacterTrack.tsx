import { useState } from "react";
import { api, StageInfo } from "../api";

interface Props {
  stages: StageInfo[];
  maxEp: number;
  onRefresh: () => void;
  onToast: (m: string) => void;
  onDraft: () => void;       // 触发 AI 识别（父组件带 busy 态）
  drafting: boolean;
}

/** R1-2 人物轨：每角色一行，阶段块按集区间宽度比例排布（生产时间轴二期）。 */
export default function CharacterTrack(p: Props) {
  const [editing, setEditing] = useState<StageInfo | null>(null);
  const [cands, setCands] = useState<string[]>([]);
  const [candsBusy, setCandsBusy] = useState(false);

  const byChar = new Map<string, StageInfo[]>();
  for (const s of p.stages) {
    const arr = byChar.get(s.character_name) ?? [];
    arr.push(s);
    byChar.set(s.character_name, arr);
  }

  const save = async (patch: Partial<StageInfo>) => {
    if (!editing) return;
    try {
      await api.patchStage(editing.id, patch);
      p.onRefresh();
      if (patch.status === "confirmed") { setEditing(null); setCands([]); }
    } catch (e) { p.onToast(String(e)); }
  };

  const genCands = async () => {
    if (!editing) return;
    setCandsBusy(true);
    try {
      const r = await api.stageCandidates(editing.id, 4);
      setCands(r.urls);
    } catch (e) { p.onToast(String(e)); }
    finally { setCandsBusy(false); }
  };

  return (
    <section className="ctrack">
      <div className="ctrack-head">
        <span className="tl-title">人物资产时间轴</span>
        <span className="muted">阶段块按集区间生效 · 确认后生成时自动注入定妆图</span>
        <span style={{ flex: 1 }} />
        <button className="btn tiny" disabled={p.drafting} onClick={p.onDraft}>
          {p.drafting ? "识别中…" : "✨ AI 识别换装"}
        </button>
      </div>
      {[...byChar.entries()].map(([name, stages]) => (
        <div key={name} className="ctrack-row">
          <span className="ctrack-name">{name}</span>
          <div className="ctrack-lane">
            {stages.map((s) => (
              <div key={s.id}
                className={`ctrack-stage ${s.status === "confirmed" ? "ok" : ""}`}
                style={{ flexGrow: s.ep_to - s.ep_from + 1 }}
                title={`${s.stage_name} 第${s.ep_from}-${s.ep_to}集\n${s.description ?? ""}`}
                onClick={() => { setEditing(s); setCands([]); }}>
                {s.image_url && <img src={api.mediaUrl(s.image_url)} alt="" />}
                <span className="ctrack-stage-label">
                  {s.stage_name} <em>{s.ep_from}-{s.ep_to}集</em>
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!byChar.size && (
        <div className="muted pad">拆解完成后点「AI 识别换装」生成角色阶段草稿</div>
      )}

      {/* 阶段编辑弹窗：改名/调区间/候选定妆/确认 */}
      {editing && (
        <div className="drawer-mask" onClick={() => setEditing(null)}>
          <div className="wizard" onClick={(e) => e.stopPropagation()}>
            <h2>{editing.character_name} · 造型阶段</h2>
            <label>阶段名
              <input defaultValue={editing.stage_name}
                onBlur={(e) => e.target.value !== editing.stage_name && save({ stage_name: e.target.value })} />
            </label>
            <div className="row">
              <label style={{ flex: 1 }}>起始集
                <input type="number" min={1} defaultValue={editing.ep_from}
                  onBlur={(e) => save({ ep_from: Number(e.target.value) })} />
              </label>
              <label style={{ flex: 1 }}>结束集
                <input type="number" min={1} defaultValue={editing.ep_to}
                  onBlur={(e) => save({ ep_to: Number(e.target.value) })} />
              </label>
            </div>
            <label>造型描述（用于生成定妆图）
              <textarea className="drawer-ta" style={{ minHeight: 70 }}
                defaultValue={editing.description ?? ""}
                onBlur={(e) => save({ description: e.target.value })} />
            </label>
            {/* 定妆图：当前图 + 候选四宫格 */}
            <div className="row">
              <button className="btn" disabled={candsBusy} onClick={genCands}>
                {candsBusy ? "生成候选中…" : "🖼 生成候选定妆图"}
              </button>
              {editing.image_url && <span className="muted">已有定妆图 ✓</span>}
            </div>
            {cands.length > 0 && (
              <div className="cand-grid">
                {cands.map((u) => (
                  <img key={u} src={api.mediaUrl(u)} alt="候选"
                    title="点击设为定妆图"
                    onClick={() => { save({ image_url: u }); setCands([]); p.onToast("✅ 已设为定妆图"); }} />
                ))}
              </div>
            )}
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn ghost" onClick={async () => {
                await api.deleteStage(editing.id); p.onRefresh(); setEditing(null);
              }}>🗑 删除阶段</button>
              <span>
                <button className="btn ghost" onClick={() => setEditing(null)}>关闭</button>
                <button className="btn primary" disabled={!editing.image_url && !cands.length}
                  title={editing.image_url ? "" : "先设定妆图"}
                  onClick={() => save({ status: "confirmed" })}>✅ 确认此阶段</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
