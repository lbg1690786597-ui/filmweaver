/**
 * editorStore.ts — 全局编辑器状态
 *
 * 职责：
 *  - 当前打开的项目 ID
 *  - 左侧面板当前激活 Tab
 *  - UI 状态（最大化面板、弹窗开关等）
 *
 * ⚠️ 3.5：**选中态不在这里**。
 *
 * 这里原本有 `selectedClipId` / `selectedAssetSegmentId` 一对字段，文件头还
 * 写着"跨组件三联动靠 selectedClipId 驱动"。实情是它们和
 * `useTimelineStore.selection` 构成了**两套并存、互不同步的选中真源**：
 * 前者单选、是唯一被画成高亮的那个；后者多选、是 Delete / 复制 / 剪切真正
 * 作用的那个。Ctrl+A 只写后者 → 界面上零高亮，按 Delete 却停用全部镜头。
 *
 * 收敛的方向只能是删这一边：`selectedClipId` 全项目**只有一处在读**
 * （Timeline 的高亮），却有五处在写，属于写多读少的影子状态；而
 * `timelineStore.selection` 是操作真正读的那个，删不得。
 * 留着"只同步一下"是不够的 —— 两个真源迟早再次漂移，第六处写入不会记得
 * 同步。现在高亮直接读 `selection.clipIds`，**高亮 ≡ 将被操作的集合**
 * 成为结构性事实，不再依赖人的自觉。
 *
 * 三联动仍然成立，只是改由 `App.selectedShotId`（谁在 Inspector/播放器里）
 * 与 `timelineStore.selection`（谁会被批量操作）分别承担 —— 这两件事本来
 * 就不是一回事：Ctrl+click 加选第 5 镜时，播放器不该跟着跳过去。
 */

import { create } from "zustand";

export type LeftPanelTab =
  | "media"
  | "audio"
  | "text"
  | "transition"
  | "effect"
  | "filter"
  | "ai-script"
  | "ai-shots"
  | "ai-video"
  | "ai-image"
  | "ai-voice"
  | "ai-tasks"
  | "assets"
  | "script";

export type MaximizedPanel = null | "dock" | "player";

interface EditorState {
  // 项目
  projectId: string | null;
  setProjectId: (id: string | null) => void;

  // 左侧面板
  leftPanelTab: LeftPanelTab;
  setLeftPanelTab: (tab: LeftPanelTab) => void;

  // 选中态见文件头：已收敛到 useTimelineStore.selection，此处不再持有。

  // 面板最大化
  maximizedPanel: MaximizedPanel;
  setMaximizedPanel: (p: MaximizedPanel) => void;
  toggleMaximized: (p: Exclude<MaximizedPanel, null>) => void;

  // 弹窗/抽屉开关
  taskDrawerOpen: boolean;
  setTaskDrawerOpen: (v: boolean) => void;
  exportDialogOpen: boolean;
  setExportDialogOpen: (v: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  projectId: null,
  setProjectId: (id) => set({ projectId: id }),

  leftPanelTab: "media",
  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),

  maximizedPanel: null,
  setMaximizedPanel: (p) => set({ maximizedPanel: p }),
  toggleMaximized: (p) =>
    set((s) => ({ maximizedPanel: s.maximizedPanel === p ? null : p })),

  taskDrawerOpen: false,
  setTaskDrawerOpen: (v) => set({ taskDrawerOpen: v }),
  exportDialogOpen: false,
  setExportDialogOpen: (v) => set({ exportDialogOpen: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
}));
