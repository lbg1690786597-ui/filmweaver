import { useCallback, useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, APP_VERSION, JobOut, ProjectDetail, ShotInfo, StageInfo } from "./api";
import { LibClip, TimelineItem, fmtTime } from "./types";
import LibraryPanel from "./components/LibraryPanel";
import Timeline from "./components/Timeline";
import ProjectList from "./components/ProjectList";
import ProductionBoard from "./components/ProductionBoard";
import CharacterTrack from "./components/CharacterTrack";
import ShotAdvanced from "./components/ShotAdvanced";
import FineCut from "./components/FineCut";
import LoginPage from "./components/LoginPage";
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
  const say = (msg: string, ms = 4000) => { setToast(msg); setTimeout(() => setToast(""), ms); };

  const checkUpdate = async () => {
    setUpdateState("checking");
    try {
      const update = await check();
      if (!update?.available) {
        setUpdateState("none");
        say(`已是最新版本 v${APP_VERSION}`, 3000);
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
      say(`检查更新失败: ${e}`);
    }
  };

  // ---- 后端连接 + 登录门控 ----
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [loginRequired, setLoginRequired] = useState<boolean | null>(null); // null=探测中
  const [user, setUser] = useState<{ username: string; display_name: string | null; role: string } | null>(null);
  useEffect(() => {
    api.health().then(async (h) => {
      setBackendOk(true);
      if (!h.login) { setLoginRequired(false); return; }  // 后端未启用登录
      // 启用登录：验证本地会话是否仍有效
      const saved = localStorage.getItem("fw_session");
      if (saved) {
        try {
          const me = await api.authMe(saved);
          setUser(me.user);
          setLoginRequired(false);
          return;
        } catch { localStorage.removeItem("fw_session"); }
      }
      setLoginRequired(true);
    }).catch(() => { setBackendOk(false); setLoginRequired(false); });
  }, []);

  const doLogout = async () => {
    const t = localStorage.getItem("fw_session");
    if (t) { await api.logout(t).catch(() => {}); localStorage.removeItem("fw_session"); }
    setUser(null);
    setLoginRequired(true);
  };

  // ---- 项目（T-R0-07：状态云端化）----
  const [projectId, setProjectId] = useState<string | null>(
    () => localStorage.getItem("fw_project") || null,
  );
  const [detail, setDetail] = useState<ProjectDetail | null>(null);

  const refreshDetail = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      setDetail(await api.projectDetail(id));
    } catch {
      setProjectId(null);
      localStorage.removeItem("fw_project");
    }
  }, [projectId]);

  const openProject = (id: string) => {
    setProjectId(id);
    localStorage.setItem("fw_project", id);
    refreshDetail(id);
  };
  const closeProject = () => {
    setProjectId(null);
    setDetail(null);
    localStorage.removeItem("fw_project");
  };
  useEffect(() => { if (projectId) refreshDetail(projectId); }, []); // 启动恢复现场

  // ---- 生产 job 轮询（批量生成/一键成片共用；job id 落 localStorage 以便重开接回）----
  const [prodJob, setProdJob] = useState<JobOut | null>(null);
  const prodTimer = useRef<number | null>(null);

  const watchJob = useCallback((jobId: string, kind: string) => {
    localStorage.setItem("fw_job", JSON.stringify({ id: jobId, kind, project: projectId }));
    if (prodTimer.current) clearInterval(prodTimer.current);
    prodTimer.current = window.setInterval(async () => {
      try {
        const s = await api.jobStatus(jobId);
        setProdJob(s);
        refreshDetail();  // 看板状态色实时刷新
        if (s.status === "done" || s.status === "failed") {
          if (prodTimer.current) clearInterval(prodTimer.current);
          localStorage.removeItem("fw_job");
          say(s.status === "done" ? "✅ 生产完成" : `❌ 生产失败: ${(s.error || "").slice(0, 120)}`);
          setProdJob(null);
          refreshDetail();
        }
      } catch { /* 网络抖动忽略，下轮再试 */ }
    }, 3000);
  }, [projectId, refreshDetail]);

  // 启动时接回进行中的任务（T-R0-09 进度可离开）
  useEffect(() => {
    const saved = localStorage.getItem("fw_job");
    if (!saved) return;
    const { id, project } = JSON.parse(saved);
    if (project && project === (localStorage.getItem("fw_project") || null)) {
      api.jobStatus(id).then((s) => {
        if (s.status === "pending" || s.status === "running") {
          setProdJob(s);
          watchJob(id, "resume");
          say("已接回进行中的生产任务");
        } else localStorage.removeItem("fw_job");
      }).catch(() => localStorage.removeItem("fw_job"));
    }
  }, []);

  const generating = prodJob !== null;

  // ---- 生产看板操作（T-R0-08）----
  const doGenerate = async (shotIds: string[]) => {
    if (!projectId || !shotIds.length) return;
    try {
      const job = await api.submitShotsByIds(projectId, shotIds);
      setProdJob(job);
      watchJob(job.id, "shot_videos");
      say(`已提交 ${shotIds.length} 个镜头生产`);
    } catch (e) { say(String(e)); }
  };
  const doAdopt = async (shot: ShotInfo) => {
    try {
      await api.adoptShot(shot.id, shot.adopted_version ?? 1);
      refreshDetail();
    } catch (e) { say(String(e)); }
  };
  const [selectedShot, setSelectedShot] = useState<ShotInfo | null>(null);
  const onSelectShot = (s: ShotInfo) => {
    setSelectedShot(s);
    if (s.video_url) { setPreviewUrl(api.mediaUrl(s.video_url)); setPreviewLabel(`镜头 #${s.order}`); }
  };

  // ---- R1: 人物资产时间轴 + 镜头高级面板 ----
  const [stages, setStages] = useState<StageInfo[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [advancedShot, setAdvancedShot] = useState<ShotInfo | null>(null);
  const [fineCutOpen, setFineCutOpen] = useState(false);
  const refreshStages = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try { setStages((await api.listStages(id)).stages); } catch { /* 后端旧版无此接口时静默 */ }
  }, [projectId]);
  useEffect(() => { if (projectId) refreshStages(projectId); }, [projectId]);
  const doStagesDraft = async () => {
    if (!projectId) return;
    setDrafting(true);
    try {
      const r = await api.stagesDraft(projectId);
      await refreshStages();
      say(`✨ 识别完成：新增 ${r.created} 个阶段草稿${r.skipped_confirmed.length ? `（已确认角色保留：${r.skipped_confirmed.join("、")}）` : ""}`);
    } catch (e) { say(String(e)); }
    finally { setDrafting(false); }
  };
  const maxEp = detail?.episodes.length || 1;

  // ---- 一键成片 + 生产检查（T-R0-09）----
  const [preflight, setPreflight] = useState(false);
  const estimateMin = (() => {
    if (!detail) return 0;
    const pending = detail.shots.filter((s) => !s.video_url).length || detail.episodes.length * 3;
    const perMin = detail.production_mode === "consistent" ? 10 : 2;
    return pending * perMin;
  })();
  const doOneClick = async () => {
    if (!projectId) return;
    setPreflight(false);
    try {
      const job = await api.submitOneClickFilm(projectId);
      setProdJob(job);
      watchJob(job.id, "one_click_film");
      say("▷ 一键成片已启动");
    } catch (e) { say(String(e)); }
  };
  const oneClickStage = !prodJob ? "" :
    prodJob.progress < 10 ? "拆解中" : prodJob.progress < 80 ? "逐镜生成" : "拼接成片";

  // ---- 素材库 ----
  const [libClips, setLibClips] = useState<LibClip[]>([]);

  // ---- AI 抽屉 ----
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTab, setAiTab] = useState<AiTab>("script");
  const openAi = (t: AiTab) => { setAiTab(t); setAiOpen(true); };

  // ---- 剪辑时间轴（保留精编雏形）----
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

  // ---- 导出（画幅继承项目基准，T-R0-06 决策）----
  const [composeJob, setComposeJob] = useState<JobOut | null>(null);
  const [composing, setComposing] = useState(false);
  const composeTimer = useRef<number | null>(null);
  const [filmUrl, setFilmUrl] = useState<string | null>(null);
  const doExport = async () => {
    const videos = items.filter((t) => t.clip.kind === "video");
    if (!videos.length) { say("剪辑时间轴上没有视频"); return; }
    setComposing(true); setFilmUrl(null); setComposeJob(null);
    try {
      const aspect = detail?.base_aspect ?? "9:16";
      const [w, h] = aspect === "16:9" ? [1920, 1080] : aspect === "1:1" ? [1080, 1080] : [1080, 1920];
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
            say("拼接完成！");
          } else say(`拼接失败: ${s.error}`);
        }
      }, 3000);
    } catch (e) { say(String(e)); setComposing(false); }
  };

  const totalSec = items.filter((t) => t.clip.kind === "video").reduce((s, t) => s + (t.clip.duration || 5), 0);

  // ---- 登录门控（放在项目列表之前；探测中显示空态防闪烁）----
  if (loginRequired === null) {
    return <div className="login-page"><div className="muted">连接后端…</div></div>;
  }
  if (loginRequired) {
    return <LoginPage onLoggedIn={(u) => { setUser(u); setLoginRequired(false); }} />;
  }

  // ---- 无项目：项目列表首屏（T-R0-06）----
  if (!projectId) {
    return <ProjectList onOpen={openProject} />;
  }

  return (
    <div className="studio">
      <header className="topbar">
        <button className="btn ghost" title="返回项目列表" onClick={closeProject}>←</button>
        <div className="brand">
          🎬 {detail?.title ?? "加载中…"} <span className="ver">v{APP_VERSION}</span>
        </div>
        <div className="topbar-mid">
          {/* T-R0-09: 一键成片主入口 */}
          <button className="btn primary" disabled={generating} onClick={() => setPreflight(true)}>
            {generating ? `${oneClickStage || "生产中"} ${prodJob?.progress ?? 0}%` : "▷ 一键成片"}
          </button>
          <button className="btn" onClick={() => openAi("script")}>📝 剧本</button>
          <button className="btn" onClick={() => openAi("breakdown")}>🎬 拆解</button>
          <button className="btn" onClick={() => openAi("assets")}>🖼 资产</button>
        </div>
        <div className="topbar-right">
          <span className={`dot ${backendOk === null ? "" : backendOk ? "ok" : "bad"}`} />
          <span className="muted">{detail?.base_aspect} · {detail?.production_mode ?? "-"}</span>
          <button className="btn" disabled={!(detail?.shots.some((s) => s.video_url))}
            title="精编：裁剪/字幕/版本回退/本机导出"
            onClick={() => setFineCutOpen(true)}>🎞 精编</button>
          <button className="btn primary" disabled={composing} onClick={doExport}>
            {composing ? `导出中 ${composeJob?.progress ?? 0}%` : "🚀 快速导出"}
          </button>
          {filmUrl && <a className="btn ok-btn" href={filmUrl} download>⬇ 下载</a>}
          <button className="btn ghost" title="切换主题" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "🌙" : "☀️"}
          </button>
          {user && (
            <button className="btn ghost" title={`${user.display_name ?? user.username} · 退出登录`}
              onClick={doLogout}>👤 {user.display_name ?? user.username}</button>
          )}
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

      {/* T-R0-09: 生产检查弹窗 */}
      {preflight && detail && (
        <div className="drawer-mask" onClick={() => setPreflight(false)}>
          <div className="wizard" onClick={(e) => e.stopPropagation()}>
            <h2>生产检查</h2>
            <table className="preflight-table"><tbody>
              <tr><td>分集</td><td>{detail.episodes.length || "未导入剧本"}</td></tr>
              <tr><td>镜头</td><td>{detail.shots.length ? `${detail.shots.length}（待生成 ${detail.shots.filter((s) => !s.video_url).length}）` : "未拆解（将自动拆解）"}</td></tr>
              <tr><td>角色</td><td>{detail.assets.filter((a) => a.kind === "character").length}</td></tr>
              <tr><td>模式</td><td>{detail.production_mode ?? "默认"}</td></tr>
              <tr><td>预计耗时</td><td>约 {estimateMin || "?"} 分钟（串行）</td></tr>
              <tr><td className="muted">预计消耗</td><td className="muted">计费上线后显示</td></tr>
            </tbody></table>
            <div className="muted" style={{ margin: "8px 0" }}>
              生产期间可关闭应用，重新打开会自动接回进度。
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setPreflight(false)}>取消</button>
              <button className="btn primary" disabled={!detail.raw_script && !detail.optimized_script}
                onClick={doOneClick}>开始生产</button>
            </div>
          </div>
        </div>
      )}

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
      {generating && prodJob && (
        <div className="export-bar"><div style={{ width: `${prodJob.progress}%` }} /></div>
      )}
      {composing && composeJob && (
        <div className="export-bar"><div style={{ width: `${composeJob.progress}%` }} /></div>
      )}

      <div className="mid">
        <LibraryPanel
          clips={libClips}
          onAddClips={(cs) => setLibClips((prev) => [...prev, ...cs])}
          onAddToTimeline={addToTimeline}
          onPreview={previewClip}
          assets={(detail?.assets ?? []).filter((a) => a.image_url).map((a) => ({ name: a.name, url: a.image_url! }))}
          script={{ raw: detail?.raw_script ?? "", optimized: detail?.optimized_script ?? "" }}
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
              <div>导入剧本 → 拆解 → 生产看板生成，点击镜头即可预览</div>
              <div className="muted">剪辑轨 {items.length} 段 · {fmtTime(totalSec)}</div>
            </div>
          )}
        </main>
      </div>

      {/* R1: 人物资产时间轴（有镜头后显示） */}
      {(detail?.shots.length ?? 0) > 0 && (
        <CharacterTrack stages={stages} maxEp={maxEp}
          onRefresh={() => refreshStages()} onToast={say}
          onDraft={doStagesDraft} drafting={drafting} />
      )}

      {/* T-R0-08: 生产看板（常驻）；剪辑时间轴仅在有剪辑素材时显示 */}
      <ProductionBoard
        shots={detail?.shots ?? []}
        episodes={detail?.episodes ?? []}
        selectedShotId={selectedShot?.id ?? null}
        onSelect={onSelectShot}
        onGenerate={doGenerate}
        onAdopt={doAdopt}
        onAdvanced={(s) => setAdvancedShot(s)}
        generating={generating}
      />
      {items.length > 0 && (
        <Timeline items={items} selectedId={selectedId} onSelect={selectItem} onReorder={reorder} onRemove={removeItem} />
      )}

      {/* R1: 镜头高级面板（三层覆盖 + 五模式选择器） */}
      {advancedShot && (
        <ShotAdvanced shot={advancedShot} productionMode={detail?.production_mode ?? null}
          onClose={() => setAdvancedShot(null)}
          onSaved={() => refreshDetail()} onToast={say} />
      )}

      {/* R2: 精编器（裁剪/字幕/版本回退/本机导出） */}
      {fineCutOpen && projectId && detail && (
        <FineCut projectId={projectId} baseAspect={detail.base_aspect}
          shots={detail.shots}
          onClose={() => setFineCutOpen(false)}
          onRegenerate={doGenerate} onToast={say} />
      )}

      <AiDrawer
        open={aiOpen} tab={aiTab} onClose={() => setAiOpen(false)} onTab={setAiTab}
        projectId={projectId} detail={detail} onRefresh={() => refreshDetail()}
        onToast={say}
      />
    </div>
  );
}