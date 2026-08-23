/**
 * EditorLayout — 四区编辑器骨架（PLAN Phase 1）
 *
 * 布局（CSS Grid）：
 *   ┌────────────────────────────────────────────┐
 *   │ TopBar                                     │
 *   ├──────┬──────────┬──────────────┬───────────┤
 *   │ Rail │ LeftPanel│   Player     │ Inspector │
 *   ├──────┴──────────┴──────────────┴───────────┤
 *   │ TimelineDock                               │
 *   └────────────────────────────────────────────┘
 *
 * Rail 固定宽；LeftPanel / Inspector / Dock 尺寸可拖拽（CSS 变量 + localStorage）。
 */

import { ReactNode, useEffect, useState } from "react";
import { useEditorStore } from "../../stores/editorStore";
import { useResizable } from "../../lib/useResizable";
import { IS_TAURI } from "../export/ExportDialog";
import "./EditorLayout.css";

interface Props {
  topBar: ReactNode;
  rail: ReactNode;
  leftPanel: ReactNode;
  player: ReactNode;
  inspector: ReactNode;
  dock: ReactNode;
  /** 顶部横幅（toast / 更新提示 / 进度条等） */
  banners?: ReactNode;
  /** 弹窗层 */
  overlays?: ReactNode;
}

export default function EditorLayout(p: Props) {
  const maximized = useEditorStore((s) => s.maximizedPanel);

  // 窗口最大化时去掉那圈 inset 描边（见 EditorLayout.css）。
  // decorations:false 后窗口没有系统外框，平时靠描边划出边界，
  // 但贴满屏幕还画线就显得脏。
  const [winMax, setWinMax] = useState(false);
  useEffect(() => {
    if (!IS_TAURI) return;
    let un: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      setWinMax(await w.isMaximized());
      un = await w.onResized(async () => setWinMax(await w.isMaximized()));
    })();
    return () => un?.();
  }, []);

  // 上限动态取窗口尺寸：可拖至接近全屏（留出最小可用空间）；双击分隔条恢复默认
  // 第 5 个参数是**拖拽轴向**，由被调整的尺寸决定（宽→x，高→y），
  // 与分隔条朝向、拖动方向都无关；方向取反是 onMouseDown 的 dir 参数。
  // 此前 inspector-w 误传 false（当时是 horizontal 布尔位），
  // 导致拖 Inspector 左边缘时读的是 clientY —— 要上下拖才能左右伸缩。
  const panelResize = useResizable("panel-w", 300, 220, () => window.innerWidth - 480, "x");
  const inspectorResize = useResizable(
    "inspector-w", 300, 240, () => window.innerWidth - 560, "x");
  const dockResize = useResizable("dock-h", 260, 120, () => window.innerHeight - 200, "y");

  return (
    <div className={`fw-editor ${maximized ? `max-${maximized}` : ""}`
      + `${winMax ? " win-maximized" : ""}`}>
      <header className="fw-topbar">{p.topBar}</header>

      {/* 横幅层：绝对定位悬浮在顶栏下方，不占 grid 行——否则 toast 一出现
          整个四区就会被向下挤一行，播放器高度跟着跳。 */}
      <div className="fw-banners">{p.banners}</div>

      <div className="fw-mid">
        <nav className="fw-rail">{p.rail}</nav>

        <aside className="fw-panel">{p.leftPanel}</aside>
        <div className="fw-rz fw-rz-v" title="拖动调整宽度 · 双击恢复默认"
          onMouseDown={(e) => panelResize.onMouseDown(e, 1)}
          onDoubleClick={panelResize.reset} />

        <main className="fw-player">{p.player}</main>

        <div className="fw-rz fw-rz-v" title="拖动调整宽度 · 双击恢复默认"
          onMouseDown={(e) => inspectorResize.onMouseDown(e, -1)}
          onDoubleClick={inspectorResize.reset} />
        <aside className="fw-inspector">{p.inspector}</aside>
      </div>

      <div className="fw-rz fw-rz-h" title="拖动调整高度 · 双击恢复默认"
        onMouseDown={(e) => dockResize.onMouseDown(e, -1)}
        onDoubleClick={dockResize.reset} />
      <section className="fw-dock">{p.dock}</section>

      {p.overlays}
    </div>
  );
}
