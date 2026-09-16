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
 *  4.（3.14）**缩一镜宽没反应、再缩却从"上一次该到的地方"开始**：预览贴的是
 *     指针**原始像素**、提交才吸附到镜头边界，两者差半个到一个镜头。见 `snapEdge`。
 *  5.（3.14）**拉长会多出一块、还与原块重叠**：台账按**角色名**存、渲染按
 *     **造型**过滤，把一个造型的段拉进另一个造型的区间，写下的 op 会被那条段
 *     捡走。见 `EdgeWindow`/`snapEdge` 与 `AssetTrack` 的 `freeSpan`。
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
  /**
   * 这条 op 是**哪一条造型段**写下的（`AssetRun.stageId`，形如 `st-day:1`）。
   *
   * ⚠️ 台账是按**行名**（角色名）存的 —— 后端 `ref_overrides` 就是这么寻址的，
   * 本地跟着用同一个坐标，发请求时不用翻译（见上）。但一个角色可以有**多个
   * 造型**，它们在渲染时是**各自的段**，共享行名的 op 会被兄弟造型一起读到。
   *
   * 实测（harness ④）：常服段往右拉长吃进 #5，写的 op 是行级的
   * `{5, present:true}`；夜行衣段底座是 #9-#12、从没声明过 #5，却照样把这条
   * op 捡了去，于是在 #5 画出一块**和常服段重叠**的夜行衣，外加一条
   * 「未设阶段」段（旧名「人工注入」）—— 用户报的"拉长会创建新块、而且覆盖重叠"就是它。
   *
   * 记上写下者之后，投影层就能只把 op 还给它的作者（见 `shownForStage`）。
   * **可选**：旧 localStorage 里的 op 没有这个字段，按 undefined 处理 ——
   * 那时按老规矩（行级）生效，不会因为升级而丢操作。
   */
  stageId?: string;
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
  // 合并判据必须含 `stageId`：同一 order 上"常服要、夜行衣不要"是两件独立
  // 的事，只按 order+present 合并会把其中一条吃掉（后写覆盖先写，但作者丢了，
  // 投影时就还给错的人）。
  const next = (last && last.order === op.order && last.present === op.present
    && last.stageId === op.stageId)
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
 * ⚠️ **3.14 起手势不再直接用它** —— 拖动改为"先吸附到镜头 order，再由 order
 * 算 px"（见下面的 `snapEdge`），`snapEdge` 内部用的是同一个不变量，但把
 * "另一端"也一并算进去了。保留此函数是因为它就是这个不变量的**单行表述**，
 * 守卫脚本（`scripts/verify-draggeom.ts` 块 ⑨）拿它当"两端不许交叉"的基准；
 * 直接用它会在预览与提交之间制造半镜到一镜的偏差。
 * `AssetTrack.tsx` 里**不该**再出现它的调用 —— 那意味着又多了一套像素夹取。
 *
 * 以前的两条下限（`Math.max(6, …)`）只保证"画得出 6px"，于是段的另一端可以
 * 被推过去压到只剩 6px 并**提交**（用户报的"毫无征兆地缩到最短"有时就是
 * 拖出来的，不只是误点）。正确的不变量是**两端不许交叉**：
 * 左边缘最右只能到右边缘减一格，右边缘最左只能到左边缘加一格。
 */
export function clampEdge(
  edgePx: number, side: "from" | "to", otherPx: number, minSpanPx: number,
): number {
  return side === "from"
    ? Math.min(edgePx, otherPx - minSpanPx)
    : Math.max(edgePx, otherPx + minSpanPx);
}

/**
 * 一段连续 order 的**可及范围**：从它的两端往外走，撞上 `blocked`（同一角色的
 * **别的造型**覆盖的镜头）或"没有这一镜"就停。
 *
 * 中途那些谁都没覆盖的镜头算公共空地 —— 角色换装之间常有几镜没被任何造型
 * 声明，把它排除掉会让"拉长一镜"变成拉不动。撞上别的造型才是真边界：越过它
 * 写下的台账操作会被那条段的 `present_orders` 捡走，画出重叠的第二块。
 *
 * 放在规则层而不是组件里，是为了让守卫脚本能拿真实数据跑同一份实现
 * （`scripts/verify-draggeom.ts`）—— 口径只写一遍，两端各写一份必然漂移。
 */
