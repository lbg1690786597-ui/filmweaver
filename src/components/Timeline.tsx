import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import { TimelineItem, fmtTime } from "../types";

interface Props {
  items: TimelineItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (id: string) => void;
}

const PX_PER_SEC = 14;       // 每秒像素
const MIN_BLOCK_W = 70;      // 最小块宽
const FALLBACK_SEC = 5;      // 无时长素材按 5s 占位

/** 底部时间轴：刻度尺 + 视频轨（比例宽 / 拖拽排序 / 选中联动） */
export default function Timeline(p: Props) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const videos = p.items.filter((t) => t.clip.kind === "video");
  const audios = p.items.filter((t) => t.clip.kind === "audio");

  const totalSec = useMemo(
    () => videos.reduce((s, t) => s + (t.clip.duration || FALLBACK_SEC), 0),
    [videos],
  );

  const blockW = (sec: number) => Math.max(MIN_BLOCK_W, (sec || FALLBACK_SEC) * PX_PER_SEC);

  // 刻度：每 5 秒一格
  const ticks = useMemo(() => {
    const arr: number[] = [];
    for (let s = 0; s <= Math.max(totalSec, 30); s += 5) arr.push(s);
    return arr;
  }, [totalSec]);

  const handleDrop = (to: number) => {
    if (dragIdx !== null && dragIdx !== to) {
      // videos 索引 → items 索引
      const fromItem = videos[dragIdx];
      const toItem = videos[to];
      const fromIdx = p.items.findIndex((t) => t.id === fromItem.id);
      const toIdx = p.items.findIndex((t) => t.id === toItem.id);
      p.onReorder(fromIdx, toIdx);
    }
    setDragIdx(null); setOverIdx(null);
  };

  return (
    <section className="tl">
      <div className="tl-head">
        <span className="tl-title">时间轴</span>
        <span className="muted">总时长 {fmtTime(totalSec)} · {videos.length} 段视频{audios.length ? ` · ${audios.length} 条音频` : ""}</span>
        <span className="muted tl-hint">拖动排序 · 点击选中 · Delete 删除</span>
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        {/* 刻度尺 */}
        <div className="tl-ruler" style={{ width: Math.max(totalSec, 30) * PX_PER_SEC + 100 }}>
          {ticks.map((s) => (
            <span key={s} className="tl-tick" style={{ left: s * PX_PER_SEC }}>{fmtTime(s)}</span>
          ))}
        </div>

        {/* 视频轨 */}
        <div className="tl-track">
          <span className="tl-track-label">🎞</span>
          {videos.map((t, i) => (
            <div
              key={t.id}
              className={`tl-clip ${p.selectedId === t.id ? "sel" : ""} ${overIdx === i ? "over" : ""}`}
              style={{ width: blockW(t.clip.duration) }}
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => { e.preventDefault(); setOverIdx(i); }}
              onDragLeave={() => setOverIdx(null)}
              onDrop={() => handleDrop(i)}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
              onClick={() => p.onSelect(t.id)}
              title={t.clip.name}
            >
              <video src={api.mediaUrl(t.clip.url)} muted preload="metadata" />
              <div className="tl-clip-info">
                <span className="tl-clip-name">{t.clip.name}</span>
                <span className="tl-clip-dur">{fmtTime(t.clip.duration || FALLBACK_SEC)}</span>
              </div>
              <button className="tl-clip-x" title="移除"
                onClick={(e) => { e.stopPropagation(); p.onRemove(t.id); }}>✕</button>
            </div>
          ))}
          {!videos.length && <div className="tl-empty">从左侧素材库点「＋」把视频加入时间轴</div>}
        </div>

        {/* 音频轨（有音频素材时显示） */}
        {audios.length > 0 && (
          <div className="tl-track audio">
            <span className="tl-track-label">🎵</span>
            {audios.map((t) => (
              <div key={t.id} className={`tl-clip audio ${p.selectedId === t.id ? "sel" : ""}`}
                style={{ width: blockW(t.clip.duration) }}
                onClick={() => p.onSelect(t.id)} title={t.clip.name}>
                <div className="tl-clip-info">
                  <span className="tl-clip-name">🎵 {t.clip.name}</span>
                  <span className="tl-clip-dur">{fmtTime(t.clip.duration || FALLBACK_SEC)}</span>
                </div>
                <button className="tl-clip-x" onClick={(e) => { e.stopPropagation(); p.onRemove(t.id); }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}