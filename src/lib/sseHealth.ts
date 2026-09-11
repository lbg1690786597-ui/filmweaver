/**
 * sseHealth — 「事件流此刻通着吗」的进程级事实（修 U1 第 1、2 点）
 *
 * ## 它修的是哪个浪费
 *
 * `useProdJobs` 早就懂了一条正确的规则：**SSE 在线时轮询只需当兜底**，
 * 所以它的 job 轮询会 `tick % 5 !== 0 → return`，3s 名义、15s 实际。
 * 问题是那个 `sseUp` 是它自己的一个 `useRef` —— 别的轮询拿不到。于是全工程
 * 只有它一处降频，其余每一处都在 SSE 已经把同一条消息推过来的同时，
 * 继续无条件地按 3~5s 重拉全量数据。
 *
 * 拆解一个 1400 镜的项目时这笔账是这样的：`useBreakdown` 每 3s 一次
 * `refreshDetail()`，而 detail 是 1.6 MB —— 光这一处就是 ~550 KB/s 的持续下行，
 * 而这些字节里 SSE 已经用几百字节的 `job`/`shot` 事件说过了。
 *
 * ## 为什么是模块级变量而不是 Context / store
 *
 * 读它的地方全在 `setInterval` 回调里，那里要的是「此刻通没通」这个**瞬时值**，
 * 不是一个会触发重渲染的 state。做成 Context 的话，SSE 一断一通就要把整棵
 * 订阅树重渲染一遍，而这个信号平时**没有任何 UI** 需要展示。
 * 与 `lib/backendReach.ts` 同款理由、同款形状（那个也是模块级 + 通知函数）。
 *
 * ⚠️ 它与 `backendReach` 不是一回事，别合并：
 *   · `backendReach` = 后端连得上吗（决定要不要渲染断线页）
 *   · `sseHealth`    = 增量事件送得到吗（决定轮询该多勤）
 * SSE 断了但后端好着的情况很常见（nginx 掉了长连接、代理超时），
 * 那时界面必须一切正常，只是轮询要回到 3s 全速。
 */

/** 有没有一条活着的事件流。多项目不会并存（同时只订阅当前项目），故是单值。 */
let up = false;

/** SSE 连上/断开时由 `useProdJobs` 的 onUp/onDown 调。 */
export function setSseUp(next: boolean): void {
  up = next;
}

/** 轮询回调里读这个。刻意是个函数而不是导出变量：导出变量会被打包器
 *  快照成常量语义，闭包里读到的可能是订阅那一刻的旧值。 */
export function isSseUp(): boolean {
  return up;
}

/** 仅供验证脚本与测试重置（与 `resetBackendReach` 同款出口）。 */
export function resetSseHealth(): void {
  up = false;
}

/**
 * 「这一跳该不该真干活」——SSE 在线时把 `baseMs` 的轮询降成 `slowMs` 兜底。
 *
 * @param tick  第几次触发，**从 1 开始**（回调里先 `tick += 1` 再问）
 * @param baseMs 定时器的真实间隔
 * @param slowMs SSE 在线时希望的等效间隔（兜底节奏）
 * @param sseUp  此刻事件流通不通（调用方传 `isSseUp()`，便于纯函数测试）
 *
 * 抽成纯函数而不是各处手写 `tick % 5`，是为了让 `verify-sse-poll.ts`
 * 能把这条规则钉死：`5` 这个魔数一旦和 `baseMs` 脱钩（比如某处把间隔从 3s
 * 改成 5s 却忘了改 5），降频就会静默变成 25s —— 那种错没人看得出来。
 *
 * 边界上一律**保守**：算不出比例就当 1（每跳都干活）。宁可多刷几次，
 * 不可把用户的进度条停住。
 */
export function shouldSkipTick(
  tick: number, baseMs: number, slowMs: number, sseUp: boolean,
): boolean {
  if (!sseUp) return false;
  if (!(baseMs > 0) || !(slowMs > baseMs)) return false;
  const ratio = Math.max(1, Math.round(slowMs / baseMs));
  return tick % ratio !== 0;
}

/** 兜底节奏的统一口径：SSE 在线时，所有"顺带全量刷新"都降到这个间隔。
 *  15s 的来历是 `useProdJobs` 原有的 `tick % 5`（3s × 5），沿用以免出现
 *  两种兜底节奏；就绪度另用 30s（见 ShotsPanel 的说明）。 */
export const SSE_FALLBACK_MS = 15000;
