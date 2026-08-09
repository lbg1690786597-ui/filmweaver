import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, APP_VERSION, ShotInfo } from "./api";
import { LibClip, fmtTime } from "./types";
import LibraryPanel from "./components/LibraryPanel";
import ProjectList from "./components/ProjectList";
import TimelineDock from "./components/TimelineDock";
import ShotAdvanced from "./components/ShotAdvanced";
import FineCut from "./components/FineCut";
import LoginPage from "./components/LoginPage";
import { useResizable } from "./lib/useResizable";
import { useToast } from "./hooks/useToast";
import { useTheme } from "./hooks/useTheme";
import { useUpdater } from "./hooks/useUpdater";
import { useAuth } from "./hooks/useAuth";
import { useProject } from "./hooks/useProject";
import { usePlayer } from "./hooks/usePlayer";
import { useUndo } from "./hooks/useUndo";
import { useAudioTrack } from "./hooks/useAudioTrack";
import { useProdJobs } from "./hooks/useProdJobs";
import { useStages } from "./hooks/useStages";
import { useLibClips } from "./hooks/useLibClips";
import { useCompose } from "./hooks/useCompose";

/** G4 状态分层重构：App 从 824 行状态中枢瘦身为组合根（composition root）。
 *
 * 状态按领域分层进 src/hooks/（会话/项目/任务/播放器/编辑/资产/素材/导出/UI），
 * App 只负责：① 组装各层 hook ② 跨层协调动作（切项目清场、版本切换联动预览等）
 * ③ 顶层布局 JSX。各层职责与清场入口（clearXxx）在各 hook 头注释里。 */
