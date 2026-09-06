/**
 * keyframeEdit — 关键帧的**编辑**操作（批次 5 · 5.6）
 *
 * 与已有两个模块的分工，三者不重叠：
 *
 *   `maskGroups.ts`  取值：`normalizeKfs` / `regionBoxAt` / `isAnimated`（唯一真源）
 *   `kfExpr.ts`      导出：同一组关键帧 → ffmpeg 表达式
 *   **本文件**        编辑：插入 / 删除 / 改时刻 / 变速重算 / 轨迹
 *
 * 本文件**不重新定义插值语义**，一次都不。要知道「t 时刻的框」一律调
 * `regionBoxAt`；要知道「有哪几条关键帧」一律调 `normalizeKfs`。
 * 5.5 的教训写在那两个函数的注释里：三处各写一份的下场是"预览对、导出错"，
 * 而且没有任何断言会自然发现。
 *
 * ## 为什么这些逻辑不写在组件里
 *
 * §6.9 的「已验证」只认验证脚本跑绿，而 React 组件在 node 下跑不起来
 * （`src/api.ts:9` 读 `import.meta.env`）。把「按下菱形之后数据变成什么样」
 * 抽成纯函数，`verify-kfedit.ts` 才能把每一条语义钉住 ——
 * 留在 `onClick` 里就只能靠人眼点一遍，那不叫已验证。
 *
 * ## 一条贯穿全文件的不变式（**最重要**）
 *
 *   **只要关键帧数 < 2，静态框（`m.x/y/w/h`）与那条关键帧必须保持一致。**
 *
 * 因为 `regionBoxAt` 与 `kfExpr` 在 `< 2` 条时取的都是**静态框**（5.5 的交叉钉
 * 当场撞出过这个分叉）。若允许「1 条关键帧的值 ≠ 静态框」，用户会遇到
 * **拖了却看不见变化**：拖动写进了那条关键帧，画面却仍按静态框渲染。
 * 所以 `applyRegionBox` / `removeKfAt` 在结果不足 2 条时会把静态框一并同步过去
 * （笔迹按 `remapStroke` 跟着走）。
 */

import type { MosaicParams, RegionKeyframe } from "../render/model";
import { normalizeKfs } from "../render/maskGroups";
import type { Box, Pt } from "./regionShape";
import { remapStroke } from "./regionShape";

/**
 * 「播放头正好落在这条关键帧上」的时间容差（秒）。
 *
 * 取 0.05 = 播放头微调步长 `NUDGE_STEP_SEC`(0.1s) 的一半：按方向键走一格，
 * 落点要么命中某条关键帧、要么明确不命中，不会出现两条关键帧同时"被命中"。
 * 也比 `timeupdate` 的 ~4Hz 采样（≈0.25s）小，所以"看起来停在关键帧上"
 * 与"判定命中"不会各说各话 —— 用户仍需靠迷你时间条上的实心菱形确认。
 */
export const KF_EPS_SEC = 0.05;

/** 该区域归一化后的关键帧（升序、同刻取后者）。唯一入口，不要自己 sort。 */
export function kfsOf(m: MosaicParams): RegionKeyframe[] {
  return normalizeKfs(m.keyframes);
}

export function kfCount(m: MosaicParams): number {
  return kfsOf(m).length;
}

/** 静态框（比例）。`< 2` 条关键帧时它就是真正被渲染的那个框。 */
export function staticBox(m: MosaicParams): Box {
  return { x: m.x, y: m.y, w: m.w, h: m.h };
}

/**
 * 播放头处的关键帧下标（**归一化后**数组的下标），没有则 -1。
 * 有多条落在容差内时取**最近**的一条，不是第一条 —— 否则密集关键帧上
 * 「点菱形删掉的」和「实心菱形指的」可能不是同一条。
 */
export function findKfIndexAt(
  m: MosaicParams, tSec: number, eps: number = KF_EPS_SEC,
): number {
  const ks = kfsOf(m);
  // ⚠️ 比的是浮点距离，`d <= eps` 在**正好等于** eps 时是掷硬币：
  // `(1+0.05)-1` 实际算出 0.050000000000000044 > 0.05，于是"边界算不算命中"
  // 取决于这两个数是怎么来的。给个 1e-9 的模糊量，让边界行为可预期 ——
  // 播放头精度是 0.1s，1e-9 不可能把不该命中的判成命中。
  const lim = eps + 1e-9;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < ks.length; i++) {
    const d = Math.abs(ks[i].tSec - tSec);
    if (d <= lim && d < bestD) { best = i; bestD = d; }
  }
  return best;
}

