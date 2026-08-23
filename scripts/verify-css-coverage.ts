/**
 * verify-css-coverage.ts — CSS 类名双向覆盖检查
 *
 * ## 为什么需要
 *
 * 两类错误都发生过，且都不会被 tsc / vite build 抓到：
 *
 *   ① **用了没定义**：改组件时把 className 换了名字，CSS 里还是老名字
 *      → 元素完全没样式。刚重写 Placeholder 时就把 `.fw-placeholder`
 *        写成了 `fw-ph`，界面会直接塌掉。
 *   ② **定义了没用**：删组件时漏删 CSS，或"清理"时误删了还在用的类
 *      → 上一轮清理 CSS 时删掉 302 行，其中 6 个类还在用，界面局部失样。
 *
 * 两个方向都要查。②只警告不拦截——过渡态、伪类派生、JS 动态拼接的类名
 * 会有误报，拦下来会让人开始无脑加豁免，反而失去意义。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(SRC);
const tsxFiles = files.filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
const cssFiles = files.filter((f) => f.endsWith(".css"));

// ---- CSS 里定义的类名 ----
const defined = new Map<string, string>();   // class → 首次定义的文件
for (const f of cssFiles) {
  const css = readFileSync(f, "utf8");
  // 去掉注释，避免注释里的示例被当成定义
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    if (!defined.has(m[1])) defined.set(m[1], f.replace(SRC, "src"));
  }
}

// ---- tsx 里用到的类名 ----
// 覆盖三种写法：className="a b"、className={`a ${x}`}、className={cond ? "a" : "b"}
const used = new Map<string, string>();
for (const f of tsxFiles) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const body = m[1] ?? m[2] ?? "";
    // 从字面量片段里取词；${...} 里的表达式跳过（动态类名无法静态判定）
    for (const lit of body.matchAll(/["'`]([^"'`]*)["'`]/g)) {
      for (const c of lit[1].split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(c) && !used.has(c)) used.set(c, f.replace(SRC, "src"));
      }
    }
    if (m[1]) {
      for (const c of m[1].split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(c) && !used.has(c)) used.set(c, f.replace(SRC, "src"));
      }
    }
  }
}

// ---- ① 用了但没定义（硬错误）----
// 只查项目自有前缀，避免第三方库类名（lucide/dnd-kit）误报
const OWN = /^(fw-|sp-|board-|lib-|ctrack-|shot-|st-|opt-|plist|cand-|tl-)/;
const undefinedClasses = [...used.entries()]
  .filter(([c]) => OWN.test(c) && !defined.has(c))
  .sort();

console.log("① 用了但 CSS 里没定义（会导致元素无样式）");
if (undefinedClasses.length) {
  for (const [c, f] of undefinedClasses) console.log(`   ❌ .${c}   ← ${f}`);
} else {
  console.log(`   ✅ tsx 中 ${[...used.keys()].filter((c) => OWN.test(c)).length} 个自有类全部有定义`);
}

// ---- ② 定义了但没用（仅警告）----
const unusedClasses = [...defined.entries()]
  .filter(([c]) => OWN.test(c) && !used.has(c))
  .sort();

console.log(`\n② CSS 里定义但 tsx 未直接引用（${unusedClasses.length} 个，仅提示）`);
if (unusedClasses.length) {
  // 可能是状态类（.fw-clip.selected）、伪类派生或动态拼接，不一定是死代码
  const show = unusedClasses.slice(0, 12);
  for (const [c, f] of show) console.log(`   · .${c}   ${f}`);
  if (unusedClasses.length > show.length) {
    console.log(`   … 另有 ${unusedClasses.length - show.length} 个`);
  }
  console.log("   （状态类/动态拼接会误报；删之前先确认真的没人用）");
}

// ---- ③ CSS 变量：用了必须有定义 ----
// 注意 styles.css 里有一层「旧变量桥接」（--bg: var(--c-bg) 等），
// 定义不全在 tokens.css 里——只扫 tokens 会把桥接名全报成未定义。
const definedVars = new Set<string>();
for (const f of cssFiles) {
  const clean = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[\w-]+)\s*:/g)) definedVars.add(m[1]);
}
const usedVars = new Map<string, string>();
for (const f of cssFiles) {
  const clean = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!usedVars.has(m[1])) usedVars.set(m[1], f.replace(SRC, "src"));
  }
}
const missingVars = [...usedVars.entries()]
  .filter(([v]) => !definedVars.has(v)).sort();

console.log("\n③ CSS 变量定义");
if (missingVars.length) {
  for (const [v, f] of missingVars) console.log(`   ❌ var(${v})   ← ${f}`);
} else {
  console.log(`   ✅ 引用的 ${usedVars.size} 个变量全部有定义`);
}

const hardFails = undefinedClasses.length + missingVars.length;
if (hardFails) {
  console.log(`\n❌ ${hardFails} 处引用了不存在的类名/变量`);
  process.exit(1);
}
console.log("\n✅ CSS 覆盖检查通过");
