/**
 * projectStore.ts — `detail` 的唯一所有者（B1 → B4）
 *
 * ## 为什么要有这个文件
 *
 * 在它之前，`detail`（当前项目的整份详情：镜头/分集/资产）住在 `useProject`
 * 这个 hook 的 `useState` 里，而**调用方只有 `App.tsx:135` 一处**，
 * 拿到之后靠 props 往下传给 18 个组件，再加 28 处 `refreshDetail()`。
 * 结果是一个 1.17 MiB 的对象在整个组件树里被复制、被 props 层层转运，
 * 而每一处"改完要不要重拉"的判断都得由**写代码的人**记住 —— 记不住的
 * 那几处就变成了 B0 处理掉的那些纯浪费刷新。
 *
 * 这里把它搬到 zustand，和 `timelineStore` / `editorStore` 同一套路数：
 *
 * ```
 * 现在：  App.tsx (useState) ──28 处 refreshDetail──> api ──> 后端
 *                            └─ patchDetail（人工保证 seq 正确）
 *
 * 之后：  projectStore (zustand)
 *           ├── 权威内存模型（detail 的新家）
 *           ├── 组件自己订阅（不再靠 props 层层传）      ← B2
 *           ├── 写操作直接改 store，网络写降级为后台同步  ← B3 / C
 *           └── 复用已有的 snapshot / outbox / shotRev —— 它们终于有了上层  ← B4 ✅
 * ```
 *
 * ⚠️ **本文件是 B1，不是 B2/B3。** B1 只做"搬家"：把 `useProject` 里的
 * 状态与四个动作**逐字**搬进来，`useProject` 退化成一层薄薄的订阅壳
 * （见 `hooks/useProject.ts`）。行为必须逐字不变 —— 这也是为什么
 * `seq` / `detailRef` 这些看着像实现细节的东西一个没删：它们各自兜着
 * 一个真实的竞态（见下面各自的注释），搬家不是重写，先把地基摆正。
 *
 * ## B4：三个"早就写好、一直没有上层"的机制接进权威模型
 *
 * `snapshot` / `outbox` / `shotRev` 都先于 B1 存在，但它们的接线点一直挂在
 * `App.tsx` 里 —— 也就是说**它们靠的是一个恰好也拿着 `detail` 的组件**。
 * B1 把 `detail` 搬走之后，这个"恰好"就不成立了：
 *
 * | 机制 | B4 前挂在哪 | 为什么必须搬进来 |
 * |---|---|---|
 * | `shotRev.seed` | App 的一个 `useEffect([detail])` | 采纳规则取决于"这一行**刷新的那一刻**有没有未落库改动"，而刷新现在发生在 store 内部。留在 App 里就是"先 `set` 再 `seed`"，中间那一帧注册表里是**上一轮**的版本号 |
 * | `shotRev.clear` | App 的 `resetWorkspace()`，紧挨 `clearDetail()` | 两句话被拆到两个文件里，谁新增一条"离开项目"的路径（深链、退出登录）都可能只记得调其中一句，于是上个项目的镜头 id 带着旧版本号进新项目 |
 * | `outbox` 补发完成 | App 的 `onReconnect` 回调 | 补发**改了服务端**，而补发的那些笔（离线改的时长/画面）**不会**自动进内存 —— 用户联网后看到的是补发前的旧值，还以为没补上 |
 *
 * 三条都不是"顺手的整理"，各自兜着一个具体的错误行为，见各自的接线点注释。
 *
 * **刻意不做**：store **不订阅** `outboxStore`（不 `subscribeOutbox` 去自动补发）。
 * 补发的时机是"确认连上了"，那是会话层（`useAuth` 的 `onReconnect`）才知道的事；
 * store 自己拉一条订阅，会在任何一次入队后立刻尝试发送，把"离线"这件事绕过去。
 * B4 只做**出口**（`replayOutbox`），时机仍由会话层给。
 *
 * ## 模块级变量而不是 store 字段
 *
 * `seq` / `detailRef` / `refreshTimer` 是**不参与渲染**的：没有组件需要
 * 在它们变化时重渲染，放进 store 只会让每次自增都触发一次无谓的订阅通知。
 * 它们也不需要"跟随实例"——整个应用只有一个项目详情，不是每组件一份。
 * 所以放在模块作用域，语义上更准：它们是**这个 store 的私有实现**，
 * 不是它的公开状态。（`detailRef` 尤其重要，见下。）
 */

