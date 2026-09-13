/**
 * ledger.ts — 变更台账 + **按轮次分组撤销**（批次 E4，PLAN §2.5.3 配套三 / §2.5.4）
 *
 * ## 用户的期待只有一句话
 *
 * 「把 AI 刚才那一整轮撤销掉」，**而不是按 15 次 Ctrl+Z**。
 *
 * 所以这里做的不是"记账"，而是**把一轮 Agent 的 N 条命令变成撤销栈上的 1 条**。
 * 台账只是同一件事的副产品（出问题时能复盘"AI 到底干了什么"）。
 *
 * ## 为什么分组发生在**入栈时**，而不是撤销时
 *
 * 想过另一条路：命令照旧一条条入栈，撤销时按 `turnId` 把连续的几条一起撤。
 * 否掉的原因是**它会打破栈深与"能退几步"的对应**：用户看到历史面板上
 * 写着 30 条，实际每按一次 Ctrl+Z 退的是 3 条 —— 面板从"能力表"变成"谎话"。
 * 入栈即合并之后，**栈里一条就是界面上一行，也是 Ctrl+Z 一次**，
 * 三者重新对齐（Kdenlive 的 `logUndo` 批量抑制就是这个思路）。
 *
 * ## ⚠️ 合并只发生在一个 `turnId` 内部
 *
 * 人手动操作（`origin.by === "user"`）**永不合并** —— 用户连着改三个镜头的
 * 时长，那是三次可以分别退的操作，合并掉就等于把他 Ctrl+Z 的粒度弄粗了。
 * 只有 Agent 的一轮才是一个事务。这是本模块唯一的策略判断，写在这里防止
 * 后来者为了"少几行记录"把人的操作也并进去。
 */

import type { CommandScope } from "../command";

/** 一条台账记录：命令的**元数据快照**，不含闭包。
 *
 *  ⚠️ 刻意不存 `run` / `unrun`：台账要能序列化落盘、要能跨会话读回来复盘，
 *  存函数就成了"看起来能存其实存不了"的假象。要重放请用命令 id 去栈里找
 *  （`commandStore.find`），找不到就说找不到。 */
export interface LedgerEntry {
  /** 命令 id（`EditCommand.id`），用于回栈里找原命令 */
  commandId: string;
  turnId: string | null;
  /** 人话标签（与命令的 `label` 一致），面板直接显示 */
  label: string;
  kind: string;
  /** 影响面（合并后的命令要在台账里展开成原来的分条，见 `record`） */
  affected: CommandScope;
  at: number;
  /** 台账号。合并进一条命令的多条记录共享同一个 `groupSeq` */
  groupSeq: number;
}

export interface LedgerTurn {
  turnId: string;
  /** 这一轮的第一条命令入栈时刻 / 最后一条 */
  startedAt: number;
  endedAt: number;
  entries: LedgerEntry[];
}

const MAX_ENTRIES = 500;

let seq = 0;
let group = 0;
let entries: LedgerEntry[] = [];
/** turnId → 这一轮已经用的 groupSeq。一个 turn 内的所有命令共享一个组号。 */
const turnGroup = new Map<string, number>();

/**
 * 记一笔。**由 `commandStore.push` 调用**，调用方不需要手动记 ——
 * "忘了记台账"这种缺口在 Agent 场景下等于"AI 改了东西但查不到"，代价太高，
 * 所以不提供"手动记账"的入口。
 *
 * @returns 本条的 `groupSeq`。同一个 `turnId` 恒返回同一个值 ——
 *   `commandStore` 靠它判断"这条要不要与前一条合并"。
 */
export function record(e: Omit<LedgerEntry, "groupSeq">): number {
  const g = e.turnId ? reserveGroup(e.turnId) : nextGroup();
  entries.push({ ...e, groupSeq: g });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  return g;
}

