/**
 * lib/track/protocol.ts — 主线程 ↔ 跟踪 Worker 的消息类型（批次 6 / 6.5）
 *
 * 单独一个文件是为了**打断依赖环**：worker 与客户端都要认同一套消息，
 * 而客户端里有 `new Worker(new URL("./nccWorker.ts", …))` —— 让 worker 反过来
 * import 客户端会把它自己也打包进 worker 的 chunk。
 *
 * 纯类型 + 一个常量，零运行时依赖。
 */

import type { BoxPx, GrayFrame, MatchOpts, MatchResult, Template } from "./ncc";

export type TrackReq =
  | { id: number; type: "init"; tpl: Template; opts: MatchOpts }
  | { id: number; type: "match"; frame: GrayFrame; prev: BoxPx };

export type TrackRes =
  | { id: number; ok: true; result: MatchResult | null }
  | { id: number; ok: false; error: string };

/**
 * 握手超时（毫秒）。
 *
 * worker 造不出来时**不一定**会在 `new Worker(...)` 那一行抛：脚本加载失败是
 * 异步的 `error` 事件，而在某些容器里连那个事件都不来，表现是 postMessage 之后
 * 石沉大海。所以客户端一律先握手再用，超时即退回主线程实现（结果逐位相同）。
 * 3 秒对一次本地 chunk 加载是极宽的上限，用户感知不到。
 */
export const HANDSHAKE_TIMEOUT_MS = 3000;
