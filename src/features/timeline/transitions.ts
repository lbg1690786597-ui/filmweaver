/**
 * features/timeline/transitions.ts — 转场在时间轴上的位置与状态（3.6）
 *
 * ## 在此之前，转场是「只进不出」的
 *
 * 转场只存在于 `EffectsPanel` 的图标库里：点一下 → `api.createTransition`
 * 落库 → **然后就再也看不见了**。核对了 API 的调用方：
 *
 *   · `createTransition`  1 个调用点（`App.doApplyTransition`）
 *   · `listTransitions`   1 个（拉下来只喂给导出）
 *   · `patchTransition`   **0 个**
 *   · `deleteTransition`  **0 个**
 *
 * 也就是说：加错了改不了、也删不掉。唯一的补救是往同一条接缝上再加一个
 * （后端会 `replaced`），而"同一条接缝"用户根本看不见，只能靠数镜头去猜。
 * 所以 3.6 的「可见」必须连着「可改、可删」一起做——只画个图标出来，
 * 用户看见了却依然动不了它，比看不见更让人上火。
 *
 * ## 三类「加了但不会生效」的转场，只有画出来才发现得了
 *
 * 转场挂在两个 shot id 上，而它能否生效取决于导出时这两镜是否**仍然相邻**。
 * 加完之后用户完全可能再去删镜头、停用镜头、调顺序、把镜头挪到叠加层：
 *
 *   · 端点被删          → `normalize.ts:276-284` 找不到 clip，整条丢弃
 *   · 端点被停用        → 停用镜头不进 `picked`，同上
 *   · 中间插了别的镜头  → 编译器只在**相邻**两 clip 之间找转场
 *                        （`ffmpegCompiler.ts:550-552`），找不到就静默硬切
 *   · 端点在叠加层上    → 叠加层走 overlay 通路，压根不参与主轨串接
 *
 * 四种情况**都不报错**，成片就是硬切。用户以为自己加了转场，导出后发现没有，
 * 又无从查起。把状态标在接缝上，是这些情况唯一的暴露途径。
 *
 * ## 「成片会比时间轴短」是真的，这里如实算出来
 *
 * `xfade` 是**重叠**两段而不是插入一段：`ffmpegCompiler.ts:558` 那行
 * `baseDur = baseDur - tr.durationSec + cur.c.durationSec` 说得很清楚——
 * 每条生效的转场都让成片**缩短一个转场时长**。而时间轴的总时长
 * （`shotToClip.ts` 的顺序累加）**不减这一份**，导出对话框、刻度尺、
 * 播放头也都不减。所以只要项目里有转场，时间轴显示的总时长就是偏长的。
 *
 * 本模块**不去折叠时间轴坐标**，只把差值如实显示出来。
 *
 * 4.0 更新：导出侧的漂移已经修了（`normalize.ts` 的 cursor 现在按生效转场前移，
 * 音频 `adelay`、字幕 SRT、叠加层起点全部落在折叠后的成片坐标上）。**但时间轴
 * 本身仍然不折叠**，理由是折叠会让相邻两镜在时间轴上真的**重叠** `foldSec` 秒，
 * 而 `secToPosition` 那套「绝对秒 → 第几镜」的反查在重叠区里就成了多值的 ——
 * 播放头、吸附、框选、修剪全都建立在"镜头互不重叠"之上。这是一次独立的、
 * 会动到整个编辑面的改动，不是 4.0 的一部分。
 *
 * 不折叠不会造成错位：时间轴是成片**在每条接缝处插入了 foldSec 秒**的等价视图，
 * `foldTime` 是两者之间单调（接缝处除外）的映射，锚定关系逐条保持。
 * 用户看到的唯一差别就是总时长 —— 而那正是 `seamSummary` 里如实写着的
 * 「成片 −X.Xs」。
 *
 * 判定「哪条转场真的会折叠」的规则已下沉到 `lib/transitionFold.ts`，
 * 与 `normalize.ts` 共用一份；两边各自喂自己那条链（编辑态 / 导出态）。
 */

import type { ShotInfo, TransitionInfo } from "../../api";
import { buildOrderOffsetMap, shotDuration } from "../../adapters/shotToClip";
import { chainIndex, isAdjacent, foldingLinks } from "../../lib/transitionFold";

/** 转场最短时长（秒）。再短就看不出是转场，只是一次抖动。 */
export const MIN_TRANSITION_SEC = 0.1;
/** 转场最长时长（秒）。超过这个长度已经不是"转场"而是"叠化段落"了。 */
export const MAX_TRANSITION_SEC = 5;
/** 转场两侧各自必须保留的画面（秒）——全被吃掉的话这一镜等于没出现过。 */
export const MIN_KEEP_SEC = 0.1;

export type SeamState =
  /** 会正常生效 */
  | "ok"
  /** 端点镜头已被删除 */
  | "missing"
  /** 端点镜头已停用（导出时被剔除，转场随之丢弃） */
  | "disabled"
  /** 两镜之间还隔着别的镜头，不再相邻 */
  | "notAdjacent"
  /** 端点在叠加层上（转场只作用于主轨串接） */
  | "offMain"
  /** 时长超过两侧镜头能让出的余量 */
  | "tooLong";

