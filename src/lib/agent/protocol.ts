/**
 * protocol.ts — Agent 的**回复协议**：把模型回的一段文本解析成命令意图（批次 E6）
 *
 * ## 协议长什么样
 *
 * 后端 `agent_proxy.py` 拼的系统提示词要求模型**只回一个 JSON 对象**：
 *
 * ```json
 * { "reply": "已把第 3 场的两个镜头换序", "done": true,
 *   "commands": [ { "id": "patch_shot_timeline", "args": { … } } ] }
 * ```
 *
 * 这里只做**三件事**：剥围栏 → 取 JSON → 逐条校验。
 *
 * ## 🔴 一条边界：本文件不认识 `EditCommand`
 *
 * 传回来的是**意图**（"把这个镜头和那个换序"），执行是客户端的事
 * （`dispatch.ts` 在本进程内跑，进同一个撤销栈、走同一套逆操作）。
 * 这一点是 PLAN §2.6.1 结论 2 明确写过的：命令保持函数式、**不序列化**；
 * 序列化的只是意图。要是哪天有人让后端直接回 `EditCommand`，
 * 逆操作闭包（`unrun`）就没法传过来，Agent 的改动会变成撤不掉的 ——
 * `verify-agent.ts` 有一条断言盯着这里。
 *
 * ## 为什么解析要"宽容"，而校验要"苛刻"
 *
 * 实测：模型十次里有七八次会老实回纯 JSON，剩下的会多一句"好的，我来处理："
 * 或包一层 ```json。**因为这些格式问题丢掉一整轮是浪费**，所以剥围栏、
 * 取 `{…}` 跨度是必要的容错。
 *
 * 但**参数**必须苛刻：`at_sec` 传成字符串 `"3"` 在 JS 里能做很多意外的事，
 * 而它最终会变成一个"改错镜头且不报错"的操作。所以每一条都过
 * `schema.ts` 的 `validateArgs`，错的就是错的，**不猜、不兜底、不"尽力而为"**。
 *
 * ## ⚠️ 宁可少执行，不要猜着执行
 *
 * 一条命令解析失败时，**只丢这一条**并记进 `complaints`，不放弃整轮 ——
 * 但也绝不"修一修再用"。原因很直接：模型传了个非法值时，
 * 我们**无法知道它本来想干什么**；猜出来的那个值会真的写进用户的项目，
 * 而用户看到的只是一句"AI 改了"。
 */

import type { JsonSchema } from "./schema";
import { applyDefaults, validateArgs, unknownKeywords } from "./schema";
import { CAPABILITIES, findCapability } from "./capability";

/** 模型提出的一条命令**意图**。`args` 已过 `applyDefaults`，但**尚未**校验通过 ——
 *  校验结果在 `complaints` 里，`ok` 为假时调用方不许执行。 */
export interface AgentCommandIntent {
  capabilityId: string;
  args: Record<string, unknown>;
}

export type AgentCommandOutcome = "ok" | "unknown-capability" | "bad-args";

export interface AgentCommandReport {
  index: number;
  capabilityId: string;
  outcome: AgentCommandOutcome;
  /** 人话原因。`outcome !== "ok"` 时必须有 —— 空原因等于静默失败 */
  detail?: string;
}

