/**
 * features/timeline/selection.ts — 「哪些片段被选中」的纯计算（3.5）
 *
 * ## 为什么要有这个文件
 *
 * 3.5 之前，"选中"这件事在代码里有**两套互不相认的真源**：
 *
 *   · `useEditorStore.selectedClipId` —— 单选，**唯一被渲染成高亮的那个**
 *   · `useTimelineStore.selection.clipIds` —— 多选，**Delete / 复制 / 剪切
 *     真正作用的那个**
 *
 * 于是 Ctrl+A（只写后者）的结果是：**画面上零高亮，按 Delete 却会停用全部镜头**。
 * 用户按了全选、看不出任何变化、以为没生效，再随手按一下 Delete —— 整集镜头
 * 被停用。这不是"高亮没画出来"的小毛病，是**软件在骗人**：它显示的状态和它
 * 将要执行的操作是两回事。
 *
 * 3.5 的做法是把 `selectedClipId` **删掉**（它是写多读少：全项目只有
 * `Timeline.tsx` 的高亮一处在读），让高亮直接读 `selection.clipIds`。
 * 从此**高亮 ≡ 将被操作的集合**，这个不变式不再需要靠人去维持。
 *
 * ## 为什么"能不能被选中"要单独一条判据
 *
 * 收敛完真源之后立刻冒出第二个问题：高亮既然承诺了"这些会被操作"，就**不能
 * 把操作不了的东西也点亮**。三处选中逻辑（Ctrl+A / `[` `]` 一侧全选 / 框选）
 * 此前各写一份，且判据不一致：
 *
 *   · `commands/index.ts` 的 `selectSide` 跳过 locked/hidden 轨，但不看 shotId
 *   · `Timeline.tsx` 的 `selectSide` 是它的重复实现（多一个 toast）
 *   · 框选连 locked 轨都不跳过
 *   · Ctrl+A（`App.tsx`）三样都不看，直接把 `detail.shots` 全灌进去
 *
 * 现在统一到 `isSelectable`：**锁定/隐藏轨上的，一律不进选中集**。
 *
 * ## 6.9：判据从「有没有 shotId」放开到「有没有写通路」
 *
 * 3.5 当初的判据是 `!!clip.shotId`，理由写在这里（原话保留）：「Delete / 复制 /
 * 剪切 / 停用**全部**要经 `shotId` 才能落到后端，选中它们必然是空操作」，
 * 并明确记下了代价与兑现时点：
 *
 *   > 代价（有意为之）：在音频轨上框选现在选不中任何东西。这是诚实的 ——
 *   > 旧行为是"选得中、亮不起来、按 Delete 什么也不发生"。音频/字幕片段的
 *   > 可拖可修剪排在批次 6，届时它们会拿到 `shotId` 之外的操作通路，
 *   > 再把判据放开。
 *
 * 6.9 就是那个时点：音频/字幕现在有了自己的 DELETE 端点（`App.tsx`
 * `deleteTimelineClip`），Delete 落得到后端，所以它们重新可选。
 *
 * ⚠️ 但**当初那句话只有一半兑现了**，这一半差别必须落到代码里而不是注释里：
 *
 *   · Delete → 兑现（三种实体各有各的删法）
 *   · 复制 / 剪切 → **没有**兑现。粘贴是"以外部素材形式插一条镜头"
 *     （`App.tsx` doPaste），音频段粘不成镜头。所以 `copySelection` 只收镜头，
 *     剪切遇到音频/字幕会明说跳过 —— 不是默默剪掉一段永远粘不回来的音频。
 *   · 停用 → **不适用**。音频/字幕没有"保留在轨但不导出"这个状态，
 *     按 D 会明说"没有停用，请直接删除"。
 *
 * 也就是说：放开判据的同时，**每一个消费选中集的操作都被逐一看过**，
 * 要么真的支持，要么给一句能照着做的话。这正是 3.5 那条不变式的要求 ——
 * 高亮承诺的是"这些会被操作"，不是"这些会被操作或者被无声吃掉"。
 *
 * ## 为什么用 `entity` 而不是继续看 `shotId`
 *
 * 因为放开之后要分的是**三种**（镜头 / 音频 / 字幕），`shotId` 只能分出两种
 * （见 `types/timeline.ts` 的 `ClipEntity`）。`entity` 在这里做成**必填**，
 * 与 `Clip` 一致：`verify-selection.ts` 的每一条用例都会被 tsc 逼着说清楚
 * "这一格是什么"，漏写的那条不会静默落进某个兜底分支。
 *
 * ## 为什么用结构化的最小类型而不是 `Track` / `Clip`
 *
 * 与 `trim.ts` 的 `ClipWindowSource` 同一个理由：验证脚本要能用四五个字段
 * 拼出夹边/跨轨/锁轨的用例，而不是去构造一个有二十多个字段的 `Clip`。
 * 字段少一点，`verify-selection.ts` 里的用例才写得出、读得懂。
 */

