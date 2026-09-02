/**
 * 由 RenderPlan 生成烧录用 SRT。
 *
 * 为什么不用后端的 `/projects/{id}/subtitles.srt`：
 * 那个端点**固定从项目第一个未停用镜头开始累加**，并输出全项目的字幕段。
 * 只要本次导出不是「全部启用镜头」，时间码就整体漂移：
 *   · 按集导出 —— 第 5 集的画面从 0s 开始，字幕却还背着前 4 集的累计偏移，
 *     偏几十分钟，等于整条字幕轨全废
 *   · 已生成镜头（默认档）—— 中间未出片的镜头不进画面、不占时长，
 *     后端却仍给它们算了时长，于是越往后字幕越提前
 *
 * 而 plan.subtitles 是 normalize() 用**同一批 picked 镜头、同一套取片窗口与
 * 变速口径**换算出来的绝对秒（normalize.ts 的 shotStartSec），与实际拼接
 * 帧对帧一致。导出烧的是这个 plan，字幕就必须来自这个 plan。
 */
import type { RenderPlan } from "./model";

const p2 = (n: number) => String(n).padStart(2, "0");

/** 秒 → SRT 时间码 `HH:MM:SS,mmm`。负数钳到 0（转场回退可能算出极小负值）。 */
function ts(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(total % 1000).padStart(3, "0")}`;
}

/**
 * 生成 SRT 文本；没有可烧的字幕时返回空串（调用方据此跳过烧录环节）。
 *
 * 规范细节：SRT 按时间升序，序号从 1 连续编号；文本内的空行会截断一条字幕，
 * 故把连续空行压成单个换行。
 */
export function planToSrt(plan: RenderPlan): string {
  const cues = plan.subtitles
    .filter((c) => c.text && c.text.trim())
    .sort((a, b) => a.startSec - b.startSec || a.durationSec - b.durationSec);

  const out: string[] = [];
  cues.forEach((c, i) => {
    const dur = c.durationSec > 0 ? c.durationSec : 3;
    const text = c.text.trim().replace(/\n{2,}/g, "\n");
    out.push(`${i + 1}\n${ts(c.startSec)} --> ${ts(c.startSec + dur)}\n${text}\n`);
  });
  return out.join("\n");
}
