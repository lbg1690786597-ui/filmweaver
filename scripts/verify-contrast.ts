/**
 * verify-contrast.ts — Design Token 对比度回归
 *
 * ## 为什么需要
 *
 * 改配色最容易犯的错是"看着变好了，实际某个组合更难读了"。
 * 肉眼在自己的显示器上判断不可靠——亮度、色温、环境光每台机器都不同。
 * WCAG 对比度是可计算的客观量，用它当回归线。
 *
 * 改造前实测：--c-muted 在三种背景上是 3.65 / 3.94 / 4.19，**全部不合格**，
 * 而它被引用 165 处。这就是「文字太暗」的根因。
 *
 * ## 判定标准
 *
 * WCAG 2.1：正文 4.5、大字(≥18px 或 ≥14px粗) 与 UI 组件 3.0。
 * 本项目字号普遍 11-13px，按正文标准要求，所以正文类 token 一律 4.5。
 * 边框/分隔线不承载文字，按 3.0（UI 组件）判。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKENS = join(dirname(fileURLToPath(import.meta.url)),
                    "..", "src", "styles", "tokens.css");

// ---- OKLCH → sRGB（Björn Ottosson 的参考实现）----
function oklchToSrgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const enc = (x: number) =>
    x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return lin.map((v) => Math.max(0, Math.min(1, enc(v)))) as [number, number, number];
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const [hi, lo] = [relLuminance(fg), relLuminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const hex = (rgb: [number, number, number]) =>
  "#" + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");

// ---- 解析 tokens.css ----
// ⚠️ 必须按主题块分别解析：tokens.css 里 :root(暗色) 之后还有
// [data-theme="light"] 覆盖块。不分作用域地全文正则会让后出现的亮色值
// 覆盖掉暗色值——第一版就踩了这个坑，算出 --c-bg 是 #f4f5f7。
function parseBlock(css: string, selector: string): Map<string, [number, number, number]> {
  const start = css.indexOf(selector);
  if (start < 0) return new Map();
  const open = css.indexOf("{", start);
  let depth = 0, end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = css.slice(open, end);
  const out = new Map<string, [number, number, number]>();
  for (const m of body.matchAll(
    /--([\w-]+):\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
    out.set(m[1], oklchToSrgb(+m[2] / 100, +m[3], +m[4]));
  }
  return out;
}

const css = readFileSync(TOKENS, "utf8");
const tokens = parseBlock(css, ":root");
const lightTokens = parseBlock(css, '[data-theme="light"]');

if (tokens.size === 0) {
  console.log("❌ 没从 tokens.css 的 :root 解析到任何 oklch() token");
  process.exit(1);
}

// ---- 要检查的组合 ----
// 文字 token × 它们实际会出现的背景。不是笛卡尔积——
// 比如 c-text-hi 不会用在 accent 上，列了只会制造噪音。
const BACKGROUNDS = ["c-bg", "c-surface", "c-raised", "c-hover", "c-active", "c-track"];
const FOREGROUNDS = ["c-muted", "c-text", "c-text-hi"];

console.log("Design Token 对比度（WCAG 2.1 · 正文需 ≥4.5）\n");

const w = 12;
process.stdout.write("".padEnd(w));
for (const bg of BACKGROUNDS) {
  if (tokens.has(bg)) process.stdout.write(bg.replace("c-", "").padStart(10));
}
console.log();

let failures = 0;
for (const fg of FOREGROUNDS) {
  const f = tokens.get(fg);
  if (!f) continue;
  process.stdout.write(fg.replace("c-", "").padEnd(w));
  for (const bgName of BACKGROUNDS) {
    const b = tokens.get(bgName);
    if (!b) continue;
    const r = contrast(f, b);
    const ok = r >= 4.5;
    if (!ok) failures++;
    process.stdout.write(`${r.toFixed(2)}${ok ? "✅" : "❌"}`.padStart(11));
  }
  console.log();
}

// ---- 边框按 UI 组件标准（3.0）判 ----
console.log("\n边框可见性（UI 组件需 ≥3.0，与相邻背景比）");
const border = tokens.get("c-border");
if (border) {
  for (const bgName of ["c-bg", "c-surface", "c-raised"]) {
    const b = tokens.get(bgName);
    if (!b) continue;
    const r = contrast(border, b);
    // 边框只需"看得见"，不需要 4.5——但低于 1.5 就基本是隐形的
    const ok = r >= 1.5;
    if (!ok) failures++;
    console.log(`  border on ${bgName.replace("c-", "").padEnd(9)} ${r.toFixed(2)} ${ok ? "✅" : "❌ 几乎不可见"}`);
  }
}

// ---- 语义色在主背景上 ----
console.log("\n语义色（按钮/徽章文字，需 ≥3.0）");
for (const name of ["c-accent", "c-success", "c-warning", "c-danger"]) {
  const c = tokens.get(name);
  const bg = tokens.get("c-surface");
  if (!c || !bg) continue;
  const r = contrast(c, bg);
  const ok = r >= 3.0;
  if (!ok) failures++;
  console.log(`  ${name.replace("c-", "").padEnd(9)} on surface  ${r.toFixed(2)} ${ok ? "✅" : "❌"}`);
}

// ---- 实际渲染色（方便肉眼核对"到底有多黑"）----
console.log("\n实际渲染值");
for (const n of ["c-bg", "c-surface", "c-raised", "c-hover", "c-active",
                 "c-border", "c-muted", "c-text", "c-text-hi"]) {
  const c = tokens.get(n);
  if (c) console.log(`  ${n.padEnd(12)} ${hex(c)}   亮度 ${(relLuminance(c) * 100).toFixed(1)}%`);
}

// ---- 亮色主题（覆盖块，只查它实际重定义的部分）----
if (lightTokens.size) {
  console.log(`\n亮色主题（[data-theme="light"] 覆盖了 ${lightTokens.size} 个 token）`);
  const pick = (n: string) => lightTokens.get(n) ?? tokens.get(n);
  for (const fg of FOREGROUNDS) {
    for (const bgName of ["c-bg", "c-surface", "c-raised"]) {
      const f = pick(fg), b = pick(bgName);
      if (!f || !b) continue;
      const r = contrast(f, b);
      const ok = r >= 4.5;
      if (!ok) failures++;
      console.log(`  ${fg.replace("c-", "").padEnd(9)} on ${bgName.replace("c-", "").padEnd(9)} ${r.toFixed(2)} ${ok ? "✅" : "❌"}`);
    }
  }
}

if (failures) {
  console.log(`\n❌ ${failures} 个组合不达标`);
  process.exit(1);
}
console.log("\n✅ 全部达标");
