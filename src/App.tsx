import { useEffect, useRef, useState } from "react";
import { api, APP_VERSION, BreakdownOut, JobOut, UploadOut } from "./api";

/** 六阶段导航（对齐 PLAN 的产线流程） */
const STAGES = [
  { key: "script", label: "① 剧本优化" },
  { key: "breakdown", label: "② 镜头拆解" },
  { key: "assets", label: "③ 资产生成" },
  { key: "import", label: "④ 素材导入" },
  { key: "timeline", label: "⑤ 时间轴" },
  { key: "export", label: "⑥ 成片导出" },
] as const;
type StageKey = (typeof STAGES)[number]["key"];

interface Clip {
  id: string;
  name: string;
  url: string;
  size: number;
  kind: "video" | "audio" | "image" | "other";
}

function clipKind(name: string): Clip["kind"] {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mov", "mkv", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "aac", "m4a"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "image";
  return "other";
}

export default function App() {
  // ---- 主题（持久化到 localStorage）----
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("fw_theme") as "dark" | "light") || "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("fw_theme", theme);
  }, [theme]);

  // ---- 检查更新 ----
  const [updateMsg, setUpdateMsg] = useState("");
  const checkUpdate = async () => {
    setUpdateMsg("检查中…");
    try {
      const latest = await api.appLatest();
      if (latest.version !== APP_VERSION) {
        setUpdateMsg(`发现新版本 v${latest.version}（当前 v${APP_VERSION}）：${latest.notes}`);
        window.open(latest.download_url, "_blank");
      } else {
        setUpdateMsg(`已是最新版本 v${APP_VERSION}`);
      }
    } catch (e) {
      setUpdateMsg(`检查失败: ${e}`);
    }
  };

  // ---- 后端连接状态 ----
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  useEffect(() => {
    api.health().then(() => setBackendOk(true)).catch(() => setBackendOk(false));
  }, []);

  const [stage, setStage] = useState<StageKey>("script");

  // ---- ① 剧本优化 ----
  const [raw, setRaw] = useState("");
  const [optimized, setOptimized] = useState("");
  const [optBusy, setOptBusy] = useState(false);
  const [optErr, setOptErr] = useState("");
  const scriptFileRef = useRef<HTMLInputElement>(null);
  const doOptimize = async () => {
    setOptBusy(true); setOptErr("");
    try { setOptimized((await api.optimizeScript(raw)).optimized); }
    catch (e) { setOptErr(String(e)); }
    finally { setOptBusy(false); }
  };
  const importScriptFile = async (f: File) => {
    setRaw(await f.text());
  };

  // ---- ② 镜头拆解 ----
  const [breakdown, setBreakdown] = useState<BreakdownOut | null>(null);
  const [bdBusy, setBdBusy] = useState(false);
  const [bdErr, setBdErr] = useState("");
  const doBreakdown = async () => {
    setBdBusy(true); setBdErr("");
    try { setBreakdown(await api.breakdownScript(optimized || raw)); }
    catch (e) { setBdErr(String(e)); }
    finally { setBdBusy(false); }
  };

  // ---- ③ 资产批量生成 ----
  const [assetJob, setAssetJob] = useState<JobOut | null>(null);
  const [assetBusy, setAssetBusy] = useState(false);
  const [assetErr, setAssetErr] = useState("");
  const pollTimer = useRef<number | null>(null);
  const doAssetBatch = async () => {
    if (!breakdown) return;
    setAssetBusy(true); setAssetErr("");
    try {
      const items = [
        ...breakdown.characters.map((c) => ({ name: `角色-${c}`, prompt: `角色立绘, ${c}, 全身, 高质量, 短剧风格` })),
        ...breakdown.locations.map((l) => ({ name: `场景-${l}`, prompt: `场景概念图, ${l}, 电影感, 高质量` })),
      ];
      const submitted = await api.submitAssetBatch(items);
      setAssetJob(submitted);
      pollTimer.current = window.setInterval(async () => {
        const s = await api.jobStatus(submitted.id);
        setAssetJob(s);
        if (s.status === "done" || s.status === "failed") {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setAssetBusy(false);
        }
      }, 3000);
    } catch (e) { setAssetErr(String(e)); setAssetBusy(false); }
  };

  // ---- ④ 素材导入 ----
  const [clips, setClips] = useState<Clip[]>([]);
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState("");
  const mediaFileRef = useRef<HTMLInputElement>(null);
  const importMedia = async (files: FileList) => {
    setUploading(true); setUpErr("");
    try {
      for (const f of Array.from(files)) {
        const r: UploadOut = await api.uploadMedia(f);
        setClips((prev) => [...prev, { id: r.file_id, name: r.name, url: r.url, size: r.size, kind: clipKind(r.name) }]);
      }
    } catch (e) { setUpErr(String(e)); }
    finally { setUploading(false); }
  };

  // ---- ⑤ 时间轴（排序/删除）----
  const move = (i: number, dir: -1 | 1) => {
    setClips((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const removeClip = (i: number) => setClips((prev) => prev.filter((_, k) => k !== i));

  // ---- ⑥ 成片导出（自动拼接）----
  const [aspect, setAspect] = useState<"9:16" | "16:9">("9:16");
  const [composeJob, setComposeJob] = useState<JobOut | null>(null);
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeErr, setComposeErr] = useState("");
  const composeTimer = useRef<number | null>(null);
  const doCompose = async () => {
    const videos = clips.filter((c) => c.kind === "video");
    if (!videos.length) { setComposeErr("时间轴上没有视频素材"); return; }
    setComposeBusy(true); setComposeErr(""); setComposeJob(null);
    try {
      const [w, h] = aspect === "9:16" ? [1080, 1920] : [1920, 1080];
      const submitted = await api.submitCompose(videos.map((c) => c.url), { width: w, height: h });
      setComposeJob(submitted);
      composeTimer.current = window.setInterval(async () => {
        const s = await api.jobStatus(submitted.id);
        setComposeJob(s);
        if (s.status === "done" || s.status === "failed") {
          if (composeTimer.current) clearInterval(composeTimer.current);
          setComposeBusy(false);
        }
      }, 3000);
    } catch (e) { setComposeErr(String(e)); setComposeBusy(false); }
  };
  const filmUrl = composeJob?.status === "done" && composeJob.result
    ? api.mediaUrl(JSON.parse(composeJob.result).url) : null;

  return (
    <div className="app">
      {/* 顶栏 */}
      <header className="topbar">
        <div className="brand">🎬 FilmWeaver 织影 <span className="ver">v{APP_VERSION}</span></div>
        <div className="topbar-right">
          <span className={`dot ${backendOk === null ? "" : backendOk ? "ok" : "bad"}`} />
          <span className="muted">{backendOk === null ? "连接中…" : backendOk ? "服务在线" : "服务离线"}</span>
          <button className="btn ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "🌙 深色" : "☀️ 浅色"}
          </button>
          <button className="btn ghost" onClick={checkUpdate}>⟳ 检查更新</button>
        </div>
      </header>
      {updateMsg && <div className="banner">{updateMsg}</div>}

      <div className="body">
        {/* 左侧六阶段导航 */}
        <nav className="sidenav">
          {STAGES.map((s) => (
            <button key={s.key} className={`nav-item ${stage === s.key ? "active" : ""}`} onClick={() => setStage(s.key)}>
              {s.label}
            </button>
          ))}
        </nav>

        <main className="content">
          {stage === "script" && (
            <section className="panel">
              <h2>剧本优化</h2>
              <div className="row">
                <button className="btn" onClick={() => scriptFileRef.current?.click()}>📄 导入剧本文件</button>
                <input ref={scriptFileRef} type="file" accept=".txt,.md" hidden
                  onChange={(e) => e.target.files?.[0] && importScriptFile(e.target.files[0])} />
                <button className="btn primary" disabled={!raw || optBusy} onClick={doOptimize}>
                  {optBusy ? "优化中…" : "✨ AI 优化"}
                </button>
              </div>
              <div className="cols">
                <textarea placeholder="粘贴或导入原始剧本…" value={raw} onChange={(e) => setRaw(e.target.value)} />
                <textarea placeholder="优化结果" value={optimized} onChange={(e) => setOptimized(e.target.value)} />
              </div>
              {optErr && <div className="err">{optErr}</div>}
            </section>
          )}

          {stage === "breakdown" && (
            <section className="panel">
              <h2>镜头拆解</h2>
              <button className="btn primary" disabled={(!raw && !optimized) || bdBusy} onClick={doBreakdown}>
                {bdBusy ? "拆解中…" : "🎞 拆解为分镜"}
              </button>
              {bdErr && <div className="err">{bdErr}</div>}
              {breakdown && (
                <>
                  <div className="muted" style={{ margin: "8px 0" }}>
                    角色：{breakdown.characters.join("、") || "无"} ｜ 场景：{breakdown.locations.join("、") || "无"}
                  </div>
                  <div className="shots">
                    {breakdown.shots.map((s) => (
                      <div key={s.order} className="shot">
                        <span className="shot-no">#{s.order}</span>
                        <span className="shot-link">{s.link_to_prev === "continuous" ? "承接" : "转场"}</span>
                        <span>{s.script_ref}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {stage === "assets" && (
            <section className="panel">
              <h2>资产生成（角色/场景图）</h2>
              <button className="btn primary" disabled={!breakdown || assetBusy} onClick={doAssetBatch}>
                {assetBusy ? `生成中 ${assetJob?.progress ?? 0}%` : "🖼 批量生成资产"}
              </button>
              {!breakdown && <div className="muted">请先完成镜头拆解</div>}
              {assetErr && <div className="err">{assetErr}</div>}
              {assetJob?.result && (
                <div className="asset-grid">
                  {JSON.parse(assetJob.result).map((r: { name: string; urls?: string[]; error?: string }) => (
                    <div key={r.name} className="asset-card">
                      {r.urls?.[0] ? <img src={r.urls[0]} alt={r.name} /> : <div className="err">{r.error}</div>}
                      <div className="muted">{r.name}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {stage === "import" && (
            <section className="panel">
              <h2>素材导入</h2>
              <div className="row">
                <button className="btn primary" disabled={uploading} onClick={() => mediaFileRef.current?.click()}>
                  {uploading ? "上传中…" : "📂 导入本地素材（视频/音频/图片）"}
                </button>
                <input ref={mediaFileRef} type="file" multiple hidden
                  accept=".mp4,.mov,.mkv,.webm,.mp3,.wav,.aac,.m4a,.png,.jpg,.jpeg,.webp,.srt"
                  onChange={(e) => e.target.files && importMedia(e.target.files)} />
              </div>
              {upErr && <div className="err">{upErr}</div>}
              <div className="clip-list">
                {clips.map((c) => (
                  <div key={c.id} className="clip-row">
                    <span className="clip-icon">{c.kind === "video" ? "🎬" : c.kind === "audio" ? "🎵" : "🖼"}</span>
                    <span className="clip-name">{c.name}</span>
                    <span className="muted">{(c.size / 1048576).toFixed(1)}MB</span>
                  </div>
                ))}
                {!clips.length && <div className="muted">尚未导入素材</div>}
              </div>
            </section>
          )}

          {stage === "timeline" && (
            <section className="panel">
              <h2>时间轴（按顺序拼接）</h2>
              <div className="timeline">
                {clips.filter((c) => c.kind === "video").length === 0 && (
                  <div className="muted">时间轴为空，请先到「素材导入」上传视频</div>
                )}
                {clips.map((c, i) => c.kind === "video" && (
                  <div key={c.id} className="tl-block">
                    <video src={api.mediaUrl(c.url)} muted preload="metadata" />
                    <div className="tl-meta">
                      <span className="tl-name">{i + 1}. {c.name}</span>
                      <div className="tl-ops">
                        <button className="btn tiny" onClick={() => move(i, -1)}>←</button>
                        <button className="btn tiny" onClick={() => move(i, 1)}>→</button>
                        <button className="btn tiny danger" onClick={() => removeClip(i)}>✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {stage === "export" && (
            <section className="panel">
              <h2>成片导出（自动拼接）</h2>
              <div className="row">
                <label className="muted">画幅：</label>
                <select value={aspect} onChange={(e) => setAspect(e.target.value as "9:16" | "16:9")}>
                  <option value="9:16">9:16 竖屏 (1080×1920)</option>
                  <option value="16:9">16:9 横屏 (1920×1080)</option>
                </select>
                <button className="btn primary" disabled={composeBusy} onClick={doCompose}>
                  {composeBusy ? `拼接中 ${composeJob?.progress ?? 0}%` : "🚀 自动拼接成片"}
                </button>
              </div>
              {composeErr && <div className="err">{composeErr}</div>}
              {composeJob && (
                <div className="progress"><div style={{ width: `${composeJob.progress}%` }} /></div>
              )}
              {composeJob?.status === "failed" && <div className="err">拼接失败: {composeJob.error}</div>}
              {filmUrl && (
                <div className="film-out">
                  <video src={filmUrl} controls style={{ maxHeight: 360 }} />
                  <a className="btn primary" href={filmUrl} download>⬇ 下载成片</a>
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}