import { useRef, useState } from "react";
import { api, BreakdownOut, JobOut } from "../api";

export type AiTab = "script" | "breakdown" | "assets";

interface Props {
  open: boolean;
  tab: AiTab;
  onClose: () => void;
  onTab: (t: AiTab) => void;
  script: { raw: string; optimized: string };
  onScript: (s: { raw: string; optimized: string }) => void;
  breakdown: BreakdownOut | null;
  onBreakdown: (b: BreakdownOut) => void;
  onAssets: (assets: { name: string; url: string }[]) => void;
}

/** 右侧滑出的 AI 工作台抽屉：剧本优化 / 镜头拆解 / 资产生成 */
export default function AiDrawer(p: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [assetJob, setAssetJob] = useState<JobOut | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);

  if (!p.open) return null;

  const doOptimize = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api.optimizeScript(p.script.raw);
      p.onScript({ ...p.script, optimized: r.optimized });
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doBreakdown = async () => {
    setBusy(true); setErr("");
    try { p.onBreakdown(await api.breakdownScript(p.script.optimized || p.script.raw)); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doAssets = async () => {
    if (!p.breakdown) return;
    setBusy(true); setErr("");
    try {
      const items = [
        ...p.breakdown.characters.map((c) => ({ name: `角色-${c}`, prompt: `角色立绘, ${c}, 全身, 高质量, 短剧风格` })),
        ...p.breakdown.locations.map((l) => ({ name: `场景-${l}`, prompt: `场景概念图, ${l}, 电影感, 高质量` })),
      ];
      const job = await api.submitAssetBatch(items);
      setAssetJob(job);
      timer.current = window.setInterval(async () => {
        const s = await api.jobStatus(job.id);
        setAssetJob(s);
        if (s.status === "done" || s.status === "failed") {
          if (timer.current) clearInterval(timer.current);
          setBusy(false);
          if (s.status === "done" && s.result) {
            const rows = JSON.parse(s.result) as { name: string; urls?: string[] }[];
            p.onAssets(rows.filter((r) => r.urls?.[0]).map((r) => ({ name: r.name, url: r.urls![0] })));
          }
        }
      }, 3000);
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="drawer-tabs">
            <button className={p.tab === "script" ? "on" : ""} onClick={() => p.onTab("script")}>📝 剧本优化</button>
            <button className={p.tab === "breakdown" ? "on" : ""} onClick={() => p.onTab("breakdown")}>🎬 镜头拆解</button>
            <button className={p.tab === "assets" ? "on" : ""} onClick={() => p.onTab("assets")}>🖼 资产生成</button>
          </div>
          <button className="btn ghost" onClick={p.onClose}>✕</button>
        </div>

        <div className="drawer-body">
          {p.tab === "script" && (
            <>
              <div className="row">
                <button className="btn" onClick={() => fileRef.current?.click()}>📄 导入剧本</button>
                <input ref={fileRef} type="file" accept=".txt,.md" hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) p.onScript({ ...p.script, raw: await f.text() });
                  }} />
                <button className="btn primary" disabled={!p.script.raw || busy} onClick={doOptimize}>
                  {busy ? "优化中…" : "✨ AI 优化"}
                </button>
              </div>
              <textarea className="drawer-ta" placeholder="粘贴或导入原始剧本…"
                value={p.script.raw} onChange={(e) => p.onScript({ ...p.script, raw: e.target.value })} />
              <textarea className="drawer-ta" placeholder="优化结果（可继续手改）"
                value={p.script.optimized} onChange={(e) => p.onScript({ ...p.script, optimized: e.target.value })} />
            </>
          )}

          {p.tab === "breakdown" && (
            <>
              <button className="btn primary" disabled={(!p.script.raw && !p.script.optimized) || busy} onClick={doBreakdown}>
                {busy ? "拆解中…" : "🎞 拆解为分镜"}
              </button>
              {p.breakdown && (
                <>
                  <div className="muted" style={{ margin: "10px 0" }}>
                    角色：{p.breakdown.characters.join("、") || "无"} ｜ 场景：{p.breakdown.locations.join("、") || "无"}
                  </div>
                  <div className="shots">
                    {p.breakdown.shots.map((s) => (
                      <div key={s.order} className="shot">
                        <span className="shot-no">#{s.order}</span>
                        <span className="shot-link">{s.link_to_prev === "continuous" ? "承接" : "转场"}</span>
                        <span>{s.script_ref}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {p.tab === "assets" && (
            <>
              <button className="btn primary" disabled={!p.breakdown || busy} onClick={doAssets}>
                {busy ? `生成中 ${assetJob?.progress ?? 0}%` : "🖼 批量生成角色/场景图"}
              </button>
              {!p.breakdown && <div className="muted" style={{ marginTop: 10 }}>请先完成镜头拆解</div>}
              {assetJob?.status === "failed" && <div className="err">生成失败: {assetJob.error}</div>}
              {assetJob?.status === "done" && <div className="muted" style={{ marginTop: 10 }}>已完成，结果在左侧「🖼 资产」页签查看</div>}
            </>
          )}

          {err && <div className="err">{err}</div>}
        </div>
      </div>
    </div>
  );
}