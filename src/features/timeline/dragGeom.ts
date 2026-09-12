/**
 * features/timeline/dragGeom.ts — 拖动几何的纯计算（3.11）
 *
 * ## 为什么必须在拖动开始前把"块"和"落点"拆成两件事
 *
 * 3.10 之前，主轨拖动（`Timeline.beginMove`）把两者**压在同一个变量**上：
 * 位置由 `order` 决定，落点也是 `order`。于是：
 *
 *   · `order` 没变 → 整帧早退（`if (next === latest) return`）→ 块不动 →
 *     用户「**看不到拖动位置**」；
 *   · 位移先量化成槽再换算回来（`round(Δx / slotPx)`，而 `slotPx` 是**这个
 *     片段自己的宽度**）→ 长片段拖不动、短片段一碰跨好几格 → 「**不跟手**」；
 *   · 提交发生在 `onUp` → 「**松手时才突然移动**」。
 *
 * 拆开之后语义很清楚，而且这两件事各有各的正确性判据：
 *
 *   · **块**：连续。`continuousOffsetPx` 就是指针位移本身，一个字都不改。
 *     它直接写进 `transform: translate3d()`，不经过 React state、不经过量化。
 *   · **落点**：离散。`targetSlotAt` 把"块中心停在哪"换算成一个槽位序号，
 *     只用来驱动插入指示器与松手提交。
 *
 * 判据分得开，才能被 `scripts/verify-draggeom.ts` 逐条钉住 —— 这正是
 * `trim.ts` / `snap.ts` / `virtual.ts` 抽出来时用的同一条理由。
 *
 * ## 一个刻意的取舍：落点用"块中心"，不是"指针位置"
 *
 * 光标可能停在块的左边缘（用户就是在左边缘按下的）。用指针位置算落点，块头
 * 已经进入下一槽、块尾还在上一槽，松手后块的视觉位置会**回跳半个身位**。
 * 用中心则与"这块占了哪一段"一致，也不受用户按在哪一侧的影响。
 * 代价：拖一个 20s 长片段时要挪过它自己的半个身位才换槽 —— 这是它与
 * `orderSlotMap` 的**区间归属**（而非最近邻近）语义配套的结果，见下。
 *
 * ## 槽位是"区间归属"，不是"最近邻"
 *
 * `targetSlotAt` 用的是 `gap > t` 而不是"离哪个起点近"。差别在长片段上：
 * 最近邻会让 20s 的块在还没挨到下一个槽时就判给它（因为它的起点确实更近），
 * 松手后视觉上"提前插队"。区间归属（这块的中心落在了哪个槽的时间区间里）
 * 与用户看到的排布一致，也与 `buildOrderOffsetMap` 的口径一致。
 */

/** 一个槽位（= 一个镜头）在时间轴上的占位区间，`buildOrderOffsetMap` 的产物。 */
export interface Slot {
  order: number;
  start: number;
  end: number;
}

/**
 * 由 `buildOrderOffsetMap` 的 Map 构造有序槽位表。
 *
 * `buildOrderOffsetMap` 返回的是 `order → startSec`，每个槽的**宽度要靠相邻项
 * 相减**才能得到，而最后一项没有后继 —— 用 `durations` 补齐它。
 *
 * @param offsets   order → 该镜头在时间轴上的起点（秒）
 * @param durations order → 该镜头的时长（秒）
 */
