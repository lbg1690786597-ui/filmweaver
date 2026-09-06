/**
 * render/kfExpr.ts —— 关键帧 → ffmpeg 表达式（批次 5 · 5.5）
 *
 * 位移动画有两种走法，代价差一个数量级：
 *
 *   A. **蒙版序列**：每帧一张蒙版拼进同一个 .gray（5.4 已支持，`-framerate` 那条路）
 *   B. **一张静态蒙版 + 会动的 `crop` / `overlay` 坐标**（本文件）
 *
 * B 只在**纯位移**（w/h 不随关键帧变）时成立，而这恰恰是**跟踪**（6.5）产出的形态。
 * 90 帧、300×300 的区域：A 要写 8.1 MB，B 只写 90 KB，且省掉逐帧光栅化。
 * §5「缺陷 4 已结案」的实测里 B 与静态同价（42.4× vs 45.3×）。
 *
 * ## 唯一的语义来源仍然是 `regionBoxAt`
 *
 * 本文件**不重新定义**插值语义：排序、去重、首尾夹持全部复用
 * `maskGroups.ts::normalizeKfs`，取值逐点与 `regionBoxAt` 对齐。
 * 「预览用一份、蒙版用一份、表达式再写一份」的下场是**预览对、导出错**，
 * 而且不会有任何断言自然发现 —— `verify-kfexpr` 的第 3 节就是专门钉这条的：
 * 把本文件吐出的字符串**解析回函数**，与 `regionBoxAt` 在密集网格上逐点比对。
 *
 * ## 转义：commas 是真会炸的
 *
 * filter_complex 里 `,` 分隔滤镜、`:` 分隔选项，而本文件产出的表达式里全是逗号。
 * 直接嵌进去，`crop=w:h:if(lt(t,1),0,4):0` 会被切成一堆碎片。
 * 两条出路（都实测过，见 `verify-kfexpr` 第 4 节）：
 *   - `escapeFilterExpr()`：逐个 `\,` `\:` 转义 —— **可用**
 *   - 整体套单引号 `'…'`                      —— **也可用**，且不必逐字符处理
 * 本文件只导出前者：单引号在 Windows 的进程参数传递里是另一个雷区
 * （sidecar 走的是 argv 数组不是 shell，但 ffmpeg 自己的 token 解析仍会吃掉引号，
 * 一旦哪天参数被拼成字符串再解析就会不一致）。转义是无歧义的那条。
 */

import type { MosaicParams, RegionKeyframe } from "./model";
import { normalizeKfs } from "./maskGroups";

/** 从一条关键帧里取出要动画的那个量 */
export type KfPick = (k: RegionKeyframe) => number;

export interface KfExprOpts {
  /** 比例 → 像素的换算系数（如画布宽）。缺省 1 = 直接用比例值 */
  scale?: number;
  /** 关键帧不足 2 条时用的常量（**已按 scale 换算好**） */
  fallback?: number;
  /** 夹持下界，ffmpeg 表达式字符串（如 `"0"`）。与上界必须同时给或同时不给 */
  clampLo?: string;
  /** 夹持上界（如 `"iw-432"`；overlay 侧要写 `"W-432"`，它不认识 iw/ih） */
  clampHi?: string;
}

/** 数值 → 表达式字面量。定长 4 位小数：亚像素精度够用，且不会出现 `1e-7` 这种 ffmpeg 不认的写法 */
const lit = (v: number): string => {
  const s = v.toFixed(4);
  // -0.0000 会让表达式里出现刺眼的负零，且部分场合影响可读性
  return s === "-0.0000" ? "0.0000" : s;
};

/**
 * 把一组关键帧编译成 ffmpeg 的分段线性表达式。
 *
 * 形如 `if(lt(t,T1),V0+K0*(t-T0),if(lt(t,T2),…,Vn))`：
 *  - `t < T0` 落在第一段里，`u` 取负 —— 所以**第一段必须单独夹持**，否则会外推
 *  - 末段之后直接给常量 `Vn`
 *  - 每段写成 `V+K*(t-T)` 而不是 `V0+(V1-V0)*(t-T0)/(T1-T0)`：少一次除法、短一半
 *
 * ⚠️ 与 `regionBoxAt` 的对齐点：**首尾夹持、不外推**；同一 `tSec` 的重复关键帧
 * 由 `normalizeKfs` 统一成「后者胜」。两边共用同一个归一化函数，不是各写一份。
 */
