/**
 * TextPanel — 文本 / 字幕（PLAN §5.3，Phase 3）
 *
 * TB-02 已落地：字幕条目落库到 subtitle_clips，导出时后端生成 SRT 供烧录。
 * 样式预设随字幕一起以 JSON 存 style 字段。
 */

import { useEffect, useState } from "react";
import { Type, Plus, Trash2, Wand2, Loader2 } from "lucide-react";
import { api } from "../../api";
import type { SubtitleClipInfo } from "../../api";
import "./TextPanel.css";

/** 字幕样式预设（后端 TB-02 落库时直接存这个结构） */
export interface SubtitleStyle {
  id: string;
  name: string;
  fontSize: number;
  color: string;
  stroke: string;
  strokeWidth: number;
  bg: string;
  bold: boolean;
  position: "bottom" | "top" | "center";
}

const PRESETS: SubtitleStyle[] = [
  { id: "default", name: "默认", fontSize: 42, color: "#ffffff", stroke: "#000000", strokeWidth: 3, bg: "transparent", bold: true, position: "bottom" },
  { id: "drama", name: "短剧标准", fontSize: 48, color: "#ffffff", stroke: "#000000", strokeWidth: 4, bg: "transparent", bold: true, position: "bottom" },
  { id: "yellow", name: "黄字描边", fontSize: 46, color: "#ffe14d", stroke: "#000000", strokeWidth: 4, bg: "transparent", bold: true, position: "bottom" },
  { id: "boxed", name: "半透底框", fontSize: 40, color: "#ffffff", stroke: "transparent", strokeWidth: 0, bg: "rgba(0,0,0,0.55)", bold: false, position: "bottom" },
  { id: "title", name: "标题大字", fontSize: 72, color: "#ffffff", stroke: "#000000", strokeWidth: 5, bg: "transparent", bold: true, position: "center" },
  { id: "narration", name: "旁白顶部", fontSize: 36, color: "#e8e8e8", stroke: "#000000", strokeWidth: 2, bg: "transparent", bold: false, position: "top" },
];

interface Props {
  projectId: string;
  hasSelection: boolean;
  /** 播放头所在镜头（字幕锚定镜头 order + 镜内偏移，与后端同构） */
  anchor: { order: number; offsetSec: number } | null;
  /** TB-08：提交语音识别 job */
  onAutoSubtitles: () => Promise<void>;
  /** 增删改后通知外层刷新（时间轴字幕轨与本面板共用同一份数据） */
  onChanged: () => void;
  onToast: (m: string) => void;
}

