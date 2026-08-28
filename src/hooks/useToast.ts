import { useCallback, useEffect, useRef, useState } from "react";

/** G4 状态分层 · UI 反馈层：全局 toast。 */
export type Say = (msg: string, ms?: number) => void;

export function useToast() {
  const [toast, setToast] = useState("");
  // 上一条的隐藏定时器。不取消的话连发两条会出问题：
  // 第一条的 setTimeout 到点后把**第二条**清掉了，第二条只显示了很短时间。
  const timer = useRef<number | null>(null);

  const say: Say = useCallback((msg: string, ms = 4000) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(msg);
    timer.current = window.setTimeout(() => {
      setToast("");
      timer.current = null;
    }, ms);
  }, []);

  const clearToast = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setToast("");
  }, []);

  // 卸载时清掉，避免对已卸载组件 setState
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { toast, say, clearToast };
}
