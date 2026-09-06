/**
 * commands/index.ts — 全局快捷键 Command 系统（PLAN §23）
 *
 * 为什么要有这一层：旧版每个组件各自 addEventListener("keydown")，
 * 结果是 Space 在播放器里是播放、在时间轴里可能被别的 handler 抢走，
 * 且没有一处能列出"这个软件到底有哪些快捷键"。
 *
 * 现在：所有命令在这里注册（id + 快捷键 + 处理函数），useCommands 挂一个
 * 全局监听器统一分发。设置页要展示快捷键表、后续要支持自定义映射，
 * 都只读这一份注册表。
 */

import { useEffect, useRef } from "react";
import { useTimelineStore } from "../stores/timelineStore";

export interface Command {
  id: string;
  label: string;
  /** 显示用的快捷键文本（设置页/菜单里展示） */
  keys: string;
  /** 匹配函数：给定事件判断是否命中本命令 */
  match: (e: KeyboardEvent) => boolean;
  run: () => void;
  /** 输入框聚焦时是否仍然生效（默认 false：文本输入优先） */
  allowInInput?: boolean;
}

/** 事件是否发生在文本输入类元素上——此时绝大多数快捷键必须让位 */
export function isTextInput(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

/** 命令处理函数集合：由 App 提供具体实现 */
export interface CommandHandlers {
  playPause: () => void;
  playFromStart: () => void;
  cursorToPlayhead: () => void;
  undo: () => void;
  redo: () => void;
  copy: () => void;
  paste: () => void;
  cut: () => void;
  deleteSelected: () => void;
  splitAtPlayhead: () => void;
  nudgeLeft: (big: boolean) => void;
  nudgeRight: (big: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  escape: () => void;
  selectAll: () => void;
  /** `[` / `]`：以播放头为界选中一侧全部片段。
   *
   *  3.5：这里原本是本文件里的一个私有函数，与 `Timeline.tsx` 里的工具条按钮
   *  各写一份 —— 两份逻辑同源却不同步（时间轴那份多一个 toast、还顺手写了
   *  另一套选中态），改一处必漏一处。现在都收敛到 App 的同一个实现上，
   *  判据统一在 `features/timeline/selection.ts`。 */
  selectSide: (side: "left" | "right") => void;
  toggleDisabled: () => void;

  // ---- 3.3 播放头导航 ----
  /** Home / End：跳到时间轴两端 */
  playheadToStart: () => void;
  playheadToEnd: () => void;
  /** ↑ / ↓：跳到上/下一个片段边界（Premiere 的 edit point 语义） */
  prevEdge: () => void;
  nextEdge: () => void;
  /** J / L / K：快退 / 快进 / 停。dir=-1 是 J，+1 是 L */
  shuttle: (dir: -1 | 1) => void;
  shuttleStop: () => void;
  /** I / O：把播放头处设为当前镜头的入点 / 出点 */
  setIn: () => void;
  setOut: () => void;
}

export function buildCommands(h: CommandHandlers): Command[] {
  return [
    {
      id: "play.toggle", label: "播放 / 暂停", keys: "Space",
      match: (e) => e.code === "Space" && !e.shiftKey && !mod(e),
      run: h.playPause,
    },
    {
      id: "play.fromStart", label: "从头播放", keys: "Shift+Space",
      match: (e) => e.code === "Space" && e.shiftKey && !mod(e),
      run: h.playFromStart,
    },
    {
      id: "cursor.toPlayhead", label: "定位线吸到播放位置", keys: "S",
      match: (e) => e.key.toLowerCase() === "s" && !mod(e) && !e.shiftKey,
      run: h.cursorToPlayhead,
    },
    {
      id: "edit.undo", label: "撤销", keys: "Ctrl+Z",
      match: (e) => mod(e) && e.key.toLowerCase() === "z" && !e.shiftKey,
      run: h.undo,
    },
    {
      id: "edit.redo", label: "重做", keys: "Ctrl+Y / Ctrl+Shift+Z",
      match: (e) => mod(e) && (e.key.toLowerCase() === "y"
        || (e.key.toLowerCase() === "z" && e.shiftKey)),
      run: h.redo,
    },
    {
      id: "edit.copy", label: "复制", keys: "Ctrl+C",
      match: (e) => mod(e) && e.key.toLowerCase() === "c",
      run: h.copy,
    },
    {
      id: "edit.paste", label: "粘贴", keys: "Ctrl+V",
      match: (e) => mod(e) && e.key.toLowerCase() === "v",
      run: h.paste,
    },
    {
      id: "edit.cut", label: "剪切", keys: "Ctrl+X",
      match: (e) => mod(e) && e.key.toLowerCase() === "x",
      run: h.cut,
    },
    {
      id: "edit.selectAll", label: "全选镜头", keys: "Ctrl+A",
      match: (e) => mod(e) && e.key.toLowerCase() === "a",
      run: h.selectAll,
    },
    {
      id: "edit.delete", label: "删除选中", keys: "Delete",
      match: (e) => e.key === "Delete" || e.key === "Backspace",
      run: h.deleteSelected,
    },
    // ---- 工具切换（单键，与已有的 S / D 同风格）----
    // 直接操作 store：这两个纯粹是 UI 状态，不需要经 App 的 handler 中转。
    {
      id: "tool.select", label: "选择工具", keys: "A",
      match: (e) => e.key.toLowerCase() === "a" && !mod(e) && !e.shiftKey,
      run: () => useTimelineStore.getState().setTool("select"),
    },
    {
      id: "tool.split", label: "分割工具", keys: "B",
      match: (e) => e.key.toLowerCase() === "b" && !mod(e) && !e.shiftKey,
      run: () => useTimelineStore.getState().setTool("split"),
    },
    {
      id: "select.left", label: "选中播放头左侧全部", keys: "[",
      match: (e) => e.key === "[" && !mod(e),
      run: () => h.selectSide("left"),
    },
    {
      id: "select.right", label: "选中播放头右侧全部", keys: "]",
      match: (e) => e.key === "]" && !mod(e),
      run: () => h.selectSide("right"),
    },
    {
      id: "edit.split", label: "在播放头分割", keys: "Ctrl+B",
      match: (e) => mod(e) && e.key.toLowerCase() === "b",
      run: h.splitAtPlayhead,
    },
    {
      id: "edit.toggleDisabled", label: "停用 / 启用选中", keys: "D",
      match: (e) => e.key.toLowerCase() === "d" && !mod(e) && !e.shiftKey,
      run: h.toggleDisabled,
    },
    {
      id: "playhead.left", label: "播放头左移", keys: "← / Shift+←",
      match: (e) => e.key === "ArrowLeft" && !mod(e),
      run: () => h.nudgeLeft(false),
    },
    {
      id: "playhead.right", label: "播放头右移", keys: "→ / Shift+→",
      match: (e) => e.key === "ArrowRight" && !mod(e),
      run: () => h.nudgeRight(false),
    },
    // ---- 3.3 播放头导航 ----
    // ↑/↓ 取 Premiere 的 edit point 语义（跳片段边界），不取剪映的"换轨道"——
    // 本项目的镜头全在同一条主轨上，换轨道无处可去。
    {
      id: "playhead.prevEdge", label: "上一个片段边界", keys: "↑",
      match: (e) => e.key === "ArrowUp" && !mod(e),
      run: h.prevEdge,
    },
    {
      id: "playhead.nextEdge", label: "下一个片段边界", keys: "↓",
      match: (e) => e.key === "ArrowDown" && !mod(e),
      run: h.nextEdge,
    },
    {
      id: "playhead.home", label: "跳到片头", keys: "Home",
      match: (e) => e.key === "Home" && !mod(e),
      run: h.playheadToStart,
    },
    {
      id: "playhead.end", label: "跳到片尾", keys: "End",
      match: (e) => e.key === "End" && !mod(e),
      run: h.playheadToEnd,
    },
    // J-K-L：剪辑行业的通用手势。连按同向加倍（1→2→4），按反向先停。
    {
      id: "shuttle.reverse", label: "快退（连按加速）", keys: "J",
      match: (e) => e.key.toLowerCase() === "j" && !mod(e) && !e.shiftKey,
      run: () => h.shuttle(-1),
    },
    {
      id: "shuttle.stop", label: "停止", keys: "K",
      match: (e) => e.key.toLowerCase() === "k" && !mod(e) && !e.shiftKey,
      run: h.shuttleStop,
    },
    {
      id: "shuttle.forward", label: "快进（连按加速）", keys: "L",
      match: (e) => e.key.toLowerCase() === "l" && !mod(e) && !e.shiftKey,
      run: () => h.shuttle(1),
    },
    // I/O 直接复用 3.1/3.2 的修剪通路（trimIn/trimOut + 同一条撤销记录），
    // 所以键盘改出来的窗口与拖边缘改出来的**逐字节相同**。
    {
      id: "trim.setIn", label: "设为入点", keys: "I",
      match: (e) => e.key.toLowerCase() === "i" && !mod(e) && !e.shiftKey,
      run: h.setIn,
    },
    {
      id: "trim.setOut", label: "设为出点", keys: "O",
      match: (e) => e.key.toLowerCase() === "o" && !mod(e) && !e.shiftKey,
      run: h.setOut,
    },
    {
      id: "zoom.in", label: "时间轴放大", keys: "Ctrl + =",
      match: (e) => mod(e) && (e.key === "=" || e.key === "+"),
      run: h.zoomIn,
    },
    {
      id: "zoom.out", label: "时间轴缩小", keys: "Ctrl + -",
      match: (e) => mod(e) && e.key === "-",
      run: h.zoomOut,
    },
    {
      id: "zoom.fit", label: "适配全宽", keys: "Ctrl + 0",
      match: (e) => mod(e) && e.key === "0",
      run: h.zoomFit,
    },
    {
      id: "ui.escape", label: "清除选中 / 关闭弹窗", keys: "Esc",
      match: (e) => e.key === "Escape",
      run: h.escape,
      allowInInput: true,
    },
  ];
}

/** 挂载全局快捷键监听。handlers 变化时自动重绑（用 ref 避免闭包过期）。 */
export function useCommands(handlers: CommandHandlers, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const cmds = buildCommands(ref.current);
      const inInput = isTextInput(e.target);
      for (const c of cmds) {
        if (inInput && !c.allowInInput) continue;
        if (!c.match(e)) continue;
        // Shift+方向键 = 大步长，在此统一处理（避免注册表里再拆两条）
        if (c.id === "playhead.left") { e.preventDefault(); ref.current.nudgeLeft(e.shiftKey); return; }
        if (c.id === "playhead.right") { e.preventDefault(); ref.current.nudgeRight(e.shiftKey); return; }
        e.preventDefault();
        c.run();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** 供设置页/帮助面板列出全部快捷键（不需要真实 handlers） */
export function listCommandKeys(): { label: string; keys: string }[] {
  const noop = () => {};
  const dummy: CommandHandlers = {
    playPause: noop, playFromStart: noop, cursorToPlayhead: noop,
    undo: noop, redo: noop, copy: noop, paste: noop, cut: noop,
    deleteSelected: noop, splitAtPlayhead: noop,
    nudgeLeft: noop, nudgeRight: noop,
    zoomIn: noop, zoomOut: noop, zoomFit: noop,
    escape: noop, selectAll: noop, selectSide: noop, toggleDisabled: noop,
    playheadToStart: noop, playheadToEnd: noop, prevEdge: noop, nextEdge: noop,
    shuttle: noop, shuttleStop: noop, setIn: noop, setOut: noop,
  };
  return buildCommands(dummy).map((c) => ({ label: c.label, keys: c.keys }));
}
