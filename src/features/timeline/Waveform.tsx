/**
 * Waveform — 音频波形（Phase 2 遗留项；3.9 重做内存与 canvas 上限）
 *
 * 自己画而不引依赖：解码用 Web Audio 的 `decodeAudioData`，绘制用 Canvas，
 * 总共百来行。引 wavesurfer 之类会带来几百 KB 和一套自己的 DOM 管理。
 *
 * **判据全部在 `waveform.ts`**（纯模块，node 下可直接断言）；本文件只负责
 * 「什么时候解、把结果画到哪」这两件离不开浏览器的事。3.9 修的三个问题
 * （230 MB 解码 / canvas 超宽变空白 / 缓存无上限且失败不缓存）的完整来龙去脉
 * 写在那个文件的头注释里，不在这里重复。
 *
 * 这里只记与本文件强相关的两条：
 *
 * · **划到屏幕上才开始解**。时间轴目前不做虚拟化（那是 3.10），601 段 clip
 *   是**全部**挂进 DOM 的；不加 IntersectionObserver 就等于「打开项目 =
 *   自动把整部剧的音频下载并解码一遍」。滚出视野的段落**不取消已在飞的解码**
 *   （解到一半丢掉纯属白花），但**不会开始新的**。
 * · **未解完时画中线，不是空着**。空着看起来像「这段没有声音」。
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { localSources } from "../../lib/mediaCache";
import {
  DECODE_SAMPLE_RATE, bucketsFor, computePeaks, canvasBacking, peakRange,
  PeakCache, Gate,
} from "./waveform";

/** url → 峰值包络。`null` = 这段解不出来（负结果也缓存，见 waveform.ts） */
const PEAK_CACHE = new PeakCache();
const PENDING = new Map<string, Promise<Float32Array | null>>();
const GATE = new Gate();

/** 切/关项目时调用：峰值按 url 缓存，跨项目没有复用价值，白占内存。 */
export function clearWaveformCache(): void {
  PEAK_CACHE.clear();
}

/**
 * 6.3：拿音频字节。**盘上有就读盘，没有才走网络。**
 *
 * 这里用的是 `bytesForCurrent`（环境项目）而不是显式 projectId：
 * 本组件挂在 `ClipView` 上，那条链路（Timeline → ClipView → Waveform）
 * 只有 `clip.mediaUrl`，没有项目 id。把 projectId 一路 drill 下来要动三层
 * 组件的 Props，而缓存文件名是 **URL 的哈希**（见 `cacheName.ts`），
 * 拿错项目只会 miss、不可能命中到别的素材 —— 最坏退回走网络，与 6.3 之前一样。
 *
 * 注意这里**不造 blob**：只要字节喂给 `decodeAudioData`，没有 objectURL
 * 生命周期问题。波形解完就只剩几 KB 的峰值包络（`PeakCache`），字节当场可回收。
 */
async function audioBytes(url: string): Promise<ArrayBuffer | null> {
  const local = await localSources.bytesForCurrent(url);
  if (local) {
    // 切一份独立的 ArrayBuffer：`decodeAudioData` 会**转移（detach）**传进去的
    // buffer，而 plugin-fs 返回的可能是某个更大缓冲区上的视图 —— 直接把
    // `local.buffer` 交出去会连累同一块内存上的其他视图。
    return local.slice().buffer as ArrayBuffer;
  }
  const resp = await fetch(api.mediaUrl(url));
  if (!resp.ok) return null;
  return resp.arrayBuffer();
}

async function decode(url: string): Promise<Float32Array | null> {
  const buf = await audioBytes(url);
  if (!buf) return null;
  // AudioContext 只为解码，用完即关——每个实例都占一个硬件音频线程。
  // 指定 8kHz：decodeAudioData 会重采样到上下文速率，内存直接省 6 倍。
  const Ctor = window.OfflineAudioContext
    || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  // 1 帧的壳，只用它的 decodeAudioData；采样率由构造参数决定
  const ctx = new Ctor(1, 1, DECODE_SAMPLE_RATE);
  const audio = await ctx.decodeAudioData(buf);
  const ch = audio.getChannelData(0);
  return computePeaks(ch, bucketsFor(audio.duration, ch.length));
}

function loadPeaks(url: string): Promise<Float32Array | null> {
  const inflight = PENDING.get(url);
  if (inflight) return inflight;

  const task = (async () => {
    await GATE.acquire();
    try {
      // 排队期间可能已经有别的实例解完了（同一段音频在时间轴上会出现多次）
      if (PEAK_CACHE.has(url)) return PEAK_CACHE.get(url) ?? null;
      const peaks = await decode(url);
      PEAK_CACHE.set(url, peaks);
      return peaks;
    } catch {
      // 解码失败（格式不支持/跨域/取不到）→ 记下这个失败，退回中线。
      // 不记的话每次重挂都会重 fetch + 重解，永远失败、永远重试。
      PEAK_CACHE.set(url, null);
      return null;
    } finally {
      GATE.release();
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
  /** 进过视野没有。一旦为真就不再翻回去——解都解完了，再"省"没有意义。 */
  const [seen, setSeen] = useState(() => PEAK_CACHE.has(url));

  useEffect(() => {
    if (seen) return;
    const cv = canvasRef.current;
    if (!cv) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    // rootMargin：提前一屏开始解，滚到跟前时波形已经在了
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(cv);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    // url 换了 = 换了一段音频，重新走「进视野才解」这条路
    setSeen(PEAK_CACHE.has(url));
    setPeaks(PEAK_CACHE.get(url) ?? null);
  }, [url]);

  useEffect(() => {
    if (!seen) return;
    const hit = PEAK_CACHE.get(url);
    if (hit !== undefined) { setPeaks(hit); return; }
    let alive = true;
    void loadPeaks(url).then((p) => { if (alive) setPeaks(p); });
    return () => { alive = false; };
  }, [url, seen]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const { bw, bh } = canvasBacking(width, height, window.devicePixelRatio || 1);
    cv.width = bw;
    cv.height = bh;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // 直接在背板坐标系里画：撞到宽度上限时 css/背板不再是 dpr 倍关系，
    // scale(dpr,dpr) 会把波形画到画布外面去（旧实现的隐患）。
    ctx.clearRect(0, 0, bw, bh);
    ctx.fillStyle = color || "rgba(255,255,255,0.55)";
    const mid = bh / 2;
    const unit = Math.max(1, Math.round(bh / Math.max(1, Math.floor(height))));

    if (!peaks || peaks.length === 0) {
      // 未解完 / 解不出来：画一条中线，表示"这里有音频"。空着像是没声音。
      ctx.fillRect(0, mid - unit / 2, bw, unit);
      return;
    }
    for (let x = 0; x < bw; x++) {
      const [i0, i1] = peakRange(peaks.length, x, bw);
      let max = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > max) max = peaks[i];
      const barH = Math.max(unit, max * (bh - 2 * unit));
      ctx.fillRect(x, mid - barH / 2, 1, barH);
    }
  }, [peaks, width, height, color]);

  return (
    <canvas ref={canvasRef}
      style={{ width, height, display: "block", pointerEvents: "none" }} />
  );
}
