/**
 * features/subtitles/sources.ts — 挑出"能拿来生成字幕"的素材
 *
 * 两条来源、同一种技术（强制对齐，文本已知）：
 *   · 解说剧 → `narrationClips`：我们自己合成的旁白，文本 = TTS 输入。
 *   · 真人剧 → `dramaSources`：镜头视频自带的声轨，文本 = `script_ref` 里的台词。
 *
 * 单独成文件而不是留在 generate.ts 里：generate.ts 要 `import { api }`，
 * 而 api.ts 在模块顶层读 `import.meta.env`，Node 侧的验收脚本一 import 就炸。
 * 纯筛选逻辑放这里，I/O 编排留在 generate.ts —— 同 markup.ts 的分法。
 *
 * （`AudioClipInfo` 是 type-only 导入，编译期就被擦掉，不构成运行时依赖。）
 */

import type { AudioClipInfo } from "../../api";
import type { ShotInfo } from "../../api";

/**
 * 可用于生成字幕的旁白：已合成、有音频、有文本、有时长。
 *
 * `kind` 必须同时认 `narration` 和 `tts`：解说旁白落库写的是 `narration`
 * （routes_v2.py 那条路径），而只认 `tts` 正是自动字幕长期一条都出不来的原因。
 *
 * 排序按 (镜序, 镜内偏移) —— 字幕的时间基准就是这个锚点，
 * 顺序错了后面对齐出来的 cue 就会跨镜错位。
 */
export function narrationClips(clips: AudioClipInfo[]): AudioClipInfo[] {
  return clips
    .filter((c) => (c.kind === "narration" || c.kind === "tts")
                && c.status === "done" && !!c.url
                && !!(c.text && c.text.trim())
                && c.duration > 0)
    .sort((a, b) => a.start_shot_order - b.start_shot_order
                 || a.start_offset_sec - b.start_offset_sec);
}

/** 真人剧的一个对齐单位：一个镜头的视频 + 该镜要念的台词。 */
export interface DramaSource {
  order: number;
  /** 镜头视频 URL —— 台词长在它自带的声轨里（seedance 音画一体生成） */
  url: string;
  /** 该镜按顺序被念出来的台词（后端 `drama_timing.spoken_lines` 给出） */
  lines: string[];
  /** 片窗口在**文件时间**里的起点。没剪过是 0 */
  winStart: number;
  /** 片窗口长度 = 这一镜实际用到的秒数 */
  winDur: number;
}

/**
 * 挑出"能拿来本地对齐字幕"的镜头（真人剧）。
 *
 * 真人剧不存在旁白音频（`audio_clips` 恒为空），台词在镜头视频的声轨里，
 * 而**文本是已知的**——就是拆镜时写进 `script_ref` 的那些台词行，也正是
 * 视频模型被要求念的内容。所以这里同样是强制对齐，不需要 ASR。
 *
 * 排除项各有实际理由：
 * · `disabled` —— 停用镜头不进成片，给它排字幕会占掉时间轴位置。
 * · `track_index > 0`（叠加层）—— 字幕锚点是 `(order, 镜内偏移)`，而叠加层
 *   在时间轴上的位置由 `overlay_start_sec` 决定、**不参与主轨顺序累加**
 *   （见 `shotToClip.buildOrderOffsetMap`）。按 order 锚它必然错位。
 * · 没有 `video_url` —— 还没出片，没有声轨可探。
 * · 没有台词 —— 纯画面描述的镜头（`▲…`）本来就不该有字幕。
 *
 * 片窗口取 `clip_dur_sec ?? duration_sec`，与 `shotToClip.shotDuration`、
 * 导出侧 `render/normalize.ts` 同口径；口径不一致会让字幕与成片错位。
 */
export function dramaSources(
  shots: ShotInfo[], linesByOrder: Map<number, string[]>,
): DramaSource[] {
  const out: DramaSource[] = [];
  for (const s of shots) {
    if (s.disabled || (s.track_index ?? 0) > 0 || !s.video_url) continue;
    const lines = linesByOrder.get(s.order);
    if (!lines || !lines.length) continue;
    const winDur = (s.clip_dur_sec != null && s.clip_dur_sec > 0)
      ? s.clip_dur_sec
      : (s.duration_sec != null && s.duration_sec > 0 ? s.duration_sec : 0);
    if (!(winDur > 0)) continue;
    out.push({
      order: s.order,
      url: s.video_url,
      lines,
      winStart: s.clip_in_sec ?? 0,
      winDur,
    });
  }
  return out.sort((a, b) => a.order - b.order);
}
