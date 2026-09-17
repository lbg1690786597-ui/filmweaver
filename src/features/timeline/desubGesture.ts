/**
 * desubGesture — 去字幕块的拖 / 修剪三手势
 *
 * ## 为什么单独一个文件
 *
 * `Timeline.tsx` 的定位是「渲染与装配」，纯逻辑一律外置（gesture / snap /
 * trim / dragGeom / virtual 已是先例，架构守卫也按这条线钉着它的行数预算）。
 * 这三个手势是纯逻辑：入参是几何与回调，出参是三个 pointerdown 处理器，
 * 不碰 Timeline 的任何渲染状态。
 *
 * ## 为什么不复用 `beginTrimNonShot` 那三个
 *
 * 它们的写回都经 `clipEdit.ts` 的分派表（实体 → 三个后端端点），
 * 而去字幕标记**没有端点** —— 它是 `shot.transform_meta.desub` 里的一项，
 * 写回要先读旧 transform 再整体合并提交（走 App 的 `commitTransform`）。
 *
 * 三处语义也不同：
 *   · 上下限不是「素材有多长」，而是**本镜的区间** —— 去字幕块不能跨镜，
 *     一次提交对应一个镜头的一个素材文件，跨镜在后端无法表达。
 *   · 拖整块不是改锚点（它没有锚点），而是在本镜内平移。
 *   · 单位要换：块的几何是**源秒**，存进去的是**输出秒**。
 *
 * ## 为什么拖动期不做 staged 写
 *
 * 与时间轴上其它块一致：拖动期只写 DOM 预览，**松手才发一次 PATCH**。
 * 去字幕按处理时长计费，但钱花在「开始去字幕」那一刻，拖动本身不花钱；
 * 每帧 staged 写一次只会把 PATCH 打成上百条，没有任何收益。
 * （覆盖层的框拖拽是另一回事 —— 那里 staged 写是为了让预览跟手，见
 * `useStagedTransform` 的文件头。）
 *
 * ## 顺带承载「区间规则」这一份
 *
 * `manualDesubSpan`（橡皮擦标完一个框，块占哪一段）与夹紧三则都放在这里，
 * 而不是散在覆盖层与手势的闭包里 —— 它们是同一件事的两头（怎么建、怎么调），
 * 分开放就会各自漂。且这个文件没有 React / CSS 依赖，
 * `scripts/verify-desub-gesture.ts` 能直接 import 真函数来断言，
 * 不必退化成"读源码文本找正则"。
 *
 * ## 三条纪律（与 gesture.ts 同）
 *
 * 预览**直接写 DOM**（`pv.widthPx` / `pv.shiftPx`），不经 React；
 * `onCommit` 必须 `await`；`onSettle` 只在提交落定后清预览。
 * 违反任一条就是 3.11 修过的那三个症状：看不到拖动位置 / 松手突然移动 / 来回闪。
 */

import type React from "react";
import type { Clip } from "../../types/timeline";
import type { ShotInfo } from "../../api";
import { buildOrderOffsetMap, shotDuration } from "../../adapters/shotToClip";
import { outputSec } from "../../lib/keyframeEdit";
import { beginGesture, clipEl, stylePreview } from "./gesture";
import { quantizeSec } from "./trim";

/** 去字幕块的最短区间（秒）。
 *
 *  0.2s 不是随便取的：第三方去字幕 API 有约 25s 固定开销，比它更短的区间
 *  切出来除了多一次有损重编码之外什么都省不到。取这个值只是不让块被拖成
 *  零宽（零宽块点不中、也删不掉）。 */
export const MIN_DESUB_SEC = 0.2;

/** 新建块起点相对标注帧的回退量：人是**看到字幕之后**才按下手的，
 *  反应加确认大约就是这么久，字幕的真实起点必然早于标注帧。 */
export const LEAD_SEC = 1.0;

/**
 * 手工标记（预览窗橡皮擦拖完一个框）落到轨道上的时间区间。
 *
 * 起点回退 `LEAD_SEC` 并夹在镜头开头，终点直接取**本片段末尾** ——
 * 两头都是**刻意的过量覆盖**：字幕通常持续到切镜头，而"遮罩盖住无文字区域"
 * 实测近乎无损（1.20x 基线 MAE、可察像素 0.012%）。宁可多擦一点，也不要
 * 切掉半个字后还得再标一次。
 *
 * 代价是计费时长会略高于字幕的真实时长 —— 这是用测出来的"过量覆盖无害"
 * 换"不漏擦"，是设计选择，不是没算清楚。
 */
