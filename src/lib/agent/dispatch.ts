/**
 * dispatch.ts — 能力表与真实调用之间的**执行器**（批次 E5，PLAN §2.5.3 配套二）
 *
 * ## 为什么"说明书"和"手"要分开
 *
 * `capability.ts` 是**纯数据**的说明书：有什么能力、要什么参数、花不花钱。
 * 本文件是**唯一**把 `id` 映射到真实 `api.*` 调用的地方。分开的理由不是分层
 * 审美，是**可验证性**：两者能对不上（表里写了 `recut_shot`、执行器忘了实现，
 * 或者反过来实现了个表里没有的），而"对不上"这件事只有在两者是**两份独立清单**
 * 时才检查得出来。`verify-agent.ts` 逐条比对两边，缺一条就红灯。
 *
 * ## 谁执行 `run` / `unrun`（这是本模块最容易写错的一处）
 *
 * **`dispatch` 不执行命令**，它只**构造**命令并 `push` 进撤销栈 ——
 * 与 App.tsx 里 18 处调用点的契约完全一致：`pushUndo` 的调用时机是
 * "**已经改完了**"，命令本身就是记录，不是执行器（见 `command.ts` 的 `push` 注释）。
 * 于是每个 handler 的形状恒为三段：
 *
 *     ① await api.xxx(...)        真实调用（改后端）
 *     ② await host.refresh()      拉到新状态（否则界面还停在旧数据上）
 *     ③ host.pushCommand({ ...run/unrun })   把逆操作记进栈
 *
 * `run` 里必须**再调一次 ①**：重做的语义是"把这件事重做一遍"，
 * 不是"把第 ③ 步的快照塞回去"。`unrun` 才是逆操作。两者都必须能独立完成
 * 一次完整的改变（含落库），这是 `command.ts` 写死的契约。
 *
 * ## `unrun` 里那些"看起来多余"的 API 调用
 *
 * 没有第二条路：撤销必须是**真的撤销**（后端数据也回去），不能只改本地。
 * 所以 `patch_shot_timeline` 的逆操作是把**旧值**再 PATCH 一次，
 * 而旧值在正向调用之前就取好了（`prev` 快照），因为正向一跑旧值就没了。
 * ⚠️ 这个快照取的是 **UI 内存里**的镜头状态（`host.findShot`），不是后端。
 * 理由：Agent 的每一条修改前都要求先 `describe_timeline`，而它读的就是同一份
 * UI 状态；再打一次后端只为拿旧值，会让"慢"变成 Agent 的常态。
 * 代价是**界面陈旧时快照会错**，所以 `host.findShot` 找不到镜头时**直接报错**，
 * 不猜（宁可不做，也不要写一条逆操作是错的命令进去）。
 *
 * ## 确认闸门（§14 附录 D 硬约束 ②）
 *
 * `needsConfirm(cap)` 为真（花钱 / 破坏性）的能力，**没有出现在 `confirmed`
 * 集合里就拒绝执行**，并且**抛 `NeedConfirm` 而不是返回错误码** ——
 * 调用方（Agent 循环）必须显式 catch 它并把 `confirmText` 交给用户，
 * 返回错误码会被顺手 `try/catch` 掉变成一句"操作失败"，而用户从头到尾
 * 不知道刚才差点花掉一笔钱或者删掉一个镜头。
 *
 * ⚠️ **`confirmed` 由人来填**，且**一次调用一填**（不是一次会话一填）：
 * 用户说"生成第 3 镜"→ 只对这一次 `generate_shots` 生效。
 * 别把它做成"用户同意过一次生成，整轮都放行"——`generate_shots` 不传
 * `shot_ids` 时是对全项目触发，两次调用之间的代价差几十倍。
 */

import { findCapability, needsConfirm } from "./capability";
import type { AgentCapability } from "./capability";
// ⚠️ `import type` 是刻意的：`describeTimeline.ts` 本身是纯函数（能在 node 下跑），
// 但它没有副作用，静态 import 也不会有问题 —— 之所以 **运行时** 仍走下面的
// `await import()`，是为了让读代码的人一眼看出"这条链上没有 `api.ts`"。
import type { TimelineShotView } from "./describeTimeline";
import type { CommandDraft, CommandScope, EditCommand } from "../command";

/** 传入的自变量必须**已经过 `schema.validateArgs`**（缺省值补齐、类型校验、
 *  未知字段剔除都做完了），这里只当它可信。没在这里再校验一遍是刻意的：
 *  两处校验迟早会漂移，而"哪一处说了算"会变成一个没人答得上来的问题。 */
export type AgentArgs = Record<string, unknown>;

