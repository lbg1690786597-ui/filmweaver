/**
 * render/maskFiles.ts —— 蒙版文件的产出与生命周期（批次 5 · 5.8）
 *
 * 这是批次 5 的**接线点**：5.1 的形状层、5.2 的光栅化器、5.3 的分组器、
 * 5.4 的滤镜图在此之前都只是「能单测的纯模块」，导出主链路一次都没调用过它们
 * （`baseline-export.ts` 从不提供 `maskPath`，每条路径都落回 legacy 实现）。
 * 本文件把它们接上：**关键帧与羽化从这一刻起才真的进得了成片**。
 *
 * ## 三条硬约束
 *
 * ① **必须调 `rasterGroupMask`，不能把 `group.box` 直接交给 `rasterRegionMask`。**
 *    后者会把形状**铺满**它拿到的盒子，而组框 = 「向外取偶 + 羽化外扩 + 多区域并集
 *    + 整段时间并集」，两者根本不是一个框。照直传进去圆会被拉成椭圆、多区域组只剩
 *    第一个区域被拉满整框 —— 不报错，画面静默错。详见 `maskRaster.ts:208` 的注释。
 *
 * ② **整数只算一次。** 蒙版的宽高**直接取** `planMaskGroups` 给出的 `g.box`，
 *    与 `crop=BW:BH:BX:BY` 的字面量是同一组数。两处各 `Math.round` 一次的下场不是
 *    画面偏一点，而是 `alphamerge` 报 `Input frame sizes do not match` **整段导出失败**。
 *    所以本文件**不做任何取整**，只做 `planMaskGroups(regions, canvas)` 的复算 ——
 *    该函数是纯的、确定的（5.3 已钉），调用方与编译器算出的组必然逐字段相同。
 *
 * ③ **零回归**：`kind === "legacy"` 的组一个字节都不写，也不注册输入。
 *    矩形 + 无羽化 + 无关键帧的既有数据继续走 drawbox / split-crop-overlay（§5.3.1）。
 *
 * ## 生命周期
 *
 * 文件名 `mask_s{seg}_c{clip}_g{group}.gray`，全部落在**导出工作目录下的
 * `masks/` 子目录**里。`renderer.ts` 的 `finally` 早就有一句
 * `remove(work, { recursive: true })`，成功 / 失败 / 取消三条路径共用 ——
 * 把蒙版放进 `work/` 就是**免费**继承了这条清理，而不是再写一套自己的清理逻辑
 * （再写一套 = 三条路径里总有一条会被漏掉）。
 * 在此之上，每段渲染完成后立刻 `retireFiles` 掉该段的蒙版，把**峰值**从
 * 「全片所有蒙版」压到「单段蒙版」。
 *
 * ## 动画组为什么会有预算
 *
 * 动画组走的是「逐帧蒙版顺序拼进同一个 .gray」（5.4 定的，`-framerate` 那条路）。
 * 小框无所谓：300×300 × 90 帧 = 8 MB。但一个横穿画面的遮挡会被 `FULL_FRAME_RATIO`
 * 判成整幅，1080×1920 × 30fps × 30s = **1.86 GB**，用户的盘会在导出跑了一半时爆掉，
 * 而那是最贵的一种失败。所以有 `MASK_BUDGET_BYTES`：超预算时把最大的动画组降级成
 * 「整段时间的并集」静态蒙版 —— **只会多遮、不会漏遮**（与 `alignBox` 一律向外扩
 * 同一个取舍：少遮就是用户该挡住的东西露出来），并且**必须给用户可见提示**，
 * 不许静默把动画吃掉。
 */

import type { MosaicParams, RenderClip } from "./model";
import { clipMosaics } from "./model";
import type { CanvasPx, MaskGroup } from "./maskGroups";
import { planMaskGroups, isAnimated, normalizeKfs } from "./maskGroups";
import { rasterGroupMask } from "./maskRaster";

/** 单段蒙版的磁盘预算。超过则把最大的动画组降级为静态并集蒙版（并提示用户）。 */
export const MASK_BUDGET_BYTES = 256 * 1024 * 1024;