export function manualDesubSpan(tSec: number, shotDurSec: number):
    { t0: number; t1: number } {
  const t0 = Math.max(0, tSec - LEAD_SEC);
  return { t0, t1: Math.max(t0 + MIN_DESUB_SEC, shotDurSec) };
}

/* ---------------------------------------------------------------- 夹紧三则
 *
 * 三个手势各自的边界规则抽在这里，是为了让它们**可断言**：
 * 「不跨镜、不反向、不零宽」是这个功能的正确性核心，而拖拽本身要靠人眼看
 * （跟不跟手、松不松手闪），边界却完全是算术 —— 算术就该由脚本盯着，
 * 见 `scripts/verify-desub-gesture.ts`。
 *
 * 三个都返回**已量化**的值（`quantizeSec`，0.1s 步进），调用处不再取整：
 * 两处各取一次整，就会出现"预览 2.4、落库 2.5"这种松手跳一下的老毛病。
 */

/**
 * 量化到 0.1s 网格，但**绝不越过两端**。
 *
 * `quantizeSec` 是四舍五入，所以"先夹紧、再量化"这个顺序会在**贴边时把值推
 * 出界外**：镜内起点 0.74、镜长 8 时，右缘的上界 7.26 会被量化成 7.3，
 * 于是块的终点落在 8.04 —— 越过镜尾 0.04s。切段时 `-t` 就超过了文件末尾，
 * ffmpeg 不会报错、只会悄悄少给几帧，而我们**按提交的时长付钱**。
 *
 * 所以贴边这一下宁可停在非网格的精确边界上：用户拖到头本来就是想"顶满"，
 * 差那 0.04 秒没人看得出来，越界却是实打实的。
 */
function qClamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, quantizeSec(Math.max(lo, Math.min(hi, v)))));
}

/** 拖右缘：给定镜内起点 `a` 与想要的时长，夹进 `[MIN_DESUB_SEC, 本镜剩余]`。 */
export function clampDesubEnd(a: number, wantDur: number, shotDur: number): number {
  return qClamp(wantDur, MIN_DESUB_SEC, Math.max(MIN_DESUB_SEC, shotDur - a));
}

/** 拖左缘：给定镜内起点 `a0`、钉死的终点 `b` 与位移，返回夹紧后的**位移**。
 *  下界 `-a0` = 最多退到镜头开头（不跨镜）；上界让区间不短于 MIN_DESUB_SEC。 */
export function clampDesubStartDelta(a0: number, b: number, dx: number): number {
  return qClamp(dx, -a0, Math.max(-a0, (b - MIN_DESUB_SEC) - a0));
}

/** 拖整块：长度不变地平移，夹进 `[0, 本镜长 - 块长]`。 */
export function clampDesubMove(len: number, wantA: number, shotDur: number): number {
  return qClamp(wantA, 0, Math.max(0, shotDur - len));
}

export interface DesubGestureDeps {
  shots: ShotInfo[];
  pxPerSec: number;
  /** 提交区间（**输出秒**）。App 侧走 commitTransform：带乐观锁与撤销栈。 */
  onEditDesub?: (shotId: string, regionId: string,
    range: { t0: number; t1: number }) => Promise<void>;
  /** 工具条上的「这一块现在多长」浮标，拖完必须清掉。 */
  setPreviewDur: (v: { id: string; sec: number } | null) => void;
}

export interface DesubGestures {
  beginTrim: (e: React.PointerEvent, clip: Clip) => void;
  beginTrimIn: (e: React.PointerEvent, clip: Clip) => void;
  beginMove: (e: React.PointerEvent, clip: Clip) => void;
}

