/**
 * WindowControls — 自定义标题栏的窗口按钮（最小化 / 最大化-还原 / 关闭）
 *
 * ## 为什么要自己画
 *
 * `tauri.conf.json` 里 `decorations: false` 关掉了 Windows 原生标题栏——
 * 那条白色系统栏是"这是个网页套壳"观感的最大来源。关掉之后，
 * 三个窗口按钮就得自己提供，否则用户没法最小化/关闭。
 *
 * ## Web 预览必须降级
 *
 * 开发时用浏览器预览（http://…:9080/fw/app/），那里没有 Tauri runtime，
 * `getCurrentWindow()` 会抛错。所以整个组件在非 Tauri 环境直接不渲染——
 * 不是渲染出来点了报错，是压根不出现（浏览器标签页也不需要这三个按钮）。
 *
 * ## 权限
 *
 * Tauri v2 的窗口操作需要在 capabilities 里显式声明，`core:default` **不含**
 * minimize/toggle-maximize/close。见 src-tauri/capabilities/default.json —
 * 少声明一条，点下去就是 permission denied，且只在打包后才暴露。
 */

import { useEffect, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import { IS_TAURI } from "../export/ExportDialog";
import "./WindowControls.css";

/** 懒加载 window API：顶层 import 会让浏览器预览在模块解析期就失败 */
async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) return;
    let un: (() => void) | undefined;
    void (async () => {
      const w = await win();
      setMaximized(await w.isMaximized());
      // 监听尺寸变化：用户拖四边、双击标题栏、按 Win+↑ 都会改变最大化状态，
      // 只在点自己的按钮时切图标会和实际状态脱节
      un = await w.onResized(async () => setMaximized(await w.isMaximized()));
    })();
    return () => un?.();
  }, []);

  // 浏览器预览：不渲染。见文件头说明。
  if (!IS_TAURI) return null;

  return (
    <div className="fw-wc">
      <button className="fw-wc-btn" title="最小化"
        onClick={() => void win().then((w) => w.minimize())}>
        <Minus size={15} />
      </button>
      <button className="fw-wc-btn" title={maximized ? "向下还原" : "最大化"}
        onClick={() => void win().then((w) => w.toggleMaximize())}>
        {/* 还原态用双叠方块，与 Windows 原生图标语义一致 */}
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button className="fw-wc-btn close" title="关闭"
        onClick={() => void win().then((w) => w.close())}>
        <X size={15} />
      </button>
    </div>
  );
}
