/**
 * features/timeline/playhead.ts — 播放头移动与跟随滚动的纯计算（3.3）
 *
 * ## 为什么方向键"没反应"
 *
 * 改之前 `App.tsx` 的 nudgeLeft/nudgeRight 是这么写的：
 *
 *     const v = videoRef.current;
 *     if (v) v.currentTime = Math.max(0, v.currentTime - step);
 *
 * 也就是说**播放头不是一个时间轴概念，而是 `<video>` 的一个属性**。由此带来
 * 四个都不报错的失效（路线图只写了第一个，实际逐条核过是四个）：
 *
 *   ① **没有预览源时完全是死键。** `<video>` 只在 previewUrl 非空时渲染
 *      （`Player.tsx` 的 `p.previewUrl ? …`），刚打开项目、或正在看素材/成片时
 *      `videoRef.current` 是 null，按方向键静默无事发生 —— 不是"移动了但没显示"，
 *      是真的什么都没做，也没有任何提示。
 *   ② **跨不过镜头边界。** 一个镜头播到头，`currentTime` 顶在素材末尾就不动了。
 *      时间轴上有 200 个镜头，方向键只能在当前这一个里面爬。
 *   ③ **会走进 3.1 刚剪掉的那段素材里。** 修剪过入点的镜头，
 *      `currentTime` 减到 `inSec` 以下就是用户已经剪掉的画面；
 *      而 `toShotTime` 会把它钳成 0，于是**画面在动、播放头不动**。
 *      往右越过出点则会触发 `Player` 的窗口终止逻辑，表现为"按一下右键就跳下一镜"。
 *   ④ **步长 1/30 秒是猜的帧率**，与 3.2 定下的 0.1s 修剪格不对齐 ——
 *      用户永远没法把播放头**正好**放在一个可以下刀的位置上（Ctrl+B 分割、
 *      I/O 设入出点都落在 0.1s 格上）。
 *
 * 路线图原话是"暂停时无反应"。按规范 seek 会触发 `timeupdate`，所以
 * **只要有预览源，暂停时其实是有反应的** —— 真正的失效是上面四条。
 * 这里如实记下来，免得后人照着那句话去找一个不存在的 bug。
 *
 * ## 本文件只放纯函数
 *
 * 与 `trim.ts` 同一套理由：这些数学原本散在 mousemove/keydown 闭包里，
 * 唯一的检验方式是人拿手去按。抽出来之后 `verify-playhead.ts` 能逐条钉住。
 * 真正"动"的部分（seek 哪个 `<video>`、滚哪个 DOM 节点）留在调用方。
 */

import { round2 } from "./trim";

/** 播放头步进（秒）。**刻意与 `TRIM_STEP_SEC` 同为 0.1**：
 *
 *  播放头的用途就是"在这里下刀" —— Ctrl+B 分割、I/O 设入出点全都落在 0.1s 格上。
 *  播放头若走 1/30s，用户按方向键永远停在格与格之间，下刀时又被悄悄吸走一点。
 *  两者同格，"看到哪儿就切到哪儿"才成立。
 *  （为什么不是 1/fps：`<video>` 不暴露帧率，见 `trim.ts` 文件头。） */
export const NUDGE_STEP_SEC = 0.1;

/** Shift+方向键的大步长（秒）。1s 是"跳一句台词"的量级。 */
export const NUDGE_BIG_SEC = 1;

/** J/L 快进快退的最高倍速。
 *
 *  上限 4 不是随手取的：实际播放速率是 `本镜变速 × 快进倍速`
 *  （见 `Player.tsx` 的 playbackRate effect），本镜若已经 2× 变速，
 *  L 按到 4 就是 8× —— 再高浏览器会直接丢音频、部分解码器会掉帧。 */
export const SHUTTLE_MAX = 4;

/**
 * 按格步进。
 *
 * ⚠️ 是"吸到格上再走一格"，不是"当前值加减一格"。
 * 后者从 2.37 出发会得到 2.47 / 2.57…… 永远停在格与格之间；
 * 前者第一下就把播放头拉回 2.4，之后每一下都落在可下刀的位置上。
 *
 * @param cur    当前绝对秒
 * @param dir    -1 左 / +1 右
 * @param step   步长（`NUDGE_STEP_SEC` 或 `NUDGE_BIG_SEC`）
 * @param maxSec 可达上限（最后一个启用镜头的结尾，见 `buildEdgeSecs`）
 */
export function nudgeSec(
  cur: number, dir: -1 | 1, step: number, maxSec: number,
): number {
  const inv = 1 / step;
  const g = cur * inv;
  // 1e-6 的作用：cur 正好落在格上时（g=24.000000000000004 这类），
  // floor/ceil 不能因为浮点尾巴而少走或多走一格。
  const nextG = dir > 0 ? Math.floor(g + 1e-6) + 1 : Math.ceil(g - 1e-6) - 1;
  return clampSec(round2(nextG / inv), maxSec);
}

/** 钳到 `[0, maxSec]`。maxSec 非正数（空项目）时一律回 0。 */
export function clampSec(sec: number, maxSec: number): number {
  if (!(maxSec > 0)) return 0;
  return Math.max(0, Math.min(maxSec, round2(sec)));
}

/**
 * 跳到上/下一个片段边界（↑ / ↓）。
 *
 * @param edges 升序、已去重的边界秒（由 `buildEdgeSecs` 从
 *              `buildOrderOffsetMap` 派生 —— **不要**在这里另起一套累加，
 *              时间轴上"画线 / 刻度尺定位 / 边界跳转"必须同源，
 *              见 `adapters/shotToClip.ts` 里 `secToPosition` 的长注释）
 * @returns 落点秒；已在两端时返回该端点（不是原地不动 —— 从 0.3 按 ↑ 要回到 0）
 */
