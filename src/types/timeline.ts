/**
 * types/timeline.ts — 前端时间轴数据模型
 *
 * 关键约束（PLAN §5）：后端 Shot 不能直接当时间轴数据结构用。
 * 后端字段一改，UI 就跟着炸；且 Shot 只有 order 没有绝对时间坐标，
 * 时间轴要的是"第几秒到第几秒"。所以这里定义独立模型，
 * 由 adapters/shotToClip.ts 做单向转换（后端 → 前端）。
 *
 * 反向（前端编辑 → 后端）不走这层，直接调对应 Service 的 patch 方法。
 */

export type TrackKind =
  | "video"        // 主视频轨（AI 镜头 + 外部素材，当前唯一真源）
  | "overlay"      // 叠加层（Phase 3 预留）
  | "subtitle"     // 字幕（Phase 3）
  | "voice"        // 旁白/TTS
  | "audio"        // 音效（Phase 3 预留）
  | "music"        // 配乐（Phase 3 预留）
  | "asset-char"   // 人物资产轨（Phase 5）
  | "asset-loc"    // 场景资产轨（Phase 5）
  | "asset-ref";   // 参考资产轨（Phase 5）

export type ClipStatus = "pending" | "generating" | "done" | "failed";

/** 提示词来源状态（对应后端 Shot.prompt_state） */
export type PromptState = "draft" | "aligned" | "sent" | "manual";

/**
 * 这个片段背后是**哪种后端实体**（6.9）。
 *
 * 在此之前，判据是"有没有 `shotId`" —— 有就是镜头，没有就是音频/字幕/资产，
 * 三者再靠所在轨道的 kind 去猜。这在只有镜头能被编辑的时候够用；6.9 让音频和
 * 字幕也能拖、能修剪、能删之后就不够了：**三种实体的写通路是三个不同的端点、
 * 三套不同的时长上下限**（见 `features/timeline/clipEdit.ts`），靠"没有 shotId"
 * 只能分出"不是镜头"，分不出"是音频还是字幕"。
 *
 * 做成**必填**是有意的：`Clip` 字面量全项目只有 5 处（3 个文件），
 * 必填能让 tsc 把每一处都问一遍。可选字段则会让漏写的那处静默落进
 * 某个 `?? "shot"` 兜底分支 —— 字幕被当成镜头去 PATCH `/v2/shots/`，
 * 报 404 或者更糟：改到一个 id 恰好撞上的镜头。
 */
export type ClipEntity = "shot" | "audio" | "subtitle";

export interface Clip {
  id: string;
  trackId: string;
  /** 绝对起始秒（由 adapter 累加前序镜头时长得出） */
  startSec: number;
  durationSec: number;
  /** 背后是哪种后端实体。决定写通路与时长上下限，见 ClipEntity。 */
  entity: ClipEntity;

  // ---- 关联后端数据 ----
  shotId?: string;         // 对应 Shot.id
  shotOrder?: number;      // 对应 Shot.order（拖动换位时回写用）
  episode?: number;
  mediaUrl?: string;       // 当前采用版本的视频
  thumbUrl?: string;
  label: string;           // 展示名（AI 镜头 = #order，外部素材 = special_name）
  /**
   * 3.11 R1：该镜的历史版本总数（后端 `version_count`）。1 = 从没重新生成过。
   *
   * 只有镜头有。它驱动的角标是"重新生成不覆盖"这件事**唯一**摆在主路径上的证据：
   * 用户在时间轴上右键重新生成，画面变了，但他得能一眼看见"上一版还在"。
   * `undefined` = 后端没下发（老数据），按不知道处理，不画角标。
   */
  versionCount?: number;

  // ---- 3.1 取片窗口（对应后端 clip_in_sec / clip_dur_sec）----
  /** 入点：从素材的第几秒开始取。undefined = 从头（未修剪过 / 未分割过）。
   *  注意它**不影响** startSec —— 时间轴是无缝顺排的，修掉开头只会让
   *  这一格变窄，左边缘不会移动（后面的镜头整体前移）。
   *
   *  ⚠️ 6.9 起音频段也用这两个字段（后端 `audio_clips.clip_in_sec/clip_dur_sec`），
   *  但**音频的左边缘会移动** —— 它不是无缝顺排的，它锚在某个镜头的某个偏移上，
   *  剪掉开头就该原地变短而不是把后面的音频拽过来。两种语义的差别写在
   *  `features/timeline/clipEdit.ts` 里，那里是唯一决定"拖左边缘发什么"的地方。 */
  clipInSec?: number;
  /** 窗口长度。
   *  · 镜头：有值时恒等于 durationSec（后端强制的不变式）
   *  · 音频：有值时等于 durationSec，无值表示"整段播放"（时长退回 sourceDurSec）
   *  留着这个字段是为了让"有没有窗口"这件事在前端可判定
   *  ——拖右边缘要据此决定发不发 clipDurSec，见 features/timeline/trim.ts。 */
  clipDurSec?: number;
  /** 素材本身有多长（音频 = ffprobe 实测的 `AudioClip.duration`）。
   *
   *  6.9 新增，**只有音频段有**。它是修剪右边缘的上界：音频最多只能播到
   *  素材结束，再拖就是拖出一段不存在的声音。镜头不需要这个字段 ——
   *  镜头的上界是"生成时长上限"（`detail.shot_duration_max`），
   *  是个业务约束而不是素材约束，两者不能混用：拿 15 秒的生成上限去卡
   *  一段 3 分钟的背景音乐，就是本条目被推迟时记下的那个坑。 */
  sourceDurSec?: number;