export function freeSpan(
  run: number[], blocked: Set<number>, hasShot: (o: number) => boolean,
): [number, number] {
  let lo = run[0];
  let hi = run[run.length - 1];
  while (lo - 1 >= 0 && !blocked.has(lo - 1) && hasShot(lo - 1)) lo -= 1;
  while (!blocked.has(hi + 1) && hasShot(hi + 1)) hi += 1;
  return [lo, hi] as [number, number];
}

/**
 * 一段 order **最多能占到哪儿**：从 `span` 的两端继续往外走，直到撞上
 * `blocked`（同一角色的**别的造型**覆盖的镜头）或"没有这一镜"。
 *
 * ⚠️ 这是**边缘拖动与整段平移**该用的范围，不是"当前覆盖面"。旧版拿"当前
 * 覆盖到哪"当窗口，段就只减不增：
 * 右边缘往左缩到 #1-#2 之后，`snapEdge` 只从 `lo=1` 循环到 `hi=2`，而
 * `orderLimit` 要求 order 必须 `>= anchorOrder + 1 = 3` —— 无解，返回 `null`，
 * 于是**再往右拖一个字都不动**（实测：缩到 200px 后，右边缘无论往右拖多少都
 * 停在 200px；左边缘同理只能右移、不能移回）。用户只能刷新页面重来。
 *
 * 与"当前覆盖面"的差别只在**往外的余量**：里面的是现在生效的镜头，多出来的
 * 是可以吃进来、现在还没吃到的镜头（换装之间谁都没声明的公共空地，或本段
 * 缩小后让出来的位置）。窗口用 `reach`，段才能既缩又长。
 *
 * 为什么不能放宽成"整个角色的出场镜头"：那按**角色名**算，而一个角色可能有
 * 多个造型分段覆盖不同集数。造型 A 的段拉长进造型 B 的区间，写下的台账操作
 * 会被造型 B 那条段捡走，画出第二块**重叠**的段（没有造型接住时则合成
 * 「未设阶段」段，旧名「人工注入」）—— 用户报的"拉长会创建新块、而且覆盖重叠"就是它。`blocked`
 * 正是用来在这些区间前面停下的。
 */
export function reachSpan(
  span: [number, number], blocked: Set<number>, hasShot: (o: number) => boolean,
): [number, number] {
  let lo = span[0];
  let hi = span[1];
  while (lo - 1 >= 0 && !blocked.has(lo - 1) && hasShot(lo - 1)) lo -= 1;
  while (!blocked.has(hi + 1) && hasShot(hi + 1)) hi += 1;
  return [lo, hi] as [number, number];
}

/* ------------------------------------------------------------------ *
 * 边缘拖动：**先定 order，再由 order 定 px**
 *
 * 老写法是反过来的 —— 拖动期间把段边缘贴到指针的**原始像素**上（预览），
 * 松手才用 `secToOrder` 把像素吸附成镜头 order（提交）。两者对"边缘在哪"
 * 的答案本来就不一样，差半个到一个镜头：
 *
 *   · 在**一个镜头宽**之内缩，预览动了、松手却吸附回原镜头 → 看起来"没反应"；
 *   · 越过那个镜头再缩，提交结果落在"上一次拖动本该到的地方"
 *     （用户原话："新的缩小起点在上一次缩小的预期结果上"）；
 *   · 拖得越长，预览与提交的偏差越大。
 *
 * 修法是让预览和提交**共用这一个函数**：每一帧就把指针位置吸附成 order，
 * 再用该 order 的**起始秒**（`from` 边）或**起始秒 + 时长**（`to` 边）算 px。
 * 于是"看到哪就是哪"，松手不再跳。代价是拖动时边缘一格一格地走 —— 那是
 * 对的：边缘本来就只允许停在镜头边界上。
 * ------------------------------------------------------------------ */

