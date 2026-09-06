/**
 * lib/aborted.ts — 「用户主动取消」这一个错误类型
 *
 * 为什么单独一个文件：它原本定义在 `render/renderer.ts` 里，而 4.5 把素材缓存
 * 抽到 `lib/mediaCache.ts` 之后，缓存层也要抛它（下载中途取消）。
 * 让 `mediaCache` 反过来 import `renderer` 会成环。
 *
 * ⚠️ `name` 必须恒为 `"Aborted"`：`App.tsx:732` 靠 `e.name === "Aborted"` 决定
 * 「静默收场」还是「弹导出失败」。改这个字符串 = 用户每次点取消都会看到一个
 * 红色错误弹窗。
 */
export class Aborted extends Error {
  /**
   * 6.5：允许换一句话。`name` **不变**（那是承重的判据），换的只是 `message`
   * —— 跟踪也要抛这个类型，而它的取消不是"取消渲染"。缺省值一字未改，
   * 既有的 `new Aborted()` 调用点行为完全相同。
   */
  constructor(message = "用户已取消渲染") { super(message); this.name = "Aborted"; }
}
