import { useCallback, useState } from "react";

/** G4 状态分层 · UI 反馈层：全局 toast。 */
export type Say = (msg: string, ms?: number) => void;

export function useToast() {
  const [toast, setToast] = useState("");
  const say: Say = useCallback((msg: string, ms = 4000) => {
    setToast(msg);
    setTimeout(() => setToast(""), ms);
  }, []);
  const clearToast = useCallback(() => setToast(""), []);
  return { toast, say, clearToast };
}
