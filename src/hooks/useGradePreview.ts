/**
 * useGradePreview — 把 <video> 的每一帧经 WebGL 调色后画到 <canvas>。
 *
 * ## 曾经的自举死锁（本文件存在感最强的一段历史，别改回去）
 *
 * 旧版返回 `canvasRef`（普通 `useRef`），而调用方 `Player.tsx` 写的是
 * `{gpuActive && <canvas ref={canvasRef} …/>}`。于是形成一个闭环：
 *
 *     canvasRef.current 非空 ⇐ canvas 已挂载 ⇐ gpuActive ⇐ gpuOk
 *                       ⇐ create(cv) 成功 ⇐ canvasRef.current 非空
 *
 * 起点永远进不去：effect 的 deps 只有 `[active]`，`active` 翻成 true 的那一次
 * canvas 还没挂载（因为 gpuActive 还是 false），`create` 拿不到元素直接 return，
 * 而 canvas 挂载这件事**不会**再触发任何 effect —— 没有第二次机会。
 * 后果是整个 `gradePreview.ts` 从未被执行过：LUT 在预览里永远看不见，
 * 「预览为近似效果」在所有机器上都是常亮的。
 *
 * 解法两条，缺一不可：
 *   ① 调用方**无条件挂载** canvas，可见性交给 CSS（`Player.tsx`）；
 *   ② 这里改用 **state 型 ref**（callback ref → setState），
 *      canvas 元素挂载/替换时能真正触发 effect 重跑。
 *      光做①不做②，遇到「换镜头导致 canvas 重建」还是会静默失活。
 *
 * ## 上下文的生命周期绑在 canvas 元素上，不绑在 active 上
 *
 * `GradePreview.destroy()` 会 `loseContext()`，那是**不可逆**的。
 * 旧代码把它挂在 `active` 的 cleanup 上；一旦 canvas 常驻，
 * 「关一次调色」就会把这个播放器的 GPU 预览永久报废。
 * 所以停用只是"不画"，销毁只发生在 canvas 元素消失时，且延后一拍
 * （为将来的 React 19 StrictMode 留的保险，见 effect ① 的说明）。
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
 * 所以 tm 变化时无条件重绘一帧（下方 effect ④）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
  /** 当前播放源。<video> 是 `key={previewUrl}` 挂的，换源=换元素，
   *  而 `videoRef` 的**身份不变**，光靠它无法察觉元素被换掉，
   *  注册在旧元素上的 rVFC 从此再也不会触发 → 绘制循环静默停摆。
   *  所以把源作为显式依赖传进来，换源时重建循环。 */
  videoKey?: string | null,
) {
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  // callback ref：canvas 挂载/卸载会走 setState，从而触发下面的 effect。
  // 用普通 useRef 就回到了本文件开头描述的死锁。
  const canvasRef = useCallback((el: HTMLCanvasElement | null) => {
    setCanvasEl(el);
  }, []);
  const engineRef = useRef<GradePreview | null>(null);
  // GPU 不可用时降级到 CSS：调用方据此决定给 <video> 挂不挂 filter
  const [gpuOk, setGpuOk] = useState(false);

  const active = needsGpuPreview(transform);

  // transform 只进 ref、不进绘制循环的 deps。
  // 它在 App.tsx 里是 `shots.find(...)?.transform_meta`，每次 refreshDetail()
  // 都是新对象；进了 deps 就会让整个 rVFC 循环被反复拆掉重建
  // （SSE 一推送就断一次帧同步）。循环里每帧从 ref 取最新值即可。
  const tmRef = useRef(transform);
  tmRef.current = transform;

  // ---- ① 上下文生命周期：只跟 canvas 元素走 ----
  //
  // 销毁**延后一个宏任务**：元素若在同一拍内又回来（同步的卸载→挂载），
  // 就撤销销毁，engine 原样复用。
  //
  // ⚠️ 这层保险当前**并未被触发**，是防御性的，别把它当成"修了某个已复现的 bug"：
  // 全站挂在 `<React.StrictMode>` 下（main.tsx:9），开发模式下 React 会把每个
  // effect 演练一遍「挂载 → 卸载 → 再挂载」。但 React 18.3（本项目当前版本）
  // **不会**在演练里摘挂 callback ref —— `canvasEl` 自始至终没变过，
  // 这个 effect 的 cleanup 在演练中根本不会跑。实测（改成同步 destroy 后重跑
  // 端到端对照实验）依旧是 creates=1 destroys=0，全绿。
  //
  // 保留它的理由是**升级到 React 19 会变成必需**：19 的 StrictMode 会真的
  // 摘挂 ref（null → 元素），届时同步 destroy() 就会在演练里 loseContext()，
  // 而它**不可逆** —— 重建时 getContext 拿回的是那个已丢失的上下文，
  // create() 编译 shader 直接失败，于是**整个开发模式下 GPU 预览永久为假**，
  // 生产构建却正常。那正是本文件开头那个死锁的同类：静默、只在某种构建里出现。
  // 代价是 8 行，收益是这类 bug 不会再来一次，所以现在就写上。
  const pendingKill = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!canvasEl) return;
    if (pendingKill.current !== null) {
      clearTimeout(pendingKill.current);
      pendingKill.current = null;
    }
    return () => {
      pendingKill.current = setTimeout(() => {
        pendingKill.current = null;
        engineRef.current?.destroy();
        engineRef.current = null;
        setGpuOk(false);
      }, 0);
    };
  }, [canvasEl]);

  // ---- ② 懒创建：第一次真的需要调色时才建上下文 ----
  // 不需要调色的项目一个 WebGL 上下文都不占；建了之后就一直留着，
  // 直到 canvas 元素消失（见 ①），中途关掉调色**不**销毁。
  useEffect(() => {
    if (!active || !canvasEl || engineRef.current) return;
    engineRef.current = GradePreview.create(canvasEl);
    setGpuOk(!!engineRef.current);
  }, [active, canvasEl]);

  // ---- ③ 绘制循环 ----
  useEffect(() => {
    const eng = engineRef.current;
    const v = videoRef.current;
    if (!eng || !v || !active || !gpuOk) return;

    let stop = false;
    let rvfcHandle = 0;
    let rafHandle = 0;

    const schedule = () => {
      if (stop) return;
      const rv = v as HTMLVideoElement & RVFC;
      if (rv.requestVideoFrameCallback) {
        rvfcHandle = rv.requestVideoFrameCallback(() => void paint());
      } else {
        rafHandle = requestAnimationFrame(() => void paint());
      }
    };
    // draw 是 async（LUT 首次加载要 await fetch）。旧代码 `void eng.draw(); schedule();`
    // 不等它就排下一帧，LUT 载入期间会堆叠一串未完成的 draw，
    // 且 ensureLut 里的 this.lutTex 会被并发写。这里等它落地再排下一帧。
    const paint = async () => {
      if (stop) return;
      try {
        await eng.draw(v, tmRef.current);
      } catch (e) {
        // 上下文丢失等硬错误：停掉循环，别每帧刷屏
        console.warn("[useGradePreview] 绘制失败，停止本轮循环:", e);
        return;
      }
      schedule();
    };

    // 立刻画一帧：暂停状态下调参数也要能看到变化
    void paint();

    return () => {
      stop = true;
      const rv = v as HTMLVideoElement & RVFC;
      if (rvfcHandle && rv.cancelVideoFrameCallback) {
        rv.cancelVideoFrameCallback(rvfcHandle);
      }
      if (rafHandle) cancelAnimationFrame(rafHandle);
    };
  }, [active, gpuOk, canvasEl, videoKey, videoRef]);

  // ---- ④ 参数变化时补一帧（视频暂停时 rVFC 不会触发）----
  useEffect(() => {
    const eng = engineRef.current;
    const v = videoRef.current;
    if (eng && v && active && gpuOk) void eng.draw(v, transform);
  }, [transform, active, gpuOk, videoRef]);

  return { canvasRef, gpuActive: active && gpuOk };
}
