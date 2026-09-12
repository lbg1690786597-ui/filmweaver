/**
 * features/assets/useAssetDrop.ts — 资产卡拖到轨道上的**落点判定**（3.11 P1）
 *
 * ## 它取代了什么
 *
 * 原来这条链是 HTML5 DnD：卡片 `dragstart` 里 `setData("application/x-fw-asset")`，
 * 轨道侧 `onDragOver` 里判 `dataTransfer.types`、`onDrop` 里 `getData()`。
 * 宿主（WebView2 的 `IDropTarget`）把这一族事件整个吞掉，于是**一次都没跑过** ——
 * 用户看到的永远是禁止光标，松手什么都不发生。通道的机理见 `pointerDrag.ts`。
 *
 * ## 为什么落点判定要单独抽出来
 *
 * 落点一共三类，而且**有优先级**（越具体的越优先）：
 *
 *   1. `.fw-at-run`   资产段   → 换这套造型的参考图（`replaceRunImage`）
 *   2. `.fw-at-row`   资产行   → 注入到该行对应的镜头（按 x 换算 order）
 *   3. `.fw-tl-lane`  镜头轨   → 注入到落点那一镜
 *
 * 优先级不能靠"注册顺序"或"谁先冒泡"来定 —— 指针事件里根本没有冒泡那一说，
 * `elementFromPoint` 只给一个元素。所以这里**显式按 1→2→3 去 `closest()`**，
 * 一次判定。三处调用方（卡片、资产段、镜头轨）共用同一份；各写一遍必然漂移，
 * 最典型的是"拖到段上"在 A 处算换图、在 B 处算注入，同一个手势两个结果。
 */
import type { AssetDragData, ShotInfo } from "../../api";
import { injectAssetIntoShot, replaceRunImage } from "./injectAsset";

export type AssetDropTarget =
  /** 落在某个资产段上：换参考图 */
  | { kind: "run"; rowName: string; runId: string; stageId?: string;
      stageName?: string; imageUrl: string | null; isLocation: boolean; el: HTMLElement }
  /** 落在资产轨的某条行 / 空轨上：注入到落点镜头 */
  | { kind: "lane"; rowName: string | null; isLocation: boolean; el: HTMLElement }
  /** 落在镜头轨上：注入到落点镜头 */
  | { kind: "timeline"; el: HTMLElement }
  | null;

/** 行/段的 DOM 上挂的数据（渲染处写进去，这里读出来）。
 *
 *  ⚠️ 行名不能从 DOM 文本里抠（`.fw-at-rowname` 的显示文本可能被截断/改名），
 *  段名更不行（段画的是"角色·造型"的展示串）。一律走 `data-*`。 */
const DS = {
  rowName: "rowName",
  runId: "runId",
  runStageId: "runStageId",
  runStageName: "runStageName",
  runImage: "runImage",
  rowKind: "rowKind",
} as const;

/** 由命中元素定出落点种类。**只读 DOM，不发请求** —— 指针每帧都会调它。 */
export function assetDropTargetAt(hit: HTMLElement | null): AssetDropTarget {
  if (!hit) return null;

  // 1) 资产段（最具体）
  const runEl = hit.closest<HTMLElement>(".fw-at-run");
  if (runEl) {
    const rowEl = runEl.closest<HTMLElement>(".fw-at-row");
    const rowKind = rowEl?.dataset[DS.rowKind]
      ?? runEl.closest<HTMLElement>(".fw-at")?.dataset.rowKind ?? "";
    return {
      kind: "run",
      rowName: rowEl?.dataset[DS.rowName] ?? "",
      runId: runEl.dataset[DS.runId] ?? "",
      stageId: runEl.dataset[DS.runStageId] || undefined,
      stageName: runEl.dataset[DS.runStageName] || undefined,
      imageUrl: runEl.dataset[DS.runImage] || null,
      isLocation: rowKind === "location",
      el: runEl,
    };
  }

  // 2) 资产轨的行 / 空轨
  const laneEl = hit.closest<HTMLElement>(".fw-at-lane, .fw-at-empty");
  if (laneEl) {
    const rowEl = laneEl.closest<HTMLElement>(".fw-at-row");
    const rowKind = rowEl?.dataset[DS.rowKind]
      ?? laneEl.closest<HTMLElement>(".fw-at")?.dataset.rowKind ?? "";
    return {
      kind: "lane",
      rowName: rowEl?.dataset[DS.rowName] ?? null,
      isLocation: rowKind === "location",
      el: laneEl,
    };
  }

  // 3) 镜头轨（最泛）
  const tl = hit.closest<HTMLElement>(".fw-tl-lane[data-track-id]");
  if (tl) return { kind: "timeline", el: tl };

  return null;
}

