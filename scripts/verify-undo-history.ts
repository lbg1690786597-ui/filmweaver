/**
 * verify-undo-history.ts — 撤销历史面板（C3）+ 撤销深度 100（C4）
 *
 * ## 这个面板最危险的失败方式：**静默撤错步数**
 *
 * 撤销栈在这之前是不可见的，"撤销"这个动作错了会立刻被看见（画面变了）。
 * 而历史面板把"撤销"变成了**从一个列表里挑第几行**，于是多了一层纯粹的
 * 算术映射：
 *
 *     列表里第 i 行（0 起）= 要连撤 i+1 步
 *
 * 这个 `steps` 算错的后果不是报错，而是"我点第 3 条，它撤了 4 步"——
 * 界面上看起来**像撤成功了**（画面确实退了），用户不会意识到多退了一步，
 * 直到发现某个早先的改动不见了。所以 `steps` 的算法放在纯函数
 * `historyRows` 里，由本脚本逐条钉死，UI 只许照抄。
 *
 * ## 判据分三层
 *
 * ① 纯函数：`agoText` 的分档边界、`historyRows` 的倒序与截断方向、
 *    `redoRows` 的步数、`jumpToast` 的单/多步措辞。
 * ② 真跑：`jumpBack` 在真 store 上连撤、撤 0 步、撤过头、以及**中途失败**
 *    这四种情形。最后一种最关键 —— 它是 `jumpBack` 与 `undo()` 语义分岔的
 *    那一点：`undo()` 失败**留在栈里**，`jumpBack` 失败**停在中间不回滚**，
 *    并把已撤步数 `undoneSteps` 挂在错误上。
 * ③ 静态：面板/顶栏/App 三处接线没有被悄悄拆掉（这类"面板还在、按钮没了"
 *    的退化，只有静态扫源码才抓得到）。
 *
 * ⚠️ 本脚本的历史面板部分**不挂 React**：`undoHistory.ts` 刻意做成了
 * 无 store、无 React、无 lucide 的纯函数集，就是为了能在 node 下直接跑。
 * 一旦有人往里面 import 了 `useTimelineStore`，本脚本会在 import 阶段炸掉 ——
 * 这是设计中的护栏，不是脆弱测试。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { useTimelineStore } from "../src/stores/timelineStore";
import {
  HISTORY_VISIBLE, agoText, historyRows, redoRows, jumpToast,
} from "../src/features/editor/undoHistory";
import type { EditCommand } from "../src/lib/command";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const okEq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okEq) failed++;
  console.log(`  ${okEq ? "✅" : "❌"} ${name}`);
  if (!okEq) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/** 剥掉注释行再 grep：本仓的 verify 脚本吃过太多次"全文匹配匹配到自己
 *  那句解释性注释"的亏（见 verify-outbox 的红过）。 */
const stripComments = (s: string) =>
  s.split("\n").filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  }).join("\n");

/* ================================================================== *
 * ① agoText —— 分档边界
 * ================================================================== */
console.log("\n① 相对时间分档");
const NOW = 1_700_000_000_000;
const ago = (ms: number) => agoText(NOW - ms, NOW);
check("10 秒前 → 刚刚", ago(10_000), "刚刚");
check("44 秒前 → 仍算刚刚（<45s 档）", ago(44_000), "刚刚");
check("45 秒前 → 已过档，落到 1 分钟内", ago(45_000), "1 分钟内");
check("59 秒前 → 1 分钟内", ago(59_000), "1 分钟内");
check("60 秒前 → 1 分钟前", ago(60_000), "1 分钟前");
check("59 分钟前 → 59 分钟前", ago(59 * 60_000), "59 分钟前");
check("60 分钟前 → 进位到小时", ago(60 * 60_000), "1 小时前");
check("23 小时前 → 23 小时前", ago(23 * 3_600_000), "23 小时前");
check("24 小时前 → 进位到天", ago(24 * 3_600_000), "1 天前");
check("3 天前", ago(3 * 86_400_000), "3 天前");
// 时钟回拨：不显示"-3 分钟前"这种在用户眼里像 bug 的文案
check("未来时间（时钟回拨）→ 刚刚，不是负数", ago(-5_000), "刚刚");
check("非有限值 → 刚刚", agoText(NaN, NOW), "刚刚");
check("默认 now 不炸（用到 Date.now）", typeof agoText(NOW), "string");

/* ================================================================== *
 * ② historyRows —— 倒序、steps 映射、截断方向
 * ================================================================== */
console.log("\n② 撤销栈 → 面板行");
const fake = (id: string, label: string, at: number): EditCommand => ({
  id, label, kind: "shot", at, affected: {}, reversible: true,
  origin: { by: "user" },
  run: async () => {}, unrun: async () => {},
});
const stack = [fake("c1", "第一条", NOW - 180_000), fake("c2", "第二条", NOW - 60_000),
  fake("c3", "第三条", NOW - 5_000)];

