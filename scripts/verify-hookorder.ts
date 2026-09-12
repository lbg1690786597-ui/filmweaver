/**
 * scripts/verify-hookorder.ts — 6.9 黑屏回归：App 的 hook 数量必须与屏幕无关
 *
 * ## 这条钉住的是什么
 *
 * 0.9.1 的 beta 客户端**打开即黑屏**。根因不在渲染本身，而在 hook 的**位置**：
 * `App.tsx` 里有五段顶层早退
 *
 *     if (screen === "offline")  return <断线页/>;
 *     if (screen === "probing")  return <正在连接…/>;
 *     if (screen === "login")    return <LoginPage/>;
 *     if (screen === "projects") return <ProjectList/>;
 *     if (projectId === null)    return <ProjectList/>;
 *
 * 而 `shots`（普通 const）与 `assetDropCtx`（`useMemo`）原本写在**这五段之后**。
 * 后果：`App` 的 hook 调用数量**随屏幕而变** ——
 *   · 登录页 / 项目列表 / 断线页：早退，`useMemo` 不执行 → 181 个
 *   · 编辑器：走到底，`useMemo` 执行 → 182 个
 *
 * React 按 fiber 上 `memoizedState` 链的**位置**逐个配对 hook。从 181 个的渲染
 * 切到 182 个的渲染时，第 182 个位置在旧链上不存在，`updateWorkInProgressHook`
 * 抛：
 *
 *     Uncaught Error: Rendered more hooks than during the previous render.   (#310)
 *
 * 而**全仓没有任何 ErrorBoundary**（`main.tsx` 只有 StrictMode，没有 errorElement、
 * 没有 componentDidCatch），所以 React 直接把整棵树卸载 —— 页面上只剩 `body` 的
 * 深色底（`oklch(0.192 0.006 250)`）。用户的原话是「软件打开直接黑屏」，而首页
 * 恰好是**登录页 → 项目列表 → 编辑器**这条必然切换屏幕的路径，所以一开就撞。
 *
 * 网页版不复现的原因：网页是登录后直接深链进项目，历史里那条 localStorage 里的
 * 项目 id 在，`screen` 一直是 `editor`，182 → 182 配对成功。
 *
 * ## 为什么不能只靠"我会注意"
 *
 * 上面那五行 `if (...) return` 与中间任何一行 `const xxx = useXxx(...)` 之间
 * **在源码里看不出任何关系** —— 早退看起来只是一段渲染逻辑，而 hook 在它下面
 * 几十行处，中间隔着好几百行 JSX 之外的代码。加了新 hook 的人不会想到
 * "我不能放这儿"。这条脚本把关系显式钉住。
 *
 * ## 判据
 *
 * 在 `App.tsx` 里找出所有顶层早退 `return` 的行号，与所有顶层 hook 调用的行号，
 * 断言：**最小的早退行号 > 最大的 hook 行号**（即"一个 hook 都不许出现在早退之后"）。
 *
 * 只扫 `App.tsx`：其它组件没有早退分支，且这个文件是唯一出过事的地方。
 * 扫的是**顶层**（缩进 2）语句 —— 嵌套在回调 / 条件里的 hook 由 React 自己报错，
 * 不是这条要抓的形态。
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};

const SRC = "src/App.tsx";
const raw = readFileSync(SRC, "utf8");
const lines = raw.split("\n");

/**
 * hook 名（含自定义 hook：`use` + 大写开头）。
 *
 * ⚠️ 花括号**不能**省成 `\s*\(`：`useMemo<AssetDropCtx | undefined>(...)` 这种
 * 带类型参数的调用会在 `<` 处断掉，而 6.9 那个出事的 hook 恰好就带 `<` ——
 * 少了它，这条脚本在回归版本上会**全绿通过**（已实测）。
 */
