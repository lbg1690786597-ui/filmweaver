/**
 * features/timeline/trim.ts — 修剪（trim）的纯计算
 *
 * ## 为什么要单独一个模块
 *
 * 修剪的数学原本内联在 `Timeline.tsx` 的 mousemove 闭包里，于是它**无法被验证**：
 * 唯一的检验方式是人拿鼠标去拖。而这里每一个边界都会直接变成用户看得见的事故：
 * 钳错了 → 长镜被砍一半；量化错了 → 拖不动或抖动；固定边算错了 → 拖左边缘时
 * 右边缘跟着跑。抽成纯函数后 `verify-trim.ts` 能把这些逐条钉住。
 *
 * ## 为什么步进是 0.1 秒而不是整秒
 *
 * 原来是 `Math.round(startSec + delta)`，即**只能整秒**。后果不是"精度不够"，
 * 而是**这个软件不能用来剪片**：一句台词说完在 2.4s，用户只能选 2s（切掉半个字）
 * 或 3s（留 0.6s 空镜）。所有真实剪辑器都以帧为单位。
 *
 * 这里取 0.1s 而不是"帧"，是因为**前端此刻拿不到可靠的帧率**：源视频的 fps 只在
 * ffprobe（导出侧）才有，`<video>` 元素不暴露 fps。用一个猜的 fps 去量化，
 * 会得到"看起来精确、实际对不齐"的假精度。0.1s 是诚实的：
 *   · 25fps 下 0.1s = 2.5 帧，够用（人眼分辨镜头长短的阈值远大于此）
 *   · 后端按 2 位小数落库，0.1 的量化不会被四舍五入吃掉
 *   · 60px/s（ZOOM_MAX）下 0.1s = 6px，拖起来是"一格一格"的、跟手的
 * 等哪天真拿到 fps（导出侧已有），把 TRIM_STEP_SEC 换成 1/fps 即可，
 * 调用方一行都不用改。
 *
 * ## 本文件分两段
 *
 *   ① 量化与"改时长"（3.2）：`quantizeSec` / `round2` / `trimOut`
 *   ② 取片窗口，即入点/出点（3.1）：`trimIn` / `outPatch` / `inPatch` …
 *      ——为什么"改时长"和"改窗口"是两件事，见第二段开头的长注释。
 */

/** 修剪的时间步进（秒）。见文件头：为什么不是 1/fps。 */
export const TRIM_STEP_SEC = 0.1;

/** 量化到 TRIM_STEP_SEC 的整数倍。
 *
 *  先乘再除是必要的：`Math.round(x / 0.1) * 0.1` 会产出 2.9000000000000004，
 *  它会以 `2.9000000000000004s` 的形式出现在 tooltip 和请求体里。 */
export function quantizeSec(sec: number, step = TRIM_STEP_SEC): number {
  const inv = 1 / step;
  return Math.round(sec * inv) / inv;
}

/** 收敛到 2 位小数（后端 `clip_dur_sec` / `duration_sec` 的落库精度）。
 *
 *  用在"固定边减去移动边"这类减法结果上：被减数可能是分割留下的 2 位小数
 *  （`split_shot` 存的是 `round(x, 2)`），减完会带出浮点尾巴。 */
export function round2(sec: number): number {
  return Math.round(sec * 100) / 100;
}

/**
 * 拖**右边缘**（出点）：入点不动，时长跟着鼠标位移变。
 *
 * @param durSec   按下鼠标时的时长
 * @param deltaSec 鼠标横向位移换算成的秒数（向右为正）
 * @param minSec   最短时长（见 `minTrimSec`）
 * @param maxSec   最长时长（项目模型的单镜上限，见 `shot_duration_ceiling`）
 * @returns 新时长（已量化并钳制）
 */
export function trimOut(
  durSec: number, deltaSec: number, minSec: number, maxSec: number,
): number {
  return Math.max(minSec, Math.min(maxSec, quantizeSec(durSec + deltaSec)));
}