/** 降级成并集蒙版时，最多在时间轴上采样多少个点（另外总会带上全部关键帧时刻）。 */
export const UNION_SAMPLES = 96;

/** 单次写盘的最大字节数：逐帧生成、分块落盘，避免把整条动画蒙版堆在 JS 堆里。 */
export const WRITE_CHUNK_BYTES = 8 * 1024 * 1024;

/** 超预算降级时给用户看的话。**不带数字**，好让多段之间自然去重。 */
export const NOTICE_BUDGET =
  "⚠️ 有动画遮挡的逐帧蒙版超出单段磁盘预算，已改用「整段范围」的静态遮挡："
  + "只会多遮、不会漏遮，但遮挡不再跟着动画走。缩短镜头或缩小遮挡范围可恢复逐帧动画。";

const pad = (v: number, n: number) => String(Math.max(0, Math.trunc(v))).padStart(n, "0");

/** `(segIdx, clipIdx, groupIdx)` → 文件名。三元组是因为每段是一次独立的 ffmpeg 调用。 */
export function maskFileName(segIdx: number, clipIdx: number, groupIdx: number): string {
  return `mask_s${pad(segIdx, 4)}_c${pad(clipIdx, 2)}_g${pad(groupIdx, 2)}.gray`;
}

/** 一张蒙版的产出计划。`frame(i)` 是惰性的 —— 调用方逐帧取、逐块写。 */
export interface MaskSpec {
  clipIdx: number;
  groupIdx: number;
  name: string;
  /** 蒙版尺寸 = `planMaskGroups` 给的组框尺寸，**不重算** */
  w: number;
  h: number;
  /** 写进 .gray 的帧数：静态 1，动画 = ⌈时长 × fps⌉ + 1 */
  frames: number;
  bytes: number;
  /** 组内有动画区域（决定编译器要不要给这路输入加 `-framerate`） */
  animated: boolean;
  /** 动画组被预算降级成了静态并集蒙版 */
  degraded: boolean;
  frame(i: number): Uint8Array;
}

export interface SegmentMaskPlan {
  specs: MaskSpec[];
  bytes: number;
  /** 面向用户的提示（降级等）。调用方负责去重后展示。 */
  notices: string[];
}

/** 只取本模块需要的那部分 clip，方便验证脚本直接构造。 */
export interface MaskClipInput {
  /** clip 在成片上的时长（秒，**已含变速**）—— 与 `tSec` 同为输出时间口径 */
  durationSec: number;
  mosaics: MosaicParams[];
}

/** `RenderClip[]` → 本模块的输入。马赛克的提取口径与编译器共用 `clipMosaics`。 */
export function maskClipsOf(clips: RenderClip[]): MaskClipInput[] {
  return clips.map((c) => ({ durationSec: c.durationSec, mosaics: clipMosaics(c) }));
}

/**
 * 「整段时间的并集」蒙版：逐采样时刻光栅化，按 `max` 叠起来。
 *
 * 采样点 = 全部关键帧时刻（形状的转折必然在这些点上）+ 均匀采样。
 * 只取 max 是刻意的：任何一个时刻要遮的像素，在并集里都被遮住 —— 降级只会多遮。
 */
function unionMask(
  mosaics: MosaicParams[],
  g: Extract<MaskGroup, { kind: "mask" }>,
  canvas: CanvasPx,
  durSec: number,
  fps: number,
): Uint8Array {
  const times = new Set<number>([0]);
  for (const r of g.regionIdxs) {
    for (const k of normalizeKfs(mosaics[r]?.keyframes)) {
      times.add(Math.max(0, Math.min(durSec, k.tSec)));
    }
  }
  const n = Math.max(2, Math.min(UNION_SAMPLES, Math.ceil(durSec * fps) + 1));
  for (let i = 0; i < n; i++) times.add((durSec * i) / (n - 1));

  const out = new Uint8Array(g.box.w * g.box.h);
  for (const t of [...times].sort((a, b) => a - b)) {
    const m = rasterGroupMask(mosaics, g, canvas, t);
    for (let j = 0; j < out.length; j++) if (m[j] > out[j]) out[j] = m[j];
  }
  return out;
}

