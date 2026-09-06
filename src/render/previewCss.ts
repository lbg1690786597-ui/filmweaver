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

/** 裁切后仍保留的画面比例（宽、高），已做下限保护 */
function cropVisible(c: NonNullable<TransformMeta["crop"]>) {
  return {
    w: Math.max(0.01, 1 - (c.left || 0) - (c.right || 0)),
    h: Math.max(0.01, 1 - (c.top || 0) - (c.bottom || 0)),
  };
}

/**
 * 取景框裁切的预览裁剪区（clip-path）。
 *
 * ⚠️ 这条此前**完全缺失** —— crop 只在 ffmpegCompiler 里被实现（导出时真裁），
 * 预览层一行都没读。于是用户拖"裁切边距"滑块，画面纹丝不动，导出后却突然
 * 被裁掉一块（用户原话："操作裁切功能滑块看不到任何反馈"）。
 *
 * clip-path 作用在元素的 border-box 上、且**先于 transform 生效**，
 * 正好对应 ffmpeg 里 crop 排在 scale/rotate 之前的顺序。
 */
export function transformToClipPath(tm: TransformMeta | null | undefined): string {
  if (!tm?.crop) return "";
  const c = tm.crop;
  const l = c.left || 0, r = c.right || 0, t = c.top || 0, b = c.bottom || 0;
  if (l <= 0 && r <= 0 && t <= 0 && b <= 0) return "";
  // inset() 的参数顺序是 上 右 下 左
  return `inset(${(t * 100).toFixed(3)}% ${(r * 100).toFixed(3)}% `
       + `${(b * 100).toFixed(3)}% ${(l * 100).toFixed(3)}%)`;
}

/** 生成 CSS transform（缩放/旋转/位移/镜像） */
export function transformToTransform(tm: TransformMeta | null | undefined): string {
  if (!tm) return "";
  const t: string[] = [];
  // ⚠️ 单位必须与 transform_meta 的存储约定一致，否则预览与导出完全对不上：
  //   scale 存的是**百分比**（100 = 原尺寸），normalize.ts 里也是 /100 后再用；
  //         此前这里直接写 scale(tm.scale)，scale=100 就成了放大 100 倍 ——
  //         用户一点缩放手柄画面就炸开，且边框与实际画面完全错位。
  //   x / y 存的是**画布宽/高的百分比**（见 api.ts 的 TransformMeta.x）。
  //         此前这里写的是 `translate(${tm.x}px)` —— 那是**屏幕 CSS 像素**，
  //         与导出侧按画布像素解释同一个数差了整个预览缩放倍数（常见 3~5×）。
  //         CSS 的百分比位移正好按**元素自身盒子**解析，而在本项目的心智模型里
  //         <video> 元素盒 ≡ 画布（CropZoomOverlay 头注释、Player.tsx:80 都据此
  //         测量），所以百分比在这里是**精确**的，不是又一次近似。
  //         同理它也必须排在 scale 之前（CSS 变换列表右侧先作用）：
  //         位移是在画布坐标系里发生的，不该被画面自身的缩放放大。
  if (tm.x || tm.y) {
    t.push(`translate(${(tm.x || 0).toFixed(4)}%, ${(tm.y || 0).toFixed(4)}%)`);
  }
  const s = tm.scale ?? 100;
  // 非等比缩放（拖边中点单轴拉伸时产生）；缺省跟随 scale
  const sx = tm.scaleX ?? s;
  const sy = tm.scaleY ?? s;
  if (sx !== 100 || sy !== 100) {
    t.push(sx === sy
      ? `scale(${(sx / 100).toFixed(4)})`
      : `scale(${(sx / 100).toFixed(4)}, ${(sy / 100).toFixed(4)})`);
  }
  if (tm.rotate) t.push(`rotate(${tm.rotate}deg)`);
  // 镜像用 scale 负值；与上面的 scale 相乘不冲突（CSS 按顺序应用）
  if (tm.mirrorH) t.push("scaleX(-1)");
  if (tm.mirrorV) t.push("scaleY(-1)");

  // ---- 裁切后"放大铺满画布"----
  //
  // clip-path 只把画面切掉一块，留下的部分**不会**自己撑满 —— 但 ffmpeg 那边
  // crop 之后紧跟 scale + pad，裁出来的区域会被等比放大到画布里。少了这一步，
  // 预览会显示成"原位置挖了一块"，跟成片完全不是一回事。
  //
  // 追加在数组**末尾**：CSS transform 列表最右侧的先作用，正好对应
  // ffmpeg 里 crop 排在最前面的顺序。
  if (tm.crop) {
    const { w: visW, h: visH } = cropVisible(tm.crop);
    if (visW < 0.999 || visH < 0.999) {
      // 等比放大到"刚好装下"，与 ffmpeg 的 force_original_aspect_ratio=decrease
      // 一致 —— 是**贴合**不是拉伸，比例不同的裁切会留黑边，成片也是这样。
      const k = Math.min(1 / visW, 1 / visH);
      // 保留区中心相对画面中心的偏移，先平移把它挪到中心，再放大
      const dx = ((tm.crop.left || 0) + visW / 2 - 0.5) * 100;
      const dy = ((tm.crop.top || 0) + visH / 2 - 0.5) * 100;
      if (k > 1.0001) t.push(`scale(${k.toFixed(4)})`);
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        t.push(`translate(${(-dx).toFixed(3)}%, ${(-dy).toFixed(3)}%)`);
      }
    }
  }

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
