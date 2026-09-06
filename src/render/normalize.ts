/**
 * render/normalize.ts — Timeline（编辑态）→ RenderPlan（冻结的产出描述）
 *
 * 这一步做四件事：
 *   1. 丢掉渲染无关的东西（选中态、折叠、UI 高度）
 *   2. **剔除 AI Asset Track**（PLAN §8）——资产轨表达"生成时参考什么"，
 *      不是"画面上放什么"。让它连进不到 RenderPlan，编译器就不可能误合成。
 *   3. 把后端的 shot 字段翻译成通用 Clip 属性（Shot 只负责提供 Media）
 *   4. 算好绝对时间与总时长，**并按生效转场折叠**（4.0）
 *
 * ## 关于第 4 条：这里的"绝对秒"是成片秒，不是时间轴秒
 *
 * `xfade` 重叠两镜，画面每遇一条生效转场就比时间轴短一个转场时长。4.0 之前
 * cursor 不减这一份，而音频的 `adelay`、字幕的 SRT 时间码、叠加层的起点全都
 * 锚在 cursor 上 —— 于是成片是「画面折叠、声音和字幕不折叠」的：每多一条
 * 生效转场，后面所有旁白与字幕就相对画面再晚一个转场时长，且完全静默。
 *
 * 现在 cursor 走的是**成片坐标**。判定「哪条转场真的会折叠」的规则在
 * `lib/transitionFold.ts`，与时间轴上画接缝的 `buildSeamMarkers` 同源。
 * 时间轴本身仍是未折叠坐标（理由见 transitions.ts 头注释），两者之间的换算
 * 就是 `foldTime` —— 本文件里只有叠加层需要它，因为只有它的位置不锚在镜头上。
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
import { foldingLinks, foldTime } from "../lib/transitionFold";
import type { Seam } from "../lib/transitionFold";
import { renderAudioTrackId } from "./trackFlags";
import { audioPlaySec } from "../lib/audioClip";

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
  /**
   * 这个类型的转场在本机 ffmpeg 上是否真会被执行（4.0）。
   *
   * 编译器只在 `hasFilter(caps,"xfade") && hasTransition(caps,type)` 时才走 xfade，
   * 否则降级为硬切、画面**不折叠**。折叠预测若不带上这个条件，在缺某个转场类型的
   * 老 ffmpeg 上会反过来把音频/字幕锚早一个转场时长 —— 同一个 bug 换个方向。
   *
   * 缺省（不传）一律视作会执行：拿不到 caps 时这是最接近现实的假设。
   */
  foldsTransition?: (type: string) => boolean;
  /**
   * 轨道级静音 / 隐藏（4.6）。**键是 RenderTrack.id**（`v1` / `v{n}` /
   * `audio_{kind}`），由 `render/trackFlags.ts` 的 `collectTrackFlags` 生成 ——
   * 时间轴那边的 id 是另一套（`track-video-1` / `track-voice`），
   * 不能直接把 store 的轨道 id 塞进来，理由与映射表见那个文件的头注释。
   *
   * 4.6 之前这两个标志在下面三处被写死成 `false`，于是点了静音再导出，
   * BGM 照样在成片里。下游其实早就在读了（`renderer.ts` 筛 `!t.muted`、
   * `segment.ts` 筛 `!t.hidden`），缺的只是让真值流过来。
   *
   * 不传 = 全部按未静音/未隐藏处理，所以既有调用方与 verify 脚本零改动。
   */
  trackFlags?: { muted?: readonly string[]; hidden?: readonly string[] };
}

/** transform_meta（后端存储形态，-100..100 的滑块值）→ 规范化 RenderTransform
 *
 *  `out` 只为 x/y 服务：存储态是**画布百分比**（分辨率无关，理由见
 *  `api.ts` 的 `TransformMeta.x`），而 `RenderTransform.x` 是**画布像素**
 *  （编译器直接拿去拼 ffmpeg 的整数几何）。换算只在这一处发生。 */
