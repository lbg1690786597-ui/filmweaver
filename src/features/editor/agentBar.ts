/**
 * agentBar.ts — 命令条里那段**纯逻辑**（批次 E6 的 UI 收口）
 *
 * ## 为什么把它从组件里拆出来
 *
 * `verify-agent.ts` 要能断言"确认框上给用户看的是能力表写的那句代价"、
 * "取消之后不执行也不进撤销栈"这类行为，而断言一个 React 组件的内部状态
 * 得先装 jsdom、再点按钮 —— 那套在这个仓库里没有（全部 10 个 verify 脚本
 * 都是纯 node）。所以凡是**能写成函数**的都写在这里，组件只负责渲染。
 *
 * ## 这一层到底做了什么（三件）
 *
 * 1. **把 `api.agentTurn` 包成 `runAgent` 要的 `callModel`**。
 *    `runAgent` 刻意不 import `api.ts`（见那里的注释），于是必须有人在
 *    外壳里接这一根线；这里就是那根线，且**只有这一根**。
 *
 * 2. **把确认门收成一个 `Promise<boolean>`**。`confirm` 在 `runAgent` 里是
 *    同步语义的回调，而 UI 上的"确认/取消"是异步的 —— 中间必须有一个
 *    "挂起的一次询问"。用一个 `resolve` 存着，等用户点。
 *
 * 3. **轮次在飞的时候拒绝第二次提交**。不是防呆：两条 `runAgent` 同时跑
 *    会开**两轮** turnId，`beginTurn` 是覆盖式的（`command.ts`），后开的那轮
 *    会让先开那轮的 `endTurn` 关不掉自己 —— 结果就是"AI 改的那批撤不掉"。
 */

import type { ConfirmFn, AgentRunResult } from "../../lib/agent/runAgent";
import type { CommandScope } from "../../lib/command";

/** 后端 `/v2/agent/turn` 的返回里我们真正用到的部分。
 *  ⚠️ 不含 `model_id`：它只用于设置页显示"这次是哪个模型答的"，
 *  命令条不读它，写进来只会诱使 UI 去展示一个它无权解释的字段。 */
export interface AgentTurnReply {
  reply: string;
  done: boolean;
  commands: { id: string; args: Record<string, unknown> }[];
  dropped?: string[];
}

/** `callModel` 的入参（与 `RunAgentOptions.callModel` 的形参一字不差）。
 *  之所以在这里重抄一遍而不是 `Parameters<...>`：重抄能让"外壳传了什么"
 *  一眼可读，而 `Parameters<typeof x>[0]` 在编辑器和 review 里都是噪音。 */
export interface AgentModelCall {
  text: string;
  timelineText: string;
  capabilities: { id: string; desc: string; params: unknown; costly: boolean }[];
  projectId: string | null;
  history: { role: "user" | "assistant"; text: string }[];
}

export type AgentModelFn = (body: AgentModelCall) => Promise<AgentTurnReply>;

/** 把后端返回的 `dropped` 归一到数组。后端在"一条都没丢"时可能省略这个字段，
 *  直接 `for (... of undefined)` 会抛 —— 而它抛在 runAgent 的 try 里，
 *  会被报成"AI 没接上"，把一次正常的空数组说成故障。 */
