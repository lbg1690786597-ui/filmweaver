/**
 * virtual.ts — 时间轴横向虚拟化的纯逻辑（3.10）
 *
 * 抽出来的理由与 `selection.ts` / `waveform.ts` 同：判据要能在 node 下直接跑断言，
 * 而 `Timeline.tsx` 里全是 DOM 与滚动。
 *
 * ## 要解决的是什么
 *
 * 现在**每一个片段都挂在 DOM 里**：1424 镜的项目就是 1424 个 `.fw-clip`，
 * 每个里面还有 `<img>` / 角标 / 两个 trim 手柄（音频轨还各带一块 canvas）。
 * 于是：
 *
 * · **Ctrl+滚轮缩放**每挡都要把这 1424 个元素的 `left`/`width` 全部重算 + 重排。
 *   缩放是连续动作（一次滚轮好几挡），于是每挡都掉帧，手感是"拖泥带水"。
 * · 不只是缩放。`Timeline` 订阅了整个 store，**播放头一动**（播放时 4Hz、
 *   拖动刻度尺时每帧）也会重渲整棵树。
 * · ⚠️ `ClipView` 外面那层 `memo` 在这里**几乎不起作用**：`onSelect` / `onBeginMove`
 *   等 6 个回调都是在 `.map()` 里现建的箭头函数，每次渲染引用都新，
 *   `memo` 的浅比较必然失败。这不是本条要修的（改成稳定回调要重构那一大坨
 *   闭包，风险与收益不成正比），但**虚拟化之后它就不再要紧**：
 *   要重渲的从 1424 个变成几十个。这件事记在这里，免得日后有人看到 `memo`
 *   就以为已经挡住了。
 *
 * ## 三条把"虚拟化"从提速变成静默出错的陷阱
 *
 * **① 轨道宽度必须保持满宽。** 只渲染看得见的片段，但 `.fw-tl-lane` 的
 * `width: totalWidth` 一个像素都不能少 —— 3.3 的播放头跟随滚动读的是
 * `el.scrollWidth`，宽度一塌，滚动条和跟随落点跟着一起塌。
 *
 * **② 判可见要用「画出来的宽度」，不是「逻辑宽度」。** `ClipView` 里写的是
 * `Math.max(18, dur * pxPerSec)`：0.2 秒的片段在 4px/s 下逻辑宽 0.8px，
 * 实际画 18px。按逻辑宽度剔除，它会在视口左边缘"该露出一截却没有"。
 * 故 `clipSpanPx` 与 `ClipView` 共用同一个 `MIN_CLIP_PX`。
 *
 * **③ 正在拖的那个不能被剔掉。** 拖动过程里片段可能被拖出视口（或视口被
 * 拖着滚走），此时它一旦卸载，拖动预览（半透明、落点高亮、实时读数）就没了 ——
 * 拖拽本身不会断（监听挂在 window 上），所以这属于**不报错的**那类坏：
 * 用户看见片段凭空消失，松手它又回来了。故 `visibleClips` 收一个 `keep` 集合。
 *
 * ## 为什么是线性扫描，不是二分
 *
 * 虚拟化省的是**创建 React 元素 + DOM 节点 + 布局**，不是省那几次数值比较。
 * 1424 次浮点比较是微秒级的，1424 个 DOM 节点是几十毫秒级的。
 * 而二分要求 `clips` 按 `startSec` 有序 —— 主轨确实有序（`buildTimeline` 按
 * order 排过），但字幕轨/音频轨是**按后端返回顺序推进去的**，没有任何地方保证
 * 有序。在无序数组上二分不会报错，只会**少渲染一些片段**，而且是随机的、
 * 与滚动位置有关的少，属于最难查的一类 bug。用不着为微秒去换这个风险。
 */

/** 与 `ClipView` 的 `Math.max(18, dur * pxPerSec)` 同源。两处各写一份必然漂移。 */
export const MIN_CLIP_PX = 18;

/** 接缝标记（`.fw-tl-seam`）宽 18px 且 `translateX(-50%)`，故按中心 ±9 算。 */
export const SEAM_HALF_PX = 9;

/**
 * 视口外多渲染多少像素。
 *
 * 取 600 是为了让**滚轮的一次惯性滑动**基本落在已渲染区里：太小则滚动时能看到
 * 片段"追着补上来"，太大则白渲染。它同时兜住了陷阱 ②（哪怕 min-width 变大）。
 */
export const OVERSCAN_PX = 600;

/**
 * 视口量化粒度。
 *
 * **不量化的话虚拟化会自伤**：`scroll` 每帧都在变，每帧 setState 一次，
 * 省下的渲染被 setState 触发的重渲原样还回去，还多了一堆状态更新。
 * 量化后，在同一个 300px 桶里滚动**一次 state 都不写**。
 */
export const BUCKET_PX = 300;

/**
 * 还没量出视口宽度时的兜底宽度。
 *
 * ⚠️ 这里**不能返回空区间**。首帧 `scrollRef.current` 还是 null，若此时算出
 * "什么都不可见"，用户看到的是一条空时间轴 —— 而 `useLayoutEffect` 量完要等到
 * 下一次渲染才补上。宁可首帧多画一屏。
 */
