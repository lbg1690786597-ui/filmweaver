/**
 * 划区间的三个数怎么算（3.11 R3 局部重生成）。
 *
 * 为什么把这点算术单独拎出来：面板上那块「A 3.0s | B 4.1s | C 2.9s」的条
 * **就是用户对这个功能全部的认知**。数字错了（比如中间段显示 4.1s、
 * 实际划出 4.0s）没有任何报错会冒出来，用户要到出片时才发现长度不对。
 * 抽成纯函数是为了能钉住它，而不是因为它复杂。
 *
 * 另一件必须钉住的事：**两个滑块得互相夹持**。起点越过终点时后端会给
 * 422（文案没错，但用户会觉得自己明明拖到位置了却被拒）。夹持放在这里，
 * 面板只管把结果画出来。
 */

/** 两端各留的最小边距（秒）。与后端 `recut_shot` 的 `_EDGE` 同口径。 */
export const RECUT_EDGE_SEC = 0.5;

/** 滑块的最小步长：与显示的一位小数对齐，免得出现"显示 3.0 实际 3.04"。 */
const STEP = 0.1;

export interface RecutPlan {
  a: number;
  b: number;
  /** 三段时长，四舍五入到两位（后端的口径）。 */
  head: number;
  mid: number;
  tail: number;
  /** 非空 = 这组切点不该提交，内容是要说给用户的那句话。 */
  why: string | null;
}

const round = (n: number) => Math.round(n * 100) / 100;
const snap = (n: number) => Math.round(n * 10) / 10;

/**
 * 把「用户拖到哪」换算成「实际会划到哪」。
 *
 * `cutA` / `cutB` 为 `null` 表示还没动过 —— 按 1/3、2/3 给起点。
 * **不按素材总长也不按旁白算**：用户点开面板时想的是"大概哪一段要重做"，
 * 等分是他最可能要微调的起点，而算出来的任何"智能"默认值都要他先理解再推翻。
 */
export function planRecut(duration: number, cutA: number | null, cutB: number | null): RecutPlan {
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const a = snap(cutA ?? dur / 3);
  const b = snap(cutB ?? (dur * 2) / 3);
  return {
    a, b,
    head: round(a),
    mid: round(b - a),
    tail: round(dur - b),
    why: recutBlocked(dur, a, b),
  };
}

/** 拖起点滑块：夹在 [0.1, 终点-0.1]。 */
export function dragCutA(plan: RecutPlan, raw: number): number {
  return snap(Math.min(Math.max(raw, STEP), plan.b - STEP));
}

/** 拖终点滑块：夹在 [起点+0.1, 时长-0.1]。 */
export function dragCutB(plan: RecutPlan, raw: number, duration: number): number {
  return snap(Math.max(Math.min(raw, duration - STEP), plan.a + STEP));
}

/**
 * 拦下不该提交的切点。返回 null = 可以提交。
 *
 * ⚠️ 这里**只拦前端知道的**：两刀在不在端内距里、有没有重合。
 * 中间段的长度下限**不在这里** —— 它取决于项目当前视频模型
 * （H3 是 2s、seedance 是 4s、veo 是 8s），只有后端知道。
 * 在这里写死一个数迟早与后端漂移，且漂移的方向是"前端放行、后端报错"，
 * 用户看到的是一个按钮亮着却点不动。让后端说，文案原样弹出来。
 */
export function recutBlocked(duration: number, a: number, b: number): string | null {
  if (duration <= RECUT_EDGE_SEC * 2) {
    return `这一镜只有 ${duration.toFixed(1)}s，太短，划不出可用的区间`;
  }
  if (a < RECUT_EDGE_SEC || b > duration - RECUT_EDGE_SEC) {
    return `两个切点各需离两端 ${RECUT_EDGE_SEC}s 以上`;
  }
  if (b - a <= 0) return "两个切点不能重合";
  return null;
}
