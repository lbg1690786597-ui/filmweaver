/**
 * render/trackFlags.ts — 时间轴的轨道开关 → 导出计划的轨道标志（批次 4 / 4.6）
 *
 * ## 4.6 之前这三个开关是"死的"
 *
 * `track.muted` / `track.solo` 在全项目里**除了 `TrackHeader` 自己画图标之外
 * 没有任何读取方**；`normalize.ts` 的三处 `RenderTrack` 构造把 `muted/hidden`
 * 一律写死 `false`。所以点了静音再导出，BGM 照样在成片里 —— 不报错、不提示，
 * 属于最难查的那类静默失效（`TrackHeader` 的文案当时如实写着"仅为标记"）。
 *
 * 下游其实早就准备好了：
 *   · `renderer.ts:307`  `.filter((t) => t.kind === "audio" && !t.muted)`
 *   · `segment.ts:92`    `.filter((t) => t.kind === "video" && !t.hidden)`
 * 唯一缺的就是**让真值流到那两句**。本模块负责这段桥。
 *
 * ## 为什么需要一个专门的模块：两套 id 命名空间
 *
 * 编辑态与导出态的轨道 id **不是同一套**，直接把 store 的 `Track[]` 塞给
 * `normalize` 是接不上的：
 *
 * | 轨 | 时间轴 id（`adapters/shotToClip.ts`） | RenderTrack id（`normalize.ts`） |
 * |---|---|---|
 * | 主视频 | `track-video-1`   | `v1` |
 * | 叠加 idx | `track-video-${idx+1}` | `v${idx+1}` |
 * | 旁白 | `track-voice`     | `audio_tts` **与** `audio_narration` |
 * | 配乐 | `track-music`     | `audio_music` |
 * | 音效 | `track-audio`     | `audio_shot` |
 *
 * 注意音频侧是 **1 : N**：时间轴按"听感"分三轨，导出按后端的
 * `AudioClipInfo.kind` 分四轨。这个 3↔4 的对应关系原本只写在
 * `shotToClip.ts:310-312` 一处，现在被提成 `audioTrackKindOf` 由两边共用 ——
 * 各写一份的话，将来后端加一种 kind，编辑侧归了轨、导出侧漏了静音，
 * 表现就是"点了静音但那一类音频还在"，且只在有那种 kind 的项目上才复现。
 *
 * ## 本模块不 import `types/timeline`
 *
 * render 层反向依赖编辑层会让 `verify-*` 脚本连带拖进一堆 UI 类型。
 * 这里只声明自己真正要读的那几个字段（`TrackFlagSource`），结构化匹配，
 * store 的 `Track` 天然满足。
 */

import type { AudioClipInfo } from "../api";

/** 时间轴上"会出声"的三条轨。资产轨/字幕轨没有静音的概念。 */
export type AudioTrackKind = "voice" | "music" | "audio";

/**
 * 后端音频 clip 的全部 kind。
 *
 * 显式列出来是为了能被断言**穷尽**：新增一种 kind 却忘了在
 * `audioTrackKindOf` 里归轨，`verify-trackflags.ts` 会当场转红，
 * 而不是等某个项目导出后才发现"这类声音静不掉"。
 */
export const AUDIO_CLIP_KINDS = ["tts", "music", "shot", "narration"] as const;

/**
 * 后端音频 kind → 它落在哪条时间轴音频轨。
 *
 * **编辑侧与导出侧唯一的一份**（`shotToClip.ts` 排片、本模块折算静音，
 * 都走这里）。语义见 `shotToClip.ts` 的注释：`shot`（镜头原声）归「音效」，
 * `narration`（解说剧旁白）与 `tts` 同属「旁白」。
 */
export function audioTrackKindOf(kind: AudioClipInfo["kind"]): AudioTrackKind {
  return kind === "music" ? "music" : kind === "shot" ? "audio" : "voice";
}

/** `normalize.ts` 给音频轨用的 RenderTrack id。两边必须同一个拼法。 */
export const renderAudioTrackId = (kind: AudioClipInfo["kind"]) => `audio_${kind}`;

/**
 * 时间轴视频/叠加轨 id → RenderTrack id（`track-video-3` → `v3`）。
 * 不是视频轨形态的 id 返回 null（字幕/音频/资产轨走不到这里）。
 */
export function renderVideoTrackId(timelineTrackId: string): string | null {
  const m = /^track-video-(\d+)$/.exec(timelineTrackId);
  return m ? `v${m[1]}` : null;
}

/** 本模块从一条时间轴轨道上真正要读的字段。store 的 `Track` 结构上即满足。 */
export interface TrackFlagSource {
  id: string;
  kind: string;
  label: string;
  hidden: boolean;
  muted: boolean;
  solo: boolean;
  /** 轨上有多少个片段 —— 只用来判断"隐藏之后还剩不剩画面"。 */
  clipCount: number;
}

