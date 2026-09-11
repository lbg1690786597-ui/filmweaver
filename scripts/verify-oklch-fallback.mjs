/**
 * 构建产物自检：确保没有"老运行时会读不懂、又没有回退"的颜色声明。
 *
 * 由 npm run build 在 vite build 之后自动运行，检查的是**真正会发给用户的那份 CSS**，
 * 而不是源码 —— 中间隔着 postcss 插件和 esbuild 压缩，只有查产物才作数。
 *
 * 背景见 src/styles/tokens.css 文件头（2026-09-10 线上事故）：老 WebView2 不认
 * oklch()，漏了回退的声明会整条作废，界面塌成"排版还在、颜色全没了"。
 *
 * 查三件事：
 *   1. 每条**字面** oklch()（不含 var()、不是 oklch(from …)）的普通声明，
 *      前面必须紧跟一条同属性的非 oklch 回退 —— 由 vite.config.ts 的
 *      fw-oklch-fallback 插件自动生成，这里只验收。
 *   2. @supports 里的每个 --c-* token，块外必须有同名的 hex 定义，且配套的
 *      --c-*-rgb 三分量也在块外（color-mix 的回退要用）。
 *   3. 每条用 color-mix() 的规则，后面必须紧跟一份 `@supports not (…color-mix…)`
 *      的同选择器副本 —— 由 fw-color-mix-fallback 插件生成。
 *
 * 查不了、因而属于**已知降级**的（不在此报错，只在末尾统计）：
 *   - oklch(from …) 相对色语法（Chromium 119+）：参数里带 var()，且没有等价的老写法。
 *   - color-mix 第一个参数不是 var(token) 的少数几处（如 currentColor）。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postcss from "postcss";
import { canFallback, colorMixToRgba, MIN_CHROMIUM } from "./oklch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "..", "dist", "assets");

if (!existsSync(ASSETS)) {
  console.error("找不到 dist/assets —— 请先 vite build 再跑本脚本");
  process.exit(1);
}

const files = readdirSync(ASSETS).filter((f) => f.endsWith(".css"));
if (!files.length) {
  console.error("dist/assets 里没有 .css 产物，构建可能失败了");
  process.exit(1);
}

const problems = [];
let checked = 0;
let mixFixed = 0;
let mixSkipped = 0;
let relative = 0;

/** 压缩后 @supports 的 params 空格会被去掉，所以只做特征判断，不做全等比较。 */
const isMixGuard = (n) =>
  n?.type === "atrule" && n.name === "supports" && /^not\s*\(/.test(n.params) && n.params.includes("color-mix");

for (const f of files) {
  const root = postcss.parse(readFileSync(join(ASSETS, f), "utf8"), { from: f });

  root.walkDecls((decl) => {
    if (/oklch\(\s*from/.test(decl.value)) relative++;
    if (decl.prop.startsWith("--")) return; // 自定义属性走 @supports / -rgb，见下
    if (decl.value.includes("color-mix(") && !colorMixToRgba(decl.value)) mixSkipped++;
    if (!canFallback(decl.value)) return;
    checked++;
    const prev = decl.prev();
    if (prev?.type === "decl" && prev.prop === decl.prop && !prev.value.includes("oklch(")) return;
    problems.push(`${f}: ${decl.parent?.selector ?? "?"} { ${decl.prop}: ${decl.value} } 缺 oklch 回退`);
  });

  // color-mix：每条可改写的声明，都要在紧随其后的 @supports not(...) 副本里有同名属性
  root.walkRules((rule) => {
    if (isMixGuard(rule.parent)) return; // 这就是副本本身
    const want = [];
    rule.each((n) => {
      if (n.type !== "decl" || n.prop.startsWith("--")) return;
      if (colorMixToRgba(n.value)) want.push(n.prop);
    });
    if (!want.length) return;
    const guard = rule.next();
    const got = new Set();
    if (isMixGuard(guard)) guard.walkDecls((d) => got.add(d.prop));
    for (const prop of want) {
      if (got.has(prop)) mixFixed++;
      else problems.push(`${f}: ${rule.selector} { ${prop} } 用了 color-mix 却没有 @supports 回退`);
    }
  });

  // --c-* token：@supports(oklch) 内定义的，块外必须有 hex 和 -rgb 各一份
  const inside = new Set();
  const outside = new Set();
  root.walkAtRules("supports", (at) => {
    if (!at.params.includes("oklch")) return;
    at.walkDecls(/^--c-/, (d) => inside.add(d.prop));
  });
  root.walkDecls(/^--c-/, (d) => {
    let n = d.parent;
    while (n) {
      if (n.type === "atrule" && n.name === "supports" && n.params.includes("oklch")) return;
      n = n.parent;
    }
    outside.add(d.prop);
  });
  for (const t of inside) {
    if (!outside.has(t)) problems.push(`${f}: ${t} 只在 @supports 里有定义，块外缺 hex 回退`);
    if (!outside.has(`${t}-rgb`)) problems.push(`${f}: 缺 ${t}-rgb —— color-mix 回退取不到值`);
  }
}

if (problems.length) {
  console.error(`颜色回退自检不通过（${problems.length} 处）：`);
  for (const p of problems) console.error("  " + p);
  console.error("\n字面 oklch 与 color-mix 的回退由 vite.config.ts 的两个 postcss 插件生成；");
  console.error("token 的 hex / -rgb 回退由 scripts/gen-color-fallback.mjs --write 生成。");
  process.exit(1);
}

console.log(
  `颜色回退自检通过：字面 oklch ${checked} 条、color-mix ${mixFixed} 条均有回退，token 回退齐全。\n` +
    `已知降级（Chromium < ${MIN_CHROMIUM} 上仍会失效）：` +
    `oklch(from …) ${relative} 处、参数非 token 的 color-mix ${mixSkipped} 处。`,
);