/* ==========================================================================
 * 3.1 取片窗口（入点 / 出点）
 *
 * ## 两个时长概念，别混
 *
 *   · `duration_sec`   —— 时间轴上显示的、也是**未出片时的生成目标**时长
 *   · `clip_in_sec` / `clip_dur_sec` —— 在**已有素材**上的取片窗口 `[in, in+dur)`，
 *     导出（`render/normalize.ts`）与字幕定时（后端 `effective_shot_sec`）
 *     消费的是它，**优先于** `duration_sec`
 *
 * 3.2 之前只有 `duration_sec` 能改，于是对一个**被 split 过的**镜头拖右边缘：
 * 时间轴变短了、导出长度纹丝不动（导出读的是没变的 `clip_dur_sec`）。
 * 本节把窗口纳入 PATCH 通路，并维持 `duration_sec == clip_dur_sec` ——
 * 这条不变式 `split_shot` / `unsplit_shot` 一直在维持，这里补上第三个写入者。
 *
 * ## 为什么"有没有窗口"要决定发什么字段
 *
 * 没窗口的镜头，`duration_sec` 同时是**生成目标**（provider 拿它要时长）。
 * 给一个还没出片的镜头写 `clip_dur_sec`，等于宣称"在不存在的素材上取片"，
 * 且从此 `duration_sec` 再也不是生成目标。所以**只在窗口已存在时才写窗口**，
 * 否则老老实实只改 `duration_sec`（导出侧 `clip_dur_sec ?? duration_sec`
 * 的兜底会让它照样生效）。这就是 `outPatch` 的全部内容。
 * ========================================================================== */

/** 最短取片窗口（秒）。
 *
 *  **不是** 1s：`split_shot` 只保证两侧各留 0.5s，dev 库里就有 0.75s / 0.99s 的
 *  真实行。若这里floor 到 1s，用户拖一个 0.75s 的碎片时会被**拉长**到 1s ——
 *  想剪短反而变长，属于静默损坏。窗口是"在已有素材上取片"，不受生成侧档位约束。 */
export const MIN_WINDOW_SEC = 0.1;

/** 未修剪过的镜头能被拖到的最短时长（秒）。
 *
 *  它约束的是**生成时长**（没有窗口的镜头改的是 `duration_sec`），
 *  所以底是 1s 而不是 `MIN_WINDOW_SEC`。两者的区别见 `minTrimSec`。
 *
 *  3.3 把它从 `Timeline.tsx` 提到这里：I/O 快捷键要和拖边缘用**同一个**下限，
 *  各写一份迟早会漂成"拖能拖到 1s、按 O 能按到 0.5s"。 */
export const MIN_CLIP_SEC = 1;

/** 拿不到项目上限时的兜底（= seedance-2.0 / veo 的 15s）。
 *
 *  真实上限由服务端 `detail.shot_duration_max` 下发——seedance-2.5 是 30s，
 *  在这里写死 15 会让用户随手拖一下就把 28s 的长镜砍掉一半。 */
export const MAX_CLIP_SEC_FALLBACK = 15;

/** 后端 Shot 里与取片窗口有关的那几个字段（只取本模块要用的，避免依赖 api.ts） */
export interface ClipWindowSource {
  duration_sec?: number | null;
  clip_in_sec?: number | null;
  clip_dur_sec?: number | null;
  video_url?: string | null;
}

/** 该镜头是否已经有显式取片窗口（split 过、或此前修剪过入点）。
 *
 *  判据是 `clip_dur_sec` 而不是 `clip_in_sec`：入点为 0 的头段
 *  （`split_shot` 存的就是 `clip_in_sec=0`）同样是有窗口的。 */
export function hasClipWindow(s: ClipWindowSource): boolean {
  return s.clip_dur_sec != null && s.clip_dur_sec > 0;
}

/** 入点（秒）。没有窗口 = 从素材开头起算。 */
export function inPointOf(s: ClipWindowSource): number {
  return s.clip_in_sec != null && s.clip_in_sec > 0 ? round2(s.clip_in_sec) : 0;
}

/** 窗口长度（秒）。没有窗口时退回 `duration_sec`——与导出侧
 *  `clip_dur_sec ?? duration_sec` 同口径。 */
export function windowDurOf(s: ClipWindowSource): number {
  if (hasClipWindow(s)) return round2(s.clip_dur_sec as number);
  return round2(s.duration_sec ?? 0);
}

/** 出点（秒，相对素材开头）= 入点 + 窗口长度。 */
export function outPointOf(s: ClipWindowSource): number {
  return round2(inPointOf(s) + windowDurOf(s));
}

