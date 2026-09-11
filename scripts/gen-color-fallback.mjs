/**
 * 给 src/styles/tokens.css 生成"@supports 之外"的 hex 回退块。
 *
 * 为什么必须是 @supports 而不是"同一处写两遍"，以及这件事的来龙去脉，
 * 见 tokens.css 文件头（2026-09-10 线上事故）。一句话：自定义属性的值在解析期
 * 不做校验，`--c-bg: #111417; --c-bg: oklch(...)` 里后者永远赢，兜不住底。
 *
 * 用法：
 *   node scripts/gen-color-fallback.mjs           # 校验回退块与 oklch 是否一致
 *   node scripts/gen-color-fallback.mjs --write   # 就地重写回退块
 *
 * 改了 tokens.css 里任何一个 oklch 值之后**必须**重跑 --write，
 * 否则老运行时上看到的配色会和新运行时对不上。npm run build 已带上校验。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { oklchToHex, oklchToRgb } from "./oklch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = join(HERE, "..", "src", "styles", "tokens.css");

const BEGIN = "/* >>> 老运行时颜色回退（由 scripts/gen-color-fallback.mjs 生成，勿手改）>>> */";
const END = "/* <<< 老运行时颜色回退结束 <<< */";
/** 兼容首版（Python 实现）留下的标记，便于就地替换 */
const BEGIN_ALT = "/* >>> 老运行时颜色回退（由 scripts/gen-color-fallback.py 生成，勿手改）>>> */";

const DECL = /^[ \t]*(--[\w-]+)[ \t]*:[ \t]*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)[ \t]*;/gm;
const ANY_OKLCH = /oklch\(/g;

const SELECTORS = [":root", '[data-theme="light"]'];

function die(msg) {
  console.error(msg);
  process.exit(1);
}

/** 取生成区之外的原文——否则会把上一轮生成的 hex 当成源数据。 */
function stripGenerated(css) {
  const b = css.includes(BEGIN) ? BEGIN : css.includes(BEGIN_ALT) ? BEGIN_ALT : null;
  if (!b) return css;
  const i = css.indexOf(b);
  const j = css.indexOf(END);
  if (j < 0) die("tokens.css 里有起始标记却没有结束标记，请先修复");
  return css.slice(0, i) + css.slice(j + END.length);
}

function parseBlocks(css) {
  const body = stripGenerated(css);
  return SELECTORS.map((sel) => {
    const i = body.indexOf(sel + " {");
    if (i < 0) die(`tokens.css 里找不到选择器 ${sel}`);
    const j = body.indexOf("}", i);
    const block = body.slice(i, j);
    const pairs = [...block.matchAll(DECL)]
      .map((m) => {
        const [l, c, h] = [Number(m[2]), Number(m[3]), Number(m[4])];
        return [m[1], oklchToHex(l, c, h), oklchToRgb(l, c, h).join(" ")];
      });
    // 块里出现了 oklch 却没被认出来 → 宁可报错也不静默少生成一条
    const seen = (block.match(ANY_OKLCH) || []).length;
    if (seen !== pairs.length) {
      die(`${sel} 块里有本脚本认不出的 oklch 写法（认出 ${pairs.length}/${seen} 条），请检查`);
    }
    if (!pairs.length) die(`${sel} 块里没解析到任何 oklch token`);
    return [sel, pairs];
  });
}

function render(blocks) {
  const out = [
    BEGIN,
    "/* 老 WebView2 / 老 Chromium(<111) 不认 oklch()，会让所有 var() 颜色声明整条作废。",
    "   这里先用等价 hex 兜底；认得 oklch 的引擎走下面的 @supports，覆盖回原值。",
    "   两份值必须一致 —— 改了 oklch 记得重跑 scripts/gen-color-fallback.mjs --write。",
    "",
    "   配套的 `--x-rgb: r g b` 是同一颜色的 sRGB 三分量，给 color-mix() 的回退用：",
    "   `color-mix(in oklch, var(--c-accent) 14%, transparent)` 参数里带 var()，兜不住底，",
    "   由 vite 插件改写成前置的 `rgb(var(--c-accent-rgb) / 14%)`。三分量是纯数字，",
    "   任何引擎都认，且随主题切换，所以它**不能**放进 @supports 里。 */",
  ];
  for (const [sel, pairs] of blocks) {
    out.push(`${sel} {`);
    for (const [k, hex] of pairs) out.push(`  ${k}: ${hex};`);
    for (const [k, , rgb] of pairs) out.push(`  ${k}-rgb: ${rgb};`);
    out.push("}");
  }
  out.push(END);
  return out.join("\n");
}

const css = readFileSync(TOKENS, "utf8");
const want = render(parseBlocks(css));
const begin = css.includes(BEGIN) ? BEGIN : css.includes(BEGIN_ALT) ? BEGIN_ALT : null;

if (!begin) die("tokens.css 里没有回退块标记，请手工放一对标记后再跑 --write");
const i = css.indexOf(begin);
const j = css.indexOf(END) + END.length;
const current = css.slice(i, j);

if (process.argv.includes("--write")) {
  writeFileSync(TOKENS, css.slice(0, i) + want + css.slice(j), "utf8");
  console.log(`已写入回退块：${TOKENS}`);
} else if (current.trim() !== want.trim()) {
  die("回退块与 oklch 原值不一致 —— 请跑 node scripts/gen-color-fallback.mjs --write");
} else {
  console.log("回退块与 oklch 原值一致");
}
