/**
 * UndoHistoryPanel — 「我刚才做了什么」（C3）
 *
 * ## 为什么这个面板是"普通人使用逻辑"里最被低估的一条
 *
 * 撤销栈在这之前是**完全不可见的**：50 步的栈，用户只知道"还能撤"，
 * 不知道"撤到哪儿会回到什么状态"。普通人不知道 50 步是什么概念，
 * 但他知道自己刚才做错了什么。把不可见的栈变成可读的列表，
 * 是从"专业人士的工具"变成"普通人的工具"的关键一步（PLAN §3.2）。
 *
 * ## 三条设计决定
 *
 * 1. **点任意一条 = 撤到那一条之前**，所以每行右边写着"此处还要退几步"式
 *    的提示由 `steps` 决定。不提供"只撤这一条、保留它上面的" —— 那在
 *    时间轴编辑里是**不可实现的语义**：后面的操作大多建立在这一条的结果上
 *    （改的是同一批镜头），单独撤中间一条会得到一个任何时刻都不存在的状态。
 *
 * 2. **不做"跳完自动关面板"**。用户常会连点几下找"到底哪一步是我要的"，
 *    关掉再打开的成本比让他自己按 Esc 高得多。关面板的方式有三种：Esc、
 *    点面板外、再点一次顶栏按钮。
 *
 * 3. **时间用相对描述**（"3 分钟前"），且**不做定时刷新**。分钟级精度下，
 *    只有停留在面板上超过一分钟才可能看到过期值 —— 而每次打开都重算，
 *    为它挂一个 interval 让整个列表每分钟重渲一次不划算。
 */

import { useEffect, useMemo, useState } from "react";
import { Undo2, Redo2, History, Lock } from "lucide-react";
import { useTimelineStore } from "../../stores/timelineStore";
import { KIND_LABEL } from "../../lib/command";
import { historyRows, redoRows } from "./undoHistory";
import "./UndoHistoryPanel.css";

interface Props {
  /** 点一条记录：`steps` = 要连撤几步（恒 ≥ 1） */
  onJump: (steps: number) => void;
  /** 点"已撤销"里的最上面那条 = 重做一步。
   *  刻意**不复用 onJump 传负数当哨兵**：哨兵值会让调用方被迫写
   *  `if (steps < 0)` 分支，而"重做"和"撤销 N 步"本来就是两件事。 */
  onRedo: () => void;
  onToast: (m: string) => void;
}

export default function UndoHistoryPanel({ onJump, onRedo, onToast }: Props) {
  // 选择器返回的是**引用会变的数组**（store 每次入栈都 slice 出新数组），
  // 但只有面板开着时才订阅 —— 见下面 open 的判断。这是本面板敢直接订阅
  // 整个栈的原因：平时它不渲染，也就不订阅。
  const undoStack = useTimelineStore((s) => s.undoStack);
  const redoStack = useTimelineStore((s) => s.redoStack);
  const [open, setOpen] = useState(false);

  // Esc 关闭。挂 window 而不是面板上，因为焦点不一定在面板里
  // （用户可能刚点完顶栏按钮）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener("keydown", onKey, true);  // 捕获期：抢在全局快捷键前
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // 「刚才」在打开的那一刻算一次。用 useMemo 依赖 open：重开时重算，
  // 停留期间不重算（理由见文件头第 3 条）。
  const view = useMemo(() => {
    void open;                       // 只是想让它随 open 重算
    const { rows, hidden } = historyRows(undoStack);
    return { rows, hidden, redo: redoRows(redoStack) };
  }, [undoStack, redoStack, open]);

  const total = undoStack.length + redoStack.length;

  return (
    <div className="fw-uh">
      <button
        className={`fw-tb-icon fw-uh-trigger ${open ? "on" : ""}`}
        title="操作历史"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <History size={16} />
      </button>

      {open && (
        <>
          {/* 遮罩只负责"点外面关闭"。不用 document click 监听是为了避免
              与触发按钮自己的 onClick 打架（点按钮 → 关闭 → 又被 click
              监听到再开一次，表现为"点不开"）。 */}
          <div className="fw-uh-mask" onClick={() => setOpen(false)} />
          <div className="fw-uh-pop" role="dialog" aria-label="操作历史">
            <div className="fw-uh-head">
              <span>操作历史</span>
              <span className="fw-uh-count">
                {total === 0 ? "还没有操作" : `可撤销 ${undoStack.length} · 可重做 ${redoStack.length}`}
              </span>
            </div>

            <div className="fw-uh-body">
              {total === 0 && (
                <div className="fw-uh-empty">
                  做点改动（拖一下镜头、调一下画面）就会出现在这里。
                </div>
              )}

              {/* ---- 可重做的排在**上面**：它们表示"接下来会发生什么" ---- */}
              {view.redo.length > 0 && (
                <>
                  <div className="fw-uh-sep">已撤销，可以重做</div>
                  {view.redo.map((r, i) => (
                    <HistoryItem key={r.cmd.id} row={r} redo
                      // 只有最上面那条真能点（其余 steps > 1），命中"不能点"时
                      // 说明原因而不是静默无响应 —— 见下面 onClick。
                      dim={i !== 0}
                      onClick={() => {
                        // 重做的语义相反：要连做 `r.steps` 步才轮到这一条生效。
                        // 只支持"重做一步"，故其余给出说明而不是点了没反应。
                        if (r.steps !== 1) {
                          onToast("要从最近的一条开始重做，一步步来");
                          return;
                        }
                        onRedo();
                      }} />
                  ))}
                  <div className="fw-uh-sep">────────</div>
                </>
              )}

              {/* ---- 可撤销的：**最近的在最上面**（`historyRows` 已倒序） ---- */}
              {view.rows.map((r, i) => (
                <HistoryItem key={r.cmd.id} row={r} current={i === 0}
                  onClick={() => onJump(r.steps)} />
              ))}

              {view.hidden > 0 && (
                <div className="fw-uh-more">还有 {view.hidden} 步更早的操作</div>
              )}
            </div>

            <div className="fw-uh-foot">
              点一条记录会撤销它<strong>和它之后的全部</strong>操作。
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function HistoryItem(
  { row, current, redo, dim, onClick }:
  { row: { cmd: { label: string; kind: string; reversible: boolean }; ago: string; steps: number };
    current?: boolean; redo?: boolean; dim?: boolean; onClick: () => void },
) {
  const { cmd, ago, steps } = row;
  return (
    <button className={`fw-uh-item ${current ? "cur" : ""} ${redo ? "redo" : ""} ${dim ? "dim" : ""}`}
      onClick={onClick}>
      <span className="fw-uh-ico">
        {redo ? <Redo2 size={12} /> : <Undo2 size={12} />}
      </span>
      <span className="fw-uh-label" title={cmd.label}>{cmd.label}</span>
      {!cmd.reversible && (
        // ⚠️ 不可重做的命令**在列表里就要标出来**：不标的话用户按了 Ctrl+Z 撤掉它，
        // 然后发现重做按钮灰着，会以为是 bug（见 lib/command.ts 的 "尺子" 一节）。
        <span className="fw-uh-lock" title="这一步不能重做">
          <Lock size={10} />
        </span>
      )}
      <span className="fw-uh-kind">{KIND_LABEL[cmd.kind as keyof typeof KIND_LABEL] ?? "其他"}</span>
      <span className="fw-uh-ago">{ago}</span>
      <span className="fw-uh-steps">{redo ? (steps === 1 ? "重做" : `${steps}`) : (steps === 1 ? "撤销" : `退 ${steps} 步`)}</span>
    </button>
  );
}
