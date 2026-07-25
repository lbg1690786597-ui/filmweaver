import { useRef, useState } from "react";
import { api } from "../api";
import { LibClip, clipKind, fmtTime, probeDuration } from "../types";

interface Props {
  clips: LibClip[];
  onAddClips: (clips: LibClip[]) => void;      // 上传完成加入素材库
  onAddToTimeline: (clip: LibClip) => void;    // ＋加入时间轴
  onPreview: (clip: LibClip) => void;          // 单击素材 → 右侧预览
  assets: { name: string; url: string }[];     // AI 生成的资产图
  script: { raw: string; optimized: string };
  onOpenAi: (tab: "script" | "breakdown" | "assets") => void;
}

type Tab = "media" | "assets" | "script";

/** 左侧素材库：本地素材 / AI 资产 / 剧本 */
export default function LibraryPanel(p: Props) {
  const [tab, setTab] = useState<Tab>("media");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const importFiles = async (files: FileList) => {
    setUploading(true); setErr("");
    try {
      const added: LibClip[] = [];
      for (const f of Array.from(files)) {
        const r = await api.uploadMedia(f);
        const kind = clipKind(r.name);
        const duration = await probeDuration(api.mediaUrl(r.url), kind);
        added.push({ id: r.file_id, name: r.name, url: r.url, size: r.size, kind, duration });
      }
      p.onAddClips(added);
    } catch (e) { setErr(String(e)); }
    finally { setUploading(false); }
  };

  return (
    <aside className="lib">
      <div className="lib-tabs">
        <button className={tab === "media" ? "on" : ""} onClick={() => setTab("media")}>📂 素材</button>
        <button className={tab === "assets" ? "on" : ""} onClick={() => setTab("assets")}>🖼 资产</button>
        <button className={tab === "script" ? "on" : ""} onClick={() => setTab("script")}>📝 剧本</button>
      </div>

      {tab === "media" && (
        <div className="lib-body">
          <button className="btn primary wide" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? "上传中…" : "＋ 导入素材"}
          </button>
          <input ref={fileRef} type="file" multiple hidden
            accept=".mp4,.mov,.mkv,.webm,.mp3,.wav,.aac,.m4a,.png,.jpg,.jpeg,.webp,.srt"
            onChange={(e) => e.target.files && importFiles(e.target.files)} />
          {err && <div className="err">{err}</div>}
          <div className="lib-grid">
            {p.clips.map((c) => (
              <div key={c.id} className="lib-card" onClick={() => p.onPreview(c)} title={c.name}>
                {c.kind === "video" ? (
                  <video src={api.mediaUrl(c.url)} muted preload="metadata" />
                ) : c.kind === "image" ? (
                  <img src={api.mediaUrl(c.url)} alt={c.name} />
                ) : (
                  <div className="lib-audio">🎵</div>
                )}
                {c.duration > 0 && <span className="lib-dur">{fmtTime(c.duration)}</span>}
                <button className="lib-add" title="加入时间轴"
                  onClick={(e) => { e.stopPropagation(); p.onAddToTimeline(c); }}>＋</button>
                <div className="lib-name">{c.name}</div>
              </div>
            ))}
            {!p.clips.length && !uploading && <div className="muted pad">还没有素材，点上方导入</div>}
          </div>
        </div>
      )}

      {tab === "assets" && (
        <div className="lib-body">
          <button className="btn primary wide" onClick={() => p.onOpenAi("assets")}>✨ AI 生成资产</button>
          <div className="lib-grid">
            {p.assets.map((a) => (
              <div key={a.name} className="lib-card" title={a.name}>
                <img src={a.url} alt={a.name} />
                <div className="lib-name">{a.name}</div>
              </div>
            ))}
            {!p.assets.length && <div className="muted pad">先在 AI 面板做镜头拆解，再批量生成角色/场景图</div>}
          </div>
        </div>
      )}

      {tab === "script" && (
        <div className="lib-body">
          <button className="btn primary wide" onClick={() => p.onOpenAi("script")}>✨ AI 剧本工作台</button>
          <div className="script-preview">
            {(p.script.optimized || p.script.raw)
              ? <pre>{(p.script.optimized || p.script.raw).slice(0, 3000)}</pre>
              : <div className="muted pad">还没有剧本，点上方打开 AI 剧本工作台导入</div>}
          </div>
        </div>
      )}
    </aside>
  );
}