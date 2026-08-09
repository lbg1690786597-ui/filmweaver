import { useState } from "react";
import { api, AudioClipInfo, ShotInfo } from "../api";
import AutoTextarea from "./AutoTextarea";
import { LibClip } from "../types";
import { ShotRects } from "./CharacterTrack";

interface Props {
  clips: AudioClipInfo[];
  ttsAvailable: boolean;
  onToast: (m: string) => void;
  shotRects: ShotRects;
  totalW: number;
  shots: ShotInfo[];
  projectId: string;
  onChanged: () => void;          // 段增删改后刷新
  onSynth: (clipIds?: string[]) => void;  // 提交 TTS 合成 job
  synthBusy: boolean;
  /** 素材池音频/视频（选参考音色、配乐源） */
  libClips: LibClip[];
  onPreview: (url: string, label: string) => void;
}

/** P2-4 音频轨：TTS 旁白 / 配乐段落。
 *  段位置 = 锚定镜头槽 x + 镜内偏移比例；宽度 = duration×pxPerSec（经 shotRects 换算）。
 *  ➕ 弹窗新建旁白（文本+锚点+参考音色），段可拖动换锚镜头、点击试听、✏ 改文本、🗑 删。 */
export default function AudioTrack(p: Props) {
  const [editing, setEditing] = useState<AudioClipInfo | "new" | null>(null);
  const [text, setText] = useState("");
  const [anchor, setAnchor] = useState(1);
  const [refUrl, setRefUrl] = useState("");
  const [dragClip, setDragClip] = useState<string | null>(null);
  const [dragOverOrder, setDragOverOrder] = useState<number | null>(null);

  const orderToShot = new Map(p.shots.map((s) => [s.order, s]));
  /** 秒→像素比例：用锚定镜头槽自身的 宽/时长 推（与镜头轨同缩放） */
  const pxPerSecAt = (order: number): number => {
    const r = p.shotRects.get(order);
    const s = orderToShot.get(order);
    if (!r || !s) return 12;
    return r.w / Math.max(0.01, s.duration_sec ?? 5);
  };
  const clipX = (c: AudioClipInfo): number | null => {
    const r = p.shotRects.get(c.start_shot_order);
    if (!r) return null;
    return r.x + Math.min(1, c.start_offset_sec
      / Math.max(0.01, orderToShot.get(c.start_shot_order)?.duration_sec ?? 5)) * r.w;
  };

  const voiceCandidates = p.libClips.filter((c) => c.kind === "audio" || c.kind === "video");
  const musicCandidates = p.libClips.filter((c) => c.kind === "audio");

  const openNew = () => {
    setText("");
    setAnchor(p.shots[0]?.order ?? 1);
    setRefUrl(voiceCandidates[0]?.url ?? "");
    setEditing("new");
  };

  const submitNew = async () => {
    if (!text.trim()) { p.onToast("旁白文本不能为空"); return; }
    if (!refUrl) { p.onToast("请选择参考音色（先在素材池上传一段人声音频）"); return; }
    try {
      await api.createAudioClip({
        projectId: p.projectId, kind: "tts", text: text.trim(),
        startShotOrder: anchor, voiceRefUrl: refUrl,
      });
      setEditing(null);
      p.onToast("已添加旁白段，点 🔊 合成");
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  const addMusic = async (lc: LibClip) => {
    try {
      await api.createAudioClip({
        projectId: p.projectId, kind: "music", url: lc.url,
        duration: lc.duration, startShotOrder: p.shots[0]?.order ?? 1,
      });
      p.onToast(`已添加配乐「${lc.name}」`);
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  const saveText = async (c: AudioClipInfo, newText: string) => {
    if (!newText.trim() || newText === c.text) { setEditing(null); return; }
    try {
      await api.patchAudioClip(c.id, { text: newText.trim() });
      setEditing(null);
      p.onToast("文本已改，需重新合成（🔊）");
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  const remove = async (c: AudioClipInfo) => {
    try {
      await api.deleteAudioClip(c.id);
      p.onToast("已删除音频段");
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  /** 拖段换锚镜头（松手落库；offset 归零简化交互） */
  const onDropTo = async (order: number) => {
    const cid = dragClip;
    setDragClip(null);
    setDragOverOrder(null);
    if (!cid) return;
    try {
      await api.patchAudioClip(cid, { startShotOrder: order, startOffsetSec: 0 });
      p.onToast(`已移到镜头 #${order} 起点`);
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  const pendingCount = p.clips.filter(
    (c) => c.kind === "tts" && (c.status === "pending" || c.status === "failed")).length;

  return (
    <section className="atrack" style={{ width: p.totalW || undefined }}>
      {/* 工具条：新建旁白 / 合成 / 加配乐 */}
      <div className="atrack-bar">
        <button className="atrack-btn" title={p.ttsAvailable ? "新建 TTS 旁白段" : "TTS 未配置"}
          disabled={!p.ttsAvailable} onClick={openNew}>＋ 旁白</button>
        {musicCandidates.length > 0 && (
          <select className="atrack-sel" title="从素材池添加配乐" defaultValue=""
            onChange={(e) => {
              const lc = musicCandidates.find((c) => c.url === e.target.value);
              if (lc) void addMusic(lc);
              e.target.value = "";
            }}>
            <option value="" disabled>＋ 配乐…</option>
            {musicCandidates.map((c) => (
              <option key={c.id} value={c.url}>{c.name}</option>
            ))}
          </select>
        )}
        {pendingCount > 0 && (
          <button className="atrack-btn synth" disabled={p.synthBusy}
            title="合成全部待处理旁白（单段约 1 分钟）"
            onClick={() => p.onSynth()}>
            {p.synthBusy ? "⏳ 合成中…" : `🔊 合成 ${pendingCount} 段`}
          </button>
        )}
      </div>

      {/* 段落层：绝对定位于镜头坐标系 */}
      <div className="atrack-lane"
        onDragOver={(e) => {
          if (!dragClip) return;
          e.preventDefault();
          // 悬停位置 → 最近镜头（起点吸附）
          const cx = e.clientX - e.currentTarget.getBoundingClientRect().left;
          let best: number | null = null;
          let bestD = Infinity;
          for (const s of p.shots) {
            const r = p.shotRects.get(s.order);
            if (!r) continue;
            const d = Math.abs(cx - r.x);
            if (d < bestD) { bestD = d; best = s.order; }
          }
          setDragOverOrder(best);
        }}
        onDrop={() => { if (dragOverOrder != null) void onDropTo(dragOverOrder); }}>
        {dragClip && dragOverOrder != null && p.shotRects.get(dragOverOrder) && (
          <div className="atrack-drop-mark"
            style={{ left: p.shotRects.get(dragOverOrder)!.x }} />
        )}
        {p.clips.map((c) => {
          const x = clipX(c);
          if (x == null) return null;
          const w = Math.max(46, (c.duration || 3) * pxPerSecAt(c.start_shot_order));
          const label = c.kind === "music" ? "🎵" : "🎙";
          return (
            <div key={c.id}
              className={`atrack-clip ${c.kind} st-${c.status} ${dragClip === c.id ? "dragging" : ""}`}
              style={{ left: x, width: w }}
              draggable
              onDragStart={() => setDragClip(c.id)}
              onDragEnd={() => { setDragClip(null); setDragOverOrder(null); }}
              title={`${label} ${c.kind === "tts" ? c.text ?? "" : "配乐"}\n`
                + `锚定镜头 #${c.start_shot_order}${c.start_offset_sec ? ` +${c.start_offset_sec.toFixed(1)}s` : ""}`
                + ` · ${c.duration ? `${c.duration.toFixed(1)}s` : "未合成"}\n`
                + `${c.status === "failed" ? `❌ ${c.error ?? "合成失败"}\n` : ""}`
                + `拖动=换锚镜头 · 点击=试听`}
              onClick={() => {
                if (c.url) p.onPreview(c.url, c.kind === "tts" ? `🎙 ${(c.text ?? "").slice(0, 20)}` : "🎵 配乐");
                else p.onToast(c.status === "failed" ? `合成失败：${c.error ?? ""}` : "尚未合成，点 🔊");
              }}>
              <span className="atrack-clip-label">
                {label} {c.kind === "tts" ? (c.text ?? "").slice(0, 24) : "配乐"}
              </span>
              {(c.status === "pending" || c.status === "failed") && (
                <span className={`atrack-clip-st ${c.status}`}>
                  {c.status === "pending" ? "待合成" : "⚠"}
                </span>
              )}
              {c.status === "generating" && <span className="atrack-clip-st">⏳</span>}
              {c.kind === "tts" && (
                <button className="atrack-clip-edit" title="编辑文本"
                  onClick={(e) => { e.stopPropagation(); setEditing(c); setText(c.text ?? ""); }}>✏</button>
              )}
              <button className="atrack-clip-del" title="删除"
                onClick={(e) => { e.stopPropagation(); void remove(c); }}>🗑</button>
            </div>
          );
        })}
        {!p.clips.length && (
          <div className="atrack-empty">＋ 旁白 = AI 语音克隆合成 · ＋ 配乐 = 素材池音频入轨</div>
        )}
      </div>

      {/* 新建/编辑旁白弹窗 */}
      {editing && (
        <div className="drawer-mask" onClick={() => setEditing(null)}>
          <div className="wizard" onClick={(e) => e.stopPropagation()}>
            <h2>{editing === "new" ? "🎙 新建旁白" : "✏ 编辑旁白文本"}</h2>
            <label>旁白文本
              <AutoTextarea className="drawer-ta" minHeight={80} value={text}
                onChange={(e) => setText(e.target.value)} placeholder="要合成的台词/旁白…" />
            </label>
            {editing === "new" && (
              <>
                <div className="row">
                  <label style={{ flex: 1 }}>锚定镜头
                    <select value={anchor} onChange={(e) => setAnchor(Number(e.target.value))}>
                      {p.shots.map((s) => (
                        <option key={s.id} value={s.order}>
                          #{s.order} {(s.is_special ? s.special_name ?? "" : s.script_ref).slice(0, 18)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ flex: 1 }}>参考音色
                    <select value={refUrl} onChange={(e) => setRefUrl(e.target.value)}>
                      {!voiceCandidates.length && <option value="">（素材池无音频，先上传）</option>}
                      {voiceCandidates.map((c) => (
                        <option key={c.id} value={c.url}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  语音克隆：合成音色 = 参考音频里的人声（取前 15 秒）。单段合成约 1 分钟。
                </div>
              </>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setEditing(null)}>取消</button>
              <button className="btn primary"
                onClick={() => (editing === "new" ? submitNew() : saveText(editing, text))}>
                {editing === "new" ? "✅ 添加" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
