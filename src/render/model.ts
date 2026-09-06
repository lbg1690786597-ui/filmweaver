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
  /**
   * 6.6：用户自己盘上的绝对路径（不是缓存目录里的副本）。
   *
   * **存在即意味着"这条素材只走这个文件"**——与 6.4 的 `assetMediaId` 同款纪律：
   * 读不到时**绝不允许回退到 `url`**。理由是这条路径来自用户手动选进来的素材根，
   * 云端很可能压根没有对应物（本地项目、离线素材）；就算有，也未必是同一个文件。
   * 悄悄换成云端那份的后果是**导出用的素材与用户在预览里看到的不是同一个东西**，
   * 而且没有任何现象提示他 —— 这正是本项目一再拒绝的那种"静默降级"。
   *
   * ⚠️ 它的可读性**不跨重启**：fs scope 是用户在原生对话框里选目录时由
   * dialog 插件当场授予的，关掉软件就清空（见 `lib/localRoot.ts` 文件头）。
   * 所以「路径还在、但这次启动读不到」是**正常状态**，不是数据损坏，
   * 由 `explainUnreachable()` 出提示引导用户重选一次目录。
   *
   * 缺省 `undefined` = 老数据 / 云端素材，行为与 6.6 之前完全一致。
   */
  localPath?: string;
  /**
   * 素材类别。**编译器一个字都不读它**（grep 过：`.kind` 的读取点全是轨道
   * 或蒙版组的 kind，没有一处读 media 的），它只是描述性的，所以 6.4 加
   * `"lut"` 这一档是零风险的。
   *
   * `"lut"` 表示这条 media 不是画面/声音素材，而是某个效果要用的资源文件
   * （`.cube`）。它**不挂在任何轨道的任何 clip 上**，因此：
   *   · 会被 `exportPrep` 正常下载（`plan.media` 是全量遍历的）；
   *   · 不会被音轨探测（探测集是"被视频轨 clip 引用的 media"，见 exportPrep）；
   *   · 下载失败时按"非必需素材"降级处理，而不是让导出失败。
   */
  kind: "video" | "audio" | "image" | "lut";
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

/** 马赛克效果样式。UI 侧经 stores/canvasToolStore 再导出，保持同一份定义。 */
export type MosaicStyle = "pixel" | "gaussblur" | "blackbox";

/** 马赛克区域形状。UI 侧叫「绘制工具」（canvasToolStore.MosaicTool），是同一个东西。 */
export type MosaicShape = "rect" | "ellipse" | "brush";

/**
 * 区域关键帧：某一时刻区域的**完整包围盒**（不是增量）。
 *
 * ⚠️ **时间基准是「输出时间」**：马赛克串在 `clipVideoChain` **之后**，而变速的
 * `setpts` 在那条链**之内**，所以滤镜里的 `t` 已经是变速后的输出时间。`tSec` 按输出
 * 时间存，与预览播放头一致。**后果：改 speed 会让关键帧错位**，speed 变化时必须按比例
 * 重算 `tSec` 并提示用户；跟踪结果要提示重跑。不能悄悄放着。
 */
export interface RegionKeyframe {
  /** 相对 clip 输出起点的秒数 */
  tSec: number;
  /** 该时刻的包围盒，比例 0..1 */
  x: number; y: number; w: number; h: number;
}

/**
 * 马赛克区域参数。
 *
 * ⚠️ 这个类型有**两个身份，但只能有一份定义**：
 *   ① 渲染态：存在 RenderEffect.mosaicParams 里，编译器消费；
 *   ② 持久态：存在 Shot.transform_meta.mosaics 数组里（见 api.ts TransformMeta）。
 *
 * normalize.ts:99-103 直接 `{ ...m }` 把 ② 铺进 ①，两者必须逐字段同构。
 * 此前 api.ts / MosaicOverlay / MosaicPanel 各抄了一份，靠 `as` 断言互相糊住 ——
 * 谁改了一处另外三处不会报错，是典型的静默漂移源。现在统一从这里取。
 */
export interface MosaicParams {
  /** 区域包围盒，相对画面的比例 0..1 */
  x: number; y: number; w: number; h: number;
  /** pixel=像素化马赛克(默认) | gaussblur=高斯模糊 | blackbox=黑色实心遮挡 */
  style: MosaicStyle;
  /** 强度 0..100；pixel: 方块大小(越大越模糊), gaussblur: sigma, blackbox 忽略 */
  intensity: number;
  /**
   * 形状。缺省 = rect（向后兼容：V2.3 早期只有矩形，老数据没这个字段）。
   *  rect    矩形
   *  ellipse 椭圆/圆
   *  brush   画笔涂抹（自由笔迹，由 stroke 描述）
   */
  shape?: MosaicShape;
  /**
   * brush 专用：笔迹点序列（相对画面的比例坐标 0..1）。
   * 渲染时每个点画一个圆，连起来即成笔画。
   */
  stroke?: { x: number; y: number }[];
  /** brush 专用：笔刷直径（相对画面宽度的比例，如 0.08 = 8%） */
  brushSize?: number;

  // ---- 批次 5 新增，**全部可选**，老数据零影响（`normalize.ts` 的 `{ ...m }` 自动带过来）----