/** 落点容器内的视口 x → 该容器的**内容坐标**秒。
 *
 *  `getBoundingClientRect().left` 给的是**可视区**左缘，而容器的内容随横向滚动
 *  左移了 `scrollLeft` —— 不把它加回去，用户往右拖、时间轴自动滚过一段之后，
 *  落点会越算越偏左。这正是旧 `AssetTrack.onLaneDrop` 里的算法。 */
export function secAtX(el: HTMLElement, clientX: number, pxPerSec: number): number {
  const r = el.getBoundingClientRect();
  return Math.max(0, (clientX - r.left) / pxPerSec);
}

export interface AssetDropCtx {
  projectId: string;
  shots: ShotInfo[];
  /** order → 绝对起始秒 */
  offsetMap: Map<number, number>;
  pxPerSec: number;
  onToast: (m: string) => void;
  onPushUndo: (label: string, undo: () => Promise<void>, redo: () => Promise<void>) => void;
  onChanged: () => void;
}

/** 落点 x → 哪个镜头。吸附到**包含该秒**的那一镜。
 *
 *  不用"最近起点"：10 秒的镜头上，「最近起点」会把右半边判给下一镜 —— 用户
 *  明明放在这一镜里，却注入了下一镜。所以先找"起点 ≤ sec 的最后一个"，
 *  只有落在时间轴最左端之外时才退回最近起点（给一个确定的落点，而不是拒绝）。 */
export function shotAtClientX(
  el: HTMLElement, clientX: number, ctx: AssetDropCtx,
): ShotInfo | null {
  const sec = secAtX(el, clientX, ctx.pxPerSec);
  const sorted = [...ctx.shots].sort((a, b) => a.order - b.order);
  let prev: ShotInfo | null = null;
  for (const s of sorted) {
    const start = ctx.offsetMap.get(s.order);
    if (start == null) continue;
    if (sec < start) break;
    prev = s;
  }
  if (prev) return prev;
  // 落在第一镜之前：退回最近起点
  let best: ShotInfo | null = null;
  let bestD = Infinity;
  for (const s of sorted) {
    const start = ctx.offsetMap.get(s.order);
    if (start == null) continue;
    const d = Math.abs(start - sec);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/**
 * 松手：按落点种类把资产交出去。**返回是否被接住** —— false = 拖到了空地，
 * 调用方据此提示。绝不允许静默失败：那正是这个 bug 的原始症状。
 */
export async function commitAssetDrop(
  target: AssetDropTarget, d: AssetDragData, clientX: number, ctx: AssetDropCtx,
): Promise<boolean> {
  if (!target) return false;

  if (target.kind === "run") {
    if (!target.rowName || !target.runId) return false;
    await replaceRunImage({
      projectId: ctx.projectId, rowName: target.rowName, d,
      run: { id: target.runId, stageId: target.stageId,
             stageName: target.stageName, imageUrl: target.imageUrl },
      isLocation: target.isLocation,
      onPushUndo: ctx.onPushUndo, onToast: ctx.onToast, onChanged: ctx.onChanged,
    });
    return true;
  }

  const shot = shotAtClientX(target.el, clientX, ctx);
  if (!shot) { ctx.onToast("请拖到某个镜头上方"); return true; }

  // 行名：资产轨上有行就用行名（拖的是"这个角色/场景"），没有就用卡片自己的名字。
  const name = target.kind === "lane" ? (target.rowName ?? d.name) : d.name;
  if (!name) { ctx.onToast("这条轨需要先有角色/场景行"); return true; }

  await injectAssetIntoShot({
    projectId: ctx.projectId, name,
    isLocation: target.kind === "lane" ? target.isLocation : d.kind === "location",
    shot, order: shot.order,
    onPushUndo: ctx.onPushUndo, onToast: ctx.onToast, onChanged: ctx.onChanged,
  });
  return true;
}

/** 落点容器对应的高亮元素（给 `pointerDrag` 的 `hotTarget` 用）。 */
export function assetHotElement(t: AssetDropTarget): HTMLElement | null {
  return t ? t.el : null;
}
