/**
 * features/timeline/clipEdit.ts — 音频/字幕/镜头「拖 · 修剪 · 删」的统一规则层（6.9）
 *
 * ## 这一条为什么被推迟了三个批次
 *
 * E3 审计（doc:1113）记的是「音频/字幕片段既不能拖也不能修剪、也无法从时间轴删除」，
 * 病灶看起来只有一行：`Timeline.tsx` 的 `beginTrim`/`beginTrimIn` 开头就是
 * `if (!clip.shotId) return;`。批次 3 差点就把它删了，停手的理由记在 doc:1754：
 *
 *   · `api.patchAudioClip` **全项目零调用者**，且当时**没有** duration 字段
 *   · `MIN_CLIP_SEC=1` / `MAX_CLIP_SEC_FALLBACK=15` 会把 3 分钟的背景音乐夹到 15 秒
 *
 * 也就是说，先删 gate 的结果是「拖得动、一刷新就弹回去」，或者更糟 ——
 * 「拖得动、存下去了、背景音乐被截成 15 秒」。**比不能拖更糟**：不能拖至少
 * 是诚实的，用户会去别的面板删；能拖但存不住/存错，用户以为自己剪好了。
 *
 * 6.9 先补齐三个硬前置（后端窗口列 + PATCH 通路 + 按实体分的上下限），
 * 才轮到删那一行 gate。本文件就是「按实体分的上下限」那一条。
 *
 * ## 为什么规则要单独一个文件，而不是写在 Timeline.tsx 里
 *
 * 与 `trim.ts` / `selection.ts` 同一个理由，且这次更硬：三种实体的差别**不是**
 * 参数不同，是**语义不同**。举一个最容易写错的：拖左边缘。
 *
 *   · 镜头：时间轴无缝顺排，剪掉开头 → 这一格变窄、**左边缘不动**、后面整体前移
 *   · 音频：锚在「第 N 镜 + 偏移」上，剪掉开头 → **左边缘右移**、后面的音频不动
 *
 * 两者都叫"拖左边缘"，做的却是相反的事。写在事件处理器里就会变成一串
 * `if (entity === ...)` 混在 DOM 计算中间，而 DOM 计算在 node 下测不了 ——
 * 于是最容易错的部分恰好是唯一没有测试的部分（`appGate.ts` 文件头记过同一件事）。
 *
 * 所以这里只做纯计算：进去是「片段 + 目标秒数」，出来是「该发什么 PATCH」。
 * `Timeline.tsx` 负责把鼠标位置换成秒，`App.tsx` 负责把 patch 发出去。
 *
 * ## 时长上下限：三套，不是一套
 *
 * | 实体 | 下限 | 上限 | 上限的**依据** |
 * |---|---|---|---|
 * | 镜头 | `MIN_CLIP_SEC` 1s | `shot_duration_max`（缺省 15s） | 业务约束：AI 一次能生成多长 |
 * | 音频 | `MIN_WINDOW_SEC` 0.1s | 素材剩余长度 | 物理约束：素材就这么长 |
 * | 字幕 | `MIN_WINDOW_SEC` 0.1s | 无 | 字幕没有素材，多长都能显示 |
 *
 * ⚠️ 这三列的**依据**互不相干，这正是不能共用一套常量的原因。
 * 拿镜头那套去卡音频 = 3 分钟 BGM 被夹到 15 秒（推迟时记下的原坑）；
 * 拿音频那套去卡镜头 = 允许生成一个 0.1 秒的镜头，下发给模型直接失败。
 */

import type { Clip, ClipEntity } from "../../types/timeline";
import { MIN_CLIP_SEC, MIN_WINDOW_SEC, MAX_CLIP_SEC_FALLBACK } from "./trim";

/** 一次编辑要写回后端的东西。按实体分派到三个不同的端点，见 `App.tsx`。 */
export interface ClipEditPatch {
  entity: ClipEntity;
  id: string;
  /** 音频：修剪窗口入点 */
  clipInSec?: number;
  /** 音频：修剪窗口长度 */
  clipDurSec?: number;
  /** 字幕：播放时长（字幕没有窗口，`duration` 就是时长） */
  durationSec?: number;
  /** 拖动：新的锚点镜头 order */
  startShotOrder?: number;
  /** 拖动：新的镜内偏移 */
  startOffsetSec?: number;
  /** 音频：清空修剪窗口（回到"整段使用"）。**不是**写 0 —— 见 `clearTrimPatch`。 */
  clearClip?: true;
}

/** 某个片段的时长上下限。`max` 为 `Infinity` 表示"没有上限"（字幕）。 */
export interface DurationBounds { min: number; max: number }

/**
 * 这个片段的时长能在什么范围内。
 *
 * @param maxShotSec 镜头的生成时长上限（`detail.shot_duration_max`）。
 *        只对镜头有意义，传不传都不影响音频/字幕 —— 这正是本函数存在的理由。
 */
