/**
 * render/maskGroups.ts —— 区域分组策略（批次 5 · 5.3）
 *
 * `planMaskGroups` 把一个 clip 上的马赛克区域切成若干「合成组」，每组对应
 * 编译器里的**一条滤镜链**。§5.3 的结论是「逐区域 / 并集包围盒 / 全画幅」
 * 不是三选一，而是**同一张滤镜图的三个 `crop` 取值**：
 *
 *   [fg]  crop=BW:BH:BX:BY , {effect} , scale=BW:BH , format=yuva420p [p];
 *   [mask]crop=BW:BH:BX:BY , format=gray                              [m];
 *   [p][m] alphamerge [pa];  [bg][pa] overlay=BX:BY
 *
 * 所以策略全部封闭在本文件里，编译器（5.4）只管照着 `box` 拼字符串。
 * 未来调优只改这里 + 这里的表驱动单测，**不再动编译器** —— 这正是
 * §5.4「一次到位，不打补丁」要的形状。
 *
 * ## 三个刻意的设计决定
 *
 * ### ① `box` 是**整数像素**，不是比例
 *
 * 计划书原型写的是 `box: {x,y,w,h}`（比例）。改成整数像素是有意的：
 * §0.5 的教训是「区域的整数宽高只能算一次」——它同时是 `crop` 的字面量、
 * `scale=BW:BH` 的字面量、以及 5.2 光栅化器的蒙版尺寸。让 `planMaskGroups`
 * 返回比例，就等于让下游各自 `Math.round` 一遍，那正是
 * `Input frame sizes do not match` 整段导出崩掉的来源。
 *
 * ### ② `legacy` 组**不带 style**（与计划书原型不同）
 *
 * 原型是 `{ kind:"legacy"; style; regionIdxs }`。但 legacy 组根本不共用滤镜链 ——
 * 它的含义就是「这几个区域照旧逐个走现有代码」，而 style 是**逐区域**的属性。
 * 给它一个组级 style，就被迫按 style 拆组，从而**打乱既有区域顺序**，
 * 把 §5.3.1 的零回归条款自己拆掉。故去掉该字段。
 *
 * ### ③ 空笔迹的 brush 区域**整条丢弃**
 *
 * 现有编译器对「shape=brush 但 stroke 为空」是整区跳过（`regionShapeOf` 把它降为
 * rect，brush 分支随即 `return`）。若把它当成 rect 交给蒙版路径，会**凭空画出一个
 * 满框矩形**——今天什么都不画的区域，明天糊上一块。故在这里就丢掉，
 * `regionIdxs` 也因此不保证覆盖 `0..n-1`。
 */

import type { MosaicParams, MosaicStyle, RegionKeyframe } from "./model";

/** 整数像素框。`w/h` 恒为偶数且 ≥2，`x/y` 恒为偶数且框完全落在画布内。 */
export interface BoxPx { x: number; y: number; w: number; h: number }

export type MaskGroup =
  /** 走**现有**的 drawbox / split-crop-overlay 分支：不生成蒙版文件、不注册额外 `-i` */
  | { kind: "legacy"; regionIdxs: number[] }
  /** 走统一蒙版滤镜图；`box` 同时是 crop 参数与蒙版尺寸 */
  | { kind: "mask"; style: MosaicStyle; box: BoxPx; fullFrame: boolean; regionIdxs: number[] };

/**
 * 聚类阈值：两组的并集框面积 < 两组各自框面积之和 × K 时才合并。
 *
 * K > 1 代表「少一条链」本身值点钱（少一次 crop/scale/alphamerge/overlay 与一个磁盘蒙版）。
 * 取值依据是 §5「缺陷 4 已结案」那张实测表（1080×1920，90 帧）：
 * 5 个**聚集**区域并集 28.1× 完胜逐区域 15.1×；5 个**分散**区域并集 9.44× 惨败。
 * 1.5 落在这两种形态之间，验证脚本用两侧的真实形态各钉一条。
 */
export const CLUSTER_K = 1.5;

/**
 * 框面积超过画布这个比例时，直接退化为整幅（crop 成为 no-op）。
 * 依据同一张表：全画幅**对区域数量完全免疫**（14.7× → 15.2×），
 * 而「85% 的大框」是所有形态里最差的一个点——既没省下像素，又付了 crop/overlay 的钱。
 */
