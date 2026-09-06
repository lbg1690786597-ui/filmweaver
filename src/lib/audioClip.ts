/**
 * lib/audioClip.ts — 「一个音频段在时间轴上占多久」的唯一换算（6.9）
 *
 * ## 为什么这么小的一个函数要单独一个文件
 *
 * 因为它有**两个调用方，分属两层**：时间轴（`adapters/shotToClip.ts`）画格子要用它，
 * 导出（`render/normalize.ts`）排时间线也要用它。放进任何一边，另一边就得反向
 * import（`render/` 去 import `adapters/`，或反过来），而这条边一旦开了，
 * 后面的人会顺着它把更多东西搬过去。
 *
 * 更实际的理由是：**这两处各算一遍是本条目最可能出的错**。
 * 两边都写 `a.clip_dur_sec ?? a.duration` 看起来一样，但只要有一处的兜底写成
 * `?? 3`、或者漏判 `> 0`、或者其中一处忘了接修剪窗口，症状就是
 * **「时间轴上 5 秒、成片里 8 秒」** —— 而这种偏差要等导出完回看才发现，
 * 发现了也很难定位到是哪一层算错的。一个函数，两处都调，就不存在"不一致"这件事。
 *
 * ⚠️ `AudioClip.duration` 是**音源实测总长**（ffprobe），不是播放时长。
 * 修剪写的是 `clip_in_sec` / `clip_dur_sec`，`duration` 永不被改动 ——
 * 它是"这个文件到底多长"的唯一记录，改了就再也拉不回来（见 db.py AudioClip）。
 */

/** 参与时长换算所需的最小形状（`AudioClipInfo` 是其超集）。
 *
 *  用结构化最小类型而不是直接吃 `AudioClipInfo`，理由与 `selection.ts` /
 *  `trim.ts` 同款：验证脚本要能用三个字段拼出用例，而不是去构造一个
 *  有十几个字段、还带 status/error/voice_ref_url 的完整对象。 */
export interface AudioClipDuration {
  duration: number;
  clip_dur_sec?: number | null;
}

/** 没有任何时长信息时的兜底秒数。与旧代码保持一致（时间轴与导出原来都写 3）。 */
export const AUDIO_FALLBACK_SEC = 3;

/**
 * 这个音频段在时间轴上占多久：剪过用窗口长度，没剪过用素材总长。
 *
 * `clip_dur_sec` 为 null/undefined 表示**整段播放**（从没剪过），
 * 这与「剪成 0 秒」是两回事 —— 后者在后端被夹在 0.1 秒以上，永远不会是 0。
 * 所以这里判的是 `!= null && > 0`，两个条件都不能省：
 *   · 省掉 `!= null` → `0 ?? x` 不成立，undefined 会被当成 0 秒
 *   · 省掉 `> 0` → 库里万一有一条 0（老数据/异常写入），整段音频静默消失
 */
export function audioPlaySec(a: AudioClipDuration): number {
  if (a.clip_dur_sec != null && a.clip_dur_sec > 0) return a.clip_dur_sec;
  return a.duration > 0 ? a.duration : AUDIO_FALLBACK_SEC;
}