export interface EdgeSnap {
  /** 吸附到的镜头 order；`null` = 这个方向上一个可用镜头都没有（边界外） */
  order: number | null;
  /** 该 order 对应的边缘 px（松手提交与拖动预览共用） */
  px: number;
  /** 是否撞在窗口边界上（拖到头了）—— 调用方可以据此给"到界"提示 */
  atLimit: boolean;
}

/**
 * 边缘允许落在哪些 order 上。
 *
 * `lo`/`hi` 是**该段自己的可及范围**：造型区间之外、以及同一角色**别的造型**
 * 已经覆盖的镜头，都不在内。老写法只夹住"两端不交叉"，于是把一个造型的段
 * 拉长就会把台账操作写进另一个造型的区间 —— 而台账是按**角色名**存的、
 * 渲染却按**造型**过滤，那些 order 会被另一条段捡走，画出第二块**重叠**的段
 * （没有造型区间接住时则合成「未设阶段」段，旧名「人工注入」）。这就是用户报的"拉长会创建
 * 一个新块，而且是覆盖重叠的"。
 *
 * 边界由调用方按数据算好传进来，这里只做**机械的取整与夹取**，不认识造型。
 */
export interface EdgeWindow {
  /** 可落的最小 order */
  lo: number;
  /** 可落的最大 order */
  hi: number;
  /** 某个 order 此刻是否**允许**落上去（外部素材镜头、别的造型的区间为 false） */
  ok: (order: number) => boolean;
}

/**
 * 把指针位置吸附成"边缘应该在哪"。
 *
 * `anchorOrder` 是**另一端**的 order —— "两端不交叉"在这里是**按 order 算**的，
 * 不再是按 px：
 *
 *   · 左边缘：最多落到 `anchorOrder`
 *   · 右边缘：最少落到 `anchorOrder`
 *
 * ⚠️ 界是 `anchorOrder` **本身**，不是 `anchorOrder ∓ 1`。取后者等于规定
 * "一段至少两镜"，于是右边缘缩到剩两镜就再也缩不动、左边缘同理 —— 实测
 * 从 #1-#2 把右边缘往左拖 2000px，台账仍是 `[[1,2]]`，屏幕纹丝不动，
 * 而用户看到的是"拖到底了却还剩两格，且没有任何提示"。
 * **一镜宽的段是合法的**（这个资产只在这一镜出现），要整段去掉有右键
 * 「删除此注入段」和 Delete 键两条明路，不该靠"边缘拖到 0 宽"来表达。
 * 顺带一提，像素兜底 `minSpanPx`（一个整镜宽）本来就允许 from === to，
 * 两道闸口口径不一致时，是 order 这道错了。
 *
 * 老写法用的是像素口径（`anchorPx ± minSpanPx`，`minSpanPx` = 另一端那一镜的
 * 时长 × pxPerSec），在**镜头时长相等**时两者等价 —— 可一旦镜头长短不一，
 * 像素口径就落在别处：极限位置卡在两个镜头边界之间，指针对面的那一格被
 * `limit` 整格滤掉。用户的原话是"缩短一个片段距离后视觉上没有反应，但再次
 * 拖到缩小，新的缩小起点在上一次缩小的预期结果上" —— 拖第一格时滑块还停在
 * 原地（那一格不合法的），第二格才跳到"本该到的位置"。
 *
 * `minSpanPx` 仍然收着，只作为**像素兜底**：order 口径已经把合法落点限制死，
 * 它只在边界情况（另一端的 order 不在 offsetMap 里）起作用，且必须是整镜宽。
 *
 * 窗口内一个合法落点都没有时返回 `{order: null, px: otherPx}`：调用方应当
 * **不提交**（保持原范围），不要把边缘硬夹到 `otherPx` 上 —— 那会把段挤成 0 宽。
 */
