import { useEffect, useRef, useState } from "react";
import { api, BreakdownOut, JobOut } from "./api";

/** MVP 工作流：剧本优化 → 镜头拆解 → 资产批量生图（job 轮询）。 */
export default function App() {
  const [backendOk, setBackendOk] = useState<boolean | null>(null);

  // 阶段①
  const [raw, setRaw] = useState("");
  const [optimized, setOptimized] = useState("");
  const [optBusy, setOptBusy] = useState(false);
  const [optErr, setOptErr] = useState("");

  // 阶段②
  const [breakdown, setBreakdown] = useState<BreakdownOut | null>(null);
  const [bdBusy, setBdBusy] = useState(false);
  const [bdErr, setBdErr] = useState("");

  // 阶段③
  const [job, setJob] = useState<JobOut | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobErr, setJobErr] = useState("");
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    api.health().then(() => setBackendOk(true)).catch(() => setBackendOk(false));
    return () => { if (pollTimer.current) window.clearInterval(pollTimer.current); };
  }, []);

  const doOptimize = async () => {
    setOptBusy(true); setOptErr("");
    try {
      const r = await api.optimizeScript(raw);
      setOptimized(r.optimized);
    } catch (e) { setOptErr(String(e)); }
    setOptBusy(false);
  };

  const doBreakdown = async () => {
    setBdBusy(true); setBdErr("");
    try {
      const r = await api.breakdownScript(optimized || raw);
      setBreakdown(r);
    } catch (e) { setBdErr(String(e)); }
    setBdBusy(false);
  };

  const doAssetBatch = async () => {
    if (!breakdown) return;
    setJobBusy(true); setJobErr(""); setJob(null);
    // 角色定妆 + 场景参考各生一张
    const items = [
      ...breakdown.characters.map((c) => ({ name: `角色-${c}`, prompt: `角色定妆照：${c}，短剧风格，影棚灯光，正面半身` })),
      ...breakdown.locations.map((l) => ({ name: `场景-${l}`, prompt: `场景参考图：${l}，电影感光线，空镜` })),
    ];
    try {
      const submitted = await api.submitAssetBatch(items);
      setJob(submitted);
      pollTimer.current = window.setInterval(async () => {
        const s = await api.jobStatus(submitted.id);
        setJob(s);
        if (s.status === "done" || s.status === "failed") {
          if (pollTimer.current) window.clearInterval(pollTimer.current);
          setJobBusy(false);
        }
      }, 3000);
    } catch (e) { setJobErr(String(e)); setJobBusy(false); }
  };

  const assets: { name: string; urls?: string[]; error?: string }[] =
    job?.result ? JSON.parse(job.result) : [];

  return (
    <div className="app">
      <h1>FilmWeaver 织影</h1>
      <p className="sub">
        剧本 → 分镜 → 资产 → 成片（MVP）
        {backendOk === true && <span className="status ok"> · 后端已连接</span>}
        {backendOk === false && <span className="status err"> · 无法连接服务器</span>}
      </p>

      <section className="stage">
        <h2><span className="badge">①</span>剧本优化</h2>
        <textarea
          placeholder="粘贴原始剧本或故事大意…"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <button disabled={!raw.trim() || optBusy} onClick={doOptimize}>
          {optBusy ? "优化中…" : "优化剧本"}
        </button>
        {optErr && <div className="status err">{optErr}</div>}
        {optimized && <div className="result">{optimized}</div>}
      </section>

      <section className="stage">
        <h2><span className="badge">②</span>镜头拆解 · 资产盘点</h2>
        <button disabled={(!optimized && !raw.trim()) || bdBusy} onClick={doBreakdown}>
          {bdBusy ? "拆解中…" : "拆解镜头"}
        </button>
        {bdErr && <div className="status err">{bdErr}</div>}
        {breakdown && (
          <>
            <div className="shots">
              {breakdown.shots.map((s) => (
                <div className="shot" key={s.order}>
                  <span className="no">#{s.order}</span>
                  <span>{s.script_ref}</span>
                  <span className="tag">
                    {s.link_to_prev === "transition" ? "⟿ 转场" : "→ 承接"}
                    {s.location ? ` · ${s.location}` : ""}
                  </span>
                </div>
              ))}
            </div>
            <div className="status muted">
              角色：{breakdown.characters.join("、")} ｜ 场景：{breakdown.locations.join("、")}
            </div>
          </>
        )}
      </section>

      <section className="stage">
        <h2><span className="badge">③</span>资产生图（异步任务）</h2>
        <button disabled={!breakdown || jobBusy} onClick={doAssetBatch}>
          {jobBusy ? "生成中…" : "批量生成角色/场景图"}
        </button>
        {jobErr && <div className="status err">{jobErr}</div>}
        {job && (
          <>
            <div className="status muted">
              任务 {job.id} · {job.status} · {job.progress}%
            </div>
            <div className="progress"><div style={{ width: `${job.progress}%` }} /></div>
            <div className="assets">
              {assets.map((a) =>
                a.urls?.length ? (
                  <div className="asset" key={a.name}>
                    <img src={a.urls[0]} alt={a.name} />
                    <div className="name">{a.name}</div>
                  </div>
                ) : a.error ? (
                  <div className="asset" key={a.name}>
                    <div className="name">{a.name}：{a.error.slice(0, 60)}</div>
                  </div>
                ) : null,
              )}
            </div>
          </>
        )}
      </section>

      <section className="stage">
        <h2><span className="badge">④</span>视频生成（待接入）</h2>
        <div className="status muted">
          等待 kegeai 网关的视频模型可用后接入；任务队列与进度机制已就绪。
        </div>
      </section>
    </div>
  );
}