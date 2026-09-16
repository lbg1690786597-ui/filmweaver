/**
 * stores/assetOverrideStore.ts — 资产轨本地覆写的**存放与落库**（承接 assetOverrides.ts 的规则层）
 *
 * ## 为什么台账要落 localStorage，而 outbox 落文件
 *
 * `outbox`（6.8）排的是"已经构造好的 HTTP 请求"，进它就必须是 `PATCH/PUT/DELETE`，
 * 因为 POST 由服务端分配 id。而资产注入**是** POST（`/v2/shots/ref-overrides`），
 * 排不进 outbox。所以这条链自己带一份台账：
 *
 *   · 台账 = 用户的**意图**（这一镜要/不要这个资产），按 order 记，与 id 无关；
 *   · 发出去 = 按当前 `shots` 把 order 翻成 shot_id，POST 一次。
 *
 * 分开的好处是**拖动期间不用管网络**：手指还在动的时候只往台账里写，松手后
 * 防抖 600ms 再发一次请求。中途断网、切走、关窗口，台账都还在，下次启动
 * 会自己重新对齐（`handleServerBase`）。
 *
 * ## 为什么放在 localStorage 而不是 `persistIO` 的文件里
 *
 * 台账是**小**的（一场戏满打满算几百条 op，几 KB），且必须在**首帧渲染之前**
 * 就能读到 —— 用它落文件的话，读盘是异步的，第一帧只能先画服务端底座，
 * 于是用户会看到"上次的调整闪一下才回来"。localStorage 是同步的，读得到就画得对。
 *
 * ⚠️ 与 `persistIO` 里那句"队列不进项目目录、清缓存不会误删"同一个道理：
 * 台账是**数据**不是缓存，所以键名前缀 `fw_asset_ovr:` 与素材缓存无关，
 * 清素材缓存不会碰它。
 *
 * ## 什么时候 flush
 *
 * **3.13 起：调整资产块本身不发任何请求。** 旧版每次写入后 600ms 尾防抖落库，
 * 于是"拖一下边缘 = 一次网络往返"，而且返回后还要按服务端底座重画一遍 ——
 * 用户看到的就是"闪一下才到正确位置"。现在只在两个时机碰网络：
 *
 *   1. **显式 `flushAssetOverrides()`** —— 调用**服务端能力**之前
 *      （生成图片/视频/音频、导出、重新拆解、跑 pipeline）。这些动作要么
 *      要读服务端的 `ref_overrides`，要么要按它注入参考图，不先落库就会漏；
 *   2. `window` 的 `pagehide` / `visibilitychange`（隐藏）—— 关窗口/切后台，
 *      兜底一次。**只发台账里真正有未落库改动的那几行**，没有改动就一个请求都不发。
 *
 * 除此之外的一切（拖边缘、平移、删除段、点轨道注入、撤销重做）**只写台账**，
 * 画面完全按台账画，网络上一片安静。这也是"软件里一切操作都留在本地"这条
 * 要求的落点：本地的是意图，服务端只在下一次真正需要它的时候才被对齐。
 */

import { create } from "zustand";
import { api } from "../api";
import type { ShotInfo } from "../api";
import type { CommandDraft } from "../lib/command";
import {
  appendOps, opsOf, pruneTable, syncDiff, projectOrders, projectManualAdds,
} from "../features/assets/assetOverrides";
import type { AssetOverrideOp, AssetOverrideTable } from "../features/assets/assetOverrides";

const KEY_PREFIX = "fw_asset_ovr:";

/** 一趟 flush 里两行之间的最小间隔。**不是防抖**：调整本身已经完全不发请求了，
 *  这里只是给"很多行一起 flush"（例如一次 pipeline 前的全量对齐）留一个
 *  呼吸位，避免同一毫秒内向同一个后端打十几次 POST。 */
export const FLUSH_STAGGER_MS = 30;

/** 落库失败后的重试间隔（指数上限见下）。失败**不丢台账** —— 见 store 头注释。 */
const RETRY_BASE_MS = 4000;
const RETRY_MAX_MS = 60000;

function storageKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

/**
 * 读一份台账。**同步**且**吞掉一切异常**：localStorage 在隐私模式/配额满时
 * 会抛，让它冒出去会让整个应用首帧就崩 —— 而代价只是丢掉本地的调整意图，
 * 服务端底座还在，用户重拖一次即可。宁可退化，不可白屏。
 */
