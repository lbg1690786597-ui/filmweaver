/**
 * features/subtitles/align.ts — 本地强制对齐（forced alignment）
 *
 * ## 为什么不是 ASR
 *
 * 解说剧的旁白是**我们自己合成的**：`AudioClip.text` 就是逐字送进 TTS 的
 * 那段文本，`AudioClip.duration` 是精确总时长。文本已知的情况下用 ASR 去
 * "猜"文本，是把已知信息扔掉再花钱买回来一个更差的版本——whisper 会把
 * 人名听错、把数字听成别的数字，而原文一个字都不会错。
 *
 * 已知文本时的正确技术是 forced alignment。我们不需要模型：
 * ffmpeg 的 `silencedetect` 就能给出**真实的停顿位置**。
 *
 * 实测（tts_2a2ea04085fe.flac，205 字 / 34.66s，noise=-32dB:d=0.18）：
 * 得到 21 段静音，几乎覆盖每一处句读，最短 0.19s、最长 0.62s。
 *
 * ## 为什么必须拆条
 *
 * 拆镜改成跟随 plus(48G) 显存包线后，480p 单镜可到 45.5s，
 * 库里已出现 205 字 / 34.66 秒的**单段**旁白。一条 205 字的字幕在竖屏上
 * 完全没法看——不拆条，字幕功能等于没做。
 *
 * ## 精度依据
 *
 * 21 条已合成旁白的"字数/时长"标准差只有 0.303（均值 6.02 字/秒），
 * 所以在没有静音可吸附的地方，按字符数线性插值的误差 < 5%。
 * 静音点用来消掉累积误差，插值用来填静音点之间的空隙。
 */

/** 一条字幕的时间与文本（音频内相对秒） */
export interface Cue {
  text: string;
  /** 相对该段音频起点的秒数 */
  start: number;
  end: number;
}

export interface SplitOptions {
  /** 单条最大字数。竖屏 1080 宽、48px 粗体一行约 15 字 */
  maxChars?: number;
  /** 单条最短显示时长（秒）。太短会闪，读不完 */
  minSec?: number;
  /** 单条最长显示时长（秒）。太长说明该再切一刀 */
  maxSec?: number;
}

export const DEFAULT_SPLIT: Required<SplitOptions> = {
  maxChars: 15, minSec: 0.8, maxSec: 5,
};

/** 句末标点：优先在这里断，断出来的是完整句子 */
const HARD_STOPS = "。！？!?…";
/** 句中标点：句子超长时的次选断点 */
const SOFT_STOPS = "，、；：,;:";

/**
 * 把一段文本拆成字幕条。
 *
 * 优先级：句末标点 → 句中标点 → 硬断。标点**留在前一条**（中文字幕的惯例，
 * 也让下一条不会以逗号开头）。
 *
 * 注意这里不做时长判断——时长要等对齐完才知道。`maxSec` 的约束由
 * `alignCues` 在拿到真实时间后回头补切。
 */
export function splitIntoCues(text: string, opts: SplitOptions = {}): string[] {
  const { maxChars } = { ...DEFAULT_SPLIT, ...opts };
  const src = (text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];

  // 1) 先按句末标点切成句子
  const sentences: string[] = [];
  let buf = "";
  for (const ch of src) {
    buf += ch;
    if (HARD_STOPS.includes(ch)) { sentences.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) sentences.push(buf.trim());

  // 2) 过长的句子在句中标点处再切；仍过长才硬断
  const out: string[] = [];
  for (const sent of sentences) {
    if (sent.length <= maxChars) { out.push(sent); continue; }

    const pieces: string[] = [];
    let p = "";
    for (const ch of sent) {
      p += ch;
      if (SOFT_STOPS.includes(ch) && p.length >= Math.ceil(maxChars / 2)) {
        pieces.push(p); p = "";
      }
    }
    if (p) pieces.push(p);

    for (const piece of pieces) {
      if (piece.length <= maxChars) { out.push(piece); continue; }
      // 硬断：均分成 n 段，避免"14 字 + 1 字"这种尾巴
      const n = Math.ceil(piece.length / maxChars);
      const size = Math.ceil(piece.length / n);
      for (let i = 0; i < piece.length; i += size) out.push(piece.slice(i, i + size));
    }
  }
  return out.filter((s) => s.length > 0);
}

export interface Silence { start: number; end: number }

/**
 * 解析 `-af silencedetect` 打在 stderr 上的结果。
 *
 * ffmpeg 的输出形如：
 *     [silencedetect @ 0x..] silence_start: 1.33143
 *     [silencedetect @ 0x..] silence_end: 1.57565 | silence_duration: 0.244218
 *
 * 末尾可能只有 silence_start 没有对应的 end（音频以静音收尾时 ffmpeg 不打
 * end）。那种半开区间直接丢弃——它落在音频末尾，对断句没有价值，
 * 而当成 [start, start] 会造出一个零宽吸附点把最后一条字幕拽歪。
 */
export function parseSilence(stderr: string): Silence[] {
  const out: Silence[] = [];
  let pending: number | null = null;
  for (const line of (stderr || "").split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { pending = parseFloat(s[1]); continue; }
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && pending !== null) {
      const end = parseFloat(e[1]);
      if (Number.isFinite(pending) && Number.isFinite(end) && end > pending) {
        out.push({ start: pending, end });
      }
      pending = null;
    }
  }
  return out;
}

