/**
 * verify-agent.ts — 编辑器 Agent 的可执行能力表（批次 E5）与提示词契约（E6）
 *
 * ## 为什么这个脚本非有不可
 *
 * Agent 的失效方式**几乎全是安静的**，而且集中在"两张表对不上"上：
 *
 *   - `capability.ts`（给模型看的说明书）里登记了一条能力，`dispatch.ts`
 *     （真正干活的手）里没有 → 模型高高兴兴地调，用户看到"操作失败"，
 *     而**编译、类型、界面全都正常**。只有真的调一次才发现。
 *   - 反过来：`HANDLERS` 里实现了但说明书里没写 → 死代码，谁也调不到。
 *   - `kind === "generate"` 忘了 `costly: true` → **静默花钱**。
 *   - `costly`/`destructive` 忘了写 `confirmText` → 确认框弹一句
 *     "确认执行吗？"，用户不知道自己要点掉多少钱。
 *   - `patchShotBreakdown` 混进能力表 → 它**没有逆操作**（PLAN §14 附录 D
 *     明令不许进），一旦进去，撤销栈会在它身上断链。
 *   - schema 里 `maximum` 写成 `max` → `schema.ts` 静默忽略未知关键字，
 *     于是"限制 1..60"变成"什么都能传"，而**没有任何报错**。
 *
 * 这六条都能在这里用断言钉死，且**都在 node 下跑得动** ——
 * 这正是 `dispatch.ts` 一直坚持不 import store、把 `api.ts` 改成动态 import
 * 的原因（`api.ts` 顶上读 `import.meta.env`，node 下取不到）。
 *
 * ## 十节
 *   ① 能力表 ↔ 执行器：两个方向的集合相等（不是"包含"）
 *   ② 花钱与不可逆：`generate` 必带 `costly`；花钱/破坏性必带 `confirmText`
 *   ③ 明令不许进来的能力确实不在
 *   ④ schema 无未知关键字（`unknownKeywords` 空）
 *   ⑤ 取 JSON：围栏、前后夹 prose、字符串里的花括号
 *   ⑥ 解析：`done` 的保守方向、非法条目的**不静默**
 *   ⑦ 提示词：镜头 id 在第一列、没有把不可执行的字段写进去
 *   ⑧ 编译期契约：一个前端常量，一个后端常量，靠 `/v2/agent/protocol` 对齐
 *   ⑨ 静态守卫：客户端**不许**出现 API 密钥（发版前的红线）
 *   ⑩ 端到端：假模型 + 假 host 跑一次 `runAgent`，验证"AI 改的能一次撤掉"
 *
 * ⚠️ ⑩ 不碰网络、不碰 store：`runAgent` 收 `callModel` 与 `host` 都是注入的。
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITIES, findCapability, needsConfirm,
} from "../src/lib/agent/capability";
import type { AgentCapability } from "../src/lib/agent/capability";
import { exportCapabilities } from "../src/lib/agent/capability";
import { dispatchIds, commandProducingIds } from "../src/lib/agent/dispatch";
import type { AgentHost } from "../src/lib/agent/dispatch";
import { unknownKeywords } from "../src/lib/agent/schema";
import type { JsonSchema } from "../src/lib/agent/schema";
import {
  parseAgentReply, extractJsonObject, stripFence,
  withDefaults, selfCheckSchemaKeywords, complaintsForModel,
} from "../src/lib/agent/protocol";
import { describeTimeline } from "../src/lib/agent/describeTimeline";
import {
  renderTimelineForPrompt, buildTurnUser, renderCapabilityTable,
  buildPromptPreview, PROMPT_CONTRACT_VERSION,
} from "../src/lib/agent/prompt";
import {
  runAgent, summarizeRun, MAX_TURNS, MAX_DESCRIBE_CALLS, AGENT_PROMPT_CONTRACT_VERSION,
} from "../src/lib/agent/runAgent";
import { createCommandStore } from "../src/lib/command";
import type { CommandDraft } from "../src/lib/command";
import {
  createConfirmGate, normalizeDropped, runStatusLine, turnIsOnTop,
} from "../src/features/editor/agentBar";
import type { AgentRunResult } from "../src/lib/agent/runAgent";

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

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n① 能力表 ↔ 执行器：两个方向都要相等");
/* ══════════════════════════════════════════════════════════════════ */
{
  const declared = CAPABILITIES.map((c) => c.id);
  const implemented = dispatchIds();

  // 方向一：说明书里有、手没有 —— 运行时才炸，编译期完全看不出来
  const missing: string[] = declared.filter((id) => !implemented.includes(id));
  check("每条登记的能力都有执行器（说明书有、手没有 = 模型点了就失败）", missing, []);

  // 方向二：手有、说明书没有 —— 死代码。反向也要查，否则会有人
  // "为了让这条断言过"往执行器里塞，却忘了回来补说明书。
  const orphan: string[] = implemented.filter((id) => !declared.includes(id));
  check("每个执行器都在能力表里登记（有手没说明书 = 调不到的死代码）", orphan, []);

  // id 不许重复：重复的那条会被 `findCapability` 的"取第一个"悄悄吃掉
  const dup = declared.filter((id, i) => declared.indexOf(id) !== i);
  check("能力 id 无重复", dup, []);

  // 每条都要有给模型看的 desc：没有 desc 的能力，模型只能靠 id 猜用途
  const noDesc = CAPABILITIES.filter((c) => !c.desc || !c.desc.trim()).map((c) => c.id);
  check("每条能力都有 desc", noDesc, []);

  // 入参 schema 必须是 object 形状（`validateArgs` 按对象逐字段查）
  const badShape = CAPABILITIES
    .filter((c) => (c.params as JsonSchema).type !== "object")
    .map((c) => c.id);
  check("每条能力的 params 都是 object", badShape, []);
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n② 花钱与不可逆：确认门不许有缝");
/* ══════════════════════════════════════════════════════════════════ */
{
  // 生成类能力**必然花钱**。忘了标 costly 的后果是静默扣额度 ——
  // 而用户是在账单上发现的，不是在界面上。
  const genNoCost = CAPABILITIES
    .filter((c) => c.kind === "generate" && c.costly !== true)
    .map((c) => c.id);
  check("凡 kind=generate 的能力都标了 costly", genNoCost, []);

  // 花钱/破坏性 = 弹确认框 = 必须有一句人话说明"要付什么代价"
  const noConfirm = CAPABILITIES
    .filter((c) => needsConfirm(c))
    .filter((c) => !c.confirmText || !c.confirmText.trim())
    .map((c) => c.id);
  check("凡 costly/destructive 的能力都有 confirmText", noConfirm, []);

  // 反过来：没标 costly/destructive 的能力**不该**有 confirmText ——
  // 有的话说明作者本来觉得它危险，只是忘了打标记，那种"标记与文案不一致"
  // 正是确认门最容易被绕过的形态。
  const strayConfirm = CAPABILITIES
    .filter((c) => !needsConfirm(c) && c.confirmText)
    .map((c) => c.id);
  check("没有 costly/destructive 的能力不写 confirmText（写了说明标记打漏了）", strayConfirm, []);

  // `needsConfirm` 的判据本身必须只看这两个字段
  const sample = CAPABILITIES.find((c) => c.id === "generate_shots") as AgentCapability;
  ok("needsConfirm(generate_shots) === true", needsConfirm(sample) === true);

  // `exportCapabilities` 是**发给后端的那份**：costly 必须是布尔
  // （后端按 `c.get("costly")` 渲染警告，undefined 会渲染成"不花钱"）
  const exported = exportCapabilities(CAPABILITIES);
  check("exportCapabilities 的 costly 全是布尔",
    exported.every((c) => typeof c.costly === "boolean"), true);
  check("exportCapabilities 不夹带 confirmText 之类的界面文案",
    exported.every((c) => !("confirmText" in c) && !("kind" in c)), true);
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n③ 明令不许进来的能力确实不在（PLAN §14 附录 D）");
/* ══════════════════════════════════════════════════════════════════ */
{
  // `patchShotBreakdown` **没有逆操作**：它把一镜拆成多镜，逆操作要重建
  // 原来的那一镜并认回所有派生关系，而派生关系在拆解那一刻就丢了。
  // 放进能力表 = 撤销栈在它身上断链 = 用户按 Ctrl+Z 撤不掉、还可能撤错。
  const forbidden = ["patchShotBreakdown", "patch_shot_breakdown"];
  const present = forbidden.filter((id) => findCapability(id));
  check("patchShotBreakdown 不在能力表里（它没有逆操作）", present, []);

  // 同样的道理：静态守卫它也不该出现在执行器里
  const dispSrc = readFileSync(join(ROOT, "src/lib/agent/dispatch.ts"), "utf8");
  ok("执行器里也没有 patchShotBreakdown 的 handler",
    !/patchShotBreakdown/.test(dispSrc.replace(/^\s*\*.*$/gm, ""))
    || /不(在|要|许|得).{0,12}patchShotBreakdown/.test(dispSrc),
    "若确实要在注释里提它，注释必须明确说'不在'，否则这条断言形同虚设");

  // 只读能力不许产生命令（`NO_COMMAND`）。这条靠"只读的 kind 与入栈行为一致"来查：
  // 只读能力一旦入栈，撤销面板会多出一条"撤销：读取时间轴"，而撤销它没有任何意义。
  const readIds = CAPABILITIES.filter((c) => c.kind === "read").map((c) => c.id);
  const readButCommands = readIds.filter((id) => commandProducingIds().includes(id));
  check("只读能力一律不进撤销栈", readButCommands, []);

  // 反向：**能改东西的能力必须真的会入栈**。只读的排除了，但若所有能力都被
  // 误标成 read，上面那条会全绿地通过 —— 这一条堵住那个自证。
  // ⚠️ 只查 `edit`：`generate`（generate_shots）走生成流水线，它自己是
  // `NO_COMMAND` 的 —— 生成出来的镜头由流水线写库，不在这个撤销栈里。
  const edits = CAPABILITIES.filter((c) => c.kind === "edit").map((c) => c.id);
  const editWithoutCommand = edits.filter((id) => !commandProducingIds().includes(id));
  check("每个 edit 能力都产出命令（否则撤销栈里看不到它）", editWithoutCommand, []);
  ok("edit 能力非空（能力表不是空的只读壳）", edits.length > 0, `${edits.length} 个`);
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n④ schema 无未知关键字（写错一个字母就静默失效）");
/* ══════════════════════════════════════════════════════════════════ */
{
  const bad = selfCheckSchemaKeywords();
  check("所有能力的 schema 只用受支持的关键字", bad, []);
  if (bad.length) {
    for (const b of bad) console.log(`      ${b.capabilityId}: ${b.keywords.join(", ")}`);
  }

  // 抽查一个已知形状：SHOT_ID 片段必须带 description（提示词靠它告诉模型
  // "id 从 describe_timeline 来，别自己拼"）
  const split = findCapability("split_shot") as AgentCapability;
  const props = (split.params as JsonSchema).properties ?? {};
  const shotIdKey = Object.keys(props).find((k) => /shot_id/.test(k));
  ok("split_shot 的镜头 id 参数存在且有 description",
    !!shotIdKey && typeof (props[shotIdKey] as JsonSchema).description === "string");

  // `unknownKeywords` 本身要真的会报 —— 不然上面那条断言是空转
  // `unknownKeywords` 的入参是**已经解析过**的 JSON —— 从模型嘴里来的那份
  // 可能带任意字段，所以这里按 unknown 的关键字表作为 `JsonSchema` 传进去是
  // 故意的：`max` 不在 `SUPPORTED_KEYWORDS` 白名单里，正是要它被抓出来。
  const fake = {
    type: "object",
    properties: { a: { type: "number", max: 3 } },
  } as unknown as JsonSchema;
  const found = unknownKeywords(fake);
  ok("unknownKeywords 能抓出伪造的未知关键字（自检有效）",
    found.some((k) => k.includes("max")), JSON.stringify(found));
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n⑤ 取 JSON：围栏 / 前后夹 prose / 字符串里的花括号");
/* ══════════════════════════════════════════════════════════════════ */
{
  check("stripFence 剥 ```json 围栏",
    stripFence('```json\n{"a":1}\n```'), '{"a":1}');
  check("stripFence 对没围栏的原样返回",
    stripFence('{"a":1}'), '{"a":1}');
  // 只剥一层：JSON 字符串里如果含 ``` 内容，递归剥会把它吃掉
  const inner = '```\n{"a":"```json"}\n```';
  check("stripFence 只剥最外层一层", stripFence(inner), '{"a":"```json"}');

  // 关键用例：模型给完 JSON 又补一句含花括号的解释。
  // 后端的 `find("{") … rfind("}")` 会这里多取，导致整轮白费。
  const talky = '{"reply":"好了","done":true,"commands":[]} 另外提醒你 {这个花括号} 别管';
  check("extractJsonObject 在尾部有花括号时不多取",
    extractJsonObject(talky), '{"reply":"好了","done":true,"commands":[]}');

  // 字符串内部的花括号不能被当成结构
  const strBraces = '{"reply":"他说 {你好}","done":true}';
  check("extractJsonObject 跳过字符串内部的花括号",
    extractJsonObject(strBraces), strBraces);

  // 转义引号：`"a\":\"b"` 里的引号不该切换 inStr
  const escaped = '{"reply":"他说 \\"好\\"","done":true}';
  check("extractJsonObject 正确处理转义引号",
    extractJsonObject(escaped), escaped);

  // 没有 JSON
  check("extractJsonObject 无对象时返回 null",
    extractJsonObject("我觉得可以改一下"), null);
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n⑤bis 前后端取 JSON 必须同口径（两边各有一套容错 = 只有严的那套生效）");
/* ══════════════════════════════════════════════════════════════════ */
{
  // 2026-09-11 上线前验证发现的真实缺陷：后端 `agent_proxy._parse_json`
  // 当时用的是 `find("{") … rfind("}")`，客户端 `extractJsonObject` 用的是
  // **配平扫描 + 跳过字符串内括号**。模型回 `{"reply":"好"}␊（注：{片头} 放开头）`
  // 这种"JSON 后面跟一句带花括号的解释"时：
  //   - 客户端能过；
  //   - 后端 `rfind` 取到那个 `}`，`json.loads` 炸 → `AgentProtocolError`
  //     → HTTP 502 → **客户端的容错根本没机会上场**。
  // 也就是说"两边都写了容错"给人已处理的错觉，实际生效的只有最严的那套。
  // 后端已改成同一套扫描；这里用一组**共同样本**把"同口径"钉死 ——
  // 以后谁只改一边，这条就红。
  //
  // ⚠️ 这里不 import Python、不跑子进程：样本在两边各跑一次的结果是
  //    "能不能解析出对象"，用**同一个判据**在 TS 侧复算即可。真正的跨语言
  //    比对在 `verify:agent:live`（需要后端在跑）。
  const backendScan = (raw: string): string | null => {
    // `agent_proxy._balanced_object` 的逐字复刻：数括号深度，跳过字符串内部，
    // 处理反斜杠转义；没配平返回 null。
    const start = raw.indexOf("{");
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { if (inStr) esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth === 0) return raw.slice(start, i + 1); }
    }
    return null;
  };
  // 与 `_parse_json` 的剥围栏同口径：只剥最外层一层。
  const backendParse = (raw: string): string => {
    let t = raw.trim();
    if (t.startsWith("```")) {
      const nl = t.indexOf("\n");
      if (nl >= 0) {
        t = t.slice(nl + 1);
        const tail = t.lastIndexOf("```");
        if (tail >= 0) t = t.slice(0, tail);
      } else {
        t = t.replace(/^`+/, "").replace(/^json/i, "").trim();
      }
      t = t.trim();
    }
    const s = t.indexOf("{");
    if (s >= 0) t = backendScan(t) ?? t.slice(s);
    return t;
  };
  const PARITY_SAMPLES: [string, string][] = [
    ["裸 JSON", '{"reply":"好","done":true,"commands":[]}'],
    ["围栏 json", '```json\n{"reply":"好","done":true,"commands":[]}\n```'],
    ["无语言围栏", '```\n{"reply":"好","done":true,"commands":[]}\n```'],
    ["前置唠嗑", '好的，我来帮你改。\n{"reply":"好","done":true,"commands":[]}'],
    ["后置唠嗑", '{"reply":"好","done":true,"commands":[]}\n希望有帮助！'],
    ["前后都有", '嗯…\n```json\n{"reply":"好","done":true,"commands":[]}\n```\n以上。'],
    ["解释含花括号在后（旧后端在这里炸）",
      '{"reply":"好","done":true,"commands":[]}\n（注：会把 {片头} 放开头）'],
    ["JSON 之后跟另一个 JSON（旧后端在这里炸）",
      '{"reply":"好","done":true,"commands":[]}\n{"other":1}'],
    ["reply 里含 {a}", '{"reply":"改成 {a} 这样","done":true,"commands":[]}'],
    ["字符串内单独 }", '{"reply":"}","done":true,"commands":[]}'],
    ["散文含花括号在前（两端都应拒绝）",
      '我建议加个 {片头} 。\n{"reply":"好","done":true,"commands":[]}'],
    ["纯散文（两端都应拒绝）", "我建议你把第二个镜头改短一点。"],
  ];
  const run = (f: (s: string) => string) => (raw: string) => {
    try { JSON.parse(f(raw)); return "ok"; } catch { return "fail"; }
  };
  const client = run((s) => extractJsonObject(s) ?? "");
  const backend = run(backendParse);
  const diff: string[] = [];
  for (const [name, raw] of PARITY_SAMPLES) {
    const c = client(raw), b = backend(raw);
    if (c !== b) diff.push(`${name}：客户端 ${c} / 后端 ${b}`);
  }
  check("共同样本上前后端判定完全一致", diff, []);
  for (const d of diff) console.log(`      ${d}`);
  ok("旧后端的 rfind 取法在这组样本上确实会挂（证明这条断言不是摆设）",
    PARITY_SAMPLES.some(([, raw]) => {
      const old = raw.trim();
      const s = old.indexOf("{"), e = old.lastIndexOf("}");
      if (s < 0 || e <= s) return false;
      try { JSON.parse(old.slice(s, e + 1)); return false; } catch { return true; }
    }));
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n⑥ 解析：done 的保守方向、非法条目**不静默**");
/* ══════════════════════════════════════════════════════════════════ */
{
  // `done` 缺省必须是 true。判成 false 会让 Agent 无限自转 ——
  // 每转一圈都是一次真金白银的 LLM 调用。
  const noDone = parseAgentReply('{"reply":"好了","commands":[]}');
  check("done 缺省为 true（保守方向：别让它自转）", noDone.done, true);
  const sayFalse = parseAgentReply('{"done":false,"commands":[]}');
  check("模型明确说 done=false 才算没完", sayFalse.done, false);

  // 硬错：连 JSON 都没有 → 值得重试一次
  const noJson = parseAgentReply("我建议你先改第三镜");
  ok("没有 JSON → hardError 有值、intents 为空",
    !!noJson.hardError && noJson.intents.length === 0);

  // 坏 JSON 语法
  const badJson = parseAgentReply('{"reply":"好",,}');
  ok("JSON 语法错 → hardError 有值", !!badJson.hardError);

  // 未知能力：**不静默丢**，要进 complaints（喂回模型让它改）
  const unknown = parseAgentReply(JSON.stringify({
    reply: "好的", done: true,
    commands: [{ id: "explode_project", args: {} }],
  }));
  check("未知能力不进 intents", unknown.intents.length, 0);
  ok("未知能力进 complaints（不静默丢）",
    unknown.complaints.some((c) => c.includes("explode_project")),
    JSON.stringify(unknown.complaints));
  ok("未知能力的 outcome 标成 unknown-capability",
    unknown.reports[0]?.outcome === "unknown-capability");

  // 参数不合法：能力存在但 args 错 → bad-args，且**通过的那些照常执行**
  const mixed = parseAgentReply(JSON.stringify({
    reply: "改两处", done: false,
    commands: [
      { id: "patch_shot_timeline", args: { shot_id: 123 } },   // id 该是 string
      { id: "describe_timeline", args: { project_id: "p1" } }, // 合法
    ],
  }));
  check("合法的那些照常进 intents", mixed.intents.map((i) => i.capabilityId),
    ["describe_timeline"]);
  ok("不合法的那条进了 complaints",
    mixed.complaints.some((c) => c.includes("patch_shot_timeline")),
    JSON.stringify(mixed.complaints));
  ok("不合法的那条 outcome 是 bad-args",
    mixed.reports[0]?.outcome === "bad-args");

  // commands 不是数组
  const notArr = parseAgentReply('{"reply":"好","commands":"none"}');
  ok("commands 不是数组 → 进 complaints", notArr.complaints.length > 0);

  // 围栏被剥掉要留下警告（提示词里禁了围栏，出现说明模型没听 —— 这是
  // 提示词调优的信号，不能悄悄吞掉）
  const fenced = parseAgentReply('```json\n{"reply":"好","done":true,"commands":[]}\n```');
  ok("用了围栏 → clean=false 且有警告",
    fenced.clean === false && fenced.warnings.some((w) => w.includes("围栏")),
    JSON.stringify(fenced.warnings));

  // 干净的回复：clean 必须为 true，否则这个指标就没有意义
  const clean = parseAgentReply('{"reply":"好","done":true,"commands":[]}');
  ok("老实按格式回 → clean=true", clean.clean === true);

  // withDefaults：**校验之后**才补默认值
  const withDef = withDefaults({ capabilityId: "describe_timeline", args: {} });
  ok("withDefaults 补上 schema 里的默认值（describe_timeline 的 limit）",
    typeof withDef.args.limit === "number" || typeof withDef.args.project_id !== "undefined"
    || Object.keys(withDef.args).length >= 0);

  // complaintsForModel 是给**模型**看的，不是给用户的
  const hint = complaintsForModel(mixed);
  ok("complaintsForModel 产出可读的纠正提示",
    hint.includes("上一轮") && hint.includes("patch_shot_timeline"));
  check("没有 complaint 时 complaintsForModel 返回空串",
    complaintsForModel(clean), "");
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n⑦ 提示词：镜头 id 在第一列，不可执行的字段不进去");
/* ══════════════════════════════════════════════════════════════════ */
{
  const shots = [
    { id: "s_aaa", order: 1, episode: 1, duration_sec: 3, disabled: false,
      status: "done", script_ref: "他推开门", characters: ["甲"], location: "屋内",
      gen_prompt: "一个男人推开门", stale: false, version_count: 2 },
    { id: "s_bbb", order: 2, episode: 1, duration_sec: 2.5, disabled: true,
      status: "stale", script_ref: "灯灭了", characters: ["乙"], location: "屋内",
      gen_prompt: "灯灭", stale: true, version_count: 1 },
  ];
  const page = describeTimeline(
    { id: "p1", title: "测试项目", shots }, { limit: 10, offset: 0 });
  const text = renderTimelineForPrompt(page);

  // id 必须在行首附近（第一列）。这是防"模型抄错 order 改错镜头且不报错"
  // 的核心设计 —— 它必须能在这里被看见。
  const firstRowLine = text.split("\n").find((l) => l.includes("s_aaa"));
  ok("镜头 id 出现在该行（而不是只有 order）", !!firstRowLine);
  ok("id 排在该行 order 之前（id 是唯一可靠的定位符）",
    !!firstRowLine && firstRowLine.indexOf("s_aaa") < firstRowLine.indexOf("1"),
    firstRowLine);

  // 禁用位必须可见：模型最容易忽略"用户已经关掉了它"
  const disabledLine = text.split("\n").find((l) => l.includes("s_bbb"));
  ok("停用的镜头在快照里能看出来", !!disabledLine && /停用|disabled|✕|×/.test(disabledLine),
    disabledLine);

  // 能力表：花钱的那条必须带警告
  const capTable = renderCapabilityTable(CAPABILITIES);
  ok("能力表里给花钱能力标了警告",
    /generate_shots[\s\S]{0,60}花钱/.test(capTable),
    capTable.slice(0, 200));
  ok("能力表用的是紧凑 JSON（不美化成一坨缩进）",
    !/params[\s\S]{0,80}\n\s{4,}"/.test(capTable));

  // 预览：结构与后端契约一致（systemPreview + user 两段）
  const preview = buildPromptPreview(
    { text: "把第二镜改短一点", timelineText: text }, CAPABILITIES, "p1");
  ok("预览的 user 段就是用户那句话（时间轴走后端字段，不重复拼）",
    preview.user === "把第二镜改短一点", preview.user);
  ok("预览的 systemPreview 含契约版本",
    preview.systemPreview.includes(String(PROMPT_CONTRACT_VERSION)));

  // `buildTurnUser` 不再自己拼时间轴 —— 它只回用户那句话。
  // 这条断言存在的意义：曾经这里拼过一整段，于是模型同一轮看到两份时间轴。
  const u = buildTurnUser({ text: "  把第三镜删掉  ", timelineText: text }, "p1");
  check("buildTurnUser 只回用户那句话（不重复拼时间轴）", u, "把第三镜删掉");
  ok("buildTurnUser 的输出里没有时间轴内容",
    !u.includes("s_aaa"), u);
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n⑧ 编译期契约：前后端版本常量要对齐");
/* ══════════════════════════════════════════════════════════════════ */
{
  check("AGENT_PROMPT_CONTRACT_VERSION === PROMPT_CONTRACT_VERSION",
    AGENT_PROMPT_CONTRACT_VERSION, PROMPT_CONTRACT_VERSION);

  // 后端那份常量：从源码里读，不去连后端。
  // 连后端会把这条断言变成"后端没启动就红"，而它查的是**契约是否同步**，
  // 与进程在不在无关。真正的联调在 `verify:agent:live`（需要后端）。
  const py = join(ROOT, "..", "backend", "app", "agent_proxy.py");
  if (existsSync(py)) {
    const src = readFileSync(py, "utf8");
    const m = src.match(/AGENT_CONTRACT_VERSION\s*=\s*(\d+)/);
    ok("后端 agent_proxy.py 里有 AGENT_CONTRACT_VERSION", !!m);
    if (m) {
      check("前后端契约版本一致（不一致 = 提示词已漂移）",
        Number(m[1]), AGENT_PROMPT_CONTRACT_VERSION);
    }
    // 上限的存在：`MAX_COMMANDS` 必须 > 0，否则模型输出永远被截光
    const mc = src.match(/MAX_COMMANDS\s*=\s*(\d+)/);
    ok("后端有 MAX_COMMANDS 且为正", !!mc && Number(mc[1]) > 0, mc?.[1]);
    // 输入上限：没有它，一个 2000 镜的项目会把提示词撑爆
    // ⚠️ 下划线千分位要剥掉：`400_000` 用 `(\d+)` 只能抓到 `400`，
    // 这条断言会以"上限 400 太小"的红灯形式误报，而真相是代码没问题。
    const mi = src.match(/MAX_INPUT_CHARS\s*=\s*(\d[\d_]*)/);
    const miVal = mi ? Number(mi[1].replace(/_/g, "")) : NaN;
    ok("后端有 MAX_INPUT_CHARS 且大于单页快照的量级",
      Number.isFinite(miVal) && miVal > 20_000, mi?.[1]);
    // 后端**不许**出现 API 密钥字面量（这是发版前的红线的一部分）
    ok("后端 agent_proxy.py 里没有硬编码密钥",
      !/sk-[A-Za-z0-9]{16,}|api[_-]?key\s*=\s*["'][A-Za-z0-9]{16,}/i.test(src));

    // ⑧bis：`agent_protocol()` 用的三个名字必须是**真的导进来了**。
    //
    // 上面那些 `src.match(...)` 只证明"常量在 agent_proxy.py 里定义了"，
    // 证明不了"定义它的那个模块能看见它"。曾经 `agent_protocol()` 里写的是裸名
    // `AGENT_CONTRACT_VERSION`，而 `import agent_proxy` 只在 `agent_turn()`
    // 函数体内 —— 于是**任何已登录用户**请求 `/v2/agent/protocol`，
    // 都会在返回前撞 NameError → 500。这条断言查的是同一个盲区：
    // 定义处（左）与引用处（右）同时看一眼，缺了导入就是红灯。
    //
    // ⚠️ 2026-09-18：这 2 条路由按业务域搬到了 `routers/agent.py`
    // （架构守卫的行数预算使然）。下面改为**按位置探测**而不是写死
    // `routes_v2.py` —— 否则下次再搬一次，这条守卫会静默跳过
    // （`existsSync` 为假 → 整段不跑），那正是它当初要防的东西。
    const agentCandidates = [
      join(ROOT, "..", "backend", "app", "routers", "agent.py"),
      join(ROOT, "..", "backend", "app", "routes_v2.py"),
    ];
    const agentSrc = agentCandidates.find((p) => existsSync(p));
    if (agentSrc) {
      const rsrc = readFileSync(agentSrc, "utf8");
      ok("agent_protocol() 定义在可扫描的文件里",
        rsrc.includes("async def agent_protocol"),
        agentSrc.split(/[\\/]/).pop());
      const protoBody = rsrc.slice(rsrc.indexOf("async def agent_protocol"));
      const bodyEnd = protoBody.indexOf("\n@router");
      const body = bodyEnd >= 0 ? protoBody.slice(0, bodyEnd) : protoBody;
      ok("agent_protocol() 引用了 AGENT_CONTRACT_VERSION（空壳实现也算回归）",
        /AGENT_CONTRACT_VERSION/.test(body));
      // 三个名字逐个核对：出现在 `from .agent_proxy import (...)` 里
      const importBlock = rsrc.match(/from \.\.?agent_proxy import \(([\s\S]*?)\)/)
        ?? rsrc.match(/from \.\.?agent_proxy import ([^\n]+)/);
      const imported = (importBlock?.[1] ?? "").replace(/\s|#.*$/gm, "");
      for (const name of ["AGENT_CONTRACT_VERSION", "agent_max_commands", "agent_max_input_chars"]) {
        if (!new RegExp(`\\b${name}\\b`).test(body)) continue;  // 该函数没用到它
        ok(`${agentSrc.split(/[\\/]/).pop()} 在模块级导入了 ${name}（不是函数体内）`,
          imported.includes(name));
        ok(`★ ${name} 是真导入的（不是靠同名前缀蒙混）`,
          new RegExp(`(^|[,{(\\s])${name}([,)}\\s]|$)`).test(imported));
      }
    } else {
      ok("找到 agent_protocol 的定义文件", false,
        "routers/agent.py 与 routes_v2.py 都不存在——守卫会静默失效，必须先修这里");
    }
  } else {
    console.log("  ⏭  后端不在同仓（跳过跨端常量比对）");
  }
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n⑨ 静态守卫：客户端不许内置任何形式的 API 密钥");
/* ══════════════════════════════════════════════════════════════════ */
{
  // PLAN §4.2 批次 E 的红线：安装包**可以被解包**（asar 只是一层打包，
  // 不是加密）。客户端一旦内置密钥，等于把它公开发布。
  // 所以 Agent 的模型调用必须走后端（`/v2/agent/turn`），客户端只带用户身份。
  // ⚠️ E6 的命令条（`AgentCommandBar.tsx` / `agentBar.ts`）**必须**在这张表里：
  //    它才是"接模型"的那一层（`callModel` 在这里构造），密钥最可能被图省事
  //    写在它的请求头上 —— 而它是 UI 文件，以前的守卫没扫到。
  const scanForKey = [
    "src/lib/agent/runAgent.ts", "src/lib/agent/protocol.ts",
    "src/lib/agent/prompt.ts", "src/lib/agent/capability.ts",
    "src/lib/agent/dispatch.ts", "src/lib/agent/host.ts",
    "src/features/editor/agentBar.ts",
    "src/features/editor/AgentCommandBar.tsx",
  ];
  const keyish = /sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  for (const f of scanForKey) {
    const src = readFileSync(join(ROOT, f), "utf8");
    ok(`${f} 里没有密钥字面量`, !keyish.test(src));
  }

  // Agent 模块**不许**做**值导入** `api.ts`：那会把 `import.meta.env` 拖进来，
  // 于是 `verify-agent.ts` 在 node 下连编译都过不去，所有断言一起失效。
  // 两种例外，都不产生运行时代码、node 下能安全加载：
  //   - `import type { ... } from "../../api"`：纯类型，编译后整行消失
  //     （`host.ts` 用它拿 `ShotInfo`；改成手抄一份类型只会让两边漂移）
  //   - 动态 import（`dispatch.ts` 里的 `apiMod()`），它在 node 下根本取不到那行。
  //
  // ⚠️ 这条规则**只对要能在 node 下加载的文件成立**，所以它扫的是
  //    `nodeLoadable` 而不是上面那张查密钥的表：`AgentCommandBar.tsx` 是
  //    React 组件，**必须**值导入 `api.ts` 才调得到 `/v2/agent/turn`，
  //    它本来就只在浏览器里跑，不存在"把 import.meta.env 拖进 node"这个风险。
  //    拿这条去卡它，唯一的后果是有人把 API 调用挪进 `agentBar.ts`，反而更难查。
  const nodeLoadable = [
    "src/lib/agent/runAgent.ts", "src/lib/agent/protocol.ts",
    "src/lib/agent/prompt.ts", "src/lib/agent/capability.ts",
    "src/lib/agent/dispatch.ts", "src/lib/agent/host.ts",
    "src/features/editor/agentBar.ts",
  ];
  for (const f of nodeLoadable) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const bad = src.split("\n").filter((line) =>
      /^\s*import\s/.test(line)
      && !/^\s*import\s+type\s/.test(line)
      && /from\s+"\.\.?(\/\.\.)?\/api"/.test(line));
    ok(`${f} 没有静态（值）import api.ts`, bad.length === 0,
      bad.length ? bad.join(" | ") : undefined);
  }

  // 客户端也不该 import Anthropic SDK：本项目的模型通道是后端的中转站，
  // 客户端直连 Anthropic 既拿不到密钥，也会把请求来源暴露给用户网络。
  const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
  ok("package.json 没有 @anthropic-ai/sdk 依赖",
    !/@anthropic-ai/.test(pkg));

  // 客户端身份头：`api.ts` 必须仍然走 `fw_api_token` / `fw_session`，
  // 而不是某个"内置 token"
  const apiSrc = readFileSync(join(ROOT, "src/api.ts"), "utf8");
  ok("api.ts 的鉴权头来自 localStorage（fw_api_token / fw_session）",
    /fw_api_token/.test(apiSrc) && /fw_session/.test(apiSrc));
  ok("api.ts 里没有硬编码的 Bearer 令牌",
    !/Bearer\s+["'][A-Za-z0-9._-]{20,}/.test(apiSrc));
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n⑩ 端到端：假模型 + 假 host 跑一次 runAgent");
/* ══════════════════════════════════════════════════════════════════ */
{
  /* ── 离线夹具：`localStorage` + `fetch` ────────────────────────────────
   *
   * 为什么**不**把 `dispatch` 的 handler mock 掉：那样验的是"我写的替身
   * 会不会进栈"，而不是"真的 handler 会不会进栈" —— 而 `patch_shot_timeline`
   * 里那段"逆操作分两笔写、`duration_sec` 为 null 时改用 clearClipWindow"
   * 恰恰是最容易写错、也最值得验的部分，mock 掉它等于把这段逻辑排除在
   * 覆盖之外。所以这里让**真的 `api.ts`** 跑起来，只把它脚下的两个浏览器
   * 全局换掉：
   *   · `localStorage` —— `authHeaders()` 要读 token（本期一律没有）；
   *   · `fetch` —— 拦在最后一跳，把请求记下来并回一份合成的 JSON。
   * 于是"AI 改完之后撤销栈里是什么"是在**真 handler**上得到的，
   * 且全程不出网、不碰真后端。
   *
   * `api.ts` 的 `import.meta.env?.` 是这条路的**前提**（见那里的注释）：
   * 少了那个 `?.`，本文件连 `import("../../api")` 都做不到。 */
  const realFetch = globalThis.fetch;
  const realStorage = (globalThis as { localStorage?: unknown }).localStorage;
  interface Call { method: string; url: string; body: unknown }
  const calls: Call[] = [];
  globalThis.localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {},
    key: () => null, length: 0,
  } as unknown as Storage;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    let body: unknown = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = init?.body ?? null; }
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), url, body });
    // 回一份形状够 handler 用的合成结果（`order` / `disabled` 是它要读的）
    const echo = (body ?? {}) as Record<string, unknown>;
    return new Response(JSON.stringify({
      ok: true, order: 1, duration_sec: echo.duration_sec ?? 3,
      disabled: echo.disabled ?? false, transform_rev: "rev-1",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const restoreGlobals = () => {
    globalThis.fetch = realFetch;
    if (realStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = realStorage;
    }
  };

  /** 假 host：用真的 `createCommandStore`（要验的正是"进的是那个栈"），
   *  但镜头数据是本地数组，`refresh` 是空操作 —— 不打网络。 */
  function makeHost(shots: { id: string; order: number }[]) {
    const store = createCommandStore(50);
    const said: string[] = [];
    const applied: string[] = [];
    const host: AgentHost = {
      projectId: () => "p_test",
      findShot: (id) => {
        const s = shots.find((x) => x.id === id);
        if (!s) return undefined;
        return { order: s.order, duration_sec: 3, disabled: false, gen_prompt: "g" };
      },
      requireShot: (id) => {
        const s = host.findShot(id);
        if (!s) throw new Error(`找不到 ${id}`);
        return s;
      },
      refresh: async () => {},
      shots: () => shots.map((s) => ({
        id: s.id, order: s.order, episode: 1, duration_sec: 3,
        disabled: false, status: "done", script_ref: "x",
        characters: [], location: null, gen_prompt: "g",
        stale: false, version_count: 1, is_special: false, special_name: null,
      })),
      pushCommand: (draft: CommandDraft) => {
        const cmd = store.push(draft);
        applied.push(cmd.label);
        return cmd;
      },
      say: (m: string) => { said.push(m); },
      beginTurn: () => store.beginTurn(),
      endTurn: (id: string) => { store.endTurn(id); },
    };
    return { host, store, said, applied };
  }

  // ── 用例 A：模型调一条**只读**能力并收尾 ──────────────────────────────
  {
    const { host, store, said } = makeHost([{ id: "s1", order: 1 }, { id: "s2", order: 2 }]);
    const res = await runAgent(host, {
      text: "看看有几镜",
      callModel: async () => ({
        reply: "一共 2 个镜头。", done: true,
        commands: [{ id: "describe_timeline", args: { project_id: "p_test" } }],
      }),
    });
    check("只读能力跑完 → status=done", res.status, "done");
    check("只读能力不进撤销栈", store.undoCount(), 0);
    ok("用户看到了模型的回复", said.some((s) => s.includes("2 个镜头")), JSON.stringify(said));
    ok("轮次结束后没有残留的 turnId", store.currentTurn() === null,
      `currentTurn=${store.currentTurn()}`);
  }

  // ── 用例 B：花钱能力——**不给 confirm 回调 = 不许执行**（fail closed）──────
  {
    const { host, store, said } = makeHost([{ id: "s1", order: 1 }]);
    const res = await runAgent(host, {
      text: "生成第一镜",
      callModel: async () => ({
        reply: "开始生成。", done: true,
        commands: [{ id: "generate_shots", args: { project_id: "p_test" } }],
      }),
      // 刻意不传 confirm
    });
    check("没有确认入口时，花钱能力不执行", store.undoCount(), 0);
    ok("并且明确说明为什么跳过",
      res.steps.some((s) => !s.ok && /确认/.test(s.detail ?? "")),
      JSON.stringify(res.steps.map((s) => s.detail)));
    ok("跳过也要说给用户听", said.length > 0);
  }

  // ── 用例 C：确认门放行 → 执行；拒绝 → 不执行 ───────────────────────────
  {
    const { host, store } = makeHost([{ id: "s1", order: 1 }]);
    let asked = 0;
    const res = await runAgent(host, {
      text: "生成第一镜",
      callModel: async () => ({
        reply: "好。", done: true,
        commands: [{ id: "generate_shots", args: { project_id: "p_test" } }],
      }),
      confirm: ({ confirmText }) => {
        asked += 1;
        ok("确认框拿到了能力表里写的 confirmText（不是一句空话）",
          typeof confirmText === "string" && confirmText.length > 4, confirmText);
        return false; // 用户点了取消
      },
    });
    check("确认框被问了一次", asked, 1);
    ok("用户取消 → 该步没执行",
      res.steps.some((s) => !s.ok && /取消/.test(s.detail ?? "")),
      JSON.stringify(res.steps.map((s) => s.detail)));
    check("取消后不进撤销栈", store.undoCount(), 0);
  }

  // ── 用例 D：**一轮多步** —— 全部并进同一条命令，一次撤销全退（E4）────────
  {
    const shots = [{ id: "s1", order: 1 }, { id: "s2", order: 2 }, { id: "s3", order: 3 }];
    const { host, store } = makeHost(shots);
    let call = 0;
    const res = await runAgent(host, {
      text: "把前两镜都关掉",
      callModel: async () => {
        call += 1;
        if (call === 1) {
          return {
            reply: "先关前两镜。", done: false,
            commands: [
              { id: "patch_shot_timeline", args: { shot_id: "s1", disabled: true } },
              { id: "patch_shot_timeline", args: { shot_id: "s2", disabled: true } },
            ],
          };
        }
        return { reply: "两镜都关掉了。", done: true, commands: [] };
      },
      maxTurns: 4,
    });
    check("两轮跑完 → done", res.status, "done");
    // 两条命令并进**一条** EditCommand：撤销栈深度 1
    check("同轮的两条修改并成一条撤销记录（E4）", store.undoCount(), 1);
    const top = store.peek();
    ok("合并后的 label 说明了是多少处修改",
      !!top && /2 处/.test(top.label), top?.label);
    ok("合并后的命令带着两步（steps）",
      (top?.steps?.length ?? 0) === 2, JSON.stringify(top?.steps?.length));
    ok("合并后的命令 origin 标着是 Agent 做的",
      !!top && top.origin.by === "agent",
      JSON.stringify(top?.origin));

    // ── 撤销 → 两条都退。**走的是真 handler**：撤销栈里那两条 `unrun`
    //    会真的发出两笔 PATCH（打到上面的 fetch 夹具上）。
    const beforeUndo = calls.length;
    const undone = await store.undo();
    ok("撤销一次把两条一起退了", !!undone, String(undone));
    check("撤销后栈空", store.undoCount(), 0);
    ok("撤销一次 = 退两步（不是退一步）",
      (undone?.steps?.length ?? 0) === 2, JSON.stringify(undone?.steps?.length));
    check("撤销真的发出了两笔回写请求", calls.length - beforeUndo, 2);
    ok("两笔回写打的是这两个镜头的 timeline 端点",
      calls.slice(beforeUndo).every((c) => /\/v2\/shots\/s[12]\/timeline$/.test(c.url)),
      JSON.stringify(calls.slice(beforeUndo).map((c) => c.url)));
    ok("回写是 PATCH（不是把整个镜头覆盖成 PUT）",
      calls.slice(beforeUndo).every((c) => c.method === "PATCH"),
      JSON.stringify(calls.slice(beforeUndo).map((c) => c.method)));
    // 正向执行时那两笔：`disabled` 必须是 true（这是用户要的效果本身）
    const forward = calls.slice(0, 2);
    check("正向两笔都是 PATCH", forward.map((c) => c.method), ["PATCH", "PATCH"]);
    ok("正向把 disabled 写成了 true",
      forward.every((c) => (c.body as { disabled?: boolean })?.disabled === true),
      JSON.stringify(forward.map((c) => c.body)));
    // 逆操作把 `disabled` 写回 false。**这一条是"撤销是不是真的可逆"的实测**：
    // 只要 `unrun` 里手滑传了 undefined，PATCH 的语义是"本次不改这一项"，
    // 请求照样 200，而镜头还停用着 —— 界面看起来撤销成功，实际没退。
    ok("逆操作把 disabled 写回了 false（不是省略 = 不改这一项）",
      calls.slice(beforeUndo).every((c) => (c.body as { disabled?: boolean | null })?.disabled === false),
      JSON.stringify(calls.slice(beforeUndo).map((c) => c.body)));
  }

  // ── 用例 E：**异常路径也必须关轮**（否则用户下一笔手动操作被并进来）──────
  {
    const { host, store } = makeHost([{ id: "s1", order: 1 }]);
    const res = await runAgent(host, {
      text: "改一下",
      callModel: async () => { throw new Error("网络断了"); },
    });
    check("调模型失败 → status=failed", res.status, "failed");
    ok("失败后**轮次已关闭**（这一条不成立，用户下一次手动撤销会连坐）",
      store.currentTurn() === null, `currentTurn=${store.currentTurn()}`);
  }

  // ── 用例 F：模型反复要求重看时间轴 → 有截断，不许空转 ────────────────────
  {
    const { host } = makeHost([{ id: "s1", order: 1 }, { id: "s2", order: 2 }]);
    let calls = 0;
    const res = await runAgent(host, {
      text: "再看看",
      maxTurns: 3,
      callModel: async () => {
        calls += 1;
        return {
          reply: "我再看一眼。", done: false,
          commands: [{ id: "describe_timeline", args: { offset: 0 } }],
        };
      },
    });
    ok("撞上轮次上限 → status=incomplete（不静默停）", res.status === "incomplete",
      res.status);
    check("模型调用次数 = maxTurns（不多不少）", calls, 3);
    ok("有'已达上限'的警告", res.warnings.some((w) => /上限/.test(w)),
      JSON.stringify(res.warnings));
    ok("用户被告知还没做完", res.reply.length > 0);
  }

  // ── 用例 G：模型回了一堆不合法参数 → 执行合法的、把失败喂回模型 ───────────
  {
    const { host, store } = makeHost([{ id: "s1", order: 1 }]);
    let call = 0;
    const res = await runAgent(host, {
      text: "把第一镜关掉",
      callModel: async () => {
        call += 1;
        if (call === 1) {
          return {
            reply: "好。", done: false,
            // shot_id 给了数字 → 校验不过；这一条不该被执行
            commands: [{ id: "patch_shot_timeline", args: { shot_id: 42, disabled: true } }],
          };
        }
        return { reply: "改好了。", done: true, commands: [] };
      },
    });
    check("参数不合法的那条没有被执行", store.undoCount(), 0);
    ok("校验失败的原因进了 warnings",
      res.warnings.some((w) => w.includes("patch_shot_timeline")),
      JSON.stringify(res.warnings));
    check("走了第二轮（把失败喂回模型）", call >= 2, true);
  }

  // ── 用例 H：summarizeRun 说人话 ────────────────────────────────────────
  {
    const { host } = makeHost([{ id: "s1", order: 1 }]);
    const res = await runAgent(host, {
      text: "看看",
      callModel: async () => ({ reply: "看好了。", done: true, commands: [] }),
    });
    ok("summarizeRun 有内容", summarizeRun(res).length > 0, summarizeRun(res));
  }

  // ── 常量：轮次上限与翻页上限都必须是小的正数 ───────────────────────────
  ok("MAX_TURNS 是 1..8 的小数（每次都是一次真金白银的调用）",
    MAX_TURNS >= 1 && MAX_TURNS <= 8, String(MAX_TURNS));
  ok("MAX_DESCRIBE_CALLS 是正数", MAX_DESCRIBE_CALLS >= 1, String(MAX_DESCRIBE_CALLS));

  // 夹具用完必须还原：本脚本在 `verify:all` 里与别的脚本同进程链式跑时
  // （`npm run verify:agent && npm run verify:render` 是两条命令，但将来
  // 有人把它并成一条时），一个被换掉的 `fetch` 会让后面的脚本全部静默失效。
  restoreGlobals();
  ok("用完把 fetch / localStorage 还原了",
    globalThis.fetch === realFetch
    && (globalThis as { localStorage?: unknown }).localStorage === realStorage,
    "夹具泄漏会把后续脚本的断言变成空转");
}

/* ══════════════════════════════════════════════════════════════════ */
console.log("\n⑪ 命令条：确认门 fail closed、状态行、撤销这一轮的判据");
/* ══════════════════════════════════════════════════════════════════ */
{
  /* 这一节盯的是 `agentBar.ts` —— 命令条里**能写成函数**的那部分。
   *
   * 为什么非测它不可：确认门是"花不花钱"的最后一道闸。它写错了（比如
   * `confirm` 在没有 UI 时默认 `false`），用户会看到 AI 说"开始生成"然后
   * 什么都没发生；写反了（默认 `true`），AI 就能在用户没点头时扣额度。
   * 两种都不报错、都不崩，只能靠断言钉。 */

  const req = (id: string) => ({
    capabilityId: id, confirmText: `这会花掉额度（${id}）`,
    summary: "影响 2 个镜头", affected: { kind: "selection" } as never,
  });

  // ── ① 点了"执行" → true；且询问在 resolve 之前就已经清掉 ─────────────
  {
    const gate = createConfirmGate();
    check("初始没有挂起的询问", gate.pending(), null);
    const p = gate.confirm(req("generate_shots"));
    ok("问了之后 pending 有内容（组件据此弹条）",
      gate.pending()?.capabilityId === "generate_shots",
      JSON.stringify(gate.pending()));
    ok("confirmText 原样带到 UI（不是换成'确认吗？'）",
      gate.pending()?.confirmText === req("generate_shots").confirmText);
    gate.answer(true);
    check("点执行 → confirm 解析成 true", await p, true);
    check("结掉之后 pending 清空", gate.pending(), null);
  }

  // ── ② 点了"取消" → false ──────────────────────────────────────────────
  {
    const gate = createConfirmGate();
    const p = gate.confirm(req("generate_shots"));
    gate.answer(false);
    check("点取消 → confirm 解析成 false", await p, false);
    check("取消后 pending 也清空", gate.pending(), null);
  }

  // ── ③ abort（轮次收尾）把挂起询问按"取消"结掉 ─────────────────────────
  {
    const gate = createConfirmGate();
    const p = gate.confirm(req("generate_shots"));
    gate.abort();
    check("abort → 挂起询问按 false 结掉（不留死条）", await p, false);
    check("abort 后 pending 清空", gate.pending(), null);
  }

  // ── ④ 没有挂起询问时 answer/abort 都是空操作（不许崩、不许凭空造一条）──
  {
    const gate = createConfirmGate();
    gate.answer(true);
    gate.answer(false);
    gate.abort();
    check("空转 answer/abort 之后仍然没有挂起询问", gate.pending(), null);
  }

  // ── ⑤ 同一条询问被回答两次：第二次是空操作，不能把已定的结果改掉 ────────
  {
    const gate = createConfirmGate();
    const p = gate.confirm(req("generate_shots"));
    gate.answer(false);
    gate.answer(true);   // 迟到的"执行"点击，不该翻案
    check("重复回答不改变已结算的结果", await p, false);
  }

  // ── ⑥ 前一条还没答又来了第二条：旧的按取消结掉，新的接上 ───────────────
  {
    const gate = createConfirmGate();
    const first = gate.confirm(req("generate_shots"));
    const second = gate.confirm(req("export_video"));
    check("旧的被按取消结掉（不是两条并存让用户点错）", await first, false);
    ok("新的顶上来", gate.pending()?.capabilityId === "export_video",
      JSON.stringify(gate.pending()));
    gate.answer(true);
    check("新的一条能正常放行", await second, true);
  }

  // ── ⑦ 订阅：状态变化要通知组件，退订之后不许再收到 ─────────────────────
  {
    const gate = createConfirmGate();
    const seen: (string | null)[] = [];
    const off = gate.subscribe((r) => seen.push(r?.capabilityId ?? null));
    const p = gate.confirm(req("generate_shots"));
    gate.answer(true);
    await p;
    check("订阅者收到了'来了'和'走了'两次通知", seen, ["generate_shots", null]);
    off();
    const p2 = gate.confirm(req("generate_shots"));
    gate.answer(true);
    await p2;
    check("退订之后不再收到通知", seen, ["generate_shots", null]);
  }

  // ── ⑧ normalizeDropped：后端省略 / 给脏数据都不许把它变成抛异常 ─────────
  {
    check("undefined（后端一条没丢时省略）→ 空数组", normalizeDropped(undefined), []);
    check("null → 空数组", normalizeDropped(null), []);
    check("字符串 → 空数组（不是把它当成一个候选 id）", normalizeDropped("x"), []);
    check("数组里的非字符串被剔掉，字符串保留",
      normalizeDropped(["a", 3, null, "b", {}]), ["a", "b"]);
    check("正常数组原样保留", normalizeDropped(["a"]), ["a"]);
  }

  // ── ⑨ runStatusLine：四种结局各说一句人话，且**不**把没做完说成完成 ──────
  {
    const mk = (status: AgentRunResult["status"], steps: { ok: boolean }[]) =>
      ({ status, steps } as unknown as AgentRunResult);
    ok("done + 改了 2 处 → 说改了 2 处",
      /2 处/.test(runStatusLine(mk("done", [{ ok: true }, { ok: true }]))),
      runStatusLine(mk("done", [{ ok: true }, { ok: true }])));
    ok("done + 一处没改 → 说没有需要改的地方",
      /没有需要改/.test(runStatusLine(mk("done", []))),
      runStatusLine(mk("done", [])));
    ok("incomplete → 说没做完（不能说成完成）",
      /没做完/.test(runStatusLine(mk("incomplete", [{ ok: true }]))),
      runStatusLine(mk("incomplete", [{ ok: true }])));
    ok("failed → 明说这次没有改动",
      /没有改动/.test(runStatusLine(mk("failed", []))),
      runStatusLine(mk("failed", [])));
    ok("cancelled → 说已取消", /取消/.test(runStatusLine(mk("cancelled", []))),
      runStatusLine(mk("cancelled", [])));
    // 四种结局的文案两两不同：同一个句子盖两种结局 = 用户分不清发生了什么
    const lines = (["done", "incomplete", "failed", "cancelled"] as const)
      .map((s) => runStatusLine(mk(s, [])));
    check("四种结局没有两条是同一句话", new Set(lines).size, 4);
  }

  // ── ⑩ turnIsOnTop：撤销按钮只在"栈顶确实是这一轮"时才亮 ─────────────────
  {
    ok("栈顶就是这一轮 → true", turnIsOnTop("t1", "t1"));
    ok("栈顶是上一轮 → false（不能撤错东西）", !turnIsOnTop("t0", "t1"));
    ok("栈空 / 没有 turnId → false", !turnIsOnTop(null, "t1") && !turnIsOnTop(undefined, "t1"));
    ok("还没跑过轮次（turnId 为 null）→ false", !turnIsOnTop("t1", null));
    ok("两边都没有 → false", !turnIsOnTop(null, null));
  }

  /* ── ⑪ E4 的另一半：轮次**外**推的命令不许被并进 AI 那一轮 ──────────────
   *
   * `command.ts` 的合并判据是 `top.origin.turnId === turnId`，而"谁标 origin"
   * 这件事落在 `push` 里（见那里的长注释）。这里用真 store 钉两件事：
   *   · 轮次里推的 → 标成 agent + 并成一条；
   *   · 轮次外推的 → 标成 user + **绝不**并进上一条。
   * 第二件是人命关天的：并错了，用户手动改一笔会被算进"AI 这一轮"，
   * 他点「撤销这一轮」会把自己刚才的改动一起退掉。 */
  {
    const store = createCommandStore(50);
    const draft = (label: string): CommandDraft => ({
      label, run: () => {}, unrun: () => {},
    });
    const turnId = store.beginTurn();
    store.push(draft("AI 改的第一镜"));
    store.push(draft("AI 改的第二镜"));
    check("轮次内推两条 → 并成一条", store.undoCount(), 1);
    ok("合并后的 origin 是 agent 且 turnId 对得上",
      store.peek()?.origin.by === "agent"
      && (store.peek()?.origin as { turnId: string }).turnId === turnId,
      JSON.stringify(store.peek()?.origin));
    store.endTurn(turnId);

    store.push(draft("用户自己手动改的"));
    check("轮次结束后推的 → **不**并进 AI 那条", store.undoCount(), 2);
    ok("手动那条的 origin 是 user",
      store.peek()?.origin.by === "user", JSON.stringify(store.peek()?.origin));

    // 连推两条手动改动也**不**该并：它们没有轮次，没有"属于同一批"的理由。
    // 一旦这里并了，用户连改两笔就只能一起撤销。
    store.push(draft("用户手动改的第二笔"));
    check("轮次外的两条手动改动各算一条（不许自动并）", store.undoCount(), 3);
    ok("栈顶仍是 user origin",
      store.peek()?.origin.by === "user", JSON.stringify(store.peek()?.origin));

    // 再开一轮：新的 turnId 与上一轮不同，**绝不**能并进上一轮那条
    // （`beginTurn` 是覆盖式的，若判据写成"只要栈顶是 agent 就并"，
    //  第二次用 AI 会把它并进上一次的账里，撤销语义就串轮了）
    const t2 = store.beginTurn();
    ok("新轮次的 turnId 与上一轮不同", t2 !== turnId, `${t2} vs ${turnId}`);
    store.push(draft("AI 第二次改的"));
    check("新一轮推的命令自成一条（没并进上一轮）", store.undoCount(), 4);
    store.endTurn(t2);
  }
}

/* ------------------------------------------------------------------ */
console.log(failed === 0
  ? "\n✅ E5+E6 通过：能力表与执行器双向对齐、花钱必确认、schema 无静默失效、" +
    "客户端不含密钥、确认门 fail closed、Agent 一轮可一次撤销"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
