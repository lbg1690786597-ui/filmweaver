/**
 * lib/reconcileDetail.ts — 让 `refreshDetail()` 回来的新 JSON **复用未变动对象的引用**
 *
 * ## 修的是什么（U2 第 3 点）
 *
 * `api.projectDetail()` 每次都是一份全新解析出来的 JSON：即使 1424 个镜头里
 * 只有一个刚出片，`detail.shots` 里**每一个** `ShotInfo` 都是新对象。于是
 * `ShotCard` 那个 `memo(...)` 逐个比较 props 时全部判不等 ——
 * **1424 张卡片整体重渲染一遍**，只为了让其中 1 张换个缩略图。
 * 这就是"拆解/出片时界面发黏"的直接来源（U1 降频把频次从 3s 降到 15s，
 * 但每一次刷新依然是全表重渲染，频次低了不等于单次便宜了）。
 *
 * 本模块做的事只有一句：**逐项深比较，内容没变就把上一轮的对象原样还回去**。
 * React 的 `memo` / `useMemo` / `useEffect` 依赖判等全是引用比较，
 * 引用稳住了，它们才第一次真正开始工作。
 *
 * ## 为什么值得单开一个模块
 *
 * 1. 它是纯函数，能在 node 里对**真实的 1.6 MB 载荷**跑基准
 *    （`scripts/verify-detail-reconcile.ts` / `scripts/bench-shots-render.ts`）。
 * 2. 复用规则有几条不显然的边界（见下），写在调用点会被当成"顺手优化"删掉。
 *
 * ## 三条边界（每条都对应一种会真实发生的错）
 *
 * · **顺序变了就不复用数组**：镜头顺序是用户可拖的。数组引用不换、只换内容，
 *   会让依赖 `shots` 的 `useMemo`（分集分组、时间轴排布）拿着旧顺序不重算。
 * · **只认 id 相同的项**：id 是服务端主键，跨刷新稳定。按下标配对的话，
 *   删掉第一个镜头会让后面 1423 个全部"比中"上一位的内容 —— 复用出一整片错位数据。
 * · **深比较，不比 JSON 字符串**：`JSON.stringify` 依赖键序（同一后端序列化器下
 *   确实稳定，但一旦哪天字段顺序变了就会静默退化成"全都不复用"，
 *   而这种退化没有任何报错，只表现为"优化好像没了"）。深比较还能短路在第一处差异上。
 *
 * ## 不做的事
 *
 * 不递归复用**镜头内部**的子对象（`transform_meta` 等）。镜头本身没变时整个对象
 * 都被复用，子对象自然也是原引用；镜头变了时它已经要重渲染了，
 * 再省里面几个子对象的引用毫无收益，只是多几百次比较。
 */

import type { ProjectDetail } from "../api";

/** 深比较（数组按序、对象按键集）。短路在第一处差异。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao), bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** 复用统计（基准脚本与验证脚本据此断言，运行时不用） */
export interface ReuseStats {
  /** 各列表复用了多少项 */
  reused: Record<string, number>;
  /** 各列表总项数 */
  total: Record<string, number>;
  /** 整份 detail 被判为"完全没变"（连顶层对象都还是上一个引用） */
  wholeReused: boolean;
}

/**
 * 按 `key` 配对复用列表项；**全部复用且顺序长度一致**时连数组引用一起复用。
 * 返回 `[结果数组, 复用项数]`。
 */
function reuseList<T>(
  prev: readonly T[] | undefined,
  next: readonly T[],
  keyOf: (item: T) => string | number,
): [T[] | readonly T[], number] {
  if (!prev || !prev.length) return [next as T[], 0];
  const byKey = new Map<string | number, T>();
  for (const it of prev) byKey.set(keyOf(it), it);
  let reused = 0;
  let sameOrder = prev.length === next.length;
  const out: T[] = new Array(next.length);
  for (let i = 0; i < next.length; i++) {
    const n = next[i];
    const p = byKey.get(keyOf(n));
    if (p !== undefined && deepEqual(p, n)) { out[i] = p; reused++; }
    else { out[i] = n; }
    // 顺序判定必须**按位**比，不能只看"复用了几个"：
    // 拖动两个镜头互换位置时两项都复用得上，但数组序已经变了。
    if (sameOrder && out[i] !== prev[i]) sameOrder = false;
  }
  return [sameOrder && reused === next.length ? prev : out, reused];
}

/**
 * 把 `next` 里与 `prev` 内容相同的部分换回 `prev` 的引用。
 * `prev` 为 null（首次加载 / 切项目后）时原样返回 —— 没有可复用的东西。
 */
export function reconcileDetail(
  prev: ProjectDetail | null | undefined,
  next: ProjectDetail,
  stats?: ReuseStats,
): ProjectDetail {
  const note = (name: string, reused: number, total: number) => {
    if (stats) { stats.reused[name] = reused; stats.total[name] = total; }
  };
  if (!prev) {
    note("shots", 0, next.shots?.length ?? 0);
    note("assets", 0, next.assets?.length ?? 0);
    note("episodes", 0, next.episodes?.length ?? 0);
    if (stats) stats.wholeReused = false;
    return next;
  }
  // 换项目了就整份换掉：按 id 配对本来也配不上，白比一遍 1424 次深比较
  if (prev.id !== next.id) {
    note("shots", 0, next.shots?.length ?? 0);
    note("assets", 0, next.assets?.length ?? 0);
    note("episodes", 0, next.episodes?.length ?? 0);
    if (stats) stats.wholeReused = false;
    return next;
  }

  const [shots, rs] = reuseList(prev.shots, next.shots ?? [], (s) => s.id);
  const [assets, ra] = reuseList(prev.assets, next.assets ?? [], (a) => a.id);
  const [episodes, re] = reuseList(prev.episodes, next.episodes ?? [], (e) => e.order);
  note("shots", rs, next.shots?.length ?? 0);
  note("assets", ra, next.assets?.length ?? 0);
  note("episodes", re, next.episodes?.length ?? 0);

  const listsSame = shots === prev.shots && assets === prev.assets
    && episodes === prev.episodes;
  // 顶层标量（title / base_aspect / raw_script / …）也没变 → 连 detail 本身都复用。
  // 这一步不是锦上添花：`detail` 是十几个 effect 的依赖，顶层引用稳住，
  // 一次"什么都没变"的兜底刷新才真的等于零工作量。
  if (listsSame) {
    const scalarsSame = Object.keys(next).every((k) => {
      if (k === "shots" || k === "assets" || k === "episodes") return true;
      return deepEqual(
        (prev as unknown as Record<string, unknown>)[k],
        (next as unknown as Record<string, unknown>)[k],
      );
    }) && Object.keys(prev).length === Object.keys(next).length;
    if (scalarsSame) { if (stats) stats.wholeReused = true; return prev; }
  }
  if (stats) stats.wholeReused = false;
  return { ...next, shots: shots as ProjectDetail["shots"],
    assets: assets as ProjectDetail["assets"],
    episodes: episodes as ProjectDetail["episodes"] };
}

/** 新建一个空统计（给基准/验证脚本用） */
export function emptyStats(): ReuseStats {
  return { reused: {}, total: {}, wholeReused: false };
}
