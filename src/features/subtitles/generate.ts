/**
 * features/subtitles/generate.ts — 从旁白生成字幕（主入口的编排层）
 *
 * 串起四步，全部在用户本机完成（除了最后的落库）：
 *
 *   listAudioClips  →  probeSilence(ffmpeg silencedetect)  →  alignText  →  bulk 落库
 *
 * 这是**主路径**：解说剧的旁白是我们自己合成的，`AudioClip.text` 就是逐字
 * 送进 TTS 的文本，`AudioClip.duration` 是精确总时长。文本已知时用 ASR 去
 * 猜文本，是把已知信息扔掉再花钱买一个更差的版本。ASR 只在"用户没有文本"
 * （真人录音 / 外部素材）时才有意义，保留为备选。
 *
 * 零网络（音频首次会下载一次并缓存）、零模型、零费用。
 */

import { api } from "../../api";
import { probeSilence } from "./probeSilence";
import { alignText, type SplitOptions } from "./align";
import { stripScriptMarkup } from "./markup";
import { narrationClips } from "./sources";

// 剥离与筛选逻辑在 markup.ts / sources.ts —— 它们不能 import api.ts
// （顶层读 import.meta.env，Node 侧验收脚本一 import 就炸），
// 所以纯函数与 I/O 分了文件；这里转出，调用方的 import 路径不变。
export { stripScriptMarkup, narrationClips };

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
  /** 进度回调：(已处理段数, 总段数, 当前在做什么) */
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
    throw new Error("没有可用的旁白音频——请先在「音频」面板合成解说旁白");
  }

  const payload: {
    project_id: string; text: string; kind: string;
    start_shot_order: number; start_offset_sec: number; duration: number;
  }[] = [];
  let degraded = 0;

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    onProgress?.(i, sources.length, `分析停顿 ${i + 1}/${sources.length}`);

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

  if (!payload.length) throw new Error("旁白文本剥离符号后为空，没有可生成的字幕");

  onProgress?.(sources.length, sources.length, `写入 ${payload.length} 条字幕`);
  // 逐条 POST 不可接受：一段 205 字旁白约产 14 条 cue，21 段 ≈ 300 条。
  const r = await api.bulkSubtitleClips({
    project_id: projectId,
    replace_kind: "subtitle",
    clips: payload,
  });
  return { created: r.created, deleted: r.deleted, sources: sources.length, degraded };
}