/** 一次能力调用的结果。**给 Agent 循环看的**，不是给用户看的。 */
export interface DispatchResult {
  ok: true;
  capability: string;
  /** 进撤销栈的命令（只读类能力没有，省略）。`turnId` 见 `Host.beginTurn` */
  command?: EditCommand;
  /** 这条命令是否被**合并**进了本轮已有的一条里（E4）。
   *  Agent 循环据此在回复里说"共改了 N 处"，而不是"执行了 N 次"。 */
  merged?: boolean;
  /** 该回给模型的纯数据（只读能力的查询结果、写能力的后端回执摘要）。 */
  data?: unknown;
  /** 给**用户**的一句话（`say()` 直接显示）。人话，不是 `ok: true` */
  say: string;
}

/** 需要用户确认才能执行。**必须被调用方捕获**，见文件头"确认闸门"。 */
export class NeedConfirm extends Error {
  readonly capability: string;
  readonly confirmText: string;
  constructor(cap: AgentCapability) {
    super(`「${cap.id}」需要用户确认：${cap.confirmText ?? ""}`);
    this.name = "NeedConfirm";
    this.capability = cap.id;
    // 确认文案**必须**存在（capability.ts 的契约），但真缺了也要能跑 ——
    // 退化成一句说明"这个操作要花钱"而不是空字符串，空字符串在确认框里
    // 等于没有确认框。
    this.confirmText = cap.confirmText ?? "这个操作会产生不可逆的后果或花费额度，确认执行吗？";
  }
}

/** 能力不存在 / 参数不合法 / 执行失败。**不要**用裸 `Error`：
 *  Agent 循环要靠 `instanceof` 区分"该重试"（`DispatchError.retryable`）
 *  与"该改参数重来"，靠字符串认错误迟早被文案改动弄坏。 */
export class DispatchError extends Error {
  readonly capability: string;
  /** 值得原样交给模型重试吗（比如 409 冲突就不值得 —— 重试还是 409）。 */
  readonly retryable: boolean;
  constructor(capability: string, msg: string, retryable = false) {
    super(msg);
    this.name = "DispatchError";
    this.capability = capability;
    this.retryable = retryable;
  }
}

/** 执行器需要的宿主能力。**用接口而不是直接 import store**：
 *  1. 本模块要能在 node 下被 `verify-agent.ts` 跑（zustand store 拉进 node
 *     会因为 `window` 炸），Mock 一个 Host 就能测全部 handler；
 *  2. `run` / `unrun` 会在**撤销时**执行（`App.tsx` 的 `doUndo`），
 *     那时拿不到 Agent 循环的任何局部变量 —— 闭包捕获 `host` 是唯一活路。
 */
export interface AgentHost {
  /** 现在打开的项目 id。没打开项目时抛错 —— 所有写能力都落在这个项目上，
   *  默认一个 id 会让 AI 改到别的项目里去。 */
  projectId: () => string;
  /** 从**当前界面状态**里找一个镜头。找不到返回 undefined。
   *  用来取"改之前是什么样"（逆操作的输入）。 */
  findShot: (shotId: string) => { order: number; duration_sec: number | null;
                                 disabled: boolean; gen_prompt: string | null;
                                 video_url?: string | null; is_special?: boolean } | undefined;
  /** 按 id 取镜头（`findShot` 的别名，语义更明确的写法留给需要"必须有"的调用点） */
  requireShot: (shotId: string) => { order: number; duration_sec: number | null;
                                     disabled: boolean; gen_prompt: string | null };
  /** 重新拉取项目详情 / 时间轴（正向与反向、成功与失败都要调）。
   *  返回 Promise 是为了让 undo 里的 `await host.refresh()` 真的等到数据回来。 */
  refresh: () => Promise<void>;
  /** 界面内存里的镜头列表（`describe_timeline` 的数据源，**不打网络**）。
   *  形状按 `TimelineShotView` 收窄是刻意的：多说一句都不给 ——
   *  `describeTimeline` 只读那几个字段，传整个 `ShotInfo` 进来只会
   *  诱使后续改动去摸界面专属字段（选中态、缩略图…），把纯函数拖脏。 */
  shots: () => readonly TimelineShotView[];
  /** 入栈（`timelineStore.pushUndo`）。**调用时机是"已经改完了"** */
  pushCommand: (draft: CommandDraft) => EditCommand;
  /** 写一句给用户的话 */
  say: (msg: string) => void;
  /** 文本模型的单轮补全（E6 用；`describe_timeline` 之类的只读能力不碰它）。
   *  省略时 `generate_shots` 之外的生成类能力仍可跑，只有需要"让模型改提示词"
   *  的能力会明确报错。 */
  llm?: (system: string, user: string) => Promise<string>;
  /** 开一轮（E4 的合并窗口）。返回 `turnId`，之后所有 `pushCommand`
   *  都并进**同一条** `EditCommand`，撤销时一起退。
   *
   *  ⚠️ 为什么放在 `AgentHost` 而不是让 `runAgent` 直接 import store：
   *  同上（node 下要能跑）。而为什么由**调用方**开轮而不是 `dispatch` 自己开：
   *  `dispatch` 是**单条命令**的执行入口（用户手点也走它），
   *  在那里开轮意味着"每一条命令各开一轮" —— 恰恰是 E4 要消灭的东西。
   *  轮的边界只有 Agent 循环知道。 */
  beginTurn: () => string;
  /** 关一轮。**必须成对调用**（`runAgent` 放在 `finally` 里）。
   *  漏调的后果不是"少合并一次"，而是用户接下来的**手动**操作
   *  被并进 AI 那一轮 —— 他按一次 Ctrl+Z 会连自己刚做的改动一起撤掉。 */
  endTurn: (turnId: string) => void;
}

