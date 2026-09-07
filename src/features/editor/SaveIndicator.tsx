/**
 * SaveIndicator — 顶栏左侧的保存状态（批次 2 / 2.1）
 *
 * 取代原来那句写死的 `<span>✓ 已保存</span>`（TopBar.tsx 旧 92 行）。
 * 那句话不接任何状态：断网、后端 500、token 过期，它照样显示「已保存」——
 * 用户据此关窗口，改动真丢。详见 stores/saveStateStore.ts 的开头。
 *
 * ## 为什么是独立组件、而不是给 TopBar 加 props
 *
 * 保存状态每笔写请求都会变两次（begin/end）。若提到 App 里当 props 往下传，
 * 每次自动保存都会重渲染整个编辑器（时间线、画布、面板全在里面）。
 * 组件内部订阅，重渲染就只限这一个 span —— 拖滑块时这点差别很实在。
 *
 * ## 失败为什么要点一下才消失
 *
 * 见 saveStateStore：PATCH 是按字段发的，一笔失败就是那笔改动没落库，
 * 后面别的字段存成功救不回它。所以必须让用户**看见过一次**才允许消失。
 */

import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useSaveState, saveStatusOf } from "../../stores/saveStateStore";

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function SaveIndicator() {
  const inFlight = useSaveState((s) => s.inFlight);
  const lastError = useSaveState((s) => s.lastError);
  const failedCount = useSaveState((s) => s.failedCount);
  const lastSavedAt = useSaveState((s) => s.lastSavedAt);
  const clearError = useSaveState((s) => s.clearError);

  const status = saveStatusOf({ inFlight, lastError });

  if (status === "error") {
    const more = failedCount > 1 ? `（共 ${failedCount} 笔未保存）` : "";
    return (
      <button
        className="fw-tb-save error"
        title={`${lastError!.message}${more}\n发生于 ${hhmmss(lastError!.at)} · 点击可忽略此提示`}
        onClick={clearError}
      >
        <AlertTriangle size={11} />
        <span className="fw-tb-save-msg">{lastError!.message}</span>
        {failedCount > 1 && <span className="fw-tb-save-n">{failedCount}</span>}
      </button>
    );
  }

  if (status === "saving") {
    return (
      <span className="fw-tb-save saving" title={`正在保存 ${inFlight} 笔改动`}>
        <Loader2 size={11} className="fw-spin" /> 保存中
      </span>
    );
  }

  return (
    <span
      className="fw-tb-save saved"
      title={lastSavedAt
        ? `改动已自动保存 · 最近一次 ${hhmmss(lastSavedAt)}`
        : "改动会自动保存（本次打开后还没有改动）"}
    >
      <Check size={11} /> 已保存
    </span>
  );
}
