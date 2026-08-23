/**
 * verify-layout.ts — 布局分隔条轴向与方向核对
 *
 * ## 为什么需要
 *
 * `useResizable` 的第 5 个参数曾是 boolean `horizontal`。三处调用里
 * `inspector-w` 传了 `false`，于是**调宽度的分隔条去读 clientY**——
 * 用户拖 Inspector 左边缘时，必须上下拖鼠标才能左右伸缩。
 *
 * 这类 bug 单看代码很难发现：布局结构、CSS 类名、拖动方向全是对的，
 * 只有一个布尔位传反了，而 `false` 在那个位置看起来像是"方向取反"。
 * 改成 "x"/"y" 字面量后类型能挡住，这个脚本再从**语义**上核对一遍。
 *
 * ## 核对两件事
 *
 *   ① 轴向：调宽度(-w)必须是 "x"，调高度(-h)必须是 "y"
 *   ② 方向：dir 要让"朝面板方向拖 = 变小，背离 = 变大"
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LAYOUT = join(dirname(fileURLToPath(import.meta.url)),
                    "..", "src", "features", "editor", "EditorLayout.tsx");
const src = readFileSync(LAYOUT, "utf8");

let failed = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${msg}${detail && !cond ? `  (${detail})` : ""}`);
};

// ---- ① 轴向 ----
// 变量名后缀就是尺寸类型：-w 是宽、-h 是高，不该有例外
console.log("① 拖拽轴向（由被调整的尺寸决定）");
// 参数里有箭头函数 `() => window.innerWidth - 480`，含括号，
// 所以不能用 [^)]* 跨过参数列表——第一版就是这么写的，一个都没匹配到。
const calls = [...src.matchAll(
  /useResizable\(\s*"([\w-]+)"[\s\S]*?,\s*"([xy])"\s*\)/g)];

ok(calls.length === 3, `找到 3 处 useResizable 调用`, `实际 ${calls.length}`);

for (const [, varName, axis] of calls) {
  const isWidth = varName.endsWith("-w");
  const want = isWidth ? "x" : "y";
  ok(axis === want,
     `${varName.padEnd(12)} axis="${axis}"`,
     `调${isWidth ? "宽" : "高"}度应为 "${want}"`);
}

// 显式轴向不能省：省了就会默默吃默认值 "x"，高度分隔条会读错轴
const allCalls = [...src.matchAll(/useResizable\(/g)].length;
ok(allCalls === calls.length,
   "每处调用都显式标注了轴向",
   `${allCalls} 处调用中只有 ${calls.length} 处带轴向`);

// 旧的 boolean 写法必须绝迹
ok(!/useResizable\([^)]*,\s*(true|false)\s*\)/s.test(src),
   "没有残留 boolean 轴向参数（旧写法会传反）");

// ---- ② 拖动方向 ----
// 分隔条在面板的哪一侧决定 dir：
//   面板在分隔条**之前**（左/上）→ dir=1，鼠标远离面板即变大
//   面板在分隔条**之后**（右/下）→ dir=-1
console.log("\n② 拖动方向（dir）");
const dirs = new Map(
  [...src.matchAll(/(\w+)Resize\.onMouseDown\(e,\s*(-?1)\)/g)]
    .map((m) => [m[1], Number(m[2])]));

ok(dirs.get("panel") === 1,
   `panel      dir=${dirs.get("panel")}`, "左面板在分隔条左侧，应为 1");
ok(dirs.get("inspector") === -1,
   `inspector  dir=${dirs.get("inspector")}`, "右面板在分隔条右侧，应为 -1");
ok(dirs.get("dock") === -1,
   `dock       dir=${dirs.get("dock")}`, "底部面板在分隔条下方，应为 -1");

// ---- ③ 分隔条 CSS 类与轴向一致 ----
// fw-rz-v = 竖直的条（调宽度），fw-rz-h = 水平的条（调高度）。
// 类名错了不影响功能但光标会反（col-resize vs row-resize），一样别扭。
console.log("\n③ 分隔条样式类");
const vCount = (src.match(/fw-rz fw-rz-v/g) ?? []).length;
const hCount = (src.match(/fw-rz fw-rz-h/g) ?? []).length;
ok(vCount === 2, `竖直分隔条 ${vCount} 个`, "panel 与 inspector 各一个");
ok(hCount === 1, `水平分隔条 ${hCount} 个`, "dock 一个");

if (failed) {
  console.log(`\n❌ ${failed} 项不符`);
  process.exit(1);
}
console.log("\n✅ 布局分隔条配置正确");