  /**
   * 位置/大小关键帧。**≥2 条才算动画**；0 或 1 条一律按静态处理
   * （只有一条时它描述的就是静态框本身，没有第二个端点可插值）。
   * 有动画时 `x/y/w/h` 不再参与合成，一切以关键帧为准。
   */
  keyframes?: RegionKeyframe[];
  /**
   * 羽化宽度，占区域**短边**的百分比 0..100；缺省 0 = 硬边。
   * 换算成像素在 `render/maskGroups.ts` 的 `featherPxOf` 里，只有那一处。
   */
  feather?: number;
  /** 跟踪元数据（5.7 写入）。仅供 UI 呈现「已跟踪 · N 帧」，**不参与编译**。 */
  track?: { generatedAt: number; sampleFps: number; ok: number; total: number };
}

export interface RenderEffect {
  type: RenderEffectType;
  /** 数值类效果的强度（多数 0..100）；lut 用 assetUrl / assetMediaId */
  value?: number;
  /**
   * 效果所需的外部资源 URL（目前只有 `lut` 用：`.cube` 文件的服务器地址）。
   *
   * ⚠️ **这个字段不能直接喂给 ffmpeg**。它是 `/fw/media/uploads/x.cube` 这种
   * 服务器路径，ffmpeg 的 `lut3d=file=` 只认本机文件——6.4 之前编译器正是直接
   * 把它拼进滤镜，实测**整段导出失败**（`Error initializing filter 'lut3d'` →
   * `Conversion failed!`，退出码 1）。它之所以能长期没人发现，是因为导出基线的
   * 11 个场景里一个 `lut` 都没有（6.4 补了第 12 个场景）。
   *
   * 6.4 起：`normalize` 会把它同时登记进 `plan.media`，并把媒体 id 写进
   * 下面的 `assetMediaId`；编译器优先用后者换本地路径。`assetUrl` 保留，
   * 一是预览（`gradePreview` 走浏览器 `fetch`，服务器 URL 才是对的），
   * 二是兼容手工构造 plan 的老调用点。
   */
  assetUrl?: string;
  /**
   * 6.4：`assetUrl` 对应的 `plan.media[].id`。**存在即意味着"必须走本地文件"**——
   * 编译器拿不到本地路径时**绝不允许回退到 `assetUrl`**，那正是上面说的那个
   * 会让导出整段失败的 bug。拿不到就跳过该效果并由调用方报降级提示。
   */
  assetMediaId?: string;
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
  /**
   * P2-7 留黑：**画面变黑，时长与声音照旧**。
   *
   * ⚠️ 与 `disabled`（7.2 停用）是两件不同的事，最容易混的也正是这两个：
   *
   * |            | 占时间 | 有画面 | 有声音 | 字幕 |
   * |------------|:---:|:---:|:---:|---|
   * | 停用 disabled | ✗   | ✗   | ✓   | 合拢到后继镜头处 |
   * | **留黑 blackout** | **✓** | **黑** | ✓ | 照常在本镜位置显示 |
   *
   * 停用是「把这一镜从成片里抽掉」，留黑是「这一镜还在、只是画面不给看」。
   * 用途：待补拍的镜头先占位、转场处刻意留黑、送审时遮掉某一镜。
   *
   * 落点在 `transform_meta` 这个 JSON 列里（后端 `routes_v2.py:1881`
   * 收 `Optional[dict]` 原样透传），**因此零迁移** —— 这也是 7.1 判 `已放弃`
   * 之后仍能做这件事的原因：那次要的 `clips` 表根本不存在，而留黑不需要它。
   */
  blackout?: boolean;
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
  // ⚠️ scaleX/scaleY 必须一起看。漏掉它们的后果不是"少判一种情况"，而是
  // **单轴拉伸整个失效**：scale 仍是 1 而 scaleX=0.5 的镜头会被判成恒等变换 →
  // `clipNeedsFilter` 说不需要滤镜 → 分段器判成 passthrough → 那条 `-vf` 里
  // 压根没有 transform → 用户拖了边中点、预览也动了、成片纹丝不动。
  // （与 `placement.ts` 开头列的缺陷 4 是同一个 UI 手柄的两道关，缺一不可。）
  return t.scale === 1 && (t.scaleX ?? 1) === 1 && (t.scaleY ?? 1) === 1
    && t.rotate === 0 && t.x === 0 && t.y === 0
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
  // P2-7：留黑的镜头整幅被填成黑色，任何遮挡都看不见了。
  // 这里返回 false 不只是省一点 CPU —— 它让整条蒙版链（planMaskGroups →
  // writeSegmentMasks → 追加 ffmpeg 输入 → alphamerge）对留黑镜头**根本不启动**，
  // 于是也不会为一个看不见的遮挡去写蒙版文件、占磁盘、担像素对齐失败的风险。
  if (c.blackout) return false;
  return c.effects.some((e) => e.type === "mosaic");
}

/**
 * 一个 clip 上的马赛克区域，**顺序即叠放顺序**（后者盖前者）。
 *
 * 单列成函数不是为了少写一行：5.8 起**编译器**（登记蒙版输入）与
 * **蒙版产出器**（写蒙版文件）必须看到**同一个数组、同一个顺序** ——
 * `planMaskGroups` 的 `regionIdxs` 与 `groupIdx` 全都是这个数组的下标。
 * 两处各写一遍 `filter(...).map(...)`，哪天有人在一边多加个条件
 * （比如顺手跳过 no-op 区域），下标就整体错位：蒙版张冠李戴，不报错，只是遮错地方。
 */
export function clipMosaics(c: RenderClip): MosaicParams[] {
  return c.effects
    .filter((e) => e.type === "mosaic" && e.mosaicParams)
    .map((e) => e.mosaicParams!);
}
