/**
 * adapters/shotToClip.ts — 后端数据 → 前端时间轴模型
 *
 * 唯一转换入口（PLAN §5）。后端字段变动只改这一处，Timeline 组件不受影响。
 *
 * 时间坐标计算：后端 Shot 只有 order（第几个镜头），没有绝对秒。
 * 绝对起点 = 前面所有**未停用**镜头的 duration_sec 累加。
 * 停用镜头仍在轨上渲染（视觉标灰），但不占时间——与导出口径一致。
 */

import type {
  ShotInfo, AudioClipInfo, StageInfo, LocationInfo, AssetInfo, SubtitleClipInfo,
} from "../api";
import type { Clip, Track, Timeline, AssetSegment } from "../types/timeline";

/** 未指定时长时的兜底（后端 duration_sec 可能为 null） */
const DEFAULT_SHOT_SEC = 5;

export function shotDuration(s: ShotInfo): number {
  return s.duration_sec != null && s.duration_sec > 0 ? s.duration_sec : DEFAULT_SHOT_SEC;
}

/** 镜头 order → 绝对起始秒 的映射表（停用镜头不占时间，但保留条目便于定位） */
export function buildOrderOffsetMap(shots: ShotInfo[]): Map<number, number> {
  const map = new Map<number, number>();
  let acc = 0;
  for (const s of [...shots].sort((a, b) => a.order - b.order)) {
    // 叠加层不参与顺序累加——它的位置由 overlay_start_sec 决定。
    // 与 render/normalize.ts 必须同口径，否则时间轴显示与导出结果对不上。
    if ((s.track_index ?? 0) > 0) continue;
    map.set(s.order, acc);
    if (!s.disabled) acc += shotDuration(s);
  }
  return map;
}

/** ShotInfo → Clip */
export function shotToClip(s: ShotInfo, startSec: number, trackId: string): Clip {
  // effective 注入集合：(L1 ∪ add) − remove，与后端 db.effective_characters 同口径。
  // 轨道显示必须等于实际注入行为，否则用户按显示调参考图会调错。
  const ov = s.ref_overrides ?? {};
  const rm = new Set(ov.remove ?? []);
  const characters = [...s.characters, ...(ov.add ?? [])].filter((c) => !rm.has(c));
  const rmLoc = new Set(ov.remove_loc ?? []);
  const locs = [...(s.location ? [s.location] : []), ...(ov.add_loc ?? [])]
    .filter((c) => !rmLoc.has(c));

  const status: Clip["status"] =
    s.status === "failed" ? "failed"
      : s.status === "generating" || s.status === "prompting" ? "generating"
        : s.video_url ? "done" : "pending";

  return {
    id: s.id,
    trackId,
    startSec,
    durationSec: shotDuration(s),
    shotId: s.id,
    shotOrder: s.order,
    episode: s.episode,
    mediaUrl: s.video_url ?? undefined,
    thumbUrl: s.thumb_url ?? undefined,
    label: s.is_special ? (s.special_name || "外部素材") : `#${s.order}`,
    disabled: s.disabled,
    isSpecial: s.is_special,
    status,
    currentVersion: s.adopted_version ?? undefined,
    promptState: s.prompt_state ?? undefined,
    refsStale: s.refs_stale,
    firstFrameUrl: s.first_frame_url ?? undefined,
    scriptRef: s.script_ref,
    characters,
    location: locs[0],
  };
}

/** AudioClipInfo → Clip（锚定镜头 order + 镜内偏移 → 绝对秒） */
export function audioToClip(
  a: AudioClipInfo, offsetMap: Map<number, number>, trackId: string,
): Clip {
  const base = offsetMap.get(a.start_shot_order) ?? 0;
  return {
    id: a.id,
    trackId,
    startSec: base + a.start_offset_sec,
    durationSec: a.duration > 0 ? a.duration : 3,
    mediaUrl: a.url ?? undefined,
    label: a.kind === "tts" ? (a.text?.slice(0, 20) || "旁白") : "配乐",
    disabled: false,
    isSpecial: false,
    status: a.status === "done" ? "done"
      : a.status === "failed" ? "failed"
        : a.status === "generating" ? "generating" : "pending",
    refsStale: false,
    characters: [],
  };
}

/** StageInfo → AssetSegment（Phase 5 资产轨；present_orders 是"实际注入"的镜头集合）
 *
 * 一个 stage 的 present_orders 可能不连续（角色中途没出场），因此按连续段切分成
 * 多个 AssetSegment——画成一整条会让用户以为中间那些镜头也注入了这个造型。 */
