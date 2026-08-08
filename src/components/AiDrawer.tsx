import { useRef, useState } from "react";
import { api, EpisodeInfo, ProjectDetail } from "../api";

export type AiTab = "script" | "breakdown" | "assets";

interface Props {
  open: boolean;
  tab: AiTab;
  onClose: () => void;
  onTab: (t: AiTab) => void;
  projectId: string;
  detail: ProjectDetail | null;
  onRefresh: () => void;      // 操作落库后刷新项目 detail
  onToast: (msg: string) => void;
}

/** AI 工作台抽屉（T-R0-07 项目化版）：剧本导入(分集预览确认)/优化 · 按集拆解 · 资产生成 */
export default function AiDrawer(p: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 导入预览态：解析出的分集，待用户确认
  const [draft, setDraft] = useState<{ text: string; episodes: EpisodeInfo[] } | null>(null);
  // 拆解进行中的集
  const [bdEpisode, setBdEpisode] = useState<number | null>(null);

  if (!p.open) return null;

  const doParse = async (text: string) => {
    setBusy(true); setErr("");
    try {
      const r = await api.importScript(text);  // 仅解析预览
      setDraft({ text, episodes: r.episodes });
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doConfirmImport = async () => {
    if (!draft) return;
    setBusy(true); setErr("");
    try {
      await api.importScript(draft.text, p.projectId, true);  // 落库
      setDraft(null);
      p.onRefresh();
      p.onToast(`✅ 已导入 ${draft.episodes.length} 集`);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doOptimize = async () => {
    const raw = p.detail?.raw_script;
    if (!raw) return;
    setBusy(true); setErr("");
    try {
      await api.optimizeScript(raw, undefined, p.projectId);  // 带 project_id 落库
      p.onRefresh();
      p.onToast("✅ 剧本优化完成");
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doBreakdownEp = async (ep: EpisodeInfo, content: string) => {
    setBdEpisode(ep.order); setErr("");
    try {
      await api.breakdownEpisode(p.projectId, ep.order, content);
      p.onRefresh();
      p.onToast(`✅ ${ep.title} 拆解完成`);
    } catch (e) { setErr(String(e)); }
    finally { setBdEpisode(null); }
  };

  const episodes = p.detail?.episodes ?? [];
  const shotsByEp = new Map<number, number>();
  for (const s of p.detail?.shots ?? []) {
    shotsByEp.set(s.episode, (shotsByEp.get(s.episode) ?? 0) + 1);
  }

  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="drawer-tabs">
            <button className={p.tab === "script" ? "on" : ""} onClick={() => p.onTab("script")}>📝 剧本</button>
            <button className={p.tab === "breakdown" ? "on" : ""} onClick={() => p.onTab("breakdown")}>🎬 拆解</button>
            <button className={p.tab === "assets" ? "on" : ""} onClick={() => p.onTab("assets")}>🖼 资产</button>
          </div>
          <button className="btn ghost" onClick={p.onClose}>✕</button>
        </div>

        <div className="drawer-body">
          {p.tab === "script" && !draft && (
            <>
              <div className="row">
                <button className="btn" onClick={() => fileRef.current?.click()}>📄 导入剧本文件</button>
                <input ref={fileRef} type="file" accept=".txt,.md" hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) doParse(await f.text());
                  }} />
                <span className="muted">支持"第N集/章/话"分集标注，导入后可预览确认</span>
              </div>
              <textarea className="drawer-ta" placeholder="或直接粘贴剧本文本，然后点下方解析…"
                id="fw-paste-area" defaultValue="" />
              <button className="btn primary" disabled={busy}
                onClick={() => {
                  const el = document.getElementById("fw-paste-area") as HTMLTextAreaElement;
                  if (el?.value.trim()) doParse(el.value);
                }}>
                {busy ? "解析中…" : "🔍 解析分集"}
              </button>
              {p.detail?.raw_script && (
                <div className="muted" style={{ marginTop: 10 }}>
                  当前已导入 {episodes.length} 集（共 {p.detail.raw_script.length} 字）
                  <button className="btn tiny" style={{ marginLeft: 8 }} disabled={busy} onClick={doOptimize}>
                    {busy ? "优化中…" : "✨ AI 优化全篇"}
                  </button>
                </div>
              )}
            </>
          )}

          {p.tab === "script" && draft && (
            <>
              <div className="muted">解析出 {draft.episodes.length} 集，确认后保存到项目：</div>
              <div className="shots">
                {draft.episodes.map((ep) => (
                  <div key={ep.order} className="shot">
                    <span className="shot-no">{ep.order}</span>
                    <span style={{ flex: 1 }}>{ep.title}</span>
                    <span className="muted">{ep.word_count} 字</span>
                  </div>
                ))}
              </div>
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
                <button className="btn ghost" onClick={() => setDraft(null)}>重新导入</button>
                <button className="btn primary" disabled={busy} onClick={doConfirmImport}>
                  {busy ? "保存中…" : "✅ 确认导入"}
                </button>
              </div>
            </>
          )}


          {p.tab === "breakdown" && (
            <>
              <div className="muted" style={{ marginBottom: 8 }}>
                按集拆解为镜头（镜头进入底部生产看板）：
              </div>
              {!episodes.length && <div className="muted">先在「📝 剧本」页导入剧本</div>}
              <div className="shots">
                {episodes.map((ep) => {
                  const done = shotsByEp.get(ep.order) ?? 0;
                  return (
                    <div key={ep.order} className="shot">
                      <span className="shot-no">{ep.order}</span>
                      <span style={{ flex: 1 }}>{ep.title}</span>
                      <span className="muted">{done ? `${done} 镜` : "未拆解"}</span>
                      <button className="btn tiny" disabled={bdEpisode !== null}
                        onClick={() => {
                          // 集内容需从 raw_script 再解析（detail 只存元信息）
                          const raw = p.detail?.raw_script ?? "";
                          doBreakdownEp(ep, raw ? extractEpisodeContent(raw, ep.order) : "");
                        }}>
                        {bdEpisode === ep.order ? "拆解中…" : done ? "重新拆解" : "🎞 拆解"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {p.tab === "assets" && (
            <AssetsTab detail={p.detail} onRefresh={p.onRefresh} onToast={p.onToast} />
          )}

          {err && <div className="err">{err}</div>}
        </div>
      </div>
    </div>
  );
}

/** 从整本剧本中提取第 order 集的内容（与后端 smart_split_chapters 同规则的轻量版）。 */
function extractEpisodeContent(raw: string, order: number): string {
  const pattern = /(?:^|\n)\s*(第\s*[一二三四五六七八九十百千零壹贰叁肆伍陆柒捌玖\d]+\s*[集章节话回幕场])[ \t]*[^\n]*/g;
  const matches = [...raw.matchAll(pattern)];
  if (matches.length < 2) return raw;  // 单集/无标注：全文
  const idx = order - 1;
  if (idx < 0 || idx >= matches.length) return raw;
  const start = matches[idx].index! + matches[idx][0].length;
  const end = idx + 1 < matches.length ? matches[idx + 1].index! : raw.length;
  return raw.slice(start, end).trim();
}

/** 资产页签：批量生成角色/场景图（沿用 asset_batch job，结果落库后经 detail 刷新） */
function AssetsTab(p: { detail: ProjectDetail | null; onRefresh: () => void; onToast: (m: string) => void }) {
  const [job, setJob] = useState<{ id: string; progress: number; status: string } | null>(null);
  const timer = useRef<number | null>(null);
  const characters = (p.detail?.assets ?? []).filter((a) => a.kind === "character");
  const locations = (p.detail?.assets ?? []).filter((a) => a.kind === "location");

  const doAssets = async () => {
    const items = [
      ...characters.map((c) => ({ name: `角色-${c.name}`, prompt: `角色立绘, ${c.name}, 全身, 高质量, 短剧风格` })),
      ...locations.map((l) => ({ name: `场景-${l.name}`, prompt: `场景概念图, ${l.name}, 电影感, 高质量` })),
    ];
    if (!items.length) return;
    try {
      const j = await api.submitAssetBatch(items);
      setJob(j);
      timer.current = window.setInterval(async () => {
        const s = await api.jobStatus(j.id);
        setJob(s);
        if (s.status === "done" || s.status === "failed") {
          if (timer.current) clearInterval(timer.current);
          p.onRefresh();
          p.onToast(s.status === "done" ? "✅ 资产生成完成" : `❌ 资产生成失败`);
          setJob(null);
        }
      }, 3000);
    } catch (e) { p.onToast(String(e)); }
  };

  return (
    <>
      <div className="muted" style={{ marginBottom: 8 }}>
        拆解后自动盘点：角色 {characters.length} · 场景 {locations.length}
      </div>
      <button className="btn primary" disabled={!characters.length || job !== null} onClick={doAssets}>
        {job ? `生成中 ${job.progress}%` : "🖼 批量生成角色/场景图"}
      </button>
      {!characters.length && <div className="muted" style={{ marginTop: 10 }}>先完成镜头拆解</div>}
    </>
  );
}