  // ---- 6.9 锚点（只有音频/字幕有）----
  /** 锚定在第几个镜头上（后端 `start_shot_order`）。
   *
   *  音频/字幕不像镜头那样"无缝顺排"，它们钉在「第 N 镜的第 M 秒」上 ——
   *  这样镜头增删改序时它们会跟着走，而不是停在一个绝对秒数上错位
   *  （见 db.py AudioClip 的类注释）。拖动这两种片段改的就是这一对值。 */
  anchorOrder?: number;
  /** 锚定镜头内的偏移秒（后端 `start_offset_sec`）。
   *  拖左边缘时它会**跟着右移** —— 音频剪掉开头是"晚点开始放"，
   *  不是像镜头那样"原地变窄"。 */
  anchorOffsetSec?: number;

  // ---- 状态 ----
  disabled: boolean;       // 保留在轨但不参与导出
  /**
   * P2-7 留黑：这一镜**在成片里**，只是画面被填成黑（时长、声音、字幕照旧）。
   *
   * ⚠️ 它与上面的 `disabled` 一定要分开看，两者的时间语义正好相反：
   * 停用**不占时间**（所以才有下面那套折叠标记），留黑**占满原时长**——
   * 因此留黑镜头照常按 `durationSec` 整格画出来，不参与折叠。
   *
   * 只是个**展示用**的镜像值，真值在 `ShotInfo.transform_meta.blackout` 里；
   * 可选，所以音频/字幕/资产那几条 `*ToClip` 不用改。
   */
  blackout?: boolean;
  /**
   * 7.2：这一格是**折叠标记**，以及它在同一处折叠里排第几个（0 起）。
   *
   * 只有主轨的停用镜头会有值。停用镜头**不占时间**（`buildOrderOffsetMap`
   * 与 `render/normalize.ts` 都是这么算的），所以它的 `startSec` 与后继镜头
   * **必然相同** —— 在「秒」这套坐标里它没有属于自己的位置。7.2 之前它却按
   * 原时长整格画出来，于是被后继镜头整块盖住：看不见、点不到、**没法再启用**。
   *
   * 所以折叠是**像素层**的事，不是秒层的事：`durationSec` 置 0（这才是真话），
   * 位置由 `ClipView` 按这个下标往接缝**左侧**排。连续多个停用镜头靠下标错开，
   * 否则它们会叠在同一个像素上，三个只看得见一个。
   *
   * ⚠️ 不能改成"给它一点点秒数"来腾位置：那会推动 `buildOrderOffsetMap` 的
   * 累加值，而音频/字幕的锚点、播放头边界、接缝位置全都由它派生，导出侧却
   * 不会跟着动 —— 时间轴与成片当场分家。
   */
  collapsedIndex?: number;
  isSpecial: boolean;      // 外部素材（可删；AI 镜头只能停用）
  status: ClipStatus;

  // ---- AI 信息（Inspector 用）----
  currentVersion?: number;
  modelId?: string;
  promptState?: PromptState;
  refsStale: boolean;      // 参考图变过、尚未重新生成
  firstFrameUrl?: string;
  scriptRef?: string;      // 剧本原文片段
  characters: string[];    // effective 注入角色
  location?: string;       // effective 注入场景
}

export interface AssetSegment {
  id: string;
  trackId: string;
  startSec: number;
  durationSec: number;

  assetId: string;
  assetName: string;
  assetKind: "character" | "location" | "custom";
  imageUrl?: string;
  /** 服装/造型阶段名（面向用户的自然语言，不暴露 stage_id） */
  stageName?: string;
  stageId?: string;
  /** 受影响的镜头 order 列表（Inspector 里用自然语言展示） */
  affectedShotOrders: number[];
  locked: boolean;
}

export interface Track {
  id: string;
  kind: TrackKind;
  label: string;
  locked: boolean;
  hidden: boolean;
  muted: boolean;          // 仅音频轨有意义
  solo: boolean;
  height: number;          // px
  collapsed: boolean;
  clips: Clip[];
  assetSegments: AssetSegment[];  // 仅 asset-* 轨使用
}

export interface Timeline {
  tracks: Track[];
  totalDurationSec: number;
}

export interface Selection {
  clipIds: string[];
  assetSegmentIds: string[];
}

/** 时间轴缩放边界（px per second） */
export const ZOOM_MIN = 4;      // 全局俯瞰：几百镜一屏看完
export const ZOOM_MAX = 60;     // 精修：单镜可辨识
export const ZOOM_DEFAULT = 12;

/** 秒 → mm:ss */
export function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 秒 → mm:ss.f（时间轴刻度用） */
export function fmtSecPrecise(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
