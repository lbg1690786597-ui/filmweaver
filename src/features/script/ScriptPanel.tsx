/**
 * ScriptPanel — 剧本面板（PLAN §6，Phase 4）
 *
 * 从旧 LibraryPanel 的「剧本」页签抽出，逻辑保持一致：
 *   导入（文件 / 粘贴）→ 弹窗确认分集 → 按集文本框直接编辑 → 失焦保存
 *
 * 改进：
 *  - 分集折叠 + 集内字数/镜头数/过期标识（原版全部展开，20 集时要滚很久）
 *  - 剧本优化入口（后端 /script/optimize 一直有，旧 UI 没暴露）
 *  - 保存状态与「N 个镜头已过期」提示就地显示，不再只靠 toast 一闪而过
 */

import { useEffect, useRef, useState } from "react";
import {
  FileUp, ChevronDown, ChevronRight, Loader2, Wand2,
  AlertTriangle, Check, Scissors,
} from "lucide-react";
import { api } from "../../api";
import type { EpisodeInfo, ShotInfo } from "../../api";
import AutoTextarea from "../../components/AutoTextarea";
import "./ScriptPanel.css";

interface EpContent { order: number; title: string; content: string }

interface Props {
  projectId: string;
  episodes: EpisodeInfo[];
  shots: ShotInfo[];
  breakdownProgress: number | null;
  onBreakdown: (episodes?: number[]) => void;
  onRefresh: () => void;
  onToast: (m: string) => void;
}

