/**
 * prompt.ts — 把能力表 + 时间轴快照拼成**模型能读的一段话**（批次 E6）
 *
 * ## 谁在拼提示词：客户端，而且只有客户端
 *
 * 后端 `agent_proxy.py` **不拼**实质内容 —— 它把收到的东西放进一个薄壳里
 * 交给模型。真正决定"模型看到什么"的是本文件（经由 `api.agentTurn`）。
 * 这么切的理由：能力表的唯一事实来源在客户端（`capability.ts`，
 * 那里还带着 `verify-agent.ts` 的交叉校验），时间轴快照的唯一事实来源
 * 也在客户端（界面内存）。后端再抄一份 = 两边迟早不一致。
 *
 * 后端仍负责的是**协议外壳**（"只能回一个 JSON 对象"、字段名、长度上限），
 * 它必须知道这些，因为它要解析。所以契约是**两端共同持有**的：
 * `PROMPT_CONTRACT_VERSION` 在这里，`AGENT_CONTRACT_VERSION` 在
 * `agent_proxy.py`，由 `GET /v2/agent/protocol` 暴露、`verify-agent.ts` 比对。
 *
 * ## 时间轴那一段**不再自己渲染一遍**
 *
 * 用 `describeTimeline.toPromptText(page)`。理由写在那个文件里：
 * 每行开头是 id 而不是 order，是防止"模型抄错 order 改错镜头且不报错"的
 * 关键设计。这里再写一个渲染器 = 把那个设计复制一份，两边迟早不一致，
 * 而不一致的那天改错的是**用户的项目**。
 */

import type { AgentCapability } from "./capability";
import { exportCapabilities } from "./capability";
import type { TimelinePage } from "./describeTimeline";
import { toPromptText } from "./describeTimeline";

/**
 * 把时间轴快照渲染成给模型看的那段文本。
 *
 * 只是 `toPromptText` 的一层薄包装 —— 存在的理由是**让"渲染器只有一个"
 * 这件事在类型层面成立**：调用方（`runAgent`）拿不到别的方式拼时间轴，
 * 也就不会有人再手写第三个渲染器。
 */
export function renderTimelineForPrompt(page: TimelinePage): string {
  return toPromptText(page);
}

/** 提示词契约版本。**改提示词格式/字段名时必须 +1**，两端各存一份，
 *  由 `verify-agent.ts` 比对（见文件头"两份提示词会漂移"）。
 *
 *  ⚠️ⓘ 本文件与后端 `_SYSTEM_HEAD` 一起，是**按当前默认模型
 *  （`settings.llm_model` = gemini-3.6-flash，flash 档）的脾气写的**：
 *  正因为它是 flash 档、没有原生 JSON mode，才需要把"只回一个 JSON 对象"
 *  翻来覆去写进提示词、并在 `protocol.ts` 里容错剥围栏。
 *  **换到指令跟随更强 / 有原生 JSON mode 的模型时，应当回头简化这里**
 *  （提示词可以变短、容错层级可以降），而不是把旧提示词原样套上去 ——
 *  旧提示词里的"不要解释、不要 Markdown"对强模型是纯噪音，却会稀释
 *  真正的重点（用 id 不用 order）。换模型时同步看一眼 `protocol.ts` 的
 *  容错范围是否还该这么宽。 */
export const PROMPT_CONTRACT_VERSION = 3;

/** 之前几轮：[用户说了什么, 模型回了什么]。**不含本轮**。
 *  ⚠️ 历史与"当前时间轴"**不在这里拼** —— 它们在 `agent_proxy.build_system_prompt`
 *  里拼。本文件只负责把**能力表**和**时间轴快照**渲染出来（两者的事实来源都在
 *  客户端），发过去让后端放进它那个外壳里。见下方 `buildWirePayload`。 */
export interface PromptTurnContext {
  /** 用户这一句 */
  text: string;
  /**
   * 时间轴快照（**已经渲染好的文本**，见文件头）。
   *
   * ⚠️ `buildTurnUser` **不读这个字段**（它只回 `text`）—— 时间轴是通过
   * `callModel({ timelineText })` 单独发给后端的。保留在类型里是因为
   * `buildPromptPreview` 要按同一份上下文渲染"模型看到了什么"的预览。
   * 于是它标成可选：让 `buildTurnUser` 的调用方**不必**为了填一个自己不
   * 用的字段去渲染一遍一千镜头的快照（那正是 runAgent 以前在做的事）。
   */
  timelineText?: string;
  /** 之前几轮：[用户说了什么, 模型回了什么]。**不含本轮** */
  history?: { role: "user" | "assistant"; text: string }[];
}