/** 把静态框搬到 `box`，笔迹同步仿射映射。`< 2` 条关键帧时的唯一真源就是它。 */
function syncStatic(m: MosaicParams, box: Box): MosaicParams {
  const stroke = remapStroke(m.stroke, staticBox(m), box);
  const out: MosaicParams = { ...m, x: box.x, y: box.y, w: box.w, h: box.h };
  if (stroke) out.stroke = stroke;
  return out;
}

/**
 * 在画面上把区域拖到了 `box` —— **一条路径同时覆盖静态与动画两种区域**。
 *
 *  - 没有关键帧：老行为，直接改静态框（笔迹跟着仿射映射）
 *  - 有关键帧：在 `tSec` 处**插入或更新**一条关键帧；静态框与笔迹**不动**
 *    （`regionShapeAt` / `rasterGroupMask` 会把笔迹从静态框映射到当帧的框，
 *    这里再动一次就是动了两次）
 *  - 结果不足 2 条：把静态框同步过去（见文件头的不变式）
 *
 * 命中已有关键帧时**保留它原本的 `tSec`**，不改用当前播放头时间：
 * 反复微调同一条关键帧不该让它在时间轴上慢慢漂走。
 */
export function applyRegionBox(m: MosaicParams, tSec: number, box: Box): MosaicParams {
  const ks = kfsOf(m);
  if (ks.length === 0) return syncStatic(m, box);

  const t = Math.max(0, tSec);
  const i = findKfIndexAt(m, t);
  const kf: RegionKeyframe = { tSec: i >= 0 ? ks[i].tSec : t, ...box };
  const next = i >= 0
    ? ks.map((k, j) => (j === i ? kf : k))
    : normalizeKfs([...ks, kf]);

  const out: MosaicParams = { ...m, keyframes: next };
  return next.length < 2 ? syncStatic(out, box) : out;
}

/**
 * 在 `tSec` 处记一条关键帧（菱形按钮的"插入"）。
 * 记的是**当前这一帧看到的框**（`regionBoxAt`），所以第一次点菱形
 * 画面不会有任何跳动 —— 只是把现状固定下来。
 */
export function insertKfAt(m: MosaicParams, tSec: number, boxAtT: Box): MosaicParams {
  const t = Math.max(0, tSec);
  const ks = kfsOf(m);
  const next = normalizeKfs([...ks, { tSec: t, ...boxAtT }]);
  const out: MosaicParams = { ...m, keyframes: next };
  return next.length < 2 ? syncStatic(out, boxAtT) : out;
}

/**
 * 删掉播放头处的那条关键帧（菱形按钮的"删除" / 迷你时间条右键）。
 *
 * 删到只剩 1 条时把静态框同步成**那条剩下的**：否则区域会瞬间跳回
 * 做动画之前的老位置（静态框从没被动画路径更新过），用户看到的是
 * "删了一个关键帧，整块遮挡飞走了"。
 * 删到 0 条时静态框已等于那条曾经剩下的（不变式保证），无需再动。
 */
export function removeKfAt(
  m: MosaicParams, tSec: number, eps: number = KF_EPS_SEC,
): MosaicParams {
  const i = findKfIndexAt(m, tSec, eps);
  if (i < 0) return m;
  const ks = kfsOf(m);
  const next = ks.filter((_, j) => j !== i);
  const out: MosaicParams = { ...m };
  if (next.length) out.keyframes = next; else delete out.keyframes;
  if (next.length === 1) {
    const k = next[0];
    return syncStatic(out, { x: k.x, y: k.y, w: k.w, h: k.h });
  }
  return out;
}

/**
 * 清空关键帧，区域退回静态。静态框保持当前值（不变式下它就是最后一条的值）。
 *
 * 6.5 起一并清掉 `track`：那个字段是"这些关键帧是跟踪出来的"的说明，
 * 关键帧都没了还留着它，面板会显示「已跟踪」而区域其实是静态的。
 */
export function clearKfs(m: MosaicParams): MosaicParams {
  const out: MosaicParams = { ...m };
  delete out.keyframes;
  delete out.track;
  return out;
}

/**
 * 整组替换关键帧（6.5：跟踪结果落盘的唯一入口）。
 *
 * 与逐条编辑的区别只在"一次换掉全部"，**不变式仍然照守**：
 * 结果不足 2 条时把静态框同步成剩下的那条，否则用户会看到
 * 「跟踪说成功了，画面却纹丝不动」。
 *
 * `track` 元数据**只在真写进了动画（≥2 条）时才留**。跟踪跟丢、只攒到 1 个
 * 可信样本时 `runTrack` 返回空数组（见 `track.ts` 的规则 2），这里随之
 * 连徽标一起不写 —— 「不把烂数据写进去」不只是不写关键帧，也包括不写
 * 一个会让用户以为成功了的标记。
 */
