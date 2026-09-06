/**
 * lib/outboxStore.ts — 离线写入队列的**实例**（6.8）
 *
 * 与 `lib/backendReach.ts` 同款：进程级单例 + `useSyncExternalStore` 订阅。
 * 理由也同款 —— 入队发生在 `trackedFetch` 里，那不在任何组件中；
 * 而顶栏/横幅要显示"暂存了几处"，必须能订阅到。
 *
 * ## I/O 是注入的，且**允许没有**
 *
 * 桌面端注入落盘实现（`lib/outboxIO.ts`），浏览器 `/fw/app/` 下没有
 * `appDataDir()`，就**不注入**：队列退化成纯内存，关掉页签就没了。
 * 这是刻意的，而且必须让用户看得见 —— `isDurable()` 就是给界面用的，
 * 界面据此把「联网后自动补发」改成「本页面关闭前有效」。
 * 假装浏览器也能持久化，等于又造一个"假的已保存"。
 *
 * ## 落盘里**不存 Authorization**
 *
 * 队列只存 method / url / body。补发时现取 `authHeaders()`。
 * 把 token 写进磁盘上的明文 JSON 是不能接受的，而且陈旧 token 补发也只会 401。
 */

import {
  canQueue, coalesce, replayQueue,
  type OutboxIO, type QueuedWrite, type ReplayResult,
} from "./outbox";

let queue: QueuedWrite[] = [];
let io: OutboxIO | null = null;
let seq = 0;
let replaying = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** 换上新队列并落盘。落盘失败只记日志：**内存里的队列仍然有效**，
 *  为了一次写盘失败就把用户的改动丢掉是本末倒置。 */
function commit(next: QueuedWrite[]): void {
  queue = next;
  notify();
  void io?.save(next).catch((e) => console.warn("[outbox] 落盘失败:", e));
}

/** 桌面端在启动时注入落盘实现；浏览器下不调用。 */
export function setOutboxIO(next: OutboxIO | null): void {
  io = next;
}

/** 队列是否真的能扛住重启。界面文案据此变化，见文件头。 */
export function isDurable(): boolean {
  return io !== null;
}

/** 启动时把上次残留的队列读回来。没有 I/O 就什么也不做。 */
export async function hydrateOutbox(): Promise<number> {
  if (!io) return 0;
  try {
    const loaded = await io.load();
    if (loaded.length === 0) return 0;
    // seq 要接着最大的往下走，否则新入队的笔会和旧笔重号
    seq = Math.max(seq, ...loaded.map((w) => w.seq));
    queue = [...loaded].sort((a, b) => a.seq - b.seq);
    notify();
    return queue.length;
  } catch (e) {
    console.warn("[outbox] 读取队列失败，按空队列继续:", e);
    return 0;
  }
}

/** 当前队列。引用稳定：内容没变时永远是同一个数组（`useSyncExternalStore` 要求）。 */
export function getOutbox(): readonly QueuedWrite[] {
  return queue;
}

/** 待补发笔数。给 `useSyncExternalStore` 用的原始值快照。 */
export function getOutboxCount(): number {
  return queue.length;
}

export function subscribeOutbox(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 记下一笔因为断线而没发出去的写。返回是否真的入队了。
 *
 * 调用点在 `trackedFetch` 的 catch 里，且只在 `isUnreachable(err)` 成立时 ——
 * 一次 500 不该进队列，它是"服务端拒绝了"，补发一百次也是同一个 500。
 */
export function noteFailedWrite(
  url: string, method: string, body: unknown, now: number,
): boolean {
  if (!canQueue(url, method, body)) return false;
  const entry: QueuedWrite = {
    seq: ++seq,
    method: method.toUpperCase(),
    url,
    body: typeof body === "string" ? body : null,
    at: now,
    tries: 0,
  };
  const next = coalesce(queue, entry);
  // coalesce 可能因为"目标已排了 DELETE"而原样返回，此时不算入队
  const changed = next.length !== queue.length
    || next.some((w, i) => w !== queue[i]);
  if (!changed) return false;
  commit(next);
  return true;
}

/**
 * 补发一遍队列。**同一时刻只允许一趟**：恢复连接的那一下可能同时来自
 * 探测轮询和某个成功的请求，两趟并行会把同一笔发两次。
 */
export async function runReplay(
  send: (w: QueuedWrite) => Promise<number | null>,
): Promise<ReplayResult | null> {
  if (replaying || queue.length === 0) return null;
  replaying = true;
  try {
    const { result, remaining } = await replayQueue(queue, send);
    commit(remaining);
    return result;
  } finally {
    replaying = false;
  }
}

/** 仅供测试与切换账号时重置。 */
export function resetOutbox(): void {
  queue = [];
  seq = 0;
  replaying = false;
  notify();
}
