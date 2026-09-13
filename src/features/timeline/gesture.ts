/**
 * features/timeline/gesture.ts — 时间轴上"按住拖"的手势底噪层（3.12）
 *
 * ## 它解决什么
 *
 * 3.11 把**主轨片段换位**和**资产卡拖入轨道**迁到了 `pointerDrag.ts`，但时间轴上
 * 还有八处拖拽仍是老写法：`mousedown` + `window.mousemove` + 每帧 `setState`。
 * 老写法的三个毛病与通道无关，是结构性的：
 *
 *  1. **不经 rAF 合并**：鼠标一秒能发 100+ 次 `mousemove`，触发多少次就 setState
 *     多少次。1424 镜的项目上每帧重渲整棵树 —— 用户报的"不跟手、来回闪烁"。
 *  2. **松手先清预览再等网络**：`setPreviewXxx(null)` 写在 `await p.onPatch(...)`
 *     **前面**。预览一清，块立刻按**服务端旧值**重画；等 PATCH + `refreshDetail()`
 *     回来才跳到新位置。这就是"松手时突然移动"的第二个来源（第一个来源是
 *     3.10 那套"按落点重画"，已由 pointerDrag 修掉）。
 *  3. **没有取消路径**：拖错了只能松手、吃一条 undo，再拖回来。Esc 无效。
 *
 * ## 为什么不都用 `startDrag`
 *
 * `pointerDrag.ts` 服务的是"**块在自由移动**"这一类手势：它要算连续位移、
 * 算落点槽位、可能跟随滚动。而修剪、拖边缘、框选、拖播放头这些手势的
 * 语义是"**把一个标量映射成秒数**"，没有落点概念，且预览形式各不相同
 * （改 left / 改 width / 改 transform）。硬塞进 `startDrag` 只会长出五个
 * 布尔开关。所以这里只抽**共同的那层底噪**，预览怎么画交给调用方。
 *
 * ## 与 pointerDrag 一致的三条规矩
 *
 *  · 监听挂 `window` + **捕获**阶段（划出窗口也能收到 `pointerup`，
 *    否则手势会永久卡住）；
 *  · 每帧最多算一次、最多写一次（`onFrame`）；
 *  · **松手先提交、后收尾**：`onCommit` 返回的 Promise 落定之后才调 `onSettle`。
 *
 * ## 为什么是轮询 `pointerdown` 而不是 `mousedown`
 *
 * WebView2 宿主装了一个 OS 级 `IDropTarget` 来收"从资源管理器拖文件进来"，
 * 它按 OS 的规矩接管拖放 —— 页内 HTML5 DnD 因此完全失效（见 pointerDrag.ts
 * 头注释）。Pointer 事件走的是另一条通道，宿主不接管。老代码里这些手势
 * "能用"只是因为它们本来就是 `mousedown`+`mousemove`、没用 HTML5 DnD，
 * 但既然要重写，统一到 pointer 通道可以少一条心智负担，也顺带拿到
 * `pointerId`/`pointercancel`（触摸/笔）。
 */

/** 一次手势的公共状态。`cancelled` 供 `onFrame` 提前收手。 */
export interface GestureCtx {
  /** 指针当前视口坐标 */
  clientX: number;
  clientY: number;
  /** 相对按下点的原始位移（像素，未量化、未吸附） */
  dx: number;
  dy: number;
  /** 按下时是否真的越过了 `thresholdPx`（见 `beginGesture`） */
  moved: boolean;
  /** 已取消（Esc / pointercancel）—— `onFrame` 里若已做了 DOM 预览，
   *  不必自己判断，`onSettle` 一定会跑。 */
  cancelled: boolean;
}

export interface GestureHooks {
  /** 每帧最多一次（已用 rAF 合并）。**这里只该做轻量的事**：
   *  直接改 DOM 样式、或写入一个已经做过等值短路的局部队列。
   *  写 React state 之前先问一句"真的变了吗"——每秒 60~120 次的
   *  setState 正是"拖不动"的成因。 */
  onFrame: (ctx: GestureCtx) => void;
  /** 松手。返回值会被 `await`；**落定之后才调 `onSettle`**。
   *  `moved === false` 时（纯点击）也会调，调用方自行决定要不要发请求。 */
  onCommit: (ctx: GestureCtx) => void | Promise<void>;
  /**
   * 收尾：清预览、复位内联样式、松光标。
   *
   * ⚠️ **它一定在 `onCommit` 的 Promise 落定之后**才跑，这是这个模块存在的
   * 首要理由。预览若在 `await` 之前就清掉，元素会先按**服务端旧值**重画
   * 一次、等刷新回来再跳一次 —— 就是"松手来回闪"。写在这里意味着：
   * 要么预览一直挂到新数据到位（下一帧 React 用新值重画，预览清掉看不出变化），
   * 要么提交失败（`onCommit` 抛错也会走到这里），预览被丢弃、回到事实。
   *
   * 无论提交成功、失败、还是被 Esc 取消，它都**恰好跑一次**。 */
  onSettle: (ctx: GestureCtx) => void;
  /** 位移阈值（像素）。低于它按"点击"处理，`moved` 保持 false。
   *  默认 0：时间轴上这些手势都是"按下去就是为了拖"，
   *  加阈值反而会让前几像素的微调被吞掉。需要区分点击/拖动的调用方
   *  （如资产卡）自己传 `DRAG_THRESHOLD_PX`。 */
  thresholdPx?: number;
  /** 手势期间光标形状。缺省 `grabbing`；收尾时自动复位成按下前的样子。
   *  修剪类手势传 `ew-resize`。 */
  cursor?: string;
}

