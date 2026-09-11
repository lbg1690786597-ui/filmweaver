/**
 * SceneCanonDialog — 场景名归一（U3）
 *
 * ## 这个面板要解决的问题
 *
 * 剧本里同一个物理空间在各集常写成好几种写法（「日 内 楚家公馆-客厅」/
 * 「楚家公馆 客厅」/「1-3 夜 内 楚家公馆 客厅」）。归一表（`scene_aliases`）决定
 * 哪些写法算**同一个空间**，而它是服装继承（scene_bound 造型）与场景基准帧共享的判据。
 * 在此之前，归一只在 `stages_draft` 内部自动跑一次，用户既看不见也改不动 ——
 * 归错了只能整段重跑。
 *
 * ## 为什么是「预览 + 逐组确认」，而不是一个「归一」按钮
 *
 * 归一里有**不可逆**的一段：同一归一名下的多行 `Asset(kind="location")` 会被合并成
 * 一行，多余那行直接删掉 —— 而它可能已经出过图、花过钱。所以：
 *
 *   · 打开面板**不自动跑 AI**（那是白花一次模型调用，也等于替用户做了决定）；
 *   · 预览走 `POST /scenes/preview`，**一个字都不写库**；
 *   · 确认是**逐组**的（`applySceneGroups` 每次只提交一组），并且后端带
 *     `scoped_assets` —— 确认一组不会顺带收敛用户从没看过的其它组；
 *   · 会删资产行的组必须先过一道 `window.confirm`，文案里点名删的是哪一行、有没有图。
 *
 * 判断逻辑全在 `sceneGroups.ts`（纯函数，`scripts/verify-scene-canon.ts` 逐条钉住）；
 * 这个文件只负责把它渲染出来 + 发请求。
 */
import { useEffect, useState } from "react";
import { api, ScenePreviewGroup, SceneGroup } from "../../api";
import {
  consequenceText, droppedAssets, groupRisk, groupSummary, mergedGroups,
  splitCanonical, splitPreview, confirmText,
} from "./sceneGroups";
import "./SceneCanonDialog.css";

interface Props {
  projectId: string;
  onClose: () => void;
  onToast: (m: string) => void;
  /** 归一改了之后资产/服装继承都会变，父级要重拉 */
  onChanged: () => void;
}

const RISK_LABEL: Record<string, string> = {
  asset: "⚠️ 不可逆",
  override: "⚠️ 覆盖手改",
  alias: "只改映射",
  none: "无变化",
};

