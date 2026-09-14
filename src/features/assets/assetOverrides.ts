/**
 * features/assets/assetOverrides.ts — 资产轨「本地先行」的**规则层**（纯函数，无 React、无 I/O）
 *
 * ## 它修的是什么
 *
 * 3.12 之前，资产轨上**每一次**调整都是同步的：拖一下边缘 → `await api.refOverrides()`
 * → `onChanged()` → `refreshStages() + refreshDetail()` → 新几何才算出来。
 * 三个后果，用户逐个报了回来：
 *
 *  1. **一次闪烁**：松手到新几何之间，段先按**服务端旧值**重画一次，等两趟刷新
 *     回来再跳一次。`gesture.ts` 的 `onSettle` 只在提交 Promise 落定后才清预览，
 *     所以这个中间态是**必然**出现的，不是偶发。
 *  2. **点一下就缩到最短**：`onCommit` 走的是 `latest !== cur` 判定，而 `latest`
 *     由 `secToOrder(松手处的秒)` 算出来 —— 指针只要落在段的**中点之前**，
 *     `secToOrder` 就吸附到更早的镜头，于是"点一下"被当成"把左边缘拖到指针处"，
 *     段立刻缩到 6px 下限。这条也说明**几何必须由本地算**：服务端算出来的
 *     永远是"按落点重画"，天然带这个偏差。
 *  3. **拖得越长偏差越大**：`stylePreview.widthPx` 把宽度 `Math.round` 成整数，
 *     而边缘手势每帧都重新 `parseFloat(el.style.width)` 读回**已经舍入过**的值，
 *     再用按下时的常量 `grabOffset` 反推边缘位置 —— 逐帧累加舍入误差。
 *
 * ## 本模块的立场
 *
 * **轨道上的几何，本地是唯一真源。** 服务端给的 `present_orders` 只是"底座"，
 * 用户的每一次调整都先记成一条本地操作（`AssetOverrideOp`），立刻反映到画面；
 * 落库是**后台的、可合并的、可失败的**一件事 —— 只有在真正需要服务端的动作
 * （生成图片/视频/音频、导出）之前才 `flush` 一次。
 *
 * 这样做的另一个好处是**离线可用**：断网时调整照常跟手，`outbox` 与补发队列
 * 会在联网后把它送出去，而不是让手势卡在 `await` 上。
 *
 * ## 为什么操作记「order」而不是「shot_id」
 *
 * 后端 `ref_overrides` 存的是 shot_id（那是它的口径，不改）。但**前端显示的是
 * order**：新增/删除镜头之后，同一批 shot_id 的 order 会整体平移，一份按 shot_id
 * 记的本地操作没法判断"这条还落不落地"。order 是我们渲染和判重的单位。
 * 发请求时再用 `shots` 把 order 映射回 shot_id（见 `localPayload`）。
 *
 * ## 为什么每条操作带 `at`
 *
 * 同一个 order 可能被**先后**加进来又剔出去（拖过头了再拖回来）。判定"最终
 * 状态"必须看**最后一次**操作，所以 ops 是**只追加的时间线**，不是集合差。
 * `coalesce` 只做相邻同类合并，不改变语义。
 */

/** 一次本地调整。加进来和剔出去各记一条，按 `at` 升序取最终态。 */
export interface AssetOverrideOp {
  /** 绝对镜头 order */
  order: number;
  /** true = 这一镜要有该资产；false = 这一镜不要 */
  present: boolean;
  /** 该 op 是否由用户手动添加（用于渲染斜纹，与后端 manual_add_orders 同义） */
  manual: boolean;
  /** 记下的时刻（Date.now()），同时用作同毫秒内的稳定排序 */
  at: number;
}

/** 单个项目的本地覆写台账：`行名 → 该行的操作时间线`。
 *
 *  键含**行名**而不是行 id：后端 `ref_overrides` 就是按角色名/场景归一名寻址的，
 *  本地跟着用同一个坐标，发请求时不用再做一次翻译（做翻译就会漂移）。 */
export interface AssetOverrideTable {
  [rowName: string]: AssetOverrideOp[];
}

/** 一份台账里某一行的操作列表（永不返回 undefined，调用方少一层判空）。 */
export function opsOf(table: AssetOverrideTable, rowName: string): AssetOverrideOp[] {
  return table[rowName] ?? [];
}

