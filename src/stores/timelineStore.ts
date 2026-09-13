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
import type { CommandDraft, EditCommand } from "../lib/command";
import { createCommandStore } from "../lib/command";

/** 会进撤销栈的轨道开关。**不含 collapsed**，理由见文件头。 */
export type TrackFlag = "locked" | "hidden" | "muted" | "solo";

/** 撤销深度上限。C1 起真正的裁切在 `commandStore` 里做，这里只负责把它
 *  传下去 —— 两个数必须是同一个，故只留一处定义。
 *
 *  C4：50 → 100。一次成片会给一个项目塞进几十步（每个镜头一条 + 批量操作
 *  一条），50 步意味着"从头配一遍"的那一轮一旦超了就再也退不回去。100 步的
 *  内存代价可以忽略：一条 `EditCommand` 是闭包 + 几十字节的元数据，凡是"重"
 *  的东西（新旧值、后端快照）都装在闭包里按需重建，栈本身不存大对象。
 *  ⚠️ 面板只展示最近 `HISTORY_VISIBLE`（30）条，与这个数**故意不同**：
 *  栈深是"能退多远"（能力），面板高度是"看得清几条"（界面），混成一个数
 *  会逼着在"展示太多挤爆"和"少退 70 步"之间二选一。 */
const MAX_UNDO = 100;

/**
 * 撤销栈的**真正持有者**（C1）。放在模块级而不是 create() 里面，理由同
 * `lib/outboxStore.ts` / `lib/backendReach.ts`：命令模型在 node 下要能被
 * 验证脚本单独跑，而 zustand 的 store 一旦被 `create()` 包住就只能在
 * React 环境里用了。
 *
 * 本 store 的 `undoStack` / `redoStack` 是它的**快照**（`slice()` 复制），
 * 每次入栈/出栈后同步 —— 这样 `Timeline.tsx` 的订阅与 verify 脚本读
 * `useTimelineStore.getState().undoStack` 的老写法都一行不用改。
 *
 * ⚠️ 两个栈只许**通过 `commandStore` 的方法**改。直接 `set({undoStack: ...})`
 * 会让快照与真身分岔：界面显示"有 3 步可撤"，实际栈里是 0 步。
 */
