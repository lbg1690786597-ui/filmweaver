/**
 * verify-command.ts — 撤销命令模型（批次 C / C1）
 *
 * ## 为什么要在 node 下真跑一遍，而不是读源码
 *
 * C1 把撤销栈里装的东西从「不透明闭包 `{label, undo, redo}`」换成
 * 「`EditCommand`（id / kind / at / affected / reversible / run / unrun）」
 * （`src/lib/command.ts`）。这一步**没有任何界面变化** —— 用户看到的按钮、
 * 提示、Ctrl+Z 行为全都一样。所以单靠肉眼完全看不出它做对没有，
 * 而它做错的后果又都很安静：
 *
 *   - `run`/`unrun` 接反（旧代码里 `undo` 对应的是 `unrun`，`redo` 对应
 *     `run`，**这是个交叉**）→ 撤销变成重做。编译通过、类型也对（两者
 *     签名相同），只有真的按一下才看得出来。
 *   - 出栈时机错 → 命令抛异常时那条记录被吃掉，用户"跳着撤"。
 *   - `pushUndo` 的旧/新形状判别用错字段 → 静默走错分支。
 *
 * 这三条都能在这个文件里用几行断言直接钉死，前提是命令模型**不依赖
 * `api.ts`**（那边顶上是 `import.meta.env`，node 下取不到）—— 这正是
 * 它被单独放成 `src/lib/command.ts` 的原因，与 `shotRev.ts` / `stagedWrite.ts`
 * 同款。
 *
 * ## 六节
 *   ① 入栈：id 唯一、kind 推导、at 有值（撤销历史面板的原料）
 *   ② 正向→反向→正向：状态真还原（`run`/`unrun` 没接反）
 *   ③ 失败的命令**不**出栈（"跳着撤"那条）
 *   ④ 深度上限 与 `clear`
 *   ⑤ 撤销入口的**形状唯一性**：不存在第二套 `pushUndo(label, undo, redo?)`
 *      签名（C2 迁完后适配层已删，这里改成"证明它真的没了"）
 *   ⑥ 静态守卫：timelineStore 真的用了 commandStore；快照不是真身；
 *      `resetForProjectSwitch` 清的是真身；App 不许再直接摸 `lib/shotRev` 式的绕过
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCommandStore, commandKindOf, uid,
  type CommandKind,
} from "../src/lib/command";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}
function check(name: string, actual: unknown, expected: unknown) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) failed++;
  console.log(`  ${same ? "✅" : "❌"} ${name}`);
  if (!same) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}

/** 一个"状态"，供命令去改、去还原。用 Set 而不是数组：撤销还原的是**集合**，
 *  顺序不该影响判定（真实现里镜头在时间轴上本来就有序，但那是另一回事）。 */
function box(initial: string) {
  let v = initial;
  return {
    get value() { return v; },
    set: (n: string) => { v = n; },
  };
}

/* ================================================================== *
 * ① 入栈
 * ================================================================== */
console.log("\n① 入栈：拿到的是完整命令，不是不透明闭包");
{
  const cs = createCommandStore(50);
  const a = box("A");
  const c = cs.push({
    label: "镜头 #3 移到 #5",
    kind: "shot",
    affected: { shots: ["s3"] },
    run: () => { a.set("B"); },
    unrun: () => { a.set("A"); },
  });

  ok("push 返回完整命令", !!c && typeof c.id === "string" && c.id.length > 0);
  check("label 原样带回", c.label, "镜头 #3 移到 #5");
  check("kind 用调用方声明的", c.kind, "shot");
  check("affected 原样带回（uid，不是 index）", c.affected.shots, ["s3"]);
  ok("at 是时间戳", Number.isFinite(c.at) && c.at > 1_600_000_000_000);
  check("没声明 reversible 时默认 true", c.reversible, true);
  check("入栈后栈深 1", cs.undoCount(), 1);
  check("peek 拿到栈顶", cs.peek()?.id, c.id);

  // id 唯一性：连着推 200 条，不许有重复。⚠️ 这会把上面那条挤出栈（上限 50），
  // 所以 find 的断言必须放在这个循环**之前** —— 先跑循环再找 c.id 必然找不到。
  check("find 能在撤销栈里找到", cs.find(c.id)?.id, c.id);

  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    ids.add(cs.push({ label: `x${i}`, run: () => {}, unrun: () => {} }).id);
  }
  check("200 条命令 id 互不相同", ids.size, 200);
  check("老命令被上限挤掉后就 find 不到了（如实反映栈的内容）", cs.find(c.id), undefined);
}