/** 正向调用的产物。`affected` 在正向调用**之后**才知道（新 id 是后端给的），
 *  所以它是 handler 的**返回值**、再由 `dispatch` 入栈。
 *
 *  ⚠️ `draft` 缺省表示"这次调用**不产生命令**"（只读能力、生成能力）。
 *  它**不允许**由 handler 随手省略 —— `NO_COMMAND` 是唯一的判定处，
 *  两处都能决定"要不要入栈"必然漂移成"有的只读能力悄悄进了撤销栈"。 */
interface Applied {
  /** 进栈的命令草稿。缺省 = 不入栈（见上） */
  draft?: Omit<CommandDraft, "origin">;
  /** 给模型的回执（纯数据） */
  data?: unknown;
  /** 给用户的一句话 */
  say: string;
}

/** 一个 handler：调后端 → 返回"怎么记这笔账"。 */
type Handler = (
  host: AgentHost, args: AgentArgs, cap: AgentCapability,
) => Promise<Applied>;

/** 逆操作速查表：命令 id → 撤销时要跑的东西。
 *
 *  ⚠️ 为什么需要它 —— `add_special_shot` 的逆操作要删掉**刚被创建出来的**
 *  那个镜头 id，而那个 id 要等正向调用返回才知道。它没法写进 `Applied` 的
 *  静态字段里（那是个 id，不是函数）。这里的做法是：正向调用拿到新 id 后
 *  `remember(cmd.id, ...)`，撤销时 `take(cmd.id)` 取回来。
 *
 *  ⚠️ 表会随命令出栈而**留下垃圾**（撤销过的条目不会再被读）。
 *  刻意不做定时清理：它的量级是"一次会话几十条"，而清理逻辑一旦写错
 *  （在重做前就把条目删了）表现是"重做后再撤销静默什么也不做"。
 *  真要做，就在 `clearUndo` 里整体清空（见 `forgetAll`）。
 */
const inverseRegistry = new Map<string, () => Promise<void>>();

export function remember(cmdId: string, fn: () => Promise<void>): void {
  inverseRegistry.set(cmdId, fn);
}

export function forgetAll(): void {
  inverseRegistry.clear();
}

/** 取一条镜头，取不到就抛。**不返回 undefined** —— 所有需要它的调用点
 *  都是"没它就没法构造逆操作"，返回 undefined 只会把错误推到更深的地方。 */
function shotOrThrow(host: AgentHost, id: string) {
  const s = host.findShot(id);
  if (!s) throw new DispatchError("", `找不到镜头 ${id}（界面数据可能已过期，请先重新读取时间轴）`, true);
  return s;
}