export function durationBounds(clip: Clip, maxShotSec?: number): DurationBounds {
  if (clip.entity === "shot") {
    return { min: MIN_CLIP_SEC, max: maxShotSec ?? MAX_CLIP_SEC_FALLBACK };
  }
  if (clip.entity === "audio") {
    // 上限 = 素材总长 - 已剪掉的开头。素材长度未知（还在合成 / 素材池没探测出来）
    // 时不设上限：宁可让用户拖过头被后端夹回来，也不要凭空编一个上限把
    // 一段其实很长的音频锁死在某个数字上（那正是 15 秒那个坑的形状）。
    const src = clip.sourceDurSec;
    if (src === undefined || src <= 0) return { min: MIN_WINDOW_SEC, max: Infinity };
    return { min: MIN_WINDOW_SEC, max: Math.max(MIN_WINDOW_SEC, src - (clip.clipInSec ?? 0)) };
  }
  // 字幕：没有素材，也就没有"素材用完了"这回事。
  return { min: MIN_WINDOW_SEC, max: Infinity };
}

/** 夹持到上下限内。`Infinity` 上限下 `Math.min` 天然是 no-op，无需特判。 */
export function clampDuration(sec: number, b: DurationBounds): number {
  return Math.max(b.min, Math.min(b.max, sec));
}

/** 秒数取两位小数。后端也 round 到两位，两边不一致会让拖完立刻回跳一丁点。 */
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 拖**右**边缘：把片段的播放时长改成 `wantSec`。
 *
 * 三种实体在这里的差别只有"写哪个字段"，语义是一致的（都是"播到哪儿为止"），
 * 所以合成一个函数。左边缘不是这样，见 `trimInPatch`。
 */
export function trimOutPatch(
  clip: Clip, wantSec: number, maxShotSec?: number,
): ClipEditPatch | null {
  const dur = r2(clampDuration(wantSec, durationBounds(clip, maxShotSec)));
  // 没变就不发。空 PATCH 会白白触发一次全量刷新，拖动时每一帧都发一次
  // 就是一串刷新风暴（P2-5 合并刷新压的正是这个）。
  if (Math.abs(dur - clip.durationSec) < 0.005) return null;
  if (clip.entity === "audio") {
    return { entity: "audio", id: clip.id, clipDurSec: dur };
  }
  if (clip.entity === "subtitle") {
    return { entity: "subtitle", id: clip.id, durationSec: dur };
  }
  // 镜头走的是既有的 3.1 通路（clip_in_sec/clip_dur_sec + duration_sec 不变式），
  // 由 trim.ts 负责，这里只给出窗口值。
  return { entity: "shot", id: clip.id, clipDurSec: dur };
}

/**
 * 拖左边缘时 `deltaSec` 的取值范围（正数 = 往右剪、负数 = 往左还回来）。
 *
 * ## 为什么 `min` 不是 0
 *
 * 只允许正数的话，左边缘就是**单向阀**：剪掉的开头永远拖不回来。
 * 用户拖过头了只能靠 Ctrl+Z —— 而撤销栈跨会话不存在，关掉软件再打开，
 * 那段音频的开头就永久没了（后端数据还在，只是 UI 上没有任何路径能还原它）。
 * 这正是 ClipView 上那个剪刀角标想提醒、却提醒完无路可走的状态。
 *
 * 能还回来多少，由**两个各自独立的余量**取小：
 *   · 素材余量：`clipInSec` —— 之前剪掉了多少，就最多还回来多少（字幕恒为 0，
 *     它没有素材，"往左"只能靠提前出现）
 *   · 位置余量：`anchorOffsetSec` —— 左边缘要跟着左移，移到锚点镜头的开头就到头了。
 *     再往左需要**改锚到上一镜**，那是"拖动整段"（`movePatch`）在做的事，
 *     不是修剪。混进来的话，一次拖左边缘会同时改锚点和窗口，出问题时
 *     分不清是哪一半错了。到边就停，用户想让它更早开始就整段拖。
 */
export function trimInDeltaBounds(clip: Clip): DurationBounds {
  const b = durationBounds(clip);
  // 剪掉开头之后至少要剩 min，否则就成了一个长度为负的段
  const max = clip.durationSec - b.min;
  if (clip.entity === "shot") return { min: 0, max };
  const material = clip.entity === "audio" ? (clip.clipInSec ?? 0) : 0;
  const room = clip.anchorOffsetSec ?? 0;
  return { min: -Math.min(material, room), max };
}

