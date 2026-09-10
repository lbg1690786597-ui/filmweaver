/**
 * features/subtitles/generate.ts — 从已知文本生成字幕（主入口的编排层）
 *
 * 两条路径、同一种技术，全部在用户本机完成（除了最后的落库）：
 *
 *   解说剧：listAudioClips → probeSilence → alignText          → bulk
 *   真人剧：listSpokenLines → probeSilence(镜头视频) → alignLinesInSpeech → bulk
 *
 * 共同前提是**文本已知**：解说剧的旁白是我们自己合成的，`AudioClip.text`
 * 就是逐字送进 TTS 的文本；真人剧的台词写在 `script_ref` 里，那正是当初送给
 * 视频模型要它念的内容。文本已知时用 ASR 去猜文本，是把已知信息扔掉再花钱
 * 买一个更差的版本（whisper 会把人名听错，还会在静音镜头上凭空写出
 * 「请不吝点赞 订阅 转发」）。ASR 只在"用户没有文本"（真人录音 / 外部素材）
 * 时才有意义，保留为备选。
 *
 * 零网络（音频/视频首次会下载一次并缓存）、零模型、零费用。
 */

import { api } from "../../api";
import type { ShotInfo } from "../../api";
import { probeSilence } from "./probeSilence";
import {
  alignText, alignLinesInSpeech, clipSilences, type SplitOptions,
} from "./align";
import { stripScriptMarkup } from "./markup";
import { narrationClips, dramaSources } from "./sources";

// 剥离与筛选逻辑在 markup.ts / sources.ts —— 它们不能 import api.ts
// （顶层读 import.meta.env，Node 侧验收脚本一 import 就炸），
// 所以纯函数与 I/O 分了文件；这里转出，调用方的 import 路径不变。
export { stripScriptMarkup, narrationClips, dramaSources };

export interface GenerateResult {
  /** 落库成功的字幕条数 */
  created: number;
  /** 被替换掉的旧自动字幕条数 */
  deleted: number;
  /** 参与对齐的旁白段数 */
  sources: number;
  /** 其中**没能**拿到停顿、退化为纯字符比例分配的段数 */
  degraded: number;
}

export interface GenerateOptions extends SplitOptions {
  /** 进度回调：(已处理段数, 总段数, 当前在做什么)。
   *  ⚠️ `label` **不要带计数**——调用方（TextPanel）会自己拼上
   *  `（done/total）`，两边都写就成了「分析停顿 1/21（0/21）」。 */
  onProgress?: (done: number, total: number, label: string) => void;
  /** 传 false 可跳过停顿探测（非 Tauri 环境没有 sidecar ffmpeg） */
  probe?: boolean;
}

/**
 * 从项目的旁白音频生成整轨字幕。
 *
 * 时间基准：字幕锚点沿用 `(start_shot_order, start_offset_sec)`，
 * 与旁白同构——cue 的镜内偏移 = 旁白自身的偏移 + cue 在音频内的相对秒。
 * 不换算成绝对秒，镜头时长后面改了字幕也不会整体错位。
 *
 * 落库用 `replace_kind="subtitle"`：只清掉上一次自动生成的那一类，
 * 用户手打的 `normal` / `title` 不动。
 */
export async function generateFromNarration(
  projectId: string, opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const { onProgress, probe = true, ...split } = opts;

  const { clips } = await api.listAudioClips(projectId);
  const sources = narrationClips(clips);
  if (!sources.length) {
    throw new Error("还没有旁白——请先到「音频」面板合成解说旁白");
  }

  const payload: {
    project_id: string; text: string; kind: string;
    start_shot_order: number; start_offset_sec: number; duration: number;
  }[] = [];
  let degraded = 0;

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    onProgress?.(i, sources.length, "分析旁白");

    // 探测失败返回空数组（不抛错）：退化为纯字符比例分配，实测误差 < 5%，
    // 不该让整个"生成字幕"因为一段音频探不动就全军覆没。
    const silences = probe ? await probeSilence(src.url!, projectId) : [];
    if (!silences.length) degraded++;

    const text = stripScriptMarkup(src.text || "");
    if (!text) continue;

    for (const cue of alignText(text, silences, src.duration, split)) {
      const dur = cue.end - cue.start;
      if (dur <= 0) continue;                     // 兜底：不落零长字幕
      payload.push({
        project_id: projectId,
        text: cue.text,
        kind: "subtitle",
        start_shot_order: src.start_shot_order,
        start_offset_sec: src.start_offset_sec + cue.start,
        duration: Number(dur.toFixed(3)),
      });
    }
  }

  if (!payload.length) throw new Error("旁白里没有可用的文字，生成不了字幕");

  onProgress?.(sources.length, sources.length, "保存字幕");
  // 逐条 POST 不可接受：一段 205 字旁白约产 14 条 cue，21 段 ≈ 300 条。
  const r = await api.bulkSubtitleClips({
    project_id: projectId,
    replace_kind: "subtitle",
    clips: payload,
  });
  return { created: r.created, deleted: r.deleted, sources: sources.length, degraded };
}

