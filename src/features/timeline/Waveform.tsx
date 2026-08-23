/**
 * Waveform — 音频波形（Phase 2 遗留项，收尾补齐）
 *
 * 自己画而不引依赖：解码用 Web Audio 的 decodeAudioData，绘制用 Canvas，
 * 总共几十行。引 wavesurfer 之类会带来几百 KB 和一套自己的 DOM 管理。
 *
 * 两个必须处理的现实问题：
 *  1) **解码很贵**：一段 30s 音频解码出的 Float32Array 有上百万个采样点。
 *     所以解码结果按 url 缓存（模块级 Map），同一段音频在时间轴上反复
 *     重绘时不再重复解码。
 *  2) **不能阻塞首屏**：解码是异步的，未完成时先画一条中线占位，
 *     而不是让整条轨道空着或卡住。
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../../api";

/** url → 峰值数组（已降采样到 ~1000 点，够画任何缩放级别） */
const PEAK_CACHE = new Map<string, Float32Array>();
const PENDING = new Map<string, Promise<Float32Array | null>>();
const PEAK_BUCKETS = 1000;

async function loadPeaks(url: string): Promise<Float32Array | null> {
  const cached = PEAK_CACHE.get(url);
  if (cached) return cached;
  const inflight = PENDING.get(url);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const resp = await fetch(api.mediaUrl(url));
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      // AudioContext 只为解码，用完即关——每个实例都占一个硬件音频线程
      const Ctor = window.AudioContext
        || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      try {
        const audio = await ctx.decodeAudioData(buf);
        const ch = audio.getChannelData(0);
        const per = Math.max(1, Math.floor(ch.length / PEAK_BUCKETS));
        const peaks = new Float32Array(PEAK_BUCKETS);
        for (let i = 0; i < PEAK_BUCKETS; i++) {
          let max = 0;
          const from = i * per;
          const to = Math.min(ch.length, from + per);
          for (let j = from; j < to; j++) {
            const v = Math.abs(ch[j]);
            if (v > max) max = v;
          }
          peaks[i] = max;
        }
        PEAK_CACHE.set(url, peaks);
        return peaks;
      } finally {
        void ctx.close();
      }
    } catch {
      return null;   // 解码失败（格式不支持/跨域）→ 退回中线，不报错打扰用户
    } finally {
      PENDING.delete(url);
    }
  })();
  PENDING.set(url, task);
  return task;
}

interface Props {
  url: string;
  width: number;
  height: number;
  /** 波形颜色；默认取轨道强调色 */
  color?: string;
}

export default function Waveform({ url, width, height, color }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(
    () => PEAK_CACHE.get(url) ?? null);

  useEffect(() => {
    let alive = true;
    const hit = PEAK_CACHE.get(url);
    if (hit) { setPeaks(hit); return; }
    setPeaks(null);
    void loadPeaks(url).then((p) => { if (alive) setPeaks(p); });
    return () => { alive = false; };
  }, [url]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color || "rgba(255,255,255,0.55)";
    const mid = h / 2;

    if (!peaks) {
      // 未解码完：画一条中线，表示"这里有音频，正在算波形"
      ctx.fillRect(0, mid - 0.5, w, 1);
      return;
    }
    // 每个像素列取对应区间的峰值（缩放变化时自动重采样）
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((x / w) * peaks.length);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * peaks.length));
      let max = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) {
        if (peaks[i] > max) max = peaks[i];
      }
      const barH = Math.max(1, max * (h - 2));
      ctx.fillRect(x, mid - barH / 2, 1, barH);
    }
  }, [peaks, width, height, color]);

  return (
    <canvas ref={canvasRef}
      style={{ width, height, display: "block", pointerEvents: "none" }} />
  );
}
