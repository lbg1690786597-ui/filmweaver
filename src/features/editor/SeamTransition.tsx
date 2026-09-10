/**
 * SeamTransition — 播放器里的转场预览（3.9）
 *
 * ## 在此之前，转场是「导出才看得见」的
 *
 * `ffmpegCompiler` 早就会把转场编译成 `xfade`（导出确实生效），但播放器
 * 从头到尾没有 transition 这个概念 —— 用户在轨道上加了闪黑，播一遍完全
 * 看不出任何变化，报「转场能力似乎没有实现」。
 *
 * ## 做法：定格上一镜的末帧，让它按转场的方式退场
 *
 * 播放器是**单个 `<video>` 换 src**（`key={previewUrl}`，那个 key 是连播能
 * 自动播放的唯一原因，见 Player 里的注释，不能动）。要做真正的双流叠化就得
 * 同时解码两段视频并逐帧同步，那是一次伤筋动骨的重构，风险远大于收益。
 *
 * 这里改成：上一镜播完的那一刻把**末帧抓成一张位图**盖在新视频上面，
 * 再让这张位图按转场类型退场。新的一镜在底下正常播。
 *
 * ### 这是近似，近似在哪一处必须说清楚
 *
 * `xfade` 混合的是**两段都在动**的画面；这里出场的一路是**定格**的。于是：
 *   - 闪黑 / 闪白：视觉上等价（中间那一下本来就是纯色，谁在动都看不见）
 *   - 擦除 / 滑动 / 圆形开合：几何完全一致，只是被推走的那半幅不再动，
 *     0.3~1s 的转场里几乎看不出来
 *   - 叠化 / 溶解：最明显的一档，真实效果里旧画面还在动。仍足够判断
 *     "这里有一次叠化、时长合不合适"，但不能拿它当成片验收
 *
 * 组件因此在 title 里**明说**自己是预览，不假装等于成片。要像素级一致
 * 只能预渲染接缝片段 —— 那要落盘、要等，且网页端根本没有 ffmpeg。
 *
 * ## 为什么自己跑 rAF 而不用 CSS transition
 *
 * 圆形开幕要的是"旧画面中间破一个越来越大的洞"，CSS 表达不了（clip-path
 * 的 circle() 只能留下一个圆盘，做不出洞；mask-image 里的 radial-gradient
 * 又不可插值）。逐帧自己算 progress 之后，六种 motion 用同一套写法就都能
 * 表达，还顺带解决了两个 CSS 方案自带的毛病：
 *   - 挂载同一帧改样式会被当成初始值，动画一帧都不跑
 *   - clip-path 与 opacity 各自触发 transitionend，被打断时一次都不来，
 *     清理逻辑收不干净，这层就会永远糊在画面上
 */

import { useEffect, useRef, useState } from "react";
import type { TransitionMotion } from "../effects/transitionCatalog";
import "./SeamTransition.css";

export interface SeamTransitionProps {
  /** 上一镜末帧的位图（dataURL）。抓不到时为 null —— 此时只放"闪色"那一类
   *  不需要旧画面的转场，其余直接跳过，绝不拿黑屏冒充末帧。 */
  snapshot: string | null;
  motion: TransitionMotion;
  durationSec: number;
  /** 转场中文名，用于 title 说明 */
  name: string;
  /** 动画跑完（或被卸载）后通知父组件清理 */
  onDone: () => void;
}

/** 出场层（= 旧画面）在进度 u 时的样式。u: 0 = 刚开始，1 = 完全让位。 */
function layerStyleAt(m: TransitionMotion, u: number): React.CSSProperties {
  switch (m.kind) {
    case "crossfade":
      return { opacity: 1 - u };
    case "flash":
      // 旧画面在前半程淡出，后半程完全交给纯色层
      return { opacity: Math.max(0, 1 - u * 2) };
    case "slide":
      return { transform: `translate(${m.dx * u * 100}%, ${m.dy * u * 100}%)` };
    case "wipe": {
      const p = (u * 100).toFixed(2) + "%";
      const inset = {
        left: `inset(0 ${p} 0 0)`,
        right: `inset(0 0 0 ${p})`,
        up: `inset(0 0 ${p} 0)`,
        down: `inset(${p} 0 0 0)`,
      }[m.dir];
      return { clipPath: inset };
    }
    case "circle":
      return m.open
        // 开幕：旧画面中间破洞，洞从 0 长到盖满（150% 保证四角也被吃掉）
        ? (() => {
            const r = (u * 150).toFixed(2) + "%";
            const g = `radial-gradient(circle at 50% 50%,`
                    + ` transparent 0 ${r}, #000 ${r})`;
            return { maskImage: g, WebkitMaskImage: g };
          })()
        // 闭幕：旧画面从外圈收拢成一个点
        : { clipPath: `circle(${((1 - u) * 150).toFixed(2)}% at 50% 50%)` };
    case "zoom":
      return { transform: `scale(${(1 + u * 1.2).toFixed(3)})`, opacity: 1 - u };
  }
}

export default function SeamTransition(p: SeamTransitionProps) {
  const { snapshot, motion, durationSec, onDone } = p;
  const [u, setU] = useState(0);
  // onDone 放 ref：父组件每次渲染都会给一个新函数，进依赖数组会把动画重启
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const ms = Math.max(80, durationSec * 1000);
    let raf = 0;
    let t0 = 0;
    const tick = (ts: number) => {
      if (!t0) t0 = ts;
      const next = Math.min(1, (ts - t0) / ms);
      setU(next);
      if (next < 1) raf = requestAnimationFrame(tick);
      else doneRef.current();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [durationSec, snapshot, motion]);

  const title = `转场预览「${p.name}」${durationSec.toFixed(1)}s`
    + "（近似：出场画面为定格末帧，成片以导出为准）";

  // 闪色不需要旧画面也成立（中间那一下是纯色）；其余转场没有末帧就什么都不放 ——
  // 拿黑屏冒充末帧会凭空多出一次闪黑，比没有预览更糟。
  if (!snapshot && motion.kind !== "flash") return null;

  return (
    <div className="fw-seamtr" title={title}>
      {snapshot && (
        <img className="fw-seamtr-layer" src={snapshot} alt=""
             style={layerStyleAt(motion, u)} />
      )}
      {motion.kind === "flash" && (
        <div className="fw-seamtr-layer"
             style={{
               background: motion.color,
               // 0 → 1 → 0：中点为纯色，两端透明
               opacity: 1 - Math.abs(2 * u - 1),
             }} />
      )}
    </div>
  );
}
