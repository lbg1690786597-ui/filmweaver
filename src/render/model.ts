/**
 * render/model.ts — Render Engine V2 的标准化渲染描述（RenderPlan）
 *
 * 这一层的存在理由：把「用户在时间轴上编排了什么」与「ffmpeg 该怎么跑」彻底隔开。
 * UI 只产出 RenderPlan，编译器只消费 RenderPlan——两边都不需要知道对方的实现。
 *
 * 与 types/timeline.ts 的区别：
 *   Timeline  是**编辑态**，带选中、折叠、UI 高度这些渲染无关的东西，
 *             且 Clip 的时长会随拖拽实时变化。
 *   RenderPlan 是**冻结的产出描述**：绝对时间已算好、无效对象已剔除、
 *             轨道已按合成顺序排好。同一个 Timeline 在不同导出设置下
 *             （分辨率/范围/是否含音频）会产出不同的 RenderPlan。
 *
 * 关键约束（PLAN §8）：AI Asset Track **不进入** RenderPlan。
 * 资产轨表达的是"生成时参考什么"，不是"画面上放什么"。
 * normalize 阶段直接丢弃，编译器根本看不到它们。
 */

/** 渲染用的媒体引用。一个 Media 可被多个 RenderClip 使用（同素材多次出现）。 */
export interface RenderMedia {
  id: string;
  /** /fw/media/... 或 http；由 resolver 转成本地路径 */
  url: string;
  kind: "video" | "audio" | "image";
  /** 已知时长（秒）；未知为 0，编译器会按 clip 需求处理 */
  durationSec: number;
}

/** 画面变换（与后端 Shot.transform_meta 同构，但这里是**规范化后**的值）。 */
export interface RenderTransform {
  /** 相对画布的缩放，1 = 铺满（等比时用它） */
  scale: number;
  /** 非等比缩放（拖边中点单轴拉伸产生）；缺省跟随 scale */
  scaleX?: number;
  scaleY?: number;
  /** 度 */
  rotate: number;
  /** 相对画布中心的像素偏移 */
  x: number;
  y: number;
  /** 0..1 */
  opacity: number;
  mirrorH: boolean;
  mirrorV: boolean;
  /** 裁切（相对原始画面的比例 0..1）；undefined = 不裁 */
  crop?: { left: number; top: number; right: number; bottom: number };
}

/** 调色 / 效果。**不存 ffmpeg filter 字符串**（PLAN §7）——存结构化参数，
 *  由 compiler 决定用哪个滤镜实现。换实现时不用动数据。 */
export type RenderEffectType =
  // ---- 调色（V2.1 已实现）----
  | "brightness" | "contrast" | "saturation" | "temperature" | "tint"
  | "highlights" | "shadows" | "sharpen" | "lut"
  // ---- 逐帧特效（V2.2）----
  // 每一项都在真实 ffmpeg 上验证过可执行，没有基于文档臆测的
  | "blur"          // gblur   高斯模糊
  | "vignette"      // vignette 暗角
  | "grain"         // noise    胶片颗粒
  | "glitch"        // rgbashift RGB 分离/故障风
  | "shake"         // crop+scale 画面抖动（按时间摆动裁切窗口）
  | "zoomPulse"     // scale(eval=frame)+crop 心跳缩放
  | "flash"         // curves   闪白
  | "glow"          // gblur+blend=screen 发光
  // ---- 区域马赛克（V2.3）----
  // style: "pixel"=像素化(默认) "gaussblur"=高斯模糊 "blackbox"=黑色遮挡
  | "mosaic";       // 见 MosaicParams

/** 马赛克区域参数（存在 RenderEffect.mosaicParams 里） */
export interface MosaicParams {
  /** 区域包围盒，相对画面的比例 0..1 */
  x: number; y: number; w: number; h: number;
  /** pixel=像素化马赛克(默认) | gaussblur=高斯模糊 | blackbox=黑色实心遮挡 */
  style: "pixel" | "gaussblur" | "blackbox";
  /** 强度 0..100；pixel: 方块大小(越大越模糊), gaussblur: sigma, blackbox 忽略 */
  intensity: number;
  /**
   * 形状。缺省 = rect（向后兼容：V2.3 早期只有矩形，老数据没这个字段）。
   *  rect    矩形
   *  ellipse 椭圆/圆
   *  brush   画笔涂抹（自由笔迹，由 stroke 描述）
   */
  shape?: "rect" | "ellipse" | "brush";
  /**
   * brush 专用：笔迹点序列（相对画面的比例坐标 0..1）。
   * 渲染时每个点画一个圆，连起来即成笔画。
   */
  stroke?: { x: number; y: number }[];
  /** brush 专用：笔刷直径（相对画面宽度的比例，如 0.08 = 8%） */
  brushSize?: number;
}

