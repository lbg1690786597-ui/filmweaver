import { useCallback } from "react";
import type { Say } from "./useToast";
import { useTimelineStore } from "../stores/timelineStore";

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
 */
export function useUndo(say: Say) {
  const pushUndo = useCallback(
    (label: string, undo: () => Promise<void>, redo?: () => Promise<void>) => {
      useTimelineStore.getState().pushUndo({
        label,
        undo,
        // 调用方没给 redo 时给一个明确提示，而不是静默什么都不做 ——
        // 按钮是亮的却点了没反应，比按钮灰着更让人困惑。
        redo: redo ?? (() => { say(`「${label}」暂不支持重做`); }),
      });
    }, [say]);

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
