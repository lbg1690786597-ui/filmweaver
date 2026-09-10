/**
 * transitionCatalog.ts — 转场的**唯一**目录（id / 中文名 / 分组 / 预览表现）
 *
 * ## 为什么要有这一层
 *
 * 3.9 之前这份表只存在于 `EffectsPanel.tsx` 里，是那个组件的私有常量。
 * 于是时间轴那边拿不到中文名，`transitions.ts::seamHint` 与 `Timeline.tsx`
 * 的转场弹窗只能直接把 `m.type` 拼进文案，用户在轨道上看到的是：
 *
 *     #5 #6「fadeblack」3.7s（成片会缩短 3.7s）
 *
 * ——一个中文界面里突然冒出 ffmpeg 的内部标识符。用户报「名称是英文看不懂」。
 *
 * 名字属于**转场本身**，不属于任何一个面板。放这里，两边都读同一份。
 *
 * ## 命名口径：跟剪映走
 *
 * 用户明确要求"命名向剪映看齐"。所以 `fade` 不叫"淡入淡出"而叫**叠化**，
 * `fadeblack` 与 `fadewhite` 不叫"黑场过渡/白场过渡"而叫**闪黑**、**闪白** —
 * 这三个是短剧剪辑里最常用的，名字对不上等于每次都要用户在心里做一次翻译。
 *
 * ## `preview` 与 `motion` 是两件事
 *
 * - `preview`：卡片上那块**静态**渐变色板，纯装饰，只需"看起来像那么回事"。
 * - `motion`：播放器**真正**播这条转场时怎么动（`SeamTransition` 用）。
 *   它必须是 CSS 能精确表达的几何/透明度变化 —— 播放器是双 `<video>` 叠加，
 *   没有逐帧合成能力。表达不了的转场（如 pixelize 的马赛克溶解）退回
 *   `crossfade` 近似，并在 `approx` 上标明，UI 要如实告诉用户"预览为近似"。
 */

/** 播放器怎么把这条转场"演"出来。全部可由 CSS transform/opacity/clip-path 表达。 */
export type TransitionMotion =
  /** 交叉淡化：上一段淡出、下一段淡入 */
  | { kind: "crossfade" }
  /** 闪色：先淡到纯色，再从纯色淡出到下一段（闪黑 / 闪白） */
  | { kind: "flash"; color: string }
  /** 整幅位移推入，dx/dy 为 ±1（占一个画面宽/高） */
  | { kind: "slide"; dx: number; dy: number }
  /** 擦除：下一段按方向用 clip-path 逐渐盖上来，上一段不动 */
  | { kind: "wipe"; dir: "left" | "right" | "up" | "down" }
  /** 圆形开合：open=true 下一段从中心圆形展开 */
  | { kind: "circle"; open: boolean }
  /** 缩放推入 */
  | { kind: "zoom" };

export interface TransitionDef {
  /** ffmpeg xfade 的 transition 名。**唯一主键**，落库存的就是它。 */
  id: string;
  /** 中文名（剪映口径），界面上一律显示这个 */
  name: string;
  group: string;
  /** 卡片上的静态色板，纯装饰 */
  preview: string;
  /** 播放器预览怎么演 */
  motion: TransitionMotion;
  /** true = `motion` 只是近似，与导出结果不完全一致，UI 要说明 */
  approx?: boolean;
}

export const TRANSITIONS: TransitionDef[] = [
  { id: "fade", name: "叠化", group: "基础",
    preview: "linear-gradient(90deg,#000,#888,#fff)",
    motion: { kind: "crossfade" } },
  { id: "fadeblack", name: "闪黑", group: "基础",
    preview: "linear-gradient(90deg,#fff,#000,#fff)",
    motion: { kind: "flash", color: "#000" } },
  { id: "fadewhite", name: "闪白", group: "基础",
    preview: "linear-gradient(90deg,#333,#fff,#333)",
    motion: { kind: "flash", color: "#fff" } },
  { id: "dissolve", name: "颗粒溶解", group: "基础",
    preview: "radial-gradient(circle,#888,#222)",
    // xfade 的 dissolve 是逐像素噪声消散，CSS 做不出噪声，用叠化近似
    motion: { kind: "crossfade" }, approx: true },

  { id: "slideleft", name: "向左滑动", group: "运动",
    preview: "linear-gradient(90deg,#4a5,#254)",
    motion: { kind: "slide", dx: -1, dy: 0 } },
  { id: "slideright", name: "向右滑动", group: "运动",
    preview: "linear-gradient(270deg,#4a5,#254)",
    motion: { kind: "slide", dx: 1, dy: 0 } },
  { id: "slideup", name: "向上滑动", group: "运动",
    preview: "linear-gradient(0deg,#4a5,#254)",
    motion: { kind: "slide", dx: 0, dy: -1 } },
  { id: "slidedown", name: "向下滑动", group: "运动",
    preview: "linear-gradient(180deg,#4a5,#254)",
    motion: { kind: "slide", dx: 0, dy: 1 } },
  { id: "smoothleft", name: "平滑左移", group: "运动",
    preview: "linear-gradient(100deg,#57a,#235)",
    // xfade 的 smoothleft 带渐变软边，CSS 位移是硬边，故标近似
    motion: { kind: "slide", dx: -1, dy: 0 }, approx: true },
  { id: "zoomin", name: "放大推入", group: "运动",
    preview: "radial-gradient(circle,#a85 20%,#432 80%)",
    motion: { kind: "zoom" } },

  { id: "wipeleft", name: "向左擦除", group: "擦除",
    preview: "linear-gradient(90deg,#a54,#421)",
    motion: { kind: "wipe", dir: "left" } },
  { id: "wiperight", name: "向右擦除", group: "擦除",
    preview: "linear-gradient(270deg,#a54,#421)",
    motion: { kind: "wipe", dir: "right" } },
  { id: "circleopen", name: "圆形开幕", group: "擦除",
    preview: "radial-gradient(circle,#fff 30%,#222 70%)",
    motion: { kind: "circle", open: true } },
  { id: "circleclose", name: "圆形闭幕", group: "擦除",
    preview: "radial-gradient(circle,#222 30%,#fff 70%)",
    motion: { kind: "circle", open: false } },

  { id: "pixelize", name: "像素溶解", group: "风格",
    preview: "repeating-linear-gradient(45deg,#666 0 6px,#333 6px 12px)",
    // 逐级降分辨率，CSS 无法表达，用叠化近似
    motion: { kind: "crossfade" }, approx: true },
];

const BY_ID = new Map(TRANSITIONS.map((t) => [t.id, t]));

/** 按 id 取定义。未知 id 返回 undefined —— 调用方自己决定怎么退化，
 *  这里不造一个假的定义出来（那会让"库里存了个我们不认识的转场"这件事
 *  变得完全不可见）。 */
export function transitionDef(id: string): TransitionDef | undefined {
  return BY_ID.get(id);
}

/** 界面上该显示的名字。未知 id **原样返回**：
 *  露出 `fadeblack` 这种原始 id 很难看，但比显示"未知转场"强得多 ——
 *  后者把唯一能用来排查的线索也擦掉了。 */
export function transitionName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}
