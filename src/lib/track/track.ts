/**
 * lib/track/track.ts — 运动跟踪的编排层（批次 6 / 6.5，纯逻辑 + 注入 I/O）
 *
 * ## 分工
 *
 *   `ncc.ts`         数学：模板、一帧内的最佳匹配位置
 *   **本文件**        流程：采样时刻 → 逐帧匹配 → 判跟丢 → 抽稀成关键帧 → 说人话
 *   `frameSource.ts` 抽帧：`<video>` seek + `drawImage` + `getImageData`（有 DOM 才能跑）
 *   `nccClient.ts`   把匹配搬进 Web Worker（可选实现，拿不到 worker 就退回主线程）
 *
 * 抽帧与 worker 都是**注入进来的**，所以本文件在 node 下能被 `verify-track.ts`
 * 整条跑通：喂人造的灰度帧、人造的匹配器，把「跟丢了怎么办」「抽稀丢了多少精度」
 * 「消息说的是不是人话」全部真跑一遍，而不是靠 grep 源码。
 *
 * ## 时间口径：本模块一律用**输出秒**
 *
 * `RegionKeyframe.tSec` 存的是滤镜里的 `t`，也就是**变速之后**的输出时间
 * （见 `model.ts` 的字段注释）。面板的播放头、迷你时间条也都是这个口径。
 * 所以跟踪从头到尾只认输出秒，「输出秒 → 素材秒 → `video.currentTime`」这一步
 * 是抽帧那一侧的事（`frameSource.ts` 拿 `clipIn` 和 `speed` 自己换）。
 *
 * 这样分的理由很实际：如果本模块也掺和素材秒，那么「同一个时刻」就会在
 * 采样、抽稀、写关键帧三处各算一遍，而三处算错任何一处的表现都是
 * **遮挡在错误的时刻动**，且没有任何断言会自然发现。
 *
 * ## 两条不肯让步的规则
 *
 * 1. **跟丢就停，停在最后一个可信帧，并且说清楚在第几秒丢的。**
 *    不外推、不"猜一下应该在这儿"。用户看到「第 3.2s 处跟丢」会去看那一帧，
 *    然后手动补一个关键帧；而一串悄悄跑偏的框，用户只会在导出之后才发现。
 * 2. **可信样本不足 2 个就一个关键帧都不写。**
 *    1 个关键帧在 `regionBoxAt` 里等价于静态框（见 `maskGroups.ts`），
 *    写进去只会让面板显示「◇ 1帧」，用户以为跟踪成功了，实际什么都没发生。
 *    这就是"不把烂数据写进去"的具体含义。
 */

import type { RegionKeyframe } from "../../render/model";
import { Aborted } from "../aborted";
import {
  MIN_TEMPLATE_SD, makeTemplate, matchTemplate, toPx, toRel,
  type BoxPx, type BoxRel, type GrayFrame, type MatchOpts, type MatchResult, type Template,
} from "./ncc";

/** 逐帧抽帧器。`tSec` 是**输出秒**（见文件头）；取不到那一帧返回 `null`。 */
export interface FrameSource {
  grab(tSec: number): Promise<GrayFrame | null>;
}

/** 一个已经吃下模板的匹配器。生产里可能是 Worker，验证里是内存假货。 */
export interface Matcher {
  match(frame: GrayFrame, prev: BoxPx): Promise<MatchResult>;
  close(): void;
}

/** 造匹配器。模板在外面算好再传进来 —— 这样"纯色区域拒绝开始"能在建 worker 之前判掉。 */
export type OpenMatcher = (tpl: Template, opts: MatchOpts) => Promise<Matcher>;

/**
 * 主线程匹配器：直接调 `matchTemplate`。
 *
 * 它同时是 worker 版的**兜底**：`/fw/app/` 这类环境下 worker 造不出来时退回它，
 * 结果逐位相同，只是会在每个采样点上占住主线程十几毫秒。
 */
export const openLocalMatcher: OpenMatcher = async (tpl, opts) => ({
  match: async (frame, prev) => matchTemplate(frame, tpl, prev, opts),
  close: () => { /* 主线程版没有要释放的东西 */ },
});

export interface TrackSample {
  /** 输出秒 */
  tSec: number;
  box: BoxRel;
  /** NCC 得分；第一帧恒为 1（它就是模板本身） */
  score: number;
}

