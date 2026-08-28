/**
 * timelineStore.ts — 时间轴状态（Phase 2）
 *
 * 与旧 TimelineDock 的关键区别：**绝对时间坐标**。
 * 旧版每个镜头是流式排开的"槽"，没有全局秒坐标，因此资产轨/音频轨只能靠
 * 镜头下标对齐，做不到"旁白在第 12.5 秒开始"这种跨轨定位。新版所有对象
 * 统一用 startSec 定位，left = startSec * pxPerSec，多轨天然对齐。
 *
 * 撤销栈：操作以「做/撤」成对入栈，与后端 PATCH 解耦——store 只管本地
 * 状态与栈，真正落库由调用方在 apply 里做。这样拖动过程可以先本地预览，
 * 松手才提交，不会拖一次发十几个请求。
 */

import { create } from "zustand";
import type { Timeline, Track, Clip, AssetSegment, Selection } from "../types/timeline";
import { ZOOM_DEFAULT, ZOOM_MIN, ZOOM_MAX } from "../types/timeline";
import { readPref, writePref } from "../lib/prefs";

/** 编辑工具。select = 拖拽/框选；split = 点哪切哪。 */
export type EditorTool = "select" | "split";

/** 一条可撤销操作：label 给用户看，undo/redo 是真正的动作 */
export interface UndoEntry {
  label: string;
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
}

const MAX_UNDO = 50;

interface TimelineState {
  timeline: Timeline;
  setTimeline: (t: Timeline) => void;

  // ---- 编辑工具（参考剪映：切了保持状态，不自动回退）----
  tool: EditorTool;
  setTool: (t: EditorTool) => void;

  // ---- 吸附 ----
  snapping: boolean;
  toggleSnapping: () => void;
  /** 拖拽中命中的吸附点（绝对秒）；null = 未命中。仅用于画 guide 线 */
  snapGuideSec: number | null;
  setSnapGuide: (s: number | null) => void;

  // ---- 缩放 / 滚动 ----
  pxPerSec: number;
  setPxPerSec: (v: number) => void;
  zoomBy: (factor: number) => void;
  /** 适配全宽：把整条时间轴缩放到给定视口宽度 */
  fitTo: (viewportPx: number) => void;

  // ---- 播放头（绝对秒）----
  playheadSec: number;
  setPlayheadSec: (s: number) => void;
  nudgePlayhead: (deltaSec: number) => void;

  // ---- 定位线（editing cursor，绝对秒；null = 未放置）----
  cursorSec: number | null;
  setCursorSec: (s: number | null) => void;

  // ---- 选择 ----
  selection: Selection;
  selectClip: (id: string, additive?: boolean) => void;
  selectAssetSegment: (id: string, additive?: boolean) => void;
  selectClips: (ids: string[]) => void;
  clearSelection: () => void;
  isClipSelected: (id: string) => boolean;

  // ---- 剪贴板（Ctrl+C / Ctrl+V）----
  clipboard: Clip[];
  copySelection: () => void;

  // ---- 轨道控制 ----
  toggleTrackLock: (trackId: string) => void;
  toggleTrackHidden: (trackId: string) => void;
  toggleTrackMuted: (trackId: string) => void;
  toggleTrackSolo: (trackId: string) => void;
  toggleTrackCollapsed: (trackId: string) => void;
  setTrackHeight: (trackId: string, h: number) => void;

  // ---- 本地乐观更新（拖动预览用；提交后由 setTimeline 覆盖）----
  patchClipLocal: (clipId: string, patch: Partial<Clip>) => void;

