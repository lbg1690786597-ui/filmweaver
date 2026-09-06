/**
 * canvasToolStore — 画面编辑工具的共享 UI 状态
 *
 * ## 为什么需要它
 *
 * V2.3 把马赛克/取景做成了"画面上直接操作"的覆盖层（MosaicOverlay /
 * CropZoomOverlay），工具选择、当前选中的区域、笔刷大小这些状态原本是
 * **各自组件内部的 useState**。于是右侧检查器里的 MosaicPanel / CropZoomPanel
 * 与画面上的覆盖层是两套互不相通的 UI：
 *
 *   - 面板里看不到"现在选的是矩形还是画笔"，也没法切换 —— 用户反馈
 *     "预设几何形、画笔都没在这里展示"，正是因为这些状态根本传不进面板；
 *   - 面板里点一个区域，画面上不会选中它；画面上选中一个，面板也不高亮；
 *   - 面板改样式/强度改的是"数组里第 N 项"，覆盖层改的是"当前选中项"，
 *     两边对不上。
 *
 * 把这些**纯 UI 状态**（不落库、不影响导出）提到一个 store 里，面板与覆盖层
 * 就变成同一个编辑器的两个视图：面板负责"列清单、给预设、精确微调"，
 * 画面负责"直接画"。这也是剪映的分工。
 *
 * ## 边界：这里只放 UI 态
 *
 * 真正的数据（区域坐标、样式、强度）始终存在 shot.transform_meta 里，
 * 经 onPatchTransform 落库。本 store 只记"用户此刻在用哪个工具、选中了谁"。
 * 所以切项目时直接 reset 即可，不会丢任何用户数据。
 */

import { create } from "zustand";
import type { MosaicShape, MosaicStyle } from "../render/model";

/** 画面覆盖层模式：null = 不激活 */
export type OverlayMode = "cropzoom" | "mosaic" | null;

/**
 * 马赛克绘制工具 —— 就是 MosaicParams.shape，UI 侧的叫法不同而已。
 * 定义在 render/model.ts（唯一一份），这里只做别名与再导出，
 * 既保持既有 `import { MosaicTool } from "stores/canvasToolStore"` 不变，
 * 又杜绝"工具枚举加了一项、渲染层不认识"的漂移。
 */
export type MosaicTool = MosaicShape;

/** 马赛克效果样式（同上，源自 render/model.ts） */
export type { MosaicStyle };

/** 取景覆盖层的子模式：frame = 拖裁剪框，picture = 拖画面本身 */
export type CropTool = "frame" | "picture";

interface CanvasToolState {
  // ---- 覆盖层激活 ----
  overlayMode: OverlayMode;
  setOverlayMode: (m: OverlayMode) => void;

  // ---- 马赛克 ----
  mosaicTool: MosaicTool;
  setMosaicTool: (t: MosaicTool) => void;
  /** 当前选中的区域下标；null = 没选中 */
  mosaicSel: number | null;
  setMosaicSel: (i: number | null) => void;
  /** "下次新建"的默认样式/强度；选中区域时同步为该区域的值 */
  mosaicStyle: MosaicStyle;
  setMosaicStyle: (s: MosaicStyle) => void;
  mosaicIntensity: number;
  setMosaicIntensity: (v: number) => void;
  /** 笔刷直径（相对画面宽度比例 0.02..0.4） */
  brushSize: number;
  setBrushSize: (v: number) => void;

  // ---- 取景 ----
  cropTool: CropTool;
  setCropTool: (t: CropTool) => void;
  /** 裁剪框锁定的宽高比（w/h）；null = 自由 */
  cropRatio: number | null;
  setCropRatio: (r: number | null) => void;

  /** 切项目 / 关项目时清场（由 App.resetWorkspace 调用） */
  resetCanvasTools: () => void;
}

const INITIAL = {
  overlayMode: null as OverlayMode,
  mosaicTool: "rect" as MosaicTool,
  mosaicSel: null as number | null,
  mosaicStyle: "pixel" as MosaicStyle,
  mosaicIntensity: 60,
  brushSize: 0.1,
  cropTool: "frame" as CropTool,
  cropRatio: null as number | null,
};

export const useCanvasToolStore = create<CanvasToolState>((set) => ({
  ...INITIAL,

  setOverlayMode: (m) =>
    // 切换/关闭覆盖层时把选中态一并清掉：留着的话再次进入马赛克模式，
    // 画面上会凭空出现一个选中框和设置气泡，指向用户早就忘了的那个区域。
    set({ overlayMode: m, mosaicSel: null }),

  setMosaicTool: (t) => set({ mosaicTool: t }),
  setMosaicSel: (i) => set({ mosaicSel: i }),
  setMosaicStyle: (s) => set({ mosaicStyle: s }),
  setMosaicIntensity: (v) => set({ mosaicIntensity: v }),
  setBrushSize: (v) => set({ brushSize: Math.max(0.02, Math.min(0.4, v)) }),

  setCropTool: (t) => set({ cropTool: t }),
  setCropRatio: (r) => set({ cropRatio: r }),

  resetCanvasTools: () => set({ ...INITIAL }),
}));