export default function App() {
  // ---- UI 层：toast / 主题 / 应用内更新 ----
  const { toast, say, clearToast } = useToast();
  const { theme, toggleTheme } = useTheme();
  const { updateState, setUpdateState, updateProgress, updateNotes, checkUpdate } = useUpdater(say);

  // ---- 会话层：后端探测 + 登录门控 ----
  const { backendOk, loginRequired, user, doLogout, onLoggedIn } = useAuth();


  // ---- 项目层（T-R0-07 状态云端化）----
  const { projectId, setProjectId, detail, refreshDetail, refreshSoon, clearDetail } = useProject();

  // ---- 播放器层（P2-1 播放头 + 连播 + 选中镜头）----
  const {
    videoRef, previewUrl, previewLabel, previewShot, playhead, setPlayhead,
    pendingSeek, autoNext, setAutoNext, selectedShot, setSelectedShot,
    onSelectShot, seekTo, onPreviewEnded, previewMedia, previewShotVersion,
    clearPlayer,
  } = usePlayer();

  // ---- 编辑层（P2-2 撤销栈）----
  const { pushUndo, clearUndo } = useUndo(say);

  // ---- 音频层（P2-4 音频轨）----
  const { audioClips, ttsAvailable, ttsJobId, refreshAudio, doSynthTts, clearAudio } =
    useAudioTrack(projectId, say);

  // ---- 任务层（生产 job 轮询 + P2-3 接回 + P2-5 SSE）----
  const { jobList, generating, prodJob, trackJob, clearJobs } = useProdJobs({
    projectId, say, refreshDetail, refreshSoon, refreshAudio,
  });

  const openProject = (id: string) => {
    resetWorkspace();          // 修复：切项目必须清空上一项目的预览/剪辑/选中态
    setProjectId(id);
    localStorage.setItem("fw_project", id);
    refreshDetail(id);
  };
  const closeProject = () => {
    resetWorkspace();
    setProjectId(null);
    localStorage.removeItem("fw_project");
  };


  // ---- 生产看板操作 ----
  const doGenerate = async (shotIds: string[]) => {
    if (!projectId || !shotIds.length) return;
    try {
      const job = await api.submitShotsByIds(projectId, shotIds);
      trackJob(job, "shot_videos");
      say(`已提交 ${shotIds.length} 个镜头生产（可继续提交其他镜头）`);
    } catch (e) { say(String(e)); }
  };
  // 版本切换 = 采用该版本并同步预览/时间轴（「采用」按钮已删：生成即默认采用）
  const doSwitchVersion = async (shot: ShotInfo, verNo: number) => {
    try {
      const r = await api.adoptShot(shot.id, verNo);
      refreshDetail();
      if (r.video_url) previewShotVersion(shot, verNo, r.video_url);
      say(`已切换到 V${verNo}`);
    } catch (e) { say(String(e)); }
  };

  // ---- 资产层（R1 人物阶段 + P1-3 场景）+ 弹窗 ----
  const { stages, locations, drafting, refreshStages, doStagesDraft, clearStages } =
    useStages(projectId, say);
  const [advancedShot, setAdvancedShot] = useState<ShotInfo | null>(null);
  const [fineCutOpen, setFineCutOpen] = useState(false);

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
      trackJob(job, "one_click_film");
      say("▷ 一键成片已启动");
    } catch (e) { say(String(e)); }
  };
  const oneClickStage = !prodJob ? "" :
    prodJob.progress < 10 ? "拆解中" : prodJob.progress < 80 ? "逐镜生成" : "拼接成片";

  // ---- 素材层（P1-3 素材池落库）----
  const { libClips, deleteClip, addClips, clearClips } = useLibClips(projectId, say);

  // ---- 面板尺寸拖拽（CSS 变量 + localStorage 记忆）----
  // 上限动态取窗口尺寸：可拖至接近全屏（留出顶栏/最小预览空间）；双击分隔条恢复默认
  const libResize = useResizable("lib-w", 360, 260, () => window.innerWidth - 320);
  const dockResize = useResizable("dock-h", 260, 120, () => window.innerHeight - 160, false);

  // ---- 版块最大化（⛶ / Esc 还原）----
  const [maxPanel, setMaxPanel] = useState<null | "dock">(null);
  useEffect(() => {
    if (!maxPanel) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setMaxPanel(null); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [maxPanel]);

  // ---- 导出层（快速导出 compose + 拆解 job；成片就绪即入预览器）----
  const {
    composeJob, composing, filmUrl, exportClips, totalSec, doExport,
    bdProgress, doBreakdown: doBreakdownRaw, clearCompose,
  } = useCompose({
    detail, say, refreshDetail,
    onFilmReady: (url) => previewMedia(url, "🎬 成片预览"),
  });
  const doBreakdown = (episodes?: number[]) => doBreakdownRaw(projectId, episodes);


  // ---- 素材入轨（P0-3 归一）：素材库「＋」不再进第二条剪辑轨，
  //      而是作为 is_special 镜头插入镜头轨末尾，与 AI 镜头同轨同导出 ----
  const [insertingClip, setInsertingClip] = useState(false);
  const addToTimeline = async (clip: LibClip) => {
    if (!projectId) return;
    if (clip.kind !== "video") { say("只有视频素材可以插入镜头轨"); return; }
    setInsertingClip(true);
    try {
      const r = await api.addSpecialShot(
        projectId, clip.name, clip.url, undefined,
        clip.duration > 0 ? clip.duration : undefined);
      await refreshDetail();
      previewMedia(clip.url, clip.name);
      say(`已插入镜头轨 #${r.order}（外部素材），可拖动调整位置`);
    } catch (e) { say(String(e)); }
    finally { setInsertingClip(false); }
  };

  // ---- 镜头轨轻剪辑（唯一真源）：改时长 / 改顺序 / 停用 / 删除外部素材 ----
  const patchTimeline = async (
    shotId: string, patch: { durationSec?: number; toOrder?: number; disabled?: boolean },
  ) => {
    try {
      // P2-2：提交前记旧值 → 撤销 = 回写旧值（时长/顺序/停用三类各自独立入栈）
      const old = detail?.shots.find((s) => s.id === shotId);
      await api.patchShotTimeline(shotId, patch);
      if (old) {
        if (patch.durationSec !== undefined && old.duration_sec != null) {
          const prev = old.duration_sec;
          pushUndo(`镜头 #${old.order} 时长 → ${patch.durationSec}s`, async () => {
            await api.patchShotTimeline(shotId, { durationSec: prev });
            await refreshDetail();
          });
        }
        if (patch.toOrder !== undefined) {
          const prev = old.order;
          pushUndo(`镜头 #${prev} 移到 #${patch.toOrder}`, async () => {
            await api.patchShotTimeline(shotId, { toOrder: prev });
            await refreshDetail();
          });
        }
        if (patch.disabled !== undefined) {
          const prev = old.disabled;
          pushUndo(`镜头 #${old.order} ${patch.disabled ? "停用" : "恢复启用"}`, async () => {
            await api.patchShotTimeline(shotId, { disabled: prev });
            await refreshDetail();
          });
        }
      }
      await refreshDetail();
    } catch (e) { say(String(e)); }
  };
  const deleteSpecialShot = async (shotId: string) => {
    try {
      await api.deleteShot(shotId);
      if (selectedShot?.id === shotId) setSelectedShot(null);
      await refreshDetail();
      say("已从镜头轨移除");
    } catch (e) { say(String(e)); }
  };

  // ---- 预览器动作（播放器层的便捷封装）----
  const previewClip = (c: LibClip) => previewMedia(c.url, c.name);       // 素材预览
  const previewAudio = (url: string, label: string) => previewMedia(url, label);  // 旁白/配乐试听

  // ---- 跨层协调：切/关项目清场（各层 clearXxx 统一从这里调度）----
  // 修复：切换/关闭项目时清空工作区状态，防止上一项目的预览/剪辑/选中态串到新项目
  function resetWorkspace() {
    clearPlayer();          // 预览/播放头/选中镜头
    setAdvancedShot(null);
    setFineCutOpen(false);
    clearClips();           // 素材池内存态
    clearStages();          // 人物/场景轨
    clearCompose();         // 成片地址
    clearUndo();            // P2-2：撤销栈按项目隔离，切项目即清空
    clearAudio();           // P2-4：音频轨状态与合成轮询一并清
    clearJobs();            // P2-3：停掉上一项目的 job 轮询（新项目从服务端重新接回）
    clearDetail();          // P2-5：合并刷新定时器一并清 + 旧 detail 立即失效
  }

  // ---- 登录门控（放在项目列表之前；探测中显示空态防闪烁）----
  if (loginRequired === null) {
    return <div className="login-page"><div className="muted">连接后端…</div></div>;
  }
  if (loginRequired) {
    return <LoginPage onLoggedIn={onLoggedIn} />;
  }

  // ---- 无项目：项目列表首屏（T-R0-06）----
  if (!projectId) {
    return <ProjectList onOpen={openProject} />;
  }

  return (
    <div className={`studio ${maxPanel === "dock" ? "max-dock" : ""}`}>
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
          <button className="btn ghost" title="切换主题" onClick={toggleTheme}>
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
      {toast && <div className="banner" onClick={clearToast}>{toast}</div>}
      {generating && prodJob && (
        <div className="export-bar" title={jobList.length > 1 ? `${jobList.length} 个任务并行` : ""}>
          <div style={{ width: `${Math.round(jobList.reduce((s, j) => s + j.progress, 0) / jobList.length)}%` }} />
        </div>
      )}
      {composing && composeJob && (
        <div className="export-bar"><div style={{ width: `${composeJob.progress}%` }} /></div>
      )}

      <div className="mid">
        <LibraryPanel
          projectId={projectId}
          clips={libClips}
          onAddClips={addClips}
          onAddToTimeline={addToTimeline}
          inserting={insertingClip}
          onPreview={previewClip}
          onDeleteClip={deleteClip}
          assetsMeta={detail?.assets ?? []}
          stages={stages}
          onRefreshStages={() => refreshStages()}
          onRefresh={() => refreshDetail()}
          onToast={say}
          shots={detail?.shots ?? []}
          episodes={detail?.episodes ?? []}
          selectedShotId={selectedShot?.id ?? null}
          onSelectShot={onSelectShot}
          onGenerate={doGenerate}
          onSwitchVersion={doSwitchVersion}
          onAdvanced={(s) => setAdvancedShot(s)}
          generating={generating}
          onBreakdown={doBreakdown}
          breakdownProgress={bdProgress}
        />
        {/* 拖拽条：调整左栏宽度（双击恢复默认） */}
        <div className="rz rz-v" title="拖动调整宽度 · 双击恢复默认"
          onMouseDown={(e) => libResize.onMouseDown(e, 1)}
          onDoubleClick={libResize.reset} />
        <main className="player">
          {previewUrl ? (
            <div className="player-box">
              <video key={previewUrl} src={previewUrl} controls autoPlay className="player-video"
                ref={videoRef}
                onLoadedMetadata={(e) => {
                  // 跨镜 seek：新镜头元数据就绪后跳到目标秒
                  if (pendingSeek.current != null) {
                    e.currentTarget.currentTime = pendingSeek.current;
                    pendingSeek.current = null;
                  }
                }}
                onTimeUpdate={(e) => {
                  if (previewShot)
                    setPlayhead({ order: previewShot.order, offsetSec: e.currentTarget.currentTime });
                }}
                onEnded={() => onPreviewEnded(detail?.shots ?? [])} />
              <div className="player-label">
                {previewLabel}
                {previewShot && (
                  <label className="player-autonext" title="本镜播完自动切到下一个已生成镜头">
                    <input type="checkbox" checked={autoNext}
                      onChange={(e) => setAutoNext(e.target.checked)} /> 连播
                  </label>
                )}
              </div>
            </div>
          ) : (
            <div className="player-empty">
              <div className="player-empty-icon">🎬</div>
              <div>导入剧本 → 拆解 → 「🎬 镜头」页生成，点击镜头即可预览</div>
              <div className="muted">镜头轨 {exportClips.length} 段可导出 · {fmtTime(totalSec)}</div>
            </div>
          )}
        </main>
      </div>

      {/* 统一时间轴版块：人物资产轨 + 镜头轨（单行横向滚动）+ 音频轨（预留）；
          空轨默认折叠、可点头部展开，有内容自动展开；上缘可拖拽调高（可至近全屏，双击恢复）；
          ⛶ 一键最大化，Esc 还原 */}
      <div className="rz rz-h" title="拖动调整高度 · 双击恢复默认"
        onMouseDown={(e) => dockResize.onMouseDown(e, -1)}
        onDoubleClick={dockResize.reset} />
      <TimelineDock
        shots={detail?.shots ?? []} episodes={detail?.episodes ?? []}
        selectedShotId={selectedShot?.id ?? null} onSelectShot={onSelectShot}
        stages={stages} locations={locations} onRefreshStages={() => refreshStages()}
        onToast={say} onDraft={doStagesDraft} drafting={drafting}
        maximized={maxPanel === "dock"}
        onToggleMax={() => setMaxPanel((m) => (m === "dock" ? null : "dock"))}
        onPatchTimeline={patchTimeline} onDeleteShot={deleteSpecialShot}
        totalSec={totalSec} exportCount={exportClips.length}
        projectId={projectId ?? ""}
        onOverridesChanged={() => { refreshStages(); refreshDetail(); }}
        playhead={playhead} onSeek={seekTo} onPushUndo={pushUndo}
        audioClips={audioClips} ttsAvailable={ttsAvailable}
        onAudioChanged={() => refreshAudio()} onSynthTts={doSynthTts}
        synthBusy={ttsJobId !== null} libClips={libClips}
        onPreviewAudio={previewAudio} />

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
    </div>
  );
}