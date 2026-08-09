import { useEffect, useRef, useState } from "react";
import { api, ShotInfo } from "../api";
import { localRender, RenderClip } from "../lib/localRender";

interface Props {
  projectId: string;
  baseAspect: string;              // 项目画幅基准（导出默认继承）
  shots: ShotInfo[];               // 已有视频的镜头（按 order）
  onClose: () => void;
  onRegenerate: (shotIds: string[]) => void;   // 回云端重生成（只重视频档）
  onToast: (m: string) => void;
}

interface CutState { inSec: number; durSec?: number }

/** R2-2 精编器 v1（与生产看板分离的精编视图）：
 *  连续预览+播放头 / 入出点裁剪 / srt 字幕编辑 / 版本历史回退 / 回云端重生成 / 本机导出。 */
export default function FineCut(p: Props) {
  const clips = p.shots.filter((s) => s.video_url);
  const [idx, setIdx] = useState(0);                       // 当前播放的镜头序号
  const [cuts, setCuts] = useState<Record<string, CutState>>({});
  const [srt, setSrt] = useState("");
  const [versions, setVersions] = useState<Record<string, { version_no: number; video_url: string | null; created_at: string | null }[]>>({});
  const [rendering, setRendering] = useState<string>("");  // 渲染进度文案
  const [cloudMode, setCloudMode] = useState(false);       // 云端导出兜底
  const videoRef = useRef<HTMLVideoElement>(null);

  const cur = clips[idx];

  // 连续预览：一段播完自动切下一段（播放头）
  const onEnded = () => { if (idx < clips.length - 1) setIdx(idx + 1); };
  useEffect(() => { videoRef.current?.play().catch(() => {}); }, [idx]);

  // 初始 srt：按镜头时长档生成模板（可手改）
  const genSrtDraft = () => {
    let t = 0;
    const fmt = (s: number) => {
      const h = String(Math.floor(s / 3600)).padStart(2, "0");
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const sec = String(Math.floor(s % 60)).padStart(2, "0");
      const ms = String(Math.round((s % 1) * 1000)).padStart(3, "0");
      return `${h}:${m}:${sec},${ms}`;
    };
    const rows = clips.map((s, i) => {
      const dur = cuts[s.id]?.durSec ?? 8;  // 无实测时长按 8s 档
      const row = `${i + 1}\n${fmt(t)} --> ${fmt(t + dur)}\n${s.script_ref.slice(0, 30)}\n`;
      t += dur;
      return row;
    });
    setSrt(rows.join("\n"));
  };

  const loadVersions = async (shotId: string) => {
    try {
      const r = await api.shotVersions(shotId);
      setVersions((prev) => ({ ...prev, [shotId]: r.versions }));
    } catch (e) { p.onToast(String(e)); }
  };

  const rollback = async (shotId: string, verNo: number) => {
    try {
      await api.adoptShot(shotId, verNo);
      p.onToast(`✅ 已回退到 V${verNo}`);
    } catch (e) { p.onToast(String(e)); }
  };

  const doExport = async () => {
    const renderClips: RenderClip[] = clips.map((s) => ({
      url: s.video_url!,
      inSec: cuts[s.id]?.inSec || undefined,
      durSec: cuts[s.id]?.durSec || undefined,
    }));
    const [w, h] = p.baseAspect === "16:9" ? [1920, 1080]
      : p.baseAspect === "1:1" ? [1080, 1080] : [1080, 1920];
    if (cloudMode) {
      // 云端兜底：无裁剪支持，仅整段 + burn_srt
      if (Object.keys(cuts).length) p.onToast("⚠️ 云端导出不支持裁剪，将按整段拼接");
      try {
        await api.submitCompose(clips.map((s) => s.video_url!), {
          width: w, height: h, burn_srt: srt.trim() || undefined,
        });
        p.onToast("已提交云端导出（顶部进度条跟踪）");
      } catch (e) { p.onToast(String(e)); }
      return;
    }
    try {
      const out = await localRender(p.projectId, renderClips, {
        width: w, height: h, fps: 30, burnSrt: srt.trim() || undefined,
        onProgress: (pct, stage) => setRendering(`${stage} ${pct}%`),
      });
      setRendering("");
      p.onToast(out ? `✅ 已导出: ${out}` : "已取消导出");
    } catch (e) {
      setRendering("");
      p.onToast(`本机渲染失败（可切云端导出兜底）: ${String(e).slice(0, 150)}`);
    }
  };


  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="finecut" onClick={(e) => e.stopPropagation()}>
        <div className="board-head">
          <span className="tl-title">🎞 精编器</span>
          <span className="muted">{clips.length} 镜 · 画幅 {p.baseAspect}</span>
          <span style={{ flex: 1 }} />
          <label className="row" style={{ alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={cloudMode} onChange={(e) => setCloudMode(e.target.checked)} />
            <span className="muted">云端导出（低配兜底）</span>
          </label>
          <button className="btn primary" disabled={!!rendering || !clips.length} onClick={doExport}>
            {rendering || (cloudMode ? "☁ 云端导出" : "💻 本机导出")}
          </button>
          <button className="btn ghost" onClick={p.onClose}>✕</button>
        </div>

        <div className="finecut-body">
          {/* 左：预览 + 播放头序列 */}
          <div className="finecut-left">
            {cur ? (
              <video ref={videoRef} key={cur.id} src={api.mediaUrl(cur.video_url!)}
                controls autoPlay onEnded={onEnded} className="player-video" />
            ) : <div className="muted pad">没有已生成的镜头</div>}
            <div className="finecut-strip">
              {clips.map((s, i) => (
                <div key={s.id} className={`finecut-chip ${i === idx ? "on" : ""}`}
                  onClick={() => setIdx(i)}>#{s.order}</div>
              ))}
            </div>
            {/* 当前镜头：裁剪 + 版本 + 重生成 */}
            {cur && (
              <div className="finecut-shotops">
                <label>入点(s)
                  <input type="number" min={0} step={0.5} style={{ width: 70 }}
                    value={cuts[cur.id]?.inSec ?? 0}
                    onChange={(e) => setCuts((prev) => ({ ...prev, [cur.id]: { ...prev[cur.id], inSec: Number(e.target.value) } }))} />
                </label>
                <label>时长(s)
                  <input type="number" min={0.5} step={0.5} style={{ width: 70 }}
                    placeholder="全长"
                    value={cuts[cur.id]?.durSec ?? ""}
                    onChange={(e) => setCuts((prev) => ({ ...prev, [cur.id]: { inSec: prev[cur.id]?.inSec ?? 0, durSec: e.target.value ? Number(e.target.value) : undefined } }))} />
                </label>
                <button className="btn tiny" onClick={() => loadVersions(cur.id)}>🕘 版本</button>
                <button className="btn tiny" onClick={() => { p.onRegenerate([cur.id]); p.onToast("已提交重生成（只重视频）"); }}>
                  ↻ 回云端重生成
                </button>
                {(versions[cur.id] ?? []).map((v) => (
                  <button key={v.version_no} className="btn tiny ghost"
                    title={v.created_at ?? ""}
                    onClick={() => rollback(cur.id, v.version_no)}>
                    V{v.version_no}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 右：srt 字幕编辑器 */}
          <div className="finecut-right">
            <div className="row">
              <span className="tl-title">字幕（srt）</span>
              <span style={{ flex: 1 }} />
              <button className="btn tiny" onClick={genSrtDraft}>按镜头生成初稿</button>
            </div>
            <textarea className="drawer-ta fill" style={{ fontFamily: "monospace", fontSize: 12 }}
              placeholder={"1\n00:00:00,000 --> 00:00:03,000\n第一句字幕…\n\n留空=不烧字幕"}
              value={srt} onChange={(e) => setSrt(e.target.value)} />
          </div>
        </div>
      </div>
    </div>
  );
}