export function stageToSegments(
  st: StageInfo, offsetMap: Map<number, number>, durMap: Map<number, number>,
  trackId: string,
): AssetSegment[] {
  if (!st.present_orders.length) return [];
  const orders = [...st.present_orders].sort((a, b) => a - b);
  const runs: number[][] = [];
  let cur: number[] = [orders[0]];
  for (let i = 1; i < orders.length; i++) {
    if (orders[i] === orders[i - 1] + 1) cur.push(orders[i]);
    else { runs.push(cur); cur = [orders[i]]; }
  }
  runs.push(cur);

  return runs.map((run, idx) => {
    const startSec = offsetMap.get(run[0]) ?? 0;
    const lastStart = offsetMap.get(run[run.length - 1]) ?? startSec;
    const lastDur = durMap.get(run[run.length - 1]) ?? DEFAULT_SHOT_SEC;
    return {
      id: `${st.id}:${idx}`,
      trackId,
      startSec,
      durationSec: Math.max(0.5, lastStart + lastDur - startSec),
      assetId: st.id,
      assetName: st.character_name,
      assetKind: "character" as const,
      imageUrl: st.effective_image_url ?? st.image_url ?? undefined,
      stageName: st.stage_name,
      stageId: st.id,
      affectedShotOrders: run,
      locked: st.status === "confirmed",
    };
  });
}

/** LocationInfo → AssetSegment（场景轨，切分逻辑同上） */
export function locationToSegments(
  loc: LocationInfo, offsetMap: Map<number, number>, durMap: Map<number, number>,
  trackId: string, assets: AssetInfo[],
): AssetSegment[] {
  if (!loc.present_orders.length) return [];
  const orders = [...loc.present_orders].sort((a, b) => a - b);
  const runs: number[][] = [];
  let cur: number[] = [orders[0]];
  for (let i = 1; i < orders.length; i++) {
    if (orders[i] === orders[i - 1] + 1) cur.push(orders[i]);
    else { runs.push(cur); cur = [orders[i]]; }
  }
  runs.push(cur);

  const asset = assets.find((a) => a.kind === "location" && a.name === loc.name);
  return runs.map((run, idx) => {
    const startSec = offsetMap.get(run[0]) ?? 0;
    const lastStart = offsetMap.get(run[run.length - 1]) ?? startSec;
    const lastDur = durMap.get(run[run.length - 1]) ?? DEFAULT_SHOT_SEC;
    return {
      id: `loc:${loc.name}:${idx}`,
      trackId,
      startSec,
      durationSec: Math.max(0.5, lastStart + lastDur - startSec),
      assetId: asset?.id ?? loc.name,
      assetName: loc.name,
      assetKind: "location" as const,
      imageUrl: loc.image_url ?? undefined,
      affectedShotOrders: run,
      locked: false,
    };
  });
}

/** SubtitleClipInfo → Clip（字幕轨；锚定镜头 order + 镜内偏移 → 绝对秒） */
export function subtitleToClip(
  sub: SubtitleClipInfo, offsetMap: Map<number, number>, trackId: string,
): Clip {
  const base = offsetMap.get(sub.start_shot_order) ?? 0;
  return {
    id: sub.id,
    trackId,
    startSec: base + sub.start_offset_sec,
    durationSec: sub.duration > 0 ? sub.duration : 3,
    label: sub.text.slice(0, 24),
    disabled: false,
    isSpecial: false,
    status: "done",
    refsStale: false,
    characters: [],
  };
}

function emptyTrack(id: string, kind: Track["kind"], label: string, height: number): Track {
  return {
    id, kind, label, height,
    locked: false, hidden: false, muted: false, solo: false, collapsed: false,
    clips: [], assetSegments: [],
  };
}

export interface BuildTimelineInput {
  shots: ShotInfo[];
  audioClips?: AudioClipInfo[];
  subtitleClips?: SubtitleClipInfo[];
  stages?: StageInfo[];
  locations?: LocationInfo[];
  assets?: AssetInfo[];
}