export function buildSlots(
  offsets: Map<number, number>,
  durations: Map<number, number>,
): Slot[] {
  const out: Slot[] = [];
  for (const [order, start] of offsets) {
    // 时长缺失时用"到下一个槽的距离"兜底；连下一个都没有就用 0 宽。
    // 0 宽槽在 targetSlotAt 里仍可被 `t >= start` 命中，不会变成黑洞。
    let end = durations.get(order) ?? Number.NaN;
    if (!Number.isFinite(end)) {
      // 找最小的、比 start 大的起点
      let next = Number.POSITIVE_INFINITY;
      for (const s of offsets.values()) if (s > start && s < next) next = s;
      end = Number.isFinite(next) ? next - start : 0;
    }
    out.push({ order, start, end: start + Math.max(0, end) });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 块要位移多少像素 —— **连续值，不量化**。
 *
 * 这是"跟手"的全部秘密：它就是指针位移。任何量化（round 到槽、round 到帧）
 * 都必须发生在**落点**上，不能发生在这里。
 */
export function continuousOffsetPx(x: number, x0: number): number {
  return x - x0;
}

/**
 * 把"块中心停在哪一秒"换算成落点槽序号。
 *
 * @param slots    有序槽位表（见 `buildSlots`）。空表返回 `fallback`。
 * @param centerSec 块**中心**在时间轴上的绝对秒
 * @param fallback 表为空时的返回值（通常是原来的 order —— 宁可不动，不要跳到 1）
 *
 * `t` 被钳制在 `[首个起点, 末个终点]` 内，所以拖出时间轴两端时落点稳定地
 * 停在首/尾，而不是返回 undefined 让调用方决定（那会各处各写一遍钳制）。
 */
export function targetSlotAt(slots: Slot[], centerSec: number, fallback: number): number {
  if (!slots.length) return fallback;
  const first = slots[0];
  const last = slots[slots.length - 1];
  const t = Math.min(Math.max(centerSec, first.start), last.end);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    // 末槽必须用闭区间收尾，否则 t === last.end（拖到最右端）会落空。
    if (t >= s.start && (t < s.end || (i === slots.length - 1 && t <= s.end))) return s.order;
  }
  return last.order;
}

/**
 * 块中心在时间轴上的绝对秒。
 *
 * `startSec` 是该片段**静止时**的起点，`offsetPx` 是连续位移，
 * `pxPerSec` 是当前缩放。滚动造成的视口位移**不在这里** —— 它由
 * `scrollCompensatedSec` 处理，两者是不同的量，混在一起会让"拖到边缘
 * 自动滚动"变成自我加速的死循环。
 */
export function centerSecOf(startSec: number, durSec: number, offsetPx: number, pxPerSec: number): number {
  return startSec + durSec / 2 + offsetPx / pxPerSec;
}

/**
 * 自动滚动的步进（像素/帧）。
 *
 * @param pointerX 指针在视口里的 x（clientX）
 * @param left     轨道滚动区的视口左边界
 * @param right    轨道滚动区的视口右边界
 * @param edgePx   触发带宽度（默认 40：贴到边才开始滚，否则正常拖动会被"吸"）
 * @param stepPx   一帧最多滚多少（默认 12：约 720px/s，够追上拖动又不至于失控）
 *
 * 返回 0 表示不滚。**带符号**：正 = 内容左移（看后面的），负 = 回看前面。
 */
export function autoScrollStep(
  pointerX: number,
  left: number,
  right: number,
  edgePx = 40,
  stepPx = 12,
): number {
  if (right - left <= edgePx * 2) return 0; // 视口太窄，整条都是触发带 → 不滚
  if (pointerX < left + edgePx) {
    const depth = (left + edgePx - pointerX) / edgePx; // 0..1+
    return -Math.min(1, depth) * stepPx;
  }
  if (pointerX > right - edgePx) {
    const depth = (pointerX - (right - edgePx)) / edgePx;
    return Math.min(1, depth) * stepPx;
  }
  return 0;
}

/**
 * 自动滚动之后，指针"在时间轴上的绝对秒"要减去滚走的量。
 *
 * 拖动过程中容器滚动时，`clientX` 没变但指针指向的时间**变了**。不补偿的话，
 * 滚一点、指针就前进一点、落点又催着再滚 —— 是个正反馈的死循环。
 *
 * @param scrolledPx 自拖动开始以来 `scrollLeft` 的增量
 */
export function scrollCompensatedSec(baseSec: number, scrolledPx: number, pxPerSec: number): number {
  return baseSec - scrolledPx / pxPerSec;
}

/**
 * 落点提示的文案（工具条读数）。
 *
 * 抽出来是为了"没变的时候不显示"这条判据只有一处：起点等于终点时返回 `null`，
 * 调用方不必再写一遍 `previewOrder.order !== move.startOrder` ——
 * 那个判断今天就写在 JSX 里，且与 `previewOrder` 的形状（`{id, order}`）缠在一起，
 * 是本文件 §1.2.3 记的"闪烁"三个成因之一。
 */
export function dropLabel(fromOrder: number, toOrder: number | null): string | null {
  if (toOrder === null || toOrder === fromOrder) return null;
  return `#${fromOrder} → #${toOrder}`;
}