/**
 * 追加一条操作，返回**新表**（不改原表 —— zustand 的浅比较要它换引用）。
 *
 * 相邻同类合并：连着两次"要/不要"同一镜，只有最后一次有意义。合并省掉的是
 * 无意义的数组增长（拖动会按帧产生 op，一场 1400 镜的戏能攒出几千条）。
 * **不合并非相邻的**——中间隔着一次反向操作时，两条都有语义。
 */
export function appendOp(
  table: AssetOverrideTable, rowName: string, op: AssetOverrideOp,
): AssetOverrideTable {
  const prev = table[rowName] ?? [];
  const last = prev[prev.length - 1];
  const next = (last && last.order === op.order && last.present === op.present)
    ? [...prev.slice(0, -1), op]
    : [...prev, op];
  return { ...table, [rowName]: next };
}

/** 批量追加（拖一次边缘会同时改两端几十个 order）——一次换引用，别逐个 append。 */
export function appendOps(
  table: AssetOverrideTable, rowName: string,
  ops: readonly Omit<AssetOverrideOp, "at">[], at: number,
): AssetOverrideTable {
  if (!ops.length) return table;
  let next = table;
  for (const o of ops) next = appendOp(next, rowName, { ...o, at });
  return next;
}

/** 某一行的最终态：`order → {present, manual}`。后写的 op 覆盖先写的。 */
export function finalOps(ops: readonly AssetOverrideOp[]): Map<number, { present: boolean; manual: boolean }> {
  const sorted = [...ops].sort((a, b) => a.at - b.at);
  const m = new Map<number, { present: boolean; manual: boolean }>();
  for (const o of sorted) m.set(o.order, { present: o.present, manual: o.manual });
  return m;
}

/**
 * 把底座（服务端 `present_orders`）叠上本地操作，得到**当前该显示的 order 集合**。
 *
 * `isSpecial` 里的 order 一律不显示也不注入：特殊镜头（片头/空镜一类）后端
 * 本来就不参与注入，显示了会让用户以为拖进去生效了。调用方传 `(o) => shot.is_special`。
 */
export function projectOrders(
  base: readonly number[], ops: readonly AssetOverrideOp[],
  isSpecial?: (order: number) => boolean,
): number[] {
  const set = new Set<number>();
  for (const o of base) if (!isSpecial?.(o)) set.add(o);
  for (const [order, st] of finalOps(ops)) {
    if (isSpecial?.(order)) { set.delete(order); continue; }
    if (st.present) set.add(order); else set.delete(order);
  }
  return [...set].sort((a, b) => a - b);
}

/** 斜纹标记：投影后**实际显示**、且由用户手动加进来的 order。 */
export function projectManualAdds(
  shown: readonly number[], base: readonly number[], ops: readonly AssetOverrideOp[],
): number[] {
  const baseSet = new Set(base);
  const f = finalOps(ops);
  return shown.filter((o) => {
    const st = f.get(o);
    return st ? st.manual : !baseSet.has(o);
  });
}

/**
 * 一条本地操作是否**已经被服务端实现**了（可以摘掉）。
 *
 * 服务端返回 `present_orders` 后调用。只判"这个 order 的当前状态是不是就是
 * 本地想要的状态"，是则这条 op 的意图已经兑现。**只看最终态、不逐条判**：
 * 中间那条"先加后删"的操作在服务端看不见，逐条判会让它永远留在表里。
 */
export function opSatisfied(
  base: readonly number[], order: number, want: boolean,
): boolean {
  return base.includes(order) === want;
}

/**
 * 摘掉所有已被服务端兑现的操作，返回新表。空行会被移除（表里不留空数组）。
 *
 * `before` 是"兑现的截止时刻"：只有**在这一刻之前**记下的操作才允许摘 ——
 * 服务端底座反映的是某一次落库的**结果**，它兑现的是"那一刻之前我攒的意图"。
 * 之后记下的（用户还在拖）服务端根本没见过，拿底座去比对只会把新意图误判成
 * "已兑现"然后删掉。**不传 `before` 就一条都不摘**，这个缺省比"全摘"安全。
 */
