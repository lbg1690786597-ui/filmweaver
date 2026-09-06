/**
 * backendReach — 「后端此刻还连得上吗」的进程级观测（6.7）
 *
 * ## 它修的是哪个 bug
 *
 * `useAuth` 的探测 `probe()` 只在挂载时跑一次，而那个 15 秒的轮询
 * `if (backendOk !== false) return;` —— **只在已经离线时才启动**。
 * 于是「会话中途断网」这件事永远不会被察觉：用户接着编，每一笔 PATCH 都失败，
 * 而顶栏那颗 `.fw-tb-dot` 一直是绿的。（更准确地说，那颗点的红色分支在旧代码里
 * 根本**到不了** —— 一旦 backendOk 变成 false，`App.tsx` 的门禁会先把整个编辑器
 * 换成断线页，红点还没来得及渲染。）
 *
 * ## 为什么不是"那就一直轮询"
 *
 * 最直觉的修法是把轮询改成始终跑。但那是拿一个**恒定的背景请求**去换一个
 * **只在出事时才需要的信号**：软件开着不动的时候每分钟都在打后端，而真正断网的
 * 那一刻，用户其实**已经有一个失败的请求了**——就是他刚做的那个操作。
 *
 * 所以这里反过来：让真实流量自己报告。`trackedFetch`（所有写）和 `api.get`（所有读）
 * 各自在成功/失败时调一句，本模块只记住最近一次结论。健康时零额外请求，
 * 断网时在**用户的第一个动作**上就察觉——比任何轮询都快。
 * 轮询仍然保留，但只在已判定离线后跑（恢复检测），与原来一致。
 *
 * ## 它不是什么
 *
 * 不是重试队列，也不是离线缓存。失败的请求就是失败了；本模块只负责让界面
 * 说实话（横幅 + 那颗红点），不制造"看起来还在正常工作"的假象。
 * 真正的离线编辑与回连同步是 6.8。
 */

import { isUnreachable } from "./appGate";

/** null = 本次会话还没有任何请求给出过结论 */
let reach: boolean | null = null;
const listeners = new Set<() => void>();

function set(next: boolean): boolean {
  if (reach === next) return false;   // 每个请求都通知一次的话，React 会被刷爆
  reach = next;
  for (const fn of [...listeners]) fn();
  return true;
}

export function getBackendReach(): boolean | null { return reach; }

export function subscribeBackendReach(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 任何一次请求**拿到了回应**（哪怕是 500）——后端活着。 */
export function noteRequestOk(): boolean { return set(true); }

/**
 * 任何一次请求抛了异常。**是不是断网由 `isUnreachable` 判**，不在这里判：
 * 调用点（trackedFetch / api.get）拿到的 err 五花八门，把判据散到调用点上，
 * 迟早有一处把 500 或者用户取消当成断网。
 *
 * 注意失败**不算数**的那些（有状态码、AbortError）这里也不当成"连得上"——
 * 一次 404 不足以证明网络好，但下一个成功的请求会。宁可晚一步，不要来回抖。
 */
export function noteRequestFailed(err: unknown): boolean {
  return isUnreachable(err) ? set(false) : false;
}

/** 仅供验证脚本重置 */
export function resetBackendReach(): void {
  reach = null;
  for (const fn of [...listeners]) fn();
}