export function replaceKfs(
  m: MosaicParams, kfs: RegionKeyframe[], track?: MosaicParams["track"],
): MosaicParams {
  const next = normalizeKfs(kfs);
  const out: MosaicParams = { ...m };
  if (next.length) out.keyframes = next; else delete out.keyframes;
  if (track && next.length >= 2) out.track = track; else delete out.track;
  if (next.length === 1) {
    const k = next[0];
    return syncStatic(out, { x: k.x, y: k.y, w: k.w, h: k.h });
  }
  return out;
}

/**
 * 把第 `idx` 条关键帧挪到 `newTSec`（迷你时间条上横向拖）。
 *
 * 拖到与另一条重合时**拖动的这条赢**：把它排到同刻那条的后面再交给
 * `normalizeKfs`（同刻取后者），符合"后写的赢"的直觉。
 * 依赖 `Array.prototype.sort` 的稳定性（ES2019 起是规范保证）。
 */
export function retimeKf(
  m: MosaicParams, idx: number, newTSec: number, durSec: number,
): MosaicParams {
  const ks = kfsOf(m);
  if (idx < 0 || idx >= ks.length) return m;
  const hi = durSec > 0 ? durSec : Infinity;
  const t = Math.max(0, Math.min(hi, newTSec));
  const moved: RegionKeyframe = { ...ks[idx], tSec: t };
  const next = normalizeKfs([...ks.filter((_, j) => j !== idx), moved]);
  const out: MosaicParams = { ...m, keyframes: next };
  return next.length < 2
    ? syncStatic(out, { x: next[0].x, y: next[0].y, w: next[0].w, h: next[0].h })
    : out;
}

/**
 * 镜内素材秒 → 关键帧用的**输出秒**。
 *
 * 全项目的播放头口径是「素材时间 − 入点」（`usePlayer.ts:68` 的 `toShotTime`，
 * `shotDuration` 同样取的是取片窗口长度），**不含变速**；而 `tSec` 存的是
 * 滤镜里的 `t`，也就是变速之后的**输出时间**（见 `rescaleKfTimes` 的注释）。
 * 两者只在 speed=1 时相等。
 *
 * 面板的迷你时间条与画面上的拖拽必须走**同一个**换算，否则同一个播放头位置
 * 在两处算出两个 `tSec`：菱形显示"这里没有关键帧"，拖一下却更新了另一条。
 * 所以换算只此一份，两边都调它。
 */
export function outputSec(shotSec: number, speed: number | undefined): number {
  const sp = Math.max(0.25, Math.min(4, speed ?? 1));
  return Math.max(0, shotSec) / sp;
}

/** `outputSec` 的逆：输出秒 → 镜内素材秒（面板点时间条要跳播放头时用）。 */
export function shotSecOf(outSec: number, speed: number | undefined): number {
  const sp = Math.max(0.25, Math.min(4, speed ?? 1));
  return Math.max(0, outSec) * sp;
}

/** 关键帧中心点轨迹（比例坐标），按时间升序。缩略图里画成折线。 */
export function trajectory(m: MosaicParams): Pt[] {
  return kfsOf(m).map((k) => ({ x: k.x + k.w / 2, y: k.y + k.h / 2 }));
}

/**
 * 变速后重算关键帧时刻。
 *
 * ⚠️ `tSec` 存的是**输出时间**（马赛克串在 `clipVideoChain` 之后，而变速
 * `setpts` 在链内，滤镜里的 `t` 已经是变速后的时间；见 `model.ts` 的字段注释）。
 * 速度 1× → 2× 时同一个画面内容出现的输出时刻**减半**，所以
 * `factor = 旧速 / 新速`。不重算的话，用户一改变速，所有遮挡都在错误的时刻动。
 */
export function rescaleKfTimes(m: MosaicParams, factor: number): MosaicParams {
  const ks = kfsOf(m);
  if (!ks.length || !Number.isFinite(factor) || factor <= 0 || factor === 1) return m;
  return { ...m, keyframes: ks.map((k) => ({ ...k, tSec: k.tSec * factor })) };
}

/**
 * 一个镜头上全部区域的变速重算。返回**受影响的区域个数**，供调用方决定
 * 要不要 toast —— 悄悄改用户的数据和不改一样糟。
 */
export function rescaleMosaicsForSpeed(
  mosaics: MosaicParams[] | undefined, oldSpeed: number, newSpeed: number,
): { mosaics: MosaicParams[]; changed: number } {
  const list = mosaics ?? [];
  const factor = oldSpeed / newSpeed;
  if (!list.length || !Number.isFinite(factor) || factor <= 0 || factor === 1) {
    return { mosaics: list, changed: 0 };
  }
  let changed = 0;
  const out = list.map((m) => {
    if (kfCount(m) === 0) return m;
    changed++;
    return rescaleKfTimes(m, factor);
  });
  return { mosaics: changed ? out : list, changed };
}
