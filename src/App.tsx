import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, APP_VERSION, JobOut, ShotInfo, sendQueuedWrite } from "./api";
import type { TransformMeta, TransformPatchOpts } from "./api";
import { tierModel, TIERS, type QualityTier } from "./lib/qualityTiers";
// 2.3 乐观锁：transform_meta 的版本号注册表 + 带状态码的写错误
import { shotRev } from "./lib/shotRev";
import { describeTransform } from "./lib/transformLabel";
import { SaveHttpError } from "./stores/saveStateStore";
import { useLoadState } from "./stores/loadStateStore";
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
import { decideScreen } from "./lib/appGate";
import { offlineBannerText, describeReplay } from "./lib/outbox";
import { getOutboxCount, subscribeOutbox, runReplay, isDurable } from "./lib/outboxStore";
import { describeSnapshotAge } from "./lib/snapshot";
import { useTheme } from "./hooks/useTheme";
import { useUpdater } from "./hooks/useUpdater";
import { useAuth } from "./hooks/useAuth";
import { useProject } from "./hooks/useProject";
import { useStagedTransform } from "./hooks/useStagedTransform";
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
import { outPatch, clearWindowPatch, inPatch, trimIn, trimOut,
         minTrimSec, canTrimIn, inPointOf, outPointOf, quantizeSec,
         MIN_CLIP_SEC, MAX_CLIP_SEC_FALLBACK, windowDurOf,
       } from "./features/timeline/trim";
import { nudgeSec, edgeSec, clampSec, nextShuttle, REVERSE_TICK_MS,
         NUDGE_STEP_SEC, NUDGE_BIG_SEC } from "./features/timeline/playhead";
