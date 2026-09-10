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
import { audioTrackKindOf } from "../render/trackFlags";
import { audioPlaySec } from "../lib/audioClip";

/** 未指定时长时的兜底（后端 duration_sec 可能为 null） */
const DEFAULT_SHOT_SEC = 5;

export function shotDuration(s: ShotInfo): number {
  // 3.1：优先取片窗口长度，与导出（render/normalize.ts 的
  // `clip_dur_sec ?? duration_sec`）和字幕定时（后端 effective_shot_sec）同口径。
  //
  // 后端已经把 `duration_sec == clip_dur_sec` 作为不变式强制维持
  // （split / unsplit / patch_shot_timeline 三处写入者），所以今天这一行
  // 取哪个都一样（dev 库实测 0 行不一致）。写成这样是为了**结构上**与导出一致：
  // 万一将来哪条路径又把两者写岔，时间轴显示的会是真正出片的那个长度，
  // 而不是"轨上 2.4s、成片 5s"。
  if (s.clip_dur_sec != null && s.clip_dur_sec > 0) return s.clip_dur_sec;
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

/**
 * 3.3：时间轴上的**片段边界**（升序、去重），供 ↑/↓ 跳边界与 Home/End 用。
 *
 * 直接由 `buildOrderOffsetMap` 派生，与画线、`secToPosition` 同源 ——
 * 理由见本文件末尾 `secToPosition` 的长注释：这条时间轴上曾同时存在**三套**
 * 累加算法，"线画在一处、跳到的是另一处"。跳边界是第四个需要绝对秒的地方，
 * 绝不能再自己写一遍累加。
 *
 * 末元素 = 最后一个**启用**镜头的结尾，也就是播放头能到的最远处
 * （再往后没有画面可预览，End 停在这里才有意义）。
 * 停用镜头在 map 里占位但不推进时间轴，所以它不产生新的边界。
 */
export function buildEdgeSecs(shots: ShotInfo[]): number[] {
  const map = buildOrderOffsetMap(shots);
  const out: number[] = [];
  let end = 0;
  for (const s of [...shots].sort((a, b) => a.order - b.order)) {
    if ((s.track_index ?? 0) > 0) continue;
    if (s.disabled) continue;
    const start = map.get(s.order);
    if (start === undefined) continue;
    out.push(start);
    end = start + shotDuration(s);
  }
  if (!out.length) return [0];
  out.push(end);
  // 0 时长的脏数据会让相邻两个边界重合，去重后 ↑/↓ 才不会"按了没动"
  return [...new Set(out.map((x) => Math.round(x * 100) / 100))]
    .sort((a, b) => a - b);
}

/**
 * 7.2：把主轨上的停用镜头折叠成标记。
 *
 * ## 折叠之前是什么样
 *
 * `buildOrderOffsetMap` 里 `if (!s.disabled) acc += …` —— 停用镜头**不推进**
 * 累加，所以它拿到的 `startSec` 与**后继镜头完全相同**。而 `shotToClip` 又照
 * 原时长给它 `durationSec`，于是它被整格画在后继镜头的位置上，且因为 DOM 里
 * 排在前面，后继镜头把它**整块盖住**：用户看不见它、点不到它，也就**没有任何
 * 路径能再把它启用回来**（右键菜单要先点中才出得来）。停用是可逆操作，却在
 * UI 上变成了单向的 —— 这正是本条要修的。
 *
 * ## 为什么是「时长置 0 + 像素层错开」，而不是给它分配一点秒数
 *
 * 停用镜头**真的**不占时间：`buildOrderOffsetMap` 与 `render/normalize.ts` 都
 * 这么算，成片里它一帧都不出现。所以 `durationSec: 0` 是这条数据的真话，
 * 顺带修掉一串把它当成「有长度的格子」的地方（播放头落在哪一镜、框选范围、
 * 吸附点、在播放头处分割 —— 今天这些都会先命中那个看不见的停用镜头）。
 *
 * 反过来，"给它 0.3 秒好腾个位置"会推动 `buildOrderOffsetMap` 的累加值，
 * 而音频/字幕锚点、播放头边界、接缝位置全都由它派生，**导出侧却不会跟着动**
 * ——时间轴与成片当场分家，且不报错。所以位置只能在像素层解决。
 *
 * ## 为什么要 `collapsedIndex` 而不是一个布尔
 *
 * 连续停用三镜时，三个标记的 `startSec` 一模一样。只给布尔的话它们会叠在同一
 * 个像素上，三个只看得见一个（还是"看不见 = 启用不回来"那个老问题，只是从
 * 被后继盖住变成被同伴盖住）。下标让它们依次往左排开。
 */
export function collapseDisabled(clips: Clip[]): Clip[] {
  let run = 0;
  return clips.map((c) => {
    if (!c.disabled) { run = 0; return c; }
    return { ...c, durationSec: 0, collapsedIndex: run++ };
  });
}

/** ShotInfo → Clip */
export function shotToClip(s: ShotInfo, startSec: number, trackId: string): Clip {
  // effective 注入集合：(L1 ∪ add) − remove，与后端 db.effective_characters 同口径。
  // 轨道显示必须等于实际注入行为，否则用户按显示调参考图会调错。
  const ov = s.ref_overrides ?? {};
  const rm = new Set(ov.remove ?? []);
  const characters = [...s.characters, ...(ov.add ?? [])].filter((c) => !rm.has(c));
  const rmLoc = new Set(ov.remove_loc ?? []);
  // 场景走**归一名**：`clip.location` 会被拿去和场景资产（按归一名存）比对，
  // 且 remove_loc 现在也存归一名——用原名两边都比不中。
  const l1Loc = s.location_canonical ?? s.location;
  const locs = [...(l1Loc ? [l1Loc] : []), ...(ov.add_loc ?? [])]
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
    entity: "shot",
    shotOrder: s.order,
    episode: s.episode,
    mediaUrl: s.video_url ?? undefined,
    thumbUrl: s.thumb_url ?? undefined,
    clipInSec: s.clip_in_sec ?? undefined,
    clipDurSec: s.clip_dur_sec ?? undefined,
    label: s.is_special ? (s.special_name || "外部素材") : `#${s.order}`,
    disabled: s.disabled,
    // P2-7：留黑存在 transform_meta 里（不是顶层字段），这里镜像一份给
    // ClipView 画角标用。`=== true` 不是多余的：transform_meta 是后端原样
    // 透传的 JSON 口袋，老数据里没有这个键，拿到的是 undefined。
    blackout: s.transform_meta?.blackout === true,
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
    entity: "audio",
    startSec: base + a.start_offset_sec,
    // 6.9：播放时长是**算出来的** —— 剪过就用窗口长度，没剪过才用素材总长。
    // 读反了（直接用 a.duration）的症状是：剪完右边缘、时间轴上那一格立刻
    // 弹回原长，而导出出来的确实是剪过的 —— 界面和成片各说各话。
    durationSec: audioPlaySec(a),
    clipInSec: a.clip_in_sec ?? undefined,
    clipDurSec: a.clip_dur_sec ?? undefined,
    sourceDurSec: a.duration > 0 ? a.duration : undefined,
    anchorOrder: a.start_shot_order,
    anchorOffsetSec: a.start_offset_sec,
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
    entity: "subtitle",
    startSec: base + sub.start_offset_sec,
    // 字幕没有素材，`duration` 本身就是播放时长（不像音频要和源长区分），
    // 所以既没有 clipInSec/clipDurSec，也没有 sourceDurSec。
    durationSec: sub.duration > 0 ? sub.duration : 3,
    anchorOrder: sub.start_shot_order,
    anchorOffsetSec: sub.start_offset_sec,
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
  // 7.2：主轨的停用镜头折叠成标记。**只折叠主轨** —— 叠加层的位置由
  // `overlay_start_sec` 决定，它本来就不与谁共用起点，没有被盖住的问题。
  videoTrack.clips = collapseDisabled(mainShots.map((s) =>
    shotToClip(s, offsetMap.get(s.order) ?? 0, videoTrack.id)));

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
    //
    // 4.6：这套对应关系被提到 `render/trackFlags.ts` 由编辑侧与导出侧共用。
    // 各写一份的话，将来后端加一种 kind、这边归了轨而那边漏了静音，
    // 表现就是"点了静音但那一类音频还在"，且只在有那种 kind 的项目上复现。
    const byKind = audioTrackKindOf(a.kind);
    const t = byKind === "music" ? musicTrack
      : byKind === "audio" ? audioTrack
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
