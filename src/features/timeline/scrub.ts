/**
 * features/timeline/scrub.ts — 拖播放头的节流策略（3.4）
 *
 * ## 被节流的不是"计算"，是**换一个 `<video>` 元素并重新下载一整个文件**
 *
 * 改之前 `TimelineRuler` 的 mousemove 直接调 `onScrub` → `Timeline.onRulerScrub`
 * → `seekTo(shot, offsetSec)`。跨镜时 `seekTo` 会走 `onSelectShot` 换掉
 * `previewUrl`，而 `<video>` 是 `key={previewUrl}` 挂的（这个 `key` **必须保留**，
 * 它是连播能自动播放的唯一原因，见 §0.5(g)），于是每跨一个镜头就是：
 *
 *     销毁 `<video>` → 建一个新的 → 它没有 `preload` → 默认 `auto` 尽力下整片
 *     → 下一个 mousemove 又把它销毁，上一个下载 abort
 *
 * 默认 12 px/s 下拖过 1200 px = 扫过约 20 个镜头 = **20 次元素重建 + 20 个整片
 * 下载**（绝大多数立刻作废）。这不是"有点浪费"：素材走的是 9080 的远端 URL，
 * 拖一次播放头能打出几十兆无用流量，且每次重建都要重新建解码器。
 *
 * ## 因此把一次拖动拆成两种代价完全不同的动作
 *
 *   · **廉价**（每帧都做）：挪时间轴上那条线；若落点仍在当前预览镜头内，
 *     顺带 seek 一下 `currentTime`（同一个元素，不重新下载）。
 *   · **昂贵**（只在停稳或松手时做）：切换预览源 = 换元素 + 重新下载。
 *
 * 对应到本模块就是三个 phase：`start` / `move` / `commit`。
 * 调用方（`Timeline` → `App.movePlayheadTo`）决定每个 phase 做什么，
 * 本模块只负责**什么时候**发出它们。
 *
 * ## 为什么"停稳 120ms 也提交"，而不是只在松手时提交
 *
 * 只在松手时切源的话，慢慢拖过去找镜头的用户全程看不到画面变化，
 * 等于"拖动时预览是瞎的"。停稳即提交保住了"拖到哪儿看到哪儿"的手感，
 * 而快速掠过的那十几个镜头（每个停留远不到 120ms）一个都不会被加载。
 * 120ms 略高于人手停顿的抖动，又短到感觉不出延迟。
 *
 * ## 为什么定时器与 rAF 都可注入
 *
 * 与 `stagedWrite` 同一套理由：「拖 180 帧只换 1 次源」是本条的验收标准，
 * 得能测。注入假时钟后 `verify-scrub.ts` 可以模拟整串 mousemove 再断言
 * commit 次数，而不是跑真实时间去赌。
 */

/** 拖动中"停稳多久算停下"（毫秒）。见文件头。 */
export const SCRUB_SETTLE_MS = 120;

/**
 * 拖播放头的三个阶段。
 *
 *   · `start`  —— 按下。调用方应在此停掉快进/快退并暂停播放：
 *                 边播边拖会让 `timeupdate` 与拖动互相抢播放头。
 *   · `move`   —— 拖动中，**每帧最多一次**。只挪线，不许换预览源。
 *   · `commit` —— 停稳或松手。此时才允许换预览源。
 */
export type ScrubPhase = "start" | "move" | "commit";

export interface ScrubberOpts {
  /** 发出一个阶段。调用方据 phase 决定做廉价还是昂贵的事。 */
  emit: (sec: number, phase: ScrubPhase) => void;
  /** 停稳多久后提交；缺省 `SCRUB_SETTLE_MS` */
  settleMs?: number;
  raf?: (fn: () => void) => number;
  cancelRaf?: (h: number) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (t: unknown) => void;
}

export interface Scrubber {
  /** mousedown：立刻挪线（单击 = 直接跳过去，不能等一帧），并开始计时 */
  start: (sec: number) => void;
  /** mousemove：记下位置，本帧内多次调用只会挪一次线 */
  move: (sec: number) => void;
  /** mouseup：把还没画的那一帧补上，然后立刻提交 */
  end: () => void;
  /** 组件卸载：丢掉待处理的 rAF 与定时器，**不**提交 */
  dispose: () => void;
  /** 供验证脚本断言：收到多少次 move、实际画了多少帧、换了多少次源 */
  readonly stats: { moves: number; frames: number; commits: number };
}

export function createScrubber(o: ScrubberOpts): Scrubber {
  const settleMs = o.settleMs ?? SCRUB_SETTLE_MS;
  const raf = o.raf ?? ((fn: () => void) => requestAnimationFrame(fn));
  const cancelRaf = o.cancelRaf ?? ((h: number) => cancelAnimationFrame(h));
  const schedule = o.schedule
    ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const cancel = o.cancel
    ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));

  let latest = 0;
  let rafH: number | null = null;
  let timer: unknown = null;
  /** 上一次真正换过源的位置。相同位置不重复提交 —— 松手时若停稳提交已经
   *  发生过，再提交一次就是白白重建一遍 `<video>`。 */
  let committed: number | null = null;
  const stats = { moves: 0, frames: 0, commits: 0 };

  const clearTimer = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const clearFrame = () => { if (rafH !== null) { cancelRaf(rafH); rafH = null; } };

  const paint = () => {
    rafH = null;
    stats.frames++;
    o.emit(latest, "move");
  };

  const armSettle = () => {
    clearTimer();
    timer = schedule(() => { timer = null; commit(); }, settleMs);
  };

  const commit = () => {
    clearTimer();
    if (committed === latest) return;
    committed = latest;
    stats.commits++;
    o.emit(latest, "commit");
  };

  return {
    start(sec) {
      latest = sec;
      // 每次按下都重置：上一次拖动提交在哪儿，与这一次能不能省掉提交无关
      committed = null;
      o.emit(sec, "start");
      // 单击（按下后不动就松手）必须立刻见效，所以这里同步挪线而不排 rAF
      stats.frames++;
      o.emit(sec, "move");
      armSettle();
    },
    move(sec) {
      latest = sec;
      stats.moves++;
      if (rafH === null) rafH = raf(paint);
      armSettle();
    },
    end() {
      // 还压着一帧没画时，先把线放到最终位置再提交 —— 否则线会停在
      // 上一帧的位置上，而预览跳到了松手处，两者对不上
      if (rafH !== null) { clearFrame(); paint(); }
      commit();
    },
    dispose() { clearFrame(); clearTimer(); },
    stats,
  };
}