export interface SeamMarker {
  /** 转场 id（后端主键，patch / delete 都用它） */
  id: string;
  type: string;
  durationSec: number;
  /** 接缝在时间轴上的绝对秒；两端镜头都没了就定位不到，为 null */
  atSec: number | null;
  fromShotId: string;
  toShotId: string;
  /** 端点镜头的 order；找不到为 null（只用于给用户报位置，别拿去算时间） */
  fromOrder: number | null;
  toOrder: number | null;
  state: SeamState;
  /** 这条转场实际会让成片缩短多少秒（不生效的为 0） */
  foldSec: number;
  /** 这条接缝最多能放多长的转场；0 = 放不下（相邻镜头太短） */
  maxSec: number;
}

/**
 * 这条接缝最多能放多长的转场。
 *
 * `xfade` 吃掉的是**两段的重叠部分**：前一镜的尾巴和后一镜的开头各被吃掉
 * `duration` 秒。所以上限由**短的那一镜**决定，且两侧都要留下 `MIN_KEEP_SEC`
 * 的纯画面，否则短的那一镜从头到尾都在过渡中，等于没出现过。
 *
 * 返回 0 表示这条缝放不下任何转场（相邻镜头短于 0.2s，多半是脏数据）。
 */
export function maxTransitionSec(fromDur: number, toDur: number): number {
  const room = Math.min(fromDur, toDur) - MIN_KEEP_SEC;
  if (!(room > 0)) return 0;
  const capped = Math.min(MAX_TRANSITION_SEC, room);
  // 落到 0.1s 格上：UI 的输入框、后端存的值、这里的上限必须同格，
  // 否则会出现"填了上限值却仍被判 tooLong"
  const q = Math.floor(capped * 10 + 1e-6) / 10;
  return q >= MIN_TRANSITION_SEC ? q : 0;
}

/** 把用户输入的时长夹到这条缝允许的范围内 */
export function clampTransitionSec(sec: number, fromDur: number, toDur: number): number {
  return clampToSeam(sec, maxTransitionSec(fromDur, toDur));
}

/**
 * 同上，但直接给上限——`SeamMarker.maxSec` 已经算好了，UI 不该再拿镜头时长
 * 推一遍（推的那一遍迟早和标记上写的那个上限对不上，用户会看到"填了显示的
 * 上限值却被弹回去"）。`clampTransitionSec` 也走这里，全项目只有一份夹持。
 */
export function clampToSeam(sec: number, maxSec: number): number {
  if (maxSec <= 0) return 0;
  if (!Number.isFinite(sec)) return Math.min(maxSec, 0.5);
  return Math.min(maxSec, Math.max(MIN_TRANSITION_SEC, Math.round(sec * 10) / 10));
}

/**
 * 转场 → 时间轴上的接缝标记。
 *
 * ⚠️ 位置**必须**取自 `buildOrderOffsetMap`，不许在这里再写一遍顺序累加。
 * 理由见 `shotToClip.ts` 末尾 `secToPosition` 的长注释：这条时间轴上曾同时
 * 存在三套累加算法，"线画在一处、跳到的是另一处"。接缝是第五个需要绝对秒的
 * 地方，自己再累加一遍就是第四套。
 */
