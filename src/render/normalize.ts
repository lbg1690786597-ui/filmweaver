/**
 * render/normalize.ts — Timeline（编辑态）→ RenderPlan（冻结的产出描述）
 *
 * 这一步做四件事：
 *   1. 丢掉渲染无关的东西（选中态、折叠、UI 高度）
 *   2. **剔除 AI Asset Track**（PLAN §8）——资产轨表达"生成时参考什么"，
 *      不是"画面上放什么"。让它连进不到 RenderPlan，编译器就不可能误合成。
 *   3. 把后端的 shot 字段翻译成通用 Clip 属性（Shot 只负责提供 Media）
 *   4. 算好绝对时间与总时长
 *
 * 过渡期说明（PLAN §4）：当前 Clip 仍由 Shot 派生（一个 Shot → 一个 Clip）。
 * 独立 Clip 表的迁移牵动资产/音频/字幕的镜头锚点，不与 Render V2.1 绑定。
 * 本模块已按「Clip 是独立对象」建模，将来换成真 Clip 表时只改这一个文件。
 */

import type {
  ShotInfo, AudioClipInfo, SubtitleClipInfo, TransformMeta, TransitionInfo,
} from "../api";
import type {
  RenderPlan, RenderClip, RenderMedia, RenderTrack, RenderOutput,
  RenderTransform, RenderAudio, RenderEffect, RenderSubtitle,
} from "./model";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "./model";

const DEFAULT_SHOT_SEC = 5;

export interface NormalizeInput {
  projectId: string;
  shots: ShotInfo[];
  audioClips?: AudioClipInfo[];
  subtitleClips?: SubtitleClipInfo[];
  transitions?: TransitionInfo[];
  output: RenderOutput;
  /** 导出范围：只导已出片 / 全部启用 / 指定镜头 */
  scope?: "generated" | "all" | "selection";
  selectedShotIds?: string[];
}

/** transform_meta（后端存储形态，-100..100 的滑块值）→ 规范化 RenderTransform */
function toTransform(tm: TransformMeta | null | undefined): RenderTransform {
  if (!tm) return { ...DEFAULT_TRANSFORM };
  return {
    scale: (tm.scale ?? 100) / 100,
    rotate: tm.rotate ?? 0,
    x: tm.x ?? 0,
    y: tm.y ?? 0,
    opacity: (tm.opacity ?? 100) / 100,
    mirrorH: !!tm.mirrorH,
    mirrorV: !!tm.mirrorV,
  };
}

function toAudio(tm: TransformMeta | null | undefined): RenderAudio {
  if (!tm) return { ...DEFAULT_AUDIO };
  return {
    volume: (tm.volume ?? 100) / 100,
    muted: !!tm.muted,
    // 前端滑块以 0.1s 为单位存储
    fadeInSec: (tm.fadeIn ?? 0) / 10,
    fadeOutSec: (tm.fadeOut ?? 0) / 10,
  };
}

/** 调色参数 → 结构化 effect 列表（不产出 filter 字符串，那是 compiler 的事） */
function toEffects(tm: TransformMeta | null | undefined): RenderEffect[] {
  if (!tm) return [];
  const out: RenderEffect[] = [];
  const num = (k: keyof TransformMeta, type: RenderEffect["type"]) => {
    const v = tm[k];
    if (typeof v === "number" && v !== 0) out.push({ type, value: v });
  };
  num("exposure", "brightness");
  num("contrast", "contrast");
  num("saturation", "saturation");
  num("temperature", "temperature");
  num("tint", "tint");
  num("highlights", "highlights");
  num("shadows", "shadows");
  num("sharpen", "sharpen");
  // V2.2 逐帧特效
  num("blur", "blur");
  num("vignette", "vignette");
  num("grain", "grain");
  num("glitch", "glitch");
  num("shake", "shake");
  num("zoomPulse", "zoomPulse");
  num("flash", "flash");
  num("glow", "glow");
  if (tm.lut) out.push({ type: "lut", assetUrl: tm.lut });
  return out;
}

