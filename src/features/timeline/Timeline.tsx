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

import { useEffect, useRef, useState, useCallback } from "react";
import type { Clip } from "../../types/timeline";
import { ZOOM_MIN, ZOOM_MAX } from "../../types/timeline";
import type { ShotInfo, AudioClipInfo, StageInfo, LocationInfo, AssetInfo, SubtitleClipInfo } from "../../api";
import { buildTimeline, buildOrderOffsetMap, secToPosition } from "../../adapters/shotToClip";
import { useTimelineStore } from "../../stores/timelineStore";
import { useEditorStore } from "../../stores/editorStore";
import TimelineRuler from "./TimelineRuler";
import TrackHeader from "./TrackHeader";
import ClipView from "./ClipView";
import ContextMenu from "../../components/ContextMenu/ContextMenu";
import type { MenuItem } from "../../components/ContextMenu/ContextMenu";
import AssetTrack, { AssetTrackKind, AssetRun } from "../assets/AssetTrack";
import { collectSnapPoints, snapRange } from "./snap";
import {
  Undo2, Redo2, ZoomIn, ZoomOut, Maximize2, MousePointer2, Scissors,
  ChevronsLeft, ChevronsRight, Magnet,
  Trash2, EyeOff, Eye, Copy, Scissors as ScissorsIcon,
  RefreshCw, History, Gem, Layers, VolumeX, CopyPlus, Crosshair,
} from "lucide-react";
import "./Timeline.css";

const GUTTER_W = 68; // 轨道头宽度（px），与 TrackHeader sticky left 对齐
const MIN_CLIP_SEC = 1;
//: 拿不到项目上限时的兜底（= seedance-2.0 / veo 的 15s）。
//: 真实上限由服务端 `detail.shot_duration_max` 下发——seedance-2.5 是 30s，
//: 在这里写死 15 会让用户随手拖一下就把 28s 的长镜砍掉一半。
const MAX_CLIP_SEC_FALLBACK = 15;

interface Props {
  shots: ShotInfo[];
  audioClips?: AudioClipInfo[];
  subtitleClips?: SubtitleClipInfo[];
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
  onSeek: (shot: ShotInfo, sec: number) => void;

  maximized: boolean;
  onToggleMax: () => void;