export function snapEdge(
  edgePx: number, side: "from" | "to",
  offsetMap: Map<number, number>, pxPerSec: number,
  durOf: (order: number) => number,
  win: EdgeWindow, otherPx: number, minSpanPx: number,
  anchorOrder?: number,
): EdgeSnap {
  const limit = side === "from" ? otherPx - minSpanPx : otherPx + minSpanPx;
  // `anchorOrder` 是**另一端**那一格，用来按 order 保证两端不交叉：
  // 左边缘不许越过右边缘（`o > anchorOrder` 丢掉），右边缘不许越过左边缘
  // （`o < anchorOrder` 丢掉）。缺省时该是"这一侧没有 order 约束"，
  // 于是左边缘的上限是 +∞、右边缘的下限是 -∞ —— **两个方向正好相反**。
  // ⚠️ 写反过一次：缺省给左边缘 -∞，下面那句 `o > -Infinity` 对每个 order
  // 都成立，循环把候选**全部**滤掉、返回 `{order: null, px: otherPx}`。
  // 组件自己总会传这个参数所以真机看不出来，但函数退化成了"永远吸不上"，
  // 任何不传它的调用方（验证脚本就是）拿到的都是"边缘一动不动"。
  const orderLimit = anchorOrder == null
    ? (side === "from" ? Infinity : -Infinity)
    : anchorOrder;
  // ① 先定 order：窗口内、合法、且边缘落点离指针最近的镜头。
  let best: number | null = null;
  let bestD = Infinity;
  for (let o = win.lo; o <= win.hi; o++) {
    if (!win.ok(o)) continue;
    if (side === "from" ? o > orderLimit : o < orderLimit) continue;
    const start = offsetMap.get(o);
    if (start == null) continue;
    // 边缘 px：左边缘贴镜头**起点**，右边缘贴镜头**起点 + 时长**
    const px = side === "from" ? start * pxPerSec
      : (start + durOf(o)) * pxPerSec;
    // 像素兜底：与另一端不交叉。order 口径已保证大部分情况，这里只防
    // `anchorOrder` 缺失时（老调用方）退化成旧行为。
    if (side === "from" ? px > limit : px < limit) continue;
    const d = Math.abs(px - edgePx);
    // ⚠️ **等距时取"更靠外"的那一格**：左边缘取更小 order、右边缘取更大
    // order。循环是升序的，所以左边缘天然如此，右边缘要显式取等号，否则
    // 在正中间卡住时会退回里侧那一格，"再往外拖一点点"看着没反应。
    const better = side === "from" ? d < bestD : d <= bestD;
    if (better) { bestD = d; best = o; }
  }
  if (best == null) {
    // 一个合法落点都没有（例如整段都在别的造型里）：原地不动，别报错
    return { order: null, px: otherPx, atLimit: true };
  }
  // ② 再由 order 定 px —— 与上面比较时用的是同一个式子，故二者永远一致。
  const start = offsetMap.get(best) ?? 0;
  const px = side === "from" ? start * pxPerSec : (start + durOf(best)) * pxPerSec;
  return { order: best, px, atLimit: Math.abs(px - edgePx) > pxPerSec };
}

/**
 * **造型级**的台账投影（人物轨用）。
 *
 * ⚠️ 台账是**按角色名**记账的（后端 `present_orders` 也只在角色这一行），
 * 但一个角色可以有多套造型分段覆盖不同集数（常服 #1-4、夜行衣 #9-12）。
 * 组件最初的写法是把**行级**投影 `displayOrdersOf(base, …, 角色名)` 施加到
 * **每一个造型**的底座上 —— 于是"把常服缩到 #1-#2"记下的
 * `{3: present:false, 4: present:false}` 会被夜行衣那条段捡走：夜行衣的
 * `base` 里没有 #3-#4，投影却把 #3-#4 补进了 `shown`，渲染出第二块
 * **重叠**的段（`st-night:3`，坐标正好压在常服缩掉的那两格上）。
 * 用户原话：「发长资产块时，会创建一个新的资产块…而且是覆盖重叠的-这显然错了」。
 *
 * 两级口径分开：
 *   - `present`（**某造型自己的**状态）：本造型底座里的 order 一律保留
 *     （行级删除只是"这个造型不要了"，不该让没声明过它的别的造型凭空长出来）；
 *     本造型底座之外的 order 只有台账**显式 present:true** 才进。
 *   - `manual`（其余造型**没声明过**的 order）：只有这种才是真正"人工加入"
 *     的公共空地，画斜纹。在别的造型区间里动过的格子不算 —— 那只是行级台账
 *     对这一行的记录，跟本造型无关。
 */
