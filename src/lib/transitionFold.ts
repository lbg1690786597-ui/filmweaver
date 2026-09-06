/**
 * lib/transitionFold.ts — 「转场把成片折叠了多少」的唯一事实来源（4.0）
 *
 * ## 4.0 之前：画面折叠、声音和字幕不折叠
 *
 * `xfade` 是**重叠**两段，不是插入一段。`ffmpegCompiler.ts` 那行
 *
 *     baseDur = baseDur - tr.durationSec + cur.c.durationSec
 *
 * 说得很清楚：每条生效的转场都让画面**缩短一个转场时长**。
 * 而 `normalize.ts` 的 cursor 在累加各 clip 起点时**从不减这一份**，
 * 音频轨的 `adelay`（`compileAudioMix`）与字幕的 SRT 时间码（`planToSrt`）
 * 又全都锚在这个 cursor 上。于是成片里每多一条生效转场，后面所有旁白与字幕
 * 就相对画面**再晚一个转场时长**：5 条 0.5s 的转场 = 尾部错位 2.5s。
 *
 * 这不是显示问题，是**成片本身**的音画不同步；而且完全静默 ——
 * 不报错、不掉帧，只是嘴型对不上，用户多半会去怪配音而不是怪导出。
 *
 * ## 「生效」只能有一份判据
 *
 * 转场挂在两个元素 id 上，能否生效取决于导出时这两个元素在**实际串接的那条链**
 * 上是否相邻。3.6 的 `buildSeamMarkers` 已经有一套判据，4.0 的 `normalize`
 * 需要同一套。两处各写一遍必然漂移，而漂移的表现是「时间轴上写着成片会短
 * 2.5s、实际短了 2.0s」这种没人查得出的偏差。所以判据下沉到这里，
 * 调用方只负责**喂各自那条链**：
 *
 *   · `buildSeamMarkers` 喂**编辑态**的链（主轨 + 未停用）
 *   · `normalize`        喂**导出态**的链（再加 scope 过滤，且必须真有 video_url）
 *
 * 两条链本来就该不同 —— 默认档不导未出片的镜头，那些镜头在成片里压根不存在，
 * 跨过它们的两镜在导出时才是相邻的。**同源的是规则，不是输入。**
 *
 * ## 折叠与否还取决于本机 ffmpeg
 *
 * 编译器只在 `hasFilter(caps,"xfade") && hasTransition(caps, type)` 时才走 xfade，
 * 否则降级为硬切、**不折叠**。所以判据必须能带上这个条件，否则在缺 `zoomin`
 * 的老 ffmpeg 上会反过来错位（锚点早了一个转场时长）。
 * `foldingLinks` 因此接受一个可选的 `folds` 谓词，由调用方注入 caps。
 */

/** 链上的一条连接（转场）。用元素 id 表述，不关心它是 shot 还是 clip。 */
export interface ChainLink {
  /** 转场自身的 id（调用方用来回填结果） */
  id: string;
  fromId: string;
  toId: string;
  /** 转场时长（秒）——生效时它就是折叠量 */
  durationSec: number;
  /** 转场类型（用于 caps 判断；不需要判断时可省） */
  type?: string;
}

export interface FoldingLink extends ChainLink {
  /** 折叠发生在链上第几个元素**之前**（= 两端里靠后的那个的下标，恒 ≥ 1） */
  atIndex: number;
}

/** 接缝：一条生效转场在**未折叠**时间轴上的位置与它吃掉的重叠。 */
export interface Seam {
  /** 未折叠时间轴上的绝对秒 */
  atSec: number;
  foldSec: number;
}

/** 链上 id → 下标。重复 id 属脏数据，后者覆盖前者（与 Map 构造语义一致）。 */
export function chainIndex(chainIds: readonly string[]): Map<string, number> {
  return new Map(chainIds.map((id, i) => [id, i]));
}

/**
 * 两个元素在链上是否相邻。
 *
 * **不要求方向**：编译器在相邻两 clip 之间是双向查找转场的
 * （`ffmpegCompiler.ts` 的 `seg.transitions.find(...)` 两个方向都认），
 * 所以 b→a 与 a→b 同样有效。判成不相邻会把好转场标黄，是虚警。
 */
export function isAdjacent(
  pos: ReadonlyMap<string, number>, aId: string, bId: string,
): boolean {
  const ia = pos.get(aId);
  const ib = pos.get(bId);
  return ia !== undefined && ib !== undefined && Math.abs(ia - ib) === 1;
}

/**
 * 挑出**真的会折叠**的转场，按链上位置排序。
 *
 * @param chainIds 导出时实际串接的那条链，按播放顺序
 * @param links    候选转场
 * @param folds    可选：该转场在本机是否真会被执行（注入 caps）。
 *                 缺省一律视作会执行 —— 编辑态的 UI 拿不到 caps，只能这么预测。
 */
export function foldingLinks(
  chainIds: readonly string[],
  links: readonly ChainLink[],
  folds?: (link: ChainLink) => boolean,
): FoldingLink[] {
  const pos = chainIndex(chainIds);
  const out: FoldingLink[] = [];
  // 一条缝上只会跑一条转场：编译器用的是 `.find`，取相邻两 clip 之间**第一条**
  // 匹配的。后端对同一条缝是 upsert，正常不会有第二条；但脏数据若在这里被重复
  // 计入，折叠就会比画面多扣一份 —— 又是那种"差一点点、查不出来"的错位。
  // 故显式去重，且**先到先得**，与编译器的 `.find` 同序。
  const taken = new Set<number>();
  for (const l of links) {
    if (!isAdjacent(pos, l.fromId, l.toId)) continue;
    if (folds && !folds(l)) continue;
    const atIndex = Math.max(pos.get(l.fromId)!, pos.get(l.toId)!);
    if (taken.has(atIndex)) continue;
    taken.add(atIndex);
    out.push({ ...l, atIndex });
  }
  return out.sort((a, b) => a.atIndex - b.atIndex);
}

/**
 * 未折叠的时间轴秒 → 成片秒。
 *
 * 只有**不锚定在镜头上**的东西需要它（当前就是叠加层的 `overlay_start_sec`）。
 * 锚定在镜头 order 上的音频/字幕直接读 `normalize` 走链时算好的折叠后起点，
 * 不走这条路 —— 那条路更准，也不受下面这个多值问题影响。
 *
 * ⚠️ **本函数在接缝处是不连续、且故意不单调的**。接缝 s 折叠 f 秒，意味着
 * 前一镜的 `[s-f, s]` 与后一镜的 `[s, s+f]` 在成片里是**同一段**（叠化中）。
 * 也就是说那一段时间轴秒天然对应两个成片秒，谁都不算错：
 *
 *     t = s-0.1（前一镜的尾）→ 成片 s-0.1-Σ前面的折叠     ← 前一镜的口径
 *     t = s              → 成片 s-Σ含本条的折叠          ← 后一镜的口径
 *
 * 本函数取「≤ t 的接缝全部扣掉」，即接缝之后一律按**后一镜**的口径算。
 * 硬把它掰单调（取 running max）只会让落在叠化区里的叠加层往后挪，
 * 反而偏离用户对齐的那一镜。所以这里不掰，只兜住负数。
 */
export function foldTime(tSec: number, seams: readonly Seam[]): number {
  let out = tSec;
  for (const s of seams) if (s.atSec <= tSec) out -= s.foldSec;
  return out > 0 ? out : 0;
}