  onPatch: (shotId: string, p: { durationSec?: number; toOrder?: number; disabled?: boolean }) => Promise<void>;
  onDeleteShot: (shotId: string) => Promise<void>;
  onRegenerate: (shotIds: string[]) => void;
  /** 精品升级（换高价模型重生成该镜） */
  onUpgrade: (shot: ShotInfo) => void;
  /** 选中该镜并在右侧 Inspector 展开版本历史 */
  onShowVersions: (shot: ShotInfo) => void;
  /** 改镜头级渲染参数（静音等存在 transform_meta 里） */
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
  const setSelectedClip = useEditorStore((s) => s.setSelectedClipId);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [move, setMove] = useState<MoveState | null>(null);
  // 拖动预览只走本地 state：mousemove 每秒几十次，直接打 store 会让整棵轨道树重渲
  const [previewDur, setPreviewDur] = useState<{ id: string; sec: number } | null>(null);
  const [previewOrder, setPreviewOrder] = useState<{ id: string; order: number } | null>(null);
  /** 框选中的时间区间（null = 没在框选） */
  const [marquee, setMarquee] = useState<
    { trackId: string; fromSec: number; toSec: number } | null>(null);
  /** 叠加层拖动预览（按绝对秒，与主轨的 order 拖动是两套语义） */
  const [overlayDrag, setOverlayDrag] = useState<
    { clipId: string; startSec: number } | null>(null);
  /** 素材拖到轨道上方时的高亮反馈（没有它用户不知道能不能放） */
  const [dropHot, setDropHot] = useState(false);

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
    setSelectedClip(shot.id);

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
  }, [p.selectedShotId, p.shots, pxPerSec, setSelectedClip]);

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


  const totalWidth = Math.max(600, p.totalSec * pxPerSec);
  const tl = store.timeline;

  // ---- trim drag ----
  // 注意：onUp 是在 mousedown 那一帧创建的闭包，读不到后续 setState 的新值。
  // 因此拖动结果走 ref（latest 值），state 只负责触发重渲画预览。
  const beginTrim = useCallback((e: React.MouseEvent, clip: Clip) => {
    if (!clip.shotId) return;
    e.preventDefault(); e.stopPropagation();
    const shotId = clip.shotId;
    const startSec = clip.durationSec;
    const startX = e.clientX;
    let latest = Math.round(startSec);
    setPreviewDur({ id: clip.id, sec: latest });
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) / pxPerSec;
      const maxSec = p.maxClipSec ?? MAX_CLIP_SEC_FALLBACK;
      const next = Math.max(MIN_CLIP_SEC, Math.min(maxSec, Math.round(startSec + delta)));
      if (next === latest) return;
      latest = next;
      setPreviewDur({ id: clip.id, sec: next });
    };
    const onUp = async () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPreviewDur(null);
      const old = Math.round(startSec);
      if (latest === old) return;
      // ⚠️ 这里**不要**再 onPushUndo：onPatch 就是 App 的 patchTimeline，
      // 它内部已按 durationSec/toOrder/disabled 三类各自入栈，且带正确的 redo。
      // 两边都推的话，一次拖动进两条栈，Ctrl+Z 要按两下才回到原状，
      // 而且这边推的那条没有 redo（会弹"暂不支持重做"）。
      await p.onPatch(shotId, { durationSec: latest });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p]);

  // ---- move drag（改镜头顺序）----
  // 同 trim：落点走局部变量而非 state，避免闭包读到旧值。
  // 换位阈值取「一个镜头槽宽」：拖过半个槽才算跨一位，手抖不会误改顺序。
  const beginMove = useCallback((e: React.MouseEvent, clip: Clip) => {
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

  // ---- 框选（Phase 2 遗留项）----
  // 轨道空白处横拖出一个时间区间，与之重叠的 Clip 全部选中。
  // 只按**时间区间**判定而不做二维矩形碰撞：一条轨在时间轴上就是一维的，
  // 拖出高度没有意义，硬做二维只会让"稍微歪一点就漏选"。
  const beginMarquee = useCallback((e: React.MouseEvent, trackId: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const startSec = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    let moved = false;
    let latest = { trackId, fromSec: startSec, toSec: startSec };
    setMarquee(latest);

    const onMove = (ev: MouseEvent) => {
      const sec = Math.max(0, (ev.clientX - rect.left) / pxPerSec);
      if (Math.abs(sec - startSec) * pxPerSec > 3) moved = true;
      latest = { trackId, fromSec: Math.min(startSec, sec), toSec: Math.max(startSec, sec) };
      setMarquee(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setMarquee(null);
      if (!moved) return;
      const tk = useTimelineStore.getState().timeline.tracks
        .find((t) => t.id === latest.trackId);
      if (!tk) return;
      // 与选区有重叠即命中（不要求完全包含——用户拖个大概就该选上）
      const hit = tk.clips
        .filter((c) => c.startSec < latest.toSec
                    && c.startSec + c.durationSec > latest.fromSec)
        .map((c) => c.id);
      if (hit.length) {
        useTimelineStore.getState().selectClips(hit);
        setSelectedClip(hit[0]);
        p.onToast(`已选中 ${hit.length} 个片段`);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pxPerSec, p, setSelectedClip]);

  /**
   * 以播放头为界选中一侧的全部镜头。
   *
   * 判据用 clip 的**中点**而不是首/尾：播放头正落在某个 clip 中间时，
   * 用首会把它算进右侧、用尾会算进左侧，都反直觉。中点让"这一镜主要在哪边"
   * 决定归属，与剪映一致。
   */
  const selectSide = useCallback((side: "left" | "right") => {
    const st = useTimelineStore.getState();
    const at = st.playheadSec;
    const hit: string[] = [];
    for (const tk of st.timeline.tracks) {
      if (tk.locked || tk.hidden) continue;
      for (const c of tk.clips) {
        const mid = c.startSec + c.durationSec / 2;
        if (side === "left" ? mid < at : mid > at) hit.push(c.id);
      }
    }
    if (!hit.length) { p.onToast(`播放头${side === "left" ? "左" : "右"}侧没有镜头`); return; }
    st.selectClips(hit);
    setSelectedClip(hit[0]);
    p.onToast(`已选中${side === "left" ? "左" : "右"}侧 ${hit.length} 个片段`);
  }, [p, setSelectedClip]);

  /** 删除当前选中的全部镜头。逐个删——后端没有批量删接口，
   *  且逐个删每一步都能撤销，比一次性批量更安全。 */
  const deleteSelected = useCallback(async () => {
    const st = useTimelineStore.getState();
    const ids = st.selection.clipIds;
    if (!ids.length) return;
    const shotIds = st.timeline.tracks
      .flatMap((tk) => tk.clips)
      .filter((c) => ids.includes(c.id) && c.shotId)
      .map((c) => c.shotId as string);
    for (const sid of shotIds) await p.onDeleteShot(sid);
    st.clearSelection();
  }, [p]);

  // ---- playhead absolute px ----
  const playheadLeft = store.playheadSec * pxPerSec;

  // ---- cursor absolute px (null = hidden) ----
  const cursorLeft = p.cursor
    ? ((offsetMap.get(p.cursor.order) ?? 0) + p.cursor.offsetSec) * pxPerSec
    : null;

  // ---- ruler scrub / cursor → 定位 ----
  //
  // 两者都走 secToPosition —— 它是 buildOrderOffsetMap（画线用的那套）的
  // 逆运算。此前这里各写了一套累加循环，与画线口径三方不一致：
  // scrub 过滤停用镜头、cursor 让停用镜头参与累加，两者又都把叠加层
  // 算进主轨累加，而画线是"停用占位不累加 + 跳过叠加层"。
  // 于是同一个 x 坐标，竖线画在一处、跳到的却是另一镜。
  const onRulerScrub = (sec: number) => {
    const pos = secToPosition(p.shots, sec);
    if (!pos) return;
    const shot = p.shots.find(
      (s) => s.order === pos.order && (s.track_index ?? 0) === 0);
    if (shot) p.onSeek(shot, pos.offsetSec);
  };

  const onRulerCursor = (sec: number) => {
    const pos = secToPosition(p.shots, sec);
    if (pos) p.onSetCursor(pos);
  };

  // ---- context menu items ----
  const clipMenuItems = (clip: Clip): MenuItem[] => {
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
          onClick={() => selectSide("left")}>
          <ChevronsLeft size={13} />
        </button>
        <button className="fw-tl-tbtn" title="选中播放头右侧全部镜头 (])"
          onClick={() => selectSide("right")}>
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
            时长 {previewDur.sec}s
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
          onScrub={onRulerScrub}
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
                    cursorOrder={p.cursor?.order ?? null}
                    rowHeight={ASSET_ROW_H}
                    onChanged={p.onAssetsChanged}
                    onPushUndo={p.onPushUndo}
                    onToast={p.onToast}
                    onSelectRun={(run) => { p.onSelectAssetRun(run); setSelectedClip(null); }}
                    onRegenerate={p.onRegenerate}
                    selectedRunId={p.selectedAssetRunId} />
                </div>
              )}

              {/* 普通轨：Clip 内容区 */}
              {!track.collapsed && !assetKind && (
                <div className={`fw-tl-lane${dropHot ? " drop-hot" : ""}`}
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
                    beginMarquee(e, track.id);
                  }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest(".fw-clip")) return;
                    store.clearSelection();
                    setSelectedClip(null);
                  }}>
                  {/* 框选浮层 */}
                  {marquee?.trackId === track.id && marquee.toSec > marquee.fromSec && (
                    <div className="fw-tl-marquee"
                      style={{ left: marquee.fromSec * pxPerSec,
                               width: (marquee.toSec - marquee.fromSec) * pxPerSec }} />
                  )}
                  {track.clips.map((clip) => {
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
                        selected={selectedClipId === clip.id}
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
                          setSelectedClip(clip.id);
                          p.onSelectAssetRun(null);
                          const shot = p.shots.find((s) => s.id === clip.shotId);
                          if (shot) p.onSelectShot(shot);
                          store.selectClip(clip.id, e.shiftKey || e.ctrlKey || e.metaKey);
                        }}
                        onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, clip }); }}
                        onBeginMove={(e) => beginMove(e, clip)}
                        onBeginTrim={(e) => beginTrim(e, clip)}
                        onDoubleClick={() => {
                          const shot = p.shots.find((s) => s.id === clip.shotId);
                          if (shot) p.onSelectShot(shot);
                        }} />
                    );
                  })}
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
              const onMove = (ev: MouseEvent) => {
                onRulerScrub(Math.max(0, s0 + (ev.clientX - x0) / pxPerSec));
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
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
    </div>
  );
}
