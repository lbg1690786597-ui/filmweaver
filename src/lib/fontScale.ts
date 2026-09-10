/**
 * lib/fontScale.ts — 界面字号缩放（设置 · 外观 · 界面字号）
 *
 * 用户原话：「设置里面应该允许用户设置字体大小」。
 *
 * ## 实现方式：一个 CSS 乘子，不是"换一套字号"
 *
 * `--fs-scale` 挂在 `<html>` 的 inline style 上，`tokens.css` 的 6 个字号 token
 * 与各组件 CSS 里的硬编码字号统一写成 `calc(Npx * var(--fs-scale, 1))`。
 * 于是改一个变量，全界面文字同步缩放，**不触发 React 重渲染**（纯 CSS 层的事）。
 *
 * 为什么不用 `html { font-size }` + rem：全项目字号是 px 写的（60 多处硬编码），
 * 改根字号对它们没有任何作用，得先把所有 px 换成 rem——那是更大的机械改动，
 * 而且 rem 一改会连带 padding/圆角等用 rem 写的量（本项目没有，但以后会有）。
 *
 * ## 为什么必须在 React 挂载之前应用
 *
 * 放在组件的 `useEffect` 里的话，首屏会先按 1.0 画一帧、再跳到用户设定的档位，
 * 肉眼可见"字先小后大"的闪跳。`main.tsx` 在 render 之前调 `applyFontScale()`，
 * 首帧就是对的。
 *
 * ## 不参与缩放的东西
 *
 * 烧录字幕的字号（`features/subtitles/TextPanel` 的 `style.fontSize`）**不缩放**：
 * 那是要烧进视频画面的像素尺寸，跟界面无关。用户把界面调大却发现成片字幕也变大，
 * 是不可接受的串台。
 */
import { readPref, writePref } from "./prefs";

/** 可选档位。跨度控制在 0.85–1.3：再小会低于 10px（中文糊成一团），
 *  再大时间轴/检查器的固定宽度容不下，标签会开始截断。 */
export const FONT_SCALES = [
  { v: 0.85, label: "紧凑", hint: "更多内容，字略小" },
  { v: 1, label: "标准", hint: "默认" },
  { v: 1.15, label: "较大", hint: "长时间看剧本更省眼" },
  { v: 1.3, label: "特大", hint: "高分屏 / 远距离看" },
] as const;

const PREF_KEY = "fontScale";
export const FONT_SCALE_DEFAULT = 1;

/** 夹到合法范围：偏好被手改坏（0 或负数）会让整个界面字号塌成 0，必须兜住。 */
function clamp(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return FONT_SCALE_DEFAULT;
  return Math.min(1.6, Math.max(0.7, n));
}

export function getFontScale(): number {
  return clamp(readPref(PREF_KEY, FONT_SCALE_DEFAULT));
}

/** 写进 <html> 的 inline style。1.0 时**删掉**属性而不是写 "1"，
 *  让 tokens.css 里的默认值生效——少一层覆盖，调试时看得清是不是默认档。 */
export function applyFontScale(scale?: number): number {
  const v = clamp(scale ?? getFontScale());
  const root = document.documentElement;
  if (v === FONT_SCALE_DEFAULT) root.style.removeProperty("--fs-scale");
  else root.style.setProperty("--fs-scale", String(v));
  return v;
}

/** 设置页选档：落偏好 + 立即生效（无需刷新）。 */
export function setFontScale(scale: number): number {
  const v = clamp(scale);
  writePref(PREF_KEY, v);
  return applyFontScale(v);
}
