import { useCallback, useEffect, useRef, useState } from "react";

/** 尺寸上限：常数或动态函数（如 () => window.innerHeight - 100，支持拖到近全屏）。 */
type MaxSpec = number | (() => number);

/** 可拖拽分隔条：拖动调整相邻面板尺寸（写入 CSS 变量，localStorage 记忆）。
 *  max 传函数时每次拖拽实时求值，窗口尺寸变化后上限自动跟随。
 *  返回的 reset() 用于双击分隔条恢复默认尺寸。 */
export function useResizable(varName: string, initial: number, min: number, max: MaxSpec,
                             horizontal = true) {
  const maxOf = useCallback(() => (typeof max === "function" ? max() : max), [max]);
  const [size, setSize] = useState<number>(() => {
    const saved = Number(localStorage.getItem(`fw_sz_${varName}`));
    // 上限可能随窗口变化，读档时只校验下限，超限由 resize 收敛
    return saved && saved >= min ? saved : initial;
  });
  useEffect(() => {
    document.documentElement.style.setProperty(`--${varName}`, `${size}px`);
    localStorage.setItem(`fw_sz_${varName}`, String(size));
  }, [size, varName]);

  // 窗口缩小后把超出新上限的尺寸收回来（否则面板溢出视口）
  useEffect(() => {
    const onResize = () => setSize((s) => Math.min(s, Math.max(min, maxOf())));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min, maxOf]);

  const dragging = useRef(false);
  const start = useRef(0);
  const startSize = useRef(0);
  const dirRef = useRef(1);

  const onMouseDown = useCallback((e: React.MouseEvent, dir: 1 | -1 = 1) => {
    dragging.current = true;
    dirRef.current = dir;
    start.current = horizontal ? e.clientX : e.clientY;
    startSize.current = size;
    const limit = Math.max(min, maxOf());   // 本次拖拽的上限（按下时求值）
    document.body.style.userSelect = "none";
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    const move = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start.current) * dirRef.current;
      setSize(Math.max(min, Math.min(limit, startSize.current + delta)));
    };
    const up = () => {
      dragging.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [size, min, maxOf, horizontal]);

  const reset = useCallback(() => setSize(initial), [initial]);

  return { size, onMouseDown, reset };
}
