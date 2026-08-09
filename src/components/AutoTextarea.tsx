import { TextareaHTMLAttributes, useCallback, useEffect, useRef } from "react";

/** 自动增高文本框：高度跟随内容变化，封顶后内部滚动（防超出画面）。
 *
 *  修复背景：.drawer-ta 原有 flex:1 在 .wizard label（flex column）里接管了高度，
 *  原生 resize 手柄被卡死。本组件改为脚本控高（height=scrollHeight），
 *  minHeight 起步、maxHeight 封顶（默认视口 38%，弹窗内不会顶出屏幕），
 *  同时保留 resize: vertical——手动拉高后自动增高只增不减（尊重用户拉的高度）。
 */
type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** 起始高度 px（默认 64） */
  minHeight?: number;
  /** 封顶高度；数字=px，缺省=视口高的 38%（防弹窗溢出） */
  maxHeight?: number;
};

export default function AutoTextarea({ minHeight = 64, maxHeight, style, onChange, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const manualH = useRef(0);   // 用户手动拉出的高度（resize 手柄），自动增高不小于它

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const cap = maxHeight ?? Math.round(window.innerHeight * 0.38);
    // 先收到 minHeight 量 scrollHeight，再按内容/手动高度取大者，封顶 cap
    el.style.height = `${minHeight}px`;
    const want = Math.max(el.scrollHeight, minHeight, manualH.current);
    const h = Math.min(want, cap);
    el.style.height = `${h}px`;
    el.style.overflowY = want > cap ? "auto" : "hidden";
  }, [minHeight, maxHeight]);

  // 初始与受控 value 变化（含外部 setState）都重新量高
  useEffect(() => { fit(); });

  return (
    <textarea ref={ref} {...rest}
      style={{ ...style, minHeight, resize: "vertical" }}
      onChange={(e) => { onChange?.(e); fit(); }}
      onMouseUp={() => {
        // resize 手柄松手：记录用户拉出的高度（只记比内容更高的，缩回交给内容驱动）
        const el = ref.current;
        if (el) manualH.current = el.offsetHeight;
      }} />
  );
}