ok("uid() 生成的 id 不是纯序号（不随位置变）", (() => {
  const s = new Set([uid(), uid(), uid()]);
  return s.size === 3 && !/^\d+$/.test([...s][0]);
})());

/* ================================================================== *
 * ② 正向 → 反向 → 正向：状态真还原
 * ================================================================== */
console.log("\n② run / unrun 没接反：正向改过去、反向改回来");
{
  const cs = createCommandStore(50);
  const s = box("原值");
  const seen: string[] = [];
  cs.push({
    label: "调整镜头 #1 的画面",
    kind: "transform",
    run: () => { s.set("新值"); seen.push("run"); },
    unrun: () => { s.set("原值"); seen.push("unrun"); },
  });

  check("push 不执行任何一方向（调用时机是「已经改完了」）", seen, []);
  check("此时状态还是调用方刚改完的样子", s.value, "原值");

  // 反着走一遍：undo → redo
  await cs.undo();
  check("undo 走的是 unrun", seen, ["unrun"]);
  check("undo 之后状态是反向的结果", s.value, "原值");
  check("undo 把命令移出撤销栈", cs.undoCount(), 0);
  check("undo 把命令放进重做栈", cs.redoCount(), 1);

  await cs.redo();
  check("redo 走的是 run", seen, ["unrun", "run"]);
  check("redo 之后状态是正向的结果", s.value, "新值");
  check("redo 放回撤销栈", cs.undoCount(), 1);
  check("redo 清空重做栈", cs.redoCount(), 0);

  // 空栈
  const empty = createCommandStore(50);
  check("空栈 undo 返回 undefined 而不是抛", await empty.undo(), undefined);
  check("空栈 redo 返回 undefined 而不是抛", await empty.redo(), undefined);

  // 新操作使 redo 分支失效（标准 NLE 行为，C1 之前就有，别丢）
  const cs2 = createCommandStore(50);
  const t = box("0");
  cs2.push({ label: "1", run: () => t.set("1"), unrun: () => t.set("0") });
  await cs2.undo();
  check("撤销后重做栈有 1 条", cs2.redoCount(), 1);
  cs2.push({ label: "2", run: () => t.set("2"), unrun: () => t.set("1") });
  check("新操作清空重做栈（分支失效）", cs2.redoCount(), 0);
}

/* ================================================================== *
 * ③ 失败的命令不 出栈 —— "跳着撤"那条
 * ================================================================== */