export function shownForStage(
  base: readonly number[], ops: readonly AssetOverrideOp[],
  otherBase: ReadonlySet<number>, isSpecial?: (o: number) => boolean,
  stageId?: string,
): { shown: number[]; manual: number[] } {
  const baseSet = new Set(base);
  const final = new Map<number, { present: boolean; manual: boolean }>();
  for (const o of [...ops].sort((a, b) => a.at - b.at
    || a.order - b.order
    || String(a.stageId ?? "").localeCompare(String(b.stageId ?? "")))) {
    // 别的造型写下的 op 不归本段 —— 见 `AssetOverrideOp.stageId` 的注释。
    // 必须是**投影层**过滤而不是"提交时不写"：台账仍然是行级的（后端就是
    // 按角色名寻址），只是读到哪一段时只认哪一段的作者。
    if (o.stageId != null && o.stageId !== stageId) continue;
    // ⚠️ **没盖章的 op**（`stageId === undefined`）：本次改动之前写下的台账
    // 全是这样，用户浏览器的 localStorage 里**已经存着**，不能当它不存在。
    // 两种 op 的危险程度完全不同，所以分开处理：
    //
    //   · `present: false`（减法）—— 照旧对每一条造型生效。它只会让格子变少，
    //     永远造不出重叠；而且下面那条 `baseSet.has || otherBase.has` 的门槛
    //     保证它只能减掉"本来就声明过这一格"的造型。旧版的缩短要靠它才不回弹。
    //
    //   · `present: true`（加法）—— **不许任何造型段认领**。谁都能认领的加法
    //     就是重叠的来源：实测 B（不盖章地把常服 #1-2 粘到 #5）渲染出
    //     `st-day:1[0+600] | st-night:5[400+200] | local:林昭:5[400+200]`，
    //     三块叠在一起，正是用户报的"多出一块、而且覆盖重叠"。
    //     它们会落到「未设阶段」段（`shownForStage` 以 `stageId: undefined`
    //     调用的那一次）身上，**只画一块**。这也更诚实：行级 op 里确实没有
    //     "是哪套造型要的"这个信息，硬猜一个归属只会猜错。
    if (o.stageId == null && o.present && stageId != null) continue;
    final.set(o.order, { present: o.present, manual: o.manual });
  }
  const shown: number[] = [];
  const manual: number[] = [];
  const markedMissing = new Set<number>();
  for (const [order, st] of final) {
    if (isSpecial?.(order)) continue;
    if (!st.present) {
      // ⚠️ **删除只对"本来声明过这一格"的造型生效**，不能反过来给没声明过它的
      // 造型做加法（那正是夜行衣捡走 #3-#4 的成因）。
      if (baseSet.has(order) || otherBase.has(order)) markedMissing.add(order);
      continue;
    }
    // 别的造型底座里的格子永远不归本段（它有自己的造型行）
    if (baseSet.has(order) || otherBase.has(order)) continue;
    shown.push(order);
    if (st.manual) manual.push(order);
  }
  // 底座：台账说"这一行不要了"的格子要减掉，否则**缩短永远不生效** ——
  // 老写法无条件把整个 `base` 塞回来，"缩 2 格"记下了 op、toast 也报了，
  // 渲染出来还是 400px（实测：② 缩 2 格后 st-day:1 仍 [0+400]）。
  for (const o of base) {
    if (isSpecial?.(o)) continue;
    if (markedMissing.has(o)) continue;
    shown.push(o);
  }
  shown.sort((a, b) => a - b);
  manual.sort((a, b) => a - b);
  return { shown, manual };
}

/** 一条造型段的"底座"（`projectStages` 的入参）。 */
export interface StageBasis {
  /** `AssetStage.id`；虚拟段（没有造型行）传 undefined */
  stageId?: string;
  /** 该造型自己的 `present_orders` */
  base: readonly number[];
}