const h3 = historyRows(stack, NOW);
check("最近的排最上面", h3.rows.map((r) => r.cmd.id), ["c3", "c2", "c1"]);
check("⚠️ steps 与行序对齐：第 1 行退 1 步、第 3 行退 3 步",
  h3.rows.map((r) => r.steps), [1, 2, 3]);
check("ago 跟着每条自己的时间走", h3.rows.map((r) => r.ago),
  ["刚刚", "1 分钟前", "3 分钟前"]);
check("三条都在时不折叠", h3.hidden, 0);
check("空栈 → 空列表且不折叠", historyRows([], NOW), { rows: [], hidden: 0 });

// 截断方向：必须砍**最老的**那些，而不是最新的
const many = Array.from({ length: HISTORY_VISIBLE + 7 }, (_, i) =>
  fake(`m${i}`, `第 ${i} 条`, NOW));
const hmany = historyRows(many, NOW);
check(`超过 ${HISTORY_VISIBLE} 条时只列 ${HISTORY_VISIBLE} 行`,
  hmany.rows.length, HISTORY_VISIBLE);
check("折叠数 = 多出来的条数", hmany.hidden, 7);
check("⚠️ 砍掉的是最老的（最后一行是第 6 条，不是第 36 条）",
  hmany.rows[hmany.rows.length - 1].cmd.id, `m${7}`);
check("第一行仍是最新的那条", hmany.rows[0].cmd.id, `m${many.length - 1}`);
check("截断后 steps 仍从 1 数起（相对可见列表）",
  hmany.rows[0].steps, 1);

// 显式 limit（面板外的调用方要能压高度）
check("limit 可显式传入", historyRows(stack, NOW, 2).rows.length, 2);
check("limit 传入时 hidden 同步算对", historyRows(stack, NOW, 2).hidden, 1);

/* ================================================================== *
 * ③ redoRows + jumpToast
 * ================================================================== */
console.log("\n③ 重做栈 + 提示语");
const rstack = [fake("r1", "先重做的", NOW - 20_000), fake("r2", "后重做的", NOW - 1_000)];
const rr = redoRows(rstack, NOW);
check("下一个要重做的排最上面", rr.map((r) => r.cmd.id), ["r2", "r1"]);
check("steps：最上面那条 = 重做 1 步", rr.map((r) => r.steps), [1, 2]);
check("空重做栈 → 空", redoRows([], NOW), []);

check("撤 1 步的提示沿用老措辞（与 Ctrl+Z 一致）",
  jumpToast(1, "镜头顺序"), "↩ 已撤销：镜头顺序");
check("⚠️ 撤多步必须说出来撤了几步（否则用户以为只撤了 1 步）",
  jumpToast(5, "镜头顺序"), "↩ 已撤销 5 步（到「镜头顺序」之前）");
check("撤 0 步（点的是当前状态那行）给中性提示，不谎报成功",
  jumpToast(0, "任何"), "已经是这里了");
check("负数同样落到中性提示", jumpToast(-3, "任何"), "已经是这里了");

/* ================================================================== *
 * ④ jumpBack —— 真跑（连撤 / 0 步 / 过头 / 中途失败）
 * ================================================================== */
console.log("\n④ jumpBack 真跑");
const st = () => useTimelineStore.getState();
const landed: string[] = [];
function pushAll(n: number) {
  st().clearUndo();
  landed.length = 0;
  for (let i = 1; i <= n; i++) {
    st().pushUndo({
      label: `操作 ${i}`,
      run: async () => { landed.push(`run${i}`); },
      unrun: async () => { landed.push(`unrun${i}`); },
    });
  }
}

// 撤 0 步：什么都不该发生
pushAll(3);
check("jumpBack(0) 返回 0", await st().jumpBack(0), 0);
check("jumpBack(0) 不动栈", [st().undoStack.length, st().redoStack.length], [3, 0]);
check("jumpBack(0) 不执行任何 unrun", landed, []);

// 连撤：从栈顶往下依次 unrun
pushAll(5);
check("jumpBack(3) 返回 3", await st().jumpBack(3), 3);
check("撤回的是栈顶那 3 条，且从新到老依次执行",
  landed, ["unrun5", "unrun4", "unrun3"]);
check("栈同步：可撤 2 / 可重做 3",
  [st().undoStack.length, st().redoStack.length], [2, 3]);
check("重做栈顶 = 最后撤掉的那条（重做顺序才对）",
  st().redoStack[st().redoStack.length - 1]?.label, "操作 3");
check("面板读数：可见的最上面一条要退 1 步",
  historyRows(st().undoStack).rows[0]?.steps, 1);

// 撤过头：能撤多少撤多少，如实返回
pushAll(2);
check("jumpBack(9) 只撤得掉 2 步，返回 2", await st().jumpBack(9), 2);
check("撤过头后撤销栈空、重做栈 2", [st().undoStack.length, st().redoStack.length], [0, 2]);

