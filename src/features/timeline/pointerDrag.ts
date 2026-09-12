/**
 * features/timeline/pointerDrag.ts — 页内拖拽的**唯一**实施通道（3.11 P1）
 *
 * ## 为什么页内拖拽必须离开 HTML5 DnD
 *
 * Tauri v2 的 `dragDropEnabled` 默认为 `true`，在 WebView2 上给窗口装了一个
 * 操作系统级的 `IDropTarget`。它按 OS 的规矩接管指针：**任何**拖放一开始，
 * 指针形态就由宿主决定，页面的 `dragstart` / `dragover` / `drop` 拿不到话事权。
 *
 * 用户真机反馈是判据：「**无论怎么拖动光标都是禁止**」。页内 DnD 里光标是
 * 拖放目标给的 —— 只要 `onDragOver` 跑到了 `dropEffect = "copy"`，光标一定
 * 变成「复制」。永远不变 ⇒ lane 的 `onDragOver` **一次都没执行过** ⇒ 事件在
 * React 之前就被截了。所以这不是"再修一遍逻辑"能解决的，是**通道选错了**。
 *
 * 而宿主拖放**不能关**：从资源管理器拖文件进软件是用户点名的必需功能，
 * 它依赖的就是宿主（那是唯一能拿到**文件路径**的通道，见 `desktop/osDrop.ts`）。
 *
 * ⇒ 页内拖拽改走 **Pointer Events**：`pointerdown`/`pointermove`/`pointerup`
 * 走的是另一条通道，宿主拖放不接管它。证据是同一个窗口里播放头拖动、面板
 * 分隔条、片段边缘修剪**本来就能用**（都是 `mousedown`+`mousemove`），
 * 用户从没抱怨过它们"点不动"。能用的和不能用的，恰好就是这条分界线。
 *
 * ## 两条语义铁律（§1.2.3 的四个症状全部由此消除）
 *
 * 3.10 的主轨拖动把"块在哪"和"落点在哪"压在同一个 `order` 上，于是同时
 * 长出四个毛病：看不到拖动位置（order 没变就整帧早退）、不跟手（位移被
 * 量化到**这个片段自己的宽度**）、松手才突然移动（提交发生在 onUp）、
 * 来回闪（每帧两次 setState + 不校验 id 的旧预览值）。
 *
 * 这一版把它们拆成两件互不干涉的事：
 *
 *   · **块**：连续。`continuousOffsetPx`（dragGeom.ts）就是指针位移本身，
 *     直接写进 `transform: translate3d()` —— **不经 React state、不经量化**。
 *     一帧一次 reflow，不触发 diff，所以"跟手"是结构性的，不是调出来的。
 *   · **落点**：离散。`targetSlotAt` 把"块中心停在哪一秒"换算成槽序号，
 *     只驱动两件事：松手时提交哪个 order、时间轴上哪一格亮起落点提示。
 *
 * ## 为什么不把拖动状态放进 React
 *
 * `pointermove` 每秒 60~120 次。每次 setState 都会重渲整棵轨道树（170 镜的
 * 项目里是上千个节点），Windows 上抖动会被放大 —— "来回闪烁"的第三个成因
 * 就是它。所以拖动**期间**只有两样东西变：元素的 transform（直接改 style）、
 * 以及落点指示器（`onFrame` 里也只碰那两个节点）。React 完全不知道在拖动，
 * 直到松手那一次提交。
 *
 * ## 松手才提交
 *
 * 服务端永远是唯一事实来源，拖动过程**零副作用** —— 中途取消不会在 undo 栈
 * 里留下噪声（旧实现里拖错一次要按两次 Ctrl+Z 才回得去）。
 */

import {
  buildSlots,
  continuousOffsetPx,
  centerSecOf,
  targetSlotAt,
  autoScrollStep,
  scrollCompensatedSec,
} from "./dragGeom";
import type { Slot } from "./dragGeom";

/** 拖动意图。生命周期完全一致，只是松手后干的事不同。 */
export type DragIntent = "move" | "asset";

