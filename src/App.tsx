import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, APP_VERSION, AppLatest, BreakdownOut, JobOut } from "./api";
import { LibClip, TimelineItem, fmtTime } from "./types";
import LibraryPanel from "./components/LibraryPanel";
import Timeline from "./components/Timeline";
import AiDrawer, { AiTab } from "./components/AiDrawer";

let seq = 0;
const uid = () => `t${Date.now()}_${seq++}`;

/** 剪映式全屏工作台：左素材库 + 右预览器 + 底时间轴 */
export default function App() {
  // ---- 主题 ----
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("fw_theme") as "dark" | "light") || "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("fw_theme", theme);
  }, [theme]);

  // ---- 更新 / 连接 ----
  const [toast, setToast] = useState("");
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [update, setUpdate] = useState<AppLatest | null>(null); // 发现的新版本
  useEffect(() => {
    api.health().then(() => setBackendOk(true)).catch(() => setBackendOk(false));
  }, []);
  const checkUpdate = async () => {
    setToast("检查更新中…");
    try {
      const latest = await api.appLatest();
      if (latest.version !== APP_VERSION) {
        setUpdate(latest);
        setToast("");
      } else setToast(`已是最新版本 v${APP_VERSION}`);
    } catch (e) { setToast(`检查失败: ${e}`); }
  };
  /** 用系统浏览器打开下载页（Tauri opener；非 Tauri 环境回退 window.open） */
  const goUpdate = async () => {
    if (!update) return;
    try { await openUrl(update.download_url); }
    catch { window.open(update.download_url, "_blank"); }
  };

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

  // Delete 键删除选中片段
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
  const previewClip = (c: LibClip) => {
    setPreviewUrl(api.mediaUrl(c.url)); setPreviewLabel(c.name);
  };

  // ---- 导出（自动拼接）----
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
            setFilmUrl(url);
            setPreviewUrl(url);
            setPreviewLabel("🎬 成片预览");
            setToast("拼接完成！预览窗已切换到成片");
          } else setToast(`拼接失败: ${s.error}`);
        }
      }, 3000);
    } catch (e) { setToast(String(e)); setComposing(false); }
  };

  const totalSec = items.filter((t) => t.clip.kind === "video")
    .reduce((s, t) => s + (t.clip.duration || 5), 0);

  return (
    <div className="studio">
      {/* 顶栏 */}
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
          <button className="btn ghost" title="检查更新" onClick={checkUpdate}>⟳</button>
        </div>
      </header>
      {toast && <div className="banner" onClick={() => setToast("")}>{toast}</div>}
      {update && (
        <div className="banner update-banner">
          <span>🎉 发现新版本 v{update.version}（当前 v{APP_VERSION}）：{update.notes}</span>
          <span className="update-actions">
            <button className="btn primary" onClick={goUpdate}>⬇ 立即更新</button>
            <button className="btn ghost" onClick={() => setUpdate(null)}>稍后再说</button>
          </span>
        </div>
      )}
      {composing && composeJob && (
        <div className="export-bar"><div style={{ width: `${composeJob.progress}%` }} /></div>
      )}

      {/* 中区：素材库 + 预览器 */}
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

      {/* 底区：时间轴 */}
      <Timeline
        items={items}
        selectedId={selectedId}
        onSelect={selectItem}
        onReorder={reorder}
        onRemove={removeItem}
      />

      {/* AI 抽屉 */}
      <AiDrawer
        open={aiOpen}
        tab={aiTab}
        onClose={() => setAiOpen(false)}
        onTab={setAiTab}
        script={script}
        onScript={setScript}
        breakdown={breakdown}
        onBreakdown={setBreakdown}
        onAssets={setAssets}
      />
    </div>
  );
}