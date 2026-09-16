/**
 * dropContext.ts — `AssetDropCtx` 的**唯一组装点**
 *
 * ## 为什么要有这个文件
 *
 * 在这之前，`assetDropCtx` 在**两个地方各有一份完整复制**：
 *
 *   - `App.tsx:2183`           —— 真机
 *   - `dev/AssetTrackHarness.tsx:221` —— 验证台
 *
 * 两份靠注释互相提醒保持同步：
 *
 *   > `// 与 App.tsx 同款：只把**这个角色自己的**造型算作本行造型。`
 *   > `// 与 App 里 setAssetSyncContext 的口径一致。`
 *
 * **注释就是漂移的计时器。** 这段逻辑在 2026-09 的资产轨修复里已经被改过一次
 * （新增 `ownStageIds`，因为"往一条服务端还没有造型行的角色上注入"会被误判成
 * 「没能画上去」）。改动当时两份都改了，但下一次不会这么幸运 —— 改漏一份，
 * 用户看到的就是**换个入口同一操作有时行有时不行**。
 *
 * 更根本的问题：验证台是**唯一能自动跑这条链**的地方（`scripts/probe-assettrack.mjs`
 * 119 条断言全在真交互上）。如果台子和真机的口径可以各自漂移，
 * 那"台子绿了"就不能推出"真机对了" —— 探针的价值直接归零。
 *
 * 所以：**组装逻辑只留一份，台子从真机的装配路径上取。**
 *
 * ## 这里放什么、不放什么
 *
 * 放：**由"造型行 + 本地台账"推导出来的、与运行环境无关的装配**。
 *     —— 两个入口对同一份输入必须给出同一个 ctx，这是可验证的。
 *
 * 不放：**环境才知道的事实**（`offsetMap`、`pxPerSec`、`onToast`、`onPushUndo`、
 *       `onChanged`）。台子的时长是 fixture、缩放是常量、没有真的撤销栈，
 *       这些**本来就该不同**，强行统一反而会造出假的耦合。
 */

import type { AssetDropCtx } from "./useAssetDrop";
import type { StageBasis } from "./assetOverrides";

/**
 * 服务端造型行的最小形状 —— 只取组装 ctx 需要的那几个字段。
 *
 * 用结构类型而不是直接引用 `StageOut`：测试台的 fixture 是手写的，
 * 缺 `virtual` 之类的可选字段很正常，不该因为类型不齐而在台子里造假值。
 */
export interface StageRowLike {
  id: string;
  character_name: string;
  present_orders?: readonly number[] | null;
  /** 服务端合成的「未设阶段」行。**没有真造型行**，不是合法归属。 */
  virtual?: boolean;
}

/**
 * 造型行 → `StageBasis[]`。
 *
 * 虚拟段传 `undefined` 而不是它的 id：`stageIdAt` 里"虚拟段不是合法归属"
 * 这条判据靠的就是 `stageId == null`（见 assetOverrides.ts:597）。
 * 把 `__nostage__` 之类的哨兵 id 传进去，`stageIdAt` 会把它当成**真造型**
 * 返回，于是注入会盖上一个不存在的 stageId 章 —— 落库后那段归谁就说不清了。
 *
 * 两种"虚拟"表示都要认：
 *   - `virtual: true`     —— 服务端正规表示（`StageOut.virtual`，routes_v2.py:754）
 *   - `__nostage__` 前缀  —— 验证台 fixture 的写法（它手写的行没有 virtual 字段）
 */
export function toStageBases(rows: readonly StageRowLike[]): StageBasis[] {
  return rows.map((s) => ({
    stageId: s.virtual || s.id.startsWith("__nostage__") ? undefined : s.id,
    base: s.present_orders ?? [],
  }));
}

