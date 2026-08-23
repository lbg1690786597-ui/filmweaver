/**
 * ContextMenu — 通用右键菜单（PLAN §22）
 *
 * 时间轴 Clip / 资产段 / 素材卡共用。菜单项支持分组、危险项标红、禁用、
 * 快捷键提示。定位会自动避开视口边缘（菜单在右下角弹出时不被裁切）。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ContextMenu.css";

export interface MenuItem {
  id: string;
  label: string;
  /** lucide 图标元素 */
  icon?: React.ReactNode;
  keys?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** 分隔线：只需 { id, separator: true } */
  separator?: boolean;
  /** 子菜单（一级即可满足当前需求） */
  children?: MenuItem[];
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<string | null>(null);

  // 定位修正：菜单渲染后量出真实尺寸，超出视口就向内翻转
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x, ny = y;
    if (x + r.width > window.innerWidth - 8) nx = Math.max(8, x - r.width);
    if (y + r.height > window.innerHeight - 8) ny = Math.max(8, y - r.height);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // 延后一帧再挂，避免触发本次右键的那一下 click 立刻把菜单关掉
    const id = requestAnimationFrame(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
    });
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const renderItems = (list: MenuItem[], sub = false) => list.map((it) => {
    if (it.separator) return <div key={it.id} className="fw-cm-sep" />;
    const hasChildren = !!it.children?.length;
    return (
      <div key={it.id} className="fw-cm-item-wrap"
        onMouseEnter={() => setOpenSub(hasChildren ? it.id : null)}>
        <button
          className={`fw-cm-item ${it.danger ? "danger" : ""} ${hasChildren ? "has-sub" : ""}`}
          disabled={it.disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) return;
            it.onClick?.();
            onClose();
          }}>
          <span className="fw-cm-ico">{it.icon}</span>
          <span className="fw-cm-label">{it.label}</span>
          {it.keys && <span className="fw-cm-keys">{it.keys}</span>}
          {hasChildren && <span className="fw-cm-arrow">›</span>}
        </button>
        {hasChildren && openSub === it.id && !sub && (
          <div className="fw-cm fw-cm-sub">{renderItems(it.children!, true)}</div>
        )}
      </div>
    );
  });

  return (
    <div ref={ref} className="fw-cm" style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {renderItems(items)}
    </div>
  );
}
