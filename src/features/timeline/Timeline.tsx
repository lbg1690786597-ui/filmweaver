/**
 * Timeline — 主时间轴容器（Phase 2）
 *
 * 架构：
 *   ┌──────────────────────────────────────────────────────┐
 *   │ 工具条（缩放 / 适配 / Undo / Redo）                  │
 *   ├──────────────────────────────────────────────────────┤
 *   │ 刻度尺（sticky top）                                 │
 *   ├──────────────────────────────────────────────────────┤
 *   │ 轨道区（横向滚动，轨道头 sticky left）               │
 *   │  [TrackHeader | ClipView...][播放头][定位线]         │
 *   └──────────────────────────────────────────────────────┘
 *
 * 坐标系：left = startSec × pxPerSec，所有轨道共享 totalWidth。
 * 拖动/Trim 只更新本地状态，松手 → 调用 onPatch/onReorder。
 */

import { useEffect, useRef, useState, useCallback, useMemo, useLayoutEffect } from "react";
import type { Clip } from "../../types/timeline";
import { ZOOM_MIN, ZOOM_MAX } from "../../types/timeline";
import type { ShotInfo, AudioClipInfo, StageInfo, LocationInfo, AssetInfo, SubtitleClipInfo, TransitionInfo } from "../../api";
import { buildTimeline, buildOrderOffsetMap, secToPosition } from "../../adapters/shotToClip";
import { useTimelineStore } from "../../stores/timelineStore";
import TimelineRuler from "./TimelineRuler";
import TrackHeader from "./TrackHeader";
import ClipView from "./ClipView";
import ContextMenu from "../../components/ContextMenu/ContextMenu";
import type { MenuItem } from "../../components/ContextMenu/ContextMenu";
import AssetTrack, { AssetTrackKind, AssetRun } from "../assets/AssetTrack";
import { collectSnapPoints, snapRange } from "./snap";
import {
  quantizeSec, trimOut, trimIn, outPatch, inPatch, minTrimSec,
  inPointOf, outPointOf, canTrimIn,
  MIN_CLIP_SEC, MAX_CLIP_SEC_FALLBACK,
} from "./trim";
import type { ClipWindowSource } from "./trim";
import {
  canDrag, canDeleteFromTimeline, clampDuration, clearTrimPatch, durationBounds,
  hasTrim, trimInDeltaBounds, trimInPatch, trimOutPatch,
} from "./clipEdit";
import type { ClipEditPatch } from "./clipEdit";
import { followScroll, FOLLOW_SUSPEND_MS } from "./playhead";
import { createScrubber } from "./scrub";
import type { ScrubPhase, Scrubber } from "./scrub";
import { rectIds, rangeIds, RANGE_HINT } from "./selection";
import {
  bucketViewport, sameViewport, visibleSpan, visibleClips,
  pointSpanPx, inSpan, SEAM_HALF_PX,
} from "./virtual";
import type { Viewport } from "./virtual";
import {
  buildSeamMarkers, seamHint, seamSummary, clampToSeam,
  MIN_TRANSITION_SEC,
} from "./transitions";
import type { SeamMarker } from "./transitions";
import {
  Undo2, Redo2, ZoomIn, ZoomOut, Maximize2, MousePointer2, Scissors,
  ChevronsLeft, ChevronsRight, Magnet,
  Trash2, EyeOff, Eye, Copy, Scissors as ScissorsIcon,
  RefreshCw, History, Gem, Layers, VolumeX, CopyPlus, Crosshair,
  Shuffle, AlertTriangle, X, RotateCcw, Square,
} from "lucide-react";
import "./Timeline.css";

const GUTTER_W = 68; // 轨道头宽度（px），与 TrackHeader sticky left 对齐
// MIN_CLIP_SEC / MAX_CLIP_SEC_FALLBACK 已移到 ./trim（3.3）：
// I/O 快捷键与拖边缘必须共用同一组上下限，各写一份必然漂移。

interface Props {
  shots: ShotInfo[];
  audioClips?: AudioClipInfo[];
  subtitleClips?: SubtitleClipInfo[];
  /** 3.6 转场。此前时间轴完全不知道它们存在——加了只能靠数镜头去猜加在哪。 */
  transitions?: TransitionInfo[];
  /** 3.6 改转场时长（`api.patchTransition` 在此之前**零调用者**） */
  onPatchTransition: (id: string, durationSec: number) => void;
  /** 3.6 删转场（`api.deleteTransition` 同样是零调用者：加错了删不掉） */
  onDeleteTransition: (m: SeamMarker) => void;
  stages?: StageInfo[];
  locations?: LocationInfo[];
  assets?: AssetInfo[];

  /** 单镜时长上限（秒），来自 detail.shot_duration_max（seedance-2.5 = 30）。
   *  缺省按 15，即老模型口径。 */
  maxClipSec?: number;

  selectedShotId: string | null;
  onSelectShot: (s: ShotInfo) => void;

  playhead: { order: number; offsetSec: number } | null;
  cursor: { order: number; offsetSec: number } | null;
  onSetCursor: (c: { order: number; offsetSec: number } | null) => void;
  /** 3.4 拖播放头。`sec` 是时间轴绝对秒（不再是「哪个镜头的第几秒」——
   *  换算由 App 的 `movePlayheadTo` 统一做，与方向键/Home/End 同一条通路）。
   *
   *  `phase` 决定允不允许做昂贵的事：`move` 只挪线，只有 `commit` 才可以
   *  换预览源（= 重建 `<video>` + 重新下载整个素材）。 */
  onScrub: (sec: number, phase: ScrubPhase) => void;

  maximized: boolean;
  onToggleMax: () => void;

  onPatch: (shotId: string, p: {
    durationSec?: number; toOrder?: number; disabled?: boolean;
    /** 3.1 取片窗口（见 features/timeline/trim.ts 的 TrimPatch） */
    clipInSec?: number; clipDurSec?: number; clearClipWindow?: boolean;
  }) => Promise<void>;
  onDeleteShot: (shotId: string) => Promise<void>;
  /** 3.5 工具条的 🗑「删除选中」。
   *
   *  以前它走的是自己的一条路：对每个选中镜头直接调 `onDeleteShot`
   *  （= `api.deleteShot` 硬删）。而 Delete 键走的是 App 的
   *  `removeSelectedClips` —— 外部素材才真删（且弹确认），AI 镜头只停用
   *  且可撤销。后端本来就拒绝删 AI 镜头，所以按钮那条路在 AI 镜头上的实际
   *  效果是**每个镜头弹一条报错 toast**；Ctrl+A 之后按一下就是几百条。
   *  现在两者共用 App 的那一个实现。 */
  onRemoveSelected: () => void;
  /** 3.5 `[` / `]` 与工具条上对应的两个按钮：以播放头为界选中一侧。
   *  实现在 App（与快捷键同一个），见 `commands/index.ts` 的同名字段。 */
  onSelectSide: (side: "left" | "right") => void;
  onRegenerate: (shotIds: string[]) => void;
  /** 精品升级（换高价模型重生成该镜） */
  onUpgrade: (shot: ShotInfo) => void;
  /** 选中该镜并在右侧 Inspector 展开版本历史 */
  onShowVersions: (shot: ShotInfo) => void;
  /** 改镜头级渲染参数（静音等存在 transform_meta 里） */
  /** 6.9：音频/字幕的修剪落库。patch 由 `clipEdit.ts` 的纯函数算出，
   *  这里只负责发出去 —— 分派到哪个端点由 `patch.entity` 决定。 */
  onEditClip: (patch: ClipEditPatch) => Promise<void>;
  /** 6.9：音频/字幕拖到绝对秒 targetSec。**换算成锚点由 App 做** ——
   *  它要用 `secToPosition`（`adapters/shotToClip.ts`），而那个换算依赖
   *  完整的镜头表。在这里再写一套累加就是这条时间轴上的第四个真源，
   *  该文件的注释记着前三个曾经如何漂移成"线画在一处、片段跳到另一处"。 */
  onMoveClip: (clip: Clip, targetSec: number) => void;
  /** 6.9：从时间轴直接删掉音频/字幕片段（镜头不走这里，见 canDeleteFromTimeline） */
  onDeleteClip: (clip: Clip) => void;
  onPatchTransform: (shotId: string, patch: Record<string, unknown>) => void;
  /** TB-01：在镜内 atSec 秒分割（时间轴 Ctrl+B / 右键） */
  onSplit: (shotId: string, atSec: number) => void;
  /** 素材面板拖进来的片段（MediaPanel 设的 application/x-fw-clip）。
   *  此前 MediaPanel 的 tooltip 写着「拖到时间轴插入」，但没有任何落点
   *  接收这个 MIME —— 旧的 TimelineDock 被删时把 onDrop 一起带走了，
   *  用户按提示拖过去什么都不会发生。 */
  onDropClip?: (clip: { id: string; name: string; url: string;
                        kind: string; duration: number }) => void;
  /** Render V2：主轨 ↔ 叠加层互移（trackIndex=0 回主轨） */
  onMoveTrack: (shotId: string, trackIndex: number, startSec?: number) => void;
  onPushUndo: (label: string, undo: () => Promise<void>) => void;
  onToast: (m: string) => void;
  /** Phase 5：资产轨改动后重拉 stages + detail */
  onAssetsChanged: () => void;
  /** Phase 5：选中资产段 → Inspector 显示影响范围 */
  onSelectAssetRun: (run: (AssetRun & { rowName: string; kind: AssetTrackKind }) | null) => void;
  selectedAssetRunId: string | null;

