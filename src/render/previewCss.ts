/**
 * transformToCss — 把 Shot.transform_meta 翻译成 CSS，供预览器实时显示。
 *
 * ## 为什么需要
 *
 * 滤镜/调节面板改完参数会写进 transform_meta，但预览器此前完全不读它 ——
 * 用户拖了滑块看不到任何变化，只能导出后才知道效果，等于盲调。
 *
 * ## 这是**近似**，不是所见即所得
 *
 * 最终渲染走 ffmpeg（eq/curves/unsharp/gblur…），CSS filter 的算法与之
 * 并不等价。两者在以下方面必然有差异：
 *   - 色温/色调：ffmpeg 用 colortemperature/colorbalance 按色度学换算，
 *     CSS 这边只能用 sepia+hue-rotate 凑，偏移量对不上
 *   - 高光/阴影：CSS 没有分区调整，只能整体提亮/压暗近似
 *   - 锐化、颗粒、glitch：CSS 无对应能力，预览里直接不体现
 *
 * 所以预览的定位是**看趋势**（往哪个方向调、调了多少），不是校色依据。
 * UI 上标注了"预览为近似效果"，避免用户拿它当最终成片判断。
 *
 * ## 取值约定
 *
 * 面板里的调色项范围是 -100..100，0 = 不改变。
 * transform 类（scale/rotate/x/y/mirror）单独走 CSS transform。
 */

import type { TransformMeta } from "../api";

/** -100..100 → 乘数，100 对应 max，-100 对应 min（1 = 原样） */
function toFactor(v: number, max: number, min: number): number {
  const n = Math.max(-100, Math.min(100, v));
  return n >= 0 ? 1 + (n / 100) * (max - 1) : 1 + (n / 100) * (1 - min);
}

/** 生成 CSS filter 字符串；无可视项时返回空串（避免无谓的合成层） */
export function transformToFilter(tm: TransformMeta | null | undefined): string {
  if (!tm) return "";
  const f: string[] = [];

  // 曝光 → brightness。±100 映射到 0.4x..1.6x，超出这个范围预览会糊成一片
  if (tm.exposure) f.push(`brightness(${toFactor(tm.exposure, 1.6, 0.4).toFixed(3)})`);
  if (tm.contrast) f.push(`contrast(${toFactor(tm.contrast, 1.8, 0.3).toFixed(3)})`);
  if (tm.saturation) f.push(`saturate(${toFactor(tm.saturation, 2.0, 0).toFixed(3)})`);

  // 色温：正 = 偏暖。CSS 没有色温滤镜，用 sepia 叠加近似暖色，
  // 冷色用 hue-rotate 往蓝偏。这是全篇误差最大的一项。
  if (tm.temperature) {
    const t = Math.max(-100, Math.min(100, tm.temperature));
    if (t > 0) f.push(`sepia(${(t / 100 * 0.35).toFixed(3)})`);
    else f.push(`hue-rotate(${(t / 100 * 18).toFixed(1)}deg)`);
  }
  // 色调：绿↔品红，用 hue-rotate 近似
  if (tm.tint) f.push(`hue-rotate(${(Math.max(-100, Math.min(100, tm.tint)) / 100 * 22).toFixed(1)}deg)`);

  // 高光/阴影：CSS 无分区调整，只能整体近似 —— 幅度刻意压小，
  // 免得预览里看着变化很大、实际渲染只动了高光区
  if (tm.highlights) f.push(`brightness(${toFactor(tm.highlights * 0.5, 1.25, 0.8).toFixed(3)})`);
  if (tm.shadows) f.push(`contrast(${toFactor(-tm.shadows * 0.4, 1.2, 0.85).toFixed(3)})`);

  // 逐帧特效里只有模糊/暗角能用 CSS 表达；其余（grain/glitch/shake…）
  // 预览不体现，UI 已注明"仅渲染时生效"
  if (tm.blur) f.push(`blur(${(tm.blur / 100 * 6).toFixed(2)}px)`);

  if (tm.opacity != null && tm.opacity !== 1) f.push(`opacity(${tm.opacity})`);
  return f.join(" ");
}

/** 生成 CSS transform（缩放/旋转/位移/镜像） */
export function transformToTransform(tm: TransformMeta | null | undefined): string {
  if (!tm) return "";
  const t: string[] = [];
  if (tm.x || tm.y) t.push(`translate(${tm.x || 0}%, ${tm.y || 0}%)`);
  if (tm.scale && tm.scale !== 1) t.push(`scale(${tm.scale})`);
  if (tm.rotate) t.push(`rotate(${tm.rotate}deg)`);
  // 镜像用 scale 负值；与上面的 scale 相乘不冲突（CSS 按顺序应用）
  if (tm.mirrorH) t.push("scaleX(-1)");
  if (tm.mirrorV) t.push("scaleY(-1)");
  return t.join(" ");
}

/** 暗角无法用 filter 表达，需要一层叠加元素。返回其 background 值（无则空串） */
export function vignetteOverlay(tm: TransformMeta | null | undefined): string {
  if (!tm?.vignette) return "";
  const a = Math.max(0, Math.min(100, tm.vignette)) / 100 * 0.85;
  return `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${a.toFixed(2)}) 100%)`;
}

/** 预览里体现不出来的项 —— UI 据此提示用户"这些要导出才能看到"。
 *
 *  gpuActive: WebGL 路径能做 LUT 和暗角，CSS 路径做不了，所以清单不同。
 *  两条路径都做不了的是需要卷积/逐帧合成的那些（锐化、颗粒、故障…）。 */
export function unpreviewableEffects(
  tm: TransformMeta | null | undefined,
  gpuActive = false,
): string[] {
  if (!tm) return [];
  const names: string[] = [];
  if (tm.grain) names.push("颗粒");
  if (tm.glitch) names.push("故障");
  if (tm.shake) names.push("抖动");
  if (tm.zoomPulse) names.push("缩放脉冲");
  if (tm.flash) names.push("闪白");
  if (tm.glow) names.push("辉光");
  if (tm.sharpen) names.push("锐化");
  // LUT 只有 WebGL 能预览（CSS filter 根本没有查找表能力）
  if (tm.lut && !gpuActive) names.push("LUT");
  return names;
}