function str(args: AgentArgs, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new DispatchError("", `参数 ${key} 缺失`);
  return v;
}
function num(args: AgentArgs, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || Number.isNaN(v)) throw new DispatchError("", `参数 ${key} 不是数字`);
  return v;
}
function optNum(args: AgentArgs, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}
function optStr(args: AgentArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}
function optBool(args: AgentArgs, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

/** `api` 的**懒加载**入口。
 *
 *  `api.ts` 顶上读 `import.meta.env`（浏览器/vite 专有），在 node 下取不到 ——
 *  静态 import 会让 `verify-agent.ts` 连编译都过不去。所以这里用动态 import：
 *  验证脚本只要不真的执行写能力，就永远走不到这一行。
 *  这不是权宜之计 —— 它是"执行器必须能在 node 下被验证"这条要求的直接后果。 */
async function apiMod(): Promise<typeof import("../../api")["api"]> {
  const m = await import("../../api");
  return m.api;
}

// ─────────────────────────────────────────────────────────────────────────────
// 各能力的 handler
// ─────────────────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, Handler> = {
  // ── 只读：不落库、不进撤销栈 ──────────────────────────────────────────────
  // `describe_timeline` 与 `shot_versions` 由调用方在 `runAgent` 里处理
  // （它们需要 `describeTimeline` / `api.shotVersions`，且产物直接回给模型）。
  // 这里放一个"谁都能调"的实现，是为了让 `dispatch()` 的入口对所有能力一致：
  // Agent 循环对只读能力也走同一条路，就不存在"读走一条路、写走另一条路"
  // 这种两套代码漂移的地基。
  describe_timeline: async (host, args) => {
    // `project_id` 是**必填**（模型必须先说清楚在看哪个项目），但这里只拿它
    // 做一次一致性检查：时间轴的唯一事实来源是界面内存，不是这个参数。
    // 模型抄错项目 id 时**当场报错**，而不是悄悄返回另一个项目的镜头 ——
    // 后者会让模型基于错误的前提改东西，而且改错的是**别的项目**。
    const want = str(args, "project_id");
    const have = host.projectId();
    if (want !== have) {
      throw new DispatchError(
        "describe_timeline",
        `project_id 对不上：你传的是 ${want}，当前打开的是 ${have}。` +
          `请用当前项目的 id 重新调用（不要让用户去换项目）。`,
      );
    }
    const { describeTimeline, toPromptText } = await import("./describeTimeline");
    const page = describeTimeline(
      { id: have, shots: loadShots(host) },
      {
        episode: optNum(args, "episode"),
        offset: optNum(args, "offset") ?? 0,
        limit: optNum(args, "limit") ?? 50,
        includePrompt: optBool(args, "include_prompt") ?? false,
      },
    );
    return {
      data: page,
      say: toPromptText(page),
    };
  },

  shot_versions: async (_host, args) => {
    const api = await apiMod();
    const r = await api.shotVersions(str(args, "shot_id"));
    return {
      data: r,
      say: r.versions?.length ? `查到 ${r.versions.length} 个历史版本` : "这一镜还没有历史版本",
    };
  },

  // ── 编辑 ──────────────────────────────────────────────────────────────────

  split_shot: async (host, args) => {
    const api = await apiMod();
    const shotId = str(args, "shot_id");
    const atSec = num(args, "at_sec");
    const r = await api.splitShot(shotId, atSec);
    await host.refresh();
    const scope: CommandScope = { shots: [r.head_shot_id, r.tail_shot_id] };
    return {
      data: r,
      say: `已分割为 #${r.head_order}（${r.head_duration}s）+ #${r.tail_order}（${r.tail_duration}s）`,
      draft: {
        label: `分割镜头 #${r.head_order}`,
        kind: "shot",
        affected: scope,
        desc: `AI 在镜内第 ${atSec} 秒分割镜头，产生两行新镜头`,
        params: { shot_id: shotId, at_sec: atSec },
        agentCallable: true,
        run: async () => { await api.splitShot(r.head_shot_id, atSec); await host.refresh(); },
        // 逆操作走专门的 unsplit：后半段是 is_special=0 的 AI 镜头行，
        // `delete_shot` 明确拒删它（见 App.tsx `doSplit` 的同款注释）。
        unrun: async () => { await api.unsplitShot(r.head_shot_id, r.tail_shot_id); await host.refresh(); },
      },
    };
  },

  unsplit_shot: async (host, args) => {
    const api = await apiMod();
    const head = str(args, "head_shot_id");
    const tail = str(args, "tail_shot_id");
    const r = await api.unsplitShot(head, tail);
    await host.refresh();
    return {
      data: r,
      say: `已合回一段（${r.duration}s）`,
      draft: {
        label: `合并镜头 ${head.slice(0, 6)} + ${tail.slice(0, 6)}`,
        kind: "shot",
        affected: { shots: [head, tail] },
        desc: "AI 撤销了一次分割，把后半段合回前半段",
        params: { head_shot_id: head, tail_shot_id: tail },
        agentCallable: true,
        // 重做 = 再合一次？不行 —— 合完两行已经没了，`unsplitShot` 再调就是 404。
        // 这条命令**确实不可重做**：合并是有损的（尾部那行的 id 消失了）。
        // 按 `command.ts` 的契约，不可重做要**显式**写出来，不许让 `run` 空着。
        reversible: false,
        run: () => { host.say("合并镜头不支持重做：尾部那行已经不存在了，需要重新分割。"); },
        unrun: async () => {
          // 逆操作是"重新分出来"。切点取原头段的时长 —— 这正是当初被合掉的那一刀。
          const headShot = host.findShot(head);
          const at = headShot?.duration_sec ?? r.duration;
          await api.splitShot(head, at);
          await host.refresh();
        },
      },
    };
  },

  recut_shot: async (host, args) => {
    const api = await apiMod();
    const shotId = str(args, "shot_id");
    const cutA = num(args, "cut_a");
    const cutB = num(args, "cut_b");
    const r = await api.recutShot(shotId, cutA, cutB);
    await host.refresh();
    return {
      data: r,
      say: `已划出待重生成区间：${r.head_duration}s 保留 · ${r.mid_duration}s 待生成 · ${r.tail_duration}s 保留`,
      draft: {
        label: `划出待重生成区间（${r.mid_duration}s）`,
        kind: "shot",
        affected: { shots: [r.head_shot_id, r.mid_shot_id, r.tail_shot_id] },
        desc: `AI 把镜头划成 A|B|C 三段，只有中间 ${r.mid_duration}s 需要重新生成`,
        params: { shot_id: shotId, cut_a: cutA, cut_b: cutB },
        agentCallable: true,
        // 撤销走 `undoRecutShot`（不是 unsplit）：B 段从定义上就没有画面，
        // unsplit 的 url 守卫会把它拦下，且合出来的镜头会凭空继承 A 的画面。
        unrun: async () => { await api.undoRecutShot(r.head_shot_id, r.mid_shot_id); await host.refresh(); },
        // 重做 = 重放同样两个切点。⚠️ 重做出来的三行全是**新 id**，
        // 与撤销前那三行不是同一个 uid —— 所以这条命令的 `affected` 里
        // 记的 id 在撤销后就失效了。这是 `recut` 语义的固有代价（见 App.tsx
        // `doRecut` 的同款注释），不是这里漏改。
        run: async () => { await api.recutShot(r.head_shot_id, cutA, cutB); await host.refresh(); },
      },
    };
  },

  undo_recut_shot: async (host, args) => {
    const api = await apiMod();
    const head = str(args, "head_shot_id");
    const mid = str(args, "mid_shot_id");
    const prevMidDur = host.findShot(mid)?.duration_sec ?? null;
    const r = await api.undoRecutShot(head, mid);
    await host.refresh();
    return {
      data: r,
      say: `已合回一段（${r.duration}s）`,
      draft: {
        label: `合回划出的区间（${r.duration}s）`,
        kind: "shot",
        affected: { shots: [head, mid] },
        desc: "AI 撤销了一次局部重生成划分",
        params: { head_shot_id: head, mid_shot_id: mid },
        agentCallable: true,
        reversible: false, // 同上：合并是有损的，中间那行的 id 已经没了
        run: () => { host.say("合回划分不支持重做：中间段那行已经不存在了，需要重新划一次。"); },
        unrun: async () => {
          // 逆操作是把两刀重新划回去。切点必须重算：A 段结尾 + B 段长度。
          const headShot = host.findShot(head);
          const aDur = headShot?.duration_sec ?? null;
          if (aDur === null) throw new DispatchError("undo_recut_shot", "取不到 A 段时长，无法重建划分", true);
          const bDur = prevMidDur ?? 0;
          await api.recutShot(head, aDur, aDur + bDur);
          await host.refresh();
        },
      },
    };
  },

  patch_shot_timeline: async (host, args) => {
    const api = await apiMod();
    const shotId = str(args, "shot_id");
    const prev = shotOrThrow(host, shotId);
    const patch = {
      durationSec: optNum(args, "duration_sec"),
      toOrder: optNum(args, "to_order"),
      disabled: optBool(args, "disabled"),
      clipInSec: optNum(args, "clip_in_sec"),
      clipDurSec: optNum(args, "clip_dur_sec"),
    };
    const r = await api.patchShotTimeline(shotId, patch);
    await host.refresh();

    // 逆操作：把**改之前**的值再 PATCH 回去。
    // ⚠️ 分两笔写而不是一笔，因为 `null` 在这个接口里表示"本次不改这一项"
    //（见 api.ts 的 `clearClipWindow` 注释）—— 把没传的字段一起 PATCH 回去
    // 会顺手把别的项也改掉。
    const back = {
      durationSec: patch.durationSec !== undefined ? (prev.duration_sec ?? undefined) : undefined,
      toOrder: patch.toOrder !== undefined ? prev.order : undefined,
      disabled: patch.disabled !== undefined ? prev.disabled : undefined,
      ...(patch.clipInSec !== undefined || patch.clipDurSec !== undefined
        ? { clearClipWindow: true }
        : {}),
    };
    // 时长也有上下限（服务端钳 1–15）。旧值可能是 null（没设过时长），
    // 这时**不能**把 null 传回去 —— 它表示"不改"，于是时长就永远回不去了。
    // 语义上"没设过"等价于跟随素材，用 clip 窗口清除来表达。
    const backPatch = back.durationSec === undefined && back.toOrder === undefined
      && back.disabled === undefined && !("clearClipWindow" in back)
      ? { clearClipWindow: true }
      : back;

    const changes = Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");

    return {
      data: r,
      say: `已更新镜头 #${r.order}（${changes}）`,
      draft: {
        label: `调整镜头 #${prev.order}${changes ? `（${changes}）` : ""}`,
        kind: "shot",
        affected: { shots: [shotId] },
        desc: "AI 改了镜头的时间轴属性（时长 / 顺序 / 停用 / 取片窗口）",
        params: { shot_id: shotId, ...patch },
        agentCallable: true,
        run: async () => { await api.patchShotTimeline(shotId, patch); await host.refresh(); },
        unrun: async () => { await api.patchShotTimeline(shotId, backPatch); await host.refresh(); },
      },
    };
  },

  patch_shot_prompt: async (host, args) => {
    const api = await apiMod();
    const shotId = str(args, "shot_id");
    const genPrompt = str(args, "gen_prompt");
    const prev = host.findShot(shotId)?.gen_prompt ?? null;
    await api.patchShotPrompt(shotId, genPrompt);
    await host.refresh();
    return {
      say: "已改写提示词（这一镜已被标记为需重新生成）",
      draft: {
        label: `改写提示词（${shotId.slice(0, 6)}）`,
        kind: "transform",
        affected: { shots: [shotId] },
        desc: "AI 覆盖式改写了镜头的生成提示词",
        params: { shot_id: shotId, gen_prompt: genPrompt },
        agentCallable: true,
        run: async () => { await api.patchShotPrompt(shotId, genPrompt); await host.refresh(); },
        // 逆操作：旧提示词为空 = 当初是"系统生成的那一版"，用 DELETE 交还给 AI；
        // 非空则把旧文本写回去。⚠️ 不能一律 DELETE —— 那会把用户之前手写过的
        // 提示词一起抹掉，而用户只会看到"AI 撤销了它自己的修改，怎么我写的也没了"。
        unrun: async () => {
          if (prev) await api.patchShotPrompt(shotId, prev);
          else await api.resetShotPrompt(shotId);
          await host.refresh();
        },
      },
    };
  },

  reset_shot_prompt: async (host, args) => {
    const api = await apiMod();
    const shotId = str(args, "shot_id");
    const prev = host.findShot(shotId)?.gen_prompt ?? null;
    await api.resetShotPrompt(shotId);
    await host.refresh();
    return {
      say: "已把提示词交还给 AI（下次生成时按拆解结果重新优化）",
      draft: {
        label: `提示词恢复默认（${shotId.slice(0, 6)}）`,
        kind: "transform",
        affected: { shots: [shotId] },
        desc: "AI 清掉了手改的提示词覆盖，回到系统生成的那一版",
        params: { shot_id: shotId },
        agentCallable: true,
        // 重做 = 再清一次。⚠️ 第二次清是**空操作**（已经清了），但它是安全的、
        // 且语义正确（"把提示词恢复默认"再做一遍 = 还是默认）。不是无声失败。
        run: async () => { await api.resetShotPrompt(shotId); await host.refresh(); },
        unrun: async () => {
          // 撤销 = 把被清掉的那版写回去。取不到旧值时**明确报错不静默**：
          // 静默的话用户看到的是"撤销点了没反应"，而提示词其实已经没了。
          if (!prev) throw new DispatchError("reset_shot_prompt", "这一镜没有手改过的提示词，无需撤销");
          await api.patchShotPrompt(shotId, prev);
          await host.refresh();
        },
      },
    };
  },

  adopt_shot: async (host, args) => {
    const api = await apiMod();
    const shotId = str(args, "shot_id");
    const versionNo = num(args, "version_no");
    // 采纳前先查一下当前是哪一版 —— 撤销时要采纳回去的就是它。
    // 多一次只读调用换一条**真的能撤销**的命令，值。
    const before = await api.shotVersions(shotId);
    const current = before.versions?.find((v) => v.version_no !== versionNo);
    const r = await api.adoptShot(shotId, versionNo);
    await host.refresh();
    return {
      data: r,
      say: `已采纳第 ${versionNo} 版画面${r.clip_window_cleared ? "（原有的取片窗口已清除）" : ""}`,
      draft: {
        label: `采纳镜头 ${shotId.slice(0, 6)} 的第 ${versionNo} 版`,
        kind: "shot",
        affected: { shots: [shotId] },
        desc: "AI 把某个历史版本采纳为当前版本（旧版画面不丢，仍在版本表里）",
        params: { shot_id: shotId, version_no: versionNo },
        agentCallable: true,
        run: async () => { await api.adoptShot(shotId, versionNo); await host.refresh(); },
        // 撤销 = 采纳回原来那一版。取不到"原来那一版"时只能问后端：
        // 版本表里除目标版以外最新的一版，就是采纳前的那一版
        // （`shot_versions` 按 version_no 倒序，取第一个不等于目标版的）。
        // 这是**推断**不是记录，所以写入 `params` 让面板能看出它。
        unrun: async () => {
          const now = await api.shotVersions(shotId);
          const fallback = now.versions?.find((v) => v.version_no !== versionNo)?.version_no
            ?? current?.version_no;
          if (!fallback) throw new DispatchError("adopt_shot", "这一镜只有这一个版本，无法撤销采纳");
          await api.adoptShot(shotId, fallback);
          await host.refresh();
        },
      },
    };
  },

  delete_shot: async (host, args) => {
    const api = await apiMod();
    const shotId = str(args, "shot_id");
    // ⚠️ 删之前必须确认这确实是外部素材镜头。AI 生成镜头删不掉（后端会拒），
    // 但**别把拒绝当成本地判断的替代**：先本地拦一道，模型得到的是"该用
    // disabled=true"这条人话，而不是后端的一句 409。
    const shot = host.findShot(shotId);
    if (shot && shot.is_special !== true) {
      throw new DispatchError(
        "delete_shot",
        "这一镜是 AI 生成的镜头，删不掉。用户说「不要这个镜头」时请改用 patch_shot_timeline 的 disabled=true（停用可随时恢复）。",
      );
    }
    await api.deleteShot(shotId);
    await host.refresh();
    // 删除是**不可撤销**的：后端不留旧行，`addSpecialShot` 也回不到原来的
    // order（素材地址、名字、时长都得重新给）。所以这里只入栈一条
    // `reversible: false` 的记录 —— 它出现在撤销历史里，但重做是出声的桩。
    return {
      say: "已删除这个外部素材镜头",
      draft: {
        label: `删除外部素材镜头（${shotId.slice(0, 6)}）`,
        kind: "shot",
        affected: { shots: [shotId] },
        desc: "AI 删除了一个外部素材镜头（不可撤销）",
        params: { shot_id: shotId },
        agentCallable: true,
        reversible: false,
        run: () => { host.say("删除镜头不支持重做：素材行已经不存在了，需要重新导入素材。"); },
        unrun: () => { host.say("删除镜头无法撤销：需要重新导入素材。"); },
      },
    };
  },

  add_special_shot: async (host, args) => {
    const api = await apiMod();
    const projectId = str(args, "project_id");
    const name = str(args, "name");
    const url = str(args, "video_url");
    const afterOrder = optNum(args, "after_order");
    const durationSec = optNum(args, "duration_sec");
    const r = await api.addSpecialShot(projectId, name, url, afterOrder, durationSec);
    await host.refresh();
    return {
      data: r,
      say: `已插入「${name}」（第 ${r.order} 位）`,
      draft: {
        label: `插入外部素材「${name}」`,
        kind: "asset",
        affected: { shots: [r.shot_id] },
        desc: "AI 把一段外部素材插进镜头轨，做成一个特殊镜头",
        params: { project_id: projectId, name, video_url: url, after_order: afterOrder, duration_sec: durationSec },
        agentCallable: true,
        // 逆操作 = 删掉刚插进来的那一行。用 `deleteShot` 而不是别的手段：
        // 它本来就是外部素材镜头，正是 `deleteShot` 唯一允许删的那类。
        // ⚠️ 但**重做**要重新插一次拿的是**新 id** —— 与 `recut` 同款取舍。
        run: async () => { await api.addSpecialShot(projectId, name, url, afterOrder, durationSec); await host.refresh(); },
        unrun: async () => { await api.deleteShot(r.shot_id); await host.refresh(); },
      },
    };
  },

  // ── 生成（花钱） ──────────────────────────────────────────────────────────
  generate_shots: async (_host, args) => {
    const api = await apiMod();
    const projectId = str(args, "project_id");
    const shotIds = Array.isArray(args.shot_ids) ? (args.shot_ids as string[]) : undefined;
    const modelId = optStr(args, "model_id");
    const job = await api.submitShotsByIds(projectId, shotIds, modelId);
    // ⚠️ 生成**不进撤销栈**，而且这不是遗漏 —— 撤销一个已经提交的生成任务，
    // 语义上要做的是"取消 job"，那与命令栈的 run/unrun 模型对不上（它没有
    // 逆操作可用：job 可能已经在跑了、钱可能已经花了）。所以这里**不入栈**。
    // 代价是它也就**不记台账**（记账挂在 `push` 上，见 `command.ts`）——
    // 这是刻意的：要追溯"谁在什么时候提交了生成"，唯一的事实来源是
    // **job 列表**（`trackJob` + 后端的任务表），不是变更台账。
    // 在台账里补一条"生成了"的假命令，只会让"台账里有的都能撤销"这个
    // 契约出现例外，而例外的代价是用户再也不敢信 Ctrl+Z。
    return {
      data: job,
      say: `已提交生成任务${shotIds ? `（${shotIds.length} 个镜头）` : "（全部待生成/待重做的镜头）"}`,
    };
  },
};