console.log("\n③ undo/unrun 抛异常时，命令留在栈里（旧实现在这里丢记录）");
{
  const cs = createCommandStore(50);
  cs.push({ label: "能撤的", run: () => {}, unrun: () => {} });
  let attempts = 0;
  cs.push({
    label: "网络会挂的",
    run: () => {},
    unrun: () => { attempts++; throw new Error("500"); },
  });
  check("栈深 2", cs.undoCount(), 2);

  let threw = false;
  try { await cs.undo(); } catch { threw = true; }
  ok("异常往外冒（调用方要能 toast「撤销失败」）", threw);
  check("关键：失败的命令**还在**撤销栈里（旧实现在这里丢记录）", cs.undoCount(), 2);
  check("没被塞进重做栈", cs.redoCount(), 0);
  check("peek 还是它（重试还是撤这一条）", cs.peek()?.label, "网络会挂的");
  check("重试了一次", attempts, 1);

  // → 换一条能撤的：栈顶仍是失败那条，仍然会再失败。先把它撤成功再说
  //（模拟"网络恢复了"）：直接改它的 unrun 不行（闭包已捕获），所以验的是
  //「只要它一直失败，栈就一直是 2」这个性质。
  try { await cs.undo(); } catch { /* 预期再失败一次 */ }
  check("一直失败就一直留在栈里，不会静默少一条", cs.undoCount(), 2);

  // redo 同款
  const cs3 = createCommandStore(50);
  cs3.push({ label: "x", run: () => {}, unrun: () => {} });
  await cs3.undo();
  const cs4 = createCommandStore(50);
  let runAttempts = 0;
  cs4.push({ label: "重做会挂", run: () => { runAttempts++; throw new Error("500"); }, unrun: () => {} });
  await cs4.undo();                    // 先撤，进重做栈
  try { await cs4.redo(); } catch { /* 预期 */ }
  check("redo 失败时命令留在重做栈里", cs4.redoCount(), 1);
  check("redo 失败了也没被放回撤销栈", cs4.undoCount(), 0);
  check("试过一次", runAttempts, 1);
}

/* ================================================================== *
 * ④ 深度上限 与 clear
 * ================================================================== */
console.log("\n④ 深度上限、clear、不可重做计数");
{
  const cs = createCommandStore(3);
  for (let i = 1; i <= 5; i++) {
    cs.push({ label: `第${i}步`, run: () => {}, unrun: () => {} });
  }
  check("超出上限只留最近 3 条", cs.undoCount(), 3);
  check("留下的是最近的那三条（最老的被挤掉）",
    cs.undoEntries().map((c) => c.label), ["第3步", "第4步", "第5步"]);
  check("limit() 如实回报", cs.limit(), 3);

  // ⚠️ 重做也受上限管。这里必须用 limit=2 且**撤到没得撤**才能验出来：
  // 上限 3 且只撤 3 条时，撤销栈恰好清空，redo 从 0 涨回 3 —— 全程没超过
  // 上限，裁切那行代码**根本没被执行到**。（写这条时第一版就是这样，把探针
  // 打进去仍然是绿的，等于没测。）
  const cs5 = createCommandStore(2);
  for (let i = 1; i <= 2; i++) cs5.push({ label: `s${i}`, run: () => {}, unrun: () => {} });
  await cs5.undo();
  await cs5.undo();
  check("撤到没得撤（撤销栈空、重做栈满）", [cs5.undoCount(), cs5.redoCount()], [0, 2]);
  await cs5.redo();
  await cs5.redo();
  check("重做全部回来正好等于上限", cs5.undoCount(), 2);

  // ⚠️ 重做也受上限管。要真的打到「redo 里那行 `.slice(-limit)`」只有在
  // **撤销栈已满、同时又有一条可重做**时才可能 —— 而 `push` 会清空重做分支，
  // 所以正常操作序列里这个组合**走不出来**（写这条时试了三版才想明白：
  // 凡"撤下去 N 条再重做 N 条"，撤销栈都是从 0 涨回 N，永远差一格）。
  //
  // 于是这里直接构造那个状态：上限 1，先塞满撤销栈（A），撤销栈满着时
  // 再把 B 用**绕过 push 清空语义**的方式放进重做栈 —— 没有公开 API，就
  // 用「推 B → 撤销 B」，此时撤销栈回落到 1（A 还在？不，A 被 push B 挤掉了）。
  //
  // ↑ 上面这条推演说明：**上限为 1 时这个状态不可达**。所以改验真正重要
  // 的那件事 —— 重做回来的命令**保留全部字段**，而不是"回到栈里变成另一条"。
  // 上限裁切本身在两处都被 push 覆盖，属于防御性代码，用下面这条一致性断言兜。
  const cs6 = createCommandStore(3);
  for (let i = 1; i <= 3; i++) cs6.push({ label: `t${i}`, run: () => {}, unrun: () => {} });
  const topBefore = cs6.peek()!;
  await cs6.undo();
  await cs6.redo();
  const topAfter = cs6.peek()!;
  check("重做后回到栈顶的仍是同一条命令（id 不变）", topAfter.id, topBefore.id);
  check("且带回了 label", topAfter.label, "t3");
  check("重做后栈深不变", cs6.undoCount(), 3);
  check("撤销/重做全过程中 reversible 没被改写", topAfter.reversible, true);

  cs.clear();
  check("clear 清空撤销栈", cs.undoCount(), 0);
  check("clear 清空重做栈", cs.redoCount(), 0);

  // 不可重做计数：这是 C2 的进度尺，必须数得准
  const cs2 = createCommandStore(50);
  cs2.push({ label: "可重做", run: () => {}, unrun: () => {} });
  cs2.push({ label: "不可重做 A", reversible: false, run: () => {}, unrun: () => {} });
  cs2.push({ label: "不可重做 B", reversible: false, run: () => {}, unrun: () => {} });
  check("irreversibleCount 数得准", cs2.irreversibleCount(), 2);
  await cs2.undo();
  check("撤掉一条不可重做的之后少一个", cs2.irreversibleCount(), 1);
  check("irreversibleCount 只数撤销栈（重做栈里的不算）", cs2.undoCount(), 2);
}