export interface ParsedAgentReply {
  /** 给用户看的那句话（模型写的）。可能为空串 */
  reply: string;
  /** 这一轮到此为止了吗。模型没说就按 `true`（保守：别让它无限自转） */
  done: boolean;
  /** 可以执行的意图（**只含 outcome === "ok" 的**） */
  intents: AgentCommandIntent[];
  /** 被拒掉的条目及原因。**不静默**：面板要把它们显示出来 */
  complaints: string[];
  /** 逐条结果（含通过的），排障/日志用 */
  reports: AgentCommandReport[];
  /** 解析层就失败了（连 JSON 都没有）。此时 `intents` 必为空 */
  hardError?: string;
  /** 不阻塞的提醒（如"模型套了 Markdown 围栏"） */
  warnings: string[];
  /** 模型是否老实按格式回的（没围栏、没多余 prose）。给提示词调优当指标 */
  clean: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 取 JSON
// ─────────────────────────────────────────────────────────────────────────────

/** 剥掉 Markdown 围栏。返回剥后的文本。**只剥最外层一层**，不递归 ——
 *  递归剥会把 JSON 字符串里的反引号内容也当成围栏。 */
export function stripFence(raw: string): string {
  let t = (raw ?? "").trim();
  if (!t.startsWith("```")) return t;
  // 去掉首行的 ``` 或 ```json
  const nl = t.indexOf("\n");
  if (nl < 0) return t.slice(3).trim();
  t = t.slice(nl + 1);
  // 去掉末尾的一行 ```
  const end = t.lastIndexOf("```");
  if (end >= 0) t = t.slice(0, end);
  return t.trim();
}

/**
 * 从一段文本里取出**第一个平衡的 JSON 对象**。
 *
 * 为什么不是 `find("{") … rfind("}")`（后端 `_parse_json` 的写法）：
 * 那种写法在"模型给了 JSON 又补了一句含花括号的解释"时会**多取**，
 * 结果 `JSON.parse` 炸掉 —— 一整轮白费。这里数括号深度，
 * 且**跳过字符串内部的括号**（提示词里常有 `{"a":"}"}` 这种内容）。
 *
 * 找不到返回 `null`。
 */
export function extractJsonObject(raw: string): string | null {
  const t = raw ?? "";
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i += 1) {
    const ch = t[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  // 括号没闭合：把剩下的都给 JSON.parse 去报错，比在这里编一个错误更好定位
  return t.slice(start);
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 逐条校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验一条已经解析出来的意图。**这是执行前的最后一道闸**。
 *
 * `dispatch()` 自己也会看一眼能力表，但**不能只靠它**：
 * dispatch 是在"已经开始执行"之后才跑的，而我们要在**批量执行之前**就知道
 * 有哪些条会失败 —— 否则一轮 5 条命令改到第 3 条才发现参数不对，
 * 前两条已经写进用户项目了，用户看到的是一次**半途而废的修改**。
 *
 * 返回 `null` 表示通过。
 */
export function validateIntent(intent: AgentCommandIntent): string | null {
  const cap = findCapability(intent.capabilityId);
  if (!cap) {
    return `没有名为 ${intent.capabilityId} 的能力（可能它已被删除或从未存在）`;
  }
  const errs = validateArgs(cap.params as JsonSchema, intent.args);
  if (errs.length) {
    // 只报前三条：一条命令传错 8 个参数时，全列出来反而看不清主因
    const head = errs.slice(0, 3).map((e) => `参数 ${e.path || "(根)"}：${e.msg}`);
    const more = errs.length > 3 ? `（另有 ${errs.length - 3} 处）` : "";
    return head.join("；") + more;
  }
  return null;
}

/** 把已校验通过的意图补上 schema 默认值。**必须在校验之后调**——
 *  先补默认值再校验，会让"模型没传必填字段"变成"补了个默认值所以通过"，
 *  而那种默认值几乎必然不是模型想表达的意思。 */
export function withDefaults(intent: AgentCommandIntent): AgentCommandIntent {
  const cap = findCapability(intent.capabilityId);
  if (!cap) return intent;
  return {
    capabilityId: intent.capabilityId,
    args: applyDefaults(cap.params as JsonSchema, intent.args),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 总入口
// ─────────────────────────────────────────────────────────────────────────────

/** 一条命令的 `why`（模型解释为什么改这个）是可选的，解析时丢掉 ——
 *  它只进日志，不进 `args`（进 args 会被 `validateArgs` 当成未知字段）。 */
function readCommands(raw: unknown): { items: unknown[]; err?: string } {
  if (raw === undefined || raw === null) return { items: [] };
  if (!Array.isArray(raw)) {
    return { items: [], err: `commands 不是数组（是 ${typeof raw}）` };
  }
  return { items: raw };
}

/**
 * 解析模型的回复。
 *
 * **不抛异常**：解析失败走 `hardError`，让调用方决定是重试、报错还是兜底说句话。
 * 这里的每一个失败路径都是"用户能看懂 + 调用方能行动"的：
 *  - `hardError`：没 JSON / JSON 语法错 → 值得**重试一次**（模型偶尔会跑偏）
 *  - `complaints`：某几条不合法 → **别重试**，模型重发大概率还是那几条；
 *    把通过的照常执行、把失败的告诉用户（或让模型看一遍 complaints 再调一次）
 */
export function parseAgentReply(raw: string): ParsedAgentReply {
  const warnings: string[] = [];
  const complaints: string[] = [];
  const reports: AgentCommandReport[] = [];
  const intents: AgentCommandIntent[] = [];

  const text = raw ?? "";
  let clean = true;
  const stripped = stripFence(text);
  if (stripped !== text.trim()) {
    clean = false;
    warnings.push("模型用了 Markdown 围栏（提示词里已禁止），已自动剥掉");
  }
  const span = extractJsonObject(stripped);
  if (!span) {
    return {
      reply: "", done: true, intents: [], complaints,
      reports, warnings, clean: false,
      hardError: "模型回复里没有找到 JSON 对象",
    };
  }
  if (span.trim() !== stripped.trim()) clean = false;

  let data: unknown;
  try {
    data = JSON.parse(span);
  } catch (e) {
    return {
      reply: "", done: true, intents: [], complaints,
      reports, warnings, clean: false,
      hardError: `模型回复里的 JSON 解析失败：${(e as Error).message}`,
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      reply: "", done: true, intents: [], complaints,
      reports, warnings, clean: false,
      hardError: "模型回复的顶层不是 JSON 对象",
    };
  }

  const obj = data as Record<string, unknown>;
  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  if (typeof obj.reply !== "string") {
    warnings.push("模型没给 reply 字段（给用户的那句话），界面上会没有说明");
  }
  // 模型明确说 done=false 才继续；其它任何值（缺字段、给字符串）都当 true。
  // 保守方向的选对了很重要：判成 false 会让 Agent 无限自转、反复烧额度。
  const done = obj.done === false ? false : true;

  const { items, err } = readCommands(obj.commands);
  if (err) complaints.push(err);

  items.forEach((item, i) => {
    const idx = i + 1;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      const detail = `第 ${idx} 条不是对象`;
      complaints.push(detail);
      reports.push({ index: idx, capabilityId: "", outcome: "bad-args", detail });
      return;
    }
    const it = item as Record<string, unknown>;
    const cid = it.id;
    if (typeof cid !== "string" || !cid.trim()) {
      const detail = `第 ${idx} 条没有 id，无法判断要调什么能力`;
      complaints.push(detail);
      reports.push({ index: idx, capabilityId: "", outcome: "bad-args", detail });
      return;
    }
    let args = it.args;
    if (args === undefined || args === null) args = {};
    if (typeof args !== "object" || Array.isArray(args)) {
      const detail = `第 ${idx} 条（${cid}）的 args 不是对象`;
      complaints.push(detail);
      reports.push({ index: idx, capabilityId: cid, outcome: "bad-args", detail });
      return;
    }

    const intent: AgentCommandIntent = {
      capabilityId: cid.trim(),
      // ⚠️ 这里**先不补默认值**：校验要看模型**实际给了什么**。
      // 补默认值放在 `withDefaults`，执行前调。
      args: { ...(args as Record<string, unknown>) },
    };
    const bad = validateIntent(intent);
    if (bad) {
      const outcome: AgentCommandOutcome = findCapability(intent.capabilityId)
        ? "bad-args"
        : "unknown-capability";
      complaints.push(`第 ${idx} 条（${intent.capabilityId}）：${bad}`);
      reports.push({ index: idx, capabilityId: intent.capabilityId, outcome, detail: bad });
      return;
    }
    intents.push(intent);
    reports.push({ index: idx, capabilityId: intent.capabilityId, outcome: "ok" });
  });

  if (complaints.length) clean = false;
  return { reply, done, intents, complaints, reports, warnings, clean };
}

/**
 * 把失败原因拼成**给模型看**的一段话（下一轮附在 user 里重新问）。
 *
 * 为什么不是拿去给用户看：用户看不懂"参数 at_sec 类型应为 number"，
 * 但模型看得懂，而且**它下一轮就能改对**。用户只看 `reply`。
 * 这是"让模型自己修"与"让用户读错误信息"之间的分界线。
 */
export function complaintsForModel(p: ParsedAgentReply): string {
  if (!p.complaints.length) return "";
  return [
    "【上一轮你的输出有问题，请只修正这些后重新输出完整 JSON】",
    ...p.complaints.map((c) => `- ${c}`),
  ].join("\n");
}

/**
 * 自检：本文件用到的能力表是否自洽。
 *
 * 给 `verify-agent.ts` 用，不参与运行期。查两件运行期看不出的事：
 *  1. 每条能力的 schema 里有没有**未知关键字**（`schema.ts` 会静默忽略它们，
 *     于是 `maximum` 写成 `max` 这种笔误不会当场炸，只会安静地不生效）；
 *  2. `unknown-capability` 这个分支是否真的可达（能力表不为空）。
 */
export function selfCheckSchemaKeywords(): { capabilityId: string; keywords: string[] }[] {
  const out: { capabilityId: string; keywords: string[] }[] = [];
  // 遍历**全量**清单（不是 readonlySkills 之类的子集）：只读能力同样会被模型调用，
  // schema 写错一样会静默失效。
  for (const c of CAPABILITIES) {
    const bad = unknownKeywords(c.params as JsonSchema);
    if (bad.length) out.push({ capabilityId: c.id, keywords: bad });
  }
  return out;
}