export function loadTable(projectId: string): AssetOverrideTable {
  if (!projectId) return {};
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return {};
    const t = JSON.parse(raw) as AssetOverrideTable;
    if (!t || typeof t !== "object") return {};
    // 逐行校验：一份写坏的文件不该让轨道整体炸掉，只丢掉坏的那一行
    const out: AssetOverrideTable = {};
    for (const [row, ops] of Object.entries(t)) {
      if (!Array.isArray(ops)) continue;
      const good = ops.filter((o): o is AssetOverrideOp =>
        !!o && typeof o.order === "number" && typeof o.present === "boolean"
        && typeof o.at === "number");
      if (good.length) out[row] = good;
    }
    return out;
  } catch {
    return {};
  }
}

function saveTable(projectId: string, table: AssetOverrideTable): void {
  if (!projectId) return;
  try {
    if (!Object.keys(table).length) { localStorage.removeItem(storageKey(projectId)); return; }
    localStorage.setItem(storageKey(projectId), JSON.stringify(table));
  } catch (e) {
    console.warn("[assetOverride] 台账落盘失败（不影响本次会话内的调整）:", e);
  }
}

export interface AssetOverrideState {
  projectId: string;
  table: AssetOverrideTable;
  /** 正在落库的行数（顶栏/行头据此显示"保存中"） */
  syncing: number;
  /** 台账里还没被服务端兑现的 op 总数（> 0 = 有东西没落地） */
  pending: number;
  /** 最近一次落库失败的原因；成功后清空 */
  lastError: string | null;
  /** 台账每次变化就 +1。给渲染层当**订阅用的版本号** —— `table` 的引用只在
   *  写台账时变，而 `AssetTrack` 的行数据是 `useMemo` 出来的，没有这个计数器
   *  它不会重算（拖完边缘，段的位置就停在旧值上）。 */
  rev: number;

  /** 切项目：读该项目的台账（同步，供首帧直接用） */
  openProject: (projectId: string) => void;
  /** 摘掉当前项目（不碰 localStorage）。见实现处的说明。 */
  unloadProject: () => void;
  /** 把一份已知的台账**装回**到某个项目名下（并落盘）。见实现处的说明。 */
  adoptTable: (projectId: string, table: AssetOverrideTable) => void;
  /** 记一批调整（同一行的同一个瞬间） */
  /** 返回 false = 这批 op 没被接受（台账还没 openProject / 空 op）。调用方据此决定要不要报成功。 */
  record: (rowName: string, ops: readonly Omit<AssetOverrideOp, "at">[]) => boolean;
  /** 清空某一行（重置人工调整、删除段之后用） */
  clearRow: (rowName: string) => void;
  /** 服务端 `present_orders` 回来了：摘掉已兑现的 op（**只摘落库前记下的**，见 `pruneTable`） */
  handleServerBase: (serverBase: (rowName: string) => readonly number[] | null) => void;
}

