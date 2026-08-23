/**
 * editorStore.ts — 全局编辑器状态
 *
 * 职责：
 *  - 当前打开的项目 ID
 *  - 左侧面板当前激活 Tab
 *  - 选中对象 ID（Clip / AssetSegment）
 *  - UI 状态（最大化面板、弹窗开关等）
 *
 * 跨组件联动的"三联动"靠 selectedClipId 驱动：
 *   ShotsPanel 点击 → setSelectedClipId
 *   Timeline 高亮对应 Clip
 *   Player 加载对应视频
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

  // 选中状态（三联动核心）
  selectedClipId: string | null;           // 对应 Shot.id
  selectedAssetSegmentId: string | null;
  setSelectedClipId: (id: string | null) => void;
  setSelectedAssetSegmentId: (id: string | null) => void;

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

  selectedClipId: null,
  selectedAssetSegmentId: null,
  setSelectedClipId: (id) =>
    set({ selectedClipId: id, selectedAssetSegmentId: null }),
  setSelectedAssetSegmentId: (id) =>
    set({ selectedAssetSegmentId: id, selectedClipId: null }),

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