export function normalize(input: NormalizeInput): RenderPlan {
  const { projectId, output } = input;

  // ---- 选出参与导出的镜头 ----
  const sorted = [...input.shots].sort((a, b) => a.order - b.order);
  const picked = sorted.filter((s) => {
    if (s.disabled) return false;
    if (input.scope === "selection") {
      return (input.selectedShotIds ?? []).includes(s.id) && !!s.video_url;
    }
    if (input.scope === "all") return true;
    return !!s.video_url;              // 默认：只导已出片
  });

  // ---- Media 去重：同一个 video_url 只登记一次（同素材多次使用是常态）----
  const media: RenderMedia[] = [];
  const mediaIdByUrl = new Map<string, string>();
  const mediaIdOf = (url: string, durationSec: number): string => {
    const hit = mediaIdByUrl.get(url);
    if (hit) return hit;
    const id = `m${media.length}`;
    mediaIdByUrl.set(url, id);
    media.push({ id, url, kind: "video", durationSec });
    return id;
  };

  // ---- 视频轨：主轨顺序累加，Overlay 层按显式起点定位 ----
  // 分流的理由：叠加层若也参与顺序累加，它就变成"插队"而不是"叠在上面"了。
  const videoClips: RenderClip[] = [];
  const overlayByTrack = new Map<number, RenderClip[]>();
  let cursor = 0;
  const shotStartSec = new Map<number, number>();   // order → 绝对起点（字幕/音频锚点用）
  const clipIdByShotId = new Map<string, string>(); // 转场需要按 shot 找 clip

  for (const s of picked) {
    const shown = s.duration_sec ?? DEFAULT_SHOT_SEC;
    const trackIdx = s.track_index ?? 0;

    // Overlay 层：不参与主轨时间累加，位置由 overlay_start_sec 决定
    if (trackIdx > 0 && s.video_url) {
      const tm0 = s.transform_meta ?? null;
      const spd0 = tm0?.speed && tm0.speed > 0 ? tm0.speed : 1;
      const srcDur0 = s.clip_dur_sec ?? shown;
      const oc: RenderClip = {
        id: `c_${s.id}`,
        mediaId: mediaIdOf(s.video_url, srcDur0),
        timelineStartSec: s.overlay_start_sec ?? 0,
        durationSec: srcDur0 / spd0,
        sourceInSec: s.clip_in_sec ?? 0,
        sourceDurationSec: srcDur0,
        speed: spd0,
        transform: toTransform(tm0),
        effects: toEffects(tm0),
        audio: toAudio(tm0),
        blendMode: tm0?.blendMode ?? "normal",
      };
      const list = overlayByTrack.get(trackIdx) ?? [];
      list.push(oc);
      overlayByTrack.set(trackIdx, list);
      clipIdByShotId.set(s.id, oc.id);
      continue;                       // 关键：不推进 cursor
    }

    shotStartSec.set(s.order, cursor);
    if (s.video_url) {
      const tm = s.transform_meta ?? null;
      const speed = tm?.speed && tm.speed > 0 ? tm.speed : 1;
      // 分割过的镜头带取片窗口；没有就整段用
      const inSec = s.clip_in_sec ?? 0;
      const srcDur = s.clip_dur_sec ?? shown;
      clipIdByShotId.set(s.id, `c_${s.id}`);
      videoClips.push({
        id: `c_${s.id}`,
        mediaId: mediaIdOf(s.video_url, srcDur),
        timelineStartSec: cursor,
        // 变速后在成片上占用的时长
        durationSec: srcDur / speed,
        sourceInSec: inSec,
        sourceDurationSec: srcDur,
        speed,
        transform: toTransform(tm),
        effects: toEffects(tm),
        audio: toAudio(tm),
      });
      cursor += srcDur / speed;
    } else {
      // scope=all 时未出片的镜头：占位不产出画面，仍占时间轴位置
      cursor += shown;
    }
  }

  const tracks: RenderTrack[] = [{
    id: "v1", kind: "video", layer: 1, muted: false, hidden: false, clips: videoClips,
  }];
  // Overlay 层按 track_index 升序 → layer 递增（数字越大越靠上，后叠加）
  for (const idx of [...overlayByTrack.keys()].sort((a, b) => a - b)) {
    tracks.push({
      id: `v${idx + 1}`, kind: "video", layer: idx + 1,
      muted: false, hidden: false, clips: overlayByTrack.get(idx)!,
    });
  }

  // ---- 音频轨（锚定镜头 order + 镜内偏移 → 绝对秒）----
  const audioByKind = new Map<string, RenderClip[]>();
  for (const a of input.audioClips ?? []) {
    if (!a.url || a.status !== "done") continue;
    const base = shotStartSec.get(a.start_shot_order);
    if (base === undefined) continue;     // 锚定镜头不在导出范围内 → 跳过
    const list = audioByKind.get(a.kind) ?? [];
    list.push({
      id: `a_${a.id}`,
      mediaId: mediaIdOf(a.url, a.duration),
      timelineStartSec: base + a.start_offset_sec,
      durationSec: a.duration > 0 ? a.duration : 3,
      sourceInSec: 0,
      sourceDurationSec: a.duration > 0 ? a.duration : 3,
      speed: 1,
      transform: { ...DEFAULT_TRANSFORM },
      effects: [],
      audio: { ...DEFAULT_AUDIO },
    });
    audioByKind.set(a.kind, list);
  }
  for (const [kind, clips] of audioByKind) {
    tracks.push({
      id: `audio_${kind}`, kind: "audio", layer: 0,
      muted: false, hidden: false, clips,
    });
  }

  // ---- 字幕 ----
  const subtitles: RenderSubtitle[] = [];
  for (const sub of input.subtitleClips ?? []) {
    const base = shotStartSec.get(sub.start_shot_order);
    if (base === undefined) continue;
    subtitles.push({
      id: sub.id,
      text: sub.text,
      startSec: base + sub.start_offset_sec,
      durationSec: sub.duration > 0 ? sub.duration : 3,
      style: sub.style ?? undefined,
    });
  }

  return {
    projectId,
    media,
    tracks,
    // 转场：后端按 shot 存，这里翻成 clip 引用。
    // 指向"不在本次导出范围内"的镜头的转场直接丢弃——留着会让编译器
    // 找不到对端 clip，进而把整段的时间轴算错。
    transitions: (input.transitions ?? [])
      .map((t) => ({
        id: t.id,
        type: t.type,
        durationSec: t.duration,
        fromClipId: clipIdByShotId.get(t.from_shot_id) ?? "",
        toClipId: clipIdByShotId.get(t.to_shot_id) ?? "",
      }))
      .filter((t) => t.fromClipId && t.toClipId),
    subtitles,
    output,
    totalSec: cursor,
  };
}
