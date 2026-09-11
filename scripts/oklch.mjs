/**
 * OKLCH → sRGB 换算（CSS Color 4 / Oklab 定义），零依赖。
 *
 * 全项目**只有这一份实现**，两个消费方共用：
 *   1. scripts/gen-color-fallback.mjs —— 给 tokens.css 生成 @supports 外的 hex 回退
 *   2. vite.config.ts 的 postcss 插件 —— 给组件 CSS 里写死的 oklch() 补前置回退
 * 分成两份算法一定会漂移，那时"老机器上的配色"和"新机器上的配色"就对不上了。
 *
 * 为什么需要回退，见 src/styles/tokens.css 文件头（2026-09-10 线上事故）。
 */

/** 我们依赖的最低 Chromium 主版本（oklch / color-mix 均在此版落地）。 */
export const MIN_CHROMIUM = 111;

function gamma(u) {
  // 出色域的分量直接夹取。界面色都是低 chroma，实测夹取幅度肉眼不可辨；
  // 真做 gamut mapping 对"让老机器能看"这个目标属于过度设计。
  u = Math.max(0, Math.min(1, u));
  const v = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

/** @returns {[number, number, number]} 0-255 的 sRGB 三分量 */
export function oklchToRgb(lPct, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const l = lPct / 100;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    gamma(+4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    gamma(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    gamma(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ];
}

export function oklchToHex(lPct, c, h) {
  const [r, g, b] = oklchToRgb(lPct, c, h);
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** `oklch(L% C H)` 或 `oklch(L% C H / A)`；不认 `oklch(from …)` 那种相对色语法。 */
const OKLCH = /oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)/g;

/**
 * 判断一个 CSS 值能否安全地生成回退。
 *
 * 含 `var()` 的值**不行**：这类声明在解析期一律有效（代换是后面的事），
 * 所以它会把前面那条回退挤出层叠，等代换失败作废时回退早就不在了。
 * 那种情况只能靠 @supports，不能靠"写两遍"。
 * `oklch(from …)` 是相对色语法（Chromium 119+），参数里必带 var()，同理排除。
 */
export function canFallback(value) {
  return value.includes("oklch(")
    && !value.includes("var(")
    && !/oklch\(\s*from/.test(value);
}

/** 把值里所有 oklch() 换成 hex / rgba；没得换则原样返回。 */
export function toLegacyValue(value) {
  return value.replace(OKLCH, (_m, l, c, h, alpha) => {
    const [r, g, b] = oklchToRgb(Number(l), Number(c), Number(h));
    if (alpha === undefined) {
      const hex = (n) => n.toString(16).padStart(2, "0");
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    }
    const a = alpha.endsWith("%") ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  });
}

/* ------------------------------------------------------------------ *
 * color-mix() 的回退
 * ------------------------------------------------------------------ */

/** 按顶层逗号切分（括号内的逗号不算）。 */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** 取 `var(--name[, …])` 里的 name；不是纯 var() 则返回 null。 */
function varName(arg) {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/.exec(arg.trim());
  return m ? m[1] : null;
}

/**
 * 老引擎判别式：认得 color-mix 的引擎里它为假，整块跳过；不认得的引擎里它为真。
 * @supports 本身很老（Chrome 28+），认不出的值一律判 false，所以 not 就成立。
 */
export const NOT_COLOR_MIX = "not (color: color-mix(in oklch, red 50%, blue))";

/**
 * 把 `color-mix(in X, var(--tok) N%, …)` 改写成 `rgb(var(--tok-rgb) / N%)`。
 *
 * color-mix() 同样要 Chromium ≥ 111，而它的参数里必带 var()，所以**不能**靠
 * "写两遍" —— 含 var() 的声明在解析期一律有效，会把前面那条回退挤出层叠
 * （见 canFallback 的注释）。改写后的值里还是有 var()，所以它同样只能放进
 * `@supports ${NOT_COLOR_MIX}` 里，由 vite 插件紧跟在原规则后面插一份同选择器的副本。
 *
 * 改写本身的道理：本项目里 color-mix 全是"某个 token 掺 N%"，那就是给这个 token
 * 加 N% 透明度。三分量 token（`--c-accent-rgb: 0 165 218`，由
 * scripts/gen-color-fallback.mjs 生成）是纯数字，老引擎认得，且跟着 [data-theme]
 * 一起切换，于是 `rgb(var(--c-accent-rgb) / 14%)` 在老引擎上能画出同样的浅色调。
 *
 * 第二个参数是别的 token（而非 transparent）时，这是**近似**：把 A 掺进 B，
 * 与"把 A 以 N% 不透明度画在 B 上"只有在元素父级底色正好是 B 时才完全相等。
 * 本项目里这类元素（时间线片段、行高亮）父级底色确实就是那个 token，
 * 且这只影响老引擎 —— 比整条作废、色块彻底消失要好得多。
 *
 * @returns 改写后的值；没有可改写的 color-mix 时返回 null
 */
export function colorMixToRgba(value) {
  if (!value.includes("color-mix(")) return null;
  let out = "";
  let i = 0;
  let hit = false;
  while (i < value.length) {
    const at = value.indexOf("color-mix(", i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    // 找到配对的右括号
    let j = at + "color-mix(".length;
    let depth = 1;
    while (j < value.length && depth) {
      if (value[j] === "(") depth++;
      else if (value[j] === ")") depth--;
      j++;
    }
    const whole = value.slice(at, j);
    const parts = splitTop(value.slice(at + "color-mix(".length, j - 1));
    let replaced = null;
    if (parts.length === 3 && /^in\s+[\w-]+$/.test(parts[0])) {
      const m = /^([\s\S]+?)\s+([\d.]+)%$/.exec(parts[1]);
      const name = m ? varName(m[1]) : varName(parts[1]);
      if (name) replaced = `rgb(var(${name}-rgb) / ${m ? m[2] : "50"}%)`;
    }
    if (replaced) hit = true;
    out += replaced ?? whole;
    i = j;
  }
  return hit ? out : null;
}