  totalSec: number;
  exportCount: number;
  projectId: string;
}

interface CtxState { x: number; y: number; clip: Clip }
interface MoveState { clipId: string; shotId: string; startX: number; startOrder: number; overOrder: number }

export default function Timeline(p: Props) {
  const store = useTimelineStore();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [move, setMove] = useState<MoveState | null>(null);
  // 拖动预览只走本地 state：mousemove 每秒几十次，直接打 store 会让整棵轨道树重渲
  // inSec 只在拖左边缘（3.1 修剪入点）时有值，用来在工具条上显示"从素材第几秒起"。
  const [previewDur, setPreviewDur] = useState<
    { id: string; sec: number; inSec?: number } | null>(null);
  const [previewOrder, setPreviewOrder] = useState<{ id: string; order: number } | null>(null);
  /** 框选中的矩形（null = 没在框选）。3.8 起纵向可跨轨，故存的是**轨 id 集合**
   *  而不是单个 trackId —— 浮层要在每条被覆盖的 lane 里各画一条，拼成一个带子。 */
  const [marquee, setMarquee] = useState<
    { fromSec: number; toSec: number; trackIds: string[] } | null>(null);
  /** 叠加层拖动预览（按绝对秒，与主轨的 order 拖动是两套语义） */
  const [overlayDrag, setOverlayDrag] = useState<
    { clipId: string; startSec: number } | null>(null);
  /** 素材拖到轨道上方时的高亮反馈（没有它用户不知道能不能放） */
  const [dropHot, setDropHot] = useState(false);
  /** 3.6 正在编辑的转场（点接缝上的菱形打开）。用屏幕坐标定位，理由同右键菜单：
   *  轨道行有固定高度，浮层挂在行内会被裁掉。 */
  const [seamEdit, setSeamEdit] = useState<{ m: SeamMarker; x: number; y: number } | null>(null);

  // 当前缩放（多处使用，提前取出——下方多个 effect 依赖它）
  const pxPerSec = store.pxPerSec;

  // ---- 后端数据变化 → 重建时间轴 ----
  // setTimeline 走 getState()：从 hook 拿到的 store 对象每次渲染都是新引用，
  // 放进依赖数组会让这个 effect 每渲染都跑一次（进而 setState → 再渲染）。
  useEffect(() => {
    useTimelineStore.getState().setTimeline(buildTimeline({
      shots: p.shots,
      audioClips: p.audioClips ?? [],
      subtitleClips: p.subtitleClips ?? [],
      stages: p.stages ?? [],
      locations: p.locations ?? [],
      assets: p.assets ?? [],
    }));
  }, [p.shots, p.audioClips, p.subtitleClips, p.stages, p.locations, p.assets]);

  // ---- 外部选中镜头（分镜列表/播放器）→ 同步选中态 + 滚动到可见 ----
  // 三联动的最后一环：点镜头卡时时间轴要**滚过去**，否则 300 镜的项目里
  // 高亮的那一格根本不在视口内，等于没联动。
  useEffect(() => {
    if (!p.selectedShotId) return;
    const shot = p.shots.find((s) => s.id === p.selectedShotId);
    if (!shot) return;
    // 3.5：写的是**操作用的那套**选中态（高亮就读它）。
    //
    // 已经在选中集里就不动 —— 这一条是 Ctrl+click 加选的活路：加选第 5 镜时
    // App 的 selectedShotId 仍指着最初点的那一镜，此处若无条件
    // `selectClips([它])`，用户刚加选的 4 个会被这个 effect 悄悄清掉
    // （effect 还会因 refreshDetail 改到 p.shots 而重跑，防不住）。
    const st = useTimelineStore.getState();
    if (!st.isClipSelected(shot.id)) st.selectClips([shot.id]);

    const el = scrollRef.current;
    if (!el) return;
    const startSec = buildOrderOffsetMap(p.shots).get(shot.order) ?? 0;
    const left = GUTTER_W + startSec * pxPerSec;
    const width = (shot.duration_sec ?? 5) * pxPerSec;
    const viewL = el.scrollLeft + GUTTER_W;
    const viewR = el.scrollLeft + el.clientWidth;
    if (left < viewL || left + width > viewR) {
      // 居中显示，比"贴边刚好露出来"更容易看清上下文
      el.scrollTo({ left: Math.max(0, left - el.clientWidth / 2), behavior: "smooth" });
    }
  }, [p.selectedShotId, p.shots, pxPerSec]);

  // ---- 播放器播放头 → 时间轴绝对秒 ----
  const offsetMap = buildOrderOffsetMap(p.shots);
  useEffect(() => {
    if (!p.playhead) return;
    const base = offsetMap.get(p.playhead.order) ?? 0;
    useTimelineStore.getState().setPlayheadSec(base + p.playhead.offsetSec);
  }, [p.playhead, p.shots]);

  // ---- zoom with Ctrl+scroll ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const anchorContent = el.scrollLeft + (e.clientX - box.left) - GUTTER_W;
      const oldPx = store.pxPerSec;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newPx = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldPx * factor));
      store.setPxPerSec(newPx);
      requestAnimationFrame(() => {
        el.scrollLeft = (anchorContent / oldPx) * newPx - (e.clientX - box.left) + GUTTER_W;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [store.pxPerSec]);

  /* ==== 3.3 播放头跟随滚动 ==============================================
   *
   * 没有它的话，时间轴上只要片子超过一屏（在默认缩放下大约 40 秒），
   * 播放/快进/方向键把播放头推出视口之后，用户就得手动滚着找那条线。
   *
   * 两条"别烦人"的约束（判定全在 `playhead.ts` 的 `followScroll` 里，可单测）：
   *   · 舒适区内不滚；落点偏左留前瞻，而不是每半屏拽回中间
   *   · 用户**手动滚动后暂停跟随** `FOLLOW_SUSPEND_MS` —— 播放时想往后翻一眼
   *     看看接下来是什么，滚轮刚停就被拽回来的话，等于"播放时不许看别处"
   */
  const followSuspendUntil = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 只认不带 Ctrl 的滚轮：Ctrl+滚轮是上面那个缩放，它自己会重设 scrollLeft，
    // 把它当"用户手动滚动"会让缩放后播放头迟迟不回到视野里。
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      followSuspendUntil.current = Date.now() + FOLLOW_SUSPEND_MS;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() < followSuspendUntil.current) return;
    const next = followScroll({
      // 与下方画线用的 `left: GUTTER_W + playheadLeft` 同一个表达式；
      // 两处各算一遍迟早漂成"线在这儿、滚到那儿"
      playLeftPx: GUTTER_W + store.playheadSec * pxPerSec,
      scrollLeft: el.scrollLeft,
      viewWidthPx: el.clientWidth,
      contentWidthPx: el.scrollWidth,
      gutterPx: GUTTER_W,
    });
    if (next == null) return;
    // smooth：4Hz 的 timeupdate 下硬跳会一格一格地闪
    el.scrollTo({ left: next, behavior: "smooth" });
  }, [store.playheadSec, pxPerSec]);


  const totalWidth = Math.max(600, p.totalSec * pxPerSec);
  const tl = store.timeline;

  /* ==== 3.10 横向虚拟化 ==================================================
   *
   * 1424 镜的项目此前是**把 1424 个片段全部挂进 DOM**，于是 Ctrl+滚轮的每一挡
   * 都要重算 + 重排全部元素。判据全在 `./virtual.ts`（纯模块，可单测），
   * 这里只负责「量视口 + 把区间传下去」。
   *
   * 视口按 `BUCKET_PX` 量化后才进 state：不量化的话每帧 scroll 都 setState、
   * 每次 setState 都重渲，省下来的又原样还回去。
   *
   * `useLayoutEffect` 而不是 `useEffect`：首帧 `scrollRef.current` 为 null，
   * 用的是 `FALLBACK_VIEW_PX` 兜底宽度；layout 阶段量完立刻纠正，
   * 用户不会看见"先画一屏再改一屏"的抖动。
   */
  const [vp, setVp] = useState<Viewport>(() => bucketViewport(0, 0));
  const syncVp = useCallback(() => {
    const el = scrollRef.current;
    const next = bucketViewport(el?.scrollLeft ?? 0, el?.clientWidth ?? 0);
    // 相等就不写 —— 这正是量化的全部意义所在
    setVp((cur) => (sameViewport(cur, next) ? cur : next));
  }, []);
  useLayoutEffect(syncVp);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", syncVp, { passive: true });
    // 容器尺寸变化（最大化时间轴 / 拖侧边栏 / 窗口 resize）也要重量。
    // 只监听 window.resize 会漏掉前两种——它们不产生 resize 事件。
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(syncVp) : null;
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", syncVp); ro?.disconnect(); };
  }, [syncVp]);
  const span = useMemo(() => visibleSpan(vp, GUTTER_W), [vp]);
  /** 正在拖/修剪的那个必须留在 DOM 里，否则拖出视口时预览凭空消失（陷阱 ③）。 */
  const keepIds = useMemo(() => new Set(
    [move?.clipId, previewDur?.id, previewOrder?.id, overlayDrag?.clipId]
      .filter((x): x is string => !!x)),
    [move?.clipId, previewDur?.id, previewOrder?.id, overlayDrag?.clipId]);

  /* ==== 3.6 转场接缝 ====================================================
   *
   * 转场此前只在后端存着：加完看不见、改不了、删不掉（`patchTransition` /
   * `deleteTransition` 全项目零调用者）。这里把它们摆到主轨的接缝上。
   *
   * 只在**主轨**画：转场作用于主轨串接，叠加层根本不参与
   * （`ffmpegCompiler.ts` 的 mainClips / overlayClips 分流），画到叠加层上
   * 等于告诉用户那里也能加。 */
  const seams = useMemo(
    () => buildSeamMarkers(p.shots, p.transitions ?? []),
    [p.shots, p.transitions]);
  const seamInfo = seamSummary(seams);
  // 定位不到的（两端镜头都被删了）画不出来，但仍计入汇总标签——
  // 否则它们就成了永远删不掉的幽灵数据
  const drawableSeams = seams.filter((s) => s.atSec !== null);

  // ---- trim drag ----
  // 注意：onUp 是在 mousedown 那一帧创建的闭包，读不到后续 setState 的新值。
  // 因此拖动结果走 ref（latest 值），state 只负责触发重渲画预览。

  /** Clip → 取片窗口视图（trim.ts 的入参形状）。
   *  它读的是 adapter 从后端原样带过来的 clip_in_sec / clip_dur_sec，
   *  不是重新推算的——推算会在"窗口存不存在"这件事上猜错。 */
  const winOf = (clip: Clip): ClipWindowSource => ({
    duration_sec: clip.durationSec,
    clip_in_sec: clip.clipInSec ?? null,
    clip_dur_sec: clip.clipDurSec ?? null,
    video_url: clip.mediaUrl ?? null,
  });

  // ---- 6.9 音频/字幕的拖 · 修剪 ----
  //
  // 与镜头分开写，不是重复代码：三处语义都不同（上下限依据、左边缘方向、
  // 拖动含义），硬合成一个函数会得到一串 `if (entity === ...)` 穿插在
  // DOM 计算中间。规则本身在 `clipEdit.ts`（纯函数、node 下可验证），
  // 这里只负责"鼠标位置 → 秒"以及预览。

  /** 拖右边缘：改播放时长。 */
  const beginTrimNonShot = useCallback((e: React.MouseEvent, clip: Clip) => {
    if (!canDrag(clip)) return;
    e.preventDefault(); e.stopPropagation();
    const b = durationBounds(clip);
    const startSec = clip.durationSec;
    const startX = e.clientX;
    let latest = quantizeSec(startSec);
    setPreviewDur({ id: clip.id, sec: latest });
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: MouseEvent) => {
      const want = startSec + (ev.clientX - startX) / pxPerSec;
      const next = quantizeSec(clampDuration(want, b));
      if (next === latest) return;
      latest = next;
      setPreviewDur({ id: clip.id, sec: next });
    };
    const onUp = async () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPreviewDur(null);
      const patch = trimOutPatch(clip, latest);
      if (patch) await p.onEditClip(patch);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p]);

  /** 拖左边缘：晚点开始放（左边缘右移 + 变短）；往左拖则把剪掉的开头还回来。 */
  const beginTrimInNonShot = useCallback((e: React.MouseEvent, clip: Clip) => {
    if (!canDrag(clip)) return;
    e.preventDefault(); e.stopPropagation();
    // 上下限一次算清（**含负数余量** —— 左边缘不是单向阀，理由见
    // clipEdit.ts 的 trimInDeltaBounds），预览与写回共用同一组数，
    // 否则拖得动的范围和存得下的范围会差一截，表现为"松手弹回去"。
    const db = trimInDeltaBounds(clip);
    const startX = e.clientX;
    const startSec = clip.startSec;
    let latestDelta = 0;
    setPreviewDur({ id: clip.id, sec: clip.durationSec });
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: MouseEvent) => {
      const raw = (ev.clientX - startX) / pxPerSec;
      const d = quantizeSec(Math.max(db.min, Math.min(db.max, raw)));
      if (d === latestDelta) return;
      latestDelta = d;
      // 预览要同时表达"变短"和"右移"，否则松手前后画面会跳一下
      setPreviewDur({ id: clip.id, sec: clip.durationSec - d });
      setOverlayDrag({ clipId: clip.id, startSec: startSec + d });
    };
    const onUp = async () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPreviewDur(null); setOverlayDrag(null);
      const patch = trimInPatch(clip, latestDelta);
      if (patch) await p.onEditClip(patch);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p]);

  /** 拖整段：改锚点（第几镜 + 镜内偏移）。换算交给 App，见 onMoveClip。 */
  const beginMoveNonShot = useCallback((e: React.MouseEvent, clip: Clip) => {
    if (!canDrag(clip)) return;
    const startX = e.clientX;
    const startSec = clip.startSec;
    let latestSec = startSec;
    document.body.style.cursor = "grabbing";
    const st0 = useTimelineStore.getState();
    const snapPts = st0.snapping
      ? collectSnapPoints(st0.timeline, st0.playheadSec, st0.cursorSec, clip.id)
      : [];
    const onMove = (ev: MouseEvent) => {
      const raw = Math.max(0, startSec + (ev.clientX - startX) / pxPerSec);
      const r = snapPts.length
        ? snapRange(raw, clip.durationSec, snapPts, pxPerSec)
        : { sec: raw, hit: null };
      useTimelineStore.getState().setSnapGuide(r.hit ? r.hit.sec : null);
      if (Math.abs(r.sec - latestSec) < 0.02) return;
      latestSec = r.sec;
      setOverlayDrag({ clipId: clip.id, startSec: r.sec });
    };
    const onUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setOverlayDrag(null);
      useTimelineStore.getState().setSnapGuide(null);
      if (Math.abs(latestSec - startSec) < 0.05) return;
      p.onMoveClip(clip, latestSec);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p]);

  const beginTrim = useCallback((e: React.MouseEvent, clip: Clip) => {
    // 7.2：折叠标记（停用镜头）不参与修剪 —— 它的 durationSec 已经是 0，
    // 让它进来只会拿 0 当起点算出一堆负数。ClipView 也不给它渲染手柄，
    // 这里是第二道闸（键盘/程序触发的路径不经过 DOM）。
    if (clip.collapsedIndex !== undefined) return;
    // 6.9：音频/字幕走各自的时长上下限（`clipEdit.ts`），**不能**共用下面
    // 镜头那套 MIN_CLIP_SEC/maxClipSec —— 那是"AI 一次能生成多长"的业务约束，
    // 拿它去卡一段 3 分钟的背景音乐就会夹成 15 秒（本条目被推迟时记下的原坑）。
    if (clip.entity !== "shot") { beginTrimNonShot(e, clip); return; }
    if (!clip.shotId) return;
    e.preventDefault(); e.stopPropagation();
    const shotId = clip.shotId;
    const win = winOf(clip);
    const startSec = clip.durationSec;
    const startX = e.clientX;
    const minSec = minTrimSec(win, MIN_CLIP_SEC);
    let latest = quantizeSec(startSec);
    setPreviewDur({ id: clip.id, sec: latest });
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) / pxPerSec;
      const maxSec = p.maxClipSec ?? MAX_CLIP_SEC_FALLBACK;
      const next = trimOut(startSec, delta, minSec, maxSec);
      if (next === latest) return;
      latest = next;
      setPreviewDur({ id: clip.id, sec: next });
    };
    const onUp = async () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPreviewDur(null);
      // 与量化后的起始值比：拖了几像素但没跨过 0.1s 的格子时不该发请求
      const old = quantizeSec(startSec);
      if (latest === old) return;
      // ⚠️ 这里**不要**再 onPushUndo：onPatch 就是 App 的 patchTimeline，
      // 它内部已按 durationSec/toOrder/disabled 三类各自入栈，且带正确的 redo。
      // 两边都推的话，一次拖动进两条栈，Ctrl+Z 要按两下才回到原状，
      // 而且这边推的那条没有 redo（会弹"暂不支持重做"）。
      //
      // 3.1：改出点也要同步窗口长度——被分割过的镜头，导出读的是
      // clip_dur_sec，只改 duration_sec 会出现"轨上变短了、成片没变"。
      await p.onPatch(shotId, outPatch(win, latest));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p]);

  /** 3.1：拖**左边缘**修剪入点（出点钉死，掐掉素材开头的一段）。
   *
   *  与拖右边缘的两处关键差别：
   *  ① 时间轴是无缝顺排的，所以左边缘**不会移动** —— 这一格只是变窄，
   *     后面的镜头整体前移。用户看到的是宽度变化，不是位置变化。
   *  ② 只对**已有素材**的镜头开放（canTrimIn）：未出片的镜头没有"素材开头"，
   *     给它设入点只会让 duration_sec 不再是生成目标。 */
  const beginTrimIn = useCallback((e: React.MouseEvent, clip: Clip) => {
    // 7.2：折叠标记（停用镜头）不参与修剪 —— 它的 durationSec 已经是 0，
    // 让它进来只会拿 0 当起点算出一堆负数。ClipView 也不给它渲染手柄，
    // 这里是第二道闸（键盘/程序触发的路径不经过 DOM）。
    if (clip.collapsedIndex !== undefined) return;
    // 6.9：音频/字幕拖左边缘是**左边缘真的右移**（晚点开始放），
    // 与镜头"原地变窄、后面整体前移"是相反的两件事，故完全分开处理。
    if (clip.entity !== "shot") { beginTrimInNonShot(e, clip); return; }
    if (!clip.shotId) return;
    const win = winOf(clip);
    if (!canTrimIn(win)) return;
    e.preventDefault(); e.stopPropagation();
    const shotId = clip.shotId;
    const startIn = inPointOf(win);
    const outSec = outPointOf(win);   // 全程不变，这正是"修剪入点"的定义
    const startX = e.clientX;
    const minSec = minTrimSec(win, MIN_CLIP_SEC);
    const maxSec = p.maxClipSec ?? MAX_CLIP_SEC_FALLBACK;
    let latest = { inSec: quantizeSec(startIn), durSec: clip.durationSec };
    setPreviewDur({ id: clip.id, sec: latest.durSec, inSec: latest.inSec });
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) / pxPerSec;
      const next = trimIn(startIn, outSec, delta, minSec, maxSec);
      if (next.inSec === latest.inSec) return;
      latest = next;
      setPreviewDur({ id: clip.id, sec: next.durSec, inSec: next.inSec });
    };
    const onUp = async () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPreviewDur(null);
      if (latest.inSec === quantizeSec(startIn)) return;
      await p.onPatch(shotId, inPatch(latest.inSec, latest.durSec));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p]);

  // ---- move drag（改镜头顺序）----
  // 同 trim：落点走局部变量而非 state，避免闭包读到旧值。
  // 换位阈值取「一个镜头槽宽」：拖过半个槽才算跨一位，手抖不会误改顺序。
  const beginMove = useCallback((e: React.MouseEvent, clip: Clip) => {
    // 6.9：音频/字幕是**按绝对时间自由拖**（改锚点），不是换 order。
    // 与叠加层同构，但落点要换算成「第几镜 + 镜内偏移」，见 onMoveClip。
    if (clip.entity !== "shot") { beginMoveNonShot(e, clip); return; }
    if (!clip.shotId) return;

    // 叠加层：按**绝对时间**自由拖动，不是换 order。
    // 主轨的拖动语义是"排到第几位"，叠加层的语义是"盖在第几秒"——
    // 两者不能共用一套逻辑，否则拖叠加层会把主轨顺序搅乱。
    const shotOfClip = p.shots.find((s) => s.id === clip.shotId);
    if ((shotOfClip?.track_index ?? 0) > 0) {
      const shotId0 = clip.shotId;
      const startX0 = e.clientX;
      const startSec0 = clip.startSec;
      let latestSec = startSec0;
      document.body.style.cursor = "grabbing";
      // 吸附点在拖动开始时算一次即可：拖的过程中时间轴本身不变，
      // 每次 mousemove 重算是白烧 CPU（170 镜项目每帧遍历上千个 clip）。
      const st0 = useTimelineStore.getState();
      const snapPts = st0.snapping
        ? collectSnapPoints(st0.timeline, st0.playheadSec, st0.cursorSec, clip.id)
        : [];
      const onMove0 = (ev: MouseEvent) => {
        const raw = Math.max(0, startSec0 + (ev.clientX - startX0) / pxPerSec);
        const r = snapPts.length
          ? snapRange(raw, clip.durationSec, snapPts, pxPerSec)
          : { sec: raw, hit: null };
        const next = r.sec;
        useTimelineStore.getState().setSnapGuide(r.hit ? r.hit.sec : null);
        if (Math.abs(next - latestSec) < 0.02) return;
        latestSec = next;
        setOverlayDrag({ clipId: clip.id, startSec: next });
      };
      const onUp0 = async () => {
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove0);
        window.removeEventListener("mouseup", onUp0);
        setOverlayDrag(null);
        useTimelineStore.getState().setSnapGuide(null);
        if (Math.abs(latestSec - startSec0) < 0.05) return;
        p.onMoveTrack(shotId0, shotOfClip?.track_index ?? 1, latestSec);
      };
      window.addEventListener("mousemove", onMove0);
      window.addEventListener("mouseup", onUp0);
      return;
    }

    if (!clip.shotOrder) return;
    const shotId = clip.shotId;
    const startOrder = clip.shotOrder;
    const startX = e.clientX;
    const slotPx = Math.max(24, clip.durationSec * pxPerSec);
    let latest = startOrder;
    const maxOrder = p.shots.length;
    setMove({ clipId: clip.id, shotId, startX, startOrder, overOrder: startOrder });
    document.body.style.cursor = "grabbing";
    const onMove = (ev: MouseEvent) => {
      const orderDelta = Math.round((ev.clientX - startX) / slotPx);
      const next = Math.max(1, Math.min(maxOrder, startOrder + orderDelta));
      if (next === latest) return;
      latest = next;
      setMove((m) => (m ? { ...m, overOrder: next } : null));
      setPreviewOrder({ id: clip.id, order: next });
    };
    const onUp = async () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setMove(null); setPreviewOrder(null);
      if (latest === startOrder) return;
      // 同 trim：入栈由 onPatch(=patchTimeline) 统一负责，这里再推一次会重复。
      await p.onPatch(shotId, { toOrder: latest });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p]);

  // ---- 框选（3.8：跨轨）----
  // 轨道空白处拖出一个**时间 × 轨道**的矩形，落在里面的可操作 clip 全部选中。
  //
  // 纵向命中靠的是各 lane 在**按下那一刻**的屏幕矩形（`data-track-id`）：
  // 折叠轨没有 lane、资产轨是另一种 lane（无 data-track-id），两者天然不参与，
  // 不需要在这里再写一遍"哪些轨能选"的规则。
  //
  // 矩形只量一次、之后靠滚动增量校正：mousemove 每秒几十次，每次对十几条 lane
  // 调 getBoundingClientRect 会强制同步布局。而拖动中容器是可能滚的（拖到边缘、
  // 或用户同时滚轮），所以把按下时的 scrollLeft/Top 一起记下，之后用增量把
  // 指针坐标换算回"按下那一刻的坐标系"——比重新量便宜，且是精确的。
  const beginMarquee = useCallback((e: React.MouseEvent) => {
    const lanes = [...document.querySelectorAll<HTMLElement>(".fw-tl-lane[data-track-id]")]
      .map((el) => ({ id: el.dataset.trackId!, r: el.getBoundingClientRect() }));
    const self = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sc = scrollRef.current;
    const s0 = { left: sc?.scrollLeft ?? 0, top: sc?.scrollTop ?? 0 };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const startSec = Math.max(0, (x0 - self.left) / pxPerSec);
    let moved = false;
    let latest = { fromSec: startSec, toSec: startSec, trackIds: [] as string[] };

    /** 把当前指针位置换算进"按下那一刻"的坐标系（抵消拖动期间的滚动） */
    const frozen = (ev: MouseEvent) => ({
      x: ev.clientX + ((sc?.scrollLeft ?? 0) - s0.left),
      y: ev.clientY + ((sc?.scrollTop ?? 0) - s0.top),
    });

    const onMove = (ev: MouseEvent) => {
      const q = frozen(ev);
      const sec = Math.max(0, (q.x - self.left) / pxPerSec);
      // 纵向也算进"有没有真的拖"：只往下拖不横move 时时间区间是零宽、
      // 一个也选不中，若不算作拖动就会静默返回，用户分不清是没选中还是坏了
      if (Math.abs(q.x - x0) > 3 || Math.abs(q.y - y0) > 3) moved = true;
      const ylo = Math.min(y0, q.y);
      const yhi = Math.max(y0, q.y);
      latest = {
        fromSec: Math.min(startSec, sec),
        toSec: Math.max(startSec, sec),
        trackIds: lanes.filter((l) => l.r.top <= yhi && l.r.bottom >= ylo).map((l) => l.id),
      };
      setMarquee(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setMarquee(null);
      if (!moved) return;
      // 3.5：命中判据统一在 selection.ts（与 Ctrl+A / [ ] / Shift 范围同一条）。
      // 锁定/隐藏轨、以及没有 shotId 的音频/字幕段不再进选中集 ——
      // 它们进来也只是亮着而已，Delete/复制/剪切一个都动不了。
      const hit = rectIds(useTimelineStore.getState().timeline.tracks,
                          latest.fromSec, latest.toSec, latest.trackIds);
      if (hit.length) {
        useTimelineStore.getState().selectClips(hit);
        p.onToast(`已选中 ${hit.length} 个片段`);
      } else {
        // 旧实现在这里静默返回：用户在音频轨上拖了半天框，松手什么也没有，
        // 分不清是"没选中"还是"框选坏了"。
        p.onToast("框选范围内没有可操作的片段");
      }
    };
    // 起手那一刻先画出零宽的框并把起始轨算进去，否则纯横拖的第一帧之前没有反馈
    onMove(e.nativeEvent);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p]);

  /** 删除当前选中的全部片段 —— 与 Delete 键**同一个实现**（见 `onRemoveSelected`）。 */
  const deleteSelected = useCallback(() => p.onRemoveSelected(), [p]);

  // ---- playhead absolute px ----
  const playheadLeft = store.playheadSec * pxPerSec;

  // ---- cursor absolute px (null = hidden) ----
  const cursorLeft = p.cursor
    ? ((offsetMap.get(p.cursor.order) ?? 0) + p.cursor.offsetSec) * pxPerSec
    : null;

  // ---- ruler scrub / cursor → 定位 ----
  //
  // 3.4：scrub 不再自己把秒换算成「哪个镜头的第几秒」再 seek，而是把**绝对秒**
  // 交给 App 的 `movePlayheadTo` —— 与方向键 / Home / End / J-K-L 同一条通路。
  // 各写一套的老问题在 3.3 的注释里记过：曾经三套累加算法并存，
  // 同一个 x 坐标竖线画在一处、跳到的却是另一镜。
  //
  // 定位线仍走 secToPosition（它存的就是 (order, offset) 锚点，不是绝对秒）。
  /** `p.onScrub` 每次渲染都是新函数，而 scrubber 只建一次。用 ref 转一道，
   *  scrubber 才能永远调到最新的那个 —— 否则拖动期间来一次 refreshDetail，
   *  之后每一帧都按旧的 detail 算落点。 */
  const scrubRef = useRef(p.onScrub);
  scrubRef.current = p.onScrub;
  const scrubber = useRef<Scrubber | null>(null);
  if (!scrubber.current) {
    // 惰性建：写成 useRef(createScrubber(…)) 的话每次渲染都会白建一个再扔掉
    scrubber.current = createScrubber({
      emit: (sec, phase) => scrubRef.current(sec, phase),
    });
  }
  useEffect(() => {
    const s = scrubber.current;
    return () => s?.dispose();
  }, []);

  const onRulerCursor = (sec: number) => {
    const pos = secToPosition(p.shots, sec);
    if (pos) p.onSetCursor(pos);
  };

  // ---- context menu items ----

  /**
   * 音频/字幕段的右键菜单（6.9）。
   *
   * ⚠️ **不能**共用下面那份镜头菜单。那 11 项里有 10 项的 `disabled` 判据是
   * `!clip.shotId` —— 音频段一律没有 shotId，于是右键出来的是一整屏灰掉的
   * 「重新生成 / 精品升级 / 版本历史 / 移到叠加层 / 停用镜头…」。
   * 这比没有菜单更糟：它把"这里能做的事"整个藏在了一堆做不了的事后面，
   * 用户还要逐条试才知道哪条能点。这里只列真的能做的三件事。
   *
   * 「复制」也不在其中：粘贴只会插镜头（`App.tsx` doPaste），
   * 音频复制了粘不回来，理由与 `selection.ts` 文件头 6.9 一节同源。
   */
  const otherMenuItems = (clip: Clip): MenuItem[] => {
    const name = clip.entity === "audio" ? "音频" : "字幕";
    return [
      { id: "playhead", label: "播放头移到此处", icon: <Crosshair size={12} />,
        onClick: () => store.setPlayheadSec(clip.startSec) },
      // 只有音频有窗口可还原。字幕的 duration 就是时长，没有"原长"这回事。
      { id: "untrim", label: "还原修剪（用回整段素材）", icon: <RotateCcw size={12} />,
        disabled: !hasTrim(clip),
        onClick: async () => {
          const patch = clearTrimPatch(clip);
          if (patch) await p.onEditClip(patch);
        } },
      { id: "sep1", label: "", separator: true },
      // 说「可撤销」是因为它真的可撤销（App.deleteTimelineClip 会重建），
      // 与镜头那条「删除（不可撤销）」是两回事，不能照抄措辞。
      { id: "delete", label: `从时间轴移除${name}段（可撤销）`,
        icon: <Trash2 size={12} />, danger: true,
        disabled: !canDeleteFromTimeline(clip),
        onClick: () => p.onDeleteClip(clip) },
    ];
  };

  const clipMenuItems = (clip: Clip): MenuItem[] => {
    if (clip.entity !== "shot") return otherMenuItems(clip);
    const shot = p.shots.find((s) => s.id === clip.shotId);
    const isOverlay = (shot?.track_index ?? 0) > 0;
    return [
      { id: "regen", label: "重新生成", icon: <RefreshCw size={12} />,
        disabled: !clip.shotId, onClick: () => clip.shotId && p.onRegenerate([clip.shotId]) },
      { id: "upgrade", label: "精品升级", icon: <Gem size={12} />,
        disabled: !shot, onClick: () => shot && p.onUpgrade(shot) },
      { id: "versions", label: "版本历史", icon: <History size={12} />,
        disabled: !shot, onClick: () => shot && p.onShowVersions(shot) },
      { id: "sep1", label: "", separator: true },
      { id: "copy", label: "复制", icon: <Copy size={12} />, keys: "Ctrl+C",
        onClick: () => { store.copySelection(); } },
      { id: "duplicate", label: "复制一份到叠加层", icon: <CopyPlus size={12} />,
        // 复制一份 = 把同一镜再放一份到叠加层，用于做画中画/闪回。
        // 主轨不能有两个同 order 的镜头，所以只能往叠加层放。
        disabled: !clip.shotId || isOverlay,
        onClick: () => clip.shotId
          && p.onMoveTrack(clip.shotId, 1, store.playheadSec) },
      // 静音存在 transform_meta.muted（不是 ShotInfo 顶层字段）——
      // 它属于"这一镜怎么渲染"，和 speed/volume/调色同层
      { id: "mute", label: shot?.transform_meta?.muted ? "取消静音" : "静音",
        icon: <VolumeX size={12} />, disabled: !clip.shotId,
        // 必须在已有 transform_meta 上合并再提交 —— 后端是整体替换，
        // 只发 {muted} 会把该镜的缩放/变速/调色/LUT/特效全部抹掉。
        onClick: () => clip.shotId && p.onPatchTransform(clip.shotId,
          { ...(shot?.transform_meta ?? {}), muted: !shot?.transform_meta?.muted }) },
      { id: "locate", label: "在镜头列表中定位", icon: <Crosshair size={12} />,
        disabled: !shot, onClick: () => shot && p.onSelectShot(shot) },
      { id: "split", label: "在播放头处分割", icon: <ScissorsIcon size={12} />, keys: "Ctrl+B",
        // 播放头必须落在本 clip 内部才有切点可言
        disabled: !clip.shotId
          || store.playheadSec <= clip.startSec + 0.5
          || store.playheadSec >= clip.startSec + clip.durationSec - 0.5,
        onClick: () => clip.shotId
          && p.onSplit(clip.shotId, store.playheadSec - clip.startSec) },
      { id: "sep2", label: "", separator: true },
      // Render V2 多轨：主轨 ↔ 叠加层互移。
      // 移到叠加层时用当前播放头作为起点——用户刚在那儿看画面，
      // 那就是他想让这段叠上去的位置。
      { id: "toOverlay", label: isOverlay ? "移回主轨" : "移到叠加层",
        icon: <Layers size={12} />,
        disabled: !clip.shotId,
        onClick: () => {
          if (!clip.shotId) return;
          p.onMoveTrack(clip.shotId, isOverlay ? 0 : 1,
                        isOverlay ? undefined : store.playheadSec);
        } },
      { id: "disable", label: clip.disabled ? "启用镜头" : "停用镜头",
        icon: clip.disabled ? <Eye size={12} /> : <EyeOff size={12} />,
        onClick: async () => {
          if (!clip.shotId) return;
          await p.onPatch(clip.shotId, { disabled: !clip.disabled });
        },
        disabled: !clip.shotId },
      // P2-7 留黑：**紧挨着「停用」**是刻意的 —— 这两项是整份菜单里最容易混的一对，
      // 排在一起用户才能在同一屏里读出差别：停用把这一镜从成片里抽掉（不占时间），
      // 留黑只是不给看画面（时长、声音、字幕全照旧）。
      //
      // 写通路也不同，别照抄上面那条：`disabled` 是 ShotInfo 顶层字段走 onPatch，
      // 留黑存在 `transform_meta` 里（与「静音」同层），必须走 onPatchTransform ——
      // 后者才带乐观锁与撤销栈（App 的 stagedTransform → commitTransform）。
      { id: "blackout", label: shot?.transform_meta?.blackout ? "取消留黑" : "留黑（只黑画面）",
        icon: <Square size={12} fill="currentColor" />,
        disabled: !clip.shotId,
        onClick: () => {
          if (!clip.shotId) return;
          // 与「静音」同款纪律：必须在已有 transform_meta 上合并再提交 ——
          // 后端是整体替换，只发 { blackout } 会把该镜的缩放/变速/调色/特效全抹掉。
          const next: Record<string, unknown> = { ...(shot?.transform_meta ?? {}) };
          if (next.blackout) {
            // 取消时**删键**，不写 `false`：`describeTransform` 判的是"字段在不在"
            // 而不是"值真不真"，留一个 blackout:false 会让此后每一次画面调整的
            // 撤销标签都平白多出一句「留黑」。
            delete next.blackout;
          } else {
            next.blackout = true;
          }
          p.onPatchTransform(clip.shotId, next);
        } },
      { id: "delete", label: clip.isSpecial ? "从轨道删除" : "删除（不可撤销）",
        icon: <Trash2 size={12} />, danger: true,
        disabled: !clip.shotId || (!clip.isSpecial && !shot?.disabled),
        onClick: async () => { if (clip.shotId) await p.onDeleteShot(clip.shotId); } },
    ];
  };

  return (
    <div className={`fw-tl ${p.maximized ? "maximized" : ""}`}>
      {/* ---- 工具条 ---- */}
      <div className="fw-tl-toolbar">
        <button className="fw-tl-tbtn" title="适配全宽 (Ctrl+0)"
          onClick={() => scrollRef.current && store.fitTo(scrollRef.current.clientWidth - GUTTER_W)}>
          <Maximize2 size={13} />
        </button>
        <button className="fw-tl-tbtn" title="放大 (Ctrl+=)"
          onClick={() => store.zoomBy(1.25)} disabled={pxPerSec >= ZOOM_MAX}>
          <ZoomIn size={13} />
        </button>
        <button className="fw-tl-tbtn" title="缩小 (Ctrl+-)"
          onClick={() => store.zoomBy(0.8)} disabled={pxPerSec <= ZOOM_MIN}>
          <ZoomOut size={13} />
        </button>
        <span className="fw-tl-zoom">{pxPerSec.toFixed(0)}px/s</span>
        <div className="fw-tl-tb-sep" />

        {/* ---- 工具模式（参考剪映：切了保持，不自动回退）---- */}
        <button className={`fw-tl-tbtn ${store.tool === "select" ? "on" : ""}`}
          title="选择工具 (A)：拖动 / 调整边界 / 多选"
          onClick={() => store.setTool("select")}>
          <MousePointer2 size={13} />
        </button>
        <button className={`fw-tl-tbtn ${store.tool === "split" ? "on" : ""}`}
          title="分割工具 (B)：点击镜头上任意位置切开"
          onClick={() => store.setTool("split")}>
          <Scissors size={13} />
        </button>
        <div className="fw-tl-tb-sep" />

        <button className="fw-tl-tbtn" title="撤销 (Ctrl+Z)"
          disabled={!store.undoStack.length} onClick={() => store.undo()}>
          <Undo2 size={13} />
        </button>
        <button className="fw-tl-tbtn" title="重做 (Ctrl+Y)"
          disabled={!store.redoStack.length} onClick={() => store.redo()}>
          <Redo2 size={13} />
        </button>
        <div className="fw-tl-tb-sep" />

        {/* ---- 左右全选：以播放头为界 ---- */}
        <button className="fw-tl-tbtn" title="选中播放头左侧全部镜头 ([)"
          onClick={() => p.onSelectSide("left")}>
          <ChevronsLeft size={13} />
        </button>
        <button className="fw-tl-tbtn" title="选中播放头右侧全部镜头 (])"
          onClick={() => p.onSelectSide("right")}>
          <ChevronsRight size={13} />
        </button>
        <button className="fw-tl-tbtn danger" title="删除选中 (Delete)"
          disabled={!store.selection.clipIds.length}
          onClick={() => deleteSelected()}>
          <Trash2 size={13} />
        </button>
        <div className="fw-tl-tb-sep" />

        <button className={`fw-tl-tbtn ${store.snapping ? "on" : ""}`}
          title={store.snapping ? "吸附已开启（拖动时贴齐镜头边界/播放头）" : "吸附已关闭"}
          onClick={() => store.toggleSnapping()}>
          <Magnet size={13} />
        </button>

        <div className="fw-tl-tb-spacer" />
        {/* 拖拽中的实时读数：trim/move 过程中让用户看到落点，不用等松手 */}
        {previewDur && (
          <span className="fw-tl-live" title="松手后提交">
            时长 {previewDur.sec.toFixed(1)}s
            {/* 修剪入点时同时报"从素材第几秒起"——只看时长的话，用户
                分不清自己是在掐开头还是在改结尾（两者都让格子变窄） */}
            {previewDur.inSec !== undefined && ` · 入点 ${previewDur.inSec.toFixed(1)}s`}
          </span>
        )}
        {move && previewOrder && previewOrder.order !== move.startOrder && (
          <span className="fw-tl-live" title="松手后提交">
            #{move.startOrder} → #{previewOrder.order}
          </span>
        )}
        <span className="fw-tl-summary" title="可导出段数 · 总时长">
          {p.exportCount} 段 · {Math.floor(p.totalSec / 60)}:{String(Math.round(p.totalSec % 60)).padStart(2, "0")}
        </span>
        {/* 3.6：有转场就把「成片会比时间轴短多少」摆出来。
            总时长本身**不折叠**（折叠要动播放头/吸附/字幕锚点一整套绝对秒，
            而导出侧的音频锚点眼下也没折叠，见 transitions.ts 文件头），
            所以差值单独显示，不去改上面那个数——两个本该相等的数字打架，
            比一个偏长的数字更让人不知道该信谁。 */}
        {seamInfo && (
          <span className={`fw-tl-seamsum${seams.some((s) => s.state !== "ok") ? " bad" : ""}`}
            title={seamInfo.title}>
            <Shuffle size={11} /> {seamInfo.text}
          </span>
        )}
        <button className="fw-tl-tbtn" title={p.maximized ? "还原 (Esc)" : "最大化时间轴"}
          onClick={p.onToggleMax}>
          <Maximize2 size={13} />
        </button>
      </div>

      {/* ---- 滚动区 ---- */}
      <div className="fw-tl-scroll" ref={scrollRef}>
        {/* 刻度尺（sticky top，跟随横向滚动） */}
        <TimelineRuler
          totalSec={p.totalSec} pxPerSec={pxPerSec}
          gutterW={GUTTER_W}
          span={span}
          onScrubStart={(s) => scrubber.current?.start(s)}
          onScrubMove={(s) => scrubber.current?.move(s)}
          onScrubEnd={() => scrubber.current?.end()}
          onPlaceCursor={onRulerCursor} />

        {/* 轨道列表 */}
        {tl.tracks.map((track) => {
          const itemCount = track.clips.length + track.assetSegments.length;
          const assetKind: AssetTrackKind | null =
            track.kind === "asset-char" ? "character"
              : track.kind === "asset-loc" ? "location"
                : track.kind === "asset-ref" ? "reference" : null;

          // 资产轨行数不定（每角色一行），高度按行数算而不是固定值
          const assetRows = assetKind === "character"
            ? new Set((p.stages ?? []).filter((s) => s.present_orders?.length)
                .map((s) => s.character_name)).size
            : assetKind === "location"
              ? (p.locations ?? []).filter((l) => l.present_orders?.length).length
              : (p.assets ?? []).filter((a) => a.kind === "custom").length;
          // 22px：字号 10→11 后 20px 会把文字挤到贴边
          const ASSET_ROW_H = 22;
          const trackH = assetKind
            ? Math.max(ASSET_ROW_H, assetRows * ASSET_ROW_H)
            : track.height;

          return (
            <div key={track.id} className={`fw-tl-track ${track.hidden ? "hidden" : ""}`}
              data-track-kind={track.kind}
              style={{ height: track.collapsed ? 18 : trackH }}>
              <TrackHeader
                track={track} width={GUTTER_W} itemCount={itemCount}
                onToggleLock={() => store.toggleTrackLock(track.id)}
                onToggleHidden={() => store.toggleTrackHidden(track.id)}
                onToggleMuted={() => store.toggleTrackMuted(track.id)}
                onToggleSolo={() => store.toggleTrackSolo(track.id)}
                onToggleCollapsed={() => store.toggleTrackCollapsed(track.id)} />

              {/* 资产轨：Phase 5 完整交互（拖入注入 / 拖边缘改范围 / 右键菜单） */}
              {!track.collapsed && assetKind && (
                <div className="fw-tl-lane fw-tl-lane-asset" style={{ width: totalWidth }}>
                  <AssetTrack
                    kind={assetKind}
                    shots={p.shots}
                    stages={p.stages ?? []}
                    locations={p.locations ?? []}
                    assets={p.assets ?? []}
                    projectId={p.projectId}
                    pxPerSec={pxPerSec}
                    offsetMap={offsetMap}
                    span={span}
                    cursorOrder={p.cursor?.order ?? null}
                    rowHeight={ASSET_ROW_H}
                    onChanged={p.onAssetsChanged}
                    onPushUndo={p.onPushUndo}
                    onToast={p.onToast}
                    /* 选中资产段与选中片段互斥（原先靠 editorStore 那对 setter
                       互相置 null 来保证，3.5 收敛后由这里显式清） */
                    onSelectRun={(run) => { p.onSelectAssetRun(run); store.clearSelection(); }}
                    onRegenerate={p.onRegenerate}
                    selectedRunId={p.selectedAssetRunId} />
                </div>
              )}

              {/* 普通轨：Clip 内容区 */}
              {!track.collapsed && !assetKind && (
                <div className={`fw-tl-lane${dropHot ? " drop-hot" : ""}`}
                  data-track-id={track.id}
                  style={{ width: totalWidth }}
                  onDragOver={(e) => {
                    // 必须 preventDefault，否则浏览器默认拒绝放置、onDrop 不触发
                    if (!p.onDropClip) return;
                    if (!e.dataTransfer.types.includes("application/x-fw-clip")) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    if (!dropHot) setDropHot(true);
                  }}
                  onDragLeave={() => setDropHot(false)}
                  onDrop={(e) => {
                    setDropHot(false);
                    if (!p.onDropClip) return;
                    const raw = e.dataTransfer.getData("application/x-fw-clip");
                    if (!raw) return;
                    e.preventDefault();
                    try {
                      p.onDropClip(JSON.parse(raw));
                    } catch {
                      /* 数据损坏就当没拖过，不该因此报错打断用户 */
                    }
                  }}
                  onMouseDown={(e) => {
                    // 空白处按下 = 框选起手（点在 Clip 上则交给 Clip 处理）
                    if (e.button !== 0) return;
                    if ((e.target as HTMLElement).closest(".fw-clip")) return;
                    beginMarquee(e);
                  }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest(".fw-clip")) return;
                    store.clearSelection();
                  }}>
                  {/* 框选浮层：每条被覆盖的 lane 各画一条，纵向拼成一个带子。
                      锁定/隐藏轨上画成虚线灰条 —— 框确实扫过了它，但那儿一个也
                      选不中；直接不画会让用户以为拖歪了，画成实心又是在撒谎。
                      ⚠️ 宽度兜底 2px：纯纵向拖（时间区间零宽）**照样会选中**
                      跨过那一瞬间的片段（判据是 start < t < end，见 rectIds），
                      旧的 `toSec > fromSec` 条件会让这种情况选中了却什么都不画。 */}
                  {marquee && marquee.trackIds.includes(track.id) && (
                    <div className={`fw-tl-marquee${
                      track.locked || track.hidden ? " fw-tl-marquee-off" : ""}`}
                      style={{ left: marquee.fromSec * pxPerSec,
                               width: Math.max(2,
                                 (marquee.toSec - marquee.fromSec) * pxPerSec) }} />
                  )}
                  {/* 3.10：只渲染视口（+overscan）内的片段。lane 的 width 仍是
                      满宽 totalWidth —— 3.3 的跟随滚动读 `el.scrollWidth`，
                      宽度一塌滚动条和落点跟着塌。 */}
                  {visibleClips(track.clips, pxPerSec, span, keepIds).map((clip) => {
                    const isDragging = move?.clipId === clip.id;
                    const isDropTarget = move !== null && !isDragging
                      && clip.shotOrder === (previewOrder?.order ?? move?.overOrder);
                    const previewStart = overlayDrag?.clipId === clip.id
                      ? overlayDrag.startSec
                      : isDragging && previewOrder
                        ? (offsetMap.get(previewOrder.order) ?? clip.startSec)
                        : undefined;
                    const previewD = previewDur?.id === clip.id ? previewDur.sec : undefined;
                    return (
                      <ClipView key={clip.id} clip={clip} pxPerSec={pxPerSec}
                        variant={
                          track.kind === "subtitle" ? "subtitle"
                            : (track.kind === "voice" || track.kind === "audio"
                               || track.kind === "music") ? "audio" : "video"}
                        height={trackH}
                        selected={store.isClipSelected(clip.id)}
                        maxDurSec={p.maxClipSec ?? MAX_CLIP_SEC_FALLBACK}
                        previewStartSec={previewStart}
                        previewDurationSec={previewD}
                        dragging={isDragging}
                        dropTarget={!!isDropTarget}
                        trackLocked={track.locked}
                        splitMode={store.tool === "split"}
                        onSelect={(e) => {
                          // 分割工具：点哪切哪。用点击位置换算成镜内偏移，
                          // 不是用播放头——用户点的位置就是他想切的位置。
                          if (store.tool === "split" && clip.shotId && !track.locked) {
                            const lane = (e.currentTarget as HTMLElement)
                              .closest(".fw-tl-lane") as HTMLElement | null;
                            if (lane) {
                              const atSec = (e.clientX - lane.getBoundingClientRect().left)
                                / pxPerSec - clip.startSec;
                              // 太靠边的切点会切出 0 长度片段，后端也会拒绝
                              if (atSec > 0.3 && atSec < clip.durationSec - 0.3) {
                                p.onSplit(clip.shotId, atSec);
                              } else {
                                p.onToast("切点太靠近边缘，请点镜头中间位置");
                              }
                            }
                            return;
                          }
                          // 3.8：Shift 与 Ctrl/Cmd 从此**分工不同**。
                          // 此前两者都是"逐个加减"，Shift 的范围语义无处可去，
                          // 想选第 12~40 镜只能点 29 下（还不能点错）。
                          // 现在：Ctrl/Cmd = 逐个加减，Shift = 从锚点到这里的
                          // 整个范围，Ctrl+Shift = 把这个范围并进已选中的。
                          const toggle = e.ctrlKey || e.metaKey;
                          if (e.shiftKey) {
                            const st = useTimelineStore.getState();
                            const r = rangeIds(st.timeline.tracks,
                                               st.selectionAnchor, clip.id);
                            if (r.ok) {
                              const ids = toggle
                                ? [...new Set([...st.selection.clipIds, ...r.ids])]
                                : r.ids;
                              // 锚点显式原样传回：范围要能反复调整（点远一点变大、
                              // 点近一点变小），锚点跟着走就只会越滚越大
                              st.selectClips(ids, st.selectionAnchor);
                              p.onToast(`已选中 ${ids.length} 个片段`);
                              return;   // 与加选同理：不换预览源
                            }
                            // 三种失败各说各的话，然后**落回单选** ——
                            // 按住 Shift 点了一下却什么都没发生是最糟的结果
                            p.onToast(RANGE_HINT[r.reason]);
                          }
                          const additive = toggle;
                          store.selectClip(clip.id, additive);
                          // 3.5：加选**不换预览源**。Ctrl+click 第 5 镜是在
                          // 攒一个批量操作的集合，不是"我要看这一镜"——
                          // 让播放器跟着跳会把用户正在看的画面顶掉，且
                          // onSelectShot 会驱动上面那个 effect 把加选清成单选。
                          if (additive) return;
                          p.onSelectAssetRun(null);
                          const shot = p.shots.find((s) => s.id === clip.shotId);
                          if (shot) p.onSelectShot(shot);
                        }}
                        onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, clip }); }}
                        onBeginMove={(e) => beginMove(e, clip)}
                        onBeginTrim={(e) => beginTrim(e, clip)}
                        onBeginTrimIn={(e) => beginTrimIn(e, clip)}
                        onDoubleClick={() => {
                          const shot = p.shots.find((s) => s.id === clip.shotId);
                          if (shot) p.onSelectShot(shot);
                        }} />
                    );
                  })}
                  {/* 3.6 转场：画在主轨接缝上。放在 clips 之后 = 叠在上面，
                      否则会被相邻两格盖住（接缝两侧正好都是 clip）。 */}
                  {track.kind === "video" && drawableSeams
                    .filter((m) => inSpan(
                      pointSpanPx(m.atSec!, pxPerSec, SEAM_HALF_PX), span))
                    .map((m) => (
                    <button key={m.id}
                      className={`fw-tl-seam${m.state === "ok" ? "" : " bad"}`}
                      style={{ left: m.atSec! * pxPerSec }}
                      title={`${seamHint(m)}\n点击可改时长或删除`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSeamEdit({ m, x: e.clientX, y: e.clientY });
                      }}>
                      {m.state === "ok"
                        ? <Shuffle size={10} />
                        : <AlertTriangle size={10} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}


        {/* 播放头（蓝色竖线，绝对坐标）
            竖线本身保持 pointer-events:none —— 它贯穿整个轨道区，可交互的话
            会挡住底下片段的点击。可拖的只有顶端那个三角手柄。 */}
        <div className="fw-tl-playhead" style={{ left: GUTTER_W + playheadLeft }}
          title="播放头">
          <div className="fw-tl-playhead-grip"
            title="拖动播放头"
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              // 用位移增量而不是绝对坐标：播放头挂在可横向滚动的容器里，
              // 拖动时若容器跟着滚，绝对坐标算出来的秒数会跳。
              const x0 = e.clientX;
              const s0 = useTimelineStore.getState().playheadSec;
              // 3.4：与刻度尺共用同一个 scrubber —— 拖把手和拖刻度尺是同一件事，
              // 各走各的节流会出现"拖把手不省、拖刻度尺省"这种说不清的差异
              scrubber.current?.start(s0);
              const onMove = (ev: MouseEvent) => {
                scrubber.current?.move(Math.max(0, s0 + (ev.clientX - x0) / pxPerSec));
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                scrubber.current?.end();
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }} />
        </div>

        {/* 定位线（白色虚线竖线） */}
        {cursorLeft !== null && (
          <div className="fw-tl-cursor" style={{ left: GUTTER_W + cursorLeft }}
            title="定位线（双击刻度尺放置）" />
        )}

        {/* 吸附 guide：拖动命中吸附点时出现，松手即消失 */}
        {store.snapGuideSec !== null && (
          <div className="fw-tl-snapguide"
            style={{ left: GUTTER_W + store.snapGuideSec * pxPerSec }} />
        )}
      </div>

      {/* 右键菜单 */}
      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y}
          items={clipMenuItems(ctx.clip)}
          onClose={() => setCtx(null)} />
      )}

      {/* 3.6 转场编辑浮层：可见之外还要能改能删，否则用户看得见却动不了，
          比看不见更让人上火（在此之前唯一的"改"法是往同一条缝再加一次）。 */}
      {seamEdit && (
        <>
          <div className="fw-tl-seampop-mask" onMouseDown={() => setSeamEdit(null)} />
          <div className="fw-tl-seampop"
            style={{ left: Math.max(8, seamEdit.x - 110), top: Math.max(8, seamEdit.y - 150) }}>
            <div className="fw-tl-seampop-hd">
              <Shuffle size={12} />
              <b>{seamEdit.m.type}</b>
              <button className="fw-tl-seampop-x" title="关闭"
                onClick={() => setSeamEdit(null)}><X size={12} /></button>
            </div>
            <div className={`fw-tl-seampop-hint${seamEdit.m.state === "ok" ? "" : " bad"}`}>
              {seamHint(seamEdit.m)}
            </div>
            {/* maxSec=0 的缝（相邻镜头短于 0.2s）连最短转场都放不下，
                给个输入框只会让用户填了又被弹回来 */}
            {seamEdit.m.maxSec > 0 ? (
              <label className="fw-tl-seampop-row">
                时长
                <input type="range"
                  min={MIN_TRANSITION_SEC} max={seamEdit.m.maxSec} step={0.1}
                  value={Math.min(seamEdit.m.durationSec, seamEdit.m.maxSec)}
                  onChange={(e) => {
                    // 夹持用这条缝自己算好的上限，不在 UI 里重新推一遍镜头时长——
                    // 重推的那一遍迟早和标记上写的上限对不上
                    const v = clampToSeam(Number(e.target.value), seamEdit.m.maxSec);
                    setSeamEdit({ ...seamEdit, m: { ...seamEdit.m, durationSec: v } });
                  }}
                  /* 拖动过程中不落库（每帧一次 PATCH），松手/离开/键盘调完才提交。
                     三个事件都接是因为拖到输入框外松手时 mouseup 不一定回到它身上；
                     `doPatchTransition` 对"值没变"直接 return，重复触发无害。 */
                  onPointerUp={() => p.onPatchTransition(seamEdit.m.id, seamEdit.m.durationSec)}
                  onKeyUp={() => p.onPatchTransition(seamEdit.m.id, seamEdit.m.durationSec)}
                  onBlur={() => p.onPatchTransition(seamEdit.m.id, seamEdit.m.durationSec)} />
                <span className="fw-tl-seampop-val">{seamEdit.m.durationSec.toFixed(1)}s</span>
              </label>
            ) : (
              <div className="fw-tl-seampop-row">相邻镜头太短，这条缝放不下转场</div>
            )}
            <button className="fw-tl-seampop-del"
              onClick={() => { p.onDeleteTransition(seamEdit.m); setSeamEdit(null); }}>
              <Trash2 size={12} /> 删除转场
            </button>
          </div>
        </>
      )}
    </div>
  );
}