import { create } from "zustand";
import { api, ProjectDetail, ShotInfo } from "../api";
import { prefetcher } from "../lib/mediaCache";
import { IS_TAURI } from "../lib/isTauri";
import { tauriSnapshotIO } from "../lib/persistIO";
import { isUsableSnapshot, makeSnapshot } from "../lib/snapshot";
import { reconcileDetail } from "../lib/reconcileDetail";
import { shotRev } from "../lib/shotRev";
import { getOutboxCount, runReplay } from "../lib/outboxStore";
import type { QueuedWrite, ReplayResult } from "../lib/outbox";

/**
 * 请求序号：并发的 refreshDetail（refreshSoon 合并刷新、SSE 触发、各 patch 后的
 * 刷新会同时在飞）返回顺序不保证，先发的可能后到并**覆盖新数据** ——
 * 表现为刚拖完的时长/顺序又跳回旧值。只接受最后一次发出的那个响应。
 *
 * ⚠️ `patchDetail` 也必须推进它（见那里的注释），否则"拖完过两秒自己弹回去"。
 */
let seq = 0;

/**
 * `detail` 的镜像。**不能**改成"用 `get().detail`"了事。
 *
 * 两个用处，都不是 `get()` 能替代的：
 *  1. `refreshDetail` 里要用**上一轮的对象引用**喂给 `reconcileDetail` 做复用
 *     （见 lib/reconcileDetail.ts）。`get()` 也能拿到，所以这条其实可以替代；
 *  2. `patchDetail` 里要拿"内存里到底有没有数据"的**瞬时值**，
 *     而它是从回调里读的 —— 回调捕获的 `detail` 会是闭包里的旧值。
 *
 * 搬家时保留它是为了**逐字不变**：它是原实现的一部分，改掉就把 B1 变成了
 * 一次有风险的改写。等 B3 把调用点都收进 store 之后再评估要不要合并。
 */
let detailRef: ProjectDetail | null = null;

/** P2-5：事件可能连发（多镜并发流转），800ms 合并一次全量刷新，避免 detail 请求风暴。 */
let refreshTimer: number | null = null;

/**
 * B4：某一镜是否还有**未落库的本地改动**。
 *
 * 唯一的真相源是 2.2 的暂存层（`useStagedTransform` 的 `hasPending`），
 * 它由 `App.tsx` 在挂载时注入 —— 注册表规则本身（"有未落库改动就不采纳
 * 服务端版本号"）在 `lib/shotRev.ts` 文件头，这里只负责把那次询问
 * 搬到与 `seed` **同一个函数里**。
 *
 * 为什么是模块级变量而不是 store 字段：暂存集合在拖动中**每帧**变化，
 * 进 store 就等于每帧通知一次全部订阅者。而它在这里只被 `seed` 读，
 * 没有任何组件需要在它变化时重渲染。
 *
 * 没被注入时按"没有未落库改动"处理 —— 与 `seed` 的默认值同义。
 */
let hasPendingFn: (shotId: string) => boolean = () => false;

/** 由 `App.tsx` 挂载时注入暂存层的 `hasPending`（见上）。 */
export function setPendingProbe(fn: (shotId: string) => boolean): void {
  hasPendingFn = fn;
}

interface ProjectState {
  /** 当前项目 id。记在 localStorage 里，启动时恢复现场（T-R0-07 状态云端化）。 */
  projectId: string | null;
  setProjectId: (id: string | null) => void;

  /** 全部视图的唯一数据源：镜头 / 分集 / 资产。 */
  detail: ProjectDetail | null;
  /** detail 来自本机快照而非服务端 —— 断线横幅要据此说明"你看到的不是最新的"。 */
  snapshotAt: number | null;

  refreshDetail: (pid?: string) => Promise<void>;
  refreshSoon: () => void;
  patchDetail: (shotId: string, patch: Partial<ShotInfo>) => void;
  clearDetail: () => void;

