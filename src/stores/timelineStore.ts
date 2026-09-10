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
 *
 * ## 哪些轨道开关进撤销栈（3.7）
 *
 * 锁定 / 隐藏 / 静音 / 独奏 **进**：它们改变的是"这条轨接下来会不会被编辑到、
 * 会不会出声"，误点一下的后果是后续操作全部落空（锁定后拖不动、框选不中），
 * 而按钮只在 hover 时才显形（`TrackHeader.tsx:54`），用户往往不知道自己点了
 * 什么、更不知道该点回哪个。Ctrl+Z 是这里唯一的退路。
 *
 * 折叠 **不进**，有两个具体理由：
 *   1. 它是纯视觉的收起，不影响任何后续操作的结果；
 *   2. 它会被**自动**改写 —— `setTimeline` 在轨道"从空变成有内容"时自动展开，
 *      `buildTimeline` 末尾对空轨自动折叠。撤销栈里的条目会和这两条自动规则
 *      互相打架：撤销把它折回去，下一次 refreshDetail 又给展开，
 *      表现为"撤销了但没撤销"。
 *
 * ⚠️ 撤销闭包必须走 `setTrackFlag`（写定值）而不是再调一次 `toggleTrackX`：
 * 后者会再推一条新记录，Ctrl+Z 变成在两个状态之间反复横跳且栈无限增长。
 */

import { create } from "zustand";
import type { Timeline, Track, Clip, AssetSegment, Selection } from "../types/timeline";
import { ZOOM_DEFAULT, ZOOM_MIN, ZOOM_MAX } from "../types/timeline";
import { readPref, writePref } from "../lib/prefs";

/** 会进撤销栈的轨道开关。**不含 collapsed**，理由见文件头。 */
export type TrackFlag = "locked" | "hidden" | "muted" | "solo";

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
  /**
   * Shift 范围选择的锚点 clip id（3.8）。**必须与选中集分开存**：
   * 选中集是"哪些会被操作"，锚点是"下一次 Shift 从哪儿量起"，两者生命周期
   * 不同 —— Shift 反复调整范围时选中集一直在变，锚点必须**钉住不动**，
   * 否则范围只会越滚越大、缩不回去（详见 selection.ts 的 rangeIds）。
   */
  selectionAnchor: string | null;
  selectClip: (id: string, additive?: boolean) => void;
  selectAssetSegment: (id: string, additive?: boolean) => void;
  /**
   * 整批替换选中集。
   * @param anchorId 省略 = 锚点落到 `ids[0]`（全选 / 一侧全选 / 框选都该如此：
   *   接着 Shift 点一下就是"从这批的头量到那儿"）；显式传入 = **保持原锚点**
   *   （Shift 范围选择自己走这条）；传 null = 清掉锚点。
   */
  selectClips: (ids: string[], anchorId?: string | null) => void;
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
  /** 直接把某个轨道开关设成给定值（**不入撤销栈**）。
   *  撤销/重做闭包走这条，否则撤销时再调一次 toggle 会又推一条新记录。 */
  setTrackFlag: (trackId: string, key: TrackFlag, value: boolean) => void;
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
  selectionAnchor: null,
  // 单击 / Ctrl+单击都**移动锚点**到刚点的这一个：用户最后指过的那个片段，
  // 就是他心里"从这儿量起"的那个（Finder / VS Code 同此）。
  selectClip: (id, additive) => set((s) => {
    if (!additive) {
      return { selection: { clipIds: [id], assetSegmentIds: [] }, selectionAnchor: id };
    }
    const has = s.selection.clipIds.includes(id);
    return {
      selection: {
        clipIds: has ? s.selection.clipIds.filter((c) => c !== id)
          : [...s.selection.clipIds, id],
        assetSegmentIds: [],
      },
      selectionAnchor: id,
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
  selectClips: (ids, anchorId) => set({
    selection: { clipIds: ids, assetSegmentIds: [] },
    selectionAnchor: anchorId === undefined ? (ids[0] ?? null) : anchorId,
  }),
  clearSelection: () => set({
    selection: { clipIds: [], assetSegmentIds: [] },
    // 清空选中 = 用户说"重来"，锚点跟着作废；否则点空白后 Shift+点击
    // 会从一个屏幕上早已没有高亮的片段量起，看起来像是随机选中了一片
    selectionAnchor: null,
  }),
  isClipSelected: (id) => get().selection.clipIds.includes(id),

  clipboard: [],
  copySelection: () => {
    const { selection } = get();
    // 6.9：只收镜头。音频/字幕从此可以被选中了，但**粘不回去** ——
    // 粘贴走的是"以外部素材形式插一条镜头"（App.tsx doPaste），
    // 音频段插不成镜头。收进剪贴板只会让 Ctrl+X 变成"剪了、永远粘不回来"，
    // 那是无声的数据丢失。跳过的部分由 doCut 明说，不闷着。
    const clips = get().allClips()
      .filter((c) => selection.clipIds.includes(c.id) && c.entity === "shot");
    set({ clipboard: clips });
  },

  setTrackFlag: (id, key, value) => set((s) => ({
    timeline: mapTrack(s.timeline, id, (t) => (t[key] === value ? t : { ...t, [key]: value })),
  })),

  toggleTrackLock: (id) => toggleFlagWithUndo(get, id, "locked", "锁定", "解锁"),
  toggleTrackHidden: (id) => toggleFlagWithUndo(get, id, "hidden", "隐藏", "显示"),
  toggleTrackMuted: (id) => toggleFlagWithUndo(get, id, "muted", "静音", "取消静音"),
  toggleTrackSolo: (id) => toggleFlagWithUndo(get, id, "solo", "独奏", "取消独奏"),
  // 折叠**刻意不入撤销栈**，见文件头「哪些轨道开关进撤销栈」。
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
    selectionAnchor: null,        // 锚点是旧项目的 clip id，留着必然指向空
    clipboard: [],                 // 跨项目粘贴 clip 没有意义（shotId 属于旧项目）
    snapGuideSec: null,
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

/**
 * 翻转一个轨道开关，并把「翻回去」推进撤销栈。
 *
 * undo/redo 都写**定值**而不是再翻一次：翻转是相对操作，一旦中途有别的路径
 * 改过这个标志（比如换项目后 id 复用），"再翻一次"回到的就不是原状态了。
 */
function toggleFlagWithUndo(
  get: () => TimelineState, trackId: string, key: TrackFlag,
  onWord: string, offWord: string,
): void {
  const st = get();
  const track = st.findTrack(trackId);
  if (!track) return;
  const prev = !!track[key];
  const next = !prev;
  st.setTrackFlag(trackId, key, next);
  st.pushUndo({
    label: `${next ? onWord : offWord}轨道「${track.label}」`,
    undo: () => { get().setTrackFlag(trackId, key, prev); },
    redo: () => { get().setTrackFlag(trackId, key, next); },
  });
}