export type TrackFailKind =
  /** 镜头太短 / 起止时刻不合法，压根没有可采样的时刻 */
  | "tooshort"
  /** 起始区域几乎是纯色，没有可跟踪的纹理 —— 在开始之前就拒绝 */
  | "flat"
  /** 抽不到那一帧画面（seek 超时、素材损坏、尺寸突变） */
  | "nosource"
  /** 相关性掉到阈值以下：被遮挡或移出画面 */
  | "lost";

export interface TrackRun {
  /** 抽稀后的关键帧（输出秒）。可信样本 < 2 时**恒为空数组**，见文件头规则 2。 */
  keyframes: RegionKeyframe[];
  /** 逐采样点的原始结果，抽稀前。面板不用，验证与排查用。 */
  samples: TrackSample[];
  /** 跟到的采样点数 */
  ok: number;
  /** 计划采样点数 */
  total: number;
  /** 实际用的采样帧率（写进 `MosaicParams.track`） */
  sampleFps: number;
  /** 中途出的事；一路跟到底为 `null` */
  fail: { tSec: number; kind: TrackFailKind } | null;
  /** 给用户看的一句话（见 `trackMessage`） */
  message: string;
}

export interface TrackOpts extends MatchOpts {
  /** 采样帧率，缺省 8。见 `DEFAULT_SAMPLE_FPS` 的说明。 */
  sampleFps?: number;
  /** 判跟丢的 NCC 阈值，缺省 0.55。 */
  minScore?: number;
  /** 采样点数上限，缺省 300。 */
  maxFrames?: number;
  /** 抽稀容差（比例坐标），缺省 0.004。 */
  tolRatio?: number;
  /** 每跟到一个采样点报一次；`done` 含第一帧。 */
  onProgress?: (done: number, total: number) => void;
  /** 取消。检查点在每次抽帧之前，所以最坏多等一次 seek。 */
  signal?: { aborted: boolean };
}

/**
 * 采样帧率缺省值。
 *
 * 8 而不是素材帧率（24/30）：跟踪产出的是**关键帧之间线性插值**的轨迹，
 * 采样再密也会被 `thinTrack` 按同一个容差抽掉，只是白花 seek 的时间
 * （seek 才是这条流程的大头，见 §0.6 的实测）。而 8 fps 意味着相邻样本相隔 125 ms，
 * 一个横穿画面用 2 秒的目标每格移动 6%，远在搜索窗（框的 50%）之内。
 */
export const DEFAULT_SAMPLE_FPS = 8;

/** 判跟丢的 NCC 阈值。见 `MIN_SCORE` 的取值说明。 */
export const DEFAULT_MIN_SCORE = 0.55;

/**
 * 抽稀容差（比例）。0.004 = 1080 宽画面上的 4 像素。
 *
 * 比它更松会让匀速直线运动之外的轨迹出现肉眼可见的"抄近路"；
 * 更紧则几乎抽不掉点（NCC 的整数像素量化本身就有 1/320 ≈ 0.3% 的抖动，
 * 容差小于它等于把量化噪声当成信号，每个采样点都会变成一个关键帧）。
 */
export const DEFAULT_TOL_RATIO = 0.004;

/**
 * 采样时刻表（输出秒）。含首尾两端，所以最少 2 个。
 *
 * 时刻按 `start + span * i / (n-1)` 算而不是累加 `1/fps`：累加会让浮点误差
 * 攒到最后一个时刻上，于是"跟到镜头结尾"实际停在结尾前若干毫秒，
 * 而关键帧的**首尾夹持**语义让这点误差恰好被藏起来（看不出来，但轨迹短了一截）。
 */
export function sampleTimes(
  startSec: number, endSec: number, fps: number, maxFrames: number,
): number[] {
  const span = endSec - startSec;
  if (!(span > 0) || !(fps > 0) || maxFrames < 2) return [];
  const n = Math.min(Math.max(2, Math.round(span * fps) + 1), Math.floor(maxFrames));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(startSec + (span * i) / (n - 1));
  return out;
}