export const FALLBACK_VIEW_PX = 1600;

/** 量化后的视口（内容坐标系，含轨道头那段 gutter）。 */
export interface Viewport { scrollLeft: number; widthPx: number }

/** 可见区间（**lane 内**的像素坐标，即 `left` 的坐标系）。 */
export interface SpanRange { fromPx: number; toPx: number }

/**
 * 把真实滚动位置量化成桶。
 *
 * 左边缘**向下**取整、宽度**向上**取整并多留一个桶，保证量化后的区间
 * 永远**完全覆盖**真实视口（`bucket.left ≤ real.left` 且
 * `bucket.right ≥ real.right`）—— 覆盖不住就会在滚动到桶边界时缺一条。
 */
export function bucketViewport(scrollLeft: number, widthPx: number): Viewport {
  const w = widthPx > 0 ? widthPx : FALLBACK_VIEW_PX;
  const sl = scrollLeft > 0 ? scrollLeft : 0;
  return {
    scrollLeft: Math.floor(sl / BUCKET_PX) * BUCKET_PX,
    // +BUCKET_PX 补掉左边缘向下取整丢的那一截，再向上取整到整桶
    widthPx: Math.ceil((w + BUCKET_PX) / BUCKET_PX) * BUCKET_PX,
  };
}

/** 两个视口是否等价（用来决定要不要 setState —— 相等就别写）。 */
export function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.scrollLeft === b.scrollLeft && a.widthPx === b.widthPx;
}

/**
 * 视口 → lane 内可见区间。
 *
 * `gutterPx`：轨道头是 flex 里的第一项（sticky），lane 的 `left=0` 落在内容坐标
 * `gutterPx` 处，所以要减掉。**不建模"sticky 轨道头盖住了最左边那段"** ——
 * 那只会让最左边多渲染 68px 的片段，不值得为它引入一个会算错的边界。
 */
export function visibleSpan(
  vp: Viewport, gutterPx: number, overscanPx: number = OVERSCAN_PX,
): SpanRange {
  const base = vp.scrollLeft - gutterPx;
  return { fromPx: base - overscanPx, toPx: base + vp.widthPx + overscanPx };
}

/** 片段在 lane 内占的像素区间 `[左, 右]`，**含** `ClipView` 的最小宽度兜底。 */
export function clipSpanPx(
  startSec: number, durSec: number, pxPerSec: number,
): [number, number] {
  const left = startSec * pxPerSec;
  const w = Math.max(MIN_CLIP_PX, durSec * pxPerSec);
  return [left, left + w];
}

/** 以某一秒为中心、半宽 `halfPx` 的标记（接缝菱形之类）占的区间。 */
export function pointSpanPx(
  sec: number, pxPerSec: number, halfPx: number,
): [number, number] {
  const c = sec * pxPerSec;
  return [c - halfPx, c + halfPx];
}

/** 区间相交即可见。**闭区间**：贴边的那一个要留着，不然边缘会缺一格。 */
export function inSpan(s: [number, number], r: SpanRange): boolean {
  return s[1] >= r.fromPx && s[0] <= r.toPx;
}

/** `visibleClips` 认得的最小片段形状（不依赖 types/timeline，方便单测造夹具）。 */
export interface SpannedClip {
  id: string;
  startSec: number;
  durationSec: number;
}

/**
 * 挑出该渲染的片段。
 *
 * @param keep 无论在不在视野里都必须留着的 id（正在拖动/修剪的那个，见陷阱 ③）。
 *   ⚠️ 传进来的 id 若已被卸载/不存在，**不凭空造元素** —— 这里只做过滤。
 */
export function visibleClips<T extends SpannedClip>(
  clips: readonly T[], pxPerSec: number, r: SpanRange,
  keep?: ReadonlySet<string> | null,
): T[] {
  const out: T[] = [];
  for (const c of clips) {
    if ((keep && keep.has(c.id))
      || inSpan(clipSpanPx(c.startSec, c.durationSec, pxPerSec), r)) {
      out.push(c);
    }
  }
  return out;
}

/**
 * 刻度尺该画第几到第几根刻度。
 *
 * 刻度尺也得虚拟化：`TimelineRuler` 按 `totalSec / step + 1` 建 div，
 * 7120 秒的片子在最大缩放下 step=1s → **7121 根**主刻度（外加次级刻度），
 * 和片段是同一个量级的问题。
 *
 * @returns `[i0, i1)`，左闭右开；`count` 是总根数，用来夹住右端。
 */
export function tickIndexRange(
  r: SpanRange, stepPx: number, count: number,
): [number, number] {
  if (!(stepPx > 0) || count <= 0) return [0, 0];
  const i0 = Math.max(0, Math.floor(r.fromPx / stepPx));
  if (i0 >= count) return [count, count];   // 整段都在视口左边
  // +1：右端那根的标签是往右伸的，少画一根会在滚动时看到标签"闪出来"
  const i1 = Math.min(count, Math.floor(r.toPx / stepPx) + 2);
  return [i0, Math.max(i0, i1)];
}
