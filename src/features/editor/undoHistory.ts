/**
 * 撤销记录的**展示层读法**（C3）。
 *
 * 为什么单独一个文件：这些是纯函数 —— 没有 store、没有 React、没有 lucide，
 * 所以 `scripts/verify-undo-history.ts` 能在 node 下把每条规则钉住。
 * 撤销历史面板的错误方式很安静：**"3 分钟前"算错没人会发现**，
 * 用户不会为了一句相对时间描述去报 bug，但"3 分前"和"2 小时前"摆在一起时
 * 他对这个列表的信任就没了 —— 而信任恰恰是这个面板唯一的价值。
 */
import type { EditCommand } from "../../lib/command";

/** 面板最多列多少条。与撤销上限（`C4` 起 100）**不是**同一个数：
 *  栈里可以有 100 条，但一次列 100 行用户是找不到东西的。
 *  超出的部分在末尾折叠成一句「还有 N 步更早的操作」。 */
export const HISTORY_VISIBLE = 30;

/** 相对时间。**分档要少**——这是一份"刚才做了什么"的清单，
 *  精度到秒没有意义，反而让每一行都在变（列表跳动比不精确更难忍）。 */
export function agoText(at: number, now: number = Date.now()): string {
  const d = now - at;
  // 时钟回拨 / 未来时间：不显示负数，也不显示"刚刚"以外的猜测
  if (!Number.isFinite(d) || d < 0) return "刚刚";
  const s = Math.floor(d / 1000);
  if (s < 45) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 1) return "1 分钟内";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 一条记录在面板里显示成什么。`steps` = 点它要连撤几步。 */
export interface HistoryRow {
  cmd: EditCommand;
  /** 相对时间文案 */
  ago: string;
  /** 点这一行 = 撤到**这一条之前**，所以要退的步数（1 起） */
  steps: number;
}

/**
 * 把撤销栈（老→新）翻成面板要的行（**新→老**，最近做的在最上面）。
 *
 * 三条规则，各有各的理由：
 *
 * 1. **倒序**。用户的记忆是"我刚才做了什么"，不是"我三小时前做了什么"。
 *    栈内部是正序的（数组末尾是栈顶），这里翻过来，别再让 UI 去翻。
 *
 * 2. **`steps` 是 1 起的连撤步数**：列表里第 i 行（0 起）要退 `i + 1` 步。
 *    这个数字直接喂给 `jumpBack`，不在 UI 里现算 —— 算错一次就是"点第 3 条
 *    撤了 4 步"，用户会以为软件在乱撤。
 *
 * 3. **截断在集合尾部**（最老的），不是头部。先砍掉用户最不可能点的那些。
 */
export function historyRows(
  undoStack: readonly EditCommand[],
  now: number = Date.now(),
  limit: number = HISTORY_VISIBLE,
): { rows: HistoryRow[]; hidden: number } {
  const total = undoStack.length;
  const rows: HistoryRow[] = [];
  for (let i = total - 1; i >= 0 && rows.length < limit; i--) {
    const cmd = undoStack[i];
    rows.push({ cmd, ago: agoText(cmd.at, now), steps: total - i });
  }
  return { rows, hidden: Math.max(0, total - rows.length) };
}

/** 重做栈同理，但**正序**：它表示"接下来会发生什么"，最近的（下一个要重做的）
 *  在最上面 —— 和撤销栈一样是"最相关的在最上面"。 */
export function redoRows(
  redoStack: readonly EditCommand[],
  now: number = Date.now(),
  limit: number = HISTORY_VISIBLE,
): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (let i = redoStack.length - 1; i >= 0 && out.length < limit; i--) {
    const cmd = redoStack[i];
    // steps 对重做栈是"连做几步"，从栈顶往下数
    out.push({ cmd, ago: agoText(cmd.at, now), steps: redoStack.length - i });
  }
  return out;
}

/**
 * 用户点了一条历史之后，把这句提示语说出来。
 *
 * 为什么要专门一个函数：**"撤销 1 步"和"撤销 5 步"必须听起来不一样**。
 * 只报最后那一条的 label（"已撤销：镜头 #3 移到 #5"）在最常见的用法下
 * 恰好是对的（点最上面那条 = 撤 1 步），但连撤 5 步时用户会以为只撤了 1 步，
 * 而实际上**界面已经跳了 5 个状态**——他会怀疑点错了、再去手动补几下。
 */
export function jumpToast(n: number, lastLabel: string): string {
  if (n <= 0) return "已经是这里了";
  if (n === 1) return `↩ 已撤销：${lastLabel}`;
  return `↩ 已撤销 ${n} 步（到「${lastLabel}」之前）`;
}
