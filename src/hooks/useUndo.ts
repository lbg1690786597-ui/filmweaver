import { useCallback, useEffect, useRef } from "react";
import type { Say } from "./useToast";

/** G4 状态分层 · 编辑层：P2-2 撤销栈（Ctrl/⌘+Z 逐层回退）。
 *
 * 每项 = 标签 + 逆操作闭包。覆写拖拽的逆操作 = 反向 add/remove（与后端最小差集
 * 对消逻辑互为精确逆）；时长/顺序/停用的逆操作 = 回写旧值。栈深 30 防内存膨胀。 */
export function useUndo(say: Say) {
  const undoStack = useRef<{ label: string; undo: () => Promise<void> }[]>([]);

  const pushUndo = useCallback((label: string, undo: () => Promise<void>) => {
    undoStack.current.push({ label, undo });
    if (undoStack.current.length > 30) undoStack.current.shift();
  }, []);

  const doUndo = useCallback(async () => {
    const top = undoStack.current.pop();
    if (!top) { say("没有可撤销的操作"); return; }
    try {
      await top.undo();
      say(`↩ 已撤销：${top.label}`);
    } catch (e) { say(`撤销失败：${String(e)}`); }
  }, [say]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        const t = e.target as HTMLElement;
        // 输入框里的 Ctrl+Z 保留原生文本撤销
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
        e.preventDefault();
        void doUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doUndo]);

  /** P2-2：撤销栈按项目隔离，切项目即清空 */
  const clearUndo = useCallback(() => { undoStack.current = []; }, []);

  return { pushUndo, doUndo, clearUndo };
}
