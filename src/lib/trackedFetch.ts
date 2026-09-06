/**
 * trackedFetch — 写请求的唯一出口，顶栏「已保存」的真实数据源（批次 2 / 2.1）
 *
 * ## 为什么单独一个文件，而不是留在 api.ts 里
 *
 * `api.ts` 顶上是 `import.meta.env.VITE_FW_API_BASE` —— 那是 Vite 的编译期替换，
 * 在 node（tsx）里 `import.meta.env` 是 undefined，取属性直接抛。
 * 于是 `scripts/verify-save-state.ts` 想验「断网时写请求是否真的报失败」
 * 就根本 import 不进来，只能改成静态扫源码"看起来对不对"。
 *
 * 而 2.1 要防的恰恰是"看起来对、实际没上报"。所以把这层包装挪到一个
 * **不碰任何浏览器/Vite 专属全局**的模块里：url 由调用方传入，
 * 唯一的外部依赖是 `globalThis.fetch`（node 18+ 自带，测试里可替换）。
 * 这样验证脚本能真的把 fetch 换成"必定 reject"再断言 store 的状态。
 */

import { useSaveState, SaveHttpError } from "../stores/saveStateStore";
import { isUnreachable } from "./appGate";
import { offlineWriteHint } from "./outbox";
import { noteRequestOk, noteRequestFailed } from "./backendReach";
import { noteFailedWrite } from "./outboxStore";

export const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** 不计入"保存状态"的写端点。
 *
 *  判据是**「失败了要不要让用户担心改动丢了」**：
 *  这两个都是用户显式发起的文件导入，各自有独立的进度与错误 UI，
 *  且失败不代表任何已做的编辑没落库。把它们算进去只会让顶栏在
 *  上传大文件的整整一分钟里显示「保存中」，反而掩盖真正的编辑保存。
 *
 *  ⚠️ 新增写端点时**默认不要往这里加**。漏 track 的后果是"假的已保存"，
 *  正是 2.1 要消灭的东西；多 track 的后果只是多转一会儿圈。 */
export const UNTRACKED_WRITE_PATHS = ["/v2/media/upload", "/v2/script/import-file"];

/** 判断某次请求是否该计入保存状态。抽成纯函数好让验证脚本表驱动地测。 */
export function isTrackedWrite(url: string, method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase())
    && !UNTRACKED_WRITE_PATHS.some((p) => url.includes(p));
}

/** 包一层 fetch：写方法自动计入 saveStateStore，读方法原样透传。
 *
 *  非 2xx 也算失败 —— 只看 `fetch` 有没有 reject 是不够的，
 *  后端回 500 / 401 时 `fetch` 是成功 resolve 的，旧代码正是在这里
 *  把"没存上"当成了"已保存"。
 *
 *  6.7：顺带把「后端还连不连得上」也报出去（`backendReach`）。**两件事必须分开**：
 *  一次 500 是"没保存上"但**不是**"连不上"，所以那边的判据是 `isUnreachable`，
 *  不是这里的 `resp.ok`。混用的话，后端一报 500 整个软件就宣布离线。
 *  报告点放在这里而不是各调用点，理由与保存状态同款：写请求 25+ 处，逐个接必漏。
 *
 *  6.8：断线失败的写还会**进补发队列**（`lib/outboxStore.ts`）。同样只此一处 ——
 *  这是本文件第三次因为"写请求只有一个出口"而被选中当接线点，三件事
 *  （保存状态 / 可达性 / 补发队列）判据各不相同，但入口必须是同一个。 */
export async function fetchTracked(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (!isTrackedWrite(url, method)) {
    // 非跟踪请求（GET、以及豁免名单里的上传）不计入保存状态，
    // 但它们照样是"后端还在不在"的证据，可达性该报还是要报。
    try {
      const resp = await fetch(url, init);
      noteRequestOk();
      return resp;
    } catch (e) {
      noteRequestFailed(e);
      throw e;
    }
  }

  const { beginWrite, endWrite } = useSaveState.getState();
  beginWrite();
  try {
    const resp = await fetch(url, init);
    if (!resp.ok) {
      // 只读状态码，不消费 body —— body 归调用方读（Response 只能读一次）
      endWrite(new SaveHttpError(resp.status, `${resp.status}`));
    } else {
      endWrite();
    }
    // 回了状态码就说明后端活着，与这一笔存没存上无关
    noteRequestOk();
    return resp;
  } catch (e) {
    // 断网/DNS/被拦截：fetch 直接 reject。
    // 6.8：**只有连不上**才排队补发。一次 500 是"服务端拒绝了"，
    // 补发一百次还是同一个 500，排队只会让用户以为它还有救。
    // 判据复用 `isUnreachable`，与 6.7 判离线的是同一条，两者不会各说各话。
    const down = isUnreachable(e);
    const queued = down && noteFailedWrite(url, method, init?.body, Date.now());
    // ⚠️ 入队要在 endWrite **之前**：顶栏那句话的内容取决于这一笔到底暂存住了
    // 没有，而"暂存住了"和"彻底没了"对用户的含义正好相反。反过来写就只能
    // 统一说"未保存"，等于把刚刚做对的事又瞒下来。
    endWrite(e, offlineWriteHint(down, queued, method));
    noteRequestFailed(e);
    throw e;
  }
}