export interface DragSession {
  intent: DragIntent;
  /** 被拖的元素本身；move 时是 `.fw-clip`。它会被直接改 transform。 */
  el: HTMLElement | null;
  /** 跟随指针的浮层（调用方自己建）。**必须 `pointer-events: none`**，
   *  否则它会挡住 `elementFromPoint`，命中判定永远落回它自己。
   *
   *  ⚠️ 与 `label` 二选一：给了 `label` 就由 `startDrag` 自己造浮层
   *  （见 `makeGhost`），调用方不用管。 */
  ghost?: HTMLElement | null;
  /** 想让指针尾巴上跟着的那行字（如资产名）。给了它 `startDrag` 会自建浮层。 */
  label?: string;
  /** 指针按下点 */
  x0: number;
  y0: number;
  /** 拖动开始那一刻的滚动位置（把指针换算回"冻结坐标系"要用） */
  scroll0: { left: number; top: number };
  /** 滚动容器（自动滚动的目标）。没有则不自动滚。 */
  scroller: HTMLElement | null;
  /** 当前缩放。拖动期间不会变，量一次即可。 */
  pxPerSec: number;
  /** move 专用：被拖的镜头 */
  shotId?: string;
  fromOrder?: number;
  /** move 专用：该片段的静止起点与时长（算"块中心"要用） */
  startSec?: number;
  durSec?: number;
  /** move 专用：有序槽位表（`buildSlots(buildOrderOffsetMap, durations)`） */
  slots?: Slot[];
  /** asset 专用：调用方的不透明数据，原样还给 onCommit */
  data?: unknown;
}

export interface DragResult {
  /** 连续位移（像素，未量化）—— 块的位置就读它 */
  offsetPx: number;
  /** 指针下的轨道 id；不在任何轨道上为 null */
  trackId: string | null;
  /** 指针落在哪个镜头格上（`elementFromPoint` 命中 `.fw-clip`），没有则 null */
  overShotId: string | null;
  /** 指针端的**视口坐标**（`onCommit` 里再读 `PointerEvent` 不可靠：落点判定
   *  往往要 `await` 一次网络往返，事件早就不是"当前"的了）。 */
  clientX: number;
  clientY: number;
  /**
   * asset 专用：松手时指针**真正**落在哪个元素上。
   *
   * 资产要落到三类互不相同的目标上，而且优先级还不一样（段 > 行 > 轨道）：
   *   · `.fw-at-run`   —— 资产段，落上去 = 换这套造型的参考图；
   *   · `.fw-tl-lane[data-track-id]` / `.fw-at-row` —— 轨道，落上去 = 注入镜头。
   * 让 `pointerDrag` 逐类去认这些类名，等于把"资产语义"漏进一个几何模块；
   * 所以这里只把命中元素原样交出去，**由资产侧的调用方自己 `closest()`**。
   * `overShotId` 是它已经认识的唯一一种命中（move 用），保持原样不动。
   */
  hit: HTMLElement | null;
  /** move 专用：落点槽序号（离散，只用于指示与提交）；非 move 为 null */
  toOrder: number | null;
}

export interface DragHooks {
  /** 松手（且真的拖动过）。提交在这里，只此一次。 */
  onCommit: (s: DragSession, r: DragResult) => void;
  /** Esc 取消 / 位移不足没构成拖动：什么都不提交，调用方只需清理自己的预览 */
  onCancel: (s: DragSession) => void;
  /** 每帧一次（已用 rAF 合并）。只用来更新轻量的落点提示。 */
  onFrame?: (s: DragSession, r: DragResult) => void;
  /**
   * 想让哪个元素每帧亮起"放到这里"（`fw-drop-hot` class）？返回 null 全灭。
   *
   * 只对**变化**做增删 —— 见 `paint`。默认不亮任何东西：`move` 的落点提示
   * 是"哪一格要让位"，那是 React 管的（它要知道具体是哪个 `order`），
   * 一个 class 表达不了。资产拖拽才用它（"整条轨道会接住"）。
   */
  hotTarget?: (r: DragResult) => HTMLElement | null;
}

/** 指针位移超过这么多像素才算"拖动"，否则按点击处理（框选/选中照旧） */
export const DRAG_THRESHOLD_PX = 4;