export function edgeSec(edges: number[], cur: number, dir: -1 | 1): number {
  if (!edges.length) return 0;
  const EPS = 1e-6;
  if (dir > 0) {
    const hit = edges.find((e) => e > cur + EPS);
    return hit ?? edges[edges.length - 1];
  }
  // 反向要从后往前找第一个严格小于当前位置的边界
  for (let i = edges.length - 1; i >= 0; i--) if (edges[i] < cur - EPS) return edges[i];
  return edges[0];
}

/**
 * J / L 的倍速切换。
 *
 * 语义与所有剪辑器一致：**同向连按加速，反向按下先回到停止**。
 * 后者很关键 —— 4× 快进时按 J，用户要的是"停下来往回看"，
 * 而不是"立刻 4× 倒着冲出去"。
 *
 * @param cur 当前倍速（正=快进，负=快退，0=停）
 * @param dir -1 = 按了 J，+1 = 按了 L
 * @returns 新倍速（同样是带符号的）
 */
export function nextShuttle(cur: number, dir: -1 | 1): number {
  if (cur === 0) return dir;                 // 停 → 1× 起步
  if (Math.sign(cur) !== dir) return 0;      // 反向 → 先停
  const next = Math.abs(cur) * 2;
  return next > SHUTTLE_MAX ? Math.sign(cur) * SHUTTLE_MAX : Math.sign(cur) * next;
}

/** 快退（J）每次回退的间隔（毫秒）。
 *
 *  为什么快退要自己打定时器、而快进不用：**浏览器不支持负的 `playbackRate`**
 *  （HTML 规范允许，但 Chromium/WebKit/Gecko 至今都不实现，赋负值要么被忽略、
 *  要么直接卡住）。所以 J 只能是"暂停 + 定时把 currentTime 往回挪"。
 *
 *  50ms = 20 次/秒：再密就是在给解码器发它跟不上的 seek 风暴（每次反向 seek
 *  都要回到最近的关键帧再解到目标帧），再稀就能看出一格一格的卡顿。 */
export const REVERSE_TICK_MS = 50;

/* ==========================================================================
 * 跟随滚动
 * ========================================================================== */

export interface FollowView {
  /** 播放头在**内容坐标系**里的 left（含左侧轨道头宽度，与
   *  `Timeline.tsx` 里 `left: GUTTER_W + playheadSec * pxPerSec` 同一个值） */
  playLeftPx: number;
  /** 滚动容器当前的 scrollLeft */
  scrollLeft: number;
  /** 滚动容器可视宽度（clientWidth） */
  viewWidthPx: number;
  /** 内容总宽度（scrollWidth） */
  contentWidthPx: number;
  /** 左侧轨道头宽度 —— 它是 sticky 的，**永远盖住可视区最左边这一条**，
   *  所以真正能看见播放头的范围是 `[scrollLeft + gutter, scrollLeft + viewWidth)`。
   *  不减掉它的话，播放头"露出来了"其实是藏在轨道头底下。 */
  gutterPx: number;
}

/** 舒适区：播放头落在可视区这个比例范围内就**不要动**。 */
const COMFORT_LEFT = 0.12;
const COMFORT_RIGHT = 0.85;
/** 需要滚动时，把播放头放在可视区的这个位置 —— 偏左，因为播放是往右走的，
 *  留 3/4 的前瞻比居中更有用（居中意味着每半屏就要滚一次）。 */
const PARK_AT = 0.25;

/**
 * 播放头跟随滚动：返回新的 `scrollLeft`，`null` = 不用滚。
 *
 * 三条设计约束，每条都对应一个用起来会烦人的做法：
 *
 *   · **舒适区内一律返回 null。** 每次 `timeupdate`（~4Hz）都硬滚一次的话，
 *     用户手动滚到别处看一眼就会被立刻拽回来。
 *   · **返回值与当前 scrollLeft 相差不到 1px 也返回 null。** 否则在末尾
 *     （已经滚到底、再怎么算都还是这个值）会每帧写一次 scrollLeft，
 *     白白打断浏览器的平滑滚动动画。
 *   · **落点偏左而不是居中**，理由见 `PARK_AT`。
 */
export function followScroll(v: FollowView): number | null {
  const inner = v.viewWidthPx - v.gutterPx;
  if (inner <= 0) return null;
  const maxScroll = Math.max(0, v.contentWidthPx - v.viewWidthPx);

  const visL = v.scrollLeft + v.gutterPx;
  const comfortL = visL + inner * COMFORT_LEFT;
  const comfortR = visL + inner * COMFORT_RIGHT;
  if (v.playLeftPx >= comfortL && v.playLeftPx <= comfortR) return null;
  // 已经滚到最右端时，播放头越过舒适区右界是没法再修正的（后面没内容了），
  // 上面 maxScroll 的钳制会把结果压回原值，由下面那条 <1px 的判断兜住。

  const next = Math.max(0, Math.min(
    maxScroll, v.playLeftPx - v.gutterPx - inner * PARK_AT));
  if (Math.abs(next - v.scrollLeft) < 1) return null;
  return next;
}

/** 用户手动滚动之后，暂停跟随的时长（毫秒）。
 *
 *  没有它的话，播放中用户想往后翻一眼看看接下来是什么，滚轮刚停下就被
 *  下一次 `timeupdate` 拽回播放头处，等于"播放时不能看别处"。 */
export const FOLLOW_SUSPEND_MS = 2500;