export function kfExpr(kfs: RegionKeyframe[] | undefined, pick: KfPick, opts: KfExprOpts = {}): string {
  const scale = opts.scale ?? 1;
  const ks = normalizeKfs(kfs);
  let body: string;

  if (ks.length < 2) {
    // ⚠️ 只有 1 条关键帧时用的是 **fallback（静态框）**，不是那条关键帧的值。
    // 理由不是"哪个更合理"，而是**必须与 `regionBoxAt` 一致**：那边 `ks.length < 2`
    // 直接 `return { x: m.x, … }`，`isAnimated` 也判定"不算动画"。
    // 若这里取关键帧值，同一个区域预览按 m.x 画、导出按 kf.x 遮 —— 不报错、
    // 只是遮错地方。这条正是写交叉钉时当场撞出来的（verify-kfexpr 第 [3] 节
    // 「只有一条关键帧」用例），不是事后补的防御。
    body = lit(opts.fallback ?? 0);
  } else {
    const t = ks.map((k) => k.tSec);
    const v = ks.map((k) => pick(k) * scale);
    // 从最后一段往回套，天然得到 if(…,if(…,…))
    body = lit(v[v.length - 1]);
    for (let i = ks.length - 2; i >= 0; i--) {
      const span = t[i + 1] - t[i];
      const k = span <= 0 ? 0 : (v[i + 1] - v[i]) / span;
      // 段内取值：V_i + K_i*(t - T_i)
      const seg = k === 0 ? lit(v[i]) : `${lit(v[i])}+${lit(k)}*(t-${lit(t[i])})`;
      body = `if(lt(t,${lit(t[i + 1])}),${seg},${body})`;
    }
    // 首端夹持：t < T0 时上面的第一段会外推，这里把它压成常量
    body = `if(lt(t,${lit(t[0])}),${lit(v[0])},${body})`;
  }

  if (opts.clampLo !== undefined && opts.clampHi !== undefined) {
    // 出画时 crop 拿到负坐标会**直接报错**（不是画歪），所以夹持不是保险而是必需
    body = `max(${opts.clampLo},min(${opts.clampHi},${body}))`;
  }
  return body;
}

/**
 * 表达式 → 可以安全塞进 filter_complex 的形式。
 * `,` 会被当成滤镜分隔、`:` 会被当成选项分隔，两者都必须转义。
 * （`\` 本身不出现在我们产出的表达式里，故无需处理。）
 */
export function escapeFilterExpr(expr: string): string {
  return expr.replace(/[,:]/g, (c) => `\\${c}`);
}

/** 纯位移判定：所有关键帧的 w/h 与首帧相同（容差 0.5px 级，按比例算 1e-4） */
export function isPureTranslation(m: MosaicParams, eps = 1e-4): boolean {
  const ks = normalizeKfs(m.keyframes);
  if (ks.length < 2) return false;
  return ks.every((k) => Math.abs(k.w - ks[0].w) <= eps && Math.abs(k.h - ks[0].h) <= eps);
}

export interface CanvasPx { w: number; h: number }
/** 一个纯位移区域在滤镜图里需要的四条坐标表达式（均**未**转义） */
export interface RegionExprs {
  /** `crop` 的 x/y（用 iw/ih 夹持） */
  cropX: string; cropY: string;
  /** `overlay` 的 x/y（用 W/H 夹持 —— overlay **不认识** iw/ih，实测必报错） */
  ovX: string; ovY: string;
}

/**
 * 纯位移区域 → 四条表达式。`box` 是那张**静态**蒙版的整数尺寸
 * （由调用方按 5.3 的对齐规则算出，本文件不重算 —— 「整数只算一次」）。
 *
 * 不是纯位移就返回 `null`，调用方退回蒙版序列那条路。
 */
export function regionExprs(m: MosaicParams, canvas: CanvasPx, box: { w: number; h: number }): RegionExprs | null {
  if (!isPureTranslation(m)) return null;
  const mk = (pick: KfPick, scale: number, fallback: number, hi: string) =>
    kfExpr(m.keyframes, pick, { scale, fallback, clampLo: "0", clampHi: hi });
  return {
    cropX: mk((k) => k.x, canvas.w, m.x * canvas.w, `iw-${box.w}`),
    cropY: mk((k) => k.y, canvas.h, m.y * canvas.h, `ih-${box.h}`),
    ovX: mk((k) => k.x, canvas.w, m.x * canvas.w, `W-${box.w}`),
    ovY: mk((k) => k.y, canvas.h, m.y * canvas.h, `H-${box.h}`),
  };
}
