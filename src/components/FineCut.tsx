import { useEffect, useRef, useState } from "react";
import { api, ShotInfo } from "../api";
import { localRender, RenderClip } from "../lib/localRender";
import {
  useLoadState, describeLoadError, LOAD_LABELS,
} from "../stores/loadStateStore";
import type { SubtitleStyleLike } from "../lib/subtitleStyle";

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
 *  连续预览+播放头 / 入出点裁剪 / 字幕预览 / 版本历史回退 / 回云端重生成 / 本机导出。
 *
 *  字幕不在这里编辑：它原来自带一个裸 SRT textarea 和一个「按镜头生成初稿」
 *  按钮（每镜写死 8 秒、正文取 script_ref 前 30 字），与字幕轨 subtitle_clips
 *  完全不通——同一个项目会有两套互相不认识的字幕，导出走哪条全看用户点了哪个
 *  按钮。现在统一读字幕轨生成的 SRT，编辑入口只有「文本」面板一处。 */
export default function FineCut(p: Props) {
  const clips = p.shots.filter((s) => s.video_url);
  const [idx, setIdx] = useState(0);                       // 当前播放的镜头序号
  const [cuts, setCuts] = useState<Record<string, CutState>>({});
  const [srt, setSrt] = useState("");
  const [srtCount, setSrtCount] = useState(0);
  const [subStyle, setSubStyle] = useState<SubtitleStyleLike | null>(null);
  const [versions, setVersions] = useState<Record<string, { version_no: number; video_url: string | null; created_at: string | null }[]>>({});
  const [rendering, setRendering] = useState<string>("");  // 渲染进度文案
  const videoRef = useRef<HTMLVideoElement>(null);

  const cur = clips[idx];

  // 连续预览：一段播完自动切下一段（播放头）
  const onEnded = () => { if (idx < clips.length - 1) setIdx(idx + 1); };
  useEffect(() => { videoRef.current?.play().catch(() => {}); }, [idx]);

  // 字幕轨 → SRT（时间码由后端按镜头顺序换算），以及项目级字幕样式。
  // ⚠️ 2.4：原注释写「拉不到不该挡住精编：只是导出时不烧字幕」——**前半句对，后半句
  // 是在轻描淡写**。这里拉不到的后果不是"少个预览"，是**用户按下导出、成片里一条
  // 字幕都没有，而界面上写着「字幕（0 条）」+「字幕轨为空」**，跟真的没做字幕
  // 一模一样。他要等片子出完、播一遍才发现，然后重导一次（本机渲染，几分钟起）。
  // 所以：不挡住精编（照旧），但必须把"这 0 条是没查到"说清楚，并挡住"以为没字幕"。
  const [srtErr, setSrtErr] = useState("");
  const loadSrt = async () => {
    try {
      const r = await api.subtitlesSrt(p.projectId);
      setSrt(r.srt); setSrtCount(r.count); setSrtErr("");
      useLoadState.getState().noteLoaded("exportSrt");
    } catch (e) {
      setSrt(""); setSrtCount(0);
      setSrtErr(describeLoadError(e, LOAD_LABELS.exportSrt).message);
      if (useLoadState.getState().noteFailed("exportSrt", e)) {
        p.onToast(`⚠️ ${describeLoadError(e, LOAD_LABELS.exportSrt).message}`);
      }
    }
  };
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await loadSrt();
      try {
        const r = await api.getSubtitleStyle(p.projectId);
        if (alive) setSubStyle((r.style as SubtitleStyleLike | null) ?? null);
      } catch { /* 用 srtForceStyle 的短剧默认值；样式缺省不影响"有没有字幕" */ }
    })();
    return () => { alive = false; };
  }, [p.projectId]);

  useEffect(() => useLoadState.getState().registerRetry(
    "exportSrt", () => { void loadSrt(); }), [p.projectId]);

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
    // 2.4：字幕没查到时导出会静默出一条字幕都没有的成片。本机渲染要几分钟，
    // 发现得晚、代价是重导一次。这里问一句就够了 —— 不阻止，只是不让它无声发生。
    if (srtErr && !window.confirm(
      `字幕没能加载（${srtErr}）。\n\n现在导出的成片里不会有任何字幕。\n` +
      "确定继续导出吗？（建议先点「重试」）")) return;
    const renderClips: RenderClip[] = clips.map((s) => ({
      url: s.video_url!,
      inSec: cuts[s.id]?.inSec || undefined,
      durSec: cuts[s.id]?.durSec || undefined,
    }));
    const [w, h] = p.baseAspect === "16:9" ? [1920, 1080]
      : p.baseAspect === "1:1" ? [1080, 1080] : [1080, 1920];
    try {
      const out = await localRender(p.projectId, renderClips, {
        width: w, height: h, fps: 30,
        burnSrt: srt.trim() || undefined,
        subtitleStyle: subStyle,
        onProgress: (pct, stage) => setRendering(`${stage} ${pct}%`),
      });
      setRendering("");
      p.onToast(out ? `✅ 已导出: ${out}` : "已取消导出");
    } catch (e) {
      setRendering("");
      p.onToast(`导出失败：${String(e).slice(0, 150)}`);
    }
  };


  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="finecut" onClick={(e) => e.stopPropagation()}>
        <div className="board-head">
          <span className="tl-title">🎞 精编器</span>
          <span className="muted">{clips.length} 镜 · 画幅 {p.baseAspect}</span>
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={!!rendering || !clips.length} onClick={doExport}>
            {rendering || "💻 导出成片"}
          </button>
          <button className="btn ghost" onClick={p.onClose}>✕</button>
        </div>

        <div className="finecut-body">
          {/* 左：预览 + 播放头序列 */}
          <div className="finecut-left">
            {cur ? (
              <video ref={videoRef} key={cur.id} src={api.mediaUrl(cur.video_url!)}
                controls autoPlay
                /* 3.4 `preload="metadata"`：同 Player —— 这个 `<video>` 也是 key 挂的，
                   点镜头卡/连播换镜就是换元素，默认的 `preload="auto"` 会让每次切换
                   都去拉整片，而其中大多数在下一次切换时就被 abort。 */
                preload="metadata"
                onEnded={onEnded} className="player-video" />
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

          {/* 右：字幕轨预览（只读，编辑在「文本」面板） */}
          <div className="finecut-right">
            <div className="row">
              <span className="tl-title">
                字幕（{srtErr ? "未加载" : `${srtCount} 条`}）
              </span>
              <span style={{ flex: 1 }} />
              {srtErr
                ? <button className="btn tiny" onClick={() => void loadSrt()}>重试</button>
                : <span className="muted">编辑请到「文本」面板</span>}
            </div>
            {srtErr && <div className="finecut-srtfail">⚠️ {srtErr}</div>}
            <textarea className="drawer-ta fill" readOnly
              style={{ fontFamily: "monospace", fontSize: "calc(12px * var(--fs-scale, 1))" }}
              placeholder={srtErr
                ? "字幕没查到 —— 现在导出的成片里不会有字幕。请先重试，别照这个状态导。"
                : "字幕轨为空 —— 导出时不烧字幕。可在「文本」面板从旁白生成字幕。"}
              value={srt} />
          </div>
        </div>
      </div>
    </div>
  );
}