import type { ClipEntity } from "../../types/timeline";

/** 参与选中判定所需的最小 clip 形状（`types/timeline.ts` 的 `Clip` 是其超集） */
export interface SelectableClip {
  id: string;
  startSec: number;
  durationSec: number;
  /** 背后是哪种后端实体。决定这一格有没有可落地的操作，见文件头 6.9 一节。 */
  entity: ClipEntity;
  /** 只有镜头轨的片段有（`shotToClip.ts:98`）。音频/字幕段一律没有。 */
  shotId?: string;
}

/** 参与选中判定所需的最小 track 形状 */
export interface SelectableTrack {
  id: string;
  locked: boolean;
  hidden: boolean;
  clips: SelectableClip[];
}

/**
 * 这个片段能否进入选中集 —— **全项目唯一的判据**。
 *
 * 三处批量选中（全选 / 一侧全选 / 框选）都必须走它，否则高亮又会开始承诺
 * 做不到的事。单个点击不走这里：点击是用户明确指着某一个片段说"就它"，
 * 即便它在锁定轨上，选中它以便查看属性也是合理的。
 *
 * 镜头仍然要求 `shotId`：没有 shotId 的镜头格子是不该存在的（adapter 一定
 * 会写），真出现了说明数据坏了，让它选不中比让 Delete 拿着 undefined
 * 去 PATCH `/v2/shots/undefined` 强。
 */
export function isSelectable(track: SelectableTrack, clip: SelectableClip): boolean {
  if (track.locked || track.hidden) return false;
  if (clip.entity === "shot") return !!clip.shotId;
  return true;
}

/** Ctrl+A：全部可操作片段。轨道内按时间序、轨道间按轨道序。 */
export function allSelectableIds(tracks: SelectableTrack[]): string[] {
  const out: string[] = [];
  for (const tk of tracks) {
    for (const c of tk.clips) if (isSelectable(tk, c)) out.push(c.id);
  }
  return out;
}

/**
 * `[` / `]`：以播放头为界选中一侧的全部片段。
 *
 * 判据用 clip 的**中点**而不是首/尾：播放头正落在某个 clip 中间时，用首会把
 * 它算进右侧、用尾会算进左侧，两种都反直觉。中点让"这一镜主要在哪边"决定
 * 归属，与剪映一致。
 *
 * 边界取严格不等：中点**恰好**等于播放头时两侧都不选。这种情况下把它算进
 * 任何一侧都是硬掰，且连按 `[` `]` 会看到它在两边跳。
 */
export function sideIds(
  tracks: SelectableTrack[], atSec: number, side: "left" | "right",
): string[] {
  const out: string[] = [];
  for (const tk of tracks) {
    for (const c of tk.clips) {
      if (!isSelectable(tk, c)) continue;
      const mid = c.startSec + c.durationSec / 2;
      if (side === "left" ? mid < atSec : mid > atSec) out.push(c.id);
    }
  }
  return out;
}

/**
 * 框选 / Shift 范围选择的**共同内核**（3.8）：时间 × 轨道的二维矩形。
 *
 * 时间维取**重叠**而不是包含 —— 用户拖个大概就该选上；要求完全包含的话，
 * 拖不到片段最右端就一个也选不中。端点取严格不等：零宽度的框（点一下没拖动）
 * 选不中任何东西，紧贴边界的框也不会把隔壁那一镜捎上。调用方另有 3px 的
 * "算不算拖动"阈值，两道各管一头。
 *
 * ⚠️ 这里的"二维"是**轨道粒度**，不是像素粒度。3.5 原来写「一条轨在时间轴上
 * 就是一维的，拖出高度没有意义，硬做二维只会让"稍微歪一点就漏选"」——
 * 那句话在**轨内**依然成立（clip 占满整条 lane 的高度，纵向没有可判别的信息），
 * 3.8 并没有推翻它：纵向判的是"这次框到了哪几条轨"，同一条轨内仍然只看时间。
 *
 * 轨道维是**枚举**而不是区间：调用方传"这次覆盖了哪几条轨"。框选那边是按
 * 屏幕 Y 命中的（折叠轨没有 lane、资产轨是另一种 lane，都不该参与），
 * Shift 范围那边是按轨道下标区间算的 —— 两者对"覆盖了哪几条"的定义本就不同，
 * 在这里统一成一个 id 集合，判据就只剩一条。
 *
 * 顺序：轨道按 `tracks` 的顺序、轨内按 clip 顺序。选中集是要拿去批量操作的，
 * 顺序稳定才能让"已选中 N 个"和后续操作的报错定位对得上。
 */