/**
 * 一行"自己的"造型 id 集合（`InjectArgs.ownStageIds`）。
 *
 * ## 它解决的是什么
 *
 * 注入落库前要判"这一格画出来了吗"。判据拿的是**全量**造型列表，
 * 于是会出现这种误判：往一条服务端**还没有造型行**的角色上注入 ——
 * 落点在公共空地，画的是「未设阶段」段，屏幕上明明看得见 ——
 * 但别家角色的造型**恰好**没覆盖那一格，判据就说"有造型却没画出这一格"，
 * 弹一句「没能画上去」。用户看到的是：**东西已经在轨道上了，系统说没画上。**
 *
 * 所以判可见性时必须先把别家的造型筛掉。
 *
 * ⚠️ 注意返回的是一行**自己的**造型，**不是"所有非虚拟造型"**。
 * 同名的多套造型（常服 / 夜行衣）都算本行，这是对的 ——
 * 台账按角色名记，同名造型共享一个 op 空间。
 */
export function makeOwnStageIds(
  rows: readonly StageRowLike[],
): (rowName: string) => ReadonlySet<string> {
  // 先按角色名分桶，避免每次调用都全表 filter —— 资产轨一行一个角色，
  // 全表扫是 O(行数 × 造型数)，滚动时会被调很多次。
  const byName = new Map<string, string[]>();
  for (const s of rows) {
    if (s.virtual || s.id.startsWith("__nostage__")) continue;
    const list = byName.get(s.character_name);
    if (list) list.push(s.id);
    else byName.set(s.character_name, [s.id]);
  }
  return (rowName: string) => new Set(byName.get(rowName) ?? []);
}

/**
 * 组装 `AssetDropCtx` 的**环境无关部分**。
 *
 * 真机与验证台分别这样用：
 *
 * ```ts
 * // App.tsx —— 环境事实从组件/store 取
 * const ctx = useMemo<AssetDropCtx | undefined>(() => {
 *   if (!projectId) return undefined;
 *   void assetRev;                       // 台账一变就得重算
 *   return {
 *     ...assetDropStageFacts(stages),
 *     projectId, shots,
 *     offsetMap: buildOrderOffsetMap(shots),
 *     pxPerSec: useTimelineStore.getState().pxPerSec,
 *     table: useAssetOverride.getState().table,
 *     onToast: say, onPushUndo: pushUndo,
 *     onChanged: () => void refreshDetail(),
 *   };
 * }, [projectId, shots, detail, stages, assetRev]);
 *
 * // AssetTrackHarness.tsx —— 环境事实是 fixture 常量
 * const ctx = useMemo<AssetDropCtx>(() => ({
 *   ...assetDropStageFacts(stages),
 *   projectId: PROJECT_ID, shots, offsetMap,
 *   pxPerSec: PX_PER_SEC,
 *   table: useAssetOverride.getState().table,
 *   onToast: (m) => setToast(m),
 *   onPushUndo: () => setPushes((n) => n + 1),
 *   onChanged: () => {},
 * }), [shots, offsetMap, stages, rev]);
 * ```
 *
 * 返回的 `StageFacts` 把这两个字段钉成**必填**：
 *   · 类型上是 `Pick<AssetDropCtx, …>` 的**去掉可选性**版本 —— `AssetDropCtx.stages`
 *     本身是 `stages?:`（场景轨没有造型概念，是合法的不传），但**这个工厂永远给得出**，
 *     于是调用方不必对 `undefined` 做无意义的兜底（`injectAssetIntoShot` 的
 *     `stages` / `ownStageIds` 是非可选的，就是要这个形状）。
 *   · 语义上 —— 新增一个 ctx 字段时，两个入口都会红，不会有一边被静默漏掉。
 */
export type StageFacts = {
  [K in "stages" | "ownStageIds"]-?: NonNullable<AssetDropCtx[K]>;
};

export function assetDropStageFacts(
  rows: readonly StageRowLike[] | null | undefined,
): StageFacts {
  const list = rows ?? [];
  return {
    stages: toStageBases(list),
    ownStageIds: makeOwnStageIds(list),
  };
}