export const useAssetOverride = create<AssetOverrideState>((set, get) => ({
  projectId: "",
  table: {},
  syncing: 0,
  pending: 0,
  lastError: null,
  rev: 0,

  openProject: (projectId) => {
    if (get().projectId === projectId) return;
    clearSyncState();
    const table = loadTable(projectId);
    set((s) => ({ projectId, table, pending: countOps(table), lastError: null, rev: s.rev + 1 }));
  },

  /**
   * 摘掉当前项目，**不动 localStorage** —— 落盘的台账原样留着，下次
   * `openProject` 同一个 id 会把它读回来。
   *
   * ⚠️ 这不是"清空台账"。它的真实用途是复刻真机上确实存在的那一刻：
   * `App.tsx` 是在拿到 `projectId` 之后的 effect 里才 `openProject`，**首帧
   * 渲染时 store 还是空的**。此时 `record()` 第一行 `if (!projectId) return false`
   * —— 什么都不该改，包括那句 toast。谁想测"注入被拒时不许报成功"，
   * 就得有一个能把 store 打回这一帧的入口，而不是自己去 `setState`。
   */
  unloadProject: () => {
    clearSyncState();
    set((s) => ({ projectId: "", table: {}, pending: 0, lastError: null, rev: s.rev + 1 }));
  },

  /**
   * 把一份**已知**的台账装回到某个项目名下，并落盘。
   *
   * 与 `openProject` 的区别是"信谁"：`openProject` 信 localStorage，
   * 这个信调用方给的 `table`。两处需要它：
   *   · 开发台上的**重置** —— 要的是"台账回到空白"，而 `openProject` 见
   *     `projectId` 没变会直接早退，内存里那份旧台账还在，上一轮的 op 会跟着
   *     下一轮测试跑；
   *   · 开发台上**快照的放回** —— 探针临时把台账摘掉测一帧，之后要原样放回，
   *     不能走 localStorage（那读回来的可能是被中途写脏的版本）。
   */
  adoptTable: (projectId, table) => {
    clearSyncState();
    // 先删再存：`saveTable` 对空表是 `removeItem`，顺序反了会留下上一份
    saveTable(projectId, table);
    set((s) => ({ projectId, table, pending: countOps(table), lastError: null, rev: s.rev + 1 }));
  },

  record: (rowName, ops) => {
    const { projectId, table } = get();
    // ⚠️ **返回值必须如实反映"有没有写进去"**。老写法在这里静默 return，
    // 调用方照样弹「生效范围改为 #1-#3」，可台账里一条 op 都没有 —— 于是
    // 预览里段确实变窄了、松手却弹回原样，用户看到的是"缩了一格没反应"。
    // 唯一会走到这条早退的是"台账还没 openProject"（首帧竞态、或组件被挂在
    // 没有 App 外壳的地方），此时**什么都不该改**，包括那句 toast。
    if (!projectId || !ops.length) return false;
    const next = appendOps(table, rowName, ops, Date.now());
    if (next === table) return false;
    saveTable(projectId, next);
    set((s) => ({ table: next, pending: countOps(next), rev: s.rev + 1 }));
    // ⚠️ **这里不发请求、也不排定时器**（3.13）。调整只活在本地台账里，
    // 落库统一由 `flushAssetOverrides()` 在需要服务端能力的那一刻触发。
    // 3.12 在这里排的那个 600ms 尾防抖，就是"每次调整都闪一下"的来源：
    // 请求回来 → 服务端底座变了 → 按底座重画 → 用户看到段先弹回原位再落定。
    return true;
  },

  clearRow: (rowName) => {
    const { projectId, table } = get();
    if (!projectId || !(rowName in table)) return;
    const next = { ...table };
    delete next[rowName];
    saveTable(projectId, next);
    set((s) => ({ table: next, pending: countOps(next), rev: s.rev + 1 }));
  },

  handleServerBase: (serverBase) => {
    const { projectId, table } = get();
    if (!projectId) return;
    const { table: next, pruned } = pruneTable(table, serverBase, (row) => syncedAt.get(row));
    if (!pruned) return;
    saveTable(projectId, next);
    set((s) => ({ table: next, pending: countOps(next), rev: s.rev + 1 }));
  },
}));

/** 订阅台账版本号。渲染层用它当 `useMemo` 的依赖 —— 见 `AssetOverrideState.rev`。 */
export function useAssetOverrideRev(): number {
  return useAssetOverride((s) => s.rev);
}

function countOps(t: AssetOverrideTable): number {
  let n = 0;
  for (const ops of Object.values(t)) n += ops.length;
  return n;
}

/**
 * 换/摘项目前必须先掐掉"上一个项目挂着的"落库状态。
 *
 * ⚠️ `syncRow` 是从 store 现读 `projectId` 的，定时器不掐的话，上一项目那笔
 * 失败的写入会在新项目里重发 —— A 项目的角色名发到 B 项目的 `/shots/ref-overrides`。
 * `baseSnapshot` / `syncedAt` 同理：它们是"这一行在服务端是什么样"的记忆，
 * 换了项目就整批失效，留着会让 `pruneTable` 按旧底座摘掉新项目的 op。
 *
 * 抽成函数是因为**三个入口都要它**（`openProject` / `unloadProject` /
 * `adoptTable`）—— 各抄一份的话，早晚有一处漏掉某个 Map。
 */
function clearSyncState(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  retryDelay.clear();
  baseSnapshot.clear();
  syncedAt.clear();
}

