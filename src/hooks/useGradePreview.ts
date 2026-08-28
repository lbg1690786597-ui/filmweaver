/**
 * useGradePreview — 把 <video> 的每一帧经 WebGL 调色后画到 <canvas>。
 *
 * ## 帧同步为什么用 requestVideoFrameCallback
 *
 * rAF 按显示器刷新率触发（通常 60Hz），而视频常是 24/25/30fps ——
 * 用 rAF 会做大量重复绘制（同一帧画 2-3 次，白烧 GPU），
 * 且在视频帧率高于刷新率时反而丢帧。
 * rVFC 是"有新视频帧可用时"回调，一帧一次，正是我们要的。
 *
 * 老浏览器没有 rVFC 时退回 rAF —— 效果一样，只是多费点 GPU。
 *
 * ## 为什么暂停时也要画一次
 *
 * 用户拖调色滑块时视频通常是暂停的。只在 rVFC 里画的话，暂停状态下
 * 参数改了画面不动 —— 那就退化成了修复前的老问题。
 * 所以 tm 变化时无条件重绘一帧。
 */

import { useEffect, useRef, useState } from "react";
import type { TransformMeta } from "../api";
import { GradePreview, needsGpuPreview } from "../render/gradePreview";

/** rVFC 在部分 TS 版本的 lib.dom 里已内置、部分没有 ——
 *  重新 declare 会和内置定义冲突，所以只在调用处按需断言。 */
type RVFC = {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export function useGradePreview(
  videoRef: React.RefObject<HTMLVideoElement>,
  transform: TransformMeta | null | undefined,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GradePreview | null>(null);
  // GPU 不可用时降级到 CSS：调用方据此决定给 <video> 挂不挂 filter
  const [gpuOk, setGpuOk] = useState(false);

  const active = needsGpuPreview(transform);

  useEffect(() => {
    if (!active) {
      // 不需要调色就释放上下文 —— 浏览器同时活跃的 WebGL 上下文有上限，
      // 每个镜头留一个不释放，切几十个镜头后新的就创建不出来了
      engineRef.current?.dispose();
      engineRef.current = null;
      setGpuOk(false);
      return;
    }
    const cv = canvasRef.current;
    if (!cv) return;
    if (!engineRef.current) {
      engineRef.current = GradePreview.create(cv);
      setGpuOk(!!engineRef.current);
    }
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [active]);

  useEffect(() => {
    const eng = engineRef.current;
    const v = videoRef.current;
    if (!eng || !v || !active) return;

    let stop = false;
    let rvfcHandle = 0;
    let rafHandle = 0;

    const paint = () => {
      if (stop) return;
      void eng.draw(v, transform);
      schedule();
    };
    const schedule = () => {
      if (stop) return;
      const rv = v as HTMLVideoElement & RVFC;
      if (rv.requestVideoFrameCallback) {
        rvfcHandle = rv.requestVideoFrameCallback(paint);
      } else {
        rafHandle = requestAnimationFrame(paint);
      }
    };

    // 立刻画一帧：暂停状态下调参数也要能看到变化
    void eng.draw(v, transform);
    schedule();

    return () => {
      stop = true;
      const rv = v as HTMLVideoElement & RVFC;
      if (rvfcHandle && rv.cancelVideoFrameCallback) {
        rv.cancelVideoFrameCallback(rvfcHandle);
      }
      if (rafHandle) cancelAnimationFrame(rafHandle);
    };
  }, [active, transform, videoRef]);

  return { canvasRef, gpuActive: active && gpuOk };
}