/**
 * 规划一段（segment）要产出的全部蒙版。**纯函数**，不碰文件系统 ——
 * 因此可以在 node 下逐字节核对，也是真导出冒烟脚本产真蒙版的那条路。
 *
 * @param clips  本段的 clip（顺序即 `compileSegment` 里的 `-i` 顺序，`clipIdx` 即下标）
 * @param canvas 画布像素尺寸（= `plan.output.width/height`，马赛克作用在 pad 之后的流上）
 * @param fps    输出帧率（= `plan.output.fps`），动画蒙版按它逐帧采样
 */
export function planSegmentMasks(
  segIdx: number,
  clips: MaskClipInput[],
  canvas: CanvasPx,
  fps: number,
  budgetBytes: number = MASK_BUDGET_BYTES,
): SegmentMaskPlan {
  // fps/时长来自 RenderPlan，理论上恒为正；兜一下是因为一旦是 0/NaN，
  // 下面的 `Math.ceil(dur*fps)` 会算出 NaN 帧，表现是写出一个空 .gray 然后
  // ffmpeg 报「Input frame sizes do not match」——一个极难反查的间接失败。
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 25;

  interface Draft {
    clipIdx: number;
    groupIdx: number;
    g: Extract<MaskGroup, { kind: "mask" }>;
    mosaics: MosaicParams[];
    durSec: number;
    animated: boolean;
    frames: number;
    degraded: boolean;
  }

  const drafts: Draft[] = [];
  clips.forEach((c, clipIdx) => {
    if (!c.mosaics.length) return;
    const durSec = Number.isFinite(c.durationSec) && c.durationSec > 0 ? c.durationSec : 0;
    // ⚠️ 与编译器**同一个纯函数、同一份入参**。5.3 钉住了它的确定性，
    // 所以两边各算一次也必然得到同一组 groupIdx —— 不需要把结果传来传去。
    planMaskGroups(c.mosaics, canvas).forEach((g, groupIdx) => {
      if (g.kind !== "mask") return;      // legacy 组：一个字节都不写（§5.3.1 零回归）
      const animated = g.regionIdxs.some((r) => isAnimated(c.mosaics[r]));
      // +1 帧：framesync 会重复末帧，但少一帧意味着最后一帧用的是**前一帧**的形状。
      const frames = animated ? Math.max(1, Math.ceil(durSec * safeFps) + 1) : 1;
      drafts.push({ clipIdx, groupIdx, g, mosaics: c.mosaics, durSec, animated, frames, degraded: false });
    });
  });

  // ---- 预算：超了就把**最大的**动画组降级为静态并集蒙版 ----
  const sizeOf = (d: Draft) => d.g.box.w * d.g.box.h * d.frames;
  let total = drafts.reduce((s, d) => s + sizeOf(d), 0);
  const notices: string[] = [];
  while (total > budgetBytes) {
    let worst: Draft | null = null;
    for (const d of drafts) {
      if (!d.animated || d.degraded) continue;
      if (!worst || sizeOf(d) > sizeOf(worst)) worst = d;
    }
    // 没有可降的了（全是静态组）：静态蒙版一张就是一帧，再降也降不动。
    // 此时**不报错**——静态蒙版总量超预算意味着画布本身极大，那是正常开销。
    if (!worst) break;
    total -= sizeOf(worst);
    worst.degraded = true;
    worst.frames = 1;
    total += sizeOf(worst);
    if (!notices.includes(NOTICE_BUDGET)) notices.push(NOTICE_BUDGET);
  }

  const specs = drafts.map((d): MaskSpec => {
    const { w, h } = d.g.box;
    let cached: Uint8Array | null = null;
    const stat = () => (cached ??= d.degraded
      ? unionMask(d.mosaics, d.g, canvas, d.durSec, safeFps)
      : rasterGroupMask(d.mosaics, d.g, canvas, 0));
    return {
      clipIdx: d.clipIdx,
      groupIdx: d.groupIdx,
      name: maskFileName(segIdx, d.clipIdx, d.groupIdx),
      w, h,
      frames: d.frames,
      bytes: w * h * d.frames,
      animated: d.animated,
      degraded: d.degraded,
      // 逐帧的 tSec 是**输出时间**（i / fps），与 `RegionKeyframe.tSec` 同口径 ——
      // 马赛克串在 clipVideoChain 之后，setpts 已经生效，滤镜里的 t 就是输出秒。
      frame: (i: number) => (d.frames === 1
        ? stat()
        : rasterGroupMask(d.mosaics, d.g, canvas, i / safeFps)),
    };
  });

  return { specs, bytes: specs.reduce((s, x) => s + x.bytes, 0), notices };
}

