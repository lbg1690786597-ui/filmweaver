/**
 * runAgent.ts — Agent 的一轮完整流程（批次 E6 的收口）
 *
 * ## 一轮是什么
 *
 * ```
 *   beginTurn()  ← 从这里开始，所有 dispatch 出来的命令并进同一轮（E4）
 *       ↓
 *   把能力表 + 时间轴快照发给后端 ──→ 模型
 *       ↓                              ↓
 *   校验参数 → dry-run → 确认门 → dispatch（在本进程执行，进同一个撤销栈）
 *       ↓
 *     模型说 done 了吗？没说就带着"刚才做了什么"再来一轮
 *       ↓
 *   endTurn()    ← **必须走 finally**
 * ```
 *
 * ## 🔴 三个"不做"（每一条都对应一个曾经被讨论掉的方案）
 *
 * **① 不把 `EditCommand` 发给后端。** 发的是意图（`{id, args}`），
 * 序列化的是意图不是命令 —— 见 `protocol.ts` 文件头与 PLAN §2.6.1。
 *
 * **② 不让后端改项目。** 后端只调模型、回 JSON。改项目**只发生在这一处**，
 * 走的是和用户手点完全相同的 `pushCommand`。两处都能改项目 = 撤销栈会有
 * 缺口，"AI 改的撤不掉"就是那么来的。
 *
 * **③ 不把 `endTurn` 放在成功路径上。** 中途抛异常而没关轮次，
 * 用户接着手动改一笔会被**并进 AI 那一轮** —— 他按一次 Ctrl+Z，
 * 连自己刚做的操作一起没了。这正是 `command.ts` 那段注释警告的场景。
 *
 * ## ⚠️ 确认门在这里，不在 `dispatch` 里
 *
 * `dispatch` 只认"这一次调用有没有被 `confirmed` 放行"。**问用户**是 UI 的事，
 * 所以本模块收一个 `confirm` 回调、把它拿到的结果原样转给 dispatch。
 * 把确认框做进 `dispatch` 会让 AI 与批处理场景下弹出一堆模态框，
 * 而在 `dispatch` 里给个默认"自动同意"更糟 —— 那是静默花钱。
 *
 * ## ⚠️ 轮次上限不是"防呆"，是**成本闸**
 *
 * 每转一圈都是一次真实的 LLM 调用（花钱）。模型偶尔会陷入"再调一次
 * describe_timeline 看看"的循环，所以 `maxTurns` 是必需的；
 * 撞上限时**明确告诉用户**"已经做了这些、还没做完"，不静默停止 ——
 * 静默停止会让用户以为 AI 改完了。
 */

import { CAPABILITIES } from "./capability";
import { exportCapabilities } from "./capability";
import { describeTimeline } from "./describeTimeline";
import type { TimelinePage, TimelineShotView } from "./describeTimeline";
import { buildTurnUser, renderTimelineForPrompt, PROMPT_CONTRACT_VERSION } from "./prompt";
import { parseAgentReply, complaintsForModel, withDefaults } from "./protocol";
import type { AgentCommandIntent, ParsedAgentReply } from "./protocol";
import { dryRun } from "./dryRun";
import { dispatch, NeedConfirm, DispatchError } from "./dispatch";
import type { AgentHost } from "./dispatch";
import type { CommandScope } from "../command";

/** 一轮里最多几次"再想想"。每次都是一次真实的 LLM 调用，所以数字要小。
 *  4 次够走完"看时间轴 → 改一批 → 发现要翻页 → 再改一批 → 收尾"。 */
export const MAX_TURNS = 4;

/** 模型在**同一轮**里连着调 `describe_timeline` 的次数上限。
 *  它不花 LLM 的钱（本地渲染），但无限翻页说明模型在瞎转，要截断。 */
export const MAX_DESCRIBE_CALLS = 3;

/** 每页给模型看多少个镜头。**小于等于 `MAX_LIMIT`**（那个是硬上限）。 */
const PAGE_LIMIT = 60;

/** 回给后端的**之前对话**保留几轮（一问一答算一轮）。
 *  后端 `agent_proxy.run_turn` 自己也只取最后 6 条，这里再截一次是
 *  为了别把整段会话塞进请求体 —— 双方都截，取更小的那个生效。 */
const HISTORY_TURNS = 6;

export type AgentRunStatus =
  | "done"          // 模型说做完了，或这一轮没有任何事可做
  | "incomplete"    // 撞上轮次上限，还有没做完的
  | "failed"        // 连模型都叫不通 / 回复完全无法解析
  | "cancelled";    // 用户在确认框上点了"取消"