export interface RenderEffect {
  type: RenderEffectType;
  /** 数值类效果的强度（多数 0..100）；lut 用 assetUrl */
  value?: number;
  assetUrl?: string;
  /** mosaic 类型专用：区域和样式参数 */
  mosaicParams?: MosaicParams;
}

/** 混合模式：叠加层与下层的合成方式（ffmpeg blend=all_mode） */
export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten";

export interface RenderAudio {
  /** 0..N，1 = 原音量 */
  volume: number;
  muted: boolean;
  /** 秒 */
  fadeInSec: number;
  fadeOutSec: number;
}

/** 时间轴上的一次媒体使用。 */
export interface RenderClip {
  id: string;
  mediaId: string;
  /** 在成片时间轴上的起点（秒） */
  timelineStartSec: number;
  /** 在成片上占用的时长（秒，已含变速影响） */
  durationSec: number;
  /** 取源区间（秒，相对源文件） */
  sourceInSec: number;
  /** 取源时长（秒）；变速前的原始长度 */
  sourceDurationSec: number;
  /** 播放速度，1 = 原速 */
  speed: number;
  transform: RenderTransform;
  effects: RenderEffect[];
  audio: RenderAudio;
  /** 叠加层与下层的混合方式（V2.2）；主轨忽略。normal = 直接覆盖 */
  blendMode?: BlendMode;
}

export type RenderTrackKind = "video" | "subtitle" | "audio";

export interface RenderTrack {
  id: string;
  kind: RenderTrackKind;
  /** 合成层级：数字越大越靠上（后叠加）。音频轨忽略此值。 */
  layer: number;
  muted: boolean;
  hidden: boolean;
  clips: RenderClip[];
}

/** 转场：属于 Timeline，挂在两个相邻 clip 之间（PLAN §6）。 */
export interface RenderTransition {
  id: string;
  /** ffmpeg xfade 的 transition 名；compiler 负责映射与能力判断 */
  type: string;
  durationSec: number;
  fromClipId: string;
  toClipId: string;
}

/** 字幕条目（已换算为绝对时间）。 */
export interface RenderSubtitle {
  id: string;
  text: string;
  startSec: number;
  durationSec: number;
  style?: Record<string, unknown>;
}

export interface RenderOutput {
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  crf: number;
  withAudio: boolean;
}

export interface RenderPlan {
  projectId: string;
  media: RenderMedia[];
  tracks: RenderTrack[];
  transitions: RenderTransition[];
  subtitles: RenderSubtitle[];
  output: RenderOutput;
  /** 成片总时长（秒） */
  totalSec: number;
}

/* ---------- 默认值 ---------- */

export const DEFAULT_TRANSFORM: RenderTransform = {
  scale: 1, rotate: 0, x: 0, y: 0, opacity: 1,
  mirrorH: false, mirrorV: false,
};

export const DEFAULT_AUDIO: RenderAudio = {
  volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0,
};

/** 变换是否等价于"什么都不做"——编译器据此走零成本快路径 */
export function isIdentityTransform(t: RenderTransform): boolean {
  return t.scale === 1 && t.rotate === 0 && t.x === 0 && t.y === 0
    && t.opacity === 1 && !t.mirrorH && !t.mirrorV && !t.crop;
}

export function isDefaultAudio(a: RenderAudio): boolean {
  return a.volume === 1 && !a.muted && a.fadeInSec === 0 && a.fadeOutSec === 0;
}

/** 该 clip 是否需要任何滤镜处理（决定它能不能走 copy 透传） */
export function clipNeedsFilter(c: RenderClip): boolean {
  return !isIdentityTransform(c.transform)
    || c.effects.length > 0
    || c.speed !== 1
    || !isDefaultAudio(c.audio);
}

/** mosaic 效果需要 split/overlay，不能走 passthrough 的 -vf 单链路径 */
export function clipHasMosaic(c: RenderClip): boolean {
  return c.effects.some((e) => e.type === "mosaic");
}