/**
 * 把拆好的字幕条对齐到时间轴。
 *
 * @param cues     `splitIntoCues` 的产物，按顺序
 * @param silences `parseSilence` 的产物；空数组 = 退化为纯字符比例分配
 * @param totalSec 该段音频的**精确**总时长（来自 AudioClip.duration）
 *
 * 算法：
 * 1. 按字符数算出每个边界的"理想比例位置" → 理想秒数
 * 2. 每个边界去找最近的静音**中点**吸附，条件：
 *    - 距离在容差内（`tol`，默认 0.6s——实测停顿本身就有 0.19~0.62s 宽）
 *    - 吸附后仍严格递增（不能把边界拽到前一个边界之前）
 *    - 一个静音点只能被一个边界用（否则两条字幕会挤到同一时刻）
 * 3. 吸不上的保留理想秒数
 *
 * 首条起点取第一个非静音位置（TTS 产物开头常有 0.1~0.2s 静音，
 * 字幕跟着提前 0.2s 出现会很明显）；末条终点固定 `totalSec`。
 */
export function alignCues(
  cues: string[], silences: Silence[], totalSec: number,
  opts: SplitOptions & { tol?: number } = {},
): Cue[] {
  const { maxSec } = { ...DEFAULT_SPLIT, ...opts };
  const tol = opts.tol ?? 0.6;
  if (!cues.length || !(totalSec > 0)) return [];

  const total = cues.reduce((a, c) => a + c.length, 0) || 1;

  // 首条起点：开头那段静音结束处（若确实以静音开头）
  const head = silences.length && silences[0].start <= 0.02
    ? Math.min(silences[0].end, totalSec * 0.1)
    : 0;

  // 理想边界（含首尾）：cues.length + 1 个点
  const ideal: number[] = [head];
  let acc = 0;
  for (const c of cues) {
    acc += c.length;
    ideal.push(head + (acc / total) * (totalSec - head));
  }
  ideal[ideal.length - 1] = totalSec;

  // 静音中点作为候选吸附点（跳过开头/结尾那两段，它们不是句读）
  const anchors = silences
    .map((s) => (s.start + s.end) / 2)
    .filter((m) => m > head + 0.05 && m < totalSec - 0.05);
  const used = new Set<number>();

  // 只吸附**内部**边界；首尾是硬锚，不动
  const bounds = ideal.slice();
  for (let i = 1; i < bounds.length - 1; i++) {
    let best = -1, bestD = Infinity;
    for (let k = 0; k < anchors.length; k++) {
      if (used.has(k)) continue;
      const d = Math.abs(anchors[k] - ideal[i]);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0 || bestD > tol) continue;
    const cand = anchors[best];
    // 单调性：必须严格晚于前一个边界、早于后一个理想边界
    if (cand <= bounds[i - 1] + 0.05 || cand >= ideal[i + 1] - 0.05) continue;
    bounds[i] = cand;
    used.add(best);
  }

  // 兜底：吸附后仍可能出现非递增（浮点/极短 cue），强制拉开
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] <= bounds[i - 1]) bounds[i] = bounds[i - 1] + 0.05;
  }
  if (bounds[bounds.length - 1] > totalSec) {
    // 被强制拉开顶出了总时长：整体压回去，宁可略挤也不能超出音频
    const scale = (totalSec - head) / (bounds[bounds.length - 1] - head);
    for (let i = 1; i < bounds.length; i++) {
      bounds[i] = head + (bounds[i] - head) * scale;
    }
  }

  const out: Cue[] = [];
  for (let i = 0; i < cues.length; i++) {
    // maxSec 只做上限钳制，不再回头切分：切了就得重排整条时间轴，
    // 而真正该防的是"一条字幕挂 20 秒不动"这种观感问题。
    const start = bounds[i];
    const end = Math.min(bounds[i + 1], start + maxSec);
    out.push({ text: cues[i], start, end });
  }
  return out;
}

/** 一步到位：文本 + 静音区间 + 总时长 → 字幕条 */
export function alignText(
  text: string, silences: Silence[], totalSec: number,
  opts: SplitOptions & { tol?: number } = {},
): Cue[] {
  return alignCues(splitIntoCues(text, opts), silences, totalSec, opts);
}