export function rectIds(
  tracks: SelectableTrack[], fromSec: number, toSec: number,
  trackIds: readonly string[],
): string[] {
  const lo = Math.min(fromSec, toSec);
  const hi = Math.max(fromSec, toSec);
  const want = new Set(trackIds);
  const out: string[] = [];
  for (const tk of tracks) {
    if (!want.has(tk.id)) continue;
    for (const c of tk.clips) {
      if (!isSelectable(tk, c)) continue;
      if (c.startSec < hi && c.startSec + c.durationSec > lo) out.push(c.id);
    }
  }
  return out;
}

/**
 * 单轨框选：`rectIds` 的退化情形。保留这个入口是因为它读起来更直白，
 * 且 3.5 的用例都建在它上面。**它不是另一份实现** —— 判据只有 rectIds 一处。
 */
export function marqueeIds(
  track: SelectableTrack, fromSec: number, toSec: number,
): string[] {
  return rectIds([track], fromSec, toSec, [track.id]);
}

/**
 * Shift+点击的结果。**不是 `string[] | null`**：三种失败各自要说一句不同的话，
 * 混成一个空数组的话，调用方只能说"范围选择没成功"，用户完全不知道该怎么办。
 * 同 3.6 的 `SeamState`：每个失败态配一句能照着做的提示。
 */
export type RangeResult =
  | { ok: true; ids: string[] }
  /** 还没有锚点：本次会话第一次点击就按住了 Shift */
  | { ok: false; reason: "no-anchor" }
  /** 锚点那一镜已经不在时间轴上了（被删/被移到叠加层/切了项目） */
  | { ok: false; reason: "anchor-gone" }
  /** 点到了锁定/隐藏轨上的片段 —— 它进不了选中集，
   *  以它为端点的范围会是"端点自己不在里面"的怪结果 */
  | { ok: false; reason: "target-unselectable" };

/** 每个失败态对应的人话（调用方直接 toast，不再自己拼） */
export const RANGE_HINT: Record<
  Exclude<RangeResult, { ok: true }>["reason"], string
> = {
  "no-anchor": "Shift 范围选择要先点一个起点片段",
  "anchor-gone": "范围起点那一镜已不在时间轴上，已改为选中当前片段",
  "target-unselectable": "锁定/隐藏轨上的片段不参与范围选择",
};

function locate(tracks: SelectableTrack[], clipId: string) {
  for (let i = 0; i < tracks.length; i++) {
    const c = tracks[i].clips.find((x) => x.id === clipId);
    if (c) return { trackIdx: i, track: tracks[i], clip: c };
  }
  return null;
}

/**
 * Shift+点击：选中**锚点片段与目标片段的包围盒**内的全部可操作片段。
 *
 * ## 为什么是包围盒，而不是"同一条轨上从 A 到 B"
 *
 * 因为那样在跨轨时无解：锚点在主轨、目标在叠加层，"从 A 到 B"沿哪条路径走？
 * 包围盒是唯一一个**在同轨时退化成人人预期的那个行为**（= 两者之间的全部）、
 * 跨轨时又有确定答案的定义。而且它与框选**是同一个矩形** —— 用户 Shift 点两下
 * 得到的，正是他在这两点之间拖一个框会得到的。一条规则，两个入口。
 *
 * ## 锚点为什么不能在范围选择之后移动
 *
 * 锚点固定，Shift 才能**反复调整**同一段范围（点远一点变大、点近一点变小）。
 * 锚点跟着走的话，第二次 Shift+点击就变成"从上次的终点再连一段"，
 * 范围只会越滚越大、缩不回去。所有列表类 UI（Finder / VS Code / 资源管理器）
 * 都是固定锚点，这里没有理由不一样。
 */
export function rangeIds(
  tracks: SelectableTrack[], anchorId: string | null, targetId: string,
): RangeResult {
  if (!anchorId) return { ok: false, reason: "no-anchor" };
  const t = locate(tracks, targetId);
  if (!t || !isSelectable(t.track, t.clip)) {
    return { ok: false, reason: "target-unselectable" };
  }
  const a = locate(tracks, anchorId);
  if (!a) return { ok: false, reason: "anchor-gone" };

  const lo = Math.min(a.clip.startSec, t.clip.startSec);
  const hi = Math.max(a.clip.startSec + a.clip.durationSec,
                      t.clip.startSec + t.clip.durationSec);
  const i0 = Math.min(a.trackIdx, t.trackIdx);
  const i1 = Math.max(a.trackIdx, t.trackIdx);
  const ids = tracks.slice(i0, i1 + 1).map((x) => x.id);
  // ⚠️ 端点用**闭区间**：rectIds 的时间判据是严格不等，而端点自己的
  // start < hi && end > lo 恒成立（除非它是零长度片段），所以两个端点总在结果里。
  // 零长度片段在本项目里不存在（后端拒 0 时长），故不额外兜。
  return { ok: true, ids: rectIds(tracks, lo, hi, ids) };
}
