/**
 * features/subtitles/sources.ts — 挑出"能拿来生成字幕"的旁白
 *
 * 单独成文件而不是留在 generate.ts 里：generate.ts 要 `import { api }`，
 * 而 api.ts 在模块顶层读 `import.meta.env`，Node 侧的验收脚本一 import 就炸。
 * 纯筛选逻辑放这里，I/O 编排留在 generate.ts —— 同 markup.ts 的分法。
 *
 * （`AudioClipInfo` 是 type-only 导入，编译期就被擦掉，不构成运行时依赖。）
 */

import type { AudioClipInfo } from "../../api";

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