/** 主入口：后端数据 → Timeline */
export function buildTimeline(input: BuildTimelineInput): Timeline {
  const shots = [...input.shots].sort((a, b) => a.order - b.order);
  const offsetMap = buildOrderOffsetMap(shots);
  const durMap = new Map(shots.map((s) => [s.order, shotDuration(s)]));

  // ---- 资产轨（Phase 5 填充交互，Phase 1/2 先渲染只读段）----
  const charTrack = emptyTrack("track-asset-char", "asset-char", "人物", 40);
  const locTrack = emptyTrack("track-asset-loc", "asset-loc", "场景", 34);
  const refTrack = emptyTrack("track-asset-ref", "asset-ref", "参考资产", 34);

  for (const st of input.stages ?? []) {
    charTrack.assetSegments.push(
      ...stageToSegments(st, offsetMap, durMap, charTrack.id));
  }
  for (const loc of input.locations ?? []) {
    locTrack.assetSegments.push(
      ...locationToSegments(loc, offsetMap, durMap, locTrack.id, input.assets ?? []));
  }

  // ---- 视频轨：主轨（顺序）+ Overlay 叠加层（按 overlay_start_sec 定位）----
  // 拆分依据与 render/normalize.ts 一致：track_index=0 走主轨顺序累加，
  // 1+ 是叠加层，各自成轨，数字越大越靠上（渲染时后叠加）。
  const mainShots = shots.filter((s) => (s.track_index ?? 0) === 0);
  const overlayShots = shots.filter((s) => (s.track_index ?? 0) > 0);

  const videoTrack = emptyTrack("track-video-1", "video", "视频 1", 64);
  videoTrack.clips = mainShots.map((s) =>
    shotToClip(s, offsetMap.get(s.order) ?? 0, videoTrack.id));

  const overlayTracks: Track[] = [];
  const byIndex = new Map<number, ShotInfo[]>();
  for (const s of overlayShots) {
    const i = s.track_index ?? 1;
    byIndex.set(i, [...(byIndex.get(i) ?? []), s]);
  }
  // 降序：叠加层在时间轴上显示在主轨**上方**，层号大的在最上
  for (const idx of [...byIndex.keys()].sort((a, b) => b - a)) {
    const t = emptyTrack(`track-video-${idx + 1}`, "overlay", `叠加 ${idx}`, 48);
    t.clips = byIndex.get(idx)!.map((s) =>
      shotToClip(s, s.overlay_start_sec ?? 0, t.id));
    overlayTracks.push(t);
  }

  // ---- 字幕轨（TB-02：锚定镜头 + 镜内偏移 → 绝对秒）----
  const subtitleTrack = emptyTrack("track-subtitle", "subtitle", "字幕", 30);
  for (const sub of input.subtitleClips ?? []) {
    subtitleTrack.clips.push(subtitleToClip(sub, offsetMap, subtitleTrack.id));
  }

  // ---- 音频轨 ----
  const voiceTrack = emptyTrack("track-voice", "voice", "旁白", 40);
  const musicTrack = emptyTrack("track-music", "music", "配乐", 36);
  const audioTrack = emptyTrack("track-audio", "audio", "音效", 32);
  for (const a of input.audioClips ?? []) {
    // kind="shot"（从镜头视频剥出的原声）归「音效」轨：
    // 它既不是旁白也不是配乐，且与视频一一对应，单独一轨才看得清对位关系。
    // kind="narration"（解说剧的剧本旁白）归「旁白」轨——它就是旁白，
    // 和手工 TTS 同性质，混在一起看反而清楚（都是"人在说话"那一层）。
    const t = a.kind === "music" ? musicTrack
      : a.kind === "shot" ? audioTrack
        : voiceTrack;
    t.clips.push(audioToClip(a, offsetMap, t.id));
  }

  // 成片总时长 = 主轨顺序累加。**不含叠加层**——它盖在主轨之上，
  // 不延长成片（与 render/normalize.ts 的 totalSec 必须同口径，
  // 否则刻度尺比实际成片长，播放头永远走不到头）。
  const mainDurationSec = mainShots
    .filter((s) => !s.disabled)
    .reduce((acc, s) => acc + shotDuration(s), 0);
  // 但叠加层可能伸出主轨末尾（比如片尾字幕卡），刻度尺要能显示到它
  const overlayEnd = overlayShots.reduce(
    (m, s) => Math.max(m, (s.overlay_start_sec ?? 0) + shotDuration(s)), 0);
  const totalDurationSec = Math.max(mainDurationSec, overlayEnd);

  const tracks = [
    charTrack, locTrack, refTrack,
    ...overlayTracks,
    videoTrack,
    subtitleTrack,
    voiceTrack, audioTrack, musicTrack,
  ];

  // 空轨默认折叠：8 条轨全展开会把 260px 的时间轴区吃光，而字幕/音效/配乐
  // 在多数项目里长期为空。有内容的轨保持展开。
  for (const t of tracks) {
    if (!t.clips.length && !t.assetSegments.length) t.collapsed = true;
  }

  return { tracks, totalDurationSec };
}

/**
 * buildOrderOffsetMap 的**逆运算**：绝对秒 → {order, offsetSec}。
 *
 * 为什么要有这个函数：时间轴上"点一下定位到哪一镜"曾有**三套**互不相同的
 * 算法 —— 画线用 buildOrderOffsetMap（停用镜头占位但不累加、跳过叠加层、
 * 时长走 shotDuration），而刻度尺 scrub 把停用镜头过滤掉、
 * 刻度尺 cursor 让停用镜头参与累加，两者还都把叠加层算进主轨累加。
 * 结果是同一个 x 坐标，画出来的线和跳到的镜头不是一个 —— 项目里
 * 只要有一个停用镜头或一个叠加层，定位就开始偏，越往后偏得越多。
 *
 * 直接由 buildOrderOffsetMap 派生，保证与画线口径**永远一致**。
 */
export function secToPosition(
  shots: ShotInfo[], sec: number,
): { order: number; offsetSec: number } | null {
  const map = buildOrderOffsetMap(shots);
  if (!map.size) return null;
  const main = [...shots]
    .filter((s) => (s.track_index ?? 0) === 0)
    .sort((a, b) => a.order - b.order);

  let best: { order: number; offsetSec: number } | null = null;
  for (const s of main) {
    const start = map.get(s.order);
    if (start === undefined) continue;
    // 停用镜头在 map 里占位但不推进时间轴，落点不该停在它上面
    if (s.disabled) continue;
    const end = start + shotDuration(s);
    if (sec < end) return { order: s.order, offsetSec: Math.max(0, sec - start) };
    best = { order: s.order, offsetSec: shotDuration(s) };
  }
  // 超出末尾：吸附到最后一个启用镜头的结尾
  return best;
}
