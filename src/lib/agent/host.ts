/**
 * host.ts — 把真实的 store 接成 `AgentHost`（批次 E5 的收口）
 *
 * ## 这个文件存在的唯一理由
 *
 * `dispatch.ts` 刻意**不 import 任何 store**（要能在 node 下被
 * `verify-agent.ts` 跑），所以它定义了一个 `AgentHost` 接口；总得有人在
 * **真实 App 里**把这个接口填上。本文件就是那一处，且**只有这一处** ——
 * 两个地方各接一遍，就会出现"验证脚本测的 host 和线上跑的不是同一个"，
 * 而那正是这类接口最典型的失效方式。
 *
 * ## 为什么用 `getState()` 而不是 hook
 *
 * 这里要的是**当下这一刻**的值，不是渲染期快照。原因很硬：`run` / `unrun`
 * 会在**撤销时**执行（用户按 Ctrl+Z），那时离 `dispatch` 被调用已经过去
 * 几分钟，任何闭包捕获的 `detail` 都是旧值 —— 而逆操作拿旧值去 PATCH
 * 恰恰会**把撤销变成"改回一个更旧的状态"**。`getState()` 每次现取，
 * 从根上没有这个问题。
 *
 * 与 `dispatch.ts` 的契约：`findShot` 找不到就**返回 undefined**、
 * `requireShot` 找不到就**抛错**。两者都按"当前界面状态"回答 ——
 * 不为了凑数去打后端（理由见 dispatch.ts 文件头"unrun 里那些看起来多余的
 * API 调用"）。
 */

import { useProjectStore } from "../../stores/projectStore";
import { useTimelineStore } from "../../stores/timelineStore";
import type { ShotInfo } from "../../api";
import type { AgentHost } from "./dispatch";
import type { TimelineShotView } from "./describeTimeline";

/** 只读地从 store 取一份镜头表。**每次调用现取**，不缓存 ——
 *  缓存会让 `unrun` 拿到入栈那一刻的旧值，而它要的是**撤销那一刻**的值。 */
function shotsOf(projectId: string | null): ShotInfo[] {
  const detail = useProjectStore.getState().detail;
  if (!detail || !projectId) return [];
  return detail.shots ?? [];
}

/** `ShotInfo` → `TimelineShotView`：多一个字段都不给（见 dispatch.ts 的
 *  `AgentHost.shots` 注释）。这里是那个收窄的**唯一落点**，将来
 *  `TimelineShotView` 加字段也只需要改这里一处。 */
function toView(s: ShotInfo): TimelineShotView {
  return {
    id: s.id,
    order: s.order,
    episode: s.episode,
    duration_sec: s.duration_sec,
    disabled: s.disabled,
    status: s.status,
    script_ref: s.script_ref,
    characters: s.characters,
    location: s.location,
    gen_prompt: s.gen_prompt,
    stale: s.stale,
    version_count: s.version_count,
    is_special: s.is_special,
    special_name: s.special_name,
  };
}

/** 逆操作要的"改之前是什么样"。**只留 dispatch 真正会用到的字段** ——
 *  给全量 `ShotInfo` 会诱使 handler 去读一些它不该依赖的东西。 */
function lookup(shotId: string) {
  const pid = useProjectStore.getState().projectId;
  const s = shotsOf(pid).find((x) => x.id === shotId);
  if (!s) return undefined;
  return {
    order: s.order,
    duration_sec: s.duration_sec,
    disabled: s.disabled,
    gen_prompt: s.gen_prompt,
    video_url: s.video_url,
    is_special: s.is_special,
  };
}

/**
 * 造一个绑定到当前 App 的 host。
 *
 * @param say 写一句给用户的话。**必须传**（不设默认）—— 默认成 `console.log`
 *   会让"AI 说了一句话"在打包版里彻底消失，而这类静默失效极难被发现。
 * @param llm 文本模型单轮补全（E6 用）。省缺时依赖它的能力会明确报错，
 *   其余能力照常 —— 见 `AgentHost.llm` 的注释。
 */
export function makeAgentHost(
  say: (msg: string) => void,
  llm?: (system: string, user: string) => Promise<string>,
): AgentHost {
  return {
    projectId: () => {
      const pid = useProjectStore.getState().projectId;
      // 不兜底成空串：空串会让"写能力"的请求打到 `/v2/projects//shots` 这种
      // 路径上，后端返回 404，而模型看到的是"操作失败"—— 它会去改参数重试，
      // 一路试到把这一轮耗光。当场说清楚"没打开项目"才是可行动的。
      if (!pid) throw new Error("没有打开任何项目，先让用户打开一个项目再操作。");
      return pid;
    },
    findShot: (shotId) => lookup(shotId),
    requireShot: (shotId) => {
      const s = lookup(shotId);
      if (!s) {
        throw new Error(
          `界面上找不到镜头 ${shotId}。可能它已被删除，或界面数据还没刷新 —— ` +
            `请先重新调用 describe_timeline 拿到当前镜头 id。`,
        );
      }
      return s;
    },
    // 全量刷新走 store 的 `refreshDetail`：它会合并 800ms 内的重复请求，
    // 而一轮 Agent 可能连着改十几镜，逐个 `await` 全量刷新会打出一串请求。
    refresh: async () => {
      await useProjectStore.getState().refreshDetail();
    },
    shots: () => shotsOf(useProjectStore.getState().projectId).map(toView),
    // ⚠️ 直接转发 `pushUndo`：**不要再包一层**（比如顺手补个 `agentCallable`）。
    // 命令进栈的路径与 App.tsx 那 18 处调用点必须**完全相同**，
    // 否则"AI 改的"和"人改的"在撤销栈里会长得不一样，而这正是 E1 要消灭的差异。
    pushCommand: (draft) => useTimelineStore.getState().pushUndo(draft),
    // 轮次（E4 的合并窗口）直接转发 store，**不在这里造第二个 turnId 空间** ——
    // `commandStore` 里那个 `beginTurn` 已经在 `push` 里被读，两处各开一轮
    // 会得到"命令并进了 A 轮、界面显示的是 B 轮"。
    beginTurn: () => useTimelineStore.getState().beginTurn(),
    endTurn: (turnId) => {
      useTimelineStore.getState().endTurn(turnId);
    },
    say,
    llm,
  };
}

/** 当前是否有一轮 Agent 在进行（面板据此禁撤销 / 显示"AI 正在修改…"）。 */
export function agentTurnInFlight(): string | null {
  return useTimelineStore.getState().currentTurn();
}

/**
 * 时间轴数据到位了没有。
 *
 * ⚠️ 判据是 **`detail !== null`**，不是"`shots` 非空"。一个**真的空项目**
 * 与"还没加载完"在 `shots.length === 0` 上长得一模一样，而这两者要做的事
 * 完全相反：前者可以开始拆解，后者只能等。用长度判会出现"网络慢的时候
 * Agent 以为项目是空的，兴冲冲地要创建第一批镜头" —— 而用户其实有一千个。
 *
 * `detail` 是唯一的所有者（`projectStore`）持有的权威内存模型，
 * 它从 null 变成对象**只能**由一次成功的详情加载触发，正好是我们要的信号。
 * 失败态不在这里判（那是 `loadStateStore` 的事）：失败时 `detail` 仍为 null，
 * 于是这里也返回 false —— 对 Agent 而言"等"和"重试"是同一件事。
 */
export function projectLoaded(): boolean {
  return useProjectStore.getState().detail !== null;
}