/** 这一镜的最短时长：常规 1s，但**已经比 1s 短的**碎片以自身为底
 *  （见 `MIN_WINDOW_SEC` 的说明：不能把想剪短的东西拉长）。 */
export function minTrimSec(s: ClipWindowSource, minClipSec: number): number {
  const cur = windowDurOf(s);
  const floor = hasClipWindow(s) ? MIN_WINDOW_SEC : minClipSec;
  return Math.min(floor, cur > 0 ? cur : floor);
}

/** PATCH 载荷（`api.patchShotTimeline` 的子集，字段名与它一致） */
export interface TrimPatch {
  durationSec?: number;
  clipInSec?: number;
  clipDurSec?: number;
  clearClipWindow?: boolean;
}

/**
 * 改**出点**（拖右边缘 / Inspector 时长输入框）→ 该发什么 patch。
 *
 * 有窗口 → 同时写 `clipDurSec`，否则导出长度不跟着变（3.2 遗留的那个缺口）。
 * 没窗口 → 只写 `durationSec`，不平白给未出片的镜头造一个窗口（见本节顶部说明）。
 */
export function outPatch(s: ClipWindowSource, newDurSec: number): TrimPatch {
  const dur = round2(newDurSec);
  return hasClipWindow(s) ? { durationSec: dur, clipDurSec: dur } : { durationSec: dur };
}

/**
 * 拖**左边缘**（入点）：出点钉住不动，入点跟鼠标走。
 *
 * @param inSec    按下鼠标时的入点
 * @param outSec   出点（本次拖动全程不变——这正是"修剪入点"的定义）
 * @param deltaSec 鼠标横向位移换算成的秒数（向右为正 = 掐掉更多开头）
 * @param minSec   最短窗口长度（见 `minTrimSec`）
 * @param maxSec   最长窗口长度（项目模型的单镜上限）
 *
 * 只量化**移动的那条边**，再用减法得到时长：
 * 若两条边各自量化，固定边会在拖动过程中来回漂 0.05s（用户看到"我拖左边，
 * 右边自己动了"）。时长用 `round2` 收尾，因为被减数可能是 split 留下的
 * 2 位小数，相减会带出浮点尾巴。
 */
export function trimIn(
  inSec: number, outSec: number, deltaSec: number, minSec: number, maxSec: number,
): { inSec: number; durSec: number } {
  // 入点的合法区间由"出点不动"直接推出：
  //   下界 0（不能取到素材开头之前），以及 out-maxSec（窗口不能超过单镜上限）
  //   上界 out-minSec（不能把窗口掐成 0）
  const lo = Math.max(0, outSec - maxSec);
  const hi = Math.max(lo, outSec - minSec);
  const nextIn = Math.max(lo, Math.min(hi, quantizeSec(inSec + deltaSec)));
  return { inSec: nextIn, durSec: round2(outSec - nextIn) };
}

/** 改**入点**（拖左边缘）→ 该发什么 patch。
 *
 *  三个字段一起发：`clipInSec` 是入点本身，`clipDurSec` 是新窗口长度，
 *  `durationSec` 维持 `== clipDurSec` 的不变式（否则时间轴布局与导出长度打架）。
 *  没窗口的镜头拖左边缘就是**创建**窗口 —— 这是唯一允许凭空造窗口的入口，
 *  且调用方必须先确认该镜有素材（`video_url`），见 `canTrimIn`。 */
export function inPatch(newInSec: number, newDurSec: number): TrimPatch {
  return {
    durationSec: round2(newDurSec),
    clipInSec: round2(newInSec),
    clipDurSec: round2(newDurSec),
  };
}

/** 能不能修剪入点：必须**已经有素材**。
 *
 *  未出片的镜头没有"素材开头"可言，给它设入点只会让 `duration_sec`
 *  不再是生成目标，生成出来的片子和窗口对不上。所以左手柄对未出片的镜头不渲染。 */
export function canTrimIn(s: ClipWindowSource): boolean {
  return !!(s.video_url && String(s.video_url).trim());
}

/** 取消入点 → 该发什么 patch（回到"从素材开头起算"，长度不变）。
 *
 *  注意它**不是**"还原完整素材"：后端不知道源文件多长，清掉窗口后导出取的是
 *  `clip_dur_sec ?? duration_sec` = 现有 `duration_sec`，只是起点回到 0。 */
export function clearWindowPatch(): TrimPatch {
  return { clearClipWindow: true };
}