/** 拍掉浮点毛刺，避免给 transform 写一长串没意义的精度 */
const round = (n: number) => Math.round(n * 100) / 100;

/** 从元素往上找滚动容器（自动滚动的目标） */
export function nearestScroller(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.classList.contains("fw-tl-scroll")) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * 自建跟随浮层：一个小标签挂在 `<body>` 上。
 *
 * 为什么不用 `el.cloneNode()` 当浮层（很多库的做法）：克隆出来的是整块片段
 * （缩略图 + 波形 + 角标），在光标下反而挡住**将要落上去的那一格**，
 * 而且每个 `pointermove` 都要重排它。用户拖动时想看的是"我要插到哪"，
 * 不是"我手里这块长什么样"—— 手里那块已经在原地跟着 `transform` 走了。
 *
 * 坐标是 `fixed` + `translate3d`：拖动每秒上百帧，用 `left/top` 会逐帧
 * 触发布局计算，`transform` 只在合成层。
 */
function makeGhost(label: string): HTMLElement {
  const g = document.createElement("div");
  g.className = "fw-drag-ghost";
  g.textContent = label;
  // 样式全在 `.fw-drag-ghost`（Timeline.css），这里只管位置。
  // 内联一份颜色/字号会与主题 token 打架（暗色主题下白字压浅底就看不见了），
  // 而且 `--fs-scale`（界面字号乘子）对内联的 px 不生效。
  g.style.transform = "translate3d(-9999px, -9999px, 0)";  // 首帧定位前先放到屏外
  document.body.appendChild(g);
  return g;
}

/**
 * 起一次拖动。**同步**完成 —— 在 `pointerdown` 里直接调，不必等任何异步。
 *
 * 监听挂在 `window` 上并用**捕获**阶段：指针划出窗口/划到别的元素上时，
 * 事件照样能收到，`pointerup` 不会丢。丢掉 `pointerup` 的后果不是"拖动没生效"，
 * 是覆盖层永久挂在屏幕上 —— 这是该类实现最常见的翻车点。
 *
 * 位移不足 `DRAG_THRESHOLD_PX` 就松手 = **按点击处理**（走 `onCancel`）。
 * 这一点是"卡片既要点开详情、又要能拖走"的前提：不能因为加了拖拽就让
 * 点击失灵。阈值与浏览器原生的 DnD 起手阈值（5px）同量级。
 */