/* ------------------------------------------------------------------ *
 * 落库：一次请求发一行的完整差集
 *
 * 为什么按行发**完整差集**而不是"把这次拖动的增删发出去"：本地台账可能攒了
 * 好几笔（拖三次边缘），合并成一次差集既少发请求，又天然是**幂等**的 ——
 * 发失败重发、和服务端当前状态对比，结果都一样。这正好补上 POST 不能进
 * outbox 的那块（POST 没有"重发安全"的默认假设，这里靠绝对值语义给它建一个）。
 * ------------------------------------------------------------------ */

/** 每行一个计时器，防抖。按 `${projectId} ${rowName}` 存。 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const retryDelay = new Map<string, number>();

/** 一行资产的**服务端底座**：`present_orders` + 哪些是人工加的 + 该 order 是不是特殊镜头。
 *
 *  特殊镜头（片头/空镜/外部素材）后端本来就不参与注入，本地台账也不该往里写。 */
export interface RowBase {
  present: number[];
  manualAdd: number[];
  /** 该 order 是不是特殊镜头 */
  isSpecial: boolean;
  /** 这条轨是不是场景轨（决定请求里的 `isLocation`） */
  isLocation: boolean;
}

/** 落库与投影需要的全部上下文。由调用方（App）在数据刷新后塞进来。 */
export interface AssetSyncCtx {
  projectId: string;
  /** order → shot（落库时把 order 翻成 shot_id） */
  shots: ShotInfo[];
  /** 取某一行的底座；行不存在返回 null（此时既不投影也不落库） */
  baseOf: (rowName: string) => RowBase | null;
  /** 撤销/重做时用：记一条**反向操作**进台账（不发即时请求，交给防抖落库） */
  pushUndo: (draft: CommandDraft) => void;
  /** 顶栏提示（落库失败等）。可选 —— 缺省静默，台账不丢。 */
  onToast?: (m: string) => void;
}

/** 由调用方（Timeline/App）在数据刷新后塞进来；落库时要靠它把 order 翻成 shot_id。 */
let ctx: AssetSyncCtx | null = null;

/** 服务端底座快照：`行名 → 最近一次落库成功后的 present_orders`。
 *
 *  为什么需要它：`ctx.baseOf` 给的是**当前**底座，而一次落库成功之后页面还没
 *  刷新，`baseOf` 可能仍是旧值 —— 拿它去 `pruneTable` 会把刚发出去的 op 判成
 *  "还没兑现"留着不放，下次 `syncDiff` 又发一遍同样的请求。快照记的是
 *  "我已经知道的、服务端该有的样子"，用它比对才准。 */
const baseSnapshot = new Map<string, number[]>();

/** 每行的快照是**哪一刻**攒下的意图换来的（`pruneTable` 的截止时刻）。 */
const syncedAt = new Map<string, number>();

/** 服务端**真正**的底座（快照优先，没有快照时用 ctx 给的当前值）。 */
function effectiveBase(rowName: string): number[] | null {
  const snap = baseSnapshot.get(rowName);
  if (snap) return snap;
  return ctx?.baseOf(rowName)?.present ?? null;
}

/** 落库成功：底座换成新值，并记下"这一刻之前的意图都兑现了"。 */
function rememberBase(rowName: string, present: readonly number[]): void {
  baseSnapshot.set(rowName, [...present].sort((a, b) => a - b));
  syncedAt.set(rowName, Date.now());
}

export function setAssetSyncContext(next: AssetSyncCtx | null): void {
  ctx = next;
  if (!next) baseSnapshot.clear();
}

/** 把台账里所有未落库的调整发给服务端。**调用服务端能力之前必须调它。**
 *
 *  返回"是否全部发成功"。调用方（生成/导出入口）据此决定要不要提醒用户 ——
 *  静默吞掉失败会让用户看到"我明明拖了角色 A，出来的片子却没有"。
 *
 *  ⚠️ **串行发**，不是 `Promise.all`：同一行的两次并发 POST 在后端是竞态
 *  （两次都读旧状态、两次写回），而"按行发的完整差集"只有在**顺序**下才幂等。
 *  行与行之间留一个呼吸位，别把同一毫秒的十几条 POST 砸过去。 */