  // ---- 撤销栈 ----
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  pushUndo: (e: UndoEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clearUndo: () => void;

  /** 切/关项目时的清场：把**跟项目绑死**的状态复位。
   *
   *  timeline 本身会因 detail=null → shots=[] 被重建 effect 清空，
   *  但播放头/定位线/选中/剪贴板不在那条链路上，会原样留给下一个项目。
   *  最难发现的后果是播放头：「移到叠加层」拿它当 overlay_start_sec，
   *  于是从一个 400s 的项目切到 40s 的项目后，这一镜被放到 320s ——
   *  远在片尾之外，时间轴上看不见、导出也不会出现。
   *
   *  刻意**不复位**的：pxPerSec（缩放）与 snapping —— 那是用户的操作习惯，
   *  不属于某个项目，每次切项目都重置回默认反而讨人嫌。 */
  resetForProjectSwitch: () => void;

  // ---- 查询辅助 ----
  findClip: (id: string) => Clip | undefined;
  findTrack: (id: string) => Track | undefined;
  allClips: () => Clip[];
  findAssetSegment: (id: string) => AssetSegment | undefined;
}

const EMPTY_TIMELINE: Timeline = { tracks: [], totalDurationSec: 0 };

export const useTimelineStore = create<TimelineState>((set, get) => ({
  timeline: EMPTY_TIMELINE,
  /** 用后端新数据重建时间轴，但**保留用户对轨道的设置**
   *  （折叠/锁定/隐藏/静音/独奏/高度）——否则任何一次 refreshDetail
   *  都会把用户折叠好的轨道全部弹开，编辑过程被反复打断。 */
  setTimeline: (t) => set((s) => {
    const prev = new Map(s.timeline.tracks.map((x) => [x.id, x]));
    return {
      timeline: {
        ...t,
        tracks: t.tracks.map((nt) => {
          const old = prev.get(nt.id);
          if (!old) return nt;
          return {
            ...nt,
            locked: old.locked,
            hidden: old.hidden,
            muted: old.muted,
            solo: old.solo,
            height: old.height,
            // 折叠状态：用户手动改过就沿用；从"空轨"变成"有内容"时自动展开
            collapsed: old.collapsed
              && !(nt.clips.length + nt.assetSegments.length > 0
                   && old.clips.length + old.assetSegments.length === 0),
          };
        }),
      },
    };
  }),

  // 工具不持久化：下次打开默认回到 select 更符合预期——
  // 上次退出时停在 split，下次打开一点就切开镜头，是很糟的意外
  tool: "select",
  setTool: (t) => set({ tool: t }),

  // 吸附是长期偏好，持久化
  snapping: readPref("tlSnapping", true),
  toggleSnapping: () => set((st) => {
    const v = !st.snapping;
    writePref("tlSnapping", v);
    return { snapping: v, snapGuideSec: null };
  }),
  snapGuideSec: null,
  setSnapGuide: (s) => set({ snapGuideSec: s }),

  pxPerSec: ZOOM_DEFAULT,
  setPxPerSec: (v) => set({ pxPerSec: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v)) }),
  zoomBy: (factor) => set((s) => ({
    pxPerSec: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.pxPerSec * factor)),
  })),
  fitTo: (viewportPx) => set((s) => {
    const total = s.timeline.totalDurationSec;
    if (total <= 0 || viewportPx <= 0) return {};
    return { pxPerSec: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewportPx / total)) };
  }),

  playheadSec: 0,
  setPlayheadSec: (v) => set({ playheadSec: Math.max(0, v) }),
  nudgePlayhead: (d) => set((s) => ({
    playheadSec: Math.max(0, Math.min(s.timeline.totalDurationSec, s.playheadSec + d)),
  })),

  cursorSec: null,
  setCursorSec: (v) => set({ cursorSec: v == null ? null : Math.max(0, v) }),

  selection: { clipIds: [], assetSegmentIds: [] },
  selectClip: (id, additive) => set((s) => {
    if (!additive) return { selection: { clipIds: [id], assetSegmentIds: [] } };
    const has = s.selection.clipIds.includes(id);
    return {
      selection: {
        clipIds: has ? s.selection.clipIds.filter((c) => c !== id)
          : [...s.selection.clipIds, id],
        assetSegmentIds: [],
      },
    };
  }),
  selectAssetSegment: (id, additive) => set((s) => {
    if (!additive) return { selection: { clipIds: [], assetSegmentIds: [id] } };
    const has = s.selection.assetSegmentIds.includes(id);
    return {
      selection: {
        clipIds: [],
        assetSegmentIds: has ? s.selection.assetSegmentIds.filter((c) => c !== id)
          : [...s.selection.assetSegmentIds, id],
      },
    };
  }),
  selectClips: (ids) => set({ selection: { clipIds: ids, assetSegmentIds: [] } }),
  clearSelection: () => set({ selection: { clipIds: [], assetSegmentIds: [] } }),
  isClipSelected: (id) => get().selection.clipIds.includes(id),

  clipboard: [],
  copySelection: () => {
    const { selection } = get();
    const clips = get().allClips().filter((c) => selection.clipIds.includes(c.id));
    set({ clipboard: clips });
  },

  toggleTrackLock: (id) => set((s) => ({ timeline: mapTrack(s.timeline, id, (t) => ({ ...t, locked: !t.locked })) })),
  toggleTrackHidden: (id) => set((s) => ({ timeline: mapTrack(s.timeline, id, (t) => ({ ...t, hidden: !t.hidden })) })),
  toggleTrackMuted: (id) => set((s) => ({ timeline: mapTrack(s.timeline, id, (t) => ({ ...t, muted: !t.muted })) })),
  toggleTrackSolo: (id) => set((s) => ({ timeline: mapTrack(s.timeline, id, (t) => ({ ...t, solo: !t.solo })) })),
  toggleTrackCollapsed: (id) => set((s) => ({ timeline: mapTrack(s.timeline, id, (t) => ({ ...t, collapsed: !t.collapsed })) })),
  setTrackHeight: (id, h) => set((s) => ({
    timeline: mapTrack(s.timeline, id, (t) => ({ ...t, height: Math.max(20, h) })),
  })),

  patchClipLocal: (clipId, patch) => set((s) => ({
    timeline: {
      ...s.timeline,
      tracks: s.timeline.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      })),
    },
  })),

  undoStack: [],
  redoStack: [],
  pushUndo: (e) => set((s) => ({
    undoStack: [...s.undoStack, e].slice(-MAX_UNDO),
    redoStack: [],   // 新操作使 redo 分支失效（标准 NLE 行为）
  })),
  undo: async () => {
    const { undoStack } = get();
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    set({ undoStack: undoStack.slice(0, -1) });
    await entry.undo();
    set((s) => ({ redoStack: [...s.redoStack, entry] }));
  },
  redo: async () => {
    const { redoStack } = get();
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    set({ redoStack: redoStack.slice(0, -1) });
    await entry.redo();
    set((s) => ({ undoStack: [...s.undoStack, entry] }));
  },
  clearUndo: () => set({ undoStack: [], redoStack: [] }),

  resetForProjectSwitch: () => set({
    timeline: EMPTY_TIMELINE,       // 不等重建 effect，立即失效
    playheadSec: 0,
    cursorSec: null,
    selection: { clipIds: [], assetSegmentIds: [] },
    clipboard: [],                 // 跨项目粘贴 clip 没有意义（shotId 属于旧项目）
    snapGuideSec: null,
    tool: "select",                // 停在 split 上切项目，一点就切开新项目的镜头
    undoStack: [],
    redoStack: [],
  }),

  findClip: (id) => get().allClips().find((c) => c.id === id),
  findTrack: (id) => get().timeline.tracks.find((t) => t.id === id),
  allClips: () => get().timeline.tracks.flatMap((t) => t.clips),
  findAssetSegment: (id) =>
    get().timeline.tracks.flatMap((t) => t.assetSegments).find((a) => a.id === id),
}));

function mapTrack(tl: Timeline, id: string, fn: (t: Track) => Track): Timeline {
  return { ...tl, tracks: tl.tracks.map((t) => (t.id === id ? fn(t) : t)) };
}