export default function TextPanel(p: Props) {
  const [tab, setTab] = useState<"text" | "style">("text");
  const [items, setItems] = useState<SubtitleClipInfo[]>([]);
  const [styleId, setStyleId] = useState("drama");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [asrOk, setAsrOk] = useState(false);
  const [asrBusy, setAsrBusy] = useState(false);

  useEffect(() => {
    api.asrStatus().then((r) => setAsrOk(r.available)).catch(() => setAsrOk(false));
  }, []);

  const load = async () => {
    try {
      const r = await api.listSubtitleClips(p.projectId);
      setItems(r.clips);
    } catch { /* 无字幕时静默 */ }
  };

  /** 增删改之后：本面板重拉 + 通知外层刷新时间轴字幕轨。
   *  不放进 load() 里——load 会在 useEffect 里跑，那样会形成
   *  onChanged → 外层刷新 → 重渲染 → load → onChanged 的死循环。 */
  const reloadAll = async () => {
    await load();
    p.onChanged();
  };
  useEffect(() => { void load(); }, [p.projectId]);

  const addText = async () => {
    if (!draft.trim()) { p.onToast("请先输入文字内容"); return; }
    const st = PRESETS.find((x) => x.id === styleId) ?? PRESETS[0];
    setBusy(true);
    try {
      await api.createSubtitleClip({
        project_id: p.projectId,
        text: draft.trim(),
        kind: st.position === "center" ? "title" : "subtitle",
        start_shot_order: p.anchor?.order ?? 1,
        start_offset_sec: p.anchor?.offsetSec ?? 0,
        duration: 3,
        style: { ...st },
      });
      setDraft("");
      await reloadAll();
      p.onToast(`已添加字幕（锚定镜头 #${p.anchor?.order ?? 1}）`);
    } catch (e) { p.onToast(String(e)); }
    finally { setBusy(false); }
  };

  const removeItem = async (id: string) => {
    try {
      await api.deleteSubtitleClip(id);
      await reloadAll();
    } catch (e) { p.onToast(String(e)); }
  };

  const style = PRESETS.find((s) => s.id === styleId) ?? PRESETS[0];

  return (
    <div className="fw-text">
      <div className="fw-text-tabs">
        <button className={tab === "text" ? "on" : ""} onClick={() => setTab("text")}>
          <Type size={12} /> 文本
        </button>
        <button className={tab === "style" ? "on" : ""} onClick={() => setTab("style")}>
          样式
        </button>
      </div>

      <div className="fw-text-body">
        {tab === "text" && (
          <>
            <div className="fw-text-compose">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                placeholder="输入字幕 / 标题文字…" rows={3} spellCheck={false} />
              <div className="fw-text-compose-acts">
                <span className="fw-text-at">
                  {p.anchor
                    ? `锚定镜头 #${p.anchor.order} 第 ${p.anchor.offsetSec.toFixed(1)}s`
                    : "锚定第 1 个镜头"}
                </span>
                <button className="primary" disabled={busy} onClick={() => void addText()}>
                  {busy ? <Loader2 size={12} className="fw-spin" /> : <Plus size={12} />} 添加
                </button>
              </div>
            </div>

            <div className="fw-text-sec">自动字幕</div>
            <button className="fw-text-auto" disabled={!asrOk || asrBusy}
              title={asrOk
                ? "对已合成的 AI 旁白做语音识别，按时间戳生成字幕"
                : "未配置语音识别通道"}
              onClick={async () => {
                setAsrBusy(true);
                try {
                  await p.onAutoSubtitles();
                  // job 是异步的，给后端一点时间落库再刷新列表
                  setTimeout(() => void reloadAll(), 3000);
                } finally { setAsrBusy(false); }
              }}>
              {asrBusy ? <Loader2 size={12} className="fw-spin" /> : <Wand2 size={12} />}
              从旁白自动生成字幕
              {!asrOk && <span className="fw-text-todo">未配置</span>}
            </button>

            {items.length > 0 && (
              <>
                <div className="fw-text-sec">已添加（{items.length}）</div>
                <div className="fw-text-list">
                  {items.map((it) => {
                    const st = (it.style ?? {}) as Partial<SubtitleStyle>;
                    return (
                      <div key={it.id} className="fw-text-row">
                        <span className="fw-text-row-preview" style={{
                          color: st.color ?? "#fff",
                          fontWeight: st.bold ? 700 : 400,
                          background: st.bg ?? "transparent",
                          WebkitTextStroke: st.strokeWidth
                            ? `${Math.min(2, st.strokeWidth / 2)}px ${st.stroke ?? "#000"}` : undefined,
                        }}>{it.text}</span>
                        <span className="fw-text-row-meta">
                          #{it.start_shot_order} · {it.duration}s
                        </span>
                        <button className="danger" title="删除"
                          onClick={() => void removeItem(it.id)}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {tab === "style" && (
          <>
            <div className="fw-text-sec">字幕样式预设</div>
            <div className="fw-text-presets">
              {PRESETS.map((s) => (
                <button key={s.id}
                  className={`fw-text-preset ${styleId === s.id ? "on" : ""}`}
                  onClick={() => setStyleId(s.id)}>
                  <span className="fw-text-preset-demo" style={{
                    fontSize: Math.max(11, s.fontSize / 4),
                    color: s.color,
                    fontWeight: s.bold ? 700 : 400,
                    background: s.bg,
                    WebkitTextStroke: s.strokeWidth
                      ? `${Math.min(1.5, s.strokeWidth / 3)}px ${s.stroke}` : undefined,
                    alignItems: s.position === "top" ? "flex-start"
                      : s.position === "center" ? "center" : "flex-end",
                  }}>示例字幕</span>
                  <span className="fw-text-preset-name">{s.name}</span>
                </button>
              ))}
            </div>

            <div className="fw-text-sec">当前样式参数</div>
            <div className="fw-text-params">
              <Param k="字号" v={`${style.fontSize}px`} />
              <Param k="颜色" v={<span className="fw-text-swatch" style={{ background: style.color }} />} />
              <Param k="描边" v={style.strokeWidth ? `${style.strokeWidth}px ${style.stroke}` : "无"} />
              <Param k="加粗" v={style.bold ? "是" : "否"} />
              <Param k="位置" v={{ bottom: "底部", top: "顶部", center: "居中" }[style.position]} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Param({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="fw-text-param">
      <span>{k}</span><span>{v}</span>
    </div>
  );
}