export default function SceneCanonDialog(p: Props) {
  const [cur, setCur] = useState<SceneGroup[] | null>(null);
  const [preview, setPreview] = useState<ScenePreviewGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState(false);
  /** 正在提交的组（canonical），用于禁用那一行的按钮 */
  const [busy, setBusy] = useState<string | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const reloadCurrent = async () => {
    try {
      const r = await api.listScenes(p.projectId);
      setCur(r.scenes);
    } catch (e) { p.onToast(`读取场景归一失败：${String(e)}`); }
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await api.listScenes(p.projectId);
        if (alive) setCur(r.scenes);
      } catch (e) { if (alive) p.onToast(`读取场景归一失败：${String(e)}`); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.projectId]);

  /** 让 AI 找可合并的组 —— 用户点了才跑（一次文本调用，不出图） */
  const doPropose = async () => {
    setProposing(true);
    try {
      const r = await api.previewSceneCanon(p.projectId);
      setPreview(r.groups);
      const { actionable } = splitPreview(r.groups);
      p.onToast(actionable.length
        ? `找到 ${actionable.length} 组可合并（还没有写任何东西，请逐组确认）`
        : "没有可合并的写法 —— 当前归一已经是最优了");
    } catch (e) { p.onToast(`归一建议失败：${String(e)}`); }
    finally { setProposing(false); }
  };

  /** 确认一组：不可逆/覆盖手改的先过二次确认 */
  const doApply = async (g: ScenePreviewGroup) => {
    const warn = confirmText(g);
    if (warn && !window.confirm(warn)) return;
    setBusy(g.canonical);
    try {
      const r = await api.applySceneGroups(p.projectId, [{
        canonical: g.canonical, members: g.members.map((m) => m.raw_name),
      }]);
      const del = r.assets.deleted.length;
      p.onToast(`✅ 已合并为「${g.canonical}」：${r.updated} 个写法改了映射`
        + (del ? `，删掉 ${del} 行重复场景资产` : ""));
      // 这一组已落库 → 重新预览剩下的（后端会把它标成 changed=false），
      // 并刷新现状列表。刻意不本地改 state：落库结果由后端说，别猜。
      await reloadCurrent();
      try {
        const pv = await api.previewSceneCanon(p.projectId);
        setPreview(pv.groups);
      } catch { /* 建议刷新失败不影响已完成的合并，现状列表已经更新了 */ }
      p.onChanged();
    } catch (e) { p.onToast(`合并失败：${String(e)}`); }
    finally { setBusy(null); }
  };

  /** 把一个写法从当前组里拆出去（误合并的修法） */
  const doSplit = async (rawName: string) => {
    if (!window.confirm(`把「${rawName}」从当前归一组里拆出去？\n\n`
      + "它会变成独立的空间：服装继承与场景基准帧不再与原组共享。\n"
      + "镜头里的原名不变，随时可以再合回去。")) return;
    setBusy(rawName);
    try {
      await api.patchSceneAlias(p.projectId, rawName, splitCanonical(rawName));
      p.onToast(`✅ 已把「${rawName}」拆为独立场景`);
      await reloadCurrent();
      p.onChanged();
    } catch (e) { p.onToast(`拆分失败：${String(e)}`); }
    finally { setBusy(null); }
  };

  const merged = cur ? mergedGroups(cur) : [];
  const split = preview ? splitPreview(preview) : null;

  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="wizard wizard-lg sc-dlg" onClick={(e) => e.stopPropagation()}>
        <h2>🔗 场景名归一</h2>

        <div className="sc-intro">
          同一个空间在各集里可能写成好几种写法。归一决定哪些写法算<b>同一个空间</b> ——
          它是<b>服装继承</b>（限定场景的造型）与<b>场景基准帧共享</b>的判据。
          <br />
          镜头里的场景原名<b>永远不会被改写</b>，归一只是一层映射，改错了可以拆回来。
        </div>

        {/* ───────── 现状 ───────── */}
        <div className="sc-h">当前已合并的组{cur ? `（${merged.length} / 共 ${cur.length} 个场景）` : ""}</div>
        {loading && <div className="sc-empty">读取中…</div>}
        {!loading && merged.length === 0 && (
          <div className="sc-empty">
            还没有任何写法被合并 —— 每个写法各自是一个独立空间。
          </div>
        )}
        {merged.map((g) => (
          <div key={`cur-${g.canonical}`} className="sc-cur">
            <div className="sc-cur-h">
              <b>{g.canonical}</b>
              <span className="muted">{g.members.length} 种写法 · {g.shots} 镜</span>
            </div>
            {g.members.map((m) => (
              <div key={m.raw_name} className="sc-mem">
                <span className="sc-mem-name">{m.raw_name}</span>
                <span className="muted">{m.shots} 镜</span>
                <span className={`sc-src ${m.source === "manual" ? "manual" : ""}`}>
                  {m.source === "manual" ? "手改" : "自动"}
                </span>
                <button className="btn ghost sc-mini" disabled={busy === m.raw_name}
                  title="改回它自己的名字：不再与本组共享服装/场景基准帧"
                  onClick={() => { void doSplit(m.raw_name); }}>
                  {busy === m.raw_name ? "⏳" : "拆出去"}
                </button>
              </div>
            ))}
          </div>
        ))}

        {/* ───────── AI 建议（按需触发） ───────── */}
        <div className="sc-h">找可以合并的写法</div>
        <div className="sc-row">
          <button className="btn" disabled={proposing || loading}
            onClick={() => { void doPropose(); }}
            title="一次文本模型调用，不出图。只算不写，结果要你逐组确认才生效">
            {proposing ? "⏳ 分析中…" : preview ? "🤖 重新分析" : "🤖 让 AI 找可合并的场景"}
          </button>
          <span className="muted sc-note">一次文本调用，不出图；结果只是建议，不会自动生效</span>
        </div>

        {split && split.actionable.length === 0 && (
          <div className="sc-empty">没有可合并的写法 —— 当前归一已经是最优了。</div>
        )}

        {split?.actionable.map((g) => {
          const risk = groupRisk(g);
          const cons = consequenceText(g);
          const drop = droppedAssets(g).filter((d) => !d.deleted);
          return (
            <div key={`pv-${g.canonical}`} className={`sc-pv risk-${risk}`}>
              <div className="sc-pv-h">
                <b>{g.canonical}</b>
                <span className={`sc-risk ${risk}`}>{RISK_LABEL[risk]}</span>
                <span className="muted">{groupSummary(g)}</span>
              </div>
              {g.members.map((m) => (
                <div key={m.raw_name} className={`sc-mem ${m.will_change ? "chg" : ""}`}>
                  <span className="sc-mem-name">{m.raw_name}</span>
                  <span className="muted">{m.shots} 镜</span>
                  {m.will_change
                    ? <span className="sc-arrow">现在归入「{m.current_canonical}」→ 改为「{g.canonical}」</span>
                    : <span className="muted">已经是「{m.current_canonical}」，不变</span>}
                </div>
              ))}
              {cons && <div className="sc-cons">{cons.replace(/\*\*/g, "")}</div>}
              {drop.length > 0 && (
                <div className="sc-keep muted">
                  保留资产行「{(g.asset_merges as { keep: { name: string } }).keep.name}」，
                  被删行的图会并到它上面（保留行原本没图时才补）。
                </div>
              )}
              <div className="sc-pv-act">
                <button className={`btn ${risk === "asset" ? "danger" : "primary"}`}
                  disabled={busy !== null}
                  onClick={() => { void doApply(g); }}>
                  {busy === g.canonical ? "⏳ 合并中…" : "✓ 确认这一组"}
                </button>
              </div>
            </div>
          );
        })}

        {split && split.unchanged.length > 0 && (
          <div className="sc-unchanged">
            <button className="btn ghost sc-mini"
              onClick={() => setShowUnchanged((v) => !v)}>
              {showUnchanged ? "收起" : "展开"}
            </button>
            <span className="muted">
              另有 {split.unchanged.length} 组已是当前状态（确认它们不会有任何变化）
            </span>
            {showUnchanged && (
              <div className="sc-unchanged-list muted">
                {split.unchanged.map((g) => (
                  <div key={`un-${g.canonical}`}>
                    {g.canonical} · {g.members.length} 种写法 · {g.shots} 镜
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={p.onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
