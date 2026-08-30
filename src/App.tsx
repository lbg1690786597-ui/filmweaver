import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, APP_VERSION, JobOut, ShotInfo } from "./api";
import type { TransformMeta } from "./api";
import { tierModel, TIERS, type QualityTier } from "./lib/qualityTiers";
const TIER_LABEL: Record<QualityTier, string> = {
  preview: `${TIERS.preview.icon} ${TIERS.preview.label}`,
  final: `${TIERS.final.icon} ${TIERS.final.label}`,
};
import { LibClip, fmtTime } from "./types";
import LibraryPanel, { Tab as LibTab } from "./components/LibraryPanel";
import ProjectList from "./components/ProjectList";
import ShotAdvanced from "./components/ShotAdvanced";
import FineCut from "./components/FineCut";
import LoginPage from "./components/LoginPage";
import PreflightDialog from "./components/PreflightDialog";
import { useToast } from "./hooks/useToast";
import { useTheme } from "./hooks/useTheme";
import { useUpdater } from "./hooks/useUpdater";
import { useAuth } from "./hooks/useAuth";
import { useProject } from "./hooks/useProject";
import { usePlayer } from "./hooks/usePlayer";
import { useUndo } from "./hooks/useUndo";
import { useAudioTrack } from "./hooks/useAudioTrack";
import { useSubtitles } from "./hooks/useSubtitles";
import { useSubtitleStyle } from "./hooks/useSubtitleStyle";
import { useTransitions } from "./hooks/useTransitions";
import { useProdJobs } from "./hooks/useProdJobs";
import { useStages } from "./hooks/useStages";
import { useLibClips } from "./hooks/useLibClips";
import { useBreakdown } from "./hooks/useBreakdown";
// ---- Phase 1 重构：编辑器 Shell ----
import EditorLayout from "./features/editor/EditorLayout";
import TopBar from "./features/editor/TopBar";
import Rail from "./features/editor/Rail";
import LeftPanel from "./features/editor/LeftPanel";
import Player from "./features/editor/Player";
import Inspector from "./features/inspector/Inspector";
import AssetInspector from "./features/inspector/AssetInspector";
import Timeline from "./features/timeline/Timeline";
import type { AssetRun, AssetTrackKind } from "./features/assets/AssetTrack";
// ---- Phase 3 重构：基础剪辑面板 ----
import MediaPanel from "./features/media/MediaPanel";
import AudioPanel from "./features/audio/AudioPanel";
import TextPanel from "./features/subtitles/TextPanel";
import EffectsPanel from "./features/effects/EffectsPanel";
// ---- Phase 4 重构：FilmWeaver AI 模块 ----
import ScriptPanel from "./features/script/ScriptPanel";
import VideoPanel from "./features/generation/VideoPanel";
import ExportDialog from "./features/export/ExportDialog";
import TasksDrawer from "./features/tasks/TasksDrawer";
import SettingsDialog from "./features/settings/SettingsDialog";
import { normalize as normalizeRenderPlan } from "./render/normalize";
import { render as renderV2 } from "./render/renderer";
import { useTimelineStore } from "./stores/timelineStore";
import { useCommands } from "./commands";
import { useEditorStore, LeftPanelTab } from "./stores/editorStore";

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
  const { backendOk, loginRequired, user, doLogout, onLoggedIn, retry: retryBackend } = useAuth();


  // ---- 项目层（T-R0-07 状态云端化）----
  const { projectId, setProjectId, detail, refreshDetail, refreshSoon, clearDetail } = useProject();

  // ---- 播放器层（P2-1 播放头 + 连播 + 选中镜头）----
  const {
    videoRef, previewUrl, previewLabel, previewShot, playhead, setPlayhead,
    pendingSeek, autoNext, setAutoNext, selectedShotId, setSelectedShotId,
    onSelectShot, seekTo, onPreviewEnded, previewMedia, previewShotVersion,
    clearPlayer, cursor, setCursor,
  } = usePlayer();

  // ---- 编辑层（P2-2 撤销栈）----
  const { pushUndo, doUndo, doRedo, clearUndo } = useUndo(say);

  // ---- 音频层（P2-4 音频轨）----
  const { audioClips, ttsAvailable, ttsJobId, refreshAudio, doSynthTts, clearAudio } =
    useAudioTrack(projectId, say);

  // ---- 字幕层（TB-02）：时间轴字幕轨与文本面板共用同一份数据 ----
  const { subtitles, refreshSubtitles, clearSubtitles } = useSubtitles(projectId);
  // 项目级默认字幕样式：播放器预览 / 文本面板 / 导出烧录三方读同一份
  const { subtitleStyle, saveSubtitleStyle, clearSubtitleStyle } =
    useSubtitleStyle(projectId);

  // ---- 转场层（Render V2）：挂在相邻镜头接缝上 ----
  const { transitions, refreshTransitions, clearTransitions } = useTransitions(projectId);

  // ---- 任务层（生产 job 轮询 + P2-3 接回 + P2-5 SSE）----
  const { jobList, generating, prodJob, jobPhase, trackJob, clearJobs } = useProdJobs({
    projectId, say, refreshDetail, refreshSoon, refreshAudio, refreshSubtitles,
  });

  const openProject = (id: string) => {
    resetWorkspace();          // 修复：切项目必须清空上一项目的预览/剪辑/选中态
    setProjectId(id);
    localStorage.setItem("fw_project", id);
    // 落到「镜头」页而不是默认的「媒体」：媒体库对新项目必然是空的，
    // 而镜头页有四步引导条（拆解→资产→首帧→片段），是用户真正的起点。
    // 老项目同样合适——打开就看到进度到哪一步了。
    setLeftTab("ai-shots");
    refreshDetail(id);
  };
  const closeProject = () => {
    resetWorkspace();
    setProjectId(null);
    localStorage.removeItem("fw_project");
  };


  // ---- 生产看板操作 ----
  /** 后端提交去重命中：返回的是已在跑的那个 job，不是新提交的。
   *  照旧挂上追踪（换设备/刷新后也能接回），但要说清楚"没有开第二批"——
   *  否则用户以为提交成功、等半天没有额外产出，又去点第三次。 */
  const sayIfDeduped = (job: JobOut, ok: string): boolean => {
    if (job.deduped) {
      say(`⏳ 该项目已有生产任务在跑（${job.progress}%），本次不再重复提交`);
      return true;
    }
    say(ok);
    return false;
  };
  /** 当前质量档（⚡快速验证 / ◆精品）。决定生成时下发哪个模型。
   *  存 localStorage：用户在一个项目里选定的档位，切回来应该还在。 */
  const [tier, setTier] = useState<QualityTier>(
    () => (localStorage.getItem("fw_tier") as QualityTier) || "preview");
  useEffect(() => { localStorage.setItem("fw_tier", tier); }, [tier]);

  /** 生成镜头。modelId 缺省时按当前质量档下发——后端 shot_videos job
   *  一直支持 payload.model_id，之前只是前端没传，导致「精品」档形同虚设。 */
  /** 任务中心重试：定向任务（payload 带 shot_ids）只重跑那几镜，
   *  否则回落到该 kind 的全量入口。重跑全部会把已成功的镜头再烧一遍钱。 */
  const retryJob = (kind: string, shotIds: string[]) => {
    setTasksOpen(false);
    if (kind === "first_frames") doFirstFrames(shotIds.length ? shotIds : undefined);
    else if (kind === "costume_scan") doCostumeScan();
    else if (kind === "reprompt") doReprompt();
    else if (kind === "shot_videos" || kind === "first_frame_pipeline"
             || kind === "one_click_film") {
      doGenerate(shotIds.length ? shotIds
        : shots.filter((s) => !s.video_url && !s.disabled).map((s) => s.id));
    } else if (kind === "tts_batch") doSynthTts();
    else say(`该任务类型（${kind}）暂不支持一键重试，请在对应面板重新发起`);
  };

  /** 从任务中心跳到某个镜头：选中它并把左栏切回镜头列表 */
  const locateShot = (shotId: string) => {
    const s0 = shots.find((x) => x.id === shotId);
    if (!s0) { say("该镜头已不存在（可能已被删除）"); return; }
    setSelectedShotId(s0.id);
    setTasksOpen(false);
    setLeftTab("ai-shots");
  };

  const doGenerate = async (shotIds: string[], modelId?: string) => {
    if (!projectId || !shotIds.length) return;
    try {
      const model = modelId ?? tierModel(tier);
      const job = await api.submitShotsByIds(projectId, shotIds, model);
      trackJob(job, "shot_videos");
      sayIfDeduped(job,
        `已提交 ${shotIds.length} 个镜头生产（${modelId ? "精品升级" : TIER_LABEL[tier]}）`);
    } catch (e) { say(String(e)); }
  };

  /** 精品升级：用 Seedance 2.0 重生成，落成新版本供对比择优。
   *  不覆盖原版本——用户可能觉得快速验证那版构图更好。 */
  const doUpgrade = async (shot: ShotInfo) => {
    await doGenerate([shot.id], tierModel("final"));
  };
  // 批量首帧（i2va 路线：先出图后出片，构图不对及时止损）
  const doFirstFrames = async (shotIds?: string[]) => {
    if (!projectId) return;
    try {
      const job = await api.submitFirstFrames(projectId, { shotIds });
      trackJob(job, "first_frames");
      sayIfDeduped(job, shotIds?.length ? `已提交 ${shotIds.length} 个镜头首帧生成`
        : "已提交批量首帧生成（补齐所有缺失首帧）");
    } catch (e) { say(String(e)); }
  };
  // 一键成片（原「🚀 一条龙」已合并进来）：拆解 → 资产 → 首帧 → 片段 → 拼接。
  // stopAfter="assets" 时只补资产就收工——人物一致性靠定妆图注入，缺定妆图先补图，
  // 别让一整批"纯文生图"的首帧白烧钱。
  const doPipeline = async (opts: { genAssets: boolean;
                                    stopAfter?: "assets" | "frames" }) => {
    if (!projectId) return;
    try {
      const job = await api.submitFirstFramePipeline(projectId, {
        genAssets: opts.genAssets, stopAfter: opts.stopAfter,
      });
      trackJob(job, "first_frame_pipeline");
      sayIfDeduped(job,
        opts.stopAfter === "assets" ? "🖼 正在补齐资产图"
          : opts.stopAfter === "frames" ? "🎬 正在补齐资产与首帧（不出片）"
            : "▷ 正在生产：资产 → 首帧 → 片段");
    } catch (e) { say(String(e)); }
  };
  // 全剧服装识别（job，纯文本：逐集扫剧本 → 造型阶段落库）。
  // 必须能在补图之前单独跑：不识别就补图，补的只是"没有定妆图的角色"各一张，
  // 剧情里真正需要的睡衣/婚纱/西装根本没进过资产表（用户实测「测试3」即此情况）。
  const doCostumeScan = async () => {
    if (!projectId) return;
    try {
      const job = await api.submitCostumeScan(projectId);
      trackJob(job, "costume_scan");
      sayIfDeduped(job, "🔍 正在识别全剧服装（纯文本，不出图不花生图的钱）");
    } catch (e) { say(String(e)); }
  };
  // 按当前资产重对齐提示词（job，纯文本：不出图不出片）。
  // 镜头卡上的提示词是拆解时的初稿——那会儿资产还没生成，服装/人称都靠猜；
  // 与资产对齐的改写原本只发生在点「生成视频」之后，用户看不到也改不了。
  const doReprompt = async (shotIds?: string[]) => {
    if (!projectId) return;
    try {
      const job = await api.submitReprompt(projectId, { shotIds });
      trackJob(job, "reprompt");
      sayIfDeduped(job, shotIds?.length ? `✨ 正在按资产重写 ${shotIds.length} 个镜头的提示词`
        : "✨ 正在按当前资产重写全部镜头提示词（纯文本，不出图不出片）");
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

  // 生产 job 全部收尾时重拉造型阶段：服装识别 job 是**只写 asset_stages** 的，
  // refreshDetail 不含这张表，不重拉的话识别完资产页仍是旧的（看着像没生效）。
  useEffect(() => {
    if (!generating && projectId) void refreshStages(projectId);
  }, [generating, projectId, refreshStages]);

  // 一键成片跑到「资产/服装」段时也要重拉——否则资产图早就出好了、库里也有，
  // 轨道却要等整条流水线（首帧+片段+拼接，可能几十分钟）全跑完才显示。
  // 上面那个 effect 的条件是 !generating，一键成片全程为 true，永远不会触发。
  //
  // 用 done 的分档而不是 done 本身做依赖：refreshStages 没有防抖，
  // 25 张图逐张触发就是 25 次请求。每 5 张刷一次，够用且不打崩后端。
  const phaseKey = jobPhase?.key;
  const assetBatch = phaseKey === "assets" || phaseKey === "costume"
    ? Math.floor((jobPhase?.done ?? 0) / 5)
    : -1;
  useEffect(() => {
    if (!projectId || assetBatch < 0) return;
    void refreshStages(projectId);
  }, [phaseKey, assetBatch, projectId, refreshStages]);

  // ---- 一键成片 + 生产检查（T-R0-09）----
  // 原「🚀 一条龙」已与本入口合并：同一条链（拆解→资产→首帧→片段→拼接）没有理由
  // 摆两个按钮。后端 run_one_click_film 会跳过已完成的环节，所以从哪一环切入都安全。
  const [preflight, setPreflight] = useState(false);
  const doOneClick = async (opts: {
    genAssets: boolean;
    videoModel?: string | null;
    width?: number;
    height?: number;
  }) => {
    if (!projectId) return;
    // 刻意**不**关弹窗：它原地变成五段进度面板，用户能看到卡在哪一步。
    // 关掉的话进度就只剩顶栏一个百分比，看不出是在补资产还是在出片。
    try {
      const job = await api.submitOneClickFilm(projectId, {
        genAssets: opts.genAssets,
        // 这三个是"本次覆写"，undefined 时后端沿用项目设置
        videoModel: opts.videoModel ?? undefined,
        width: opts.width,
        height: opts.height,
      });
      trackJob(job, "one_click_film");
      say("▷ 一键成片已启动");
    } catch (e) { say(String(e)); setPreflight(false); }
  };

  /** 停止一键成片。语义是"不再为后续镜头发起新请求"——
   *  已经发给上游的那些照样会返回并计费，不假装能撤回。 */
  const stopOneClick = async () => {
    if (!prodJob) return;
    if (!window.confirm(
      "停止生产？\n\n已经提交给上游的生成请求无法撤回（该扣的费用仍会产生），"
      + "但后续镜头不会再发起新请求。\n已生成的内容都会保留。")) return;
    try {
      await api.cancelJob(prodJob.id);
      say("已请求停止，正在收尾…");
    } catch (e) { say(String(e)); }
  };

  // 阶段标签直接用后端的 phase.label（五段），拿不到时退回按 progress 粗分。
  // 旧的三段硬编码把资产/首帧/片段三段全叫"逐镜生成"，用户看不出卡在哪。
  const oneClickStage = !prodJob ? ""
    : jobPhase?.label ? jobPhase.label
      : prodJob.progress < 10 ? "拆解中" : prodJob.progress < 80 ? "逐镜生成" : "拼接成片";

  // ---- 素材层（P1-3 素材池落库）----
  const { libClips, deleteClip, renameClip, addClips, clearClips } = useLibClips(projectId, say);

  // ---- 面板尺寸拖拽已移入 EditorLayout（Phase 1）；此处只留 dock 最大化状态 ----
  // ---- 版块最大化（⛶ / Esc 还原）----
  const maxPanel = useEditorStore((s) => s.maximizedPanel);
  const setMaxPanel = useEditorStore((s) => s.setMaximizedPanel);
  const toggleMaximized = useEditorStore((s) => s.toggleMaximized);
  useEffect(() => {
    if (!maxPanel) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setMaxPanel(null); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [maxPanel, setMaxPanel]);

  // ---- Rail 导航 ↔ LibraryPanel 内部页签映射 ----
  // Phase 3 起「媒体」由 MediaPanel 承担，Phase 4 起「剧本」由 ScriptPanel 承担；
  // 旧 LibraryPanel 只剩 资产(生图) / 分镜 两个 Tab，Phase 5 拆完即可删。
  const leftTab = useEditorStore((s) => s.leftPanelTab);
  const setLeftTab = useEditorStore((s) => s.setLeftPanelTab);
  const RAIL_TO_LIB: Partial<Record<LeftPanelTab, LibTab>> = {
    "ai-image": "assets", "ai-shots": "shots",
  };
  const LIB_TO_RAIL: Record<LibTab, LeftPanelTab> = {
    script: "ai-script", assets: "ai-image", shots: "ai-shots",
  };
  const libTab = RAIL_TO_LIB[leftTab];

  // ---- Phase 5：资产轨选中段（Inspector 显示影响范围）----
  const [assetRun, setAssetRun] = useState<
    (AssetRun & { rowName: string; kind: AssetTrackKind }) | null>(null);

  // ---- Phase 6：导出 / 任务中心 / 设置 ----
  const [exportOpen, setExportOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localProgress, setLocalProgress] =
    useState<{ pct: number; stage: string } | null>(null);
  /** 渲染中断控制器（长任务必须能取消——1424 镜项目要跑几十分钟） */
  const [renderAbort, setRenderAbort] = useState<AbortController | null>(null);

  /** 本机 ffmpeg 渲染（Tauri sidecar）。浏览器预览下不可达，由 ExportDialog 屏蔽入口。 */
  const doLocalExport = async (o: {
    clips: ShotInfo[]; width: number; height: number; fps: number;
    vcodec: string; crf: number; withAudio: boolean;
    scope: "generated" | "all" | "selection";
    name?: string;
  }) => {
    if (!projectId || !detail) return;
    if (!o.clips.some((s) => s.video_url)) { say("没有已生成的镜头可导出"); return; }

    // Render Engine V2：Timeline → RenderPlan → 分段 → ffmpeg。
    // 分段是可行性前提：单张 filter_complex 在 1424 镜项目需 187GB，
    // 分段后峰值恒定 <1.5GB（详见 render/segment.ts 头注释）。
    const plan = normalizeRenderPlan({
      projectId,
      shots: o.clips,
      audioClips,
      subtitleClips: subtitles,
      transitions,
      output: {
        width: o.width, height: o.height, fps: o.fps,
        vcodec: o.vcodec, crf: o.crf, withAudio: o.withAudio,
      },
      scope: o.scope,
      selectedShotIds: selectedShot ? [selectedShot.id] : [],
    });

    // 字幕交给最后一道烧录（时间码由后端按镜头顺序换算，与分段无关）
    let burnSrt: string | undefined;
    try {
      const r = await api.subtitlesSrt(projectId);
      if (r.count > 0) burnSrt = r.srt;
    } catch { /* 拉不到字幕不该挡住导出 */ }

    // 项目级字幕样式（useSubtitleStyle 已随项目拉好）。烧录是一个 SRT 配
    // 一套 force_style，必须有个确定的"这个项目的字幕长什么样"，不能随便
    // 挑一条 cue 的 style 代表全体。为 null 时由 srtForceStyle 兜底默认值。

    const ctl = new AbortController();
    setRenderAbort(ctl);
    setLocalProgress({ pct: 0, stage: "准备" });
    try {
      const res = await renderV2({
        plan,
        preferEncoder: "auto",       // 有硬件编码器就用，否则回落 libx264
        burnSrt,
        subtitleStyle,
        // 用对话框里填的文件名；为空才回落到「项目名_日期」。
        // 此前这里写死了默认值，输入框改了也没用。
        defaultName: o.name
          || `${detail.title || "film"}_${new Date().toISOString().slice(0, 10)}`,
        onProgress: (p2) => setLocalProgress({ pct: p2.pct, stage: p2.stage }),
        signal: ctl.signal,
      });
      if (res.outputPath) {
        say(`✅ 已导出到 ${res.outputPath}（${res.segments} 段 · ${res.encoder} · `
          + `${(res.elapsedMs / 1000).toFixed(0)}s）`);
        setExportOpen(false);
      } else {
        say("已取消保存");
      }
    } catch (e) {
      // 用户主动取消不是错误，不弹失败提示
      if (e instanceof Error && e.name === "Aborted") say("已取消导出");
      else say(`本机渲染失败：${String(e)}`);
    } finally {
      setLocalProgress(null);
      setRenderAbort(null);
    }
  };

  // ---- 应用内进度看板（用户要求：进度在 web 预览里可见）----


  // ---- 导出层（拆解 job 追踪 + 导出口径）----
  // 云端合成已下线，成片一律由 doLocalExport 走本机 ffmpeg 收尾。
  const {
    exportClips, totalSec, bdProgress, doBreakdown: doBreakdownRaw, clearBreakdown,
  } = useBreakdown({ detail, say, refreshDetail });
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
        // 三类各自独立入栈。redo = 再做一遍原操作，与 undo 精确互逆。
        if (patch.durationSec !== undefined && old.duration_sec != null) {
          const prev = old.duration_sec;
          const next = patch.durationSec;
          pushUndo(`镜头 #${old.order} 时长 → ${next}s`,
            async () => {
              await api.patchShotTimeline(shotId, { durationSec: prev });
              await refreshDetail();
            },
            async () => {
              await api.patchShotTimeline(shotId, { durationSec: next });
              await refreshDetail();
            });
        }
        if (patch.toOrder !== undefined) {
          const prev = old.order;
          const next = patch.toOrder;
          pushUndo(`镜头 #${prev} 移到 #${next}`,
            async () => {
              await api.patchShotTimeline(shotId, { toOrder: prev });
              await refreshDetail();
            },
            async () => {
              await api.patchShotTimeline(shotId, { toOrder: next });
              await refreshDetail();
            });
        }
        if (patch.disabled !== undefined) {
          const prev = old.disabled;
          const next = patch.disabled;
          pushUndo(`镜头 #${old.order} ${next ? "停用" : "恢复启用"}`,
            async () => {
              await api.patchShotTimeline(shotId, { disabled: prev });
              await refreshDetail();
            },
            async () => {
              await api.patchShotTimeline(shotId, { disabled: next });
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
      if (selectedShotId === shotId) setSelectedShotId(null);
      await refreshDetail();
      say("已从镜头轨移除");
    } catch (e) { say(String(e)); }
  };

  // ---- 定位线派生：所在镜头（三视图高亮共用）+ 播控动作 ----
  const cursorShot = cursor ? (detail?.shots.find((s) => s.order === cursor.order) ?? null) : null;
  /** 定位线镜头的 effective 注入集合（(L1∪add)−remove，与生成注入同源）→ 资产页高亮 */
  const cursorChars = (() => {
    if (!cursorShot) return [] as string[];
    const ov = cursorShot.ref_overrides ?? {};
    const rm = ov.remove ?? [];
    return [...cursorShot.characters, ...(ov.add ?? [])].filter((c) => !rm.includes(c));
  })();
  const cursorLoc = (() => {
    if (!cursorShot) return null;
    const ov = cursorShot.ref_overrides ?? {};
    const rm = ov.remove_loc ?? [];
    const locs = [...(cursorShot.location ? [cursorShot.location] : []), ...(ov.add_loc ?? [])]
      .filter((c) => !rm.includes(c));
    return locs[0] ?? null;
  })();

  /** ▶ 从定位线播放（Space）：定位到定位线所在镜头+镜内秒；已在播同镜则暂停/续播切换 */
  const playFromCursor = () => {
    if (!cursor || !cursorShot) { say("先在时间轴刻度尺上单击放置定位线"); return; }
    if (!cursorShot.video_url) { say(`镜头 #${cursorShot.order} 尚未生成，无法播放`); return; }
    const v = videoRef.current;
    if (v && previewShot?.id === cursorShot.id) {
      // 同镜：Space 语义闭环——播放中=暂停，暂停中=从定位线继续
      if (!v.paused) { v.pause(); return; }
      v.currentTime = cursor.offsetSec;
      void v.play();
      return;
    }
    seekTo(cursorShot, cursor.offsetSec);
  };

  /** ⏮ 从头播放（Shift+Space）：第一个已生成且未停用的镜头从 0s 播 */
  const playFromStart = () => {
    const first = (detail?.shots ?? []).find((s) => s.video_url && !s.disabled);
    if (!first) { say("还没有已生成的镜头"); return; }
    setCursor({ order: first.order, offsetSec: 0 });
    seekTo(first, 0);
  };

  /** 🎯 定位线→播放位置（S）：把定位线吸到当前播放头（"看到这里了，标记住"） */
  const cursorToPlayhead = () => {
    if (!playhead) { say("当前没有在播放的镜头"); return; }
    setCursor({ order: playhead.order, offsetSec: playhead.offsetSec });
    say(`🎯 定位线已置于镜头 #${playhead.order} 第 ${playhead.offsetSec.toFixed(1)}s`);
  };

  /** ⏪ 回到定位线（不自动播）：反复对比某一帧时用 */
  const seekToCursor = () => {
    if (!cursor || !cursorShot) { say("先放置定位线"); return; }
    if (!cursorShot.video_url) { say(`镜头 #${cursorShot.order} 尚未生成`); return; }
    const v = videoRef.current;
    if (v && previewShot?.id === cursorShot.id) {
      v.pause();
      v.currentTime = cursor.offsetSec;
      return;
    }
    seekTo(cursorShot, cursor.offsetSec);
    // 跨镜 seek 后暂停（seekTo 会 autoplay，等元数据就绪后暂停）
    setTimeout(() => videoRef.current?.pause(), 400);
  };

  // ---- 全局快捷键（Phase 2：统一 Command 系统，旧散装 addEventListener 退役）----
  // 命令处理函数要读到"当前"的 store，用 getState() 而不是订阅——
  // 订阅会让 App 在每次选中/缩放变化时整棵树重渲，而这些命令只在按键时才需要值。
  const tlStore = () => useTimelineStore.getState();
  // 订阅栈长度（而非整个栈）：只有可撤销/可重做的**有无**变化时才重渲顶栏按钮。
  // 用 getState() 拿不到更新——它不建立订阅，按钮会一直停在初始的禁用态。
  // 顶栏、时间轴工具条、Ctrl+Z 现在都走这**同一个** store 栈。
  // 此前 useUndo 自己另有一个 ref 栈，所有 pushUndo 实际进的是那个，
  // 而按钮读的是 store 栈（从未被 push）—— 于是两个按钮永远置灰，
  // 只有 useUndo 自挂的键盘监听能用，重做则完全没实现。
  const tlUndoCount = useTimelineStore((s) => s.undoStack.length);
  const tlRedoCount = useTimelineStore((s) => s.redoStack.length);
  useCommands({
    playPause: playFromCursor,
    playFromStart,
    cursorToPlayhead,
    undo: () => tlStore().undo(),
    redo: () => tlStore().redo(),
    copy: () => tlStore().copySelection(),
    paste: () => {},   // Phase 2 后期：读 clipboard 并插入
    cut: () => {},
    deleteSelected: () => {
      const id = tlStore().selection.clipIds[0];
      if (!id) return;
      const clip = tlStore().findClip(id);
      if (!clip?.shotId) return;
      if (clip.isSpecial) void deleteSpecialShot(clip.shotId);
    },
    splitAtPlayhead: () => {
      // 用播放头所在的那个 clip 作为切割目标；播放头必须在片内（两端各留 0.5s）
      const ph = tlStore().playheadSec;
      const clip = tlStore().allClips().find(
        (c) => c.shotId && ph > c.startSec + 0.5 && ph < c.startSec + c.durationSec - 0.5);
      if (!clip?.shotId) { say("把播放头移到某个镜头中间再按 Ctrl+B"); return; }
      void doSplit(clip.shotId, ph - clip.startSec);
    },
    toggleDisabled: () => {
      const id = tlStore().selection.clipIds[0];
      const clip = tlStore().findClip(id ?? "");
      if (!clip?.shotId) return;
      void patchTimeline(clip.shotId, { disabled: !clip.disabled });
    },
    nudgeLeft: (big) => {
      const step = big ? 1 : 1 / 30;
      const v = videoRef.current;
      if (v) v.currentTime = Math.max(0, v.currentTime - step);
    },
    nudgeRight: (big) => {
      const step = big ? 1 : 1 / 30;
      const v = videoRef.current;
      if (v) v.currentTime = v.currentTime + step;
    },
    zoomIn: () => tlStore().zoomBy(1.25),
    zoomOut: () => tlStore().zoomBy(0.8),
    zoomFit: () => tlStore().fitTo(window.innerWidth - 800),
    escape: () => {
      tlStore().clearSelection();
      useEditorStore.getState().setSelectedClipId(null);
    },
    selectAll: () => {
      const ids = (detail?.shots ?? []).map((s) => s.id);
      tlStore().selectClips(ids);
    },
  });


  /** 旁白/配乐试听（时间轴音频轨点击）；素材预览走 LibraryPanel 的 onPreview */
  const previewAudio = (url: string, label: string) => previewMedia(url, label);

  // ---- 跨层协调：切/关项目清场（各层 clearXxx 统一从这里调度）----
  // 修复：切换/关闭项目时清空工作区状态，防止上一项目的预览/剪辑/选中态串到新项目
  function resetWorkspace() {
    clearPlayer();          // 预览/播放头/选中镜头
    setAdvancedShot(null);
    setFineCutOpen(false);
    clearClips();           // 素材池内存态
    clearStages();          // 人物/场景轨
    clearBreakdown();       // 拆解 job 轮询
    clearUndo();            // P2-2：撤销栈按项目隔离，切项目即清空
    clearAudio();           // P2-4：音频轨状态与合成轮询一并清
    clearSubtitles();       // TB-02：字幕轨按项目隔离，切项目即清
    clearSubtitleStyle();   // 字幕样式同理，否则上个项目的字号会串过来
    clearTransitions();     // Render V2：转场同理
    clearJobs();            // P2-3：停掉上一项目的 job 轮询（新项目从服务端重新接回）
    clearDetail();          // P2-5：合并刷新定时器一并清 + 旧 detail 立即失效
    // 两个 zustand store 不在上面任何 clearXxx 的覆盖范围内（F16）。
    // timeline 数据本身会因 detail=null → shots=[] 被重建 effect 清空，
    // 但播放头/定位线/选中/剪贴板/工具不走那条链路，会原样留给下一个项目。
    useTimelineStore.getState().resetForProjectSwitch();
    useEditorStore.getState().setSelectedClipId(null);
  }

  // ---- 后端不可达：给出可诊断的错误页 + 重试入口 ----
  // 此前这里把用户直接放进空项目列表，然后每个操作都失败，
  // 看不出是"后端挂了"还是"我的项目没了"。
  if (backendOk === false) {
    return (
      <div className="login-page">
        <div className="fw-offline">
          <div className="fw-offline-title">连不上后端服务</div>
          <div className="fw-offline-desc">
            请确认后端已启动。正在每 15 秒自动重试，恢复后会自动进入。
          </div>
          <button className="btn primary" onClick={() => { void retryBackend(); }}>
            立即重试
          </button>
        </div>
      </div>
    );
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

  // ---- 派生值：给 Inspector / TopBar 用 ----
  // totalSec / exportClips 来自 useCompose（与「快速导出」同口径，不另算一套）
  const shots = detail?.shots ?? [];
  // ⚠️ 从最新的 shots 里**派生**，不要存对象快照。
  // usePlayer 只持有 id —— 存整个对象的话，refreshDetail() 换掉 detail.shots
  // 之后它仍指向旧对象，多个面板会长期显示/使用陈旧数据
  // （特效面板开关关不掉、Inspector 切 tab 回退、版本徽标不更新，全是这一个根因）。
  const selectedShot = selectedShotId
    ? shots.find((s) => s.id === selectedShotId) ?? null
    : null;
  const doneCount = shots.filter((s) => s.video_url && !s.disabled).length;
  const inspectorShot = selectedShot;

  // ---- 播放器"正在播放"判断（用于播控按钮图标切换）----
  const videoEl = videoRef.current;
  const isPlaying = !!(videoEl && !videoEl.paused && previewUrl);

  // ---- 预览音频（TimelineDock 音频轨试听，见上方 previewAudio 定义）----

  /** Phase 1/3 过渡：旧 LibraryPanel 承担剧本/资产/镜头三个 Tab
   *  （它内部按 tab 切内容）。Phase 4 会拆成三个独立面板后删除此块。 */
  const legacyPanel = (
    <LibraryPanel
      projectId={projectId}
      clips={libClips}
      onAddClips={addClips}
      onAddToTimeline={addToTimeline}
      inserting={insertingClip}
      onPreview={(c) => previewMedia(c.url, c.name)}
      onDeleteClip={deleteClip}
      assetsMeta={detail?.assets ?? []}
      stages={stages}
      onRefreshStages={() => refreshStages()}
      onRefresh={() => refreshDetail()}
      onToast={say}
      shots={shots}
      episodes={detail?.episodes ?? []}
      selectedShotId={selectedShot?.id ?? null}
      cursorOrder={cursor?.order ?? null}
      cursorChars={cursorChars}
      cursorLoc={cursorLoc}
      onSelectShot={onSelectShot}
      onGenerate={doGenerate}
      onSwitchVersion={doSwitchVersion}
      onAdvanced={(s) => setAdvancedShot(s)}
      generating={generating}
      jobPhase={jobPhase}
      onBreakdown={doBreakdown}
      breakdownProgress={bdProgress}
      onFirstFrames={doFirstFrames}
      onReprompt={doReprompt}
      onPipeline={doPipeline}
      onCostumeScan={doCostumeScan}
      tab={libTab}
      onTabChange={(t) => setLeftTab(LIB_TO_RAIL[t])}
      hideTabs
    />
  );

  /** Render V2 多轨：主轨 ↔ 叠加层互移。
   *  移到叠加层时默认用播放头位置作起点——用户刚在那儿看画面，
   *  那多半就是他想让这段叠上去的时刻。 */
  const doMoveTrack = async (shotId: string, trackIndex: number, startSec?: number) => {
    try {
      await api.patchShotTimeline(shotId, {
        trackIndex,
        ...(trackIndex > 0 ? { overlayStartSec: Math.max(0, startSec ?? 0) } : {}),
      });
      await refreshDetail();
      say(trackIndex > 0
        ? `已移到叠加层，起点 ${(startSec ?? 0).toFixed(1)}s（可在检查器调整）`
        : "已移回主轨");
    } catch (e) { say(String(e)); }
  };

  /** Render V2 转场：把转场加在「选中镜头」与它下一个镜头的接缝上。
   *  转场是两个 clip 之间的关系，所以必须先选中一个镜头才知道加在哪条缝。 */
  const doApplyTransition = async (type: string) => {
    if (!projectId || !selectedShot) { say("请先在时间轴选中一个镜头"); return; }
    const sorted = [...shots].filter((s) => !s.disabled).sort((a, b) => a.order - b.order);
    const i = sorted.findIndex((s) => s.id === selectedShot.id);
    const next = sorted[i + 1];
    if (!next) { say("最后一个镜头之后没有接缝，请选中前一个镜头"); return; }
    try {
      const r = await api.createTransition({
        project_id: projectId,
        from_shot_id: selectedShot.id, to_shot_id: next.id,
        type, duration: 0.5,
      });
      await refreshTransitions();
      say(`已在 #${selectedShot.order} → #${next.order} 加「${type}」转场（${r.duration}s）`
        + `${r.replaced ? "，替换了原有转场" : ""}`);
    } catch (e) { say(String(e)); }
  };

  /** TB-08 自动字幕：对已合成的 AI 旁白做语音识别，按时间戳生成字幕段。 */
  const doAutoSubtitles = async () => {
    if (!projectId) return;
    try {
      const job = await api.submitAutoSubtitles(projectId, true);
      trackJob(job, "auto_subtitles");
      say("🎧 正在识别旁白并生成字幕（纯文本，不出图不出片）");
    } catch (e) { say(String(e)); }
  };

  /** TB-05 生成变体：同提示词换一个随机 seed 再出一版，落成新的 shot_version，
   *  用户可在 Inspector 版本列表里对比、择优采用。 */
  /** 修正镜头拆解结果。后端会置 stale，提示已出片内容已过期。 */
  const doPatchBreakdown = async (shotId: string, patch: {
    scriptRef?: string; characters?: string[];
    location?: string; linkToPrev?: "continuous" | "transition";
  }) => {
    await api.patchShotBreakdown(shotId, patch);
    await refreshDetail();
  };

  /** 保存手改的提示词。后端同时写 profile_override.prompt，
   *  否则有参考图时会被 AI 重新优化覆盖。 */
  const doPatchPrompt = async (shotId: string, text: string) => {
    await api.patchShotPrompt(shotId, text);
    await refreshDetail();
  };

  /** 撤销手改，交还给 AI */
  const doResetPrompt = async (shotId: string) => {
    await api.resetShotPrompt(shotId);
    await refreshDetail();
  };

  /** 单镜重算提示词（异步 job，只调文本模型，不出图不出片） */
  const doRepromptOne = (shotId: string) => {
    if (!projectId) return;
    void api.submitReprompt(projectId, { shotIds: [shotId] })
      .then((job) => { trackJob(job, "reprompt"); say("正在重新生成提示词…"); })
      .catch((e) => say(String(e)));
  };

  const doGenerateVariant = async (shot: ShotInfo) => {
    if (!projectId) return;
    // seed 在前端摇：后端拿到显式 seed 会记进版本 meta，同一个 seed 可复现
    const seed = Math.floor(Math.random() * 2_000_000_000);
    try {
      const job = await api.submitShotsByIds(projectId, [shot.id], undefined, seed);
      trackJob(job, "shot_videos");
      say(`🎲 正在为镜头 #${shot.order} 生成变体（seed ${seed}）`);
    } catch (e) { say(String(e)); }
  };

  /** TB-03/TB-10 保存画面与音频调整；空对象 = 清除全部调整。 */
  const doPatchTransform = async (
    shotId: string, tm: TransformMeta | Record<string, never>,
  ) => {
    try {
      await api.patchShotTimeline(shotId, { transformMeta: tm });
      await refreshDetail();
    } catch (e) { say(String(e)); }
  };

  /** TB-01 镜头分割：把某镜在 atSec 秒处切成两段（不重新转码，只记取片窗口）。 */
  const doSplit = async (shotId: string, atSec: number) => {
    try {
      const r = await api.splitShot(shotId, atSec);
      await refreshDetail();
      say(`已分割为 #${r.head_order}（${r.head_duration}s）+ #${r.tail_order}（${r.tail_duration}s）`);
    } catch (e) { say(String(e)); }
  };

  /** 音频面板：「音频」与「AI 配音」两个 Rail 入口共用同一实例，
   *  不做第二套 UI —— 同一能力两处实现必然漂移。 */
  const audioPanel = (
    <AudioPanel
      projectId={projectId}
      audioClips={audioClips}
      assets={detail?.assets ?? []}
      ttsAvailable={ttsAvailable}
      synthBusy={ttsJobId !== null}
      productionMode={detail?.production_mode}
      narrationVoiceUrl={detail?.narration_voice_url}
      onSynthTts={doSynthTts}
      onPreview={previewAudio}
      onAudioChanged={() => refreshAudio()}
      onProjectChanged={() => refreshDetail(projectId)}
      onToast={say} />
  );

  return (
    <EditorLayout
      topBar={
        <TopBar
          projectTitle={detail?.title ?? "加载中…"}
          appVersion={APP_VERSION}
          baseAspect={detail?.base_aspect}
          productionMode={detail?.production_mode}
          backendOk={backendOk}
          onBack={closeProject}
          canUndo={tlUndoCount > 0} onUndo={() => { void doUndo(); }}
          canRedo={tlRedoCount > 0} onRedo={() => { void doRedo(); }}
          generating={generating}
          progress={prodJob?.progress ?? 0}
          stageLabel={oneClickStage}
          onProduce={() => setPreflight(true)}
          jobCount={jobList.length}
          onOpenTasks={() => setTasksOpen(true)}
          fineCutEnabled={shots.some((s) => s.video_url)}
          onFineCut={() => setFineCutOpen(true)}
          exporting={localProgress !== null}
          exportProgress={localProgress?.pct ?? 0}
          onExport={() => setExportOpen(true)}
          theme={theme}
          onToggleTheme={toggleTheme}
          userName={user ? (user.display_name ?? user.username) : null}
          onLogout={doLogout}
          onOpenSettings={() => setSettingsOpen(true)}
          updateState={updateState}
          updateProgress={updateProgress}
          onCheckUpdate={checkUpdate}
          onRelaunch={() => relaunch()}
        />
      }
      rail={<Rail />}
      leftPanel={
        <LeftPanel
          panels={{
            /* Phase 3：媒体 / 音频 / 文本 / 转场 / 特效 / 调节 —— 新面板 */
            media: (
              <MediaPanel
                projectId={projectId}
                clips={libClips}
                shots={shots}
                inserting={insertingClip}
                onAddClips={addClips}
                onAddToTimeline={addToTimeline}
                onPreview={(c) => previewMedia(c.url, c.name)}
                onDeleteClip={deleteClip}
                onRenameClip={renameClip}
                onToast={say} />
            ),
            audio: audioPanel,
            /* AI 配音与「音频」是同一套能力，不做第二套 UI —— 只是从 AI 组也能进 */
            "ai-voice": audioPanel,
            text: (
              <TextPanel
                projectId={projectId}
                hasSelection={!!selectedShot}
                // 字幕锚定"第几镜 + 镜内第几秒"，与后端同构；没有播放头就落到第 1 镜
                anchor={playhead ?? (cursor ?? null)}
                onAutoSubtitles={doAutoSubtitles}
                clips={subtitles}
                style={subtitleStyle}
                onSaveStyle={saveSubtitleStyle}
                onChanged={() => { void refreshSubtitles(); }}
                onToast={say} />
            ),
            transition: (
              <EffectsPanel kind="transition" hasSelection={!!selectedShot}
                shotId={selectedShot?.id ?? null}
                projectId={projectId}
                transform={selectedShot?.transform_meta ?? null}
                onPatchTransform={(tm) => { if (selectedShot) void doPatchTransform(selectedShot.id, tm); }}
                onApplyTransition={(t) => { void doApplyTransition(t); }}
                onToast={say} />
            ),
            effect: (
              <EffectsPanel kind="effect" hasSelection={!!selectedShot}
                shotId={selectedShot?.id ?? null}
                projectId={projectId}
                transform={selectedShot?.transform_meta ?? null}
                onPatchTransform={(tm) => { if (selectedShot) void doPatchTransform(selectedShot.id, tm); }}
                onToast={say} />
            ),
            filter: (
              <EffectsPanel kind="filter" hasSelection={!!selectedShot}
                shotId={selectedShot?.id ?? null}
                projectId={projectId}
                transform={selectedShot?.transform_meta ?? null}
                onPatchTransform={(tm) => { if (selectedShot) void doPatchTransform(selectedShot.id, tm); }}
                onToast={say} />
            ),
            /* Phase 6：AI 任务 —— 与右上角任务中心抽屉共用同一组件，
               不做第二套 UI（同一份数据两种呈现最容易走样） */
            "ai-tasks": (
              <TasksDrawer projectId={projectId}
                onRetry={retryJob}
                onLocateShot={locateShot}
                onClose={() => setLeftTab("ai-shots")} />
            ),
            /* Phase 4：剧本 / AI 视频 已拆为独立面板 */
            "ai-script": (
              <ScriptPanel
                projectId={projectId}
                episodes={detail?.episodes ?? []}
                shots={shots}
                breakdownProgress={bdProgress}
                onBreakdown={doBreakdown}
                onRefresh={() => refreshDetail()}
                onToast={say} />
            ),
            "ai-video": (
              <VideoPanel
                shots={shots}
                generating={generating}
                progress={prodJob?.progress ?? 0}
                jobPhase={jobPhase}
                productionMode={detail?.production_mode ?? null}
                tier={tier}
                onTierChange={setTier}
                onGenerate={doGenerate}
                onFirstFrames={doFirstFrames}
                onReprompt={doReprompt}
                onCostumeScan={doCostumeScan}
                onStagesDraft={doStagesDraft}
                stagesDrafting={drafting}
                onFillAssets={() => doPipeline({ genAssets: true, stopAfter: "assets" })}
                onOneClick={() => setPreflight(true)}
                onSelectShot={onSelectShot}
                onToast={say} />
            ),
            /* 资产(生图) / 分镜 仍由旧 LibraryPanel 承担（内部按 tab 切内容），
             * Phase 5 迁资产轨时一并拆分。 */
            "ai-image": legacyPanel,
            "ai-shots": legacyPanel,
          }}
        />
      }
      player={
        <Player
          videoRef={videoRef}
          previewUrl={previewUrl}
          previewLabel={previewLabel}
          previewShot={previewShot}
          playhead={playhead}
          cursor={cursor}
          autoNext={autoNext}
          setAutoNext={setAutoNext}
          baseAspect={detail?.base_aspect}
          playing={isPlaying}
          // 取**正在预览**那个镜头的调色参数，不是 selectedShot ——
          // 两者可能不同（点了 A 镜预览、又在列表里选中 B 镜），
          // 用 selectedShot 会把 B 的调色套到 A 的画面上。
          transform={shots.find((s) => s.id === previewShot?.id)?.transform_meta ?? null}
          subtitles={subtitles}
          subtitleStyle={subtitleStyle}
          emptyHint={`${shots.filter((s) => !s.disabled).length} 段可导出 · ${fmtTime(totalSec)}`}
          onLoadedMetadata={(e) => {
            if (pendingSeek.current != null) {
              e.currentTarget.currentTime = pendingSeek.current;
              pendingSeek.current = null;
            }
          }}
          onTimeUpdate={(e) => {
            if (previewShot)
              setPlayhead({ order: previewShot.order, offsetSec: e.currentTarget.currentTime });
          }}
          onEnded={() => onPreviewEnded(shots)}
          onPlayFromStart={playFromStart}
          onPlayFromCursor={playFromCursor}
          onSeekToCursor={seekToCursor}
          onCursorToPlayhead={cursorToPlayhead}
          onToggleMaximize={() => toggleMaximized("player")}
        />
      }
      inspector={
        /* 资产段被选中时 Inspector 切换为资产视图（PLAN §11），
         * 否则显示镜头属性 / 项目概览 */
        assetRun ? (
          <AssetInspector
            run={assetRun}
            shots={shots}
            onRegenerate={doGenerate}
            onSelectShot={(s) => { setAssetRun(null); onSelectShot(s); }}
            onClose={() => setAssetRun(null)} />
        ) : (
          <Inspector
          shot={inspectorShot}
          projectTitle={detail?.title ?? ""}
          baseAspect={detail?.base_aspect}
          shotCount={shots.length}
          doneCount={doneCount}
          totalSec={totalSec}
          onRegenerate={doGenerate}
          onOpenAdvanced={(s) => setAdvancedShot(s)}
          onPatchDuration={(shotId, sec) => { void patchTimeline(shotId, { durationSec: sec }); }}
          onPatchTransform={(shotId, tm) => { void doPatchTransform(shotId, tm); }}
          onGenerateVariant={doGenerateVariant}
          onUpgrade={(sh) => { void doUpgrade(sh); }}
          onSwitchVersion={doSwitchVersion}
          assets={detail?.assets ?? []}
          onPatchBreakdown={doPatchBreakdown}
          onPatchPrompt={doPatchPrompt}
          onResetPrompt={doResetPrompt}
          onRepromptOne={doRepromptOne}
          onToast={say}
          />
        )
      }
      dock={
        /* Phase 2–5：新版时间轴（绝对时间坐标 / 多轨 / 资产轨注入 / 右键菜单 / Undo）。
         * 收尾阶段已移除旧 TimelineDock —— 其全部能力（资产轨拖拽注入、换图、
         * 整段平移、重置人工覆写、边缘拖拽改范围）均已迁入 features/assets/AssetTrack。 */
        <Timeline
          shots={shots}
          audioClips={audioClips}
          subtitleClips={subtitles}
          stages={stages}
          locations={locations}
          assets={detail?.assets ?? []}
          selectedShotId={selectedShot?.id ?? null}
          onSelectShot={onSelectShot}
          playhead={playhead}
          cursor={cursor}
          onSetCursor={setCursor}
          onSeek={seekTo}
          maximized={maxPanel === "dock"}
          onToggleMax={() => toggleMaximized("dock")}
          onPatch={patchTimeline}
          onDeleteShot={deleteSpecialShot}
          onRegenerate={doGenerate}
          onUpgrade={(sh) => { void doUpgrade(sh); }}
          /* 版本历史常驻 Inspector 的「版本」区，选中该镜即可见，不另开弹窗 */
          onShowVersions={(s: ShotInfo) => setSelectedShotId(s.id)}
          onPatchTransform={(sid, patch) => { void doPatchTransform(sid, patch); }}
          onSplit={doSplit}
          onDropClip={(c) => { void addToTimeline(c as LibClip); }}
          onMoveTrack={(id, idx, st) => { void doMoveTrack(id, idx, st); }}
          onPushUndo={pushUndo}
          onToast={say}
          onAssetsChanged={() => { refreshStages(); refreshDetail(); }}
          onSelectAssetRun={setAssetRun}
          selectedAssetRunId={assetRun?.id ?? null}
          totalSec={totalSec}
          exportCount={exportClips.length}
          projectId={projectId} />
      }
      banners={
        <>
          {updateState === "downloading" && (
            <div className="export-bar">
              <div style={{ width: `${updateProgress}%`, background: "var(--ok)" }} />
            </div>
          )}
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
            <div className="export-bar"
              title={jobList.length > 1 ? `${jobList.length} 个任务并行` : ""}>
              <div style={{ width: `${Math.round(jobList.reduce((s, j) => s + j.progress, 0) / jobList.length)}%` }} />
            </div>
          )}
          {localProgress && (
            <div className="export-bar"><div style={{ width: `${localProgress.pct}%` }} /></div>
          )}
        </>
      }
      overlays={
        <>
          {preflight && detail && (
            <PreflightDialog projectId={projectId} mode="film"
              hasScript={!!(detail.raw_script || detail.optimized_script)}
              productionMode={detail.production_mode}
              narrationVoiceUrl={detail.narration_voice_url}
              onNarrationVoiceChanged={() => refreshDetail(projectId)}
              running={!!prodJob} progress={prodJob?.progress} phase={jobPhase}
              onToast={say} onClose={() => setPreflight(false)} onFilm={doOneClick}
              onStop={stopOneClick}
              onProceed={() => { setPreflight(false); doGenerate(shots.filter((s) => !s.video_url).map((s) => s.id)); }}
              onGenFrames={(ids) => { setPreflight(false); doFirstFrames(ids); }}
              onFillAssets={() => { setPreflight(false); doPipeline({ genAssets: true, stopAfter: "assets" }); }}
              onCostumeScan={doCostumeScan} />
          )}
          {advancedShot && (
            <ShotAdvanced shot={advancedShot} productionMode={detail?.production_mode ?? null}
              onClose={() => setAdvancedShot(null)}
              onSaved={() => refreshDetail()} onToast={say} />
          )}
          {fineCutOpen && detail && (
            <FineCut projectId={projectId} baseAspect={detail.base_aspect}
              shots={shots} onClose={() => setFineCutOpen(false)}
              onRegenerate={doGenerate} onToast={say} />
          )}

          {/* Phase 6：导出对话框（只有本机 ffmpeg 一条通道，云端合成已下线） */}
          {exportOpen && detail && (
            <ExportDialog
              shots={shots}
              baseAspect={detail.base_aspect}
              projectTitle={detail.title}
              selectedShotIds={selectedShot ? [selectedShot.id] : []}
              onLocalExport={doLocalExport}
              localBusy={localProgress !== null}
              localProgress={localProgress}
              onCancel={() => renderAbort?.abort()}
              onClose={() => setExportOpen(false)} />
          )}

          {/* Phase 6：任务中心抽屉 */}
          {tasksOpen && projectId && (
            <div className="fw-drawer-mask" onClick={() => setTasksOpen(false)}>
              <div onClick={(e) => e.stopPropagation()} style={{ height: "100%" }}>
                <TasksDrawer projectId={projectId}
                  onRetry={retryJob}
                  onLocateShot={locateShot}
                  onClose={() => setTasksOpen(false)} />
              </div>
            </div>
          )}

          {/* Phase 6：设置 */}
          {settingsOpen && (
            <SettingsDialog
              theme={theme}
              onToggleTheme={toggleTheme}
              productionMode={detail?.production_mode ?? null}
              projectId={projectId}
              onToast={say}
              onClose={() => setSettingsOpen(false)} />
          )}
        </>
      }
    />
  );
}