/**
 * 起一次手势。**同步**完成，在 `pointerdown` 里直接调即可。
 *
 * 不返回任何东西：需要外部取消（如组件卸载）的场景，用 `cancelAllGestures()`。
 */
export function beginGesture(down: PointerEvent, hooks: GestureHooks): void {
  const threshold = hooks.thresholdPx ?? 0;
  const x0 = down.clientX;
  const y0 = down.clientY;

  let raf = 0;
  let pending: PointerEvent | null = null;
  let finished = false;
  let movedOnce = false;
  let cancelled = false;

  const ctxOf = (e: { clientX: number; clientY: number }): GestureCtx => ({
    clientX: e.clientX,
    clientY: e.clientY,
    dx: e.clientX - x0,
    dy: e.clientY - y0,
    moved: movedOnce,
    cancelled,
  });

  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;

  const paint = () => {
    raf = 0;
    if (!pending || finished) return;
    const ctx = ctxOf(pending);
    pending = null;
    hooks.onFrame(ctx);
  };

  const schedule = (e: PointerEvent) => {
    pending = e;
    if (!raf) raf = requestAnimationFrame(paint);
  };

  const teardown = () => {
    finished = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    pending = null;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancelEv, true);
    window.removeEventListener("keydown", onKey, true);
    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
  };

  function onMove(e: PointerEvent) {
    if (finished) return;
    if (threshold > 0 && !movedOnce) {
      if (Math.abs(e.clientX - x0) < threshold && Math.abs(e.clientY - y0) < threshold) return;
      movedOnce = true;
    }
    schedule(e);
  }

  function onUp(e: PointerEvent) {
    if (finished) return;
    // 松手前把最后一帧算完：rAF 还差一拍没跑的话，提交用的会是**上一帧**的值，
    // 表现为"我明明拖到这里了，它却按前一点的位置存"（与 pointerDrag.onUp 同理）。
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (pending) {
      const ctx = ctxOf(pending);
      pending = null;
      hooks.onFrame(ctx);
    }
    const ctx = ctxOf(e);
    teardown();
    let ret: void | Promise<void>;
    try {
      ret = hooks.onCommit(ctx);
    } catch {
      // onCommit 同步抛出（极少见，但调用方写的是 async 函数、可能在校验时就 throw）
      // → 仍然要收尾，否则预览会永远挂在屏幕上。
      hooks.onSettle(ctx);
      return;
    }
    if (ret && typeof (ret as Promise<void>).then === "function") {
      void (ret as Promise<void>).then(
        () => hooks.onSettle(ctx),
        () => hooks.onSettle(ctx),
      );
    } else {
      hooks.onSettle(ctx);
    }
  }

  function onCancelEv() {
    if (finished) return;
    cancelled = true;
    teardown();
    hooks.onSettle(ctxOf({ clientX: x0, clientY: y0 }));
  }

  /** Esc 取消：预览归位、**不发任何请求**（也就不进 undo 栈）。 */
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onCancelEv();
  }

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancelEv, true);
  window.addEventListener("keydown", onKey, true);

  // 光标：起手就换、收尾复位。放在监听之后设，是为了让"这一行抛异常"
  // 不会留下一个改过光标的、却没有任何监听在跑的状态。
  document.body.style.cursor = hooks.cursor ?? "grabbing";
}

/* ------------------------------------------------------------------ *
 * 内联样式预览：拖动期间直接改 DOM，收尾时一次清干净
 *
 * 为什么不走 React：这几处预览（片段左移、变宽、变窄）如果经 state 走，
 * 每秒上百次 setState 会重渲整棵轨道树。而它们全都是**同一个元素的一个属性**，
 * 直接写 style 只触发一次样式重算，且不碰 diff。
 *
 * `reset()` 会把这三个属性都清回空串，让 React 渲染时的内联值重新生效 ——
 * 前提是收尾发生在**新数据已经落到 DOM 之后**（见 GestureHooks.onSettle）。
 * ------------------------------------------------------------------ */

/** 给一个元素装上"拖动期直接改样式"的手柄。元素不在（被虚拟化掉）就返回 no-op。 */
export function stylePreview(el: HTMLElement | null) {
  if (!el) {
    return { shiftPx: (_px: number) => {}, widthPx: (_px: number) => {}, reset: () => {} };
  }
  return {
    /** 水平平移（只改 transform，不动布局） */
    shiftPx(px: number) {
      el.style.transform = `translate3d(${Math.round(px * 100) / 100}px, 0, 0)`;
    },
    /** 改宽度（修剪）+ 可选平移。宽度用 px 而不是百分比：
     *  时间轴上每一格的位置本来就都是 `秒 × pxPerSec` 算出来的 px。 */
    widthPx(px: number, shift = 0) {
      el.style.width = `${Math.max(4, Math.round(px))}px`;
      el.style.transform = shift
        ? `translate3d(${Math.round(shift * 100) / 100}px, 0, 0)`
        : "";
    },
    reset() {
      el.style.transform = "";
      el.style.width = "";
    },
  };
}

/** 找片段元素。`clipId` 是 `Clip.id`，渲染时落在 `data-clip-id` 上。 */
export function clipEl(clipId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.fw-clip[data-clip-id="${clipId}"]`);
}