export function pruneTable(
  table: AssetOverrideTable, serverBase: (rowName: string) => readonly number[] | null,
  before: (rowName: string) => number | undefined,
): { table: AssetOverrideTable; pruned: number } {
  let pruned = 0;
  const out: AssetOverrideTable = {};
  for (const [row, ops] of Object.entries(table)) {
    const base = serverBase(row);
    const cut = before(row) ?? 0;   // 不知道截止时刻 = 一条都不敢摘（见上）
    if (base == null) { out[row] = ops; continue; }  // 服务端还没回话，原样留着
    const keep = ops.filter((o) => o.at > cut || !opSatisfied(base, o.order, o.present));
    pruned += ops.length - keep.length;
    if (keep.length) out[row] = keep;
  }
  return { table: out, pruned };
}

/**
 * 把某一行的最终态与服务端底座对比，算出**要发给后端的差集**（order 口径）。
 *
 * 后端 `/v2/shots/ref-overrides` 收的是 shot_id，映射在调用方做（见 `localPayload`）。
 * 返回空数组对时**不要发请求** —— 那是"本地和服务器一致"，发了也是白发，
 * 还会白白让顶栏闪一次"保存中"。
 */
export function syncDiff(
  base: readonly number[], ops: readonly AssetOverrideOp[],
  isSpecial?: (order: number) => boolean,
): { add: number[]; remove: number[] } {
  const want = new Set(projectOrders(base, ops, isSpecial));
  const add: number[] = [], remove: number[] = [];
  for (const o of want) if (!base.includes(o)) add.push(o);
  for (const o of base) if (!want.has(o)) remove.push(o);
  return { add: add.sort((a, b) => a - b), remove: remove.sort((a, b) => a - b) };
}

/* ------------------------------------------------------------------ *
 * 几何：一份**唯一的**段几何算法
 *
 * 渲染、手势起点、提交都用它。以前渲染用 `offsetMap` 现算、手势用
 * `parseFloat(el.style.left)` 读回 DOM 里的值 —— 两套算法必然会分叉，
 * 而"读回自己刚写进去的、已经舍入过的值"就是那个越拖越偏的来源。
 * ------------------------------------------------------------------ */

export interface RunGeometry {
  /** 段左边缘在 lane 内容坐标里的 px */
  left: number;
  /** 段宽度 px */
  width: number;
  /** 右边缘 px（= left + width），手势要用，别让调用方各自再算一次 */
  right: number;
}

/**
 * 算一段的几何。**不量化**：内部全程浮点，只在最后交给浏览器时才由它去栅格化。
 *
 * `durOf(order)` 缺省返回 5 秒（与 `AssetTrack` 的兜底一致：镜头时长缺失时
 * 后端按 5 秒排轴）。`minWidth` 只用于**渲染下限**，不参与手势计算 ——
 * 让"看得见的最小宽度"反过来影响拖拽数学，就是 6px 那个坑的另一种写法。
 */
export function runGeometry(
  from: number, to: number,
  offsetMap: Map<number, number>, pxPerSec: number,
  durOf: (order: number) => number,
  minWidth = 16,
): RunGeometry {
  const left = (offsetMap.get(from) ?? 0) * pxPerSec;
  const endStart = offsetMap.get(to) ?? 0;
  const width = Math.max(minWidth, (endStart + durOf(to)) * pxPerSec - left);
  return { left, width, right: left + width };
}

/**
 * 边缘拖动时，某一侧边缘**允许**落在哪一段范围内（px）。
 *
 * 以前的两条下限（`Math.max(6, …)`）只保证"画得出 6px"，于是段的另一端可以
 * 被推过去压到只剩 6px 并**提交**（用户报的"毫无征兆地缩到最短"有时就是
 * 拖出来的，不只是误点）。正确的不变量是**两端不许交叉**：
 * 左边缘最右只能到右边缘减一格，右边缘最左只能到左边缘加一格。
 *
 * `limitPx` 是一格的宽度减去一个可握住的最小值，保证拖到极限时这一段
 * 仍然覆盖**完整的一镜**。
 */
export function clampEdge(
  edgePx: number, side: "from" | "to", otherPx: number, minSpanPx: number,
): number {
  return side === "from"
    ? Math.min(edgePx, otherPx - minSpanPx)
    : Math.max(edgePx, otherPx + minSpanPx);
}