/**
 * 从**剧本台词**生成整轨字幕（真人剧）。
 *
 * 与旁白那条同一种技术，只是三个输入换了来源：
 *
 * |        | 解说剧（`generateFromNarration`） | 真人剧（本函数） |
 * |---|---|---|
 * | 声轨   | 我们合成的旁白音频 | **镜头视频自带的声轨**（seedance 音画一体） |
 * | 文本   | `AudioClip.text`（TTS 的输入） | **`script_ref` 里的台词行**（模型被要求念的内容） |
 * | 时长   | `AudioClip.duration` | 镜头片窗口 `clip_dur_sec ?? duration_sec` |
 * | 锚点   | 旁白自身的 (镜序, 偏移) | (镜序, 0) + cue 在镜内的相对秒 |
 *
 * 关键点是**文本已知**：真人剧长期被当成"只能上 ASR"，理由是"台词在声轨里"。
 * 但台词同时也在剧本里——那就是当初送给视频模型的文本。已知文本时正确的
 * 技术是强制对齐，而不是花钱让 whisper 把它重新猜一遍
 * （还会把人名听错、把静音镜头猜成「请不吝点赞 订阅 转发」）。
 *
 * 与旁白路径的另一处实质差别：分配走**有声区间**（`alignCuesInSpeech`）。
 * 真人剧一镜是「动作 3 秒 → 台词 → 动作 2 秒」，线性摊到整镜会让字幕
 * 早出晚退好几秒，详见 `align.ts:speechRegions`。
 *
 * 同样零网络（视频首次会下载并缓存）、零模型、零费用。
 */
export async function generateFromScript(
  projectId: string, shots: ShotInfo[], opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const { onProgress, probe = true, ...split } = opts;

  const { shots: spoken } = await api.listSpokenLines(projectId);
  const byOrder = new Map(spoken.map((s) => [s.order, s.lines]));
  const sources = dramaSources(shots, byOrder);
  if (!sources.length) {
    // 三种成因分开说，否则用户只看到"没有可用镜头"无从下手
    const withVideo = shots.filter((s) => !!s.video_url && !s.disabled).length;
    throw new Error(
      !withVideo
        ? "还没有生成好的镜头视频——请先出片，字幕要对着声轨才能排"
        : !spoken.length
          ? "剧本里没有识别到台词（只有 ▲ 画面描述的镜头不需要字幕）"
          : "没有既出了片又有台词的镜头");
  }

  const payload: {
    project_id: string; text: string; kind: string;
    start_shot_order: number; start_offset_sec: number; duration: number;
  }[] = [];
  let degraded = 0;

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    onProgress?.(i, sources.length, "分析镜头原声");

    // 探的是**整个视频文件**，拿到的是文件时间；剪过的镜头要裁进片窗口
    // 并平移到窗口起点，否则字幕会拿片头的停顿去排片中那段（见 clipSilences）。
    //
    // `adaptive` 在这条路径上是**必需的**，不是调优：镜头视频带持续的音乐床
    // （实测平均 -14dB），固定 -32dB 阈值在 18 个真实镜头里有 14 个探不到
    // 任何停顿，于是每一镜都退化成线性摊开 —— 也就等于本次改动全部白做。
    const raw = probe ? await probeSilence(src.url, projectId, { adaptive: true }) : [];
    if (!raw.length) degraded++;
    const silences = clipSilences(raw, src.winStart, src.winDur);

    const lines = src.lines.map(stripScriptMarkup).filter((t) => !!t);
    if (!lines.length) continue;

    for (const cue of alignLinesInSpeech(lines, silences, src.winDur, split)) {
      const dur = cue.end - cue.start;
      if (dur <= 0) continue;
      payload.push({
        project_id: projectId,
        text: cue.text,
        kind: "subtitle",
        // 锚在本镜、偏移就是镜内相对秒。不换算绝对秒：镜头时长以后改了，
        // 字幕跟着这一镜走，不会整体错位（与旁白路径同构）。
        start_shot_order: src.order,
        start_offset_sec: Number(cue.start.toFixed(3)),
        duration: Number(dur.toFixed(3)),
      });
    }
  }

  if (!payload.length) throw new Error("台词里没有可用的文字，生成不了字幕");

  onProgress?.(sources.length, sources.length, "保存字幕");
  const r = await api.bulkSubtitleClips({
    project_id: projectId,
    replace_kind: "subtitle",
    clips: payload,
  });
  return { created: r.created, deleted: r.deleted, sources: sources.length, degraded };
}
