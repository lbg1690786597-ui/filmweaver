/**
 * lib/track/nccWorker.ts — 跟踪的匹配线程（批次 6 / 6.5）
 *
 * 为什么值得为它开一个 worker：实测一次 320×568 帧、96×77 框的 NCC 匹配是
 * **14.3 ms**（`MAX_SAMPLES=1024` 个模板点 × 7663 个候选位置，见 §0.6 的 6.5 行）。
 * 放在主线程上，每个采样点都会占住一整个动画帧 —— 而用户此刻正盯着进度条看，
 * 那是最不该掉帧的时刻。搬进 worker 后主线程只剩「seek + drawImage + getImageData」。
 *
 * ⚠️ **抽帧不能搬进来**：worker 里没有 DOM，没有 `<video>`，也没有 canvas
 * （`OffscreenCanvas` 有，但它没法解码视频）。所以分工是固定的 ——
 * 主线程抽帧、worker 算相关，帧数据用 transfer 过来（零拷贝）。
 *
 * 逻辑一行都不在这里：真正的数学全在 `ncc.ts`（纯函数、可在 node 下验证），
 * 本文件只做收发与状态保持。**worker 里不许出现第二份匹配实现** ——
 * 那样主线程兜底路径与 worker 路径会各算各的，而两者结果不同的表现是
 * "在我机器上跟得挺准"。
 */

import { matchTemplate, type MatchOpts, type Template } from "./ncc";
import type { TrackReq, TrackRes } from "./protocol";

// tsconfig 的 `lib` 里只有 DOM，没有 WebWorker（加上去会与 DOM 的同名声明打架）。
// 这里按实际用到的两个方法窄化，比整体切 lib 的副作用小得多。
const ctx = self as unknown as {
  postMessage(msg: TrackRes): void;
  addEventListener(type: "message", cb: (e: { data: TrackReq }) => void): void;
};

let tpl: Template | null = null;
let opts: MatchOpts = {};

ctx.addEventListener("message", (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      tpl = msg.tpl;
      opts = msg.opts;
      ctx.postMessage({ id: msg.id, ok: true, result: null });
      return;
    }
    if (!tpl) throw new Error("worker 尚未收到模板");
    ctx.postMessage({ id: msg.id, ok: true, result: matchTemplate(msg.frame, tpl, msg.prev, opts) });
  } catch (err) {
    // 把异常原样送回主线程：worker 里未捕获的异常只会变成一个没有 id 的
    // `error` 事件，那笔 match 会永远挂着，跟踪就卡在某个百分比不动了。
    ctx.postMessage({ id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
});