export function makeDesubGestures(d: DesubGestureDeps): DesubGestures {
  const { pxPerSec, setPreviewDur } = d;

  /** 单个块的镜内几何。返回 null = 这个块不可编辑（已擦除 / 找不到镜头）。 */
  const ctxOf = (clip: Clip) => {
    if (clip.entity !== "desub" || !clip.shotId) return null;
    // 已擦除的块改区间毫无意义：那一版已经出片了。ClipView 也不给它渲染手柄，
    // 这里是第二道闸（程序触发的路径不经过 DOM）。
    if (clip.status === "done") return null;
    const shot = d.shots.find((s) => s.id === clip.shotId);
    if (!shot) return null;
    const base = buildOrderOffsetMap(d.shots).get(shot.order) ?? 0;
    return {
      shot, base,
      // 时间轴口径的镜头长度（取片窗口优先），与块的 startSec 同源
      shotDur: shotDuration(shot),
      speed: shot.transform_meta?.speed,
    };
  };

  /** 源秒区间 → 输出秒，发出去。两端都 quantize 过，这里不再取整。 */
  const commit = async (
    clip: Clip, speed: number | undefined, aSec: number, bSec: number,
  ) => {
    if (!clip.shotId || !d.onEditDesub) return;
    await d.onEditDesub(clip.shotId, clip.id, {
      t0: outputSec(aSec, speed), t1: outputSec(bSec, speed),
    });
  };

  /** 拖右边缘：擦到更晚/更早结束。上界是本镜末尾。 */
  const beginTrim = (e: React.PointerEvent, clip: Clip) => {
    const ctx = ctxOf(clip);
    if (!ctx) return;
    e.preventDefault(); e.stopPropagation();
    const a = clip.startSec - ctx.base;           // 镜内起点（源秒），本次不变
    const startDur = clip.durationSec;
    let latest = quantizeSec(startDur);
    const pv = stylePreview(clipEl(clip.id));
    setPreviewDur({ id: clip.id, sec: latest });
    beginGesture(e.nativeEvent, {
      cursor: "ew-resize",
      onFrame: (g) => {
        const next = clampDesubEnd(a, startDur + g.dx / pxPerSec, ctx.shotDur);
        if (next === latest) return;
        latest = next;
        pv.widthPx(next * pxPerSec);
      },
      onCommit: async () => {
        if (latest === quantizeSec(startDur)) return;
        await commit(clip, ctx.speed, a, a + latest);
      },
      onSettle: () => { pv.reset(); setPreviewDur(null); },
    });
  };

  /** 拖左边缘：从更晚/更早开始擦。右端钉死，所以左缘**真的会移动**
   *  （与音频/字幕同构，与镜头"原地变窄"相反）。 */
  const beginTrimIn = (e: React.PointerEvent, clip: Clip) => {
    const ctx = ctxOf(clip);
    if (!ctx) return;
    e.preventDefault(); e.stopPropagation();
    const a0 = clip.startSec - ctx.base;
    const b = a0 + clip.durationSec;              // 镜内终点，本次不变
    // 允许**往左拖回去**（负 delta）：起点回退是这个功能最常用的调整
    // （字幕比标注早出现了），单向阀会让用户以为"只能越标越晚"。
    let latestD = 0;
    const pv = stylePreview(clipEl(clip.id));
    setPreviewDur({ id: clip.id, sec: clip.durationSec });
    beginGesture(e.nativeEvent, {
      cursor: "ew-resize",
      onFrame: (g) => {
        const dd = clampDesubStartDelta(a0, b, g.dx / pxPerSec);
        if (dd === latestD) return;
        latestD = dd;
        // 同时表达"变短"和"右移"，只做一样松手前后都会跳
        pv.widthPx((clip.durationSec - dd) * pxPerSec, dd * pxPerSec);
      },
      onCommit: async () => {
        if (latestD === 0) return;
        await commit(clip, ctx.speed, a0 + latestD, b);
      },
      onSettle: () => { pv.reset(); setPreviewDur(null); },
    });
  };

  /** 拖整块：在**本镜内**平移，长度不变。拖到镜头两端就停住 ——
   *  不吸附到别的镜头，因为块跨不了镜。 */
  const beginMove = (e: React.PointerEvent, clip: Clip) => {
    const ctx = ctxOf(clip);
    if (!ctx) return;
    const a0 = clip.startSec - ctx.base;
    const len = clip.durationSec;
    let latestA = a0;
    const pv = stylePreview(clipEl(clip.id));
    beginGesture(e.nativeEvent, {
      onFrame: (g) => {
        const next = clampDesubMove(len, a0 + g.dx / pxPerSec, ctx.shotDur);
        if (next === latestA) return;
        latestA = next;
        pv.shiftPx((next - a0) * pxPerSec);
      },
      onCommit: async () => {
        if (Math.abs(latestA - a0) < 0.05) return;
        await commit(clip, ctx.speed, latestA, latestA + len);
      },
      onSettle: () => { pv.reset(); },
    });
  };

  return { beginTrim, beginTrimIn, beginMove };
}