export interface AgentStep {
  capabilityId: string;
  say: string;
  ok: boolean;
  /** 不顺但是执行了（如"这会花钱"） */
  warnings: string[];
  /** 没执行的原因（`ok === false` 时必有） */
  detail?: string;
  merged?: boolean;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  /** 给用户看的话。**最后一句模型回复**，或本地生成的一句状态说明 */
  reply: string;
  /** 本轮改动了哪些镜头/素材（**合并去重**，与 E4 台账口径一致） */
  affected: CommandScope;
  steps: AgentStep[];
  warnings: string[];
  /** 这一轮的命令栈轮次 id。用于"撤销这一整轮" */
  turnId: string | null;
  /** 实际用掉的模型轮数（诊断 + 提示词调优用） */
  turns: number;
}

/** 让用户确认一次花钱/破坏性操作。返回是否同意。
 *
 *  ⚠️ 实现里**必须**把 `confirmText` 显示出来 —— 那是能力表里写好的
 *  "要付什么代价"，不是一句"确认吗？"。 */
export type ConfirmFn = (req: {
  capabilityId: string;
  confirmText: string;
  /** dry-run 算出的人话摘要，如「移动镜头，另有 7 个镜头会被顺移」 */
  summary: string;
  /** 会动到哪些镜头（uid） */
  affected: CommandScope;
}) => Promise<boolean> | boolean;

export interface RunAgentOptions {
  /** 用户这一句 */
  text: string;
  /** 调模型（由 App 注入，指向 `api.agentTurn`）。
   *  **注入而不是直接 import `api.ts`**：本模块要能在 node 下被
   *  `verify-agent.ts` 用假模型跑完整流程，直接 import 会拉进 `localStorage`。 */
  callModel: (body: {
    text: string;
    timelineText: string;
    capabilities: ReturnType<typeof exportCapabilities>;
    projectId: string | null;
    history: { role: "user" | "assistant"; text: string }[];
  }) => Promise<{
    reply: string;
    done: boolean;
    commands: { id: string; args: Record<string, unknown> }[];
    dropped?: string[];
  }>;
  /** 问用户。**不传 = 一次都不许执行花钱/破坏性能力**（fail closed）。
   *  默认成"自动同意"是绝对不能做的：那等于把钱花在用户没看见的地方。 */
  confirm?: ConfirmFn;
  /** 之前几轮的对话（不含本轮），用于"把第 3 场再改回去"这种follow-up */
  history?: { role: "user" | "assistant"; text: string }[];
  maxTurns?: number;
}

/** 把所有已执行的命令的影响面并起来。**不复用台账**（那是命令栈的产物），
 *  因为"还没入栈就被 dry-run 拦下"的命令也该算进"AI 试着改了什么"。 */
function mergeScope(a: CommandScope, b: CommandScope): CommandScope {
  const shots = new Set([...(a.shots ?? []), ...(b.shots ?? [])]);
  const assets = new Set([...(a.assets ?? []), ...(b.assets ?? [])]);
  const out: CommandScope = {};
  if (shots.size) out.shots = [...shots];
  if (assets.size) out.assets = [...assets];
  return out;
}

/**
 * 跑一轮。**不抛异常**（除了 host 自己抛的编程错误）：
 * 模型不通、解析失败、命令被拒，全是 `status` 的取值。
 * 让调用方去 `try/catch` 一个"AI 没听懂"是没道理的。
 */
