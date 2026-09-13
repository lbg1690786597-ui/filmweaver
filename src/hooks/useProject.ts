import { useEffect } from "react";
import { useProjectStore } from "../stores/projectStore";

/** G4 状态分层 · 项目层：当前项目 + detail 快照 + 刷新（含 800ms 合并刷新）。
 *
 * T-R0-07 状态云端化：projectId 记 localStorage，启动恢复现场；
 * detail 是全部视图的唯一数据源（镜头/分集/资产），刷新统一走这里。
 *
 * 6.8：detail 每次成功加载都**落盘一份快照**，断网启动时读回来。
 * 没有它，6.7「断线时手上有数据就留在编辑器」只在软件一直开着的情况下成立，
 * 而离线最常见的场景恰恰是关掉之后再打开。详见 `lib/snapshot.ts`。
 *
 * ⚠️ **B1 之后本文件只是一层壳**。状态与四个动作都已搬进
 * `stores/projectStore.ts`（zustand），这里保留的只有两件事：
 *
 *   1. **挂载效应**（启动恢复现场）。它必须在组件里 —— 见 store 文件末尾
 *      关于"为什么不模块级自启"的说明。
 *   2. **一个保持原签名的返回值**，让 `App.tsx` 那一行不用动。
 *
 * B4 又经这层壳多透出四个动作（`transformRevBase` / `noteTransformRev` /
 * `forgetTransformRev` / `replayOutbox`）—— 壳的定位没变，仍只是"订阅 +
 * 挂载效应"：动作本身全在 store 里，这里不做任何二次包装。
 * ⚠️ 因此**全 App 只许调一次 `useProject()`**（App.tsx 里也写着这句）：
 * 挂载效应跟着每个调用点各跑一次，调两次就是两次详情请求。
 *
 * 为什么留这层壳而不是直接把 `App.tsx` 改成订阅 store：B1 的验收标准是
 * **行为逐字不变**（`npx tsc --noEmit` + 全套 `verify:ui` 全绿）。
 * 一次到位地改 28 个调用点 + 18 个消费组件，就没法把"搬家搬错了"和
 * "迁移逻辑本身就错"这两件事分开 —— 而它们要分两次才能查清。
 * 调用点与消费组件的迁移分别是 B3 与 B2，见 `docs/PLAN-编辑核心架构收敛.md`。
 *
 * 订阅方式刻意选了**逐个字段**而不是 `useProjectStore()` 整取：
 * 整取会让 store 的任何一次 `set`（包括 `snapshotAt` 这种与调用方无关的）
 * 都重渲染 App —— 那正是搬家之前 `useState` 的行为，也是搬家要解决的问题。
 * 逐字段订阅拿到的是"这个调用方真正依赖的那几项变了才重渲染"。 */
export function useProject() {
  const projectId = useProjectStore((s) => s.projectId);
  const setProjectId = useProjectStore((s) => s.setProjectId);
  const detail = useProjectStore((s) => s.detail);
  const snapshotAt = useProjectStore((s) => s.snapshotAt);
  const refreshDetail = useProjectStore((s) => s.refreshDetail);
  const refreshSoon = useProjectStore((s) => s.refreshSoon);
  const patchDetail = useProjectStore((s) => s.patchDetail);
  const clearDetail = useProjectStore((s) => s.clearDetail);
  // B4：三个 transform 版本号动作 + 离线补发出口。逐个订阅（理由同文件头）——
  // 它们都是 `create` 时一次性定义的稳定引用，订阅本身不产生额外渲染。
  const transformRevBase = useProjectStore((s) => s.transformRevBase);
  const noteTransformRev = useProjectStore((s) => s.noteTransformRev);
  const forgetTransformRev = useProjectStore((s) => s.forgetTransformRev);
  const replayOutbox = useProjectStore((s) => s.replayOutbox);

  // 启动恢复现场。`read()` 读的是**闭包当时**的 projectId，所以只在挂载时跑一次，
  // 之后交给 `refreshDetail` 内部用 `get().projectId` 取实时值。
  useEffect(() => { if (projectId) void refreshDetail(projectId); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  return {
    projectId, setProjectId, detail, snapshotAt, refreshDetail, refreshSoon,
    patchDetail, clearDetail,
    transformRevBase, noteTransformRev, forgetTransformRev, replayOutbox,
  };
}