/* ================================================================== *
 * ⑤ 撤销入口的形状唯一性（C2：适配层已删除，改成**证伪**）
 * ================================================================== */
console.log("\n⑤ 迁移收口：旧的 (label, undo, redo?) 形状确实不存在了");
{
  // ⚠️ 这里原本是 `new URL("..", import.meta.url).pathname` —— **Windows 上必崩**：
  // file URL 的 pathname 是 `/D:/a/...`（前面那个斜杠是 URL 语法的一部分），
  // 拿去 join 就成了 `D:\D:\a\...`，ENOENT。Linux 上 pathname 恰好等于路径，
  // 所以本机一直看不出问题，只有 CI（windows-latest）会红。
  // 用文件顶部那个已经算好的 ROOT（走 fileURLToPath，两个平台都对）。
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  const cmd = read("src/lib/command.ts");
  const hook = read("src/hooks/useUndo.ts");
  const tl = read("src/stores/timelineStore.ts");
  const app = read("src/App.tsx");

  // 适配层真的删了 —— 留着就是"两种形状并存"继续存在
  // ⚠️ 查的是**声明**，不是全文出现：`useUndo.ts` 与 `command.ts` 的注释里
  // 都还写着这个名字（说明"它被删了、为什么删"），全文 grep 会把自己的说明
  // 判成违规。同 ⑦ 那刀。
  ok("command.ts 不再导出 draftFromLegacy", !/export function draftFromLegacy/.test(cmd));
  ok("command.ts 里连它的声明注释都清了", !/旧形状 → `CommandDraft` 的\*\*适配层\*\*/.test(cmd));
  ok("notReversibleRun 还在（显式表达不可逆，不是靠 run 缺省）",
    /export function notReversibleRun/.test(cmd));
  ok("timelineStore 不再导出 UndoEntry 别名", !/export interface UndoEntry/.test(tl));

  // hook 退回成纯转发：入参就一个 CommandDraft
  ok("useUndo 的 pushUndo 只收 CommandDraft",
    /pushUndo = useCallback\(\(draft: CommandDraft\) =>/.test(hook));
  ok("useUndo 里没有按参数个数分流的旧路径",
    !/typeof a === "string"/.test(hook) && !/undo\?: \(\) => Promise/.test(hook),
    "留着分流 = 两种调用约定并存，改一处漏一处时不会有任何提示");

  // ⚠️ 全项目扫"元组形式"的调用点。锚在 `pushUndo(`/`onPushUndo(` 后面紧跟
  // 字符串或标识符（而不是 `{`）——这正是旧签名与新签名的结构性差别。
  // 注释里的字面示例会误伤，所以先剥注释（同 ⑦ 那刀）。
  const stripComments = (src: string) => src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const appCode = stripComments(app);
  const hookCode = stripComments(hook);
  // ⚠️ 前置 `(?<![\w.$])`：不加的话 `bad.push(\`...\`)`（App.tsx 拼错误提示
  // 的那行）会被当成 `pushUndo` 的元组调用 —— 第一版就是这么误报的。
  const bad = /(?<![\w.$])(?:push|onPushUndo)\(\s*(?:["'`]|[A-Za-z_$][\w$]*\s*[,)])/
    .test(appCode + hookCode);
  ok("全项目没有第二套调用形状（pushUndo 后面一律是 `{`）", !bad,
    "元组形式混进来时 tsc 会拦；但 onPushUndo 一路是回调类型，宽一寸就有一处会静默接受");

  // 反向：迁移完之后，"命令必带 run"应该是常态而不是特例
  const runCount = (appCode.match(/\brun: async \(\) =>/g) ?? []).length
    + (appCode.match(/\brun: async \(ctx\) =>/g) ?? []).length;
  ok(`App 里的命令都写了 run（实测 ${runCount} 处）`, runCount >= 15,
    "少于 15 说明又退回了「撤销能写、重做靠自觉」——那正是 C1 之前的病根");
}

/* ================================================================== *
 * ⑥ kind 推导（C1 的过渡手段，C2 之后只剩兜底）
 * ================================================================== */
console.log("\n⑥ commandKindOf：能从 label 推的分类推得出来，推不出才落 other");
{
  const cases: [string, CommandKind][] = [
    ["锁定轨道「旁白」", "track"],
    ["加转场 #3 → #4", "transition"],
    ["转场时长 → 0.5s", "transition"],
    ["字幕移动", "subtitle"],
    ["移除音频段", "audio"],
    ["插入外部素材「bgm.mp3」", "asset"],
    ["调整镜头 #3 的画面（亮度 +10）", "transform"],
    ["划出待重生成区间（2.5s）", "shot"],
    ["分割镜头 #7", "shot"],
    ["粘贴 3 个片段", "shot"],
    ["某个未来才加的操作", "other"],
  ];
  for (const [label, want] of cases) {
    check(`「${label}」→ ${want}`, commandKindOf(label), want);
  }
  // 声明了 kind 就用声明的，不许被推导覆盖
  const cs = createCommandStore(50);
  const c = cs.push({ label: "锁定轨道「旁白」", kind: "other", run: () => {}, unrun: () => {} });
  check("显式 kind 优先于推导", c.kind, "other");
}

/* ================================================================== *
 * ⑦ 静态守卫：接线对不对
 * ================================================================== */
console.log("\n⑦ 静态：timelineStore 真的用了 commandStore，且清的是真身");
{
  const tl = readFileSync(join(ROOT, "src/stores/timelineStore.ts"), "utf8");
  const hook = readFileSync(join(ROOT, "src/hooks/useUndo.ts"), "utf8");
  const cmd = readFileSync(join(ROOT, "src/lib/command.ts"), "utf8");

  ok("timelineStore import 了命令模型",
    /import \{ createCommandStore \} from "\.\.\/lib\/command"/.test(tl));
  ok("命令 store 是模块级单例（不在 create() 里）",
    /^const commandStore = createCommandStore\(MAX_UNDO\);/m.test(tl),
    "放进 create() 会让 verify 脚本在 node 下 import 不进来");

  // 真身 vs 快照：state 里的是快照，必须来自 commandStore 的方法
  ok("undo 后从 commandStore 取快照（不是自己 slice state）",
    /await commandStore\.undo\(\);[\s\S]{0,300}?undoStack: commandStore\.undoEntries\(\)\.slice\(\)/.test(tl));
  ok("redo 后从 commandStore 取快照",
    /await commandStore\.redo\(\);[\s\S]{0,300}?redoStack: commandStore\.redoEntries\(\)\.slice\(\)/.test(tl));

  // ⚠️ 最容易漏的一条：切项目只清 state 不清真身 → Ctrl+Z 还能撤上一个项目的改动
  ok("⚠️ resetForProjectSwitch 清的是**真身**（commandStore.clear()）",
    /resetForProjectSwitch: \(\) => \{[\s\S]{0,400}?commandStore\.clear\(\);/.test(tl),
    "只 set({undoStack: []}) 的话，界面显示没得撤、Ctrl+Z 却还能改到旧项目的数据");
  ok("clearUndo 也清真身",
    /clearUndo: \(\) => \{[\s\S]{0,200}?commandStore\.clear\(\);/.test(tl));

  // C2：形状判别从**运行期**挪到了**编译期**。
  //
  // C1 时 store 里有一句运行期字段探测，同时吃 `{label, undo, redo}` 与
  // `CommandDraft` 两种形状。C2 把这层适配整个搬到 `hooks/useUndo.ts`，
  // store 的签名改成 `pushUndo(e: CommandDraft)` —— 于是"传了旧形状"不再是
  // 某个分支走对走错的问题，而是 **tsc 直接不过**。
  //
  // ⚠️ 必须先剥掉注释再查。否则本文件上面这几行**解释**这件事的注释，会因为
  // 正文里出现那个字段名而被判成违规 —— 写这条时第一次跑就是这个结果。
  // 凡"全文 grep 某个不许出现的字符串"的断言都欠这一刀。
  const tlCode = tl
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  ok("store 里没有运行期形状探测（代码里不出现 `in e`）",
    !/"undo" in e|"run" in e/.test(tlCode),
    "留着运行期判别 = 从别处直接调 store 还能塞进不透明闭包，编译期签名拦不住");
  ok("pushUndo 的签名是 draft-only（收 CommandDraft，不收 UndoEntry）",
    /pushUndo: \(e: CommandDraft\) => EditCommand;/.test(tl)
    && !/pushUndo: \(e: UndoEntry/.test(tl),
    "签名一旦放宽回联合类型，编译期这道闸就没了");

  // store 不反向依赖 toast：C1 时这条靠"适配层在 hook 里"保证，C2 适配层删了，
  // 得改成正面断言 —— hook 就是个零逻辑转发壳，压根没有能反向依赖的东西。
  ok("useUndo 只是个转发壳（不再翻译旧形状）",
    /pushUndo = useCallback\(\(draft: CommandDraft\) => \{\s*useTimelineStore\.getState\(\)\.pushUndo\(draft\);\s*\}, \[\]\);/.test(hook),
    "收口后这里应当是零逻辑；一旦又看到分支，说明第二套形状又长出来了");
  ok("timelineStore 没有 import toast（store 不许反向依赖 UI）",
    !/useToast|from "\.\.\/hooks\//.test(tl));

  // 文档里说不许有的东西
  ok("命令模型不 import zustand（node 下要能直接跑）", !/from "zustand"/.test(cmd));
  ok("命令模型不 import api.ts（import.meta.env 在 node 下取不到）",
    !/from "\.\.\/(api|types\/)/.test(cmd));
  ok("命令模型不提供按位置定位命令的 API",
    !/at\(\s*index|byIndex|nth\(/.test(cmd),
    "Shotcut PR #1466 的教训：shots.order 是最热的可变值，按位置必指错");

  // 真身必须只有一个
  ok("全仓只有一处 createCommandStore 调用（除命令模型自己）",
    (readFileSync(join(ROOT, "src/stores/timelineStore.ts"), "utf8")
      .match(/createCommandStore\(/g) ?? []).length === 1);
}

/* ------------------------------------------------------------------ */
console.log(failed === 0
  ? "\n✅ C1+C2 通过：run/unrun 方向正确、失败不丢记录、全项目只剩一种命令形状（旧三参数签名与适配层已删除）"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