export async function runAgent(
  host: AgentHost,
  opts: RunAgentOptions,
): Promise<AgentRunResult> {
  const warnings: string[] = [];
  const steps: AgentStep[] = [];
  let affected: CommandScope = {};
  let reply = "";
  let turns = 0;
  let scopePage: TimelinePage | null = null;

  const maxTurns = Math.max(1, opts.maxTurns ?? MAX_TURNS);
  const history = [...(opts.history ?? [])];
  /** 传给后端的**之前几轮**对话。
   *
   *  ⚠️ 不能用下面那个会增长的 `history`：它在每次循环末尾 `push` 本轮
   *  自己的问答，第二轮起就会把"本轮已经发过的话"再当历史发一遍 ——
   *  模型看到自己刚说的话被标记成"之前的对话"，会误以为用户已经确认过它。
   *  这里冻结一份快照，整个 run 期间不变。
   *
   *  后端**确实消费** history（`agent_proxy.run_turn` 取最后 6 条折进
   *  `【之前的对话】`），之前恒传 `[]` 等于把"把第 3 场再改回去"这类
   *  指代上一轮的 follow-up 能力白扔了。 */
  const priorHistory = history.slice(-HISTORY_TURNS);

  // ⚠️ `host.projectId()` 在没打开项目时**抛错**（host.ts 的设计）。
  // 这里提前接住：没打开项目时连模型都不该叫（叫了也只能得到"我改不了"）。
  let projectId: string | null = null;
  try {
    projectId = host.projectId();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    host.say(msg);
    return {
      status: "failed", reply: msg, affected: {}, steps: [], warnings,
      turnId: null, turns: 0,
    };
  }

  // ── beginTurn：从这里开始，dispatch 出来的命令并进同一轮（E4）─────────────
  const turnId = host.beginTurn();
  try {
    /** 模型要求重看时间轴时的**翻页位置**。默认 0（从头看）。
     *  ⚠️ 不是"多渲染一份塞进去"：`describeTimeline` 的 offset 就是分页参数，
     *  模型要看第 61–120 个镜头时，该做的是**把下一轮的快照换成那一页**，
     *  而不是两份快照同时塞进去 —— 两份叠着，模型指着哪个 id 说话就说不清了。 */
    let pageOffset = 0;
    let describeCalls = 0;
    /** 上一轮被拒的原因，附到下一轮的用户话里（回给模型自己修）。 */
    let retryHint = "";

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      turns = turn;

      // 每轮**重新取快照**：上一轮的命令已经生效，镜头 id / order 可能都变了。
      // 用第一轮那份会让模型基于过时的 order 下第二道命令（§12.9.4 那个坑）。
      // 分页位置（`pageOffset`）由模型上一轮的 `describe_timeline` 决定。
      scopePage = describeTimeline(
        { id: projectId, shots: host.shots() as readonly TimelineShotView[] },
        { limit: PAGE_LIMIT, offset: pageOffset },
      );

      // ⚠️ 时间轴**只渲染一次**。`buildTurnUser` 只回用户那句话（时间轴由后端
      // 拼，见 prompt.ts 的切法），所以这里以前顺手传进去的
      // `timelineText: renderTimelineForPrompt(scopePage)` 是**渲染完就扔**——
      // 一千个镜头的一页白白 JSON 化两遍。传 `text` 就够。
      const user = buildTurnUser(
        {
          // 重试提示**只接在用户这句话前面**，不单独走字段：后端把它
          // 连同这句话一起放进 `【用户这次说】`，模型看到的是"用户这么说，
          // 但上一轮的回复有问题" —— 单独成段的系统级插话会让它以为
          // 这是新指令而不是纠正。
          text: retryHint ? `${retryHint}\n\n${opts.text}` : opts.text,
        },
        projectId,
      );

      let raw: { reply: string; done: boolean;
                 commands: { id: string; args: Record<string, unknown> }[];
                 dropped?: string[] };
      try {
        raw = await opts.callModel({
          // ⚠️ 时间轴**只走 `timeline_text` 这一个字段**，不混进 `text`。
          // 早先的版本把它拼进 user 文本、这里传空串，后端又按 `timeline_text`
          // 拼了一遍 —— 模型在同一段 prompt 里看到两份时间轴（一份带标题一份不带），
          // 而"它照着哪份抄 id"完全看运气。现在只有后端拼、只拼一次。
          text: user,
          timelineText: renderTimelineForPrompt(scopePage),
          capabilities: exportCapabilities(CAPABILITIES),
          projectId,
          history: priorHistory,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const text = `AI 没接上（${msg}）。你手动改的这一轮不受影响。`;
        host.say(text);
        return { status: "failed", reply: text, affected, steps, warnings, turnId, turns };
      }

      // 后端只回 `{reply, done, commands}`；把它**重新序列化成协议文本**再走
      // 同一个解析器 —— 这样"模型直接回 JSON 文本"与"后端帮我们把 JSON 解析好"
      // 两条路**共用同一套校验**，不会出现"哪条路的参数没校验"。
      const parsed: ParsedAgentReply = parseAgentReply(JSON.stringify({
        reply: raw.reply, done: raw.done, commands: raw.commands ?? [],
      }));
      for (const d of raw.dropped ?? []) parsed.complaints.push(d);
      warnings.push(...parsed.warnings);
      if (parsed.reply) reply = parsed.reply;

      // 解析层就崩了（连 JSON 都没有）：值得**原地重试一次**，模型偶尔会先
      // 唠一句再给 JSON。第二次还不行就交给用户，不要无限重试。
      if (parsed.hardError) {
        warnings.push(parsed.hardError);
        if (turn === 1) {
          retryHint = "【上一次你的回复无法解析】请只输出那一个 JSON 对象，不要任何其它文字。";
          continue;
        }
        const text = "AI 的回复没能解析成操作，已停止。你可以换个说法再试一次。";
        host.say(text);
        return { status: "failed", reply: text, affected, steps, warnings, turnId, turns };
      }

      // 有没通过校验的命令：**执行通过的那些**，把失败的原话喂回给模型，
      // 让它下一轮修正（这是"让模型自己修"而不是"让用户读参数错误"）。
      if (parsed.complaints.length) {
        warnings.push(...parsed.complaints);
      }

      // ── 执行这一轮的命令 ────────────────────────────────────────────────
      for (const intent of parsed.intents) {
        // `describe_timeline` 是**本地**能力（快照就在内存里），不当成
        // 一次 dispatch 走网络 —— 见 dispatch.ts 里那句"由调用方在 runAgent 里处理"。
        if (intent.capabilityId === "describe_timeline") {
          if (describeCalls >= MAX_DESCRIBE_CALLS) {
            warnings.push("模型反复要求重看时间轴，已忽略（避免空转）");
            continue;
          }
          describeCalls += 1;
          // 把**下一轮**的快照挪到它要的那一页。参数名与 `describeTimeline`
          // 自己的选项一致（offset/limit），所以这里不做翻译，直接读。
          const argOffset = Number(intent.args?.offset);
          const argLimit = Number(intent.args?.limit);
          const nextOffset = Number.isFinite(argOffset) && argOffset >= 0
            ? Math.floor(argOffset)
            : 0;
          pageOffset = Math.min(nextOffset, Math.max(0, scopePage.total - 1));
          if (Number.isFinite(argLimit) && argLimit > 0) {
            // limit 由本轮固定（`PAGE_LIMIT`）：允许模型改它等于允许它
            // 一次要回全片，输入长度上限会在后端变成一条 422 —— 与其让它
            // 撞墙，不如这里就不给这个口子，并在回执里说明实际给了多少。
            warnings.push(
              `已按你的要求跳到第 ${pageOffset + 1} 个镜头起（每页固定 ${PAGE_LIMIT} 个）`,
            );
          }
          continue;
        }
        await executeOne(intent, host, opts, steps, warnings);
        const last = steps[steps.length - 1];
        if (last?.ok) affected = mergeScope(affected, lastScope(last));
      }

      if (parsed.done && !parsed.complaints.length) {
        if (!reply) reply = steps.length ? "已按你说的改好了。" : "没有需要改动的地方。";
        host.say(reply);
        return { status: "done", reply, affected, steps, warnings, turnId, turns };
      }

      // 还没完：把这一轮的对话与结果带回下一轮
      history.push({ role: "user", text: opts.text });
      history.push({
        role: "assistant",
        text: [
          parsed.reply || "(无说明)",
          steps.length
            ? "已执行：" + steps.filter((s) => s.ok).map((s) => s.say).join("；")
            : "",
        ].filter(Boolean).join(" "),
      });
      retryHint = complaintsForModel(parsed);
    }

    // 撞上限
    const text = reply ||
      `已经处理了 ${steps.filter((s) => s.ok).length} 处改动，但还没做完。可以再说一句让我继续。`;
    host.say(text);
    warnings.push(`达到单轮上限（${maxTurns} 次），仍有未完成的部分`);
    return { status: "incomplete", reply: text, affected, steps, warnings, turnId, turns };
  } finally {
    // ⚠️ **必须**。漏了它，用户接着的手动操作会并进 AI 这一轮，
    // 一次 Ctrl+Z 连自己刚做的改动一起撤掉（见文件头"三个不做"之③）。
    host.endTurn(turnId);
  }
}

/** 暂存"这条命令的影响面"，供外层并入 `affected`。
 *  用 WeakMap 而不是在 `AgentStep` 上加字段：`AgentStep` 是**给 UI 的**形状，
 *  把内部账目塞进去会让 UI 层不小心依赖它。 */
const stepScopes = new WeakMap<AgentStep, CommandScope>();
function lastScope(step: AgentStep): CommandScope {
  return stepScopes.get(step) ?? {};
}

/** 执行一条已通过解析/校验的意图。**所有失败都写进 `steps`，不抛。** */
async function executeOne(
  intent: AgentCommandIntent,
  host: AgentHost,
  opts: RunAgentOptions,
  steps: AgentStep[],
  warnings: string[],
): Promise<void> {
  const args = withDefaults(intent);
  const step: AgentStep = {
    capabilityId: args.capabilityId,
    say: "",
    ok: false,
    warnings: [],
  };
  steps.push(step);

  // ── dry-run：先算一遍"会动到什么"，不落库 ────────────────────────────────
  // ⚠️ 每次现取 shots（不是复用第一轮的）：前一条命令可能刚改过 order，
  // 用旧快照算出来的影响面是错的。
  let dry;
  try {
    dry = dryRun({
      capabilityId: args.capabilityId,
      args: args.args,
      shots: host.shots() as readonly TimelineShotView[],
    });
  } catch (e) {
    step.detail = `试运行失败：${e instanceof Error ? e.message : String(e)}`;
    warnings.push(`${args.capabilityId}：${step.detail}`);
    return;
  }
  step.warnings = [...dry.warnings];
  if (!dry.ok) {
    // dry-run 拦下的**不执行**。它的 blockers 文案里带着补救动作
    // （"请重新调 describe_timeline 取最新的 id"），正好喂回模型。
    step.detail = dry.blockers.join("；");
    step.say = dry.summary;
    warnings.push(`${args.capabilityId} 未执行：${step.detail}`);
    stepScopes.set(step, dry.affected);
    return;
  }

  // ── 确认门 ────────────────────────────────────────────────────────────
  const cap = CAPABILITIES.find((c) => c.id === args.capabilityId);
  const needConfirm = cap ? (cap.costly === true || cap.destructive === true) : false;
  if (needConfirm) {
    // ⚠️ 没给 confirm 回调 = **不放行**（fail closed），不是"默认同意"。
    if (!opts.confirm) {
      step.detail = "这个操作会花钱或有不可逆后果，但当前没有可用的确认入口，已跳过。";
      warnings.push(`${args.capabilityId}：${step.detail}`);
      return;
    }
    const agreed = await opts.confirm({
      capabilityId: args.capabilityId,
      confirmText: cap?.confirmText ?? "这个操作会产生不可逆的后果或花费额度，确认执行吗？",
      summary: dry.summary,
      affected: dry.affected,
    });
    if (!agreed) {
      step.detail = "用户取消了这一步";
      step.say = `已跳过：${dry.summary}`;
      warnings.push(`${args.capabilityId}：用户取消`);
      return;
    }
  }

  // ── 执行 ──────────────────────────────────────────────────────────────
  try {
    const res = await dispatch(args.capabilityId, args.args, host, {
      confirmed: [args.capabilityId],
    });
    step.ok = true;
    step.say = res.say;
    step.merged = res.merged;
    stepScopes.set(step, dry.affected);
    if (res.merged) {
      step.warnings.push("已并入这一轮的前一次修改（撤销时一起退）");
    }
  } catch (e) {
    if (e instanceof NeedConfirm) {
      // dispatch 的门比这里更严（比如将来确认粒度变了）—— 以它为准
      step.detail = e.message;
      step.say = e.confirmText;
    } else if (e instanceof DispatchError) {
      step.detail = e.message;
      if (e.retryable) step.warnings.push("这个错误可能重试就好了");
    } else {
      step.detail = e instanceof Error ? e.message : String(e);
    }
    warnings.push(`${args.capabilityId} 执行失败：${step.detail}`);
  }
}

/** 当前提示词契约版本（与后端 `agent_proxy.AGENT_CONTRACT_VERSION` 比对用）。
 *  `verify-agent.ts` 拿它去问 `GET /v2/agent/protocol`。 */
export const AGENT_PROMPT_CONTRACT_VERSION = PROMPT_CONTRACT_VERSION;

/** 给 UI 用：一句话说清"这一轮 AI 试着改了什么"。 */
export function summarizeRun(r: AgentRunResult): string {
  const ok = r.steps.filter((s) => s.ok).length;
  const bad = r.steps.length - ok;
  const shots = r.affected.shots?.length ?? 0;
  const parts: string[] = [];
  parts.push(ok ? `成功 ${ok} 处` : "没有成功的改动");
  if (bad) parts.push(`失败/跳过 ${bad} 处`);
  if (shots) parts.push(`涉及 ${shots} 个镜头`);
  return parts.join("，");
}