export function buildSeamMarkers(
  shots: ShotInfo[], transitions: TransitionInfo[],
): SeamMarker[] {
  const offsetMap = buildOrderOffsetMap(shots);
  const byId = new Map(shots.map((s) => [s.id, s]));

  // 主轨、未停用、按 order —— 与 `App.doApplyTransition` 挑「下一镜」
  // 以及编译器串接主轨的口径完全一致。三处口径必须同源，否则"加的时候说
  // 加在 #3→#4，导出时却不是这两镜"。
  const chain = shots
    .filter((s) => (s.track_index ?? 0) === 0 && !s.disabled)
    .sort((a, b) => a.order - b.order);
  const chainIds = chain.map((s) => s.id);
  const posInChain = chainIndex(chainIds);

  // 「哪条转场真的会折叠」的判据与 `normalize.ts` 同源（lib/transitionFold.ts），
  // 不在这里再写一遍——两处各写一份必然漂移，而漂移的表现是"标签上写着成片会短
  // 2.5s、实际短了 2.0s"这种没人查得出的偏差。
  //
  // ⚠️ 这里喂的是**编辑态**的链（主轨 + 未停用），`normalize` 喂的是**导出态**的链
  // （再加 scope 过滤 + 必须真有 video_url）。两者本该不同：默认档不导未出片的镜头，
  // 于是编辑器上还隔着一镜的两个镜头，在成片里可能恰好相邻。也因此本标签是
  // **按"全导出"预测**的，不随导出对话框的档位变化。
  const foldingIds = new Set(
    foldingLinks(chainIds, transitions.map((t) => ({
      id: t.id, fromId: t.from_shot_id, toId: t.to_shot_id,
      durationSec: t.duration, type: t.type,
    }))).map((l) => l.id));

  const out: SeamMarker[] = [];
  for (const t of transitions) {
    const a = byId.get(t.from_shot_id);
    const b = byId.get(t.to_shot_id);

    // 定位：优先取「后一镜的起点」（那才是接缝）；后一镜没了就退到前一镜的结尾。
    // 停用镜头在 offsetMap 里**占位但不推进时间**，所以即使端点被停用也定位得到，
    // 用户仍能看见并删掉这条已经失效的转场。
    let atSec: number | null = null;
    if (b && offsetMap.has(b.order)) atSec = offsetMap.get(b.order)!;
    else if (a && offsetMap.has(a.order)) atSec = offsetMap.get(a.order)! + shotDuration(a);

    const fromDur = a ? shotDuration(a) : 0;
    const toDur = b ? shotDuration(b) : 0;
    const maxSec = a && b ? maxTransitionSec(fromDur, toDur) : 0;

    let state: SeamState;
    if (!a || !b) state = "missing";
    else if (a.disabled || b.disabled) state = "disabled";
    else if ((a.track_index ?? 0) > 0 || (b.track_index ?? 0) > 0) state = "offMain";
    else {
      // 相邻即可，不要求方向：编译器两个方向都认（`ffmpegCompiler.ts:550-552`）
      if (!isAdjacent(posInChain, a.id, b.id)) {
        state = "notAdjacent";
      } else if (t.duration > maxSec) {
        state = "tooLong";
      } else {
        state = "ok";
      }
    }

    // tooLong 也是**会执行**的：编译器照样跑 xfade，只是把 offset 夹到 0
    // （`ffmpegCompiler.ts:556`），画面糊成一团但时长照样折叠。所以它计入 foldSec。
    // 判据来自 `foldingLinks`：它还额外去掉了"同一条缝上的第二条转场"
    // （编译器用 `.find`，一条缝只跑一条；重复计入会让折叠比画面多扣一份）。
    const effective = foldingIds.has(t.id);

    out.push({
      id: t.id,
      type: t.type,
      durationSec: t.duration,
      atSec,
      fromShotId: t.from_shot_id,
      toShotId: t.to_shot_id,
      fromOrder: a?.order ?? null,
      toOrder: b?.order ?? null,
      state,
      foldSec: effective ? t.duration : 0,
      maxSec,
    });
  }

  // 定位不到的排最后，其余按时间序（画出来的顺序 = 用户看到的顺序）
  return out.sort((x, y) => (x.atSec ?? Infinity) - (y.atSec ?? Infinity));
}

/**
 * 成片实际时长 = 时间轴总时长 − 所有生效转场吃掉的重叠。
 *
 * 这不是估算，是 `ffmpegCompiler.ts:558` 那行折叠公式的直接对应。
 */
export function foldedTotalSec(totalSec: number, markers: SeamMarker[]): number {
  const fold = markers.reduce((acc, m) => acc + m.foldSec, 0);
  return Math.max(0, totalSec - fold);
}

/** 给用户看的状态说明（一句话说清"为什么它不生效"，别只给个红点） */
export function seamHint(m: SeamMarker): string {
  const at = m.fromOrder !== null && m.toOrder !== null
    ? `#${m.fromOrder} → #${m.toOrder}`
    : "接缝";
  switch (m.state) {
    case "ok":
      return `${at}「${m.type}」${m.durationSec.toFixed(1)}s`
        + `（成片会缩短 ${m.durationSec.toFixed(1)}s）`;
    case "missing":
      return `${at}「${m.type}」端点镜头已被删除，导出时会被丢弃`;
    case "disabled":
      return `${at}「${m.type}」有一端镜头已停用，导出时会被丢弃`;
    case "notAdjacent":
      return `${at}「${m.type}」两镜之间已经隔着别的镜头，不再相邻，导出时会直接切过去`;
    case "offMain":
      return `${at}「${m.type}」端点在叠加层上，转场只作用于主轨，不会生效`;
    case "tooLong":
      return `${at}「${m.type}」${m.durationSec.toFixed(1)}s 超过相邻镜头能让出的 `
        + `${m.maxSec.toFixed(1)}s，画面会糊成一团，请改短`;
  }
}

/** 工具条那个汇总小标签的文案（没有转场时返回 null，不占地方） */
export function seamSummary(markers: SeamMarker[]): { text: string; title: string } | null {
  if (!markers.length) return null;
  const bad = markers.filter((m) => m.state !== "ok");
  const fold = markers.reduce((acc, m) => acc + m.foldSec, 0);
  const text = `${markers.length} 转场`
    + (fold > 0 ? ` · 成片 −${fold.toFixed(1)}s` : "")
    + (bad.length ? ` · ${bad.length} 无效` : "");
  const title = [
    "转场用 xfade 重叠两镜，每条生效的转场都让成片比时间轴短一个转场时长。",
    ...markers.map(seamHint),
  ].join("\n");
  return { text, title };
}