export async function flushAssetOverrides(): Promise<boolean> {
  const rows = new Set<string>();
  const t = useAssetOverride.getState().table;
  for (const [row, ops] of Object.entries(t)) if (ops.length) rows.add(row);
  if (!rows.size) return true;
  let allOk = true;
  let first = true;
  for (const row of rows) {
    if (!first) await new Promise((r) => setTimeout(r, FLUSH_STAGGER_MS));
    first = false;
    if (!(await syncRow(row))) allOk = false;
  }
  return allOk;
}

/** 某个项目的台账还有没有没落地的调整。 */
export function hasPendingOverrides(): boolean {
  return useAssetOverride.getState().pending > 0;
}

function keyOf(projectId: string, rowName: string): string {
  return `${projectId} ${rowName}`;
}


/**
 * 落库一行。返回是否成功（调用方一般不看，失败会进 `lastError` 并按退避重试）。
 *
 * 失败处理：**台账原样留着**，按指数退避重试。这与 `stagedWrite` 的立场一致 ——
 * 悄悄回滚用户的调整比留着一个"没落库但正确的画面"坏得多。
 */
async function syncRow(rowName: string): Promise<boolean> {
  const st = useAssetOverride.getState();
  const { projectId, table } = st;
  if (!projectId) return false;
  const ops = opsOf(table, rowName);
  if (!ops.length) return true;
  const c = ctx;
  if (!c || c.projectId !== projectId) return false;

  const isLoc = c.baseOf(rowName)?.isLocation ?? false;
  const base = effectiveBase(rowName) ?? [];
  const shotOf = new Map(c.shots.map((s) => [s.order, s]));
  const isSpecial = (o: number) => !!shotOf.get(o)?.is_special;
  const diff = syncDiff(base, ops, isSpecial);
  if (!diff.add.length && !diff.remove.length) {
    // 本地和服务端已经一致 —— 不必发请求，直接把这批 op 摘掉
    useAssetOverride.getState().handleServerBase(effectiveBase);
    return true;
  }

  const addIds: string[] = [];
  const removeIds: string[] = [];
  for (const o of diff.add) {
    const sh = shotOf.get(o);
    if (sh && !sh.is_special) addIds.push(sh.id);
  }
  for (const o of diff.remove) {
    const sh = shotOf.get(o);
    if (sh) removeIds.push(sh.id);
  }
  if (!addIds.length && !removeIds.length) return true;

  const k = keyOf(projectId, rowName);
  useAssetOverride.setState((s) => ({ syncing: s.syncing + 1 }));
  try {
    await api.refOverrides(projectId, rowName,
      { addShotIds: addIds, removeShotIds: removeIds, isLocation: isLoc });
    retryDelay.delete(k);
    // 服务端现在应该是"底座 ∪ 本地意图"了 —— 记下这个事实，供下一次 diff 用
    rememberBase(rowName, projectOrders(base, ops, isSpecial));
    useAssetOverride.setState((s) => ({
      syncing: Math.max(0, s.syncing - 1), lastError: null,
    }));
    // 服务端已经接受了这批调整 → 相等的 op 可以摘掉了。
    // **不调 `onChanged()`**：画面本来就是按本地台账画的，再刷一次等于把
    // 刚修好的"一闪烁"重新引入（几何会先按服务端底座重画一次）。
    // 真正的对齐放在下一次自然刷新（轮询/用户操作触发）里做。
    useAssetOverride.getState().handleServerBase(effectiveBase);
    return true;
  } catch (e) {
    const delay = Math.min(RETRY_MAX_MS, (retryDelay.get(k) ?? RETRY_BASE_MS));
    retryDelay.set(k, delay * 2);
    useAssetOverride.setState((s) => ({
      syncing: Math.max(0, s.syncing - 1),
      lastError: e instanceof Error ? e.message : String(e),
    }));
    c.onToast?.(`资产调整暂未保存，会自动重试：${e instanceof Error ? e.message : String(e)}`);
    const t = setTimeout(() => { timers.delete(k); void syncRow(rowName); }, delay);
    if (timers.has(k)) clearTimeout(timers.get(k)!);
    timers.set(k, t);
    return false;
  }
}

/** 底座取用的**唯一**入口：渲染和落库都必须走它。
 *
 *  快照优先的理由见 `effectiveBase`；两者的差别只在"刚落库、页面还没刷新"
 *  这一小段时间里，而如果不区分，那段时间里渲染会**回退**到旧底座 ——
 *  正是用户报的"调整完闪一下才到正确位置"。
 */