// 中途失败：**停在中间、不回滚、把已撤步数挂出来**
pushAll(5);
let boom: unknown = null;
// 让第 3 次 unrun 失败
st().clearUndo();
for (let i = 1; i <= 5; i++) {
  st().pushUndo({
    label: `操作 ${i}`,
    run: async () => {},
    unrun: async () => {
      if (i === 3) throw new Error("后端 500");
    },
  });
}
try { await st().jumpBack(3); } catch (e) { boom = e; }
ok("中途失败会抛出（不被吞掉）", boom !== null, "jumpBack 没有抛，失败被静默吞了");
check("⚠️ 已撤步数挂在错误的 undoneSteps 上（UI 才能如实说「退到第 2 步停了」）",
  (boom as { undoneSteps?: number })?.undoneSteps, 2);
check("⚠️ 已经撤掉的不回滚：可撤销 3 / 可重做 2",
  [st().undoStack.length, st().redoStack.length], [3, 2]);
check("失败后栈快照与真身一致（面板读数不会错位）",
  st().undoStack.map((c) => c.label), ["操作 1", "操作 2", "操作 3"]);
check("⚠️ 失败的那条**留在栈顶**（下次再点就是重试它，不是跳过它）",
  st().undoStack[st().undoStack.length - 1]?.label, "操作 3");
check("已撤掉的 4、5 在重做栈里，且栈序保证能原样做回去",
  st().redoStack.map((c) => c.label), ["操作 5", "操作 4"]);
check("重做栈顶 = 下一次重做的那条（先重做 4、再 5，顺序才对）",
  st().redoStack[st().redoStack.length - 1]?.label, "操作 4");

st().clearUndo();

/* ================================================================== *
 * ⑤ 静态：接线与上限没被拆
 * ================================================================== */
console.log("\n⑤ 静态接线");
const tlSrc = read("src/stores/timelineStore.ts");
const panelSrc = read("src/features/editor/UndoHistoryPanel.tsx");
const topSrc = read("src/features/editor/TopBar.tsx");
const appSrc = read("src/App.tsx");

ok("C4：撤销上限已提到 100", /const MAX_UNDO = 100;/.test(tlSrc),
  "MAX_UNDO 还是 50，C4 没落地");
ok("面板展示条数与栈深是**两个**数（HISTORY_VISIBLE ≠ MAX_UNDO）",
  HISTORY_VISIBLE === 30 && !new RegExp(`MAX_UNDO = ${HISTORY_VISIBLE};`).test(tlSrc));
ok("store 暴露 jumpBack", /jumpBack: \(steps: number\) => Promise<number>/.test(tlSrc));
ok("jumpBack 中途失败时同步快照再抛（不是吞掉）",
  /jumpBack: async \(steps\)[\s\S]{0,900}?undoneSteps: done/.test(tlSrc));

ok("顶栏提供了 undoHistory 插槽", /undoHistory\?: React\.ReactNode;/.test(topSrc));
ok("顶栏把插槽渲染在重做按钮之后",
  /title="重做 \(Ctrl\+Y\)"[\s\S]{0,220}?\{p\.undoHistory\}/.test(topSrc));
ok("⚠️ 顶栏没有自己去 import 面板（否则脱离 App 就没法单测）",
  !/UndoHistoryPanel/.test(stripComments(topSrc)));

ok("App 挂了面板", /<UndoHistoryPanel/.test(appSrc));
ok("App 面板连的是 store 的 jumpBack",
  /jumpHistory[\s\S]{0,600}?st\.jumpBack\(steps\)/.test(appSrc));
ok("App 顶栏传了 undoHistory", /undoHistory=\{/.test(appSrc));
ok("⚠️ App 如实汇报部分失败（读 e.undoneSteps）",
  /undoneSteps/.test(appSrc));

ok("面板订阅的是两个栈", /s\.undoStack/.test(panelSrc) && /s\.redoStack/.test(panelSrc));
ok("面板用纯函数算行，不自己 map 出 steps",
  /historyRows\(undoStack\)/.test(panelSrc) && !/steps:\s*total\s*-/.test(panelSrc));
ok("Esc 挂捕获期（抢在全局快捷键前）",
  /addEventListener\("keydown", onKey, true\)/.test(panelSrc));
ok("不可重做的命令在列表里有标记",
  /!cmd\.reversible/.test(panelSrc) && /不能重做/.test(panelSrc));

/* ================================================================== *
 * ⑥ CSS 只用真实存在的 token
 * ================================================================== */
console.log("\n⑥ 面板样式的 token 必须真实存在");
const css = read("src/features/editor/UndoHistoryPanel.css");
const tokensCss = read("src/styles/tokens.css");
const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
const missing = used.filter((t) => !new RegExp(`${t}\\s*:`).test(tokensCss));
check("面板不引用不存在的 CSS 变量", missing, []);
ok("弹层底色与 ContextMenu 同款（--c-raised）", /background: var\(--c-raised\)/.test(css));
ok("⚠️ 不新造 --c-panel / --c-line / --sh-pop 这类没定义的名字",
  !/--c-panel|--c-line|--sh-pop/.test(css));

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