/**
 * 渲染能力表那一段。
 *
 * `params` 直接 `JSON.stringify` —— **不要"美化"成自然语言**。
 * 美化的那天，能力表就在两边各有一份"人话版本"，而模型看到的是哪一份、
 * 与 `dispatch` 实际校验的那份是否一致，没人能说清。
 * 这里唯一的取舍是**缩进**：缩进到 `JSON.stringify` 看起来像被格式化过，
 * 反而让模型更爱抄错（实测它会把缩进当结构），所以用紧凑形态。
 */
export function renderCapabilityTable(
  caps: readonly AgentCapability[],
): string {
  const exported = exportCapabilities(caps);
  const lines: string[] = ["【能力表】"];
  for (const c of exported) {
    lines.push(c.costly ? `- ${c.id}  ⚠️花钱/不可逆，执行前必须用户确认` : `- ${c.id}`);
    if (c.desc) lines.push(`    说明：${c.desc}`);
    lines.push(`    参数：${JSON.stringify(c.params)}`);
  }
  return lines.join("\n");
}

/**
 * 拼给模型的**用户轮**内容。
 *
 * ⚠️ 这里**只有用户说的那句话**（外加可选的重试提示）。时间轴、项目 id、
 * 历史对话、"按输出格式输出"这句收尾，**全部由后端 `build_system_prompt`
 * 拼**。早先的版本两边各拼一份，结果是模型同一段话看到两遍、
 * 两遍还不完全一样（客户端这份没有后端的 schema 说明），
 * 而"模型看到的到底是哪一份"没人说得清 —— 这正是本文件头说的漂移。
 *
 * 切法：**内容的事实来源在客户端（能力表、时间轴快照），外壳的事实来源在后端**
 * （字段名、长度上限、收尾指令，因为它负责解析）。所以这里只做前者。
 */
export function buildTurnUser(
  ctx: PromptTurnContext,
  projectId: string | null,
): string {
  void projectId; // 项目 id 由后端拼进时间轴那一段（它已收到 project_id 字段）
  return ctx.text.trim();
}

/**
 * 拼**给 UI 看的预览**（能力表 + 用户轮）。
 *
 * ⚠️ 它**不是后端实际用的那份 system** —— 那份是 `agent_proxy._SYSTEM_HEAD`
 * 加同一张能力表，跑在服务器上。这里能预览到的只有"客户端贡献了什么"
 * （能力表 + 时间轴 + 这句话）。要"一字不差地看模型收到什么"，
 * 只能看后端日志；这里的目标是**排障时不用上服务器就能判断
 * 能力表是不是发对了、快照是不是这一版**。
 *
 * 返回 `{ system, user }` 两段而不是一个字符串：与 `LLMProvider.complete`
 * 的两个位置参数一一对应，将来若要在客户端直连调试也省一次拆包。
 */
export interface PromptPreview {
  /** 客户端贡献给 system 的那部分（能力表）。**不含**后端的 `_SYSTEM_HEAD` */
  systemPreview: string;
  /** 用户轮原文 —— 与发给后端 `text` 字段的内容完全一致 */
  user: string;
}

export function buildPromptPreview(
  ctx: PromptTurnContext,
  caps: readonly AgentCapability[],
  projectId: string | null,
): PromptPreview {
  const systemPreview = [
    `【契约版本】${PROMPT_CONTRACT_VERSION}`,
    renderCapabilityTable(caps),
  ].join("\n");
  return { systemPreview, user: buildTurnUser(ctx, projectId) };
}

/**
 * 给 UI 显示的**一句话摘要**：这一轮 AI 看到了多少镜头、能做什么。
 *
 * 存在的理由是"AI 到底看到了什么"必须是用户可见的（文件头第 1 条）。
 * 界面上只显示这一行，点开才看全文。
 */
export function describePromptScope(
  page: TimelinePage,
  caps: readonly AgentCapability[],
): string {
  const writable = caps.filter((c) => c.kind !== "read").length;
  const costly = caps.filter((c) => c.costly).length;
  return (
    `本次 AI 能看到第 ${page.offset + 1}–${page.offset + page.rows.length} 个镜头` +
    `（共 ${page.total} 个），可使用 ${writable} 项修改能力` +
    (costly ? `，其中 ${costly} 项会花钱` : "")
  );
}
