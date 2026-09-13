/**
 * lib/fetchTimeout.ts — 给 `fetch` 加一道**读超时**（2026-09-12）
 *
 * ## 修的是哪个 bug
 *
 * 「后端连不上时软件整体不可用」。原来的 `fetch` **没有超时**：TCP 连不上的
 * 时候它会很快 reject（那是"断网"的常见形态，`trackedFetch` 一直在处理），
 * 但**连得上却不应答**是另一回事——`fetch` 会一直挂着，直到浏览器/WebView
 * 自己放弃（可能几分钟，也可能在代理场景下永不放弃）。挂着的后果是一条链：
 *
 *   1. `api.health()` 永不 settle → `probeOk` 停在 null
 *   2. `backendOk` 于是停在 null（门禁里 = 「探测中」）→ **到不了 false**
 *   3. `noteRequestFailed` 也就永不触发 → 那个 15 秒重连轮询
 *      （`useAuth` 里 `if (backendOk !== false) return`）**永远不启动**
 *   4. 编辑器里每一次 `refreshDetail()` 同样永不 settle → stagedWrite 的
 *      待写项永不清除 → 后续每次拖动都叠在一条堵死的管线上
 *
 * 也就是说：**没有超时，"后端不可达"这个状态根本无法被表达出来**。
 * 界面只能停在"正在连接…"，而用户看到的是"软件坏了"。
 *
 * ## 超时抛什么（这一点是承重的）
 *
 * 抛 **`TypeError`**，消息里带 "网络请求超时"。理由：`appGate.isUnreachable`
 * 的判据是 `err instanceof TypeError`（那正是 `fetch` 网络层失败的形态），
 * 而 `AbortError` 被**明确排除**在外（它的注释写着：取消不是断网）。
 * 若这里直接抛 `AbortError`，可达性上报会把它当成"用户取消"而**不上报**，
 * 于是加了超时等于没加——`backendOk` 照样到不了 false。
 *
 * 所以这里把超时单独认出来、转成 TypeError，再原样抛出。用户主动取消
 * （调用方自己传进来的 signal）仍然原样抛 `AbortError`，语义不变。
 *
 * ## 为什么不做全局默认
 *
 * 素材下载（`mediaCache`）**不走这里**：那是几十上百 MB 的文件，
 * 在一个大文件上套 15 秒超时会把正常的慢网下载掐死，而且它是纯浏览器 fetch、
 * 与"后端还活着吗"无关（后端不参与）。本模块只服务 `api.ts` 的 JSON 接口。
 */

/** JSON 接口的读超时。取 15 秒而不是 5 秒：dev 后端在本地几乎瞬时返回，
 *  但正经机器的首次拆解/详情在 1424 镜项目上要几百毫秒，
 *  而 prod 走公网 + nginx；5 秒会在弱网下误报"后端挂了"，
 *  那比晚 10 秒发现离线更烦人（横幅会来回闪）。 */
export const API_TIMEOUT_MS = 15000;

/** 超时专用的错误消息前缀，验证脚本据此断言"这是超时不是别的失败"。 */
export const TIMEOUT_MARKER = "网络请求超时";

/**
 * 与调用方自己的 `signal` 合成一个：任一触发都掐断。
 *
 * `AbortSignal.any` 在 WebView2（Chromium 111+）与 node 20 上都有，
 * 但 `AbortSignal.timeout` 要看运行时而这里只需要一个定时器 + 一个自己的
 * controller，故手写：少一个"运行时到底支不支持"的不确定性，
 * 也让"到底是超时掐的还是调用方掐的"看得清楚。
 */
function withTimeout(
  init: RequestInit | undefined,
  ms: number,
): { init: RequestInit; timedOut: () => boolean; dispose: () => void } {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);

  const outer = init?.signal;
  const onOuterAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  return {
    init: { ...init, signal: ctl.signal },
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    },
  };
}

/**
 * 带超时的 `fetch`。行为与 `fetch` 完全一致，只有两处不同：
 *  · 到 `ms` 还没回应就掐断；
 *  · 因此产生的 `AbortError` **转成 TypeError**（见文件头"超时抛什么"）。
 *
 * ⚠️ **不要在流式响应上用**：`fetch` resolve 只代表响应头到了，
 * 若调用方随后要长时间读 body（SSE），计时器必须已经 dispose 掉。
 * 本函数在 resolve/reject 时都会 dispose，所以 SSE 那类调用方
 * 只要**先 await 到 Response 再自己读 body** 就是安全的
 * （`api.openEvents` 已经这么写）。
 */
export async function fetchWithTimeout(
  url: string, init: RequestInit | undefined, ms: number,
): Promise<Response> {
  const t = withTimeout(init, ms);
  try {
    return await fetch(url, t.init);
  } catch (e) {
    if (t.timedOut()) {
      // 转成 TypeError：可达性判据认的就是它。见文件头那段推导。
      throw new TypeError(`${TIMEOUT_MARKER}（${ms / 1000}s）: ${url}`);
    }
    throw e;
  } finally {
    t.dispose();
  }
}