  /**
   * B4 · 2.3：这次 `transform_meta` 写要带的 base 版本号。
   * `undefined` = 不带，服务端跳过校验（见 `lib/shotRev.ts` 文件头）。
   */
  transformRevBase: (shotId: string) => string | undefined;
  /** B4 · 2.3：写成功后收下服务端回的新版本号；传空 = 忘掉（老后端没回）。 */
  noteTransformRev: (shotId: string, rev?: string | null) => void;
  /** B4 · 2.3：409 之后忘掉，让用户下一次操作以自己的版本为准。 */
  forgetTransformRev: (shotId: string) => void;

  /**
   * B4 · 6.8：补发离线队列，**并把补发结果落到内存**。
   *
   * `send` 由会话层给（它才知道怎么带上当前的鉴权头）。返回 `null` 表示
   * 队列本来就是空的（或已有一趟在跑），此时**不刷新** —— 没写就没得变。
   */
  replayOutbox: (send: (w: QueuedWrite) => Promise<number | null>) => Promise<ReplayResult | null>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectId: localStorage.getItem("fw_project") || null,
  setProjectId: (id) => set({ projectId: id }),

  detail: null,
  snapshotAt: null,

  refreshDetail: async (pid?: string) => {
    const id = pid ?? get().projectId;
    if (!id) return;
    const my = ++seq;
    try {
      const raw = await api.projectDetail(id);
      // 期间又发起了新请求 → 本次结果已过期，丢弃
      if (my !== seq) return;
      // 切项目时上一项目的 in-flight 请求也会走到这里，
      // clearDetail() 清不掉飞行中的 promise，所以再确认一次归属
      if (id !== (pid ?? get().projectId)) return;
      // U2 第 3 点：把没变动的镜头/资产/分集**换回上一轮的对象引用**。
      // 不做这一步的话，1424 镜的项目里只要有一个镜头出片，整份 JSON 都是
      // 新对象 → `ShotCard` 的 memo 全判不等 → 1424 张卡片重渲染一遍。
      // 详见 lib/reconcileDetail.ts（含"为什么不按下标配对""为什么不比 JSON 串"）。
      const d = reconcileDetail(detailRef, raw);
      // B4 · 2.3：收下服务端版本号。规则是「有未落库的本地改动就不更新」
      // ——那些镜头屏幕上显示的是用户自己的值，采纳新版本号等于主动放弃
      // 冲突检测（完整推导见 lib/shotRev.ts 文件头）。
      //
      // ⚠️ 位置有两层讲究：
      //  1. 必须在 `set` **之前**——`set` 之后任何一次重渲染（下一帧就可能有）
      //     里用户发起的编辑，读到的 base 必须已经是这一轮的。以前这段在
      //     App 的 `useEffect([detail])` 里，那是"渲染之后再跑"，中间隔一帧。
      //  2. 也必须在 `detailRef = d` **之前**——`detailRef` 与 `set` 的相邻
      //     是承重的（`verify-detail-reconcile.ts` 钉着：两者必须是同一个
      //     复用后的对象，否则下一轮整份都复用不上）。插在它们中间会把
      //     那条相邻关系切断。放这儿两者兼得。
      shotRev.seed(d.shots, hasPendingFn);
      detailRef = d;
      set({ detail: d, snapshotAt: null });   // 拿到真数据了，不再是快照
      // 6.8：落盘。放在**序号校验之后**是承重的——过期响应本来就不该
      // 进 set，更不该覆盖盘上那份更新的快照（那会让下次断网启动
      // 读回一个比内存里更旧的世界，且完全看不出来）。
      if (IS_TAURI) {
        void tauriSnapshotIO.write(makeSnapshot(id, d, Date.now()))
          .catch((e) => console.warn("[projectStore] 快照落盘失败:", e));
      }
      // 6.2 AI 产物即时落盘：这是前端**唯一**得知素材 URL 的地方，所以预取的
      // 触发点只能挂在这儿。语义是「基线 + 增量」——第一次见到这个项目只记账，
      // 之后新冒出来的 URL 才下载，而"新冒出来"恰好等价于"某个 AI 任务刚完成"。
      // 详见 lib/prefetch.ts 的文件头（含为什么不能"detail 里有的都下一遍"）。
      prefetcher.warmNew(d.id, "shots", d.shots.map((s) => s.video_url));
    } catch (e) {
      if (my !== seq) return;
      // ⚠️ 只有"项目确实不存在"才清场。
      // 原来是无差别 catch —— 一次 5xx 或断网就 setProjectId(null) +
      // 删 localStorage，把正在工作的用户直接弹回项目列表，未保存的
      // 选中态/预览全没了。网络抖动比项目被删常见得多。
      const status = (e as { status?: number })?.status;
      const notFound = status === 404 || status === 410;
      if (notFound) {
        localStorage.removeItem("fw_project");
        set({ projectId: null });
        // 项目真没了，盘上那份快照也不该再留着骗下一次启动
        if (IS_TAURI) void tauriSnapshotIO.remove(id).catch(() => {});
        return;
      }
      // 其余错误保持现状，让用户可以重试；detail 仍是上一次的可用快照
      console.warn("[projectStore] 刷新失败，保留当前项目:", e);
      // 6.8：内存里**还没有**任何 detail（= 断网启动）时，退回本机快照。
      // 已经有 detail 就不动——盘上那份只会比内存里的旧。
      if (IS_TAURI && detailRef === null) {
        try {
          const snap = await tauriSnapshotIO.read(id);
          if (my !== seq) return;
          if (isUsableSnapshot(snap, id)) {
            detailRef = snap.detail as ProjectDetail;
            set({ detail: snap.detail as ProjectDetail, snapshotAt: snap.savedAt });
          }
        } catch (err) {
          console.warn("[projectStore] 快照读取失败:", err);
        }
      }
    }
  },