/**
 * **按造型**投影整整一行 —— 验证脚本与验证台的唯一口径。
 *
 * 为什么要有它：`displayOrdersOf` 是**行级**的（后端按角色名寻址），一个角色
 * 有多套造型时它返回的是并集。验证台一直拿这个并集当"台账投影"，而组件渲染
 * 的是**造型级**的段，两者根本不在同一个坐标系里：常服 #1-6 ∪ 夜行衣 #9-12
 * 的并集是 `[[1,6],[9,12]]`，它**无法表达**"夜行衣在 #5 另有一段"这件事，于是
 * `domMatchesLedger` 报出 `st-night:5 不在台账投影里` —— 那是量具错了，不是
 * 组件错了。这里把组件那一圈 `shownForStage` 的调用原样抽出来，让台子与探针
 * 对着**组件真正渲染的那份投影**核对。
 */
/**
 * **这个镜头该记在哪套造型名下** —— 注入类写入（拖卡片进轨道、粘一段）唯一的
 * 归属推断点，与渲染那一圈 `stageId` 口径同源。
 *
 * ## 为什么必须有它
 *
 * 台账的后端契约是**按角色名**寻址的（`present_orders` 只挂在角色那一行），
 * 所以"是谁写下的"必须由前端在**写入那一刻**自己记下来（`AssetOverrideOp.stageId`）。
 * 边缘拖动那条路一直盖着章（`applyEdge`，收 `run.stageId`）；而**注入**这条
 * 路（`injectAssetIntoShot`）从来只写 `{order, present:true, manual:true}`，
 * 于是投影层只能把它当"无主的加法"处理 —— 见 `shownForStage` 里的旧台账兼容
 * 规则：无主的加法**任何造型都不许认领**，一律落到合成的兜底段上。
 *
 * 那个规则本身是对的（谁都能认领的加法就是重叠的来源，用户实测过三块叠一起），
 * 但代价是：**用户从资产窗亲手把角色拖到自己那行的造型区间里，落的也是兜底段**。
 * 用户原话：「人工注入这个问题很大，因为用户从资产窗把资产拖到轨道上也会显示人工注入」。
 * 兜底段的名字对**真正没主的格子**是诚实的，对"拖进了自己的造型区间"就是**错的**。
 *
 * ## 判据
 *
 * 与渲染完全同源（`AssetTrack` 的 `claimed` / `base`）：
 *   1. 底座（服务端 `present_orders`）已经声明过这一格的造型**优先** —— 造型 A
 *      的底座里没有、造型 B 的底座里有 #5，就记在 B 名下。这是最常见的情形：
 *      "往已经画出来的段里再拖一张卡"。
 *   2. 底座都没声明过（公共空地），但台账里已经有**这套造型盖过章的** op 管着
 *      这一格 —— 那是"先缩掉、再拖卡加回来"，仍归原作者。
 *   3. 谁都没有 → `undefined`。**不许猜**：猜错会把 op 写进兄弟造型的区间，
 *      画出一块重叠的第二段（这正是上一轮修掉的 bug）。宁可落到兜底段。
 *
 * 多个造型都覆盖时取最后一个（与边缘拖动"谁后写算谁的"一致）。
 */
export function stageIdAt(
  stages: readonly StageBasis[], ops: readonly AssetOverrideOp[], order: number,
): string | undefined {
  let fallback: string | undefined;
  for (const s of stages) {
    if (s.stageId == null) continue;          // 虚拟段不是合法归属
    if (s.base.includes(order)) return s.stageId;   // 底座说过，直接算它的
    if (ops.some((o) => o.stageId === s.stageId && o.order === order)) fallback = s.stageId;
  }
  return fallback;
}

export function projectStages(
  stages: readonly StageBasis[], ops: readonly AssetOverrideOp[],
  isSpecial?: (o: number) => boolean,
): Array<{ stageId?: string; shown: number[]; manual: number[] }> {
  // 别的造型**声明过**的镜头：本造型不许捡（与组件同款 `claimed` 口径）
  const claimed = new Set<number>();
  for (const s of stages) for (const o of s.base) claimed.add(o);
  return stages.map((s) => {
    const own = new Set(s.base);
    const otherBase = new Set<number>();
    for (const o of claimed) if (!own.has(o)) otherBase.add(o);
    const { shown, manual } = shownForStage(s.base, ops, otherBase, isSpecial, s.stageId);
    return { stageId: s.stageId, shown, manual };
  });
}
