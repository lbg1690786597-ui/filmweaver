/**
 * lib/track/nccClient.ts — 把匹配搬进 Worker 的那一侧（批次 6 / 6.5）
 *
 * 对外只有一个 `openWorkerMatcher`，签名就是 `track.ts` 的 `OpenMatcher`，
 * 所以跟踪流程完全不知道自己算在哪根线程上。
 *
 * ## 拿不到 worker 就退回主线程，而且是**握手确认过**才敢用
 *
 * `new Worker(...)` 不抛**不等于** worker 能用：脚本加载失败走的是异步 `error`
 * 事件，某些容器里连那个事件都不来，表现是第一条 `match` 石沉大海、
 * 进度条永远停在 1/40。所以这里先 init 握手（带超时），握上了才返回 worker 版，
 * 否则 terminate 掉退回 `openLocalMatcher`。
 *
 * 两条路径**共用 `ncc.ts` 的同一个 `matchTemplate`**，结果逐位相同，
 * 差别只有"占不占主线程"。这一点是有意的：如果两边各有一份实现，
 * "在我机器上跟得挺准"就会变成一个查不动的 bug。
 *
 * ## 为什么不 transfer 帧
 *
 * 一帧 320×568 的灰度是 182 KB，结构化克隆的代价实测不到 0.1 ms；
 * 而 transfer 会把主线程这边的 `Uint8Array` **detach**——今天 `runTrack` 在
 * 匹配之后不再读 `frame.data`（只读 `w/h`），但那是当前实现的巧合，
 * 不是接口承诺。为 0.1 ms 埋一个"某天有人多读一次就拿到空数组"的雷不划算。
 */

import { openLocalMatcher, type Matcher, type OpenMatcher } from "./track";
import type { MatchResult } from "./ncc";
import { HANDSHAKE_TIMEOUT_MS, type TrackRes } from "./protocol";

/** 造一个 worker；环境不支持（老 WebView / 打包没出 chunk）时返回 null。 */
function spawn(): Worker | null {
  try {
    if (typeof Worker === "undefined") return null;
    return new Worker(new URL("./nccWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

export const openWorkerMatcher: OpenMatcher = async (tpl, opts): Promise<Matcher> => {
  const w = spawn();
  if (!w) return openLocalMatcher(tpl, opts);

  let seq = 0;
  const pending = new Map<number, {
    resolve: (r: MatchResult | null) => void; reject: (e: Error) => void;
  }>();
  let dead: Error | null = null;

  const killAll = (e: Error) => {
    dead = e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };

  w.addEventListener("message", (ev: MessageEvent<TrackRes>) => {
    const res = ev.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  });
  // worker 整个挂掉时必须把所有在飞的请求打掉，否则 `runTrack` 会 await 一个
  // 永远不 settle 的 promise —— 用户看到的是进度条卡死，且取消按钮也救不回来
  // （取消的检查点在下一次循环，而循环正卡在这个 await 上）。
  w.addEventListener("error", () => killAll(new Error("跟踪 worker 异常退出")));

  const send = (req: Parameters<Worker["postMessage"]>[0], id: number) =>
    new Promise<MatchResult | null>((resolve, reject) => {
      if (dead) { reject(dead); return; }
      pending.set(id, { resolve, reject });
      w.postMessage(req);
    });

  // ---- 握手：init 通了才认这个 worker ----
  const id0 = ++seq;
  const handshake = send({ id: id0, type: "init", tpl, opts }, id0);
  const timer = setTimeout(
    () => { const p = pending.get(id0); if (p) { pending.delete(id0); p.reject(new Error("worker 握手超时")); } },
    HANDSHAKE_TIMEOUT_MS,
  );
  try {
    await handshake;
  } catch {
    clearTimeout(timer);
    w.terminate();
    return openLocalMatcher(tpl, opts);
  }
  clearTimeout(timer);

  return {
    async match(frame, prev) {
      const id = ++seq;
      const r = await send({ id, type: "match", frame, prev }, id);
      // `init` 之外的回复不该是 null；真出现说明协议对不上，当成失败上抛，
      // 由 `runTrack` 记成 nosource 并如实告诉用户，而不是拿一个假的 0 分继续。
      if (!r) throw new Error("跟踪 worker 返回了空结果");
      return r;
    },
    close() {
      killAll(new Error("跟踪已结束"));
      w.terminate();
    },
  };
};
