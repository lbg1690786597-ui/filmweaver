import { useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, APP_VERSION, BreakdownOut, JobOut } from "./api";
import { LibClip, TimelineItem, fmtTime } from "./types";
import LibraryPanel from "./components/LibraryPanel";
import Timeline from "./components/Timeline";
import AiDrawer, { AiTab } from "./components/AiDrawer";

let seq = 0;
const uid = () => `t${Date.now()}_${seq++}`;

type UpdateState = "idle" | "checking" | "downloading" | "ready" | "none";

export default function App() {
  // ---- 主题 ----
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("fw_theme") as "dark" | "light") || "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("fw_theme", theme);
  }, [theme]);

  // ---- 更新（应用内静默下载）----
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateNotes, setUpdateNotes] = useState("");
  const [toast, setToast] = useState("");

  const checkUpdate = async () => {
    setUpdateState("checking");
    try {
      const update = await check();
      if (!update?.available) {
        setUpdateState("none");
        setToast(`已是最新版本 v${APP_VERSION}`);
        setTimeout(() => setToast(""), 3000);
        return;
      }
      setUpdateNotes(update.body ?? "");
      setUpdateState("downloading");
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdateProgress(total > 0 ? Math.round((downloaded / total) * 100) : 0);
        }
        if (event.event === "Finished") setUpdateState("ready");
      });
    } catch (e) {
      setUpdateState("idle");
      setToast(`检查更新失败: ${e}`);
      setTimeout(() => setToast(""), 4000);
    }
  };

  // ---- 后端连接 ----
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  useEffect(() => {
    api.health().then(() => setBackendOk(true)).catch(() => setBackendOk(false));
  }, []);

  // ---- 素材库 / 资产 / 剧本 ----
  const [libClips, setLibClips] = useState<LibClip[]>([]);
  const [assets, setAssets] = useState<{ name: string; url: string }[]>([]);
  const [script, setScript] = useState({ raw: "", optimized: "" });
  const [breakdown, setBreakdown] = useState<BreakdownOut | null>(null);

  // ---- AI 抽屉 ----
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTab, setAiTab] = useState<AiTab>("script");
  const openAi = (t: AiTab) => { setAiTab(t); setAiOpen(true); };

  // ---- 时间轴 ----
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const addToTimeline = (clip: LibClip) => {
    const item = { id: uid(), clip };
    setItems((prev) => [...prev, item]);
    setSelectedId(item.id);
    setPreviewUrl(api.mediaUrl(clip.url));
  };
  const reorder = (from: number, to: number) =>
    setItems((prev) => {
      const next = [...prev];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return next;
    });
  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        removeItem(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  // ---- 预览器 ----
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const selectItem = (id: string) => {
    setSelectedId(id);
    const it = items.find((t) => t.id === id);
    if (it) { setPreviewUrl(api.mediaUrl(it.clip.url)); setPreviewLabel(it.clip.name); }
  };
  const previewClip = (c: LibClip) => { setPreviewUrl(api.mediaUrl(c.url)); setPreviewLabel(c.name); };

  // ---- 导出 ----
  const [aspect, setAspect] = useState<"9:16" | "16:9">("9:16");
  const [composeJob, setComposeJob] = useState<JobOut | null>(null);
  const [composing, setComposing] = useState(false);
  const composeTimer = useRef<number | null>(null);
  const [filmUrl, setFilmUrl] = useState<string | null>(null);
  const doExport = async () => {
    const videos = items.filter((t) => t.clip.kind === "video");
    if (!videos.length) { setToast("时间轴上没有视频"); return; }
    setComposing(true); setFilmUrl(null); setComposeJob(null);
    try {
      const [w, h] = aspect === "9:16" ? [1080, 1920] : [1920, 1080];
      const job = await api.submitCompose(videos.map((t) => t.clip.url), { width: w, height: h });
      setComposeJob(job);
      composeTimer.current = window.setInterval(async () => {
        const s = await api.jobStatus(job.id);
        setComposeJob(s);
        if (s.status === "done" || s.status === "failed") {
          if (composeTimer.current) clearInterval(composeTimer.current);
          setComposing(false);
          if (s.status === "done" && s.result) {
            const url = api.mediaUrl(JSON.parse(s.result).url);
            setFilmUrl(url); setPreviewUrl(url); setPreviewLabel("🎬 成片预览");
            setToast("拼接完成！");
          } else setToast(`拼接失败: ${s.error}`);
        }
      }, 3000);
    } catch (e) { setToast(String(e)); setComposing(false); }
  };

  const totalSec = items.filter((t) => t.clip.kind === "video").reduce((s, t) => s + (t.clip.duration || 5), 0);

  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">🎬 FilmWeaver 织影 <span className="ver">v{APP_VERSION}</span></div>
        <div className="topbar-mid">
          <button className="btn" onClick={() => openAi("script")}>📝 AI 剧本</button>
          <button className="btn" onClick={() => openAi("breakdown")}>🎬 AI 拆解</button>
          <button className="btn" onClick={() => openAi("assets")}>🖼 AI 资产</button>
        </div>
        <div className="topbar-right">
          <span className={`dot ${backendOk === null ? "" : backendOk ? "ok" : "bad"}`} />
          <select value={aspect} onChange={(e) => setAspect(e.target.value as "9:16" | "16:9")}>
            <option value="9:16">9:16 竖屏</option>
            <option value="16:9">16:9 横屏</option>
          </select>
          <button className="btn primary" disabled={composing} onClick={doExport}>
            {composing ? `导出中 ${composeJob?.progress ?? 0}%` : "🚀 导出成片"}
          </button>
          {filmUrl && <a className="btn ok-btn" href={filmUrl} download>⬇ 下载</a>}
          <button className="btn ghost" title="切换主题" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "🌙" : "☀️"}
          </button>
          {/* 检查更新按钮 */}
          {updateState === "idle" || updateState === "none" ? (
            <button className="btn ghost" title="检查更新" onClick={checkUpdate}>⟳</button>
          ) : updateState === "checking" ? (
            <span className="muted">检查中…</span>
          ) : updateState === "downloading" ? (
            <span className="muted">下载 {updateProgress}%</span>
          ) : (
            <button className="btn primary" onClick={() => relaunch()}>🔄 重启安装</button>
          )}
        </div>
      </header>

      {/* 更新进度条 */}
      {updateState === "downloading" && (
        <div className="export-bar"><div style={{ width: `${updateProgress}%`, background: "var(--ok)" }} /></div>
      )}
      {/* 更新就绪提示 */}
      {updateState === "ready" && (
        <div className="banner update-banner">
          <span>✅ 新版本已下载完成{updateNotes ? `：${updateNotes}` : ""}，点「重启安装」立即生效</span>
          <span className="update-actions">
            <button className="btn primary" onClick={() => relaunch()}>🔄 重启安装</button>
            <button className="btn ghost" onClick={() => setUpdateState("idle")}>稍后</button>
          </span>
        </div>
      )}
      {toast && <div className="banner" onClick={() => setToast("")}>{toast}</div>}
      {composing && composeJob && (
        <div className="export-bar"><div style={{ width: `${composeJob.progress}%` }} /></div>
      )}

      <div className="mid">
        <LibraryPanel
          clips={libClips}
          onAddClips={(cs) => setLibClips((prev) => [...prev, ...cs])}
          onAddToTimeline={addToTimeline}
          onPreview={previewClip}
          assets={assets}
          script={script}
          onOpenAi={openAi}
        />
        <main className="player">
          {previewUrl ? (
            <>
              <video key={previewUrl} src={previewUrl} controls autoPlay className="player-video" />
              <div className="player-label">{previewLabel}</div>
            </>
          ) : (
            <div className="player-empty">
              <div className="player-empty-icon">🎬</div>
              <div>导入素材并加入时间轴，点击片段即可预览</div>
              <div className="muted">时间轴共 {items.length} 段 · {fmtTime(totalSec)}</div>
            </div>
          )}
        </main>
      </div>

      <Timeline items={items} selectedId={selectedId} onSelect={selectItem} onReorder={reorder} onRemove={removeItem} />

      <AiDrawer
        open={aiOpen} tab={aiTab} onClose={() => setAiOpen(false)} onTab={setAiTab}
        script={script} onScript={setScript} breakdown={breakdown}
        onBreakdown={setBreakdown} onAssets={setAssets}
        onShotVideo={(name, url) => {
          // AI 生成的镜头视频直接进素材库，可拖入时间轴
          setLibClips((prev) => [...prev, {
            id: `gen_${Date.now()}`, name, url, size: 0, kind: "video", duration: 0,
          }]);
          setToast(`${name} 已生成，已加入素材库`);
          setTimeout(() => setToast(""), 4000);
        }}
      />
    </div>
  );
}