export function rowBase(rowName: string): RowBase | null {
  const c = ctx;
  if (!c) return null;
  const b = c.baseOf(rowName);
  if (!b) return null;
  const snap = baseSnapshot.get(rowName);
  return snap ? { ...b, present: snap } : b;
}

/** 页面要走了：**只有台账里真有未落库的调整时**才发一次。
 *
 *  3.13 起调整本身不发请求，所以"关窗口"成了唯一一个可能丢东西的时刻 ——
 *  这个兜底必须留。但它绝不无条件发：没有未落库改动时（绝大多数关窗）
 *  一个请求都不该产生，否则"一切操作留在本地"就成了一句空话。
 *
 *  `sendBeacon` 用不了（带自定义头 + JSON body），所以只是"触发一次 flush"，
 *  来得及就发出去，来不及就留着台账下次启动续上（`loadTable` 同步读回来）。 */
if (typeof window !== "undefined") {
  const flushIfDirty = () => { if (hasPendingOverrides()) void flushAssetOverrides(); };
  window.addEventListener("pagehide", flushIfDirty);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushIfDirty();
  });
}

/* ------------------------------------------------------------------ *
 * 撤销：把一次调整的**逆操作**也记进台账
 *
 * 3.12 之前，撤销走的是"立刻反向调一次 `api.refOverrides`"。本地先行之后，
 * 正向已经不即时落库了，撤销再走网络就会出现**两种时序**：正向攒着、撤销
 * 插队发出去 —— 服务端先收到撤销、后收到正向，最终状态正好反了。
 *
 * 所以撤销同样是**往台账里记一条反向操作**，由同一个防抖队列按顺序落库。
 * 台账是"后写覆盖先写"的时间线，顺序天然正确。
 * ------------------------------------------------------------------ */

/**
 * 由一批已应用的调整生成逆操作（present 取反，manual 保持）。
 *
 * ⚠️ `stageId` 必须**原样带过去**。正向 op 是「林昭 · 常服」盖了章的注入，逆操作
 * 要是把章丢了，它就成了"无主的加法"——`shownForStage` 的老 op 规则不肯认领，
 * 撤销之后那一格会从造型段里掉出来、变成一条「未设阶段」的兜底段。用户看到的是
 * 「Ctrl+Z 撤一下，块没变回去，反而多出一块」，比不撤销还费解。
 */
export function inverseOps(
  ops: readonly Omit<AssetOverrideOp, "at">[],
): Omit<AssetOverrideOp, "at">[] {
  return ops.map((o) => ({
    order: o.order, present: !o.present, manual: o.manual, stageId: o.stageId,
  }));
}

/**
 * 记一次可通过 Ctrl+Z 回退的调整。
 *
 * `ops` 是这次调整**已经写进台账**的那些操作。撤销/重做都是再记一条反向操作
 * （`run` 记正向的逆、`unrun` 记正向），而不是直接发请求。
 *
 * 返回 `false` 表示台账**没有接受**这批 op（还没 `openProject`）—— 此时既不能
 * 推撤销栈（撤销一条从未发生过的改动，只会让 Ctrl+Z 白白吃掉一次），调用方也
 * **不许报成功**。这是"预览动了、松手弹回、toast 却说改好了"的直接来源。
 */
