/**
 * AgentCommandBar — 编辑器里的 AI 指令条（批次 E6 的 UI 收口）
 *
 * ## 它是什么，不是什么
 *
 * 是**一条输入框**：用户打一句话 → 走 `runAgent` → AI 在同一个撤销栈里改。
 * 不是聊天窗口：这个项目没有"AI 对话面板"这个需求，而对话面板会带来
 * 会话列表、上下文选择、消息流渲染一整套东西 —— 那些都不在 PLAN §2.5 里。
 *
 * ## 三个必须做对的地方（每一条都对应一种"AI 功能看起来能用其实不能用"）
 *
 * **① 确认门是 fail closed 的。** 花钱/破坏性能力在 `runAgent` 里先 dry-run、
 *    再问 `confirm`。这个组件的 `confirm` 在**没有确认条可显示时**返回
 *    "取消"（`phase` 不是 `confirm` 就 `answer(false)`）—— 反过来做，
 *    AI 就能在用户没看见的情况下花掉额度。
 *
 * **② 跑的时候禁掉第二次提交。** 两条 `runAgent` 并行会开两个 turnId，
 *    而 `beginTurn` 是覆盖式的：后开的那轮会让先开那轮的 `endTurn` 关不掉，
 *    于是"AI 改的那批"留在栈上关不掉轮次，用户接下来的手动操作会被并进去。
 *
 * **③ 撤销按钮是"这一轮"的，不是"最后一次"的。** 判据是栈顶记录的
 *    `turnId` 等于本轮 id（见 `agentBar.ts` 的 `turnIsOnTop`）。按
 *    "栈非空"来判断，用户会在 AI 什么都没改、但自己刚手动改过一笔时
 *    看到一个写着「撤销 AI 这一轮」的按钮。
 *
 * ## ⚠️ 这里没有、也永远不能有 API 密钥
 *
 * 模型调用走 `api.agentTurn`（后端代理）。PLAN §4.2 批次 E 的红线：
 * 安装包可被解包，内置 key 等于公开。`verify-agent.ts` 第 ⑨ 段有一整套
 * 静态断言钉这件事。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, X, AlertTriangle } from "lucide-react";
import { api } from "../../api";
import { useTimelineStore } from "../../stores/timelineStore";
import { makeAgentHost } from "../../lib/agent/host";
import { runAgent, summarizeRun } from "../../lib/agent/runAgent";
import type { AgentRunResult } from "../../lib/agent/runAgent";
import {
  createConfirmGate, normalizeDropped, runStatusLine, turnIsOnTop,
} from "./agentBar";
import type { ConfirmRequest } from "./agentBar";
import "./AgentCommandBar.css";

export interface AgentCommandBarProps {
  /** 写一句给用户的话（App 的 toast）。**必须传** —— host 的 `say` 不设默认，
   *  默认成 `console.log` 会让"AI 说了一句话"在打包版里彻底消失。 */
  onToast: (msg: string, ms?: number) => void;
  /** 是否可用（没打开项目 / 离线时禁用）。默认可用。 */
  enabled?: boolean;
}