import { buildEdgeSecs, buildOrderOffsetMap, secToPosition, shotDuration } from "./adapters/shotToClip";
import { clampTransitionSec, maxTransitionSec } from "./features/timeline/transitions";
import type { SeamMarker } from "./features/timeline/transitions";
import type { ScrubPhase } from "./features/timeline/scrub";
import { allSelectableIds, sideIds } from "./features/timeline/selection";
import { canDeleteFromTimeline, movePatch } from "./features/timeline/clipEdit";
import type { ClipEditPatch } from "./features/timeline/clipEdit";
import type { Clip } from "./types/timeline";
import { clearWaveformCache } from "./features/timeline/Waveform";
import type { AssetRun, AssetTrackKind } from "./features/assets/AssetTrack";
// ---- Phase 3 重构：基础剪辑面板 ----
import MediaPanel from "./features/media/MediaPanel";
import AudioPanel from "./features/audio/AudioPanel";
import TextPanel from "./features/subtitles/TextPanel";
import EffectsPanel from "./features/effects/EffectsPanel";
// ---- Phase 4 重构：FilmWeaver AI 模块 ----
import ScriptPanel from "./features/script/ScriptPanel";
import VideoPanel from "./features/generation/VideoPanel";
import ExportDialog, { IS_TAURI } from "./features/export/ExportDialog";
import {
  planEpisodeJobs, summarizeExportRun, type JobOutcome,
} from "./features/export/exportRun";
import TasksDrawer from "./features/tasks/TasksDrawer";
import SettingsDialog from "./features/settings/SettingsDialog";
import { normalize as normalizeRenderPlan } from "./render/normalize";
import { collectTrackFlags } from "./render/trackFlags";
import { render as renderV2 } from "./render/renderer";
import { localSources, prefetcher } from "./lib/mediaCache";
import { probeCapabilities, hasFilter, hasTransition } from "./render/capabilities";
import { planToSrt } from "./render/srt";
import { save, open, confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { join, downloadDir } from "@tauri-apps/api/path";
import {
  safeFileName, episodeFileName, dirOf, baseOf, stripMp4,
} from "./lib/filename";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useTimelineStore } from "./stores/timelineStore";
import { useCommands } from "./commands";
import { useEditorStore, LeftPanelTab } from "./stores/editorStore";
import { useCanvasToolStore } from "./stores/canvasToolStore";

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
  // 6.8：断 → 通 的那一下先**补发离线队列**，再把结果原原本本说出来。
  // 6.7 时这里传的是 `say`，由 useAuth 自己造句「有 N 处没能保存」——
  // 现在那句话已经不成立（真的会补发了），造句权因此收回到这一层，
  // 因为只有这里够得着队列。详见 `lib/appGate.ts` 里那块墓碑注释。
  const onReconnect = useCallback(() => {
    void (async () => {
      const r = await runReplay(sendQueuedWrite);
      // null = 队列本来就是空的（或已有一趟在跑）。空队列时不该报补发结果，
      // 但"连上了"这件事仍然要说 —— 用户刚刚一直盯着那条横幅。
      say(r === null ? "已恢复与服务器的连接" : describeReplay(r));
    })();
  }, [say]);
  const { backendOk, loginRequired, user, doLogout, onLoggedIn, retry: retryBackend } = useAuth(onReconnect);

  // 6.8 待补发笔数。订阅而不是轮询：入队发生在 `trackedFetch` 里（不在任何组件中），
  // 组件这边只能靠 store 通知。`getOutboxCount` 返回的是数字（原始值），
  // 引用稳定性天然满足 `useSyncExternalStore` 的要求。
  const pendingWrites = useSyncExternalStore(subscribeOutbox, getOutboxCount);

  // ---- 项目层（T-R0-07 状态云端化）----
  const { projectId, setProjectId, detail, snapshotAt, refreshDetail, refreshSoon, clearDetail } = useProject();

  /** 2.2 画面调整的**真正落库**动作。拖动中的中间值不直接走这里，
   *  由 `stagedTransform` 按尾防抖调用（见 hooks/useStagedTransform.ts）。
   *
   *  ⚠️ 失败必须**抛出去**：stagedWrite 靠异常判断"没落库"，
   *  从而保留本地值不回滚。这里 catch 掉再吞了，
   *  它会以为存成功、撤掉本地盖层 —— 用户的调整就在画面上悄悄消失了。
   *
   *  3.7 把它拆成两层：这一层只管写，**不入撤销栈**，撤销/重做闭包直接走它；
   *  下面的 `commitTransform` 才是给 stagedWrite 的入口，负责记旧值 + 入栈。
   *  合成一层的话，撤销时的那次写又会推一条新记录，Ctrl+Z 变成来回横跳。 */
  const writeTransform = async (
    shotId: string, tm: TransformMeta | Record<string, never>,
  ) => {
    try {
      // 2.3 乐观锁：带上"这次改动所基于的版本号"，服务端发现库里已经变了
      // 就回 409。不带的话后写方会静默盖掉先写方的调整。
      const r = await api.patchShotTimeline(shotId, {
        transformMeta: tm, baseTransformRev: shotRev.base(shotId),
      });
      shotRev.noteWritten(shotId, r.transform_rev);
      // ⚠️ 必须等 refreshDetail 回来再让 stagedWrite 撤掉本地盖层，
      // 否则会有一帧显示服务端旧值（松手瞬间画面闪回）。
      await refreshDetail();
    } catch (e) {
      if (e instanceof SaveHttpError && e.status === 409) {
        // 并发冲突。本地值按 2.2 的规则**保留**（用户眼前仍是自己调的画面，
        // 顶栏同时显示未保存），但必须明确告诉他服务端不是这个值。
        // forget 之后再操作一次就不带 base 了 —— 提示给过一次，
        // 之后以他自己的版本为准是他知情下的选择，而不是把他锁死在 409 里。
        shotRev.forget(shotId);
        say("该镜头已被其他窗口修改，这次调整未保存 —— 画面上仍是你的版本，再调一次即以你的为准");
        throw e;
      }
      say(String(e)); throw e;
    }
  };

  /**
   * 落库 + 入撤销栈。**一次拖拽只进一条**：中间帧走 `stage()` 不落库，
   * 尾防抖把整段拖动收敛成一次 commit（`lib/stagedWrite.ts` 文件头），
   * 所以这里天然是"一次手势一条记录"，与 3.6 转场滑块同一口径。
   * 若按每帧入栈，拖 3 秒会往深度 50 的栈里塞满同一个镜头的中间值，
   * 把此前所有真正的编辑记录全部挤掉 —— 那比没有撤销更坏。
   */
  const commitTransform = async (
    shotId: string, tm: TransformMeta | Record<string, never>,
  ) => {
    // 旧值必须在写之前取。拖动期间 detail 没刷新过，这里拿到的正是这次手势
    // 开始前的服务端值 —— 也就是用户心里"撤销该回到的样子"。
    const before = detail?.shots.find((s) => s.id === shotId);
    const prev = (before?.transform_meta ?? {}) as TransformMeta | Record<string, never>;
    const same = JSON.stringify(prev) === JSON.stringify(tm);
    await writeTransform(shotId, tm);
    // 松手时若防抖计时器已经把同样的值写过一遍，这次就是个空操作 ——
    // 入栈的话用户要按两下 Ctrl+Z 才看见画面变，第一下像是"撤销坏了"。
    if (same) return;
    const label = Object.keys(tm).length === 0
      ? `清除镜头 #${before?.order ?? "?"} 的画面调整`
      : `调整镜头 #${before?.order ?? "?"} 的画面（${describeTransform(tm)}）`;
    pushUndo(label,
      async () => { await writeTransform(shotId, prev); },
      async () => { await writeTransform(shotId, tm); });
  };
  // hook 必须在早返回（后端探测 / 登录门控 / 项目列表）之前无条件调用
  const stagedTransform = useStagedTransform(commitTransform);

  // 2.3：详情每回来一次就收下服务端的 transform 版本号，但**跳过还有未落库
  // 改动的镜头** —— 那些镜头屏幕上显示的是用户自己的值，采纳新版本号等于
  // 主动放弃冲突检测。规则的完整推导见 lib/shotRev.ts 文件头。
  useEffect(() => {
    shotRev.seed(detail?.shots ?? [], stagedTransform.hasPending);
  }, [detail, stagedTransform]);

  // ---- 播放器层（P2-1 播放头 + 连播 + 选中镜头）----
  const {
    videoRef, previewUrl, previewLabel, previewShot, playhead, setPlayhead,
    pendingSeek, pendingPause, autoNext, setAutoNext, selectedShotId, setSelectedShotId,
    onSelectShot, seekTo, onPreviewEnded, previewMedia, previewShotVersion,
    clearPlayer, cursor, setCursor,
    previewWindow, toMediaTime, toShotTime,
  } = usePlayer(projectId);

  // 6.3：把「当前项目」告诉本地素材解析器。
  //
  // 为什么是 effect 而不是写在 openProject 里：`Waveform` 那条链路
  // （Timeline → ClipView → Waveform）只有 url、拿不到 projectId，它靠的就是这个
  // 环境值。写在 openProject 里的话，将来任何一条新的"进入项目"路径
  // （恢复上次项目、深链、切租户）忘了跟着加一句，波形就会静默退回走网络——
  // 那种退化不报错、只是慢，最难被发现。挂在 projectId 上则天然覆盖全部路径。
  //
  // 只管"设"，不管"清"：清（连同 blob 回收）在 resetWorkspace() 里，
  // 那里才知道 <video> 的 src 已经摘掉了、此刻回收谁都不会黑屏。
  useEffect(() => { localSources.setProject(projectId); }, [projectId]);

  // ---- 编辑层（P2-2 撤销栈）----
  const { pushUndo, doUndo, doRedo, clearUndo } = useUndo(say);

  // ---- 音频层（P2-4 音频轨）----
  const { audioClips, ttsAvailable, ttsJobId, refreshAudio, doSynthTts, clearAudio } =
    useAudioTrack(projectId, say);

  // ---- 字幕层（TB-02）：时间轴字幕轨与文本面板共用同一份数据 ----
  const { subtitles, refreshSubtitles, clearSubtitles } = useSubtitles(projectId, say);
  // 项目级默认字幕样式：播放器预览 / 文本面板 / 导出烧录三方读同一份
  const { subtitleStyle, saveSubtitleStyle, clearSubtitleStyle } =
    useSubtitleStyle(projectId);

  // ---- 转场层（Render V2）：挂在相邻镜头接缝上 ----
  const { transitions, refreshTransitions, clearTransitions } = useTransitions(projectId, say);

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
      say(`⏳ 这个项目已经在出片了（${job.progress}%），先等这一轮跑完`);
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
      // 3.1：切版本 = 换素材，后端会清掉取片窗口（旧入点落在新素材上是错的）。
      // 这件事必须说出来 —— 用户回头看时间轴发现镜头变长了，得知道是为什么。
      say(r.clip_window_cleared
        ? `已切换到 V${verNo}（该镜的修剪入点已重置——换素材后旧入点不再对应）`
        : `已切换到 V${verNo}`);
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
    useState<{ pct: number; stage: string; etaSec?: number } | null>(null);
  /** 导出完成态：弹窗原地变成"已完成"面板（对齐剪映的导出结果页），
   *  而不是关掉弹窗只留一条转瞬即逝的 toast —— 用户往往还想立刻打开文件夹。 */
  const [exportDone, setExportDone] = useState<
    { path: string; segments: number; encoder: string; elapsedMs: number;
      /** 按集导出产出的文件数（>1 时 path 指向最后一个成片，用于定位所在目录） */
      files?: number;
      /** 6.0：失败的文件数。>0 时面板标题说「部分完成」而不是「导出完成」 */
      failed?: number;
      /** 5.8：导出成功但有降级（缺滤镜 / 动画蒙版超预算），在结果面板里长期可读 */
      notices?: string[] } | null>(null);
  /** 分段渲染的起算时刻，用来估剩余时间（见 doLocalExport 里的注释） */
  const segT0 = useRef<number | null>(null);
  /** 渲染中断控制器（长任务必须能取消——1424 镜项目要跑几十分钟） */
  const [renderAbort, setRenderAbort] = useState<AbortController | null>(null);

  // ---- V2.3 画布交互模式 ----
  // 从本地 useState 迁到 canvasToolStore：右侧检查器的马赛克/取景面板也要读写它
  // （面板点「圆形」要能激活画面绘制、点小按钮要能让面板翻到对应页签），
  // 靠 props 往下传要穿过 Inspector 的十几层，store 是更短的路径。
  const overlayMode = useCanvasToolStore((s) => s.overlayMode);
  const setOverlayMode = useCanvasToolStore((s) => s.setOverlayMode);

  /** 导出目录。记忆到 localStorage：导出是重复动作，用户几乎总是往同一个
   *  文件夹里放，每次都要重新翻目录树很烦。 */
  const [exportDir, setExportDir] = useState<string | null>(
    () => localStorage.getItem("fw_export_dir"));
  /** 没记忆过就默认「下载」目录——比空着强，用户至少知道会落到哪。
   *  downloadDir() 只在 Tauri 里可用，网页预览下保持 null（那边本来也导不了）。 */
  useEffect(() => {
    if (exportDir || !IS_TAURI) return;
    let alive = true;
    downloadDir()
      .then((d) => { if (alive && d) setExportDir(d); })
      .catch(() => { /* 拿不到就算了，用户点「选择…」即可 */ });
    return () => { alive = false; };
  }, [exportDir]);
  const rememberDir = (d: string) => {
    setExportDir(d);
    localStorage.setItem("fw_export_dir", d);
  };
  /** 路径分隔符按路径本身判断（Windows 反斜杠 / 其余正斜杠），
   *  拆分逻辑与单测同源，见 lib/filename.ts。 */

  /** 选导出文件夹（按集导出用；单文件没选过位置时也走它兜底）。 */
  const pickExportDir = async (): Promise<string | null> => {
    const d = await open({
      directory: true, multiple: false,
      defaultPath: exportDir ?? undefined,
      title: "选择导出文件夹",
    });
    const dir = typeof d === "string" ? d : null;
    if (dir) rememberDir(dir);
    return dir;
  };

  /**
   * 导出对话框里的「选择…」。
   *
   * 单文件走系统 save() 而不是选文件夹：save() 自带「同名文件已存在，是否替换」
   * 的原生确认，而我们做不了这个检查——fs 权限被 capabilities 限死在 $APPDATA，
   * 拿不到任意路径的 exists()。顺带把用户在对话框里改的文件名回填到输入框。
   */
  const pickExportPath = async (mode: "file" | "dir", suggestName: string) => {
    if (mode === "dir") {
      const dir = await pickExportDir();
      return dir ? { dir } : null;
    }
    const full = await save({
      defaultPath: exportDir
        ? await join(exportDir, `${suggestName}.mp4`)
        : `${suggestName}.mp4`,
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
    });
    if (!full) return null;
    const dir = dirOf(full);
    rememberDir(dir);
    return { dir, name: stripMp4(baseOf(full)) };
  };

  /** 本机 ffmpeg 渲染（Tauri sidecar）。浏览器预览下不可达，由 ExportDialog 屏蔽入口。 */
  const doLocalExport = async (o: {
    clips: ShotInfo[]; width: number; height: number; fps: number;
    vcodec: string; crf: number; withAudio: boolean;
    scope: "generated" | "all" | "selection" | "episode";
    name?: string;
    /** 对话框里已选好的目录；缺省时这里兜底弹一次选择器 */
    dir?: string;
    /** scope=episode：要导的集号；每集单独渲染成一个文件 */
    episodes?: number[];
  }) => {
    if (!projectId || !detail) return;
    if (!o.clips.some((s) => s.video_url)) { say("没有已生成的镜头可导出"); return; }

    const output = {
      width: o.width, height: o.height, fps: o.fps,
      vcodec: o.vcodec, crf: o.crf, withAudio: o.withAudio,
    };
    const defaultName = safeFileName(o.name
      || `${detail.title || "film"}_${new Date().toISOString().slice(0, 10)}`, 60)
      || "film";

    // ---- 0. 2.2：导出必须用**用户眼前看到的**参数 ----
    // 拖动中还没落库的 transform 先补一次落库（flush 内部吞异常，不会打断导出），
    // 同时把待写值盖到要导的镜头上：否则松手后立刻点导出，
    // 成片用的会是调整前的旧参数（o.clips 是 detail.shots 的对象引用）。
    await stagedTransform.flush();
    const clips = stagedTransform.applyPending(o.clips);

    // ---- 1. 先把"要产出哪些文件"排好，再开始渲染 ----
    // 旧做法：跑完 97% 才弹 save() 对话框——几十分钟渲染完，用户若取消或误关，
    // 全部计算作废。现在"选路径"和"跑渲染"拆成两个独立步骤，取消发生在跑之前，零成本。
    // 位置正常在导出对话框里就选好了（o.dir）；下面的弹窗只是没选过时的兜底。
    type Job = { shots: ShotInfo[]; outputPath: string; label: string };
    const jobs: Job[] = [];
    /** 目标路径是否已经由系统保存框问过"是否替换"（问过就别再问一遍） */
    let osAskedOverwrite = false;

    if (o.scope === "episode" && o.episodes?.length) {
      // 按集导出产出的是**一批**文件，逐集弹 save() 等于让用户点 N 次对话框，
      // 64 集就是 64 次——所以只认一个目标文件夹，文件名由集号+集标题生成。
      const dir = o.dir ?? await pickExportDir();
      if (!dir) { say("已取消导出"); return; }
      const titleOf = new Map(detail.episodes.map((e) => [e.order, e.title]));
      // 分集规则在 features/export/exportRun.ts（纯函数，verify 脚本直接跑它）：
      // 这段逻辑此前只长在这里，而 App 里的东西一行都测不到——
      // 「按集导出只出第一集」能走到用户机器上，缺的正是这层覆盖。
      for (const j of planEpisodeJobs(clips, o.episodes)) {
        jobs.push({
          shots: j.shots,
          // 与导出对话框的路径预览共用同一个函数，预览到哪就落到哪
          outputPath: await join(dir, episodeFileName(defaultName, j.episode, titleOf.get(j.episode))),
          label: `第 ${j.episode} 集`,
        });
      }
      if (!jobs.length) { say("所选集里没有已生成的镜头"); return; }
    } else {
      const outputPath = o.dir
        ? await join(o.dir, `${defaultName}.mp4`)
        : await save({
          defaultPath: `${defaultName}.mp4`,
          filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
        });
      if (!outputPath) { say("已取消导出"); return; }  // 用户取消，不启动渲染
      // 走 save() 的分支：系统保存框已经问过"是否替换"，别再问第二遍
      osAskedOverwrite = !o.dir;
      jobs.push({ shots: clips, outputPath, label: "" });
    }

    // ---- 2. 覆盖确认 ----
    // 导出位置改成在对话框里当场选之后，「开始导出」不再弹系统保存框，
    // 也就丢掉了它自带的"同名文件已存在，是否替换"。跑几十分钟把上一版成片
    // 静默盖掉是不可接受的，所以开跑前自己问一次（一次问全部，不逐个弹）。
    if (!osAskedOverwrite) {
      // invoke 失败（网页预览等没有 Rust 侧的环境）时按"查不到"处理：
      // 宁可不拦，也不能因为探测不了就挡住导出。
      const clashes = await invoke<string[]>("export_paths_exist",
        { paths: jobs.map((j) => j.outputPath) }).catch(() => [] as string[]);
      if (clashes.length) {
        const ok = await tauriConfirm(
          clashes.length === 1
            ? `已存在同名文件：\n${clashes[0]}\n\n继续导出将覆盖它。`
            : `目标文件夹里已存在 ${clashes.length} 个同名文件`
              + `（共 ${jobs.length} 个）：\n${clashes.slice(0, 5).map(baseOf).join("\n")}`
              + `${clashes.length > 5 ? `\n…另有 ${clashes.length - 5} 个` : ""}`
              + "\n\n继续导出将覆盖它们。",
          { title: "覆盖已有文件？", kind: "warning", okLabel: "覆盖", cancelLabel: "取消" });
        if (!ok) { say("已取消导出"); return; }
      }
    }

    // ---- 2.5. 轨道开关确认（4.6）----
    // 静音 / 独奏 / 隐藏从这一版起真的会少往成片里放东西，而"少了什么"在成片里
    // 是看不出来的（用户只会觉得"BGM 怎么没了"）。剪映把 solo 挡在成片之外
    // 正是怕这个；我们让它管用，改用**导出前当场说清楚**来堵那个坑。
    // 所有开关都是默认值时 notes 为空，这里一句话都不弹。
    const flagPlan = collectTrackFlags(
      useTimelineStore.getState().timeline.tracks.map((t) => ({
        id: t.id, kind: t.kind, label: t.label,
        hidden: t.hidden, muted: t.muted, solo: t.solo,
        clipCount: t.clips.length,
      })));
    if (flagPlan.noVideo) {
      // 这一条是拦截不是提示：跑几十分钟交付一个没有画面的 mp4 没有任何意义。
      say("所有视频轨都被隐藏了，导出会是空的——请先取消隐藏再导出");
      return;
    }
    if (flagPlan.notes.length) {
      const ok = await tauriConfirm(
        `本次导出会受轨道开关影响：\n\n${flagPlan.notes.map((n) => `· ${n}`).join("\n")}`
        + "\n\n继续导出？",
        { title: "轨道开关会改变成片内容", kind: "warning", okLabel: "继续导出", cancelLabel: "取消" });
      if (!ok) { say("已取消导出"); return; }
    }

    const ctl = new AbortController();
    setRenderAbort(ctl);
    setExportDone(null);
    segT0.current = null;
    setLocalProgress({ pct: 0, stage: "准备" });
    const t0 = Date.now();
    let segments = 0;
    let encoder = "";
    let lastPath = "";
    /** 各 job 的收场；汇总规则在 features/export/exportRun.ts */
    const outcomes: JobOutcome[] = [];
    let userAborted = false;
    // 多集导出时同一条降级会每集报一次，用 Set 收敛成一条。
    const exportNotices = new Set<string>();

    try {
      // 6.2：后台预取给导出让路。放在 try 的第一句、resume 放在 finally，
      // 是为了让"暂停"和"恢复"在**任何**收场方式（成功/失败/取消）下都成对。
      //
      // 让路是必须的：预取是没人在等的背景噪音，而用户正盯着这条进度条。
      // pause() 会掐断当前正在预取的那一件（不是等它下完），慢网下那可能是几十秒。
      // ⚠️ 掐断不会伤到导出自己的下载 —— 6.1 的取消是引用计数的：两边要同一个
      // URL 时挂的是同一次飞行，预取撤走只是等待者减一，导出还在等就不 abort。
      prefetcher.pause();
      // 4.0：折叠预测必须和编译器用**同一份** caps —— 编译器只在
      // `hasFilter(caps,"xfade") && hasTransition(caps,type)` 时才走 xfade，
      // 否则降级硬切、画面不折叠。这里不判就会在缺某个转场类型的老 ffmpeg 上
      // 把音频/字幕锚早一个转场时长（同一个 bug 反了个方向）。
      // `probeCapabilities` 有模块级缓存，renderV2 内部拿到的是同一个对象，
      // 首次导出只是把这 1~4s 挪到了循环之前，总耗时不变。
      const caps = await probeCapabilities();
      const foldsTransition = (type: string) =>
        hasFilter(caps, "xfade") && hasTransition(caps, type);

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (ctl.signal.aborted) { userAborted = true; break; }

        // ⚠️ 每个 job 各自 try —— **一集失败不能带走其余几集**。
        // 旧行为是任一集抛异常就整个循环塌掉，只剩一条 4 秒的红字；用户看到的
        // 就是"只导出了第一集"，且不知道有报错、更不知道是哪一集。各集是彼此
        // 独立的 ffmpeg 进程和输出文件，没有任何因果关系，不该连坐。
        // 只有**用户取消**才中断整批——那是他自己的意思。
        try {
          // Render Engine V2：Timeline → RenderPlan → 分段 → ffmpeg。
          // 按集导出时 shots 已按集切好，normalize 的 cursor 从 0 起算，
          // 音频/字幕/转场里锚定到范围外镜头的条目会被自动丢弃（见 normalize.ts）。
          const plan = normalizeRenderPlan({
            projectId,
            shots: job.shots,
            audioClips,
            subtitleClips: subtitles,
            transitions,
            output,
            // 按集的镜头已在对话框里筛成"已出片且未停用"，交给 generated 档即可
            scope: o.scope === "episode" ? "generated" : o.scope,
            selectedShotIds: selectedShot ? [selectedShot.id] : [],
            foldsTransition,
            // 4.6：轨道静音/独奏/隐藏。键是 RenderTrack.id，与时间轴那套 id
            // 不是一回事，换算在 render/trackFlags.ts 里（音频侧是 3 轨 : 4 kind）。
            trackFlags: flagPlan,
          });

          // 字幕交给最后一道烧录。必须由 plan 现算，不能用后端的全项目 SRT：
          // 那份时间码是从项目第一个镜头累加的，按集导出会整体偏掉前面所有集的时长。
          const srt = planToSrt(plan);
          const burnSrt = srt.trim() ? srt : undefined;

          segT0.current = null;
          const res = await renderV2({
            plan,
            preferEncoder: "auto",
            burnSrt,
            subtitleStyle,
            outputPath: job.outputPath,   // 渲染器直接使用，不再在内部弹对话框
            onProgress: (p2) => {
              // 预计剩余时间只用**分段渲染**这一段来推算，不用整体 pct 线性外推：
              // 前面的下载/探测与后面的 concat/混音/烧字幕速度差着数量级，
              // 拿总进度做线性估计会在阶段切换时来回跳，比不显示还糟。
              // 段与段耗时相近（每段输入数固定、时长相近），所以"已用/已完成段"
              // 外推到剩余段是稳的；尾巴那几步再加 10% 余量。
              let etaSec: number | undefined;
              const seg = p2.segment;
              if (seg && seg.total > 0) {
                if (seg.done === 0) segT0.current = Date.now();
                else if (segT0.current) {
                  const perMs = (Date.now() - segT0.current) / seg.done;
                  etaSec = Math.round(perMs * (seg.total - seg.done) * 1.1 / 1000);
                }
              }
              if (jobs.length > 1) {
                // 多集：单集内的分段外推推不出"还剩几集"，改用整体已完成比例外推。
                // 集与集时长相近（同一部剧），这个估计比只报当前集的剩余诚实得多。
                const frac = (i + p2.pct / 100) / jobs.length;
                etaSec = frac > 0.02
                  ? Math.round((Date.now() - t0) * (1 - frac) / frac / 1000)
                  : undefined;
                setLocalProgress({
                  pct: Math.round(frac * 100),
                  stage: `${job.label}（${i + 1}/${jobs.length}）· ${p2.stage}`,
                  etaSec,
                });
              } else {
                setLocalProgress({ pct: p2.pct, stage: p2.stage, etaSec });
              }
            },
            signal: ctl.signal,
          });
          segments += res.segments;
          encoder = res.encoder;
          lastPath = res.outputPath ?? job.outputPath;
          for (const n of res.notices) exportNotices.add(n);
          outcomes.push({ label: job.label, ok: true });
        } catch (e) {
          // 取消是**整批**的意思，不是这一集的事故：跳出去交给下面统一处理。
          if (e instanceof Error && e.name === "Aborted") { userAborted = true; break; }
          outcomes.push({ label: job.label, ok: false, error: String(e) });
        }
      }

      const dirHint = jobs.length > 1
        ? (lastPath || jobs[0].outputPath).replace(/[/\\][^/\\]*$/, "")
        : (lastPath || jobs[0].outputPath);
      const sum = summarizeExportRun(outcomes, userAborted, dirHint,
        `（共 ${segments} 段 · ${encoder} · ${((Date.now() - t0) / 1000).toFixed(0)}s）`
        // 提示正文写在结果面板里（toast 只有一行、4 秒就没），这里只负责把人引过去。
        + (exportNotices.size ? `　⚠️ 有 ${exportNotices.size} 条降级提示，见导出面板` : ""));

      if (sum.showResult) {
        // 不关弹窗：原地切到完成态，用户可直接「打开所在文件夹」。
        // 多文件时 path 仍指向最后一个成片——revealItemInDir 会打开其所在目录
        // 并选中它，正好就是那批文件所在的文件夹。
        setExportDone({
          path: lastPath, segments, encoder,
          elapsedMs: Date.now() - t0,
          files: sum.okCount,
          failed: sum.failed.length,
          // 失败原因和降级提示都进面板：它会一直留着等用户读完，toast 不会。
          notices: [...sum.notices, ...exportNotices],
        });
      }
      if (sum.toast) say(sum.toast);
    } catch (e) {
      // 到这儿只剩**整批**级别的意外（准备 caps 等循环之外的步骤）；
      // 单集失败已经在循环里各自接住了。
      if (e instanceof Error && e.name === "Aborted") say("已取消导出");
      else say(`导出失败：${String(e)}`);
    } finally {
      setLocalProgress(null);
      setRenderAbort(null);
      // 与 try 首句的 pause() 成对。导出这会儿已经把要用的素材都落盘了，
      // 恢复后队列里剩的是导出期间新完成的那些 AI 产物。
      prefetcher.resume();
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
      const dur = clip.duration > 0 ? clip.duration : undefined;
      const r = await api.addSpecialShot(projectId, clip.name, clip.url, undefined, dur);
      await refreshDetail();
      previewMedia(clip.url, clip.name);
      say(`已插入镜头轨 #${r.order}（外部素材），可拖动调整位置（Ctrl+Z 可撤销）`);
      // 3.7：重建换主键，所以 curId 要跟着重做的结果走 —— 与转场那三条同一个套路
      // （详见 doDeleteTransition）。拿旧 id 去 delete 会 404，撤销从第二次起就坏。
      let curId = r.shot_id;
      pushUndo(`插入外部素材「${clip.name}」`,
        async () => {
          await api.deleteShot(curId);
          await refreshDetail();
        },
        async () => {
          const again = await api.addSpecialShot(projectId, clip.name, clip.url, undefined, dur);
          curId = again.shot_id;
          await refreshDetail();
        });
    } catch (e) { say(String(e)); }
    finally { setInsertingClip(false); }
  };

  // ---- 镜头轨轻剪辑（唯一真源）：改时长 / 改顺序 / 停用 / 删除外部素材 ----
  const patchTimeline = async (
    shotId: string, patch: {
      durationSec?: number; toOrder?: number; disabled?: boolean;
      /** 3.1 取片窗口（见 features/timeline/trim.ts 的 TrimPatch） */
      clipInSec?: number; clipDurSec?: number; clearClipWindow?: boolean;
    },
  ) => {
    try {
      // P2-2：提交前记旧值 → 撤销 = 回写旧值（时长/顺序/停用三类各自独立入栈）
      const old = detail?.shots.find((s) => s.id === shotId);
      await api.patchShotTimeline(shotId, patch);
      if (old) {
        // 3.1：动了取片窗口时，(in, dur) 必须作为**一条**撤销记录。
        //
        // 拆成两条的话，Ctrl+Z 一次只回滚一半 —— 中间态是"新入点 + 旧时长"，
        // 那是一个用户从没编辑过的窗口。而且拖一次左边缘会往栈里进两条，
        // 用户要按两下 Ctrl+Z 才回到原状，第一下看起来像"撤销坏了"。
        //
        // 因此这里带 clipInSec/clipDurSec 的分支**接管** durationSec 的入栈，
        // 下面那条 durationSec 分支要跳过（见 windowTouched）。
        const windowTouched =
          patch.clipInSec !== undefined || patch.clipDurSec !== undefined
          || patch.clearClipWindow === true;
        if (windowTouched) {
          const prevIn = old.clip_in_sec;
          const prevDur = old.clip_dur_sec;
          const prevShown = old.duration_sec;
          // 旧行本来就没有窗口 → 撤销要**清掉**这次新建的窗口，
          // 而不是把 null 当成 0 写回去（那会留下一个 in=0 的假窗口，
          // 使这一镜从此走"有窗口"分支，语义与撤销前不同）。
          const undoPatch = (prevDur != null && prevDur > 0)
            ? { clipInSec: prevIn ?? 0, clipDurSec: prevDur,
                durationSec: prevShown ?? prevDur }
            : { clearClipWindow: true,
                ...(prevShown != null ? { durationSec: prevShown } : {}) };
          const label = patch.clearClipWindow
            ? `镜头 #${old.order} 取消入点`
            : `镜头 #${old.order} 修剪 → 入点 ${(patch.clipInSec ?? prevIn ?? 0).toFixed(1)}s`;
          pushUndo(label,
            async () => {
              await api.patchShotTimeline(shotId, undoPatch);
              await refreshDetail();
            },
            async () => {
              await api.patchShotTimeline(shotId, patch);
              await refreshDetail();
            });
        }
        // 三类各自独立入栈。redo = 再做一遍原操作，与 undo 精确互逆。
        if (!windowTouched
            && patch.durationSec !== undefined && old.duration_sec != null) {
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
  // ---- 6.9 音频/字幕轨轻剪辑：修剪 / 拖动 / 删除 ----
  //
  // 与上面的 patchTimeline 是**三条不同的写通路**（三个端点、三套上下限），
  // 规则在 features/timeline/clipEdit.ts（纯函数、node 下可验证），
  // 这里只负责"发出去 + 入撤销栈 + 刷新"这三件 App 层的事。
  //
  // ⚠️ 撤销一律**在这里**入栈，Timeline.tsx 不许再推一条 —— 两边都推的话，
  // 一次拖动进两条栈，Ctrl+Z 要按两下才回到原状（P2-2 记过这个坑）。

  /** 一次修剪/拖动的写回。patch 里动过的字段**合成一条**撤销记录。 */
  const editClip = async (patch: ClipEditPatch) => {
    // 镜头不从这里走：它有 duration_sec == clip_dur_sec 的不变式要维持，
    // 由既有的 patchTimeline + trim.ts 负责（3.1 已验证的路径，不重写）。
    if (patch.entity === "shot") return;
    try {
      if (patch.entity === "audio") {
        const old = audioClips.find((a) => a.id === patch.id);
        if (!old) return;
        const next = {
          ...(patch.clearClip ? { clearClip: true } : {}),
          ...(patch.clipInSec !== undefined ? { clipInSec: patch.clipInSec } : {}),
          ...(patch.clipDurSec !== undefined ? { clipDurSec: patch.clipDurSec } : {}),
          ...(patch.startShotOrder !== undefined
            ? { startShotOrder: patch.startShotOrder } : {}),
          ...(patch.startOffsetSec !== undefined
            ? { startOffsetSec: patch.startOffsetSec } : {}),
        };
        await api.patchAudioClip(patch.id, next);
        // 撤销要把这次动过的每一个字段一起回写。窗口原本就没有的行，
        // 回写用 clearClip 而**不是**写 0 —— 理由与 patchTimeline 的 undoPatch
        // 一字不差：in=0 是"从头剪了一刀"，null 才是"没剪过"，写 0 会留下
        // 一个假窗口，让这一段从此走"已修剪"分支（还原按钮凭空出现）。
        const touchedWindow = patch.clearClip === true
          || patch.clipInSec !== undefined || patch.clipDurSec !== undefined;
        const hadWindow = old.clip_dur_sec != null && old.clip_dur_sec > 0;
        const prev = {
          ...(touchedWindow
            ? (hadWindow
              ? { clipInSec: old.clip_in_sec ?? 0, clipDurSec: old.clip_dur_sec as number }
              : { clearClip: true })
            : {}),
          ...(patch.startShotOrder !== undefined
            ? { startShotOrder: old.start_shot_order } : {}),
          ...(patch.startOffsetSec !== undefined
            ? { startOffsetSec: old.start_offset_sec } : {}),
        };
        const name = old.kind === "music" ? "配乐" : "旁白";
        const act = patch.clearClip ? "还原修剪" : touchedWindow ? "修剪" : "移动";
        pushUndo(`${name}${act}`,
          async () => { await api.patchAudioClip(patch.id, prev); await refreshAudio(); },
          async () => { await api.patchAudioClip(patch.id, next); await refreshAudio(); });
        await refreshAudio();
        return;
      }
      const old = subtitles.find((s) => s.id === patch.id);
      if (!old) return;
      // 字幕没有修剪窗口：`duration` 本身就是播放时长，改它即可（后端 3071 行
      // 早就收这个字段）。所以字幕这条路上不存在"0 与 null 的分歧"。
      const next = {
        ...(patch.durationSec !== undefined ? { duration: patch.durationSec } : {}),
        ...(patch.startShotOrder !== undefined
          ? { start_shot_order: patch.startShotOrder } : {}),
        ...(patch.startOffsetSec !== undefined
          ? { start_offset_sec: patch.startOffsetSec } : {}),
      };
      await api.patchSubtitleClip(patch.id, next);
      const prev = {
        ...(patch.durationSec !== undefined ? { duration: old.duration } : {}),
        ...(patch.startShotOrder !== undefined
          ? { start_shot_order: old.start_shot_order } : {}),
        ...(patch.startOffsetSec !== undefined
          ? { start_offset_sec: old.start_offset_sec } : {}),
      };
      pushUndo(patch.durationSec !== undefined ? "字幕改时长" : "字幕移动",
        async () => { await api.patchSubtitleClip(patch.id, prev); await refreshSubtitles(); },
        async () => { await api.patchSubtitleClip(patch.id, next); await refreshSubtitles(); });
      await refreshSubtitles();
    } catch (e) { say(String(e)); }
  };

  /** 整段拖到绝对秒 `targetSec`：换算成「锚定第几镜 + 镜内偏移」。 */
  const moveClip = (clip: Clip, targetSec: number) => {
    // 换算必须用 adapters 的 secToPosition —— 那个文件记着这条时间轴上曾同时
    // 存在三套各自累加镜头时长的换算，症状是"线画在一处、片段跳到另一处"。
    //
    // 它在**一个镜头都没有**时返回 null（音频锚点无处可落）。这时静默不动，
    // 不编一个 order=1：那会写出一个指向不存在镜头的锚点，等用户建第一镜时
    // 音频突然冒出来在一个他没放过的位置。
    const pos = secToPosition(detail?.shots ?? [], Math.max(0, targetSec));
    if (!pos) return;
    const patch = movePatch(clip, targetSec, () => pos);
    if (patch) void editClip(patch);
  };

  /** 从时间轴上删掉一段音频/字幕。可撤销（重新创建，与 restoreSpecialShot 同构）。 */
  const deleteTimelineClip = async (clip: Clip) => {
    if (!canDeleteFromTimeline(clip)) return;
    try {
      if (clip.entity === "audio") {
        const old = audioClips.find((a) => a.id === clip.id);
        if (!old) return;
        await api.deleteAudioClip(clip.id);
        await refreshAudio();
        say("已从音频轨移除（Ctrl+Z 可撤销）");
        // 重建拿到的是**新 id**，所以 redo 要删的是 curId 而不是原 id ——
        // 与 restoreSpecialShot 完全同一个模式（那里踩过：redo 去删旧 id，
        // 报 404，用户看到的是"重做失败"而那一段其实还在)。
        let curId = clip.id;
        pushUndo("移除音频段",
          async () => {
            const r = await api.createAudioClip({
              projectId: projectId!, kind: old.kind as "tts" | "music",
              text: old.text ?? undefined, url: old.url ?? undefined,
              duration: old.duration, startShotOrder: old.start_shot_order,
              startOffsetSec: old.start_offset_sec,
              voiceRefUrl: old.voice_ref_url ?? undefined,
            });
            curId = r.id;
            // 修剪窗口 create 接口不收，得补一次 PATCH。这一步失败不抛：
            // 段已经回来了，为了窗口一项把整个撤销判失败，用户会以为没救回来。
            if (old.clip_dur_sec != null) {
              try {
                await api.patchAudioClip(curId, {
                  clipInSec: old.clip_in_sec ?? 0, clipDurSec: old.clip_dur_sec,
                });
              } catch { /* 见上：窗口补不回来也不能让撤销整体失败 */ }
            }
            await refreshAudio();
          },
          async () => { await api.deleteAudioClip(curId); await refreshAudio(); });
        return;
      }
      const old = subtitles.find((s) => s.id === clip.id);
      if (!old) return;
      await api.deleteSubtitleClip(clip.id);
      await refreshSubtitles();
      say("已从字幕轨移除（Ctrl+Z 可撤销）");
      let curId = clip.id;
      pushUndo("移除字幕段",
        async () => {
          const r = await api.createSubtitleClip({
            project_id: projectId!, text: old.text, kind: old.kind,
            start_shot_order: old.start_shot_order,
            start_offset_sec: old.start_offset_sec,
            duration: old.duration,
            ...(old.style ? { style: old.style } : {}),
          });
          curId = r.id;
          await refreshSubtitles();
        },
        async () => { await api.deleteSubtitleClip(curId); await refreshSubtitles(); });
    } catch (e) { say(String(e)); }
  };

  const deleteSpecialShot = async (shotId: string) => {
    try {
      // 3.7：删之前把这一镜的全部可恢复状态抄下来。后端 `delete_shot` 是**硬删**，
      // 撤销只能靠重新插一条 —— 抄漏一项，用户撤销回来的就是个"名字对、修剪没了、
      // 调色没了"的空壳，比删掉更难发现。
      const old = detail?.shots.find((s) => s.id === shotId) ?? null;
      await api.deleteShot(shotId);
      if (selectedShotId === shotId) setSelectedShotId(null);
      await refreshDetail();
      if (old) {
        let curId = shotId;
        say("已从镜头轨移除（Ctrl+Z 可撤销）");
        pushUndo(`移除外部素材「${old.special_name ?? `#${old.order}`}」`,
          async () => {
            curId = await restoreSpecialShot(old);
            await refreshDetail();
          },
          async () => {
            await api.deleteShot(curId);
            await refreshDetail();
          });
      } else {
        say("已从镜头轨移除");
      }
    } catch (e) { say(String(e)); }
  };

  /** 把一条被删掉的外部素材镜头原样插回去，返回**新的** shot id。
   *
   *  分两步：`addSpecialShot` 只认 name/url/位置/时长，其余（取片窗口、画面调整、
   *  叠加层位置、停用态）得再补一次 PATCH。第二步失败不抛 —— 镜头已经回来了，
   *  为了一项属性把整个撤销判失败，用户会以为素材没救回来。 */
  const restoreSpecialShot = async (old: ShotInfo): Promise<string> => {
    const r = await api.addSpecialShot(
      projectId!, old.special_name ?? "外部素材", old.video_url ?? "",
      // 插回原位：after_order 是"插在第几镜之后"，所以是原 order 减一；
      // 原本就是第 1 镜时传 0（后端按"插到最前"处理）。
      Math.max(0, old.order - 1),
      old.duration_sec ?? undefined);
    try {
      await api.patchShotTimeline(r.shot_id, {
        ...(old.clip_dur_sec != null && old.clip_dur_sec > 0
          ? { clipInSec: old.clip_in_sec ?? 0, clipDurSec: old.clip_dur_sec }
          : {}),
        ...(old.transform_meta ? { transformMeta: old.transform_meta } : {}),
        ...((old.track_index ?? 0) > 0
          ? { trackIndex: old.track_index!, overlayStartSec: old.overlay_start_sec ?? 0 }
          : {}),
        ...(old.disabled ? { disabled: true } : {}),
      });
    } catch (e) {
      say(`素材已恢复，但部分设置未能一并还原：${String(e)}`);
    }
    return r.shot_id;
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

  /** ▶ 播放/暂停（Space）
   *
   *  优先级与剪映对齐：**空格永远能播**，不需要先做任何准备动作。
   *   1. 正在播 → 暂停（无论从哪儿起播的）
   *   2. 有定位线 → 从定位线播（本软件特有的"标记点"语义，保留）
   *   3. 否则 → 从播放头（时间指示器）所在位置播 —— 这是剪映的默认行为，
   *      单击刻度尺就能移动它
   *   4. 时间轴上什么都没有 → 从第一个可播镜头开头播
   *
   *  ⚠️ 旧实现只有第 2 条：没放定位线时按空格只弹一句
   *  "先在时间轴刻度尺上单击放置定位线"，而刻度尺上单击其实是移动播放头、
   *  **双击**才放定位线 —— 提示本身就是错的，用户照着做也没反应。
   */
  const playFromCursor = () => {
    const v = videoRef.current;
    // 3.3：空格接管播放 → 退出快进/快退状态。不清的话 4× 快进时按两下空格
    // （停、再播）会以 4× 继续播，用户找不到哪里能调回 1×。
    clearShuttle();
    // 1) 播放中一律暂停（最高优先级：空格的第一语义是"停下来"）
    if (v && !v.paused && previewShot) { v.pause(); return; }

    // 2) 定位线
    if (cursor && cursorShot) {
      if (!cursorShot.video_url) { say(`镜头 #${cursorShot.order} 尚未生成，无法播放`); return; }
      if (v && previewShot?.id === cursorShot.id) {
        v.currentTime = toMediaTime(cursor.offsetSec);
        void v.play();
        return;
      }
      seekTo(cursorShot, cursor.offsetSec);
      return;
    }

    // 3) 播放头所在的 clip
    const ph = useTimelineStore.getState().playheadSec;
    const phClip = useTimelineStore.getState().allClips().find(
      (c) => c.shotId && ph >= c.startSec && ph < c.startSec + c.durationSec);
    const phShot = phClip ? (detail?.shots.find((s) => s.id === phClip.shotId) ?? null) : null;
    if (phShot?.video_url) {
      const off = ph - phClip!.startSec;
      if (v && previewShot?.id === phShot.id) { v.currentTime = toMediaTime(off); void v.play(); return; }
      seekTo(phShot, off);
      return;
    }

    // 4) 兜底：从头播
    const first = (detail?.shots ?? []).find((s) => s.video_url && !s.disabled);
    if (!first) { say("还没有已生成的镜头，无法播放"); return; }
    seekTo(first, 0);
  };

  /** ⏮ 从头播放（Shift+Space）：第一个已生成且未停用的镜头从 0s 播 */
  const playFromStart = () => {
    clearShuttle();   // 同 playFromCursor：显式播放动作要回到 1×
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
      v.currentTime = toMediaTime(cursor.offsetSec);
      return;
    }
    // 跨镜：`<video autoPlay>` 一定会自动播，靠 pause:true 让 loadedmetadata 收住。
    // （3.3 之前这里是 `setTimeout(..., 400)` 在赌加载耗时，见 usePlayer.pendingPause）
    seekTo(cursorShot, cursor.offsetSec, { pause: true });
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

  /** 剪映里 Delete 是"把选中的片段从轨道上拿掉"。本软件两类片段的
   *  "拿掉"含义不同，但**都必须有反馈**——旧实现遇到 AI 镜头直接
   *  `return`，按下去毫无动静，用户以为快捷键坏了。
   *
   *    · 外部素材 → 真删（不可撤销，所以问一句）
   *    · AI 镜头  → 停用（保留在轨但不参与导出，等价于"拿掉"，且可撤销）
   *    · 音频/字幕段（6.9 起可被选中）→ 真删，可撤销（重建）
   *
   *  同时支持多选：旧实现只取 clipIds[0]，框选了 10 个只处理 1 个。
   *  `silent` 供 Ctrl+X 用——那边已经报过"已剪切 N 个"，不再重复弹。 */
  const removeSelectedClips = (o?: { silent?: boolean; shotsOnly?: boolean }) => {
    const st = tlStore();
    const all = st.selection.clipIds
      .map((id) => st.findClip(id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    if (!all.length) { say("先选中时间轴上的片段"); return; }

    // 6.9：选中集里现在可能有音频/字幕段（`selection.ts` 放开了判据）。
    // 它们既不是"外部素材真删"也不是"AI 镜头停用"，是第三种删法 ——
    // 各自的 DELETE 端点，可撤销（重建）。分开处理，不混进下面两类。
    const others = o?.shotsOnly ? []
      : all.filter((c) => c.entity === "audio" || c.entity === "subtitle");
    const clips = all.filter((c) => c.entity === "shot" && !!c.shotId);
    if (!clips.length && !others.length) { say("先选中时间轴上的片段"); return; }

    const specials = clips.filter((c) => c.isSpecial);
    const aiShots = clips.filter((c) => !c.isSpecial && !c.disabled);

    if (specials.length) {
      const names = specials.map((c) => c.label).join("、");
      if (!window.confirm(
        `确定从镜头轨移除 ${specials.length} 个外部素材吗？\n\n${names}\n\n`
        + "可以按 Ctrl+Z 撤销，取片范围、画面调整、叠加层位置都会一并还原；"
        + "但一个素材算一次撤销，撤 N 个要按 N 次。")) return;
      void (async () => {
        for (const c of specials) await deleteSpecialShot(c.shotId!);
      })();
    }

    if (others.length) {
      // 逐条串行删：每条各自入一条撤销记录（与外部素材同款），
      // 并行发的话撤销栈顺序会跟着网络先后走，Ctrl+Z 撤回来的顺序就不确定了。
      void (async () => {
        for (const c of others) await deleteTimelineClip(c);
      })();
    }

    for (const c of aiShots) void patchTimeline(c.shotId!, { disabled: true });
    if (aiShots.length && !o?.silent) {
      say(`AI 镜头不能删除，已停用 ${aiShots.length} 个（不参与导出，Ctrl+Z 可撤销）`);
    }
  };

  /** `[` / `]` 与时间轴工具条上对应的两个按钮：以播放头为界选中一侧。
   *
   *  3.5：这段逻辑此前有**三份**——`commands/index.ts` 里一份（快捷键用，
   *  没有 toast）、`Timeline.tsx` 里一份（按钮用，有 toast、还顺手写了
   *  另一套选中态）、框选那里又是第三份判据。现在只有这一份，
   *  "谁算可选"进一步下沉到 `features/timeline/selection.ts`。 */
  const selectSide = (side: "left" | "right") => {
    const st = tlStore();
    const ids = sideIds(st.timeline.tracks, st.playheadSec, side);
    const w = side === "left" ? "左" : "右";
    if (!ids.length) { say(`播放头${w}侧没有可选的片段`); return; }
    st.selectClips(ids);
    say(`已选中${w}侧 ${ids.length} 个片段`);
  };

  /** Ctrl+V：把剪贴板里的片段以"外部素材"形式插到播放头所在片段之后。 */
  const doPaste = async () => {
    if (!projectId) return;
    const st = tlStore();
    const buf = st.clipboard.filter((c) => c.mediaUrl);
    if (!buf.length) {
      say(st.clipboard.length ? "剪贴板里的片段还没有生成画面，无法粘贴" : "剪贴板是空的");
      return;
    }
    // 插入位置：播放头所在片段之后；播放头不在任何片段上则追加到末尾
    const ph = st.playheadSec;
    const hit = st.allClips().find(
      (c) => c.shotOrder != null && ph >= c.startSec && ph < c.startSec + c.durationSec);
    let after = hit?.shotOrder;
    try {
      // 3.7：粘贴出来的镜头 id 要记下来，撤销才知道该删哪几条。
      // 用数组而不是单个 id：一次 Ctrl+V 可以粘贴多个片段，撤销必须是**一次**
      // 把这批全撤掉 —— 拆成 N 条的话用户要按 N 下 Ctrl+Z，中间态是"粘了一半"。
      let createdIds: string[] = [];
      for (const c of buf) {
        const r = await api.addSpecialShot(
          projectId, `${c.label} 副本`, c.mediaUrl!, after, c.durationSec);
        createdIds.push(r.shot_id);
        // 连续粘贴多个时逐个后移，保持剪贴板内部原有顺序
        after = r.order;
      }
      await refreshDetail();
      say(`已粘贴 ${buf.length} 个片段${hit ? `（在 #${hit.shotOrder} 之后）` : "（追加到末尾）"}`
        + "（Ctrl+Z 可撤销）");
      const redoAfter = hit?.shotOrder;
      pushUndo(`粘贴 ${buf.length} 个片段`,
        async () => {
          // 倒着删：删中间一条会让后面的 order 前移，正序删时后面那条的位置
          // 已经不是记录时的那个了。按 id 删本身不受影响，但倒序还能让服务端
          // 少做几次重排，且与"撤销 = 反着走一遍"的直觉一致。
          for (const id of [...createdIds].reverse()) await api.deleteShot(id);
          await refreshDetail();
        },
        async () => {
          let a = redoAfter;
          const again: string[] = [];
          for (const c of buf) {
            const r = await api.addSpecialShot(
              projectId, `${c.label} 副本`, c.mediaUrl!, a, c.durationSec);
            again.push(r.shot_id);
            a = r.order;
          }
          createdIds = again;   // 重建换主键，下一次撤销要认新的
          await refreshDetail();
        });
    } catch (e) { say(`粘贴失败：${String(e)}`); }
  };

  /** Ctrl+X：复制后按 Delete 的规则移除（外部素材真删、AI 镜头停用）。 */
  const doCut = async () => {
    const st = tlStore();
    // 6.9：选中集里可能混着音频/字幕段。它们进不了剪贴板（粘贴只会插镜头，
    // 见 timelineStore.copySelection），所以**剪切也不碰它们** ——
    // 剪了粘不回来就是无声的数据丢失。明说跳过，用户要删自己按 Delete。
    const skipped = st.selection.clipIds
      .map((id) => st.findClip(id))
      .filter((c) => c && c.entity !== "shot").length;
    st.copySelection();
    // ⚠️ 必须重新 getState()。`st` 是 copySelection **之前**的那个 state 对象，
    // zustand 的 set 换的是新对象，`st.clipboard` 读到的是上一次复制的内容 ——
    // 于是第一次 Ctrl+X（剪贴板还空着）会走进"先选中时间轴上的片段"，
    // 明明有选中却说没选中。Ctrl+C 那条（1630 行）本来就是重新取的，
    // 这里是漏的一处，顺手补齐。
    const n = tlStore().clipboard.length;
    if (!n) {
      say(skipped ? "音频/字幕段不能剪切（粘贴只会插入镜头），请用 Delete 移除"
                  : "先选中时间轴上的片段");
      return;
    }
    say(skipped
      ? `已剪切 ${n} 个镜头（跳过 ${skipped} 个音频/字幕段——它们粘不回来）`
      : `已剪切 ${n} 个片段`);
    removeSelectedClips({ silent: true, shotsOnly: true });
  };

  /* ==== 3.3 播放头导航 / J-K-L / I-O ==================================== */

  /** 播放头能到的范围：片段边界表（升序去重）+ 上限（最后一个启用镜头的结尾）。
   *
   *  每次按键现算而不是 useMemo：按键频率远低于 detail 刷新频率，
   *  而且它必须**立刻**跟上 detail —— 用户刚删掉最后一镜，End 不能还跳到旧结尾。 */
  const playRange = () => {
    const edges = buildEdgeSecs(detail?.shots ?? []);
    return { edges, maxSec: edges[edges.length - 1] ?? 0 };
  };

  /**
   * 把播放头移到绝对秒 `sec`，并让预览器跟过去（跨镜也跟）。
   *
   * 3.3 的核心是把因果**倒过来**：播放头首先是时间轴上的一个位置，
   * 其次才去驱动 `<video>`。改之前是反的（播放头 = `video.currentTime` 的投影），
   * 于是没有预览源、或落在未生成的镜头上时，方向键就是一个死键
   * （四种失效的完整说明见 `features/timeline/playhead.ts` 文件头）。
   *
   * @param opts.crossShot 3.4：落点在别的镜头上时，允不允许**换预览源**。
   *   换源 = `previewUrl` 变 = `<video>` 按 `key` 重建 = 重新下载整个素材，
   *   拖动中每帧都做的话，拖过 20 个镜头就是 20 次重建 + 20 个作废的下载。
   *   缺省 `true`（方向键 / Home / End / J-K-L 都是离散动作，该跟就跟）；
   *   拖动中的每一帧传 `false`，只挪线、同镜内仍然 seek。
   */
  const movePlayheadTo = (sec: number, opts?: { crossShot?: boolean }) => {
    const all = detail?.shots ?? [];
    const at = clampSec(sec, playRange().maxSec);
    tlStore().setPlayheadSec(at);

    const pos = secToPosition(all, at);
    const shot = pos
      ? all.find((s) => s.order === pos.order && (s.track_index ?? 0) === 0) ?? null
      : null;

    if (!shot?.video_url) {
      // 落在还没出片的镜头上：线照走，只是没画面可预览。
      // 这里**必须**把 playhead 置空 —— 否则 Timeline 里那条
      // `p.playhead → setPlayheadSec` 的 effect（依赖 [p.playhead, p.shots]）
      // 会在下一次 detail 刷新时拿播放器的旧位置把线又拽回去。
      setPlayhead(null);
      return;
    }

    const v = videoRef.current;
    if (v && previewShot?.id === shot.id) {
      // 同镜：offsetSec 是**镜内秒**，toMediaTime 负责加上 3.1 的入点偏移，
      // 所以播放头永远不会走进已经被剪掉的那段素材里。
      // 这条路**不换源**（同一个 `<video>` 元素改 currentTime），所以
      // 拖动中的每一帧也走它 —— 在当前镜头内拖动是全程有画面的。
      v.currentTime = toMediaTime(pos!.offsetSec);
      setPlayhead({ order: shot.order, offsetSec: pos!.offsetSec });
      return;
    }
    // 跨镜且这一帧不许换源（拖动中）：线已经挪好了，画面留在原处等停稳。
    // 同时把 playhead 置空，理由与上面「未出片」那支相同 —— 播放器此刻
    // 停在**另一个**镜头上，让它的 timeupdate 继续定义线的位置就会互相打架。
    if (opts?.crossShot === false) { setPlayhead(null); return; }
    // 跨镜：pause:true 收住 `<video autoPlay>` —— 挪播放头不等于要播放
    seekTo(shot, pos!.offsetSec, { pause: true });
  };

  /** J/K/L 的当前倍速：正=快进（走 playbackRate），负=快退（定时回退），0=停。
   *  state 给 UI 徽标看，ref 给事件处理器读 —— 连按两下 J 可能发生在同一帧内，
   *  只读 state 会拿到上一次的值（连按加速就变成"按几次都是 1×"）。 */
  const [shuttle, setShuttle] = useState(0);
  const shuttleRef = useRef(0);
  const revTimer = useRef<number | null>(null);
  /** 快退定时器里要用**最新**的 movePlayheadTo（它闭包了 detail / previewShot），
   *  否则倒着走的这几秒里来一次 refreshDetail，之后每一跳都按旧时间轴算。 */
  const moveRef = useRef(movePlayheadTo);
  moveRef.current = movePlayheadTo;

  const stopRevTimer = () => {
    if (revTimer.current != null) { clearInterval(revTimer.current); revTimer.current = null; }
  };
  // 卸载时收掉定时器，否则切项目/关窗后它还在往 store 里写播放头
  useEffect(() => stopRevTimer, []);

  /** 只清 shuttle 状态、不动播放（给"改用别的方式播放"的入口用，如空格）。 */
  const clearShuttle = () => {
    stopRevTimer();
    shuttleRef.current = 0;
    setShuttle(0);
  };

  /** 停快进/快退**并**暂停。所有"手动挪播放头"的操作都先调它 ——
   *  4× 快进时按方向键，用户要的是停下来微调，而不是边冲边微调。 */
  const stopShuttle = () => { clearShuttle(); videoRef.current?.pause(); };

  /** 手动跳转（方向键 / Home / End / ↑↓）统一入口：先停 shuttle 再挪。 */
  const jumpPlayhead = (sec: number) => { stopShuttle(); movePlayheadTo(sec); };

  /** 3.4 拖播放头（刻度尺 / 顶端把手）。节流在 `timeline/scrub.ts` 里，
   *  这里只决定每个阶段做什么：
   *
   *    · start  —— 停掉快进/快退并暂停。边播边拖的话，`timeupdate` 与拖动
   *                会轮流往 store 里写播放头，线会在两个位置之间来回跳。
   *    · move   —— 只挪线（同镜内仍 seek，因为那不换源、不重新下载）
   *    · commit —— 停稳或松手，这时才允许换预览源
   */
  const onScrub = (sec: number, phase: ScrubPhase) => {
    if (phase === "start") stopShuttle();
    movePlayheadTo(sec, { crossShot: phase !== "move" });
  };

  const doShuttle = (dir: -1 | 1) => {
    const next = nextShuttle(shuttleRef.current, dir);
    shuttleRef.current = next;
    setShuttle(next);
    stopRevTimer();
    const v = videoRef.current;
    if (next === 0) { v?.pause(); return; }

    if (next > 0) {
      // 快进：交给 `<video>` 自己放。倍速由 Player 里那个**唯一**的
      // playbackRate 写入点合成（本镜变速 × 快进倍速），这里绝不直接写 ——
      // 两处写同一个属性必然打架（谁最后 render 谁说了算）。
      if (!previewShot || !videoRef.current) {
        say("先选中一个已生成的镜头再按 L");
        shuttleRef.current = 0; setShuttle(0);
        return;
      }
      void v?.play();
      return;
    }

    // 快退：浏览器不支持负 playbackRate（见 REVERSE_TICK_MS 的说明），
    // 只能暂停 + 定时把播放头往回挪。走 movePlayheadTo 而不是直接减
    // currentTime，才能跨镜、才不会退进被剪掉的素材里。
    v?.pause();
    const rate = Math.abs(next);
    revTimer.current = window.setInterval(() => {
      const cur = tlStore().playheadSec;
      if (cur <= 0) { clearShuttle(); return; }   // 退到片头自动停
      moveRef.current(cur - rate * (REVERSE_TICK_MS / 1000));
    }, REVERSE_TICK_MS);
  };

  /** 播放头当前落在哪个主轨镜头上（I/O 共用；判据与画线同源）。 */
  const shotAtPlayhead = () => {
    const all = detail?.shots ?? [];
    const pos = secToPosition(all, tlStore().playheadSec);
    if (!pos) return null;
    const shot = all.find((s) => s.order === pos.order && (s.track_index ?? 0) === 0);
    return shot ? { shot, offsetSec: pos.offsetSec } : null;
  };

  /** I：把播放头处设为入点（出点不动）。
   *
   *  复用 3.1 的 `trimIn` + `inPatch`，与拖左边缘走的是同一条通路 ——
   *  键盘设出来的窗口与鼠标拖出来的**逐字节相同**，撤销也是同一条记录。 */
  const doSetIn = () => {
    const hit = shotAtPlayhead();
    if (!hit) { say("把播放头放到某个镜头上再按 I"); return; }
    const { shot, offsetSec } = hit;
    if (!canTrimIn(shot)) {
      say(`镜头 #${shot.order} 还没有画面，改入点无意义（先生成或换素材）`);
      return;
    }
    const curIn = inPointOf(shot);
    const maxSec = detail?.shot_duration_max ?? MAX_CLIP_SEC_FALLBACK;
    // deltaSec 就是"播放头距本镜起点多远" —— 镜内第 offsetSec 秒对应的素材时间
    // 正是 curIn + offsetSec，与拖左边缘时鼠标位移的语义完全一致。
    const r = trimIn(curIn, outPointOf(shot), offsetSec,
      minTrimSec(shot, MIN_CLIP_SEC), maxSec);
    if (r.inSec === quantizeSec(curIn)) { say("入点没有变化"); return; }
    void patchTimeline(shot.id, inPatch(r.inSec, r.durSec));
    say(`镜头 #${shot.order} 入点 → 素材第 ${r.inSec.toFixed(1)}s`
      + `（时长 ${r.durSec.toFixed(1)}s，Ctrl+Z 可撤销）`);
  };

  /** O：把播放头处设为出点（入点不动）。 */
  const doSetOut = () => {
    const hit = shotAtPlayhead();
    if (!hit) { say("把播放头放到某个镜头上再按 O"); return; }
    const { shot, offsetSec } = hit;
    const curDur = windowDurOf(shot);
    const minSec = minTrimSec(shot, MIN_CLIP_SEC);
    if (quantizeSec(offsetSec) < minSec) {
      // 播放头几乎贴在本镜起点：照拖动的规则会被钳成 minSec，等于"按一下 O
      // 把这一镜砍成 1 秒"。这不是用户想要的，明说比静默钳制强。
      say(`播放头离本镜起点只有 ${offsetSec.toFixed(1)}s，`
        + `不足最短时长 ${minSec}s —— 往后挪一点再按 O`);
      return;
    }
    const maxSec = detail?.shot_duration_max ?? MAX_CLIP_SEC_FALLBACK;
    const next = trimOut(curDur, offsetSec - curDur, minSec, maxSec);
    if (next === quantizeSec(curDur)) { say("出点没有变化"); return; }
    void patchTimeline(shot.id, outPatch(shot, next));
    say(`镜头 #${shot.order} 出点 → ${next.toFixed(1)}s（Ctrl+Z 可撤销）`);
  };

  useCommands({
    playPause: playFromCursor,
    playFromStart,
    cursorToPlayhead,
    // 走 doUndo/doRedo 而不是 tlStore().undo()：前者会 toast 出"已撤销：xxx"，
    // 也会在栈空时明确说"没有可撤销的操作"。直接调 store 的话按下去毫无反馈，
    // 用户分不清是撤销了还是快捷键没生效。
    undo: () => { void doUndo(); },
    redo: () => { void doRedo(); },
    copy: () => {
      tlStore().copySelection();
      const n = tlStore().clipboard.length;
      say(n ? `已复制 ${n} 个片段（Ctrl+V 粘贴到播放头后）` : "先选中时间轴上的片段");
    },
    // 粘贴 = 在播放头所在片段之后插入剪贴板里那些片段的副本。
    //
    // 副本一律落成"外部素材"镜头（复用同一条 video_url），而不是复制一份
    // AI 镜头：AI 镜头带着拆解/提示词/版本历史，复制它们语义含糊（副本要不要
    // 跟着重新生成？版本树怎么算？）。落成外部素材则含义明确——就是同一段
    // 画面再放一次，与剪映复制片段的效果一致。
    paste: () => { void doPaste(); },
    cut: () => { void doCut(); },
    deleteSelected: () => removeSelectedClips(),
    splitAtPlayhead: () => {
      // 用播放头所在的那个 clip 作为切割目标；播放头必须在片内（两端各留 0.5s）
      const ph = tlStore().playheadSec;
      const clip = tlStore().allClips().find(
        (c) => c.shotId && ph > c.startSec + 0.5 && ph < c.startSec + c.durationSec - 0.5);
      if (!clip?.shotId) { say("把播放头移到某个镜头中间再按 Ctrl+B"); return; }
      void doSplit(clip.shotId, ph - clip.startSec);
    },
    // D：停用 / 启用**全部**选中镜头。
    //
    // 3.5：旧实现是 `selection.clipIds[0]` —— 只处理第一个。这在 Ctrl+A
    // 之前还算隐蔽（多选只能靠框选），现在全选一按就高亮几百格，再按 D
    // 只有一格变灰，看起来就是坏的。与 `removeSelectedClips` 当初修掉的
    // 是同一个毛病：选中集说 N 个，操作只做 1 个。
    //
    // 方向按**第一个**选中镜头的当前状态定，整批同向 —— 逐个各自取反的话，
    // 一个半停用的选区按下去还是半停用的，用户按第二次也一样，等于没有
    // "全部停用"这个操作。
    toggleDisabled: () => {
      const st = tlStore();
      const sel = st.selection.clipIds
        .map((id) => st.findClip(id))
        .filter((c): c is NonNullable<typeof c> => !!c);
      const clips = sel.filter((c) => c.entity === "shot" && !!c.shotId);
      if (!clips.length) {
        // 6.9：音频/字幕现在选得中了，但它们**没有"停用"这个状态** ——
        // 后端没有这一列，也没有"留在轨上但不导出"的语义。这时说
        // "先选中时间轴上的片段"是撒谎（用户明明选中了），要说清楚该怎么办。
        say(sel.length
          ? "音频/字幕段没有「停用」，要拿掉请按 Delete（可 Ctrl+Z 撤销）"
          : "先选中时间轴上的片段");
        return;
      }
      const to = !clips[0].disabled;
      for (const c of clips) {
        if (c.disabled !== to) void patchTimeline(c.shotId!, { disabled: to });
      }
      if (clips.length > 1) {
        say(`已${to ? "停用" : "启用"} ${clips.length} 个镜头（Ctrl+Z 可撤销）`);
      }
    },
    nudgeLeft: (big) => jumpPlayhead(nudgeSec(
      tlStore().playheadSec, -1, big ? NUDGE_BIG_SEC : NUDGE_STEP_SEC,
      playRange().maxSec)),
    nudgeRight: (big) => jumpPlayhead(nudgeSec(
      tlStore().playheadSec, 1, big ? NUDGE_BIG_SEC : NUDGE_STEP_SEC,
      playRange().maxSec)),
    playheadToStart: () => jumpPlayhead(0),
    playheadToEnd: () => jumpPlayhead(playRange().maxSec),
    prevEdge: () => {
      const { edges } = playRange();
      jumpPlayhead(edgeSec(edges, tlStore().playheadSec, -1));
    },
    nextEdge: () => {
      const { edges } = playRange();
      jumpPlayhead(edgeSec(edges, tlStore().playheadSec, 1));
    },
    shuttle: doShuttle,
    shuttleStop: stopShuttle,
    setIn: doSetIn,
    setOut: doSetOut,
    zoomIn: () => tlStore().zoomBy(1.25),
    zoomOut: () => tlStore().zoomBy(0.8),
    zoomFit: () => tlStore().fitTo(window.innerWidth - 800),
    escape: () => {
      tlStore().clearSelection();
    },
    // 3.5：全选走 selection.ts 的同一条判据 —— 锁定/隐藏轨与没有 shotId 的
    // 音频/字幕段不进选中集。旧实现是 `detail.shots.map(s => s.id)`：
    // 既不看轨道状态，也不管那一镜此刻在不在时间轴上，选出来的集合和
    // 高亮、和 Delete 能处理的范围三方都对不上。
    selectAll: () => {
      const ids = allSelectableIds(tlStore().timeline.tracks);
      if (!ids.length) { say("时间轴上没有可选的片段"); return; }
      tlStore().selectClips(ids);
      say(`已全选 ${ids.length} 个片段`);
    },
    selectSide,
  });


  /** 旁白/配乐试听（时间轴音频轨点击）；素材预览走 LibraryPanel 的 onPreview */
  const previewAudio = (url: string, label: string) => previewMedia(url, label);

  // ---- 跨层协调：切/关项目清场（各层 clearXxx 统一从这里调度）----
  // 修复：切换/关闭项目时清空工作区状态，防止上一项目的预览/剪辑/选中态串到新项目
  function resetWorkspace() {
    clearPlayer();          // 预览/播放头/选中镜头
    clearShuttle();         // 3.3：快进/快退倍速与定时器不能跟着切到新项目
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
    shotRev.clear();        // 2.3：上个项目的 transform 版本号不能带进新项目
    // 2.4：读失败条目是"上一个项目的哪些数据没加载"，换项目后这句话不再成立；
    // 留着会在新项目顶栏挂一条永远不消失的「字幕未加载」（新项目加载成功也不清，
    // 因为 noteLoaded 清的是同一个 key —— 实际上会被清掉，但在新项目那几百毫秒里
    // 显示的是上一个项目的失败，属于误报）。
    useLoadState.getState().clearAll();
    // 两个 zustand store 不在上面任何 clearXxx 的覆盖范围内（F16）。
    // timeline 数据本身会因 detail=null → shots=[] 被重建 effect 清空，
    // 但播放头/定位线/选中/剪贴板/工具不走那条链路，会原样留给下一个项目。
    useTimelineStore.getState().resetForProjectSwitch();
    // canvasToolStore 同理（F16）：覆盖层模式/选中的马赛克区域下标是纯 UI 态，
    // 不跟着 detail 走。留着的话切到新项目会带着"第 3 个区域被选中"进来，
    // 而新项目那个镜头可能压根没有马赛克。
    useCanvasToolStore.getState().resetCanvasTools();
    // 3.9：波形峰值按 url 缓存（模块级 LRU，最坏 ~7.7 MB）。它有容量上限、
    // 不会无限涨，但跨项目**没有任何复用价值** —— 新项目的音频是另一批 url，
    // 留着只是让上个项目的条目在 LRU 里占位、把新项目的挤出去。
    clearWaveformCache();
    // 6.3：把上个项目材料化出来的 blob 全部 revoke。这里**必须**清，
    // 而且与波形缓存的理由不同：那边是"留着没价值"，这边是**留着就是内存泄漏**，
    // 泄漏单位是一整个视频文件（blob 只有 revoke 才还给系统，GC 管不着它）。
    // 顺序上排在 clearPlayer() 之后：那句已经把 <video> 的 src 摘掉了，
    // 此刻没有任何一个 blob 正在被播放，回收谁都不会黑屏。
    localSources.release();
    localSources.setProject(null);
  }

  // ---- 顶层门禁（6.7）----
  // 规则本身全在 `lib/appGate.ts`，这里只按结论渲染。搬走的理由见那个文件的开头：
  // 门禁是"错了就整个软件进不去"的逻辑，而写在 .tsx 里 node 下 import 不进来，
  // 于是它一直是全仓唯一没有测试的部分。
  const screen = decideScreen({
    backendOk, loginRequired, projectId,
    // ⚠️ 是 `detail` 不是 `projectId`：id 从 localStorage 恢复，断网启动时它也在，
    // 而详情还没拿到。拿 id 判断会把一个空壳编辑器摆到用户面前。
    hasProjectData: detail !== null,
  });

  // ---- 后端不可达且手上没有项目数据：可诊断的错误页 + 重试入口 ----
  // 此前这里把用户直接放进空项目列表，然后每个操作都失败，
  // 看不出是"后端挂了"还是"我的项目没了"。
  if (screen === "offline") {
    return (
      <div className="login-page">
        <div className="fw-offline">
          <div className="fw-offline-title">连不上服务器</div>
          <div className="fw-offline-desc">
            服务器暂时没有响应。正在每 15 秒自动重试，恢复后会自动进入。
          </div>
          <button className="btn primary" onClick={() => { void retryBackend(); }}>
            立即重试
          </button>
        </div>
      </div>
    );
  }

  // ---- 登录门控（放在项目列表之前；探测中显示空态防闪烁）----
  if (screen === "probing") {
    return <div className="login-page"><div className="muted">正在连接…</div></div>;
  }
  if (screen === "login") {
    return <LoginPage onLoggedIn={onLoggedIn} />;
  }

  // ---- 无项目：项目列表首屏（T-R0-06）----
  if (screen === "projects") {
    return <ProjectList onOpen={openProject} />;
  }

  // 到这里 `screen` 必然是 "editor"。TS 不知道 `decideScreen` 保证了
  // editor ⇒ projectId !== null（旧代码靠 `if (!projectId)` 顺手收窄，
  // 换成 screen 判断后那层收窄没了），故补这一句。
  // 它在运行期是**到不了**的：真跑到就说明 appGate 出了回归。
  // `verify-appgate.ts` 用穷举把这条不变式钉住了，所以这里不是猜测。
  if (projectId === null) {
    return <ProjectList onOpen={openProject} />;
  }

  // ---- 派生值：给 Inspector / TopBar 用 ----
  // totalSec / exportClips 来自 useCompose（与「快速导出」同口径，不另算一套）
  // 2.2：在服务端 shots 上盖一层"拖动中还没落库"的 transform_meta。
  // 播放器、特效面板、CropZoomOverlay、MosaicOverlay、ClipProperties 都从
  // 这一个 shots 派生，所以盖在这里 = 六个读取方一次性跟手，零调用点改动。
  // 没有待写项时 applyPending 原样返回同一个数组（不制造新引用）。
  const shots = stagedTransform.applyPending(detail?.shots ?? []);
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
      // 3.7：回主轨时后端**不需要** overlay_start_sec，但撤销回叠加层时需要 ——
      // 所以旧值必须在 PATCH 之前抄下来，之后 refreshDetail 一刷就没了。
      const old = detail?.shots.find((s) => s.id === shotId) ?? null;
      const prevIndex = old?.track_index ?? 0;
      const prevStart = old?.overlay_start_sec ?? 0;
      const nextStart = Math.max(0, startSec ?? 0);
      await api.patchShotTimeline(shotId, {
        trackIndex,
        ...(trackIndex > 0 ? { overlayStartSec: nextStart } : {}),
      });
      await refreshDetail();
      say(trackIndex > 0
        ? `已移到叠加层，起点 ${(startSec ?? 0).toFixed(1)}s（可在检查器调整，Ctrl+Z 可撤销）`
        : "已移回主轨（Ctrl+Z 可撤销）");
      if (old && prevIndex !== trackIndex) {
        pushUndo(trackIndex > 0 ? `镜头 #${old.order} 移到叠加层` : `镜头 #${old.order} 移回主轨`,
          async () => {
            await api.patchShotTimeline(shotId, {
              trackIndex: prevIndex,
              ...(prevIndex > 0 ? { overlayStartSec: prevStart } : {}),
            });
            await refreshDetail();
          },
          async () => {
            await api.patchShotTimeline(shotId, {
              trackIndex,
              ...(trackIndex > 0 ? { overlayStartSec: nextStart } : {}),
            });
            await refreshDetail();
          });
      }
    } catch (e) { say(String(e)); }
  };

  /** Render V2 转场：把转场加在「选中镜头」与它下一个镜头的接缝上。
   *  转场是两个 clip 之间的关系，所以必须先选中一个镜头才知道加在哪条缝。
   *
   *  3.6 修了这里的两处：
   *  ① 挑「下一镜」时**没有排除叠加层**——叠加层镜头走 overlay 通路，不参与
   *    主轨串接，转场挂上去导出时静默丢弃（`normalize.ts` 找不到相邻关系）。
   *    现在与 `buildSeamMarkers` / 编译器同一口径：主轨 + 未停用 + 按 order。
   *  ② 时长硬编码 0.5s **不夹持**。xfade 吃掉的是两侧的重叠，短镜头（比如
   *    0.4s 的空镜）会被整个吃光，导出画面糊成一团。现在按接缝余量夹持，
   *    放不下就直说，而不是加一条注定难看的转场。 */
  const doApplyTransition = async (type: string) => {
    if (!projectId || !selectedShot) { say("请先在时间轴选中一个镜头"); return; }
    const sorted = [...shots]
      .filter((s) => (s.track_index ?? 0) === 0 && !s.disabled)
      .sort((a, b) => a.order - b.order);
    const i = sorted.findIndex((s) => s.id === selectedShot.id);
    if (i < 0) {
      say((selectedShot.track_index ?? 0) > 0
        ? "叠加层镜头不参与主轨串接，转场只能加在主轨的接缝上"
        : "已停用的镜头不进成片，请先恢复启用再加转场");
      return;
    }
    const next = sorted[i + 1];
    if (!next) { say("最后一个镜头之后没有接缝，请选中前一个镜头"); return; }

    const room = maxTransitionSec(shotDuration(selectedShot), shotDuration(next));
    if (room <= 0) {
      say(`#${selectedShot.order} → #${next.order} 两镜太短，放不下转场`
        + `（转场要吃掉两侧各一段画面）`);
      return;
    }
    const duration = clampTransitionSec(0.5, shotDuration(selectedShot), shotDuration(next));
    try {
      const r = await api.createTransition({
        project_id: projectId,
        from_shot_id: selectedShot.id, to_shot_id: next.id,
        type, duration,
      });
      await refreshTransitions();
      // 3.7 前置：转场的增删改此前一个撤销点都没有，加错了只能靠"再加一个覆盖"。
      let curId = r.id;
      pushUndo(`加转场 #${selectedShot.order} → #${next.order}`,
        async () => { await api.deleteTransition(curId); await refreshTransitions(); },
        async () => {
          const again = await api.createTransition({
            project_id: projectId,
            from_shot_id: selectedShot.id, to_shot_id: next.id, type, duration,
          });
          curId = again.id;               // 重建后主键会变，撤销要认新的
          await refreshTransitions();
        });
      say(`已在 #${selectedShot.order} → #${next.order} 加「${type}」转场（${r.duration}s`
        + `${duration < 0.5 ? "，因镜头较短已缩短" : ""}）`
        + `${r.replaced ? "，替换了原有转场" : ""}`);
    } catch (e) { say(String(e)); }
  };

  /** 3.6 改转场时长。`api.patchTransition` 在此之前是**零调用者**的死代码：
   *  接缝在界面上根本不存在，用户没有任何入口能改到它。 */
  const doPatchTransition = async (id: string, durationSec: number) => {
    const prev = transitions.find((t) => t.id === id);
    if (!prev || prev.duration === durationSec) return;
    const before = prev.duration;
    try {
      await api.patchTransition(id, { duration: durationSec });
      await refreshTransitions();
      pushUndo(`转场时长 → ${durationSec.toFixed(1)}s`,
        async () => { await api.patchTransition(id, { duration: before }); await refreshTransitions(); },
        async () => { await api.patchTransition(id, { duration: durationSec }); await refreshTransitions(); });
      say(`转场时长 ${durationSec.toFixed(1)}s（成片会相应缩短 ${durationSec.toFixed(1)}s）`);
    } catch (e) { say(String(e)); }
  };

  /** 3.6 删转场。`api.deleteTransition` 同样是零调用者——加错了删不掉，
   *  唯一的补救是往同一条缝再加一个让后端 upsert 覆盖。 */
  const doDeleteTransition = async (m: SeamMarker) => {
    if (!projectId) return;
    const t = transitions.find((x) => x.id === m.id);
    if (!t) return;
    try {
      await api.deleteTransition(m.id);
      await refreshTransitions();
      let curId = m.id;
      pushUndo(`删除转场「${t.type}」`,
        async () => {
          const again = await api.createTransition({
            project_id: projectId,
            from_shot_id: t.from_shot_id, to_shot_id: t.to_shot_id,
            type: t.type, duration: t.duration,
            ...(t.params ? { params: t.params } : {}),
          });
          curId = again.id;
          await refreshTransitions();
        },
        async () => { await api.deleteTransition(curId); await refreshTransitions(); });
      say(`已删除转场「${t.type}」，这条接缝恢复硬切`);
    } catch (e) { say(String(e)); }
  };

  /** TB-08 自动字幕：对**实际发声的那条音轨**做语音识别，按时间戳生成字幕段。
   *  解说剧的声音在 TTS 旁白里，真人剧的声音在镜头视频自带的音轨里（音画一体），
   *  后端按 production_mode 选音源（见 jobs.run_auto_subtitles），这里只把话说对。 */
  const doAutoSubtitles = async () => {
    if (!projectId) return;
    const fromVideo = detail?.production_mode === "drama";
    try {
      const job = await api.submitAutoSubtitles(projectId, true);
      trackJob(job, "auto_subtitles");
      say(fromVideo
        ? "🎧 正在识别镜头原声并生成字幕（纯文本，不出图不出片）"
        : "🎧 正在识别旁白并生成字幕（纯文本，不出图不出片）");
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

  /** TB-03/TB-10 保存画面与音频调整；空对象 = 清除全部调整。
   *
   *  2.2：拖动中的中间值走 `stagedTransform`（本地即时生效、落库尾防抖），
   *  离散操作与松手收尾立即落库。转发到上面的 stagedTransform.patch ——
   *  hook 必须在早返回（登录门控/项目列表）之前调用，故声明在文件上方。 */
  const doPatchTransform = (
    shotId: string, tm: TransformMeta | Record<string, never>,
    opts?: TransformPatchOpts,
  ) => {
    stagedTransform.patch(shotId, tm, opts);
  };

  /** TB-01 镜头分割：把某镜在 atSec 秒处切成两段（不重新转码，只记取片窗口）。 */
  const doSplit = async (shotId: string, atSec: number) => {
    try {
      const r = await api.splitShot(shotId, atSec);
      await refreshDetail();
      say(`已分割为 #${r.head_order}（${r.head_duration}s）+ #${r.tail_order}（${r.tail_duration}s）`);
      // Ctrl+B 在剪映里是能 Ctrl+Z 回去的。这里的逆操作要走专门的 unsplit：
      // 后半段是 is_special=0 的 AI 镜头行，delete_shot 明确拒删它。
      pushUndo(`分割镜头 #${r.head_order}`,
        async () => {
          await api.unsplitShot(r.head_shot_id, r.tail_shot_id);
          await refreshDetail();
        },
        async () => {
          await api.splitShot(r.head_shot_id, atSec);
          await refreshDetail();
        });
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
                // 真人剧没有旁白音频可对齐，字幕只能来自镜头原声 —— 面板据此
                // 把「识别镜头原声」提为主入口（见 TextPanel 的 fromVideo 注释）
                fromVideo={detail?.production_mode === "drama"}
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
                onPatchTransform={(tm, o2) => { if (selectedShot) doPatchTransform(selectedShot.id, tm, o2); }}
                onApplyTransition={(t) => { void doApplyTransition(t); }}
                onToast={say} />
            ),
            effect: (
              <EffectsPanel kind="effect" hasSelection={!!selectedShot}
                shotId={selectedShot?.id ?? null}
                projectId={projectId}
                transform={selectedShot?.transform_meta ?? null}
                onPatchTransform={(tm, o2) => { if (selectedShot) doPatchTransform(selectedShot.id, tm, o2); }}
                onToast={say} />
            ),
            filter: (
              <EffectsPanel kind="filter" hasSelection={!!selectedShot}
                shotId={selectedShot?.id ?? null}
                projectId={projectId}
                transform={selectedShot?.transform_meta ?? null}
                onPatchTransform={(tm, o2) => { if (selectedShot) doPatchTransform(selectedShot.id, tm, o2); }}
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
          shuttleRate={shuttle}
          // 取**正在预览**那个镜头的调色参数，不是 selectedShot ——
          // 两者可能不同（点了 A 镜预览、又在列表里选中 B 镜），
          // 用 selectedShot 会把 B 的调色套到 A 的画面上。
          transform={shots.find((s) => s.id === previewShot?.id)?.transform_meta ?? null}
          subtitles={subtitles}
          subtitleStyle={subtitleStyle}
          overlayMode={overlayMode}
          onSetOverlayMode={setOverlayMode}
          onPatchTransform={previewShot
            /* `o` 必须透传：马赛克覆盖层拖动时每一帧都带 {staged:true}，
               丢掉它等于每一帧都真写一次盘（2.2 的暂存写就白做了）。 */
            ? (tm, o) => void doPatchTransform(previewShot.id, tm, o)
            : undefined}
          onToast={say}
          emptyHint={`${shots.filter((s) => !s.disabled).length} 段可导出 · ${fmtTime(totalSec)}`}
          previewWindow={previewWindow}
          onLoadedMetadata={(e) => {
            if (pendingSeek.current != null) {
              e.currentTarget.currentTime = pendingSeek.current;
              pendingSeek.current = null;
            } else if (previewWindow && previewWindow.inSec > 0) {
              // 3.1：修剪过入点的镜头要从入点开始播，而不是素材开头 ——
              // 从 0 播等于把用户刚剪掉的那段又放给他看。
              e.currentTarget.currentTime = previewWindow.inSec;
            }
            // 3.3：这次换源只是"把播放头挪过去"，收住 `<video autoPlay>` 的自动播放。
            // 必须在设好 currentTime 之后 —— 先 pause 再改时间同样有效，
            // 但放在这里才与"seek 完成即定格"的直觉一致。
            if (pendingPause.current) {
              pendingPause.current = false;
              e.currentTarget.pause();
            }
          }}
          onTimeUpdate={(e) => {
            if (previewShot)
              setPlayhead({ order: previewShot.order,
                            offsetSec: toShotTime(e.currentTarget.currentTime) });
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
          /* 5.6：马赛克关键帧要知道播放头在**本镜**的哪一秒。
             播放头不在检查器这一镜上时给 null —— 面板据此禁用菱形按钮，
             而不是拿别的镜头的时间去记关键帧。 */
          playheadShotSec={playhead && inspectorShot && playhead.order === inspectorShot.order
            ? playhead.offsetSec : null}
          onSeekShotSec={(sec) => {
            if (!inspectorShot) return;
            // 面板给的是镜内秒，播放头走的是绝对秒。用与画线同源的
            // buildOrderOffsetMap 换算，不自己累加时长（那是 secToPosition
            // 注释里记过的"三套算法"老毛病）。
            const start = buildOrderOffsetMap(shots).get(inspectorShot.order) ?? 0;
            movePlayheadTo(start + sec);
          }}
          projectTitle={detail?.title ?? ""}
          baseAspect={detail?.base_aspect}
          maxDurationSec={detail?.shot_duration_max}
          shotCount={shots.length}
          doneCount={doneCount}
          totalSec={totalSec}
          onRegenerate={doGenerate}
          onOpenAdvanced={(s) => setAdvancedShot(s)}
          onPatchDuration={(shotId, sec) => {
            // 3.1：与时间轴拖右边缘同源 —— 被分割过的镜头要同时改窗口长度，
            // 否则这里改完时间轴变短、成片长度不动（导出读的是 clip_dur_sec）。
            const sh = detail?.shots.find((s) => s.id === shotId);
            void patchTimeline(shotId, outPatch(sh ?? {}, sec));
          }}
          onClearClipWindow={(shotId) => {
            // 3.1：只清窗口起点，长度不变（后端不知道源素材多长，
            // 不可能"还原成完整素材"——那需要重新探测时长，属于另一件事）。
            void patchTimeline(shotId, clearWindowPatch());
          }}
          /* ⚠️ `opts` 必须原样透传。写成 `(shotId, tm) => …` 一样能过编译
             （参数少的函数可以赋给参数多的函数类型），但 2.2 的 staged 暂存写
             会被静默丢掉：拖滑块时每一帧都变成一次真写盘。5.6 又给这条路
             加了两个滑块和"拖动即写关键帧"，所以在这里补上。 */
          onPatchTransform={(shotId, tm, o) => { void doPatchTransform(shotId, tm, o); }}
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
          transitions={transitions}
          onPatchTransition={(id, sec) => { void doPatchTransition(id, sec); }}
          onDeleteTransition={(m) => { void doDeleteTransition(m); }}
          stages={stages}
          locations={locations}
          assets={detail?.assets ?? []}
          maxClipSec={detail?.shot_duration_max}
          selectedShotId={selectedShot?.id ?? null}
          onSelectShot={onSelectShot}
          playhead={playhead}
          cursor={cursor}
          onSetCursor={setCursor}
          onScrub={onScrub}
          maximized={maxPanel === "dock"}
          onToggleMax={() => toggleMaximized("dock")}
          onPatch={patchTimeline}
          /* 6.9 音频/字幕轨：三条与镜头不同的写通路，规则见 clipEdit.ts */
          onEditClip={editClip}
          onMoveClip={moveClip}
          onDeleteClip={(c) => { void deleteTimelineClip(c); }}
          onDeleteShot={deleteSpecialShot}
          onRemoveSelected={() => removeSelectedClips()}
          onSelectSide={selectSide}
          onRegenerate={doGenerate}
          onUpgrade={(sh) => { void doUpgrade(sh); }}
          /* 版本历史常驻 Inspector 的「版本」区，选中该镜即可见，不另开弹窗 */
          onShowVersions={(s: ShotInfo) => setSelectedShotId(s.id)}
          /* 这里**不**透传 opts：Timeline 的 onPatchTransform 只用于右键菜单里的
             「静音」这类离散动作（Timeline.tsx:655），签名本就没有 opts，
             没有 staged 写可丢。与上面 Inspector 那条的区别是真实的，不是漏改。 */
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
          {/* 6.7 断线横幅。断线**不再**把编辑器换成断线页（那会销毁选中态、
              播放头和未落库的调整），代价是必须在这里把话说清楚。
              6.8 把话改了：改动现在**真的**会被暂存并补发，6.7 那句关于
              「失败的改动没人重试」的说明因此变成了反向的谎，必须跟着行为一起改。
              文案本体在 `lib/outbox.ts` 的 `offlineBannerText`，与队列同一个文件 ——
              哪天队列被摘掉，改行为的人一眼就能看见要改的那句话。 */}
          {backendOk === false && (
            <div className="banner fw-net-bar">
              <span>
                ⚠️ 已断开与服务器的连接 —— {offlineBannerText(pendingWrites)}
                已下载到本地的素材仍可预览和导出。正在每 15 秒自动重连。
                {/* 浏览器里没有 appDataDir()，队列只在内存。这句必须说，
                    否则就是又一个"假的已保存"：用户以为关掉页签还在。 */}
                {!isDurable() && <b>（当前在浏览器中打开，暂存只在本页面有效，关闭页签即丢失）</b>}
                {snapshotAt !== null && `你看到的是 ${describeSnapshotAge(snapshotAt, Date.now())}保存在本地的版本。`}
              </span>
              <span className="update-actions">
                <button className="btn ghost" onClick={() => { void retryBackend(); }}>
                  立即重试
                </button>
              </span>
            </div>
          )}
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
              episodeTitles={Object.fromEntries(
                detail.episodes.map((e) => [e.order, e.title]))}
              selectedShotIds={selectedShot ? [selectedShot.id] : []}
              exportDir={exportDir}
              onPickPath={pickExportPath}
              onLocalExport={doLocalExport}
              localBusy={localProgress !== null}
              localProgress={localProgress}
              localResult={exportDone}
              onReveal={(path) => {
                // revealItemInDir = 在资源管理器/访达里定位并选中该文件，
                // 而不是用播放器打开它——导出完用户十有八九是要去拿这个文件。
                void revealItemInDir(path).catch((e: unknown) => say(`打开文件夹失败：${String(e)}`));
              }}
              onResetResult={() => setExportDone(null)}
              onCancel={() => renderAbort?.abort()}
              onClose={() => { setExportOpen(false); setExportDone(null); }} />
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