/** 取这一轮已经分配过的组号；没有就分配一个新的。 */
export function reserveGroup(turnId: string): number {
  const hit = turnGroup.get(turnId);
  if (hit !== undefined) return hit;
  const g = nextGroup();
  turnGroup.set(turnId, g);
  return g;
}

/** 人与 AI 共用的组号发号器。人和 AI 的组号从同一个计数器出，
 *  所以"组号"在台账里是**单调递增的时间线**，把两种来源的先后关系也带上了。 */
function nextGroup(): number {
  group += 1;
  return group;
}

/** 取某条命令入栈时所在的组号；没有记录返回 `null`。
 *
 *  `push` 用它判断"上一条命令与本条同组吗"。**查的是台账而不是命令本身** ——
 *  命令上多挂一个 `groupSeq` 字段会让"命令"这个类型沾上台账的生命周期，
 *  而台账是可以被裁掉/清空的。 */
export function groupOf(commandId: string): number | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.commandId === commandId) return e.groupSeq;
  }
  return null;
}

/** 最近一条记录的组号（栈顶命令用）。栈被裁到 100 条时台账更长，仍能对上。 */
export function lastGroup(): number | null {
  return entries.length ? entries[entries.length - 1].groupSeq : null;
}

/** 全部记录（老→新）。面板倒着读。 */
export function allEntries(): readonly LedgerEntry[] {
  return entries;
}

/** 按轮次归拢，给"AI 干了什么"的复盘视图用。**最近一轮在最前。** */
export function byTurn(): LedgerTurn[] {
  const map = new Map<string, LedgerTurn>();
  for (const e of entries) {
    if (!e.turnId) continue;
    let t = map.get(e.turnId);
    if (!t) {
      t = { turnId: e.turnId, startedAt: e.at, endedAt: e.at, entries: [] };
      map.set(e.turnId, t);
    }
    t.entries.push(e);
    t.startedAt = Math.min(t.startedAt, e.at);
    t.endedAt = Math.max(t.endedAt, e.at);
  }
  return [...map.values()].sort((a, b) => b.endedAt - a.endedAt);
}

/** 某一轮改了哪些镜头 / 素材（去重）。面板上那行"改动了 12 个镜头"读它。 */
export function scopeOfTurn(turnId: string): Required<CommandScope> {
  const shots = new Set<string>();
  const assets = new Set<string>();
  for (const e of entries) {
    if (e.turnId !== turnId) continue;
    for (const s of e.affected.shots ?? []) shots.add(s);
    for (const a of e.affected.assets ?? []) assets.add(a);
  }
  return { shots: [...shots], assets: [...assets] };
}

/** 一轮的命令 id 列表（老→新）。撤销时按**倒序**逐条 unrun。 */
export function commandIdsOfTurn(turnId: string): string[] {
  return entries.filter((e) => e.turnId === turnId).map((e) => e.commandId);
}

/** 清空（切项目时与撤销栈一起清）。
 *
 *  ⚠️ `turnGroup` 必须一起清，否则切回同一个项目、后端给的 `turnId` 恰好复用时
 *  （比如"第 1 轮"这种自增 id），新一轮的命令会**并进上一轮的组号**，
 *  表现是"新的一轮 AI 操作撤不掉/多撤了几步"，且完全看不出原因。 */
export function clear(): void {
  entries = [];
  turnGroup.clear();
  seq = 0;
  group = 0;
}

/** 计数（验证脚本与状态栏用） */
export function size(): number {
  return entries.length;
}

/** 新 turnId。形如 `turn-3-l8x2`：**人可读 + 进程内不撞**。
 *
 *  不用纯随机串是因为它要显示在撤销历史那一行上
 *  （`AI：按节奏重排第 3 场（改动了 12 个镜头）` 的复核视图里要能对上号），
 *  纯 uuid 对不上"这是第几轮"。 */
export function newTurnId(): string {
  seq += 1;
  return `turn-${seq}-${Math.random().toString(36).slice(2, 6)}`;
}