/**
 * 轨迹抽稀（Douglas–Peucker），但**误差度量不是几何距离，而是"这样存关键帧会差多少"**。
 *
 * 经典 DP 量的是点到弦的垂距。用在这里是错的：它只看形状，不看时间。
 * 一个「先匀速走 1 秒、停 2 秒、再走 1 秒」的目标，几何上是一条直线，
 * 垂距 DP 会只留首尾两点 —— 而那样插值出来的是**全程匀速**，
 * 中间那 2 秒的静止被抹平了，导出时遮挡会从目标身上滑走。
 *
 * 所以这里的误差量的是**在同一个 `tSec` 上，线性插值出来的框与实测框差多少**
 * —— 也就是 `regionBoxAt` 真正会算出来的那个值（`maskGroups.ts` 是唯一真源，
 * 本函数与它用的是同一条 `a + (b−a)·u` 公式）。于是抽稀后的最大表现误差
 * **有严格上界 `tol`**，这一条被 `verify-track.ts` 用随机轨迹反复钉住。
 *
 * x/y/w/h 四项取最大值：跟踪目前只产出位移（w/h 恒为初始框），但抽稀函数本身
 * 不该假设这一点 —— 哪天关键帧带上缩放，这里不必改。
 */
export function thinTrack(samples: TrackSample[], tolRatio: number): RegionKeyframe[] {
  const kfs: RegionKeyframe[] = samples.map((s) => ({ tSec: s.tSec, ...s.box }));
  if (kfs.length <= 2 || !(tolRatio > 0)) return kfs;

  const keep = new Array<boolean>(kfs.length).fill(false);
  keep[0] = keep[kfs.length - 1] = true;

  /** 第 i 条按 [a,b] 两端线性插值出来的框，与实测框的最大分量误差 */
  const err = (i: number, a: number, b: number): number => {
    const ka = kfs[a], kb = kfs[b], k = kfs[i];
    const span = kb.tSec - ka.tSec;
    const u = span > 0 ? (k.tSec - ka.tSec) / span : 0;
    return Math.max(
      Math.abs(ka.x + (kb.x - ka.x) * u - k.x),
      Math.abs(ka.y + (kb.y - ka.y) * u - k.y),
      Math.abs(ka.w + (kb.w - ka.w) * u - k.w),
      Math.abs(ka.h + (kb.h - ka.h) * u - k.h),
    );
  };

  // 显式栈而不是递归：采样上限 300，递归深度最坏也是 300，本来不会爆栈，
  // 但把上限从"引擎的栈有多深"换成"这个数组有多长"是白拿的确定性。
  const stack: [number, number][] = [[0, kfs.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    let worst = -1, worstE = 0;
    for (let i = a + 1; i < b; i++) {
      const e = err(i, a, b);
      if (e > worstE) { worstE = e; worst = i; }
    }
    if (worst < 0 || worstE <= tolRatio) continue;
    keep[worst] = true;
    stack.push([a, worst], [worst, b]);
  }
  return kfs.filter((_, i) => keep[i]);
}

/**
 * 跟踪结果的一句话。**这是用户唯一会读到的东西**，所以每种失败都要说清楚
 * 「在哪儿」「为什么」「已经保住了什么」，不许出现"跟踪失败"这种什么也没说的话。
 */
export function trackMessage(r: Omit<TrackRun, "message">): string {
  const kf = r.keyframes.length;
  if (!r.fail) return `已跟踪 · ${kf} 个关键帧`;
  const at = `第 ${r.fail.tSec.toFixed(1)}s 处`;
  switch (r.fail.kind) {
    case "tooshort":
      return "这个镜头太短，没有可采样的时刻";
    case "flat":
      return "这块区域几乎是纯色，没有可跟踪的纹理 —— 把框挪到有细节的地方再试";
    case "nosource":
      return kf >= 2
        ? `${at}读不到画面，已保留前段结果（${kf} 个关键帧）`
        : "读不到画面，没有写入任何关键帧";
    case "lost":
      return kf >= 2
        ? `${at}跟丢（目标被遮挡或移出画面），已保留前段结果（${kf} 个关键帧）`
        : "一开始就跟丢了（目标被遮挡或移出画面），没有写入任何关键帧";
  }
}

/**
 * 跑一次跟踪。
 *
 * `startBox` 是**起始时刻画面上那个框**（比例），模板就从那儿截。
 * 跟踪只向**后**走：`startSec` 之前的时刻由关键帧的首尾夹持覆盖
 * （`regionBoxAt` 在 `t < 第一条` 时返回第一条，不外推）。这与剪映一致 ——
 * 用户把框摆在哪一帧，就从哪一帧开始跟。
 *
 * **永不抛**，除非被 `signal` 取消（抛 `Aborted`，由调用方静默收场）。
 * 抽帧或匹配自己炸了都算 `nosource`：跟踪失败不该以一个红色异常弹窗收场。
 */
export async function runTrack(
  src: FrameSource,
  openMatcher: OpenMatcher,
  startBox: BoxRel,
  startSec: number,
  endSec: number,
  opts: TrackOpts = {},
): Promise<TrackRun> {
  const sampleFps = opts.sampleFps ?? DEFAULT_SAMPLE_FPS;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const tolRatio = opts.tolRatio ?? DEFAULT_TOL_RATIO;
  const maxFrames = opts.maxFrames ?? 300;
  const matchOpts: MatchOpts = { expand: opts.expand, minRadiusPx: opts.minRadiusPx };
  const report = (done: number, total: number) => {
    try { opts.onProgress?.(done, total); } catch { /* 进度回调炸了不该带走跟踪 */ }
  };
  const done = (
    samples: TrackSample[], total: number, fail: TrackRun["fail"],
  ): TrackRun => {
    // 规则 2：可信样本 < 2 时一个关键帧都不写（见文件头）
    const keyframes = samples.length >= 2 ? thinTrack(samples, tolRatio) : [];
    const base = { keyframes, samples, ok: samples.length, total, sampleFps, fail };
    return { ...base, message: trackMessage(base) };
  };

  const times = sampleTimes(startSec, endSec, sampleFps, maxFrames);
  if (times.length < 2) {
    return done([], times.length, { tSec: startSec, kind: "tooshort" });
  }

  const first = await grabSafe(src, times[0], opts.signal);
  if (!first) return done([], times.length, { tSec: times[0], kind: "nosource" });

  const box0 = toPx(startBox, first);
  const tpl = makeTemplate(first, box0);
  if (tpl.sd < MIN_TEMPLATE_SD) {
    return done([], times.length, { tSec: times[0], kind: "flat" });
  }

  const samples: TrackSample[] = [{ tSec: times[0], box: toRel(box0, first), score: 1 }];
  report(1, times.length);

  const matcher = await openMatcher(tpl, matchOpts);
  let fail: TrackRun["fail"] = null;
  try {
    let prev = box0;
    for (let i = 1; i < times.length; i++) {
      // ⚠️ 这一句**不承重**：`grabSafe` 下一行就自己先 `throwIfAborted` 了一遍，
      // 所以删掉它行为不变（已用变异测试实测：改掉断言全绿，故未列进变异表）。
      // 留着是因为循环体将来可能在抽帧之前多做点事（预取、埋点），那时它才开始承重；
      // 写在这里是为了下一个人别把它当成"正在起作用的取消检查点"去依赖。
      throwIfAborted(opts.signal);
      const f = await grabSafe(src, times[i], opts.signal);
      // 尺寸突变说明抽帧那一侧换了缩放基准；继续跟只会拿错像素比对
      // （`matchTemplate` 会因帧宽不符直接抛），所以在这里如实收场。
      if (!f || f.w !== first.w || f.h !== first.h) {
        fail = { tSec: times[i], kind: "nosource" };
        break;
      }
      let m: MatchResult;
      try {
        m = await matcher.match(f, prev);
      } catch (e) {
        if ((e as Error)?.name === "Aborted") throw e;
        fail = { tSec: times[i], kind: "nosource" };
        break;
      }
      if (m.score < minScore) {
        fail = { tSec: times[i], kind: "lost" };
        break;
      }
      prev = { x: m.x, y: m.y, w: box0.w, h: box0.h };
      samples.push({ tSec: times[i], box: toRel(prev, f), score: m.score });
      report(samples.length, times.length);
    }
  } finally {
    try { matcher.close(); } catch { /* 关不掉也不能带走结果 */ }
  }
  return done(samples, times.length, fail);
}

function throwIfAborted(signal: { aborted: boolean } | undefined): void {
  if (signal?.aborted) throw new Aborted("用户已取消跟踪");
}

/** 抽帧失败一律当成"这一帧没有"，只有取消才往外抛。 */
async function grabSafe(
  src: FrameSource, tSec: number, signal: { aborted: boolean } | undefined,
): Promise<GrayFrame | null> {
  throwIfAborted(signal);
  try {
    return await src.grab(tSec);
  } catch (e) {
    if ((e as Error)?.name === "Aborted") throw e;
    return null;
  }
}
