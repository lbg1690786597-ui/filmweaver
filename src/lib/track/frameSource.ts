/**
 * lib/track/frameSource.ts — 从 `<video>` 里逐帧取灰度画面（批次 6 / 6.5）
 *
 * 这是跟踪流程里唯一必须有 DOM 的部分，所以它被单独关在这个文件里，
 * 由 `runTrack` 以 `FrameSource` 接口注入 —— 验证脚本换成内存假货就能在 node 下
 * 把整条流程跑通（见 `track.ts` 文件头）。
 *
 * ## 为什么必须是 blob，而不是 `api.mediaUrl()` 的远端地址
 *
 * 两条独立的理由，任缺一条这个功能都不成立：
 *
 * 1. **画布污染**：跨源视频 `drawImage` 进 canvas 之后，`getImageData` 直接抛
 *    `SecurityError`。后端没开 CORS，加了也只是把问题挪走。
 * 2. **seek 的代价**：跟踪要 40 次精确 seek，走 HTTP 每次都是一轮 range 请求，
 *    慢且抖。本地文件的 seek 才是可用的。
 *
 * 6.3 已经把「本地文件 → blob URL」这条路铺好了（`lib/localSource.ts`），
 * 这里直接用它，不新增插件、不新增权限 —— `fs:allow-app-read-recursive`
 * 对 `$APPDATA/**` 的读权限早已授予。
 *
 * ⚠️ 这条路**只用于跟踪，不能推广成通用预览**：`readFile` 会把整个文件读进内存
 * （见 `OPTIMIZATION` §1.2 的更正）。跟踪面对的是一个几秒的短镜，几十 MB 封顶，
 * 且 `localSources` 自带 96 MB 上限；通用本地预览要的是 `assetProtocol` +
 * range 流式，那是另一件事。
 *
 * ## 时间换算只在这里做
 *
 * 外面（`track.ts`、面板、迷你时间条）一律用**输出秒**。而 `video.currentTime`
 * 要的是**素材秒**：`clipInSec + shotSecOf(输出秒, speed)`。这一步只在本文件出现
 * 一次 —— 换算散在多处是"遮挡在错误的时刻动"这类 bug 的温床。
 */

import { shotSecOf } from "../keyframeEdit";
import { grayFromRGBA, type GrayFrame } from "./ncc";
import type { FrameSource } from "./track";

/**
 * 抽帧宽度。§5.8 定的 ~320px。
 *
 * NCC 的代价与「模板点数 × 候选位置数」成正比，而候选位置数随边长平方增长：
 * 同一个框，320 宽下一次匹配 14.3 ms，640 宽就是 4 倍。而跟踪要的是
 * 「框中心在哪」，320 宽下 1 像素 = 画面的 0.3%，远低于用户能看出的偏差。
 */
export const FRAME_WIDTH = 320;

/** seek 一帧的等待上限。超时算这一帧没有（`runTrack` 记 nosource 并如实收场）。 */
export const SEEK_TIMEOUT_MS = 4000;

/** 元数据加载的等待上限。 */
export const LOAD_TIMEOUT_MS = 15000;

export interface VideoFrameSource extends FrameSource {
  /** 画面尺寸（降采样后） */
  readonly width: number;
  readonly height: number;
  /** 释放 `<video>`。**不** revoke blob URL —— 那是 `localSources` 的东西。 */
  close(): void;
}

export interface OpenFrameSourceOpts {
  /** 素材内的起点秒（`ShotInfo.clip_in_sec`），缺省 0 */
  clipInSec?: number;
  /** 变速倍率，缺省 1 */
  speed?: number;
  /** 降采样宽度，缺省 `FRAME_WIDTH` */
  width?: number;
}

function once<T>(
  el: EventTarget, ok: string, ms: number, what: string,
): Promise<T | void> {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error(`${what}失败`)); };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      el.removeEventListener("error", onErr);
    };
    timer = setTimeout(() => { cleanup(); reject(new Error(`${what}超时`)); }, ms) as unknown as number;
    el.addEventListener(ok, onOk);
    el.addEventListener("error", onErr);
  });
}

/**
 * 用一个 blob URL 造抽帧器。
 *
 * `blobUrl` 必须是同源的（`blob:` 或同源 http）。传远端 URL 不会在这里报错，
 * 而是等到第一次 `getImageData` 才抛 `SecurityError` —— 所以调用方
 * （`MosaicPanel`）在开始跟踪前就要确认素材已落地，拿不到本地文件就明说，
 * 不要抱着"也许能行"的心态开跑。
 */
export async function openVideoFrameSource(
  blobUrl: string, opts: OpenFrameSourceOpts = {},
): Promise<VideoFrameSource> {
  const clipIn = opts.clipInSec ?? 0;
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;

  const v = document.createElement("video");
  v.preload = "auto";
  v.muted = true;
  // 这两个属性对 blob 是多余的，但留着可以让「有人误传了远端 URL」时
  // 至少有机会走通，而不是必然污染画布。
  v.crossOrigin = "anonymous";
  v.playsInline = true;
  v.src = blobUrl;

  await once(v, "loadedmetadata", LOAD_TIMEOUT_MS, "读取素材");

  const vw = v.videoWidth || 0;
  const vh = v.videoHeight || 0;
  if (vw <= 0 || vh <= 0) {
    v.removeAttribute("src");
    throw new Error("素材没有画面尺寸");
  }
  const w = Math.max(16, Math.min(opts.width ?? FRAME_WIDTH, vw));
  const h = Math.max(16, Math.round((w * vh) / vw));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  // `willReadFrequently` 让浏览器把画布留在软件内存里 —— 我们每帧都要
  // `getImageData`，GPU→CPU 的回读才是这条路上真正的大头。
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    v.removeAttribute("src");
    throw new Error("拿不到 canvas 2d 上下文");
  }

  let closed = false;

  return {
    width: w,
    height: h,
    async grab(tSec: number): Promise<GrayFrame | null> {
      if (closed) return null;
      const at = clipIn + shotSecOf(tSec, speed);
      // 夹到 duration 之内：超出会让某些浏览器既不触发 `seeked` 也不报错，
      // 于是只能等超时 —— 一次 4 秒，40 帧就是 160 秒的假死。
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      const target = dur ? Math.min(Math.max(0, at), Math.max(0, dur - 1e-3)) : Math.max(0, at);
      try {
        if (Math.abs(v.currentTime - target) > 1e-3) {
          v.currentTime = target;
          await once(v, "seeked", SEEK_TIMEOUT_MS, "定位画面");
        }
        if (closed) return null;
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        return grayFromRGBA(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), w, h);
      } catch {
        // seek 超时、解码坏帧、画布污染都归到这里：返回 null，
        // 由 `runTrack` 记成 nosource 并保留前段结果。
        return null;
      }
    },
    close() {
      closed = true;
      v.pause();
      v.removeAttribute("src");
      v.load();
    },
  };
}
