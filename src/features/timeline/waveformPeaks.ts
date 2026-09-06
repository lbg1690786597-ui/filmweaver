/**
 * waveformPeaks.ts — 波形的纯逻辑（3.9）
 *
 * 抽出来的理由与 `selection.ts` / `transitions.ts` 同：这些判据要能在 node 下
 * 直接跑断言，而 `Waveform.tsx` 里到处是 canvas / Web Audio / DOM。
 *
 * ## ⚠️ 为什么不叫 `waveform.ts`（别改回去）
 *
 * 3.9 落地时它就叫 `waveform.ts`，与同目录的组件 `Waveform.tsx`
 * **只差大小写**。Linux 上两者是两个文件，`tsc` 全绿；**Windows 的文件系统
 * 大小写不敏感**，于是 `import … from "./waveform"` 在 CI 上解析到
 * `Waveform.tsx` 自己：
 *
 *     src/features/timeline/ClipView.tsx: error TS1192:
 *       Module '…/Waveform' has no default export.
 *     error TS1261: Already included file name '…/Waveform.ts' differs from
 *       file name '…/waveform.ts' only in casing.
 *
 * 这是**只在 Windows 上出现的构建阻断**（v0.8.5 首次发版即栽在这里，
 * 两条 tag 的 CI 都停在类型检查）。本机 `npm run typecheck` 永远测不到它，
 * 所以改了名之外还加了 `scripts/verify-case-collision.ts` 钉住这一类：
 * 同目录下不允许出现"basename 只差大小写"的模块。
 *
 * ## 3.9 要解决的三件事
 *
 * **① 解码把整段音频摊平进内存。** `decodeAudioData` 产出的是未压缩 Float32：
 * 10 分钟立体声 48kHz = 600 × 48000 × 4 × 2 ≈ **230 MB**，而我们最终只要
 * 几千个峰值（几十 KB）。更要命的是**没有任何东西限制同时解几段** —— 时间轴
 * 上有多少条音频 clip 就并发发多少次解码（本项目的验证素材是 601 段），
 * 峰值内存是 230 MB × N。
 *
 * ⚠️ **说清楚本条**没有**做什么**：这不是「分块解码」。`decodeAudioData` 要求
 * 一个**完整的容器**，你不能把 m4a/aac 的任意字节区间喂给它（mp3 恰好是帧式的、
 * 勉强可切，但那就成了按格式分叉的自制解复用器）。真正的流式路线只有两条，
 * 都不划算：`MediaElementAudioSourceNode` 是**实时**的（扫 10 分钟音频要 10 分钟），
 * WebCodecs `AudioDecoder` 要自己写 MP4/mp3 demuxer。
 * 本条走的是**降采样解码 + 限并发 + 只解可见的**，把峰值内存从
 * 「230 MB × N」压到「38 MB × 2」，并且大多数情况下 N 直接是 0：
 *
 *   · 解码上下文用 8kHz（`DECODE_SAMPLE_RATE`）→ 同一段音频省 6 倍内存。
 *     波形只看包络，8kHz 的包络与 48kHz 的**肉眼无差**（峰值本来就要按
 *     几百上千个采样点取 max）。
 *   · 同时最多 2 段在解（`DECODE_CONCURRENCY`），其余排队。
 *   · **划到屏幕上才开始解**（`Waveform.tsx` 的 IntersectionObserver）——
 *     时间轴目前不做虚拟化（那是 3.10），601 段 clip 是**全部**挂进 DOM 的，
 *     不加这一层就是开着项目自动把整部剧的音频拖一遍。
 *
 * **② canvas 会因为太宽而整块消失。** 背板宽度 = `clip 时长 × pxPerSec × dpr`，
 * 10 分钟音频在 `ZOOM_MAX=60` 下是 600 × 60 × 2 = **72000 px**，超过浏览器的
 * 单边上限（65535），分配失败后 canvas **不报错、直接变空白** —— 用户看到的是
 * 「一放大波形就没了」。`canvasBacking` 给背板宽度封顶，超了就让 CSS 横向拉伸。
 *
 * 上限取 `PEAK_BUCKETS_MAX`（8192）不是拍脑袋：**背板再宽也画不出比峰值桶
 * 更多的信息**，两者取同一个数，意味着背板永远够表达我们手上的每一个桶，
 * 一个像素都不浪费、也一个桶都不丢。
 *
 * **③ 峰值缓存无上限、且失败不缓存。** 旧实现 `PEAK_CACHE` 只增不减；失败时
 * 返回 null 又**什么都不记**，于是一段解不了的音频每次重挂都会重新 fetch +
 * 重新解一遍，永远失败、永远重试。现在正负都进同一个 LRU。
 */

