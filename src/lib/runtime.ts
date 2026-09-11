/**
 * 渲染引擎能力体检 —— 用来解释"界面看起来完全不对"这类只在个别机器上出现的故障。
 *
 * 背景（2026-09-10）：有用户反馈界面完全混乱（弹窗没有底色、边框消失、内容互相压住）。
 * 排查下来源码、打包、安装包三处都正常，成因在**用户机器上的 Edge WebView2 运行时版本**：
 * 我们的设计 token 全部写成 `oklch()`、还有 138 处 `color-mix()`，这两个特性都要
 * Chromium ≥ 111（2023-03）。老运行时读不懂这些值 → 含 var() 的声明在代换后
 * "invalid at computed-value time" → **整条声明作废**（背景变透明、边框直接没有），
 * 而宽高间距这些不含 var() 的声明照常生效，于是就成了"排版还在、颜色全塌"。
 *
 * oklch 那部分已在 styles/tokens.css 用 @supports + hex 回退兜住；
 * color-mix 的 138 处色块无法在样式层回退（它的参数是 var()，任何构建工具都算不出来），
 * 在老运行时上会退化成"没有淡色底"——能用，但不完整。
 *
 * 所以这里做两件事：把版本号摆到「设置」里（用户截个图就能定位，不用再猜），
 * 以及在确实过旧时说一句人话，告诉用户升级 WebView2 就能恢复。
 */

/** 我们依赖的最低 Chromium 主版本号（oklch / color-mix 都是这一版落地的）。 */
export const MIN_CHROMIUM = 111;

function supports(prop: string, value: string): boolean {
  try {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function"
      && CSS.supports(prop, value);
  } catch {
    // CSS.supports 本身在任何 Chromium 上都有；真进了这里说明环境比预期还怪，
    // 一律按"不支持"处理——宁可多提示一次，也别把坏掉的界面说成正常。
    return false;
  }
}

/** UA 里的 Chromium 主版本号；解析不出来返回 null（不猜、不编）。 */
export function chromiumMajor(): number | null {
  const m = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

export interface RuntimeCheck {
  /** Chromium 主版本号，解析不出来为 null */
  chromium: number | null;
  /** 设计 token 用的 oklch() 是否可用 */
  oklch: boolean;
  /** 138 处淡色底用的 color-mix() 是否可用 */
  colorMix: boolean;
  /** 是否有能力缺失（任一为 false） */
  degraded: boolean;
}

export function checkRuntime(): RuntimeCheck {
  const oklch = supports("color", "oklch(0% 0 0)");
  const colorMix = supports("color", "color-mix(in oklch, red, blue)");
  return { chromium: chromiumMajor(), oklch, colorMix, degraded: !oklch || !colorMix };
}

/** 给用户看的一句话；能力齐全时返回 null。 */
export function runtimeWarning(r: RuntimeCheck = checkRuntime()): string | null {
  if (!r.degraded) return null;
  const ver = r.chromium === null ? "未知版本" : `Chromium ${r.chromium}`;
  return `当前渲染引擎（${ver}）比软件要求的 ${MIN_CHROMIUM} 旧，部分配色会显示不全。`
    + "更新 Microsoft Edge WebView2 运行时即可恢复。";
}