const commandStore = createCommandStore(MAX_UNDO);

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
  //
  // C1：数据模型换成 `EditCommand`（`lib/command.ts`），**字段名一个没改** ——
  // `undoStack` / `redoStack` / `pushUndo` / `undo` / `redo` / `clearUndo` 原样
  // 保留，所以 `Timeline.tsx` 的两处 `disabled={!store.undoStack.length}` 与
  // 四个 verify 脚本都不用动。换的是**栈里装的什么**：以前是不透明的
  // `{label, undo, redo}` 闭包，现在是带 id / kind / at / affected / reversible
  // 的显式命令。
  //
  // 为什么栈仍放在本 store、不另起一个 `commandStore`：本 store 的订阅者
  // 本来就每帧重渲染（`playheadSec` 在 `Timeline.tsx` 的 useShallow 选择器里），
  // 搬出去省不下任何渲染，却会把上面那 6 个字段和下游全部打断。C4 若真需要
  // 独立 store，命令模型本身（`createCommandStore`）已经可以整体搬走。
  undoStack: EditCommand[];
  redoStack: EditCommand[];
  /** 入栈。**C2 起只收 `CommandDraft`**：
   *  显式声明 run/unrun/kind/affected/reversible 的对象字面量。
   *
   *  ⚠️ C1 曾经容忍旧形状 `{label, undo, redo?}`，靠运行期 `"undo" in e`
   *  判别。C2 把那条路堵上了：现在**类型上就只收这一种形状**，写错
   *  **编译期**报错 —— 而运行期判别只要有人从别处直接调 store 就能绕过去。
   *
   *  为什么不干脆让 store 反向依赖 toast 来做"没配重做时提示一下"：
   *  那会多一条 store→UI 的倒挂边。这个决定属于 UI 层，由调用方实现。 */
  pushUndo: (e: CommandDraft) => EditCommand;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /**
   * 连撤 N 步（C3：撤销历史面板"点任意一步回到那里"的落地）。
   *
   * ⚠️ **中途失败就停在那里，并把已经撤掉的算数返回** —— 不 try/catch 吞掉、
   * 也不回滚已经成功的那些。理由：`unrun` 失败的原因基本都是网络/后端，
   * 而"已经撤掉的 3 步"在用户的界面上**是真的撤掉了**（每次 unrun 都改过
   * 内存与后台）。把它回滚回去需要把刚失败的 redo 也做一遍，那更可能再失败。
   * 停在中间虽然状态是"撤了 3 步"，但**与界面上看到的一致**，用户再点一下
   * 继续撤就是了 —— 报错的语义是"撤到这儿停了"，不是"什么都没发生"。
   *
   * @returns 真正撤掉的步数（0 = 一步也没撤成）
   */
  jumpBack: (steps: number) => Promise<number>;
  clearUndo: () => void;
  /** 栈里 `reversible: false` 的条数。**只该降不该升** —— C2 的进度尺，
   *  也是"还有多少处 undo 没配 redo"这个历史缺口的唯一可见数字。 */
  irreversibleCount: () => number;

  // ---- E4：一轮 Agent = 一条可撤销记录 ----
  //
  // 这一对是**给 Agent 循环用的**（`lib/agent/dispatch.ts`），人手动操作
  // 从不调用 —— 人的每一下都该是独立的一步，见 `ledger.ts` 的文件头。
  //
  // ⚠️ 调用方必须 `try { ... } finally { endTurn(turn) }`。漏了 `endTurn`
  // 的后果不是"AI 那轮不合并"，而是**用户接下来的手动操作被并进 AI 那轮**：
  // 他按一次 Ctrl+Z，连自己刚改的几笔一起没了。所以 `endTurn` 走 finally。
  /**
   * 开一轮。返回 `turnId`，之后到 `endTurn` 之间的所有 `pushUndo`
   * **只要是 agent 来源**就会被合并成栈上的一条。
   */
  beginTurn: () => string;
  /** 收尾一轮。传 `turnId` 防串轮（上一轮迟到的 endTurn 关不掉新的）。 */
  endTurn: (turnId: string) => void;
  /** 当前轮次 id；不在轮次里返回 null。面板据此显示"AI 正在修改…"并禁掉撤销。 */
  currentTurn: () => string | null;

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
  /** 吸附参考线（秒）。`null` = 不显示。
   *
   *  ⚠️ **必须做等值短路**（2026-09-12 修「不跟手/闪烁」）。这一句是拖拽路径上
   *  唯一一个**每个 mousemove 都会调用**的 store 写：拖动中指针每动 1px 就调一次，
   *  而绝大多数帧算出来的吸附点与上一帧**完全相同**（同一根线、或者一直是 null）。
   *  zustand 的 `set` 不看新旧值是否相等，无条件换 state 对象 → 所有订阅者重渲染。
   *  在 1424 镜的项目上，那就是每帧把整个轨道树重渲染一遍，
   *  表现为"拖不动、闪"。
   *
   *  判据写在这里而不是各调用点：调用点有三处（拖块/拖叠加层/拖主轨），
   *  逐个加守卫必然漏；而且将来任何新的吸附调用点会自动受益。 */
  setSnapGuide: (s) => set((st) => (st.snapGuideSec === s ? {} : { snapGuideSec: s })),

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
  /** 播放头位置。等值短路同 `setSnapGuide`：拖动播放头时 `scrubber` 每帧调它，
   *  而 rAF 合并后仍可能出现"同一帧内值没变"的重复调用。 */
  setPlayheadSec: (v) => set((s) => {
    const next = Math.max(0, v);
    return s.playheadSec === next ? {} : { playheadSec: next };
  }),
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
  pushUndo: (e) => {
    // C2：**只收 `CommandDraft`**。旧形状 `{label, undo, redo}` 的翻译已经
    // 收到 `hooks/useUndo.ts` 一处 —— 那里是"UI 怎么表达一次编辑"的边界，
    // 而 store 不该认得 `undo`/`redo` 这对旧名字。
    //
    // ⚠️ 这比 C1 的 `"undo" in e` 运行期判别更硬：写错形状**编译期**就报错。
    // 代价是 `scripts/verify-f16-reset.ts` 那两处直接调 store 的手写条目要
    // 自己写成完整 draft（`{label, run, unrun}`）—— 已经改了，见那边注释。
    const cmd = commandStore.push(e);
    // 把快照写进 state，供 `Timeline.tsx` 的两个 disabled 与四个 verify 脚本读
    set({ undoStack: commandStore.undoEntries().slice(), redoStack: [] });
    return cmd;
  },
  undo: async () => {
    // 命令 store 内部已完成"先执行、成功了才出栈"；抛异常时它原样留着，
    // 这里也不 set，于是 state 与栈保持一致（不会出现"界面灰了但其实没撤"）
    await commandStore.undo();
    set({
      undoStack: commandStore.undoEntries().slice(),
      redoStack: commandStore.redoEntries().slice(),
    });
  },
  redo: async () => {
    await commandStore.redo();
    set({
      undoStack: commandStore.undoEntries().slice(),
      redoStack: commandStore.redoEntries().slice(),
    });
  },
  jumpBack: async (steps) => {
    // 消息里说的"撤了 N 步"必须与栈的真实变化一致 —— 所以**在循环里问
    // commandStore 要结果**，而不是按 `steps` 计数。`undo()` 在空栈时返回
    // undefined（一步没撤），这时立刻停：继续空转会让返回值虚高，
    // 而调用方拿这个数去决定说什么话。
    let done = 0;
    for (let i = 0; i < steps; i++) {
      let moved: unknown;
      try {
        moved = await commandStore.undo();
      } catch (e) {
        // 失败即停，但**先把快照同步出去**再抛：栈的真实状态可能已经因为
        // 之前成功的几步变了，不同步的话面板显示的还是旧的（"点了没反应"）。
        set({
          undoStack: commandStore.undoEntries().slice(),
          redoStack: commandStore.redoEntries().slice(),
        });
        // 把"撤到第几步断的"附在错误上，UI 才能说出准确的话；
        // 直接吞掉会变成一句无信息的"撤销失败"。
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), {
          undoneSteps: done,
        });
      }
      if (!moved) break;
      done += 1;
    }
    set({
      undoStack: commandStore.undoEntries().slice(),
      redoStack: commandStore.redoEntries().slice(),
    });
    return done;
  },
  clearUndo: () => {
    commandStore.clear();
    set({ undoStack: [], redoStack: [] });
  },
  irreversibleCount: () => commandStore.irreversibleCount(),

  // `beginTurn` / `endTurn` 不改 state：轮次是**写侧**的状态，界面要显示
  // "AI 正在修改…"时自己去问 `currentTurn()`（或者订阅 Agent 循环自己广播的
  // 状态）。把 turnId 塞进 store 会多一次全量重渲染，而它一变就是整轮的开始/结束，
  // 中间几十条 `pushUndo` 反而**不该**触发重渲染。
  beginTurn: () => commandStore.beginTurn(),
  endTurn: (turnId) => { commandStore.endTurn(turnId); },
  currentTurn: () => commandStore.currentTurn(),

  resetForProjectSwitch: () => {
    // ⚠️ 必须先清真身再 set 快照。C1 之前这里只 `set({undoStack: []})` 就够了，
    // 因为栈就住在 state 里；现在真身在 commandStore，只清 state 等于
    // "界面显示没有可撤销的操作，但 Ctrl+Z 还能撤上一个项目的改动"——
    // 那是会真的改到错误项目的数据的。
    commandStore.clear();
    set({
      timeline: EMPTY_TIMELINE,       // 不等重建 effect，立即失效
      playheadSec: 0,
      cursorSec: null,
      selection: { clipIds: [], assetSegmentIds: [] },
      selectionAnchor: null,        // 锚点是旧项目的 clip id，留着必然指向空
      clipboard: [],                 // 跨项目粘贴 clip 没有意义（shotId 属于旧项目）
      snapGuideSec: null,
      undoStack: [],
      redoStack: [],
    });
  },

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
 *
 * C1 起这里就直接产出 `CommandDraft`（当时是**第一个**，因为它在 store
 * 内部，改起来不牵动 App；C2 之后全项目都长这样了）。它把 `kind: "track"`
 * 写实了，`affected` 留空：轨道 id 不在 `CommandScope` 的 shots/assets
 * 两类里（那两个都是**镜头/素材**的 uid 空间），轨道开关本来就是"改轨道
 * 自己"这个标志位，没有第三个对象需要定位。
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
    kind: "track",
    run: () => { get().setTrackFlag(trackId, key, next); },
    unrun: () => { get().setTrackFlag(trackId, key, prev); },
  });
}