/** 峰值桶密度：每秒多少个桶。50ms 一个桶，在 `ZOOM_MAX=60px/s` 下约 3px 一桶。 */
export const PEAK_BUCKETS_PER_SEC = 20;
/** 桶数下限。极短的音效也别只有几个桶，否则一格一个方块。 */
export const PEAK_BUCKETS_MIN = 256;
/** 桶数上限。8192 × 4B = 32 KB，长 BGM 也就这个量级。 */
export const PEAK_BUCKETS_MAX = 8192;

/** 解码用的采样率。波形只看包络，8kHz 与 48kHz 肉眼无差，内存省 6 倍。 */
export const DECODE_SAMPLE_RATE = 8000;

/** 同时在解的音频段数。
 *  ⚠️ 这**不是**生成/任务并发（那些一律由用户掌控、严禁擅自改），
 *  而是浏览器端音频解码这一个新增动作的内存闸门：解码峰值是每段几十 MB，
 *  不设闸门时 601 段会一起摊平进内存。 */
export const DECODE_CONCURRENCY = 2;

/** 峰值缓存条目上限（LRU）。最坏 240 × 32 KB ≈ 7.7 MB，典型旁白 3s 只有 1 KB。 */
export const PEAK_CACHE_MAX = 240;

/** canvas 背板单边上限。见文件头 ②：与 `PEAK_BUCKETS_MAX` 同值是有意的。 */
export const MAX_CANVAS_PX = PEAK_BUCKETS_MAX;

/**
 * 这段音频该切多少个峰值桶。
 *
 * 按**时长**定而不是定死一个数：定死 1000 的话，3 秒旁白被过采样（没坏处但浪费），
 * 10 分钟 BGM 只有 1000 个桶 = 0.6s 一桶，放到最大缩放是 36px 宽的平台，
 * 波形退化成一排色块。
 *
 * @param sampleCount 声道采样点数。桶数**不得超过它** —— 否则会有空桶，
 *   画出来是「左半边有波形、右半边一条直线」（旧实现在极短音频上就是这样：
 *   `per = max(1, floor(len/buckets))` 在 len < buckets 时恒为 1，
 *   只覆盖前 `buckets` 个点，后面全是 0）。
 */
export function bucketsFor(durSec: number, sampleCount: number): number {
  if (!(durSec > 0) || sampleCount <= 0) return 0;
  const want = Math.ceil(durSec * PEAK_BUCKETS_PER_SEC);
  const clamped = Math.min(PEAK_BUCKETS_MAX, Math.max(PEAK_BUCKETS_MIN, want));
  return Math.min(clamped, sampleCount);
}

/**
 * 把一个声道压成峰值包络（每桶取绝对值最大）。
 *
 * 边界用 `floor(i * len / buckets)` 而不是 `i * floor(len / buckets)`：
 * 后者在不整除时会把**尾巴整段丢掉**（len=1000999、buckets=1000 时最后 999 个
 * 采样点不参与），且误差随桶数增大而增大。
 */