  refreshSoon: () => {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void get().refreshDetail();
    }, 800);
  },

  /**
   * 3.12（F7）：**局部**回填 detail —— 用一次写请求里已经回来的字段直接改内存里的
   * 那一镜，不再顺手拉一遍全量详情。
   *
   * 为什么要这一层：改前每次落库（裁剪、移轨、分割、变换）尾巴上都挂着
   * 一次 `refreshDetail()`，而详情在 1424 镜的项目里是 **1.17 MiB**，
   * 单镜改一个 `track_index` 也要重下整份 JSON 并整树 reconcile。
   * 这是"松手闪回"（要等一整圈才归位）和"后端卡住时整机不可用"共同依赖的那一环。
   *
   * ⚠️ 边界（哪些改动**不能**用它）：
   *  · **改顺序**（`to_order`）：服务端会把别的镜头一起重排，本地拼不出一致结果
   *    —— 仍然走 `refreshDetail()`。
   *  · **增删镜头**（拆解、分割、插入特殊镜头）：镜头集合会变，`patchDetail`
   *    只能合并"已经存在的行"，新增的行它插不进来 —— 也仍然走全量。
   *  `patchDetail` 收到的 `shotId` 在内存里找不到时**静默忽略**，不报错：
   *  那是"另一件事已经把这镜删了"的正常竞态，此时正该由后续的全量刷新纠正。
   *
   * ⚠️ 必须推进 `seq`。不推进的话，一个**更早发出、更晚回来**的全量响应
   * （`refreshSoon` 的合并刷新、SSE 触发的）会带着旧值落到 `set` 上，
   * 把刚写进去的这行覆盖回旧位置 —— 表现就是"拖完过了两秒自己弹回去"。
   * 这就是 `seq` 存在的理由，任何直接改 detail 的路径都得遵守。
   *
   * 快照落盘：这里**不重写**。内存值比盘上那份新，这是允许的 ——
   * 下次真正加载（切项目/重开）时用的是服务端，快照只在断网启动时兜底。 */
  patchDetail: (shotId, patch) => {
    const cur = detailRef;
    if (!cur) return;
    const i = cur.shots.findIndex((s) => s.id === shotId);
    if (i < 0) return;
    // ⚠️ 只换**那一行**的对象引用，其余行与 `shots` 之外的字段全部沿用旧引用。
    // 这正是 reconcileDetail 在做的事（见 lib/reconcileDetail.ts），复用它的理由
    // 一样：整份换新对象会让 1424 张 ShotCard 的 memo 全判不等 —— 一次单镜改动
    // 重渲染整条时间轴，比多下一个 GET 还糟。
    const shots = cur.shots.slice();
    shots[i] = { ...cur.shots[i], ...patch };
    const next = { ...cur, shots };
    seq++;                       // 作废所有在飞的全量响应（见上）
    detailRef = next;
    set({ detail: next });
  },

  /** 切/关项目时清 detail 与待执行的合并刷新（防旧项目延迟刷新串到新项目） */
  clearDetail: () => {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    detailRef = null;
    // B4 · 2.3：版本号注册表按项目隔离。它和 detail 是**同一份事实的两半**
    // ——"这一镜我手上是哪个版本"在没有这一镜之后毫无意义，而且镜头 id 全局
    // 唯一，留着不会误伤，但会让 size() 随着切项目单调增长。
    //
    // 挪进来（原来在 App 的 resetWorkspace 里，紧挨本函数的调用点）的理由是
    // **配平**：谁清 detail，谁就清它的版本号。两句话分处两个文件时，
    // 新加一条"离开项目"的路径只会记得调其中一句，而漏掉那句的症状
    // （新项目里第一笔 transform 写带着上个项目的版本号 → 偶发 409）
    // 恰恰是最难归因的那类。
    shotRev.clear();
    set({ detail: null, snapshotAt: null });
  },

  transformRevBase: (shotId) => shotRev.base(shotId),
  noteTransformRev: (shotId, rev) => shotRev.noteWritten(shotId, rev),
  forgetTransformRev: (shotId) => shotRev.forget(shotId),

  /**
   * B4 · 6.8：补发 + **把结果落回内存**。
   *
   * 这条是 B4 里唯一**新增行为**的三行（其余都是搬家）。补发之前，
   * `runReplay` 成功之后内存里的 `detail` 还是离线那一刻的旧值：
   * 用户在断网时改了三个镜头的时长，联网后被告知"已补发 3 处"，
   * 而屏幕上那三条还是旧时长 —— 看起来像补发没生效，他大概率会再改一遍。
   * PATCH 是绝对值语义，改两遍不至于出错，但这属于"让用户白干一遍"。
   *
   * **只在真的写过之后刷新**：`applied === 0 && conflicted === 0` 时不刷。
   *   · `applied > 0` → 服务端被改了，本地必须重取。
   *   · `conflicted > 0` → 服务端在别处**已经**是另一个值，屏幕上那个是错的，
   *     更要重取（用户此时正需要看到"现在到底是什么样"才能决定重不重做）。
   *   · 全 0（401 中止 / 全 4xx 放弃）→ 服务端一个字节没动，白下 1.17 MiB。
   *
   * 刻意**不**试图把补发的值 `patchDetail` 进内存：队列里存的是 URL 与 body，
   * 要从 URL 反推是哪个镜头、哪个字段，还得按端点分别解析 —— 那是把
   * `api.ts` 的 25 个写端点重写一遍（且每个新端点都要记得同步）。
   * 补发是**少见**路径（断线才发生），一次全量刷新在这里是完全付得起的。
   */
  replayOutbox: async (send) => {
    // 队列为空时不刷新：没写过，内存里就是对的
    const willWrite = getOutboxCount() > 0;
    const r = await runReplay(send);
    if (r === null) return null;
    if (willWrite && (r.applied > 0 || r.conflicted > 0)) {
      await get().refreshDetail();
    }
    return r;
  },
}));

/* 启动恢复现场（「有 projectId 就先拉一次」）仍然由 `useProject` 的挂载效应触发，
   不在这里做模块级自启。理由有两条，都不是洁癖：

   1. 首载必须发生在 **App 挂载之后**。本文件是被 `useProject` import 的，
      而 `useProject` 由 App 在渲染期调用 —— 在 main.tsx 里 `import` 到、
      到 App 首次渲染之间还有一段时间，那期间 `api` 的鉴权头/基址尚未就位。
   2. 改成自启会**改变事件顺序**，而 B1 的契约是"逐字搬家"。 */