export const NOTICE_NO_ALPHAMERGE =
  "⚠️ 本机 ffmpeg 缺少 alphamerge 滤镜：遮挡的**羽化**与**关键帧动画**本次不会生效"
  + "（形状仍然保留）。请升级客户端内置的 ffmpeg。";

export const NOTICE_RECT_ONLY =
  "⚠️ 本机 ffmpeg 同时缺少 alphamerge 与 geq 滤镜：椭圆 / 画笔遮挡本次退化为**矩形**，"
  + "遮挡范围会比你画的大。请升级客户端内置的 ffmpeg。";

/**
 * 降级提示（§5.3.1 的降级顺序：alphamerge 不可用 → 落回 geq，形状保住；
 * geq 也不可用 → 才退成矩形，**且必须有用户可见提示**）。
 *
 * 多出来的那条 `NOTICE_NO_ALPHAMERGE` 是刻意加的：计划书只要求"退成矩形时提示"，
 * 但**羽化和关键帧在落回 geq 那一档就已经没了** —— 旧路径压根不认识这两个字段。
 * 只提示最后一档，等于让用户在"形状对、羽化没了"的情况下完全无从判断。
 */
export function maskDegradeNotices(
  clips: MaskClipInput[],
  has: { alphamerge: boolean; geq: boolean },
): string[] {
  const out: string[] = [];
  const all = clips.flatMap((c) => c.mosaics);
  const live = all.filter((m) => !(m.shape === "brush" && (m.stroke?.length ?? 0) === 0));
  if (!has.alphamerge && live.some((m) => (m.feather ?? 0) > 0 || isAnimated(m))) {
    out.push(NOTICE_NO_ALPHAMERGE);
  }
  if (!has.alphamerge && !has.geq && live.some((m) => (m.shape ?? "rect") !== "rect")) {
    out.push(NOTICE_RECT_ONLY);
  }
  return out;
}

/** 写盘注入点：本模块**不 import Tauri**，好让生命周期能在 node 下被真的测出来。 */
export interface MaskIO {
  join(dir: string, name: string): Promise<string>;
  /** `append=false` 时创建/截断，`true` 时追加 */
  write(path: string, data: Uint8Array, append: boolean): Promise<void>;
}

/**
 * 把一段的蒙版真的写到盘上。
 *
 * @returns `"{clipIdx}:{groupIdx}"` → 绝对路径。直接喂给 `CompileCtx.maskPath`。
 *
 * ⚠️ 中断检查放在**每一块**之前而不是每个文件之前：一个 30s 的整幅动画蒙版
 * 就要写几百 MB，只在文件之间检查等于取消后还要干等一分钟。
 */
export async function writeSegmentMasks(
  dir: string,
  plan: SegmentMaskPlan,
  io: MaskIO,
  signal?: AbortSignal,
  onAbort?: () => never,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of plan.specs) {
    if (s.w <= 0 || s.h <= 0 || s.frames <= 0) continue;
    const path = await io.join(dir, s.name);
    const perFrame = s.w * s.h;
    const chunkFrames = Math.max(1, Math.floor(WRITE_CHUNK_BYTES / perFrame));
    let first = true;
    for (let i = 0; i < s.frames; i += chunkFrames) {
      if (signal?.aborted) onAbort?.();
      const n = Math.min(chunkFrames, s.frames - i);
      const buf = new Uint8Array(perFrame * n);
      for (let k = 0; k < n; k++) buf.set(s.frame(i + k), k * perFrame);
      await io.write(path, buf, !first);
      first = false;
    }
    out.set(`${s.clipIdx}:${s.groupIdx}`, path);
  }
  return out;
}