export function normalizeDropped(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * 把一次"问用户要不要花钱"变成可等待的一次询问。
 *
 * 组件挂上 `onConfirm` / `onCancel` 两个回调，用户在 UI 上点哪个就
 * `resolve` 哪个。**没有入口时返回的 Promise 永不 resolve** —— 这是故意的：
 * `runAgent` 那边对"没有 confirm 回调"是 fail closed（直接跳过不执行），
 * 而这里"有回调但用户一直不点"的唯一正确语义就是**继续等**。
 * 给一个默认的 `false` 会让用户离开一会儿就静默丢掉这一步。
 */
export function createConfirmGate(): {
  /** 交给 `runAgent` 的 `confirm` */
  confirm: ConfirmFn;
  /** 有没有一个挂起的询问（组件据此决定要不要弹条） */
  pending: () => ConfirmRequest | null;
  /** 用户点了同意/取消 */
  answer: (ok: boolean) => void;
  /** 轮次结束/被取消时收尾：把挂起的询问当成"取消"，清掉状态。
   *  ⚠️ 必须调用，否则组件会一直挂着一个再也不会被回答的询问条。 */
  abort: () => void;
  /** 订阅"有一条新的询问来了"（组件 setState 用）。返回退订函数。 */
  subscribe: (fn: (req: ConfirmRequest | null) => void) => () => void;
} {
  let current: ConfirmRequest | null = null;
  let resolveCurrent: ((ok: boolean) => void) | null = null;
  const listeners = new Set<(req: ConfirmRequest | null) => void>();

  const emit = () => { for (const l of listeners) l(current); };

  const settle = (ok: boolean) => {
    const r = resolveCurrent;
    resolveCurrent = null;
    current = null;
    emit();
    // 先清状态再 resolve：`resolve` 之后 `runAgent` 会立刻继续跑，
    // 如果那时组件还没收到"询问结束了"，它会渲染出一条属于上一步的确认条。
    r?.(ok);
  };

  return {
    confirm: (req) =>
      new Promise<boolean>((resolve) => {
        // 已经挂着一条还来第二条：把前一条按"取消"结掉。
        // 这不该发生（runAgent 是串行 await 的），但真发生时的正确反应是
        // 让旧的退出、新的接上，而不是两条并存让用户点错。
        if (resolveCurrent) settle(false);
        current = req;
        resolveCurrent = resolve;
        emit();
      }),
    pending: () => current,
    answer: (ok) => { if (resolveCurrent) settle(ok); },
    abort: () => { if (resolveCurrent) settle(false); },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export interface ConfirmRequest {
  capabilityId: string;
  /** 能力表里写好的代价说明。**必须原样显示** —— 不能换成"确认吗？" */
  confirmText: string;
  /** dry-run 算出的影响面摘要 */
  summary: string;
  affected: CommandScope;
}

/** 命令条的显示状态。**不存在 store 里**：它只服务这一个组件，
 *  进全局 store 会让"AI 正在想"这种高频状态把整个编辑器重渲染一遍。 */
export type AgentBarPhase = "idle" | "running" | "confirm";

/** 从一轮的结果算"该跟用户说什么"。
 *
 *  ⚠️ 与 `summarizeRun` 的分工：那个说的是"改了几处、涉及几个镜头"，
 *  这个说的是"这一轮整体成不成功"。两句都要有 —— 只报成功数，用户看不出
 *  "AI 其实没做完"；只报状态，用户不知道改了多少。
 */
export function runStatusLine(r: AgentRunResult): string {
  const n = r.steps.filter((s) => s.ok).length;
  switch (r.status) {
    case "done":
      return n ? `完成（改了 ${n} 处）` : "完成（没有需要改的地方）";
    case "incomplete":
      return `没做完（成功 ${n} 处，已达单轮上限）`;
    case "cancelled":
      return "已取消";
    case "failed":
    default:
      return "没接上（这次没有改动）";
  }
}

/** 一轮跑完之后，撤销栈顶那条记录是不是**这一轮**的。
 *
 *  判据是 `turnId` 相等，不是"栈里有没有东西"：`running` 期间用户是点不到
 *  撤销的（顶栏按钮禁用），所以只要栈顶是本轮 id，就一定是 AI 改的那一批。
 *  UI 用它决定要不要显示「撤销这一轮」这个按钮。
 */
export function turnIsOnTop(entryTurnId: string | null | undefined, turnId: string | null): boolean {
  if (!turnId || !entryTurnId) return false;
  return entryTurnId === turnId;
}
