/**
 * LoadIndicator — 顶栏的「有数据没加载出来」指示器（批次 2 / 2.4）
 *
 * 与 SaveIndicator 的分工：
 *   · SaveIndicator 说的是「你刚做的改动**有没有存进去**」
 *   · LoadIndicator 说的是「你**现在看到的东西**是不是完整的」
 *
 * 后者原本完全没有出口 —— 九处读路径失败都是 `catch {}`，界面上只剩空轨道。
 * 空轨道与"确实是空的"长得一模一样，用户的结论是"我的编辑丢了"，
 * 下一步动作是重做/重新生成，于是一次网络抖动变成一次真实的数据覆盖。
 * 完整推导见 stores/loadStateStore.ts 的开头。
 *
 * ## 为什么它必须是**持久**的，而 toast 不够
 *
 * toast 4 秒后消失，空轨道不会消失。用户回头再看一眼，看到的仍然是那句谎话。
 * 所以 toast 只负责"当场被注意到"，这里负责"只要谎话还在，纠正就还在"。
 *
 * ## 为什么内部订阅（与 SaveIndicator 同理）
 *
 * 失败态在轮询场景下每 5 秒可能变一次（count++）。提到 App 当 props 传，
 * 断网时整个编辑器每 5 秒重渲染一遍。
 * ——注意这里只订阅 `failures`，**不订阅 `retries`**：注册重试回调不该触发重渲染。
 *
 * ## 没有失败时返回 null（不是返回一个"全部已加载"的绿标）
 *
 * "数据加载正常"是默认预期，为它常驻一个标记只是噪音；顶栏空间也该留给
 * 真正需要动作的东西。这与 SaveIndicator 常驻「已保存」不同 —— 那个是
 * 在回答用户主动的疑问（我刚改的存了吗），这个是在打断一个错误的印象。
 */

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useLoadState, loadSummaryOf } from "../../stores/loadStateStore";

const KIND_HINT: Record<string, string> = {
  network: "看起来是网络断了或服务端不可达。",
  auth: "登录状态已失效，重新登录后即可恢复。",
  server: "服务端返回了错误，稍后重试通常可恢复。",
  unsupported: "当前服务端版本没有这个接口，属功能不可用（不是你的数据丢了）。",
  unknown: "",
};

export default function LoadIndicator() {
  const failures = useLoadState((s) => s.failures);
  const { list, text, kind } = loadSummaryOf(failures);

  if (!list.length) return null;

  const retryAll = () => {
    // 逐条调各自注册的重试。取的是**调用那一刻**的 retries，
    // 而不是订阅它 —— 见文件头"不订阅 retries"。
    const { retries } = useLoadState.getState();
    for (const f of list) retries[f.key]?.();
  };

  const retriable = list.filter((f) => useLoadState.getState().retries[f.key]).length;

  const detail = [
    ...list.map((f) => `· ${f.message}${f.count > 1 ? `（已失败 ${f.count} 次）` : ""}`),
    "",
    KIND_HINT[kind ?? "unknown"],
    "⚠️ 这些位置显示为空**不代表数据没了**，不要照这个状态重做或重新生成。",
    retriable > 0 ? "点击重试。" : "",
  ].filter(Boolean).join("\n");

  return (
    <button className={`fw-tb-load ${kind ?? "unknown"}`} title={detail}
      onClick={retryAll} disabled={retriable === 0}>
      <AlertTriangle size={11} />
      <span className="fw-tb-load-msg">{text}</span>
      {retriable > 0 && <RefreshCw size={10} className="fw-tb-load-retry" />}
    </button>
  );
}