export function recordWithUndo(
  label: string, rowName: string,
  ops: readonly Omit<AssetOverrideOp, "at">[],
  affectedShotIds: string[],
): boolean {
  if (!useAssetOverride.getState().record(rowName, ops)) return false;
  const pushUndo = ctx?.pushUndo;
  if (!pushUndo) return true;
  const forward = ops.map((o) => ({ ...o }));
  pushUndo({
    label,
    kind: "asset",
    // affected 用 uid 列表而不是 order 区间（`lib/command.ts` 头注释的硬约束：
    // order 是最热的可变值，撤销后按它定位必然指错）。
    affected: { shots: [...affectedShotIds] },
    unrun: async () => { useAssetOverride.getState().record(rowName, inverseOps(forward)); },
    run: async () => { useAssetOverride.getState().record(rowName, forward); },
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * 删除一个注入段（给键盘 Delete 用）
 *
 * `AssetTrack` 里的 `removeRun` 拿得到 `AssetRun`（含 `row.name`），键盘路径
 * 只有 App 里那份"选中了什么"的快照，拿不到组件里那份 `rows`。两边都要能删，
 * 且必须走**同一份**口径 —— 把规则抽到这里，组件与 App 各调一次。
 *
 * 为什么要从**投影后**的显示集里挑，而不是直接用 `[from, to]`：
 * `from..to` 是台账投影的结果，中间可能有洞（特殊镜、被别的造型挡住的镜头）。
 * 整段按下 `present: false` 会把那段区间里**根本没被这段覆盖**的镜头也标掉，
 * 而那些 order 本来是别人的。
 * ------------------------------------------------------------------ */

/** 把某一行 `[from, to]` 之内**当前显示为生效**的非特殊镜头标成删除。
 *  返回真正删掉的 order；空数组 = 这一段本来就什么都不显示，调用方不该报成功。
 *
 *  `isLocation` 只影响落库时的请求体（`syncDiff` 那一侧会读 `ctx.baseOf`），
 * 投影这里两种轨走同一条路：`ctx.baseOf` 对场景行返回 `present: []`，
 * 也就是"全部来自台账"，与 `AssetTrack` 里场景轨的 `displayOrdersOf([], …)`
 * 是同一个结果。 */
export function deleteRunOrders(
  projectId: string | null, rowName: string, from: number, to: number,
  shots: readonly ShotInfo[], isLocation: boolean, stageId?: string,
): number[] {
  void isLocation;
  const st = useAssetOverride.getState();
  if (!st.projectId || st.projectId !== projectId) return [];
  const shotOf = new Map(shots.map((s) => [s.order, s]));
  const isSpecial = (o: number) => !!shotOf.get(o)?.is_special;
  const orders = projectOrders(
    ctx?.baseOf(rowName)?.present ?? [], opsOf(st.table, rowName), isSpecial)
    .filter((o) => o >= from && o <= to && !isSpecial(o));
  if (!orders.length) return [];
  // ⚠️ 盖上 `stageId`（`AssetRun.stageId`，形如 `st-day`）。台账按**角色名**
  // 存，一个角色有多套造型时，不盖章的 op 会被**每一条**造型段读到：删掉
  // 「夜行衣」#9-12 写下的 `present:false`，常服段也会照单执行。本例里常服
  // 底座是 #1-4、与 #9-12 不相交所以看不出来，可只要两套造型的区间有重叠
  // （用户把常服拉长到 #9 之后就有），删一段就会顺手削掉另一段。
  // 拿不到造型（场景轨 / 「人工注入」段）时留空 —— 那本来就是行级的东西。
  const ops = orders.map((o) => ({ order: o, present: false, manual: false, stageId }));
  recordWithUndo(
    `删除「${rowName}」#${from}-#${to} 注入段`,
    rowName, ops,
    orders.map((o) => shotOf.get(o)!.id));
  return orders;
}

/* ------------------------------------------------------------------ *
 * 复制一个注入段（给 Ctrl+C / Ctrl+V 用）
 *
 * 与 `deleteRunOrders` 同源：都从**投影后**的显示集里挑，不用 `[from, to]`
 * 裸区间 —— 区间里可能有洞（特殊镜、别的造型挡住的镜头），整段 `present: true`
 * 会把别人的镜头也标成自己的。
 * ------------------------------------------------------------------ */

/** 读出某一行 `[from, to]` 之内当前显示的、非特殊的镜头。**不写台账**，
 *  供"复制"把内容揣进剪贴板。
 *
 *  `from`/`to` 传 `-Infinity` / `Infinity` 就是"这一行全部"（读剪贴板落点的
 *  占用情况时用得上）—— 传具体区间时只返回区间内的。 */
export function readRunOrders(
  projectId: string | null, rowName: string, from: number, to: number,
  shots: readonly ShotInfo[],
): number[] {
  const st = useAssetOverride.getState();
  if (!projectId || st.projectId !== projectId) return [];
  const shotOf = new Map(shots.map((s) => [s.order, s]));
  const isSpecial = (o: number) => !!shotOf.get(o)?.is_special;
  return projectOrders(
    ctx?.baseOf(rowName)?.present ?? [], opsOf(st.table, rowName), isSpecial)
    .filter((o) => o >= from && o <= to && !isSpecial(o));
}

/** 把一段连续 order 落到 `at` 起的位置（复制/粘贴）。返回真正写入的 order。
 *
 *  `blocked` 是落点上**已经被这一行别的段占住**的 order —— 撞上就整个拒绝，
 *  不做"挤一挤"。注入段的语义是"这几镜用这套造型"，重叠的两段无从解释。
 *
 *  ⚠️ 调用方（App 的 Ctrl+V）拿不到组件里那份按**造型**切好的行数据，只能给
 *  一个大概的 `blocked`（见那里的注释）。所以这里**只拒绝、不改写** —— 拦不住
 *  的极端情况（同一角色另有造型覆盖了落点）由服务端底座兜：那些 order 本来
 *  就在 `base.present` 里，写进去也不会凭空多出重叠块。
 */
export function pasteRunOrders(
  projectId: string | null, rowName: string, orders: readonly number[],
  at: number, shots: readonly ShotInfo[], blocked: ReadonlySet<number>,
  stageId?: string,
): number[] {
  const st = useAssetOverride.getState();
  if (!projectId || st.projectId !== projectId || !orders.length) return [];
  const shotOf = new Map(shots.map((s) => [s.order, s]));
  const base = orders[0];
  const target = orders.map((o) => at + (o - base));
  const ok = target.filter((o) => {
    const sh = shotOf.get(o);
    return !!sh && !sh.is_special && !blocked.has(o);
  });
  if (ok.length !== target.length) return [];
  // ⚠️ 同 `deleteRunOrders`：必须盖章，而且粘贴这一侧后果更重。不盖章的
  // `present:true` 会被同角色**每一条**造型段捡去 —— 把常服 #1-4 粘到 #5，
  // 夜行衣（底座 #9-12，从没声明过 #5）也会在 #5 画出一块，外加一条
  // 「人工注入」段，三块叠在一起。这正是用户报的"拉长会创建一个新的资产块
  // （如果没有，就有一个人工注入），而且是覆盖重叠的"，只是入口换成了键盘。
  const ops = ok.map((o) => ({ order: o, present: true, manual: true, stageId }));
  recordWithUndo(
    `复制「${rowName}」注入段到 #${target[0]}-#${target[target.length - 1]}`,
    rowName, ops, ok.map((o) => shotOf.get(o)!.id));
  return ok;
}

/* ------------------------------------------------------------------ *
 * 给渲染用的便捷读法
 *
 * ⚠️ 这里的三个函数**不是**可选的便利封装，而是渲染的**唯一**入口：
 * `AssetTrack` 必须用它们而不是直接读 `st.present_orders`。
 * 直接用服务端底座，本地那笔调整就不会出现在画面上 —— 而画面才是
 * 用户唯一看得见的事实。
 * ------------------------------------------------------------------ */

/** 某一行当前该显示的 order（服务端底座 + 本地台账）。
 *
 *  台账属于**别的项目**（还没 `openProject`）时退回底座：宁可不显示本地调整，
 *  也不能把一个项目的调整画到另一个项目上。 */
export function displayOrdersOf(
  base: readonly number[], projectId: string, rowName: string,
  isSpecial?: (order: number) => boolean,
): number[] {
  if (useAssetOverride.getState().projectId !== projectId) return [...base].sort((a, b) => a - b);
  return projectOrders(base, opsOf(useAssetOverride.getState().table, rowName), isSpecial);
}

/** 参考资产轨（`kind === "reference"`）的 order：底座恒为空（后端没有这一行的
 *  `present_orders` 概念），全部来自本地台账。 */
export function displayReferenceOrders(
  projectId: string, rowName: string,
  isSpecial?: (order: number) => boolean,
): number[] {
  return displayOrdersOf([], projectId, rowName, isSpecial);
}

/** 投影后**实际显示**、且由用户手动加进来的 order（画斜纹）。 */
export function displayManualAddsOf(
  base: readonly number[], shown: readonly number[], projectId: string, rowName: string,
): number[] {
  if (useAssetOverride.getState().projectId !== projectId) return [];
  return projectManualAdds(
    shown, base, opsOf(useAssetOverride.getState().table, rowName));
}

export { projectManualAdds };