export const FULL_FRAME_RATIO = 0.75;

/** 比例框（0..1） */
export interface BoxRel { x: number; y: number; w: number; h: number }
/** 浮点像素框，聚类过程中用；只在最后 `alignBox` 一次 */
interface BoxF { x: number; y: number; w: number; h: number }

export interface CanvasPx { w: number; h: number }

/**
 * 关键帧归一化：**按 `tSec` 升序**，同一时刻只保留**最后**一条。
 *
 * 全工程只有这一处定义「一组关键帧到底是哪几条、什么顺序」——
 * `regionBoxAt`（逐帧取框）、`isAnimated`（算不算动画）、5.5 的 `kfExpr`
 * （生成 ffmpeg 表达式）三处都从这里取，不各自 `sort` 一遍。
 *
 * 两条规则的理由：
 *  - **排序**：UI 可能乱序插入（在已有关键帧之前的位置补一条）。
 *  - **同刻去重取后者**：用户把一条关键帧拖到另一条头上时，"后写的赢"符合直觉；
 *    若保留两条，同一时刻会有两个取值，`regionBoxAt` 与 `kfExpr` 必然在这一点上
 *    分叉（一个先判夹持、一个先判分段），而这种分叉正是"预览对、导出错"的样子。
 */
export function normalizeKfs(kfs: RegionKeyframe[] | undefined): RegionKeyframe[] {
  if (!kfs || !kfs.length) return [];
  const sorted = [...kfs].sort((a, b) => a.tSec - b.tSec);
  const out: RegionKeyframe[] = [];
  for (const k of sorted) {
    if (out.length && out[out.length - 1].tSec === k.tSec) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/** 有 ≥2 个**不同时刻**的关键帧才算动画 */
export function isAnimated(m: MosaicParams): boolean {
  return normalizeKfs(m.keyframes).length >= 2;
}

/** 今天什么都不画的区域（brush 但笔迹为空）——见文件头决定 ③ */
export function isNoOpRegion(m: MosaicParams): boolean {
  return m.shape === "brush" && (m.stroke?.length ?? 0) === 0;
}

/**
 * 区域在**整段时间**上的包围盒（比例）。
 *
 * 关键帧之间是线性插值，端点夹持为常量，于是任意 t 的框都满足
 * `x(t) ≥ min(x_i)` 且 `x(t)+w(t) ≤ max(x_i+w_i)` —— 所以逐关键帧取 min/max
 * 得到的就是**紧确**的时间并集，不是保守放大。
 * （`crop` 的 w/h 只在配置期求值、不能动画，故必须取整段的并集。）
 */
export function timeUnionBox(m: MosaicParams): BoxRel {
  // 与 isAnimated/regionBoxAt 走同一个归一化：否则「两条同刻关键帧」会出现
  // 「不算动画、却仍按并集扩框」的自相矛盾状态
  const kfs = normalizeKfs(m.keyframes);
  if (kfs.length < 2) return { x: m.x, y: m.y, w: m.w, h: m.h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of kfs) {
    x0 = Math.min(x0, k.x); y0 = Math.min(y0, k.y);
    x1 = Math.max(x1, k.x + k.w); y1 = Math.max(y1, k.y + k.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 区域在 **t 时刻**的包围盒（比例）。关键帧之间线性插值，**首尾夹持为常量**（不外推）。
 *
 * 与 `timeUnionBox` 的分工：那个给的是「整段时间的并集」，用来定 `crop` 的框
 * （w/h 不能动画）；这个给的是「某一帧真正该遮哪」，用来光栅化那一帧的蒙版。
 *
 * ⚠️ **5.5 的 `interpolateRegion` 就是本函数**，不要再写第二份：预览要用它、
 * 蒙版序列要用它、`kfExpr` 生成的 ffmpeg 表达式还要与它逐点一致。
 * 三处各写一份的下场是"预览对、导出错"，而且没有任何断言会自然发现。
 *
 * 关键帧不要求有序、也允许同刻重复（UI 可能乱序插入 / 拖重叠），
 * 统一由 `normalizeKfs` 处理 —— **5.5 的 `kfExpr` 用的是同一个归一化**，
 * 两边因此不可能在"到底有哪几条关键帧"上分叉。
 */
export function regionBoxAt(m: MosaicParams, tSec: number): BoxRel {
  const ks = normalizeKfs(m.keyframes);
  if (ks.length < 2) return { x: m.x, y: m.y, w: m.w, h: m.h };
  const at = (k: RegionKeyframe): BoxRel => ({ x: k.x, y: k.y, w: k.w, h: k.h });
  if (tSec <= ks[0].tSec) return at(ks[0]);
  const last = ks[ks.length - 1];
  if (tSec >= last.tSec) return at(last);
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (tSec < a.tSec || tSec > b.tSec) continue;
    const span = b.tSec - a.tSec;
    // 归一化后同刻重复已消失，span 恒 > 0；这行只是防御，不产生 0/0
    const u = span <= 0 ? 1 : (tSec - a.tSec) / span;
    return {
      x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u,
      w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u,
    };
  }
  return at(last);
}

/**
 * 羽化宽度换算成像素。**全工程只有这一处**做这个换算。
 * `feather` 的语义是「占区域**短边**的百分比」，所以同一个数值在大区域上更宽 ——
 * 与用户"羽化看起来是相对这块区域的"的直觉一致。
 */
export function featherPxOf(m: MosaicParams, canvas: CanvasPx): number {
  const f = Math.max(0, Math.min(100, m.feather ?? 0));
  if (f === 0) return 0;
  const box = timeUnionBox(m);
  const shortSide = Math.min(box.w * canvas.w, box.h * canvas.h);
  return (f / 100) * shortSide;
}

/**
 * §5.3.1 的零回归判定：**矩形 + 无羽化 + 无关键帧** 才可以留在现有代码路径上。
 *
 * 形状判定走 `shape ?? "rect"` —— 与现有编译器 176 行的写法逐字同义，
 * 老数据（没有 `shape` 字段）自然落在 rect。
 */
export function legacyEligible(m: MosaicParams): boolean {
  const shape = m.shape ?? "rect";
  return shape === "rect" && (m.feather ?? 0) <= 0 && !isAnimated(m);
}

const evenDown = (v: number) => Math.floor(v / 2) * 2;
const evenUp = (v: number) => Math.ceil(v / 2) * 2;

/**
 * 浮点像素框 → 合法的整数像素框：**向外**取偶、夹进画布、最小 2×2。
 *
 * 为什么 x/y 也必须是偶数（不只是 w/h）：`vf_crop` 会把 x、y、w、h 统统按色度取样格
 * 对齐（yuv420p 下即向下取偶），而蒙版是 **gray**（无色度、不对齐）。
 * x 写成奇数，视频那侧会被悄悄挪到 x-1，蒙版却按 x 光栅化 —— 结果是**整体错位 1px**，
 * 不报错、不崩、只是遮挡歪了。验证脚本第 9 节用真 ffmpeg 实测了这条对齐行为。
 *
 * 一律**向外**扩（floor/ceil 而非 round）：宁可多遮一两个像素，也不能少遮 ——
 * 少遮就是用户该挡住的东西露出来。
 */
export function alignBox(b: BoxF, canvas: CanvasPx): BoxPx {
  const capW = Math.max(2, evenDown(canvas.w));
  const capH = Math.max(2, evenDown(canvas.h));

  let x0 = evenDown(Math.max(0, Math.floor(b.x)));
  let y0 = evenDown(Math.max(0, Math.floor(b.y)));
  let x1 = Math.min(capW, evenUp(Math.ceil(b.x + b.w)));
  let y1 = Math.min(capH, evenUp(Math.ceil(b.y + b.h)));

  // 夹持后可能塌成 0 宽/高（区域整体在画布外，或本来就极小）：往回让出 2px
  if (x1 - x0 < 2) { x1 = Math.min(capW, x0 + 2); x0 = Math.max(0, x1 - 2); }
  if (y1 - y0 < 2) { y1 = Math.min(capH, y0 + 2); y0 = Math.max(0, y1 - 2); }

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 区域的「足迹」：时间并集框 → 像素 → 外扩羽化。**未**取偶（留到分组结束再对齐一次）。 */
function footprintOf(m: MosaicParams, canvas: CanvasPx): BoxF {
  const rel = timeUnionBox(m);
  const fp = featherPxOf(m, canvas);
  return {
    x: rel.x * canvas.w - fp,
    y: rel.y * canvas.h - fp,
    w: rel.w * canvas.w + 2 * fp,
    h: rel.h * canvas.h + 2 * fp,
  };
}

function unionF(a: BoxF, b: BoxF): BoxF {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const areaF = (b: BoxF) => Math.max(0, b.w) * Math.max(0, b.h);

/** 两个足迹是否在像素上有交叠（边贴边不算） */
export function boxesOverlap(a: BoxF, b: BoxF): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 「效果键」：**同一条滤镜链只能施加一种效果**，所以能并组的前提不只是 style 相同，
 * `intensity` 也必须相同 —— 一条链上只有一个 `blockSize` / 一个 `sigma`。
 *
 * ⚠️ 这一条是首轮 68/69 全绿后复查出来的真缺陷：计划书原话是「先按 `style` 分组」，
 * 照字面写就会把「人脸 intensity=90」和「台标 intensity=20」并进一条链，
 * 两块遮挡一起变成同一个强度 —— 不报错，只是用户调的参数被悄悄丢了一个。
 *
 * 两个刻意的取舍：
 *  - **不比较量化后的值**（`blockSize` / `sigma` 会把相近 intensity 映射到同一档）。
 *    那样等于把编译器的量化规则抄一份到这里，编译器一改这里就悄悄漂移。
 *    宁可少并一次组，也不埋一条跨文件的隐式耦合。
 *  - **blackbox 忽略 intensity**（`model.ts` 的字段注释就是这么定义的，编译器也确实
 *    只发一句 `drawbox=…:color=black@1.0`），故它的键里不带 intensity ——
 *    否则「一排纯黑圆形遮挡」会因为 intensity 恰好不同而拆成好几条链。
 */
export function effectKey(m: MosaicParams): string {
  return m.style === "blackbox" ? "blackbox" : `${m.style}|${m.intensity}`;
}

/** 分组过程中的可变簇。`box` 恒为成员足迹的并集（legacy 簇也维护，免得留下会说谎的字段）。 */
interface Cluster {
  kind: "legacy" | "mask";
  /** 仅 mask 簇有意义：同组共用一条滤镜链，效果必须相同。legacy 簇逐区域编译，用不上。 */
  style: MosaicStyle;
  /** 仅 mask 簇有意义：`effectKey` 的取值，合并的必要条件 */
  key: string;
  box: BoxF;
  idxs: number[];
  minIdx: number;
}

/**
 * 合成顺序安全性。
 *
 * 现有语义是「按区域下标依次叠加，下标大的盖在上面」。分组会把区域重排成
 * 「按组依次叠加」，于是当两个**不同组**的区域在像素上有交叠、而分组把它们的
 * 先后关系颠倒时，画面就变了。聚类只在通过这项检查时才落地。
 *
 * 组间顺序按各组的最小下标排 —— 与 `planMaskGroups` 最后的排序一致，
 * 所以这里检查的就是真正会被编译出来的那个顺序。
 */
function orderSafe(clusters: Cluster[], footprints: BoxF[]): boolean {
  const ordered = [...clusters].sort((a, b) => a.minIdx - b.minIdx);
  const pos = new Map<number, number>();
  ordered.forEach((c, i) => c.idxs.forEach((r) => pos.set(r, i)));
  const all = [...pos.keys()].sort((a, b) => a - b);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const p = all[i], q = all[j];               // p < q：原本 q 盖在 p 上
      const pp = pos.get(p)!, pq = pos.get(q)!;
      if (pp === pq) continue;
      if (pq < pp && boxesOverlap(footprints[p], footprints[q])) return false;
    }
  }
  return true;
}

/**
 * 把区域列表切成合成组。
 *
 * 策略按优先级：
 *  0. 「矩形 + 无羽化 + 无关键帧」的**连续段**→ `kind:"legacy"`，原样走现有代码（§5.3.1）
 *  1. 其余区域先按 `effectKey` 分开（style **且** intensity 相同才可能同链）
 *  2. 组内空间聚类：并集面积 < 两框面积之和 × `CLUSTER_K` 才合并，且不得破坏叠放顺序
 *  3. 框面积超过画布 `FULL_FRAME_RATIO` → 退化为整幅
 *  4. 有动画的区域，框取**整段时间**的并集（`crop` 的 w/h 不能动画）
 *  5. 框的 x/y/w/h 一律偶数对齐（yuv420p 的 `crop` 会自己对齐，蒙版是 gray 不会）
 *
 * @param regions 该 clip 上的马赛克区域，**顺序即叠放顺序**（后者盖前者）
 * @param canvas  画布像素尺寸（马赛克作用在 pad 之后的画布尺寸流上）
 */
export function planMaskGroups(regions: MosaicParams[], canvas: CanvasPx): MaskGroup[] {
  const live = regions
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !isNoOpRegion(m));
  if (live.length === 0) return [];

  const footprints: BoxF[] = [];
  regions.forEach((m, i) => { footprints[i] = footprintOf(m, canvas); });

  // ---- 0/1. 种子簇：legacy 取连续段，其余每区域自成一簇 ----
  const clusters: Cluster[] = [];
  for (const { m, i } of live) {
    if (legacyEligible(m)) {
      const last = clusters[clusters.length - 1];
      if (last && last.kind === "legacy") {
        last.idxs.push(i);
        last.box = unionF(last.box, footprints[i]);
        continue;
      }
      clusters.push({
        kind: "legacy", style: m.style, key: "", box: footprints[i], idxs: [i], minIdx: i,
      });
    } else {
      clusters.push({
        kind: "mask", style: m.style, key: effectKey(m), box: footprints[i], idxs: [i], minIdx: i,
      });
    }
  }

  // ---- 2. 空间聚类（只在 mask 簇之间，且 `effectKey` 相同）----
  // 每轮挑「并集/分离」比值最小的一对合并，直到没有一对满足阈值。
  // 贪心而非全局最优是刻意的：区域个数是个位数，可预测比最优重要 ——
  // 同一份输入必须永远给出同一个分组（导出参数要可复现、基线要能钉住）。
  for (;;) {
    let best: { a: number; b: number; ratio: number } | null = null;
    for (let a = 0; a < clusters.length; a++) {
      if (clusters[a].kind !== "mask") continue;
      for (let b = a + 1; b < clusters.length; b++) {
        const A = clusters[a], B = clusters[b];
        if (B.kind !== "mask" || A.key !== B.key) continue;
        const u = unionF(A.box, B.box);
        const sep = areaF(A.box) + areaF(B.box);
        if (sep <= 0) continue;
        const ratio = areaF(u) / sep;
        if (ratio >= CLUSTER_K) continue;
        if (best && ratio >= best.ratio) continue;
        // 顺序安全：试合并后整体的叠放次序不能反转任何一对相交区域
        const trial = clusters.filter((_, k) => k !== a && k !== b);
        trial.push({
          kind: "mask", style: A.style, key: A.key, box: u,
          idxs: [...A.idxs, ...B.idxs], minIdx: Math.min(A.minIdx, B.minIdx),
        });
        if (!orderSafe(trial, footprints)) continue;
        best = { a, b, ratio };
      }
    }
    if (!best) break;
    const A = clusters[best.a], B = clusters[best.b];
    const merged: Cluster = {
      kind: "mask", style: A.style, key: A.key, box: unionF(A.box, B.box),
      idxs: [...A.idxs, ...B.idxs].sort((p, q) => p - q),
      minIdx: Math.min(A.minIdx, B.minIdx),
    };
    clusters.splice(best.b, 1);
    clusters.splice(best.a, 1, merged);
  }

  // ---- 3/5. 退化为整幅 + 偶数对齐 ----
  const fullW = Math.max(2, evenDown(canvas.w));
  const fullH = Math.max(2, evenDown(canvas.h));
  const canvasArea = Math.max(1, canvas.w * canvas.h);

  return clusters
    .sort((a, b) => a.minIdx - b.minIdx)
    .map((c): MaskGroup => {
      if (c.kind === "legacy") return { kind: "legacy", regionIdxs: c.idxs };
      let box = alignBox(c.box, canvas);
      if (box.w * box.h > FULL_FRAME_RATIO * canvasArea) {
        box = { x: 0, y: 0, w: fullW, h: fullH };
      }
      const fullFrame = box.x === 0 && box.y === 0 && box.w === fullW && box.h === fullH;
      return { kind: "mask", style: c.style, box, fullFrame, regionIdxs: c.idxs };
    });
}