const HOOK_RE = /\buse[A-Z][A-Za-z0-9]*\s*(?:<[^(]*>)?\s*\(/;
/** 顶层早退：缩进恰为 2 的 `if (...) return ...` / `if (...) {` + 紧随其后的 `return`. */
const TOP_IF_RE = /^ {2}if \(/;

/** 判断一行是否是"早退 if 的开头"：自身以 return 收尾，或紧随的几行里出现顶层 return。 */
function isEarlyReturn(idx: number): boolean {
  const line = lines[idx];
  if (!TOP_IF_RE.test(line)) return false;
  if (/\breturn\b/.test(line)) return true;
  // 多行条件 / 花括号体：向下找最多 40 行，直到遇到下一个同缩进的语句前，
  // 看里面有没有缩进 >= 4 的 `return`
  for (let j = idx + 1; j < Math.min(idx + 40, lines.length); j++) {
    const l = lines[j];
    if (/^ {2}\S/.test(l)) return false;            // 回到顶层，本 if 已结束
    if (/^ {4,}return\b/.test(l)) return true;
  }
  return false;
}

console.log("\n[1] 扫描 App.tsx 的顶层 hook 与顶层早退");

const hookLines: number[] = [];
const earlyLines: number[] = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const isTop = /^ {2}\S/.test(l);
  if (!isTop) continue;
  const t = l.trim();
  if (HOOK_RE.test(l) && !t.startsWith("//") && !t.startsWith("*")) hookLines.push(i + 1);
}
for (let i = 0; i < lines.length; i++) if (isEarlyReturn(i)) earlyLines.push(i + 1);

console.log(`   顶层 hook 调用：${hookLines.length} 处`);
console.log(`   顶层早退分支：${earlyLines.length} 处 → 行 ${earlyLines.join(", ")}`);

ok(hookLines.length >= 30, `扫到的 hook 数量合理（${hookLines.length} 处，防正则失效）`);
ok(earlyLines.length >= 4, `扫到的早退分支数量合理（${earlyLines.length} 处，防正则失效）`);

console.log("\n[2] 不变式：没有任何 hook 出现在早退分支之后");

const firstEarly = Math.min(...earlyLines);
const lastHook = Math.max(...hookLines);
const offenders = hookLines.filter((n) => n > firstEarly);

ok(
  offenders.length === 0,
  `最小的早退在第 ${firstEarly} 行；最大的 hook 在第 ${lastHook} 行`,
  offenders.length
    ? `以下 hook 位于早退之后，会导致 hook 数量随屏幕而变（黑屏根因）：\n       行 ${offenders
        .map((n) => `${n}: ${lines[n - 1].trim().slice(0, 80)}`)
        .join("\n       行 ")}`
    : "",
);

console.log("\n[3] 源码断言：那两个必须留在早退之前的派生值确实在（防止被人「顺手挪回去」）");

const shotsIdx = lines.findIndex((l) => /^ {2}const shots = stagedTransform\.applyPending\(/.test(l));
const dropIdx = lines.findIndex((l) => /^ {2}const assetDropCtx = useMemo</.test(l));
ok(shotsIdx >= 0, `找到 shots 派生（第 ${shotsIdx + 1} 行）`);
ok(dropIdx >= 0, `找到 assetDropCtx 的 useMemo（第 ${dropIdx + 1} 行）`);
ok(shotsIdx + 1 < firstEarly, "shots 在早退之前");
ok(dropIdx + 1 < firstEarly, "assetDropCtx 在早退之前");
ok(shotsIdx + 1 < dropIdx + 1, "shots 先于 assetDropCtx（后者依赖前者）");

console.log("\n[4] 源码断言：那五段早退仍然存在（防止有人用「删早退」的方式骗过这条脚本）");

for (const needle of ['screen === "offline"', 'screen === "probing"', 'screen === "login"', 'screen === "projects"', "projectId === null"]) {
  ok(raw.includes(needle), `仍存在门禁分支：${needle}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-hookorder：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