export default function ScriptPanel(p: Props) {
  const [eps, setEps] = useState<EpContent[]>([]);
  const [draft, setDraft] = useState<{ text: string; episodes: EpisodeInfo[] } | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [savingEp, setSavingEp] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [optimizing, setOptimizing] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [paste, setPaste] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const r = await api.episodesContent(p.projectId);
      setEps(r.episodes);
      // 只有一集时默认展开——多集全展开会把面板撑得没法用
      if (r.episodes.length === 1) setOpen(new Set([r.episodes[0].order]));
    } catch { /* 无剧本时静默 */ }
  };
  useEffect(() => { void load(); }, [p.projectId, p.episodes.length]);

  const doParse = async (text: string) => {
    setBusy(true); setErr("");
    try {
      const r = await api.importScript(text);
      setDraft({ text, episodes: r.episodes });
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doParseFile = async (f: File) => {
    setBusy(true); setErr("");
    try {
      const r = await api.importScriptFile(f);
      setDraft({ text: r.text, episodes: r.episodes });
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doConfirm = async () => {
    if (!draft) return;
    setBusy(true); setErr("");
    try {
      await api.importScript(draft.text, p.projectId, true);
      setDraft(null); setPaste("");
      p.onRefresh();
      await load();
      p.onToast(`✅ 已导入 ${draft.episodes.length} 集，可在「AI 分镜」拆解`);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const saveEp = async (order: number, content: string) => {
    setSavingEp(order);
    try {
      const r = await api.updateEpisodeContent(p.projectId, order, content);
      p.onRefresh();
      p.onToast(r.stale_shots > 0
        ? `第 ${order} 集已保存，${r.stale_shots} 个镜头标记为过期（需重拆）`
        : `第 ${order} 集已保存`);
      await load();
    } catch (e) { p.onToast(String(e)); }
    finally { setSavingEp(null); }
  };

  /** AI 优化：后端 /script/optimize 只做「文本进、文本出」，不落库，
   *  所以要自己把结果写回该集（走 updateEpisodeContent）。
   *  按集做而不是整本做：整本优化一次要等很久，且失败就全白等。 */
  const doOptimize = async (ep: EpContent) => {
    setOptimizing(ep.order);
    try {
      const r = await api.optimizeScript(ep.content, undefined, p.projectId);
      if (!r.optimized?.trim()) { p.onToast("优化返回为空，已保留原文"); return; }
      await api.updateEpisodeContent(p.projectId, ep.order, r.optimized);
      p.onRefresh();
      await load();
      p.onToast(`✨ 第 ${ep.order} 集已优化并保存`);
    } catch (e) { p.onToast(String(e)); }
    finally { setOptimizing(null); }
  };

  /** 每集的镜头统计（拆了几个、几个过期）——决定是否需要重拆 */
  const epStat = (order: number) => {
    const list = p.shots.filter((s) => s.episode === order);
    return { total: list.length, stale: list.filter((s) => s.stale).length };
  };

  const toggle = (order: number) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(order) ? n.delete(order) : n.add(order);
      return n;
    });

  return (
    <div className="fw-script">
      {/* 导入区 */}
      <div className="fw-script-import">
        <button className="fw-script-btn primary" disabled={busy}
          onClick={() => fileRef.current?.click()}
          title="支持 txt / md / docx / pdf（.doc 请先转存为 .docx）">
          {busy ? <><Loader2 size={13} className="fw-spin" /> 解析中…</>
            : <><FileUp size={13} /> {eps.length ? "重新导入剧本" : "导入剧本"}</>}
        </button>
        <input ref={fileRef} type="file" accept=".txt,.md,.docx,.pdf,.doc" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void doParseFile(f); e.target.value = ""; }} />
      </div>

      {/* 无剧本时提供粘贴入口 */}
      {eps.length === 0 && (
        <div className="fw-script-paste">
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)}
            placeholder="或直接粘贴剧本文本（支持「第N集 / 第N章」分集标注）…"
            rows={6} spellCheck={false} />
          <button className="fw-script-btn" disabled={busy || !paste.trim()}
            onClick={() => doParse(paste)}>
            <Scissors size={13} /> 解析粘贴内容
          </button>
        </div>
      )}

      {err && <div className="fw-script-err"><AlertTriangle size={12} /> {err}</div>}

      {/* 分集列表 */}
      {eps.length > 0 && (
        <div className="fw-script-eps">
          <div className="fw-script-sec">
            共 {eps.length} 集 · {eps.reduce((a, e) => a + e.content.length, 0).toLocaleString()} 字
          </div>
          {eps.map((ep) => {
            const st = epStat(ep.order);
            const isOpen = open.has(ep.order);
            return (
              <div key={ep.order} className={`fw-script-ep ${isOpen ? "open" : ""}`}>
                <button className="fw-script-ep-head" onClick={() => toggle(ep.order)}>
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="fw-script-ep-title">{ep.title}</span>
                  {st.stale > 0 && (
                    <span className="fw-script-chip warn" title={`${st.stale} 个镜头因剧本修改已过期`}>
                      <AlertTriangle size={9} /> {st.stale}
                    </span>
                  )}
                  {st.total > 0 && (
                    <span className="fw-script-chip" title={`已拆 ${st.total} 个镜头`}>
                      {st.total} 镜
                    </span>
                  )}
                  <span className="fw-script-ep-len">
                    {savingEp === ep.order
                      ? <><Loader2 size={9} className="fw-spin" /> 保存中</>
                      : `${ep.content.length} 字`}
                  </span>
                </button>

                {isOpen && (
                  <div className="fw-script-ep-body">
                    {/* key 绑定内容：defaultValue 只在**挂载时**读一次，
                        不换 key 的话，AI 优化后 ep.content 已经是新文本，
                        框里却还显示旧文 —— 用户点开别处触发 onBlur，
                        旧文与新 ep.content 不一致，于是**旧文被存回去**，
                        优化结果静默丢失。换 key 强制重挂载即可重读。
                        （保持非受控是有意的：受控会在每次按键都重渲整列。） */}
                    <AutoTextarea key={`ep${ep.order}:${ep.content}`}
                      className="fw-script-ta" minHeight={140} maxHeight={400}
                      defaultValue={ep.content}
                      onBlur={(e) => {
                        if (e.target.value.trim() !== ep.content.trim())
                          void saveEp(ep.order, e.target.value);
                      }} />
                    <div className="fw-script-ep-acts">
                      <span className="fw-script-hint">失焦即自动保存</span>
                      <button className="fw-script-mini" disabled={optimizing === ep.order}
                        onClick={() => void doOptimize(ep)}
                        title="AI 润色本集文本并保存（会覆盖当前内容）">
                        {optimizing === ep.order
                          ? <><Loader2 size={11} className="fw-spin" /> 优化中</>
                          : <><Wand2 size={11} /> AI 优化</>}
                      </button>
                      <button className="fw-script-mini"
                        disabled={p.breakdownProgress !== null}
                        onClick={() => p.onBreakdown([ep.order])}
                        title="只拆解本集（已拆过会覆盖）">
                        <Scissors size={11} /> 拆解本集
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <button className="fw-script-btn primary wide"
            disabled={p.breakdownProgress !== null}
            onClick={() => p.onBreakdown()}>
            {p.breakdownProgress !== null
              ? <><Loader2 size={13} className="fw-spin" /> 拆解中 {p.breakdownProgress}%</>
              : <><Scissors size={13} /> 拆解全部剧本为镜头</>}
          </button>
        </div>
      )}

      {/* 分集确认弹窗 */}
      {draft && (
        <div className="fw-script-mask" onClick={() => setDraft(null)}>
          <div className="fw-script-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>确认分集（{draft.episodes.length} 集）</h3>
            <div className="fw-script-draft-list">
              {draft.episodes.map((ep) => (
                <div key={ep.order} className="fw-script-draft-row">
                  <span className="fw-script-draft-no">{ep.order}</span>
                  <span className="fw-script-draft-title">{ep.title}</span>
                  <span className="fw-script-draft-wc">{ep.word_count} 字</span>
                </div>
              ))}
            </div>
            <p className="fw-script-hint">确认后剧本按集展示，可直接在文本框中修改</p>
            <div className="fw-script-dialog-acts">
              <button className="fw-script-btn" onClick={() => setDraft(null)}>取消</button>
              <button className="fw-script-btn primary" disabled={busy} onClick={doConfirm}>
                {busy ? <><Loader2 size={13} className="fw-spin" /> 保存中…</>
                  : <><Check size={13} /> 确认导入</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