export function startDrag(s: DragSession, hooks: DragHooks): void {
  let started = false;   // 越过阈值没有
  let finished = false;
  let raf = 0;
  let pending: PointerEvent | null = null;
  /** 自建浮层（`s.label` 存在且越过阈值之后才造，见下面的 onMove） */
  let ghost = s.ghost ?? null;
  let ownGhost = false;
  /** 上一帧命中的"落点容器"，用来只对**变化**做增删 class（见 paint） */
  let hotEl: HTMLElement | null = null;

  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;
  const scroller = s.scroller;

  /** 命中判定 + 自动滚动。只写 DOM 与局部变量，一个 setState 都没有。 */
  const compute = (ev: PointerEvent): DragResult => {
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const step = autoScrollStep(ev.clientX, box.left, box.right);
      if (step) {
        scroller.scrollLeft += step;
      }
    }
    const scrolledX = (scroller?.scrollLeft ?? 0) - s.scroll0.left;
    const scrolledY = (scroller?.scrollTop ?? 0) - s.scroll0.top;

    // ghost 是 pointer-events:none，所以命中一定落在它下面的真实元素上
    const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const lane = hit?.closest(".fw-tl-lane[data-track-id]") as HTMLElement | null;
    const overShotId = hit?.closest(".fw-clip") instanceof HTMLElement
      ? (hit!.closest(".fw-clip") as HTMLElement).dataset.shotId ?? null
      : null;

    const offsetPx = continuousOffsetPx(ev.clientX, s.x0);

    let toOrder: number | null = null;
    if (s.slots && s.slots.length && s.durSec != null && s.startSec != null) {
      // 落点用"块**中心**停在哪一秒"，不是指针位置 —— 用户可能就在左边缘按下的，
      // 用指针位置算会让块头已进下一槽、块尾还在上一槽，松手后视觉回跳半个身位。
      const center = centerSecOf(s.startSec, s.durSec, offsetPx, s.pxPerSec);
      // 滚动补偿：不扣掉滚走的量的话，"滚一点 → 指针前进一点 → 落点催着再滚"
      // 会变成自我加速的死循环。
      toOrder = targetSlotAt(
        s.slots,
        scrollCompensatedSec(center, scrolledX, s.pxPerSec),
        s.fromOrder ?? 1,
      );
    }

    void lane; void scrolledY;
    return {
      offsetPx,
      trackId: lane?.dataset.trackId ?? null,
      overShotId,
      clientX: ev.clientX,
      clientY: ev.clientY,
      hit,
      toOrder,
    };
  };

  const paint = () => {
    raf = 0;
    if (!pending || finished) return;
    const ev = pending;
    const r = compute(ev);
    // 块跟手：**直接改 transform**，不经 React、不量化、不早退。
    if (s.el) s.el.style.transform = `translate3d(${round(r.offsetPx)}px, 0, 0)`;
    if (ghost) {
      ghost.style.transform =
        `translate3d(${round(ev.clientX + 12)}px, ${round(ev.clientY + 14)}px, 0)`;
    }
    // 落点高亮：只对**变化的那个容器**增删 class。
    // 每帧给全部候选 `closest()` 一遍再统一清理，是每帧几十次 DOM 查询 + 写；
    // 记住上一帧命中的那一个，绝大多数帧里两者是同一个（指针没跨容器），
    // 于是这些帧**一次 DOM 写都没有**。
    const hot = hooks.hotTarget?.(r) ?? null;
    if (hot !== hotEl) {
      hotEl?.classList.remove("fw-drop-hot");
      hot?.classList.add("fw-drop-hot");
      hotEl = hot;
    }
    hooks.onFrame?.(s, r);
  };

  const schedule = (ev: PointerEvent) => {
    pending = ev;
    if (!raf) raf = requestAnimationFrame(paint);
  };

  const onMove = (e: PointerEvent) => {
    if (finished) return;
    if (!started) {
      if (Math.abs(e.clientX - s.x0) < DRAG_THRESHOLD_PX
          && Math.abs(e.clientY - s.y0) < DRAG_THRESHOLD_PX) return;
      started = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = s.intent === "move" ? "grabbing" : "copy";
      // 越过阈值才造浮层：单纯点一下没拖（占绝大多数按下）不该在页面上
      // 闪一个标签出来。
      if (!ghost && s.label) { ghost = makeGhost(s.label); ownGhost = true; }
    }
    schedule(e);
  };

  const cleanupVisual = () => {
    if (s.el) s.el.style.transform = "";
    if (ghost) ghost.style.transform = "";
    if (ownGhost && ghost) ghost.remove();
    hotEl?.classList.remove("fw-drop-hot");
    hotEl = null;
  };

  const teardown = () => {
    finished = true;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancelEv, true);
    window.removeEventListener("keydown", onKey, true);
    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
  };

  const onUp = (e: PointerEvent) => {
    if (finished) return;
    // 松手前把最后一帧算完：rAF 还有一拍没跑的话，落点会停在**上一帧**的位置，
    // 用户看到的就是"我明明放到这里了，它却插到了前一格"。
    const r = compute(e);
    teardown();
    cleanupVisual();
    if (!started) { hooks.onCancel(s); return; }
    hooks.onCommit(s, r);
  };

  const onCancelEv = () => {
    if (finished) return;
    teardown();
    cleanupVisual();
    hooks.onCancel(s);
  };

  /** Esc 取消：归位、**不发任何请求**。旧实现没有取消路径，拖错了只能松手
   *  再拖回来，各自吃一条 undo。 */
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onCancelEv();
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancelEv, true);
  window.addEventListener("keydown", onKey, true);
}

/** 由 `order → startSec` 与 `order → durationSec` 造出拖动的槽位表。
 *  单独抽一个函数是为了让"时长缺失"的坑只有一处（见 dragGeom.buildSlots）。 */
export function slotsOf(
  offsets: Map<number, number>,
  durations: Map<number, number>,
): Slot[] {
  return buildSlots(offsets, durations);
}