/** 不产生命令的能力（只读 + 生成）。`dispatch` 对它们**跳过入栈**。
 *
 *  ⚠️ 为什么 `generate_shots` 在这张表里而不是"入栈一条 reversible:false 的
 *  记录"：生成任务提交后的**撤销**是一个语义黑洞（取消 job ≠ 撤销一次编辑，
 *  且任务可能已经在花钱了）。把它塞进撤销栈，用户会得到一个"按 Ctrl+Z 能
 *  撤掉花钱操作"的错误承诺 —— 那比"生成不进撤销栈、但它出现在台账里"糟得多。
 *  生成要能追溯，靠的是 job 列表（`trackJob`）与后端任务表，那是另一套已经
 *  存在且更准确的东西。 */
const NO_COMMAND = new Set(["describe_timeline", "shot_versions", "generate_shots"]);

/** 拉当前项目的镜头列表。**只读能力用**（`describe_timeline`）。
 *
 *  走 `host.shots()` 而不是直接 `api`：镜头列表已经在界面内存里了，再打一次
 *  后端只会让"读一下时间轴"变成一次网络往返 —— 而 Agent 每改一步之前都要
 *  读一次，一次往返乘下来就是"AI 干活很慢"。 */
/** 界面内存里的镜头 → `describeTimeline` 要的只读数组。
 *  拷贝一份（`.slice()`）是刻意的：`describeTimeline` 内部已经不再改动入参，
 *  但传进去的是 store 里那个**活的**数组引用，把它的可变性暴露给一个纯函数
 *  迟早会有人在里面 `sort` 一下（原地 `sort` 会**直接改掉界面顺序**）。 */