export default function AgentCommandBar(p: AgentCommandBarProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<ConfirmRequest | null>(null);
  const [last, setLast] = useState<{ turnId: string | null; line: string } | null>(null);
  // 上一轮改动了什么，供"撤销这一轮"按钮的 tooltip 说清楚代价
  const [lastSummary, setLastSummary] = useState("");

  const gateRef = useRef<ReturnType<typeof createConfirmGate> | null>(null);
  if (!gateRef.current) gateRef.current = createConfirmGate();
  const gate = gateRef.current;

  // 确认条的来源是 gate 内部的挂起询问，不是组件自己的 state ——
  // 这样"用户在确认期间点了关闭"也不会留下一条点不动的确认条。
  useEffect(() => gate.subscribe(setPending), [gate]);

  const undoCount = useTimelineStore((s) => s.undoStack.length);
  const undoTopTurn = useTimelineStore((s) => s.undoStack[s.undoStack.length - 1]?.origin);
  const hint = undoTopTurn?.by === "agent"
    ? `撤销 AI 这一轮${lastSummary ? `（${lastSummary}）` : ""}`
    : "撤销";

  const submit = useCallback(async () => {
    const q = text.trim();
    if (!q || running) return;
    setRunning(true);
    setLast(null);
    setText("");
    // `makeAgentHost` 的 `say` 就是 toast：`runAgent` 在"没打开项目"、
    // "模型没接上"这些分支里都靠它说话，一个字都不能吞。
    const host = makeAgentHost(p.onToast);
    try {
      const r: AgentRunResult = await runAgent(host, {
        text: q,
        // 🔴 密钥不在客户端：这里只是把请求转给后端代理（见文件头）。
        callModel: async (body) => {
          const resp = await api.agentTurn(body);
          return {
            reply: resp.reply,
            done: resp.done,
            commands: resp.commands ?? [],
            dropped: normalizeDropped(resp.dropped),
          };
        },
        confirm: gate.confirm,
      });
      const line = runStatusLine(r);
      const detail = summarizeRun(r);
      setLast({ turnId: r.turnId, line });
      setLastSummary(detail);
      // `runAgent` 已经在成功/失败各分支里 `say` 过一句了，这里不重复报同一件事，
      // 只在**它没说清的**情况下补一句：撞上限、有被跳过/失败的步骤。
      const skipped = r.steps.filter((s) => !s.ok).length;
      if (r.status === "incomplete") p.onToast(`⚠️ ${line}。可以再说一句让我继续。`, 8000);
      else if (skipped) p.onToast(`⚠️ ${line}，有 ${skipped} 处没做成（见下）`, 8000);
      void detail;
    } catch (e) {
      // `runAgent` 声明不抛，但 host 的编程错误会抛到这里；不接住的话
      // 用户看到的是"点了没反应 + 控制台一条红字"。
      const msg = e instanceof Error ? e.message : String(e);
      p.onToast(`AI 这一轮出错了：${msg}`, 8000);
      setLast({ turnId: null, line: "出错" });
    } finally {
      gate.abort();      // 收尾：挂起的询问按"取消"结掉，不留死条
      setRunning(false);
    }
  }, [text, running, p, gate]);

  const undoThisTurn = useCallback(() => {
    const top = useTimelineStore.getState().undoStack;
    const entry = top[top.length - 1];
    if (!turnIsOnTop(entry && entry.origin.by === "agent" ? entry.origin.turnId : null, last?.turnId ?? null)) {
      // 栈顶已经不是 AI 那一轮了（用户中间自己撤销/重做过）—— 说清楚，
      // 不要"撤一个别的什么"然后让用户以为撤的是 AI。
      p.onToast("AI 那一轮已经不在撤销栈顶了，用顶栏的撤销按钮逐步退");
      return;
    }
    void useTimelineStore.getState().undo();
    setLast(null);
    setLastSummary("");
  }, [last, p]);

  if (!p.enabled) return null;

  return (
    <div className={`fw-agbar ${open ? "open" : ""}`}>
      {open && (
        <div className="fw-agbar-panel" onKeyDown={(e) => {
          // Esc 关面板（输入框里也一样）。不 stopPropagation：外层没有别的手势
          if (e.key === "Escape") { setOpen(false); }
        }}>
          <div className="fw-agbar-head">
            <Sparkles size={14} />
            <span>AI 改片</span>
            <button className="fw-agbar-x" title="关闭" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>

          {/* 确认条：能力表里写好的代价**原样**显示（`confirmText`），
              不换成"确认吗？"—— 那句话在能力表里是对每个能力逐条写死的。 */}
          {pending && (
            <div className="fw-agbar-confirm">
              <div className="fw-agbar-confirm-t"><AlertTriangle size={13} /> 这一步要你点头</div>
              <div className="fw-agbar-confirm-c">{pending.confirmText}</div>
              {pending.summary && (
                <div className="fw-agbar-confirm-s">{pending.summary}</div>
              )}
              <div className="fw-agbar-confirm-b">
                <button className="fw-agbar-ok" onClick={() => gate.answer(true)}>执行</button>
                <button className="fw-agbar-no" onClick={() => gate.answer(false)}>跳过</button>
              </div>
            </div>
          )}

          <textarea
            className="fw-agbar-input"
            rows={2}
            placeholder="说一句要改什么，例如「把第 3 场的镜头按节奏重排」"
            value={text}
            disabled={running}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter 提交、Shift+Enter 换行 —— 与这个项目其它输入框一致
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
            }}
          />
          <div className="fw-agbar-foot">
            <button className="fw-agbar-run" disabled={running || !text.trim()}
              onClick={() => { void submit(); }}>
              {running ? <><Loader2 size={13} className="fw-spin" /> 正在改…</> : "让 AI 改"}
            </button>
            {last && last.turnId && (
              <button className="fw-agbar-undo" title={hint} onClick={undoThisTurn}>
                撤销这一轮
              </button>
            )}
            {last && <span className="fw-agbar-line">{last.line}</span>}
          </div>

          {/* 用户随时能看到"撤销栈里有没有 AI 的账"。这个数不是为了好看：
              AI 改完而栈没动，正是 2.5.1 描述的那种"绕过命令层"的失效长相。 */}
          <div className="fw-agbar-note">
            改动走同一个撤销栈（栈内 {undoCount} 条）· 模型调用经服务器代理，客户端不含密钥
          </div>
        </div>
      )}

      <button className={`fw-agbar-fab ${open ? "on" : ""}`}
        title="AI 改片（读时间轴、下指令，改动能一次撤销）"
        onClick={() => setOpen((v) => !v)}>
        <Sparkles size={15} />
      </button>
    </div>
  );
}