export function computePeaks(ch: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(Math.max(0, buckets));
  if (buckets <= 0 || ch.length === 0) return out;
  for (let i = 0; i < buckets; i++) {
    const from = Math.floor((i * ch.length) / buckets);
    // 至少取一个点：buckets 已被 bucketsFor 夹到 ≤ len，这里只是防守
    const to = Math.max(from + 1, Math.floor(((i + 1) * ch.length) / buckets));
    let max = 0;
    for (let j = from; j < to && j < ch.length; j++) {
      const v = ch[j] < 0 ? -ch[j] : ch[j];
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

/** canvas 背板尺寸。`truncated` = 撞到上限了（调用方据此**不要**再 `scale(dpr,dpr)`）。 */
export interface Backing { bw: number; bh: number; truncated: boolean }

/**
 * 算 canvas 背板尺寸，并给宽度封顶。
 *
 * 撞顶时**不缩小 CSS 宽度**（那会让波形和 clip 对不上），而是让背板小于
 * `css × dpr`，由 CSS 把它横向拉伸。信息量没有损失：背板上限等于桶数上限。
 */
export function canvasBacking(cssW: number, cssH: number, dpr: number): Backing {
  const d = dpr > 0 ? dpr : 1;
  const w = Math.max(1, Math.floor(cssW));
  const h = Math.max(1, Math.floor(cssH));
  const want = Math.max(1, Math.round(w * d));
  const bw = Math.min(want, MAX_CANVAS_PX);
  return { bw, bh: Math.max(1, Math.round(h * d)), truncated: bw < want };
}

/** 第 x 个背板像素列对应的桶区间 `[i0, i1)`。左闭右开，且保证非空。 */
export function peakRange(peakCount: number, x: number, columns: number): [number, number] {
  if (peakCount <= 0 || columns <= 0) return [0, 0];
  const i0 = Math.min(peakCount - 1, Math.floor((x / columns) * peakCount));
  const i1 = Math.min(peakCount, Math.max(i0 + 1, Math.floor(((x + 1) / columns) * peakCount)));
  return [i0, i1];
}

/* ------------------------------------------------------------------ *
 * LRU：峰值缓存
 * ------------------------------------------------------------------ */

/**
 * 定容 LRU。`null` 是**合法值**，表示「这段解不出来」——
 * 负结果必须和正结果一样进缓存，否则解不了的音频每次重挂都重 fetch + 重解，
 * 永远失败、永远重试（旧实现就是这样）。
 */
export class PeakCache {
  private m = new Map<string, Float32Array | null>();
  constructor(private readonly max: number = PEAK_CACHE_MAX) {}

  has(k: string): boolean { return this.m.has(k); }
  get size(): number { return this.m.size; }

  /** 命中会把该键提到最新（Map 靠插入序，删了再插就是提最新）。 */
  get(k: string): Float32Array | null | undefined {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k)!;
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }

  set(k: string, v: Float32Array | null): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) {
      const oldest = this.m.keys().next();
      if (oldest.done) break;
      this.m.delete(oldest.value);
    }
  }

  /** 切/关项目时清空：峰值是按 url 缓的，跨项目没有复用价值，白占内存。 */
  clear(): void { this.m.clear(); }

  /** 仅供断言：按最旧→最新列出键 */
  keys(): string[] { return [...this.m.keys()]; }
}

/* ------------------------------------------------------------------ *
 * 解码闸门
 * ------------------------------------------------------------------ */

/**
 * 定容信号量。`acquire()` 拿到令牌后**必须**配对 `release()`（调用方放 finally）。
 *
 * 用它而不是「一次全发出去」：解码峰值内存是每段几十 MB，601 段一起解会直接
 * 把标签页撑爆；而且排在后面的多半已经滚出视野，早晚会被跳过。
 */
export class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number = DECODE_CONCURRENCY) {}

  get inFlight(): number { return this.active; }
  get queued(): number { return this.waiting.length; }

  acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return Promise.resolve(); }
    return new Promise<void>((res) => {
      this.waiting.push(() => { this.active++; res(); });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) next();
  }
}