export interface TrackFlagPlan {
  /** 要静音的 **RenderTrack.id**，喂给 `NormalizeInput.trackFlags` */
  muted: string[];
  /** 要隐藏的 **RenderTrack.id** */
  hidden: string[];
  /**
   * 逐条人话说明，导出前原样念给用户听。
   *
   * 空数组 = 所有开关都是默认值，本次导出不受影响，**不要弹任何东西**。
   * 非空时必须弹：静音/独奏/隐藏都是"少一点东西进成片"，
   * 而少掉的那部分在成片里是看不出来的（用户只会觉得"BGM 怎么没了"）。
   * 剪映把 solo 挡在成片之外正是怕这个，我们改用"当场说清楚"来解决 ——
   * 既让按钮真的管用，又不会静默吃掉内容。
   */
  notes: string[];
  /**
   * true = 本来有画面，全被隐藏光了，导出必然是个空文件。
   * 这一条不是提示而是**拦截**：跑完几十分钟交付一个空 mp4 没有任何意义。
   */
  noVideo: boolean;
}

const isAudioKind = (k: string): k is AudioTrackKind =>
  k === "voice" || k === "music" || k === "audio";
const isVideoKind = (k: string) => k === "video" || k === "overlay";

/**
 * 把时间轴的轨道开关折算成导出计划要用的标志。
 *
 * ## 独奏的语义（4.6 的决策）
 *
 * **有任意音频轨处于独奏时，其余音频轨视作静音，并且这条规则进导出。**
 *
 * 剪映的 solo 是纯监听、不进成片。这里没照抄，理由是我们的预览**根本走不到
 * 轨道模型**：`Player` 播的是单个镜头的 `<video>`，轨道开关一个都读不到。
 * 照抄就等于把 solo 标成"仅预览"，然后它连预览也不影响 —— 那还是一句谎话，
 * 只是换了个说法。要么让它真的管用，要么把按钮删掉；4.6 选前者，
 * 并用 `notes` 把"其余音频轨不进成片"在导出前讲明白，堵住剪映所担心的
 * 那个"独奏完忘了关、成片少了 BGM"的坑。
 *
 * ## 隐藏只对视频轨进导出
 *
 * `segment.ts` 消费的就是 `kind === "video" && !t.hidden`。音频轨上的眼睛
 * 保持纯编辑器语义（变暗、不可选中、不参与吸附）—— 音频要不出声有静音按钮，
 * 让两个开关做同一件事只会让人猜不透哪个才算数。字幕轨同理：字幕走
 * `plan.subtitles`，压根不经过轨道。`TrackHeader` 的眼睛文案按轨型分开写。
 */
export function collectTrackFlags(tracks: readonly TrackFlagSource[]): TrackFlagPlan {
  const muted = new Set<string>();
  const hidden = new Set<string>();
  const notes: string[] = [];

  // ---- 音频：静音 + 独奏 ----
  const audioTracks = tracks.filter((t) => isAudioKind(t.kind));
  const soloed = audioTracks.filter((t) => t.solo);
  const silenced = audioTracks.filter(
    (t) => t.muted || (soloed.length > 0 && !t.solo));

  for (const t of silenced) {
    for (const k of AUDIO_CLIP_KINDS) {
      if (audioTrackKindOf(k) === t.kind) muted.add(renderAudioTrackId(k));
    }
  }
  // 说明按"原因"归并，不逐轨复读：三条轨全被独奏挤掉时，
  // 三句一模一样的"未独奏"只会把真正要看的那句淹掉。
  const mutedByFlag = audioTracks.filter((t) => t.muted);
  if (mutedByFlag.length) {
    notes.push(`${labels(mutedByFlag)}轨已静音 → 这些音频不进成片`);
  }
  if (soloed.length) {
    const dropped = silenced.filter((t) => !t.muted);
    notes.push(dropped.length
      ? `${labels(soloed)}轨处于独奏 → 只保留它，${labels(dropped)}不进成片`
      : `${labels(soloed)}轨处于独奏 → 其余音频轨本来就没有内容，成片不受影响`);
  }

  // ---- 视频：隐藏 ----
  const videoTracks = tracks.filter((t) => isVideoKind(t.kind));
  const hiddenVideo = videoTracks.filter((t) => t.hidden);
  for (const t of hiddenVideo) {
    const rid = renderVideoTrackId(t.id);
    if (rid) hidden.add(rid);
  }
  if (hiddenVideo.length) {
    notes.push(`${labels(hiddenVideo)}轨已隐藏 → 这些画面不进成片`);
  }

  const hadPicture = videoTracks.some((t) => t.clipCount > 0);
  const noVideo = hadPicture
    && videoTracks.every((t) => t.hidden || t.clipCount === 0);

  return {
    muted: [...muted].sort(),
    hidden: [...hidden].sort(),
    notes,
    noVideo,
  };
}

/** 「旁白」「配乐」这样把一串轨名念出来 */
function labels(tracks: readonly TrackFlagSource[]): string {
  return tracks.map((t) => `「${t.label}」`).join("");
}