function loadShots(host: AgentHost): TimelineShotView[] {
  return host.shots().slice();
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchOptions {
  /** 用户**这一次**已经同意执行的花钱/破坏性能力 id。
   *  ⚠️ 一次调用一填，不是一次会话一填 —— 理由见文件头"确认闸门"。 */
  confirmed?: readonly string[];
}

/**
 * 执行一个能力调用。
 *
 * 成功返回 `DispatchResult`（`ok` 恒为 true —— 失败一律抛异常，
 * 见 `DispatchError`）。**没有 `ok: false` 这个态**：一个既可能抛异常、
 * 又可能返回 `{ok:false}` 的接口，调用方一定会漏判一种。
 */
export async function dispatch(
  id: string,
  args: AgentArgs,
  host: AgentHost,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const cap = findCapability(id);
  if (!cap) throw new DispatchError(id, `没有叫「${id}」的能力。可用的能力见能力表，不要自己造名字。`);

  if (needsConfirm(cap) && !(opts.confirmed ?? []).includes(id)) {
    throw new NeedConfirm(cap);
  }

  const handler = HANDLERS[id];
  if (!handler) {
    // 说明书里有、手没有 —— 这是**开发期**的错误（`verify-agent.ts` 会拦），
    // 运行期出现说明验证没跑。给模型的话要能理解，给用户的话要能上报。
    throw new DispatchError(id, `能力「${id}」已在能力表里登记，但执行器还没实现它。请联系开发者。`);
  }

  let applied: Applied;
  try {
    applied = await handler(host, args, cap);
  } catch (e) {
    if (e instanceof NeedConfirm || e instanceof DispatchError) throw e;
    // 后端的 409 / 4xx 一律**不重试**：能力表里好几处写着"409 时不要重试，
    // 把文案交给用户"（unsplit 后半段单独生成过、undo_recut 中间段已付费），
    // 那不是暂时性故障，重试一百次还是 409。
    const msg = e instanceof Error ? e.message : String(e);
    throw new DispatchError(id, msg, false);
  }

  // 只读 / 生成：不入栈。但它们**不是**"忘了记账"——见 `NO_COMMAND`。
  if (NO_COMMAND.has(id) || !applied.draft) {
    return { ok: true, capability: id, data: applied.data, say: applied.say };
  }

  const cmd = host.pushCommand(applied.draft);
  // E4：合并过的命令的 `id` 是**栈顶那条**的（见 `command.ts` 的 `push` 注释）。
  // `merged` 靠比较 id 判出来 —— 不靠"步数大于 1"，因为一轮里第一步本来就
  // 可能是合并后的第一条（那时 id 与 step 数都对不上直觉）。
  return { ok: true, capability: id, command: cmd, merged: isMerged(cmd), data: applied.data, say: applied.say };
}

/** 这条命令是否是**合并产物**（`steps` 长度 > 1 说明至少并过一次）。 */
function isMerged(cmd: EditCommand): boolean {
  return (cmd.steps?.length ?? 0) > 1;
}

/** 能力表 ↔ 执行器 的交叉校验数据源（`verify-agent.ts` 用）。
 *  **导出成函数而不是常量**：常量会在模块初始化时就算好，而 `HANDLERS` 是
 *  字面量对象 —— 校验脚本要的正是"当前这两个字面量对不对得上"。 */
export function dispatchIds(): string[] {
  return Object.keys(HANDLERS);
}

/** 会进撤销栈的能力 id（`NO_COMMAND` 的补集）。 */
export function commandProducingIds(): string[] {
  return Object.keys(HANDLERS).filter((id) => !NO_COMMAND.has(id));
}

/** 确认闸门的判定结果，供 UI 在调用前问用户（不必先抛一次 `NeedConfirm`）。 */
export function confirmTextOf(id: string): string | null {
  const cap = findCapability(id);
  if (!cap || !needsConfirm(cap)) return null;
  return cap.confirmText ?? "这个操作会产生不可逆的后果或花费额度，确认执行吗？";
}

export { HANDLERS as _handlers };