/**
 * 拖**左**边缘：把片段的起点移动 `deltaSec`（正数 = 剪掉开头，负数 = 还回来）。
 *
 * ⚠️ 这是三种实体分歧最大的一处，也是本文件存在的主要理由：
 *
 *   · **音频**：素材往里推（`clipInSec += delta`）、时长同步变短、
 *     **并且锚点偏移 += delta**（左边缘真的右移）。三件事必须一起发，
 *     少一件的症状分别是：声音跑了 / 格子长度不对 / 格子原地不动。
 *   · **字幕**：没有素材可推，只有"晚点出现、短一点"（偏移 += delta、时长 -= delta）。
 *   · **镜头**：由既有的 `trim.ts` 处理（无缝顺排，左边缘不动），
 *     本函数**不管镜头**，返回 null 让调用方走老路 —— 老路是有测试、
 *     且正在用的，把它挪进来重写一遍只会引入回归。
 *
 * 负 delta 的余量见 `trimInDeltaBounds`。
 */
export function trimInPatch(
  clip: Clip, deltaSec: number,
): ClipEditPatch | null {
  if (clip.entity === "shot") return null;
  const db = trimInDeltaBounds(clip);
  const d = r2(Math.max(db.min, Math.min(db.max, deltaSec)));
  if (Math.abs(d) < 0.005) return null;
  const newOffset = r2(Math.max(0, (clip.anchorOffsetSec ?? 0) + d));
  if (clip.entity === "subtitle") {
    return {
      entity: "subtitle", id: clip.id,
      durationSec: r2(clip.durationSec - d),
      startOffsetSec: newOffset,
    };
  }
  return {
    entity: "audio", id: clip.id,
    clipInSec: r2((clip.clipInSec ?? 0) + d),
    clipDurSec: r2(clip.durationSec - d),
    startOffsetSec: newOffset,
  };
}

/**
 * 拖动整段到绝对秒 `targetSec`：换算成「锚定第几镜 + 镜内偏移」。
 *
 * ⚠️ **必须**用调用方传进来的 `secToPosition`（`adapters/shotToClip.ts`），
 * 不许在这里自己累加镜头时长。那个文件的注释记着：这条时间轴上曾经同时存在
 * 三套各自累加的换算，症状是"线画在一处、片段跳到另一处"。这里再写第四套，
 * 就是第四个会漂移的真源。
 */
export function movePatch(
  clip: Clip, targetSec: number,
  secToPosition: (sec: number) => { order: number; offsetSec: number },
): ClipEditPatch | null {
  if (clip.entity === "shot") return null;   // 镜头是换位不是移动，走既有通路
  const pos = secToPosition(Math.max(0, targetSec));
  return {
    entity: clip.entity, id: clip.id,
    startShotOrder: pos.order,
    startOffsetSec: r2(pos.offsetSec),
  };
}

/**
 * 这个片段身上有没有修剪窗口（＝右键菜单里那个「还原修剪」该不该出现）。
 *
 * 只有音频有窗口。字幕的 `duration` 本身就是时长，改短了就是改短了，
 * 没有"原长"可还原 —— 给它一个还原按钮只能还成一个编出来的数字。
 */
export function hasTrim(clip: Clip): boolean {
  return clip.entity === "audio" && clip.clipDurSec != null && clip.clipDurSec > 0;
}

/**
 * 还原修剪：回到"整段使用"。
 *
 * ⚠️ 写的是 `clearClip` 而不是 `clipInSec: 0, clipDurSec: 素材总长`，两者**不等价**：
 * 后者留下一个"入点 0、长度恰好等于素材"的**假窗口**，这一段从此永远走
 * "已修剪"分支 —— 剪刀角标虽然会消失（判据是 `clipInSec > 0`），但一旦
 * TTS 重合成出一段更长的音频，那个窗口会把新音频截回旧长度，而用户完全
 * 看不出为什么。后端的 `clear_clip` 把两列写回 NULL，才是真的"没剪过"
 * （`routes_v2.py` 的 `patch_audio_clip`，NULL 语义见 `db.py` 的 AudioClip）。
 */
export function clearTrimPatch(clip: Clip): ClipEditPatch | null {
  if (!hasTrim(clip)) return null;
  return { entity: "audio", id: clip.id, clearClip: true };
}

/**
 * 这个片段能不能从时间轴上直接删掉。
 *
 * 音频/字幕：能 —— 6.9 接通了 DELETE 通路，删了就是删了。
 * 镜头：**不能**，这不是"还没做"，是刻意的：AI 镜头删掉意味着重新生成才能拿回来，
 * 所以镜头走的是"停用"（`disabled`，保留在轨但不导出）。外部素材镜头可以删，
 * 但那条路径在 `Timeline.tsx` 已有且有自己的确认弹窗，不从这里走。
 */
export function canDeleteFromTimeline(clip: Clip): boolean {
  return clip.entity === "audio" || clip.entity === "subtitle";
}

/**
 * 这个片段能不能被拖动/修剪。
 *
 * 音频与字幕恒为真（6.9 起）。镜头**在时间轴上**只能修剪不能拖动，
 * 拖动镜头是"换位"，由 `Timeline.tsx` 的既有拖拽换序处理。
 */
export function canDrag(clip: Clip): boolean {
  return clip.entity === "audio" || clip.entity === "subtitle";
}