function toTransform(
  tm: TransformMeta | null | undefined, out: RenderOutput,
): RenderTransform {
  if (!tm) return { ...DEFAULT_TRANSFORM };
  return {
    scale: (tm.scale ?? 100) / 100,
    scaleX: (tm.scaleX ?? tm.scale ?? 100) / 100,
    scaleY: (tm.scaleY ?? tm.scale ?? 100) / 100,
    rotate: tm.rotate ?? 0,
    x: ((tm.x ?? 0) / 100) * out.width,
    y: ((tm.y ?? 0) / 100) * out.height,
    opacity: (tm.opacity ?? 100) / 100,
    mirrorH: !!tm.mirrorH,
    mirrorV: !!tm.mirrorV,
    // V2.3：取景框裁切，直接透传比例值（0..1）
    crop: tm.crop
      ? { left: tm.crop.left, top: tm.crop.top, right: tm.crop.right, bottom: tm.crop.bottom }
      : undefined,
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

/** 调色参数 → 结构化 effect 列表（不产出 filter 字符串，那是 compiler 的事）
 *
 *  `registerAsset` 把效果依赖的**外部资源文件**登记进 `plan.media`，换回媒体 id。
 *  目前只有 LUT 用：`tm.lut` 是服务器 URL，而 ffmpeg 的 `lut3d=file=` 只认本机
 *  文件，所以它必须和普通素材走同一条下载通路（`exportPrep` 全量遍历
 *  `plan.media`），不能等到编译期才发现手上只有个 URL。见 `RenderEffect.assetMediaId`。 */
function toEffects(
  tm: TransformMeta | null | undefined,
  registerAsset: (url: string) => string,
): RenderEffect[] {
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
  if (tm.lut) out.push({ type: "lut", assetUrl: tm.lut, assetMediaId: registerAsset(tm.lut) });
  // V2.3 区域马赛克（每个区域一条 effect entry）
  if (tm.mosaics?.length) {
    for (const m of tm.mosaics) {
      out.push({ type: "mosaic", mosaicParams: { ...m } });
    }
  }
  return out;
}

export function normalize(input: NormalizeInput): RenderPlan {
  const { projectId, output } = input;

  // ---- 选出参与导出的镜头 ----
  //
  // ⚠️ 7.2：**范围**（scope）与**停用**（disabled）是两件不同的事，必须分开判。
  // 合在一个 filter 里是 7.2 之前那个静默丢字幕的 bug 的根：停用镜头被整个滤掉
  // 之后，下面 `shotStartSec` 里就没有它的条目，于是锚定在它身上的音频与字幕
  // 撞上 `if (base === undefined) continue` —— **无声地**从成片里消失，而时间轴上
  // 它们照常显示。用户看到的是"字幕在那儿、导出来没有"，没有任何提示。
  //
  // 正确口径与时间轴的 `buildOrderOffsetMap` 一致：停用镜头**不产出画面、不占
  // 时间，但保留起点条目**（它的起点就是后继镜头的起点）。这样锚在它身上的
  // 旁白/字幕会**合拢**到那个位置继续播——停用的是画面，不是声音和字幕。
  //
  // 「不在范围内」则仍然照旧丢弃：那种情况下这一镜整个不在这次导出里，
  // 把它的字幕塞到 0 秒去才是错的。
  const sorted = [...input.shots].sort((a, b) => a.order - b.order);
  const inScope = (s: ShotInfo): boolean => {
    if (input.scope === "selection") {
      return (input.selectedShotIds ?? []).includes(s.id) && !!s.video_url;
    }
    if (input.scope === "all") return true;
    return !!s.video_url;              // 默认：只导已出片
  };
  const scoped = sorted.filter(inScope);
  const picked = scoped.filter((s) => !s.disabled);

  // ---- Media 去重：同一个 video_url 只登记一次（同素材多次使用是常态）----
  const media: RenderMedia[] = [];
  const mediaIdByUrl = new Map<string, string>();
  const mediaIdOf = (
    url: string,
    durationSec: number,
    kind: RenderMedia["kind"] = "video",
  ): string => {
    const hit = mediaIdByUrl.get(url);
    if (hit) return hit;
    const id = `m${media.length}`;
    mediaIdByUrl.set(url, id);
    media.push({ id, url, kind, durationSec });
    return id;
  };
  // LUT（`.cube`）也当一条 media 登记，这样它能白蹭现成的下载/去重/单飞：
  // 同一个 LUT 铺在 30 个镜头上只会下一次。`durationSec` 无意义填 0。
  // 注意 kind 走 `"lut"` 而不是 `"video"`——探测音轨的开销要按 media 数量算，
  // 拿 `ffmpeg -i` 去探一个 `.cube` 是纯浪费（实测每次约 30ms）。
  const lutIdOf = (url: string): string => mediaIdOf(url, 0, "lut");

  // ---- 已剥离原声的镜头集合 ----
  // 这些镜头的声音已经作为独立音频段存在于音频轨上，视频自带的那一份
  // **必须静音**，否则同一段声音会响两遍（视频一遍 + 音频轨一遍）。
  // 用"存在性"判定而不是给镜头存 muted 标记：删掉音频段静音自动解除，
  // 不会出现"音频段没了但画面还是哑的"这种两处状态不同步的坑。
  //
  // 两种来源都算：
  //   kind="shot"      —— 用户手动点「提取镜头原声」剥出来的
  //   kind="narration" —— 解说剧按剧本切出来的旁白（画面原声本就不该出声）
  const detachedShotIds = new Set(
    (input.audioClips ?? [])
      .filter((a) => (a.kind === "shot" || a.kind === "narration")
        && a.source_shot_id && a.status === "done")
      .map((a) => a.source_shot_id as string),
  );

  // ---- 转场折叠（4.0）----
  // `xfade` 重叠两镜，画面每遇一条生效转场就短一个转场时长；4.0 之前 cursor
  // 不减这一份，导致音频（adelay）与字幕（SRT）相对画面整体偏晚。
  //
  // 链**必须是导出态的链**：只有真的产出 clip 的主轨镜头才在成片里串接。
  // 默认档不导未出片的镜头，跨过它们的两镜在导出时才是相邻的 —— 拿编辑态的
  // 镜头列表去判相邻会得出不同的答案。判据本身在 lib/transitionFold.ts，
  // 与 `buildSeamMarkers` 同源。
  const mainChainIds = picked
    .filter((s) => (s.track_index ?? 0) === 0 && !!s.video_url)
    .map((s) => s.id);
  const folding = foldingLinks(
    mainChainIds,
    (input.transitions ?? []).map((t) => ({
      id: t.id, fromId: t.from_shot_id, toId: t.to_shot_id,
      durationSec: t.duration, type: t.type,
    })),
    input.foldsTransition ? (l) => input.foldsTransition!(l.type ?? "") : undefined,
  );
  /** 链上镜头 id → 进入这一镜之前要扣掉的重叠秒数 */
  const foldBefore = new Map(
    folding.map((l) => [mainChainIds[l.atIndex], l.durationSec] as const));

  // ---- 视频轨：主轨顺序累加，Overlay 层按显式起点定位 ----
  // 分流的理由：叠加层若也参与顺序累加，它就变成"插队"而不是"叠在上面"了。
  const videoClips: RenderClip[] = [];
  const overlayByTrack = new Map<number, RenderClip[]>();
  /** 成片秒（已折叠）—— 主轨 clip、音频锚点、字幕时间码全都用它 */
  let cursor = 0;
  /** 时间轴秒（未折叠）—— 只用来把叠加层的绝对起点换算过来 */
  let rawCursor = 0;
  const seams: Seam[] = [];
  const shotStartSec = new Map<number, number>();   // order → 绝对起点（字幕/音频锚点用）
  const clipIdByShotId = new Map<string, string>(); // 转场需要按 shot 找 clip

  /**
   * 7.2：连续停用镜头的 order 暂存区。
   *
   * 它们的起点 = **后继镜头折叠后的起点**，所以不能在遇到它们的当下就写
   * `cursor`：下一镜若带生效转场，`cursor` 还要往回退一个转场时长，先写就会
   * 让这些字幕比它们该合拢到的那一镜**晚**一个转场时长（4.0 修掉的正是同一类
   * 错位，只是换了个来源）。攒着，等真正落位的那一刻一起写。
   */
  let pendingDisabled: number[] = [];
  const flushDisabled = (atSec: number) => {
    for (const o of pendingDisabled) shotStartSec.set(o, atSec);
    pendingDisabled = [];
  };

  for (const s of scoped) {
    const shown = s.duration_sec ?? DEFAULT_SHOT_SEC;
    const trackIdx = s.track_index ?? 0;

    // 停用：不产出 clip、不推进 cursor，但**保留起点**（合拢到后继镜头处）。
    // 叠加层不参与：它的位置由 overlay_start_sec 决定，从来就不在 shotStartSec
    // 里，锚定叠加层的音频/字幕在 7.2 之前之后都一样被跳过。
    if (s.disabled) {
      if (trackIdx === 0) pendingDisabled.push(s.order);
      continue;
    }

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
        transform: toTransform(tm0, input.output),
        effects: toEffects(tm0, lutIdOf),
        audio: detachedShotIds.has(s.id)
          ? { ...toAudio(tm0), muted: true }   // 原声已剥离到音频轨
          : toAudio(tm0),
        blendMode: tm0?.blendMode ?? "normal",
        blackout: tm0?.blackout === true,   // P2-7：叠加层同样可留黑
      };
      const list = overlayByTrack.get(trackIdx) ?? [];
      list.push(oc);
      overlayByTrack.set(trackIdx, list);
      clipIdByShotId.set(s.id, oc.id);
      continue;                       // 关键：不推进 cursor
    }

    // 这一镜与上一镜之间有生效转场：xfade 把本镜的头与上一镜的尾重叠掉，
    // 成片起点因此前移一个转场时长（编译器那行 `baseDur - tr.durationSec` 的对应）。
    const fold = foldBefore.get(s.id) ?? 0;
    if (fold > 0) {
      seams.push({ atSec: rawCursor, foldSec: fold });
      // 兜 0：tooLong 的脏数据（转场比前面整条链还长）不该产出负的时间码。
      cursor = Math.max(0, cursor - fold);
    }
    shotStartSec.set(s.order, cursor);
    flushDisabled(cursor);   // 7.2：前面攒下的停用镜头合拢到这一镜的起点
    if (s.video_url) {
      const tm = s.transform_meta ?? null;
      const speed = tm?.speed && tm.speed > 0 ? tm.speed : 1;
      // 分割过的镜头带取片窗口；没有就整段用
      const inSec = s.clip_in_sec ?? 0;
      const srcDur = s.clip_dur_sec ?? shown;
      // 变速后在成片上占用的时长
      const outDur = srcDur / speed;
      clipIdByShotId.set(s.id, `c_${s.id}`);
      videoClips.push({
        id: `c_${s.id}`,
        mediaId: mediaIdOf(s.video_url, srcDur),
        timelineStartSec: cursor,
        durationSec: outDur,
        sourceInSec: inSec,
        sourceDurationSec: srcDur,
        speed,
        transform: toTransform(tm, input.output),
        effects: toEffects(tm, lutIdOf),
        audio: detachedShotIds.has(s.id)
          ? { ...toAudio(tm), muted: true }    // 原声已剥离到音频轨
          : toAudio(tm),
        // P2-7 留黑：只影响画面，不动 timelineStartSec / durationSec / audio ——
        // 这正是它与 disabled 的分界（disabled 在上面 273 行就 continue 掉了，
        // 根本不产出 clip；留黑产出一个正常的 clip，只是画面会被填黑）。
        blackout: tm?.blackout === true,
      });
      cursor += outDur;
      rawCursor += outDur;
    } else {
      // scope=all 时未出片的镜头：占位不产出画面，仍占时间轴位置
      cursor += shown;
      rawCursor += shown;
    }
  }
  // 7.2：末尾还压着停用镜头（整片最后几镜被停用）时，它们合拢到成片结尾。
  // 不 flush 的话这几镜上的字幕又回到"静默丢弃"，只是换了个位置发生。
  flushDisabled(cursor);

  // 叠加层的位置是**时间轴绝对秒**（`overlay_start_sec`），而主轨刚刚折叠过 ——
  // 必须换算到同一套坐标，否则叠加层会相对画面整体偏晚。那正是 4.0 在音频与
  // 字幕上修掉的同一个错位，只是换了一条轨：`compileSegment` 里
  // `st = o.c.timelineStartSec - seg.startSec` 是拿它直接减折叠后的段起点的。
  if (seams.length) {
    for (const list of overlayByTrack.values()) {
      for (const oc of list) oc.timelineStartSec = foldTime(oc.timelineStartSec, seams);
    }
  }

  // 4.6：轨道静音/隐藏。三处 RenderTrack 构造都走同一个 flagsFor，
  // 不许只接其中一处 —— "只有视频轨认隐藏、音频轨不认静音"是这条最可能的
  // 半截实现，`verify-trackflags.ts` 按三处逐个钉住。
  const mutedIds = new Set(input.trackFlags?.muted ?? []);
  const hiddenIds = new Set(input.trackFlags?.hidden ?? []);
  const flagsFor = (id: string) => ({
    muted: mutedIds.has(id),
    hidden: hiddenIds.has(id),
  });

  const tracks: RenderTrack[] = [{
    id: "v1", kind: "video", layer: 1, ...flagsFor("v1"), clips: videoClips,
  }];
  // Overlay 层按 track_index 升序 → layer 递增（数字越大越靠上，后叠加）
  for (const idx of [...overlayByTrack.keys()].sort((a, b) => a - b)) {
    tracks.push({
      id: `v${idx + 1}`, kind: "video", layer: idx + 1,
      ...flagsFor(`v${idx + 1}`), clips: overlayByTrack.get(idx)!,
    });
  }

  // ---- 音频轨（锚定镜头 order + 镜内偏移 → 绝对秒）----
  const audioByKind = new Map<string, RenderClip[]>();
  for (const a of input.audioClips ?? []) {
    if (!a.url || a.status !== "done") continue;
    const base = shotStartSec.get(a.start_shot_order);
    // 锚定镜头不在**导出范围**内 → 跳过。
    // ⚠️ 7.2 起「停用」不再走这条：停用镜头保留起点条目，锚在它身上的音频会
    // 合拢到后继镜头处继续播。停用的是画面，不是声音。
    if (base === undefined) continue;
    const list = audioByKind.get(a.kind) ?? [];
    list.push({
      id: `a_${a.id}`,
      // ⚠️ mediaId 用的是**素材总长**，不是修剪后的时长 —— 它是"这是哪个文件"
      // 的身份，与"这次播多少"无关。用修剪后的时长会让同一个文件在剪过之后
      // 变成另一个 mediaId，于是缓存/去重全部失效（同一段 BGM 下载两遍）。
      mediaId: mediaIdOf(a.url, a.duration),
      timelineStartSec: base + a.start_offset_sec,
      // 6.9 修剪窗口。与时间轴共用 `audioPlaySec`，两处各算一遍正是
      // "时间轴上 5 秒、成片里 8 秒"这类偏差的来源（见该函数注释）。
      durationSec: audioPlaySec(a),
      sourceInSec: a.clip_in_sec ?? 0,
      sourceDurationSec: audioPlaySec(a),
      speed: 1,
      transform: { ...DEFAULT_TRANSFORM },
      effects: [],
      audio: { ...DEFAULT_AUDIO },
    });
    audioByKind.set(a.kind, list);
  }
  for (const [kind, clips] of audioByKind) {
    // id 的拼法由 trackFlags.ts 提供：折算静音的那一侧也用同一个函数，
    // 各拼各的就会出现"静音了但 id 对不上、于是没静掉"。
    const id = renderAudioTrackId(kind as AudioClipInfo["kind"]);
    tracks.push({ id, kind: "audio", layer: 0, ...flagsFor(id), clips });
  }

  // ---- 字幕 ----
  const subtitles: RenderSubtitle[] = [];
  for (const sub of input.subtitleClips ?? []) {
    const base = shotStartSec.get(sub.start_shot_order);
    // 同上：不在导出范围才丢；停用镜头上的字幕会合拢到后继镜头处照常显示。
    // 7.2 之前这一行是那个「时间轴上看得见、导出来没有」的静默丢弃点。
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
    // 4.0：已折叠 —— 这是**成片**时长，不是时间轴时长。两者之差正是
    // 3.6 在工具条上显示的那个「成片 −X.Xs」。
    totalSec: cursor,
  };
}
