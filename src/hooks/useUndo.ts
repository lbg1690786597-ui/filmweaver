import { useCallback } from "react";
import type { Say } from "./useToast";
import { useTimelineStore } from "../stores/timelineStore";
import type { CommandDraft } from "../lib/command";

/** G4 状态分层 · 编辑层：撤销栈（Ctrl/⌘+Z 回退，Ctrl+Y / Ctrl+Shift+Z 重做）。
 *
 * ## 为什么这里只是个转发层
 *
 * 曾经有**两套互不相通**的撤销栈：
 *   · 本 hook 自己的 ref 栈 —— 所有 pushUndo 调用实际进的是它
 *   · useTimelineStore 的 undoStack/redoStack —— 从未被 push 过
 *
 * 而顶栏（TopBar）和时间轴工具条的撤销/重做按钮读的都是 **store 那一套**，
 * 于是它们永远置灰、点了没反应；Ctrl+Z 之所以还能用，纯粹因为本 hook
 * 另外挂了一个 window keydown。重做则完全没实现（ref 栈没有 redo）。
 *
 * 现在统一：入栈/出栈全部走 store，本 hook 只保留键盘绑定与 toast 提示。
 * 这样按钮的 disabled 状态、快捷键、时间轴工具条自然是同一份真相。
 *
 * ## C1 → C2：适配层已经**撤掉**
 *
 * C1 时栈里装的东西从 `UndoEntry` 换成 `EditCommand`（`lib/command.ts`），
 * 但 18 个调用点还按老签名写 `pushUndo(label, undo, redo?)`，于是本 hook 临时
 * 兼做翻译机（`draftFromLegacy`）。C2 把 18 处全改成对象字面量之后，翻译机没有
 * 输入了 —— 翻译机 `draftFromLegacy` 与入参别名 `UndoEntry` 一并删除，
 * 本 hook 退回成纯粹的转发层（`notReversibleRun` 留着，理由见 `lib/command.ts`）。
 *
 * 顺带消失的两个隐患（都不是"重构顺手清掉"，而是**迁移本身就是修 bug**）：
 *
 * | | 迁移前 | 迁移后 |
 * |---|---|---|
 * | `redo` 忘了传 | 静默退化：撤得回、重做点了只出一行字 | 写 `reversible: false` 要显式打出来，漏写是缺字段 → **tsc 报错** |
 * | 形状判别 | store 里运行期 `"undo" in e`，从别处直接调 store 能绕过去 | 类型上只收 `CommandDraft`，**编译期**就拒收 |
 *
 * ⚠️ `say` 必须真实传进来，且 `doRedo` 里那个 `!top.reversible` 分支**不能删**：
 * 不可重做的命令其 `run` 是 `notReversibleRun` 生成的桩（见 `lib/command.ts`）——
 * 理由是"按钮亮着却点了毫无反应，比按钮灰着更让人困惑"（教训见原实现的注释）。
 * 现在 18 处全都写了 `run`，`irreversibleCount()` 应为 0；但只要有**一条**历史
 * 命令是不可重做的（比如以后新加的入口忘了写 `run`），这个分支就是它的兜底。
 */
export function useUndo(say: Say) {
  const pushUndo = useCallback((draft: CommandDraft) => {
    useTimelineStore.getState().pushUndo(draft);
  }, []);

  const doUndo = useCallback(async () => {
    const st = useTimelineStore.getState();
    const top = st.undoStack[st.undoStack.length - 1];
    if (!top) { say("没有可撤销的操作"); return; }
    try {
      await st.undo();
      say(`↩ 已撤销：${top.label}`);
    } catch (e) { say(`撤销失败：${String(e)}`); }
  }, [say]);

  const doRedo = useCallback(async () => {
    const st = useTimelineStore.getState();
    const top = st.redoStack[st.redoStack.length - 1];
    if (!top) { say("没有可重做的操作"); return; }
    // ⚠️ `reversible: false` 的命令，redo 执行的是 `notReversibleRun` 那个桩 ——
    // 它自己会 toast，所以这里**必须 return**，不能再补一句，否则同一条提示弹
    // 两遍。而这个提前 return 本身也是必要的：桩是"正常 resolve"的，不拦的话
    // 下面那句 `已重做：X` 会照样说出来，用户以为重做成了。
    if (!top.reversible) {
      try { await st.redo(); } catch (e) { say(`重做失败：${String(e)}`); }
      return;
    }
    try {
      await st.redo();
      say(`↪ 已重做：${top.label}`);
    } catch (e) { say(`重做失败：${String(e)}`); }
  }, [say]);

  // ⚠️ 这里**不再**自挂 window keydown。
  //
  // Ctrl+Z 的键位归 commands/index.ts 的 `edit.undo` 统一管（那里还负责
  // 输入框豁免、与其他快捷键的优先级）。本 hook 曾另挂一个监听，结果是
  // 一次 Ctrl+Z 触发两个 handler、连弹**两条**撤销记录——用户以为撤销了
  // 一步，实际退了两步，且多退的那步没有任何提示，属于静默数据丢失。
  // App 把 useCommands 的 undo/redo 指到下面的 doUndo/doRedo 即可。

  /** 撤销栈按项目隔离，切项目即清空 */
  const clearUndo = useCallback(() => {
    useTimelineStore.getState().clearUndo();
  }, []);

  return { pushUndo, doUndo, doRedo, clearUndo };
}
