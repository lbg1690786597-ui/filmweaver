/**
 * lib/prefetch.ts — AI 产物「一出来就落盘」的后台泳道（批次 6 / 6.2，可注入的纯逻辑）
 *
 * ## 要解决的是什么
 *
 * 6.1 之前（以及 6.1 之后的这一刻），`ensureCached` 在整个应用里**只有一条调用路径**：
 * `render/renderer.ts` 的 `cacheMedia`，而它只在 `render()` 里被调一次。
 * 也就是说素材**只有到了点「开始导出」那一刻才开始下载**。
 *
 * 后果是用户能直接感受到的：一个 601 镜的项目，镜头是过去几个小时里陆续生成的，
 * 网早就闲着；但导出时要在进度条停在「准备素材」上把几个 GB 一次性拉下来。
 * 更糟的是这段时间**没有可跳过的替代路径** —— 6.4「导出跳过下载」的前提，
 * 正是素材在导出之前就已经躺在盘上了。
 *
 * 所以 6.2 的动作是把 `ensureCached` 的触发点从「导出时」提前到
 * 「**前端第一次看见这个 URL 的时候**」。
 *
 * ## 为什么是「基线 + 增量」，而不是「看见就下」
 *
 * 前端得知 URL 的唯一途径是 `useProject.refreshDetail` 的整份 `ProjectDetail`
 * 快照（`useProject.ts:30` 的 `setDetail(d)`），它**没有**「哪几个是新出的」这种信息。
 * 如果照直理解成「detail 里有的都 warm 一遍」，那么用户**打开一个老项目**的瞬间
 * 就会开始静默下载几十 GB —— 他可能只是想看一眼分镜。这是纯粹的伤害。
 *
 * 因此语义定死为：
 *
 * · **第一次见到某个项目** → 把它当前的全部 URL 记进基线，**一个都不下**
 * · 之后的任何一次刷新 → 只有**新冒出来**的 URL 进队列
 *
 * 而「新冒出来的 URL」恰好就是条目本身要的那件事：**某个 AI 任务刚刚完成**。
 * 不需要额外的事件通道，也不需要后端配合。
 *
 * ## 基线必须按「项目 × 通道」分桶，不能只按项目
 *
 * 素材 URL 从**两条互不相干**的通道进前端：镜头视频走 `useProject.refreshDetail`，
 * 旁白/配乐走 `useAudioTrack.refreshAudio`。两边各自调 `warmNew`。
 *
 * 如果基线只按 projectId 分桶，那么先到的那一条会把桶建起来（记账、不下载），
 * 后到的那一条看见桶已存在 → `firstSight === false` → **把自己的 URL 全部当成新出炉的**。
 * 也就是说：打开一个 601 镜的老项目，只要音频那条先跑，紧接着的 detail 刷新
 * 就会把**全部镜头视频**排进队列 —— 正好是本设计要避免的那件事，而且是静默发生的。
 *
 * 所以 `channel` 是**必填**参数，不给默认值：给了默认值，下一个接进来的通道
 * 就会不声不响地复用别人的桶，重演一次上面这个 bug。
 *
 * ## 为什么泳道只有一条，而且导出时必须让路
 *
 * 预取是**背景噪音**，用户没在等它。导出是用户正盯着进度条等的前台任务。
 * 两者抢同一条上行/下行带宽时，谁该让路没有悬念，所以：
 *
 * · 并发恒为 **1**（不是可调参数 —— 调大它就是拿用户的导出速度换一个没人在等的东西）
 * · `App.tsx` 在 `doLocalExport` 前后 `pause()` / `resume()`
 * · `pause()` 会**掐断当前这一件**，不是"等它下完再停"：慢网下一个大素材就是
 *   几十秒的继续抢带宽。被掐的那件原样放回队头，`resume()` 后重来。
 *
 * ⚠️ 掐断是安全的，**这一点由 6.1 的引用计数取消承重**：预取和导出要同一个 URL 时，
 * 两边挂在**同一次飞行**上（单飞），预取撤走只是等待者减一；只要导出还在等，
 * 那次 `fetch` 就不会被 abort。反过来说，如果 6.1 是「谁取消谁掐 fetch」的写法，
 * 这里每 pause 一次就会打断导出自己的下载 —— 那才是灾难。
 *
 * ## 为什么规则住在这个不 import 任何东西的文件里
 *
 * 与 `cacheName.ts` / `cacheFetch.ts` 同一个理由：`mediaCache.ts` 必须
 * `import { api }`，而 `api.ts` 顶层读 `import.meta.env`，**node 下 import 即抛**。
 * 规则写在那边就只能靠源码 grep 断言，而这里的每一条语义
 * （基线不下载 / 增量才下 / 并发恒 1 / pause 掐当前件 / 队列上限）
 * 都是**能被真跑出来**的行为。生产注入真的 `ensureCached`，
 * `scripts/verify-prefetch.ts` 注入一个假的，跑的是同一份规则。
 */

import { Aborted } from "./aborted";
import type { EnsureCached } from "./cacheFetch";

/** 被掐断（pause）与真失败必须分开：前者要放回队列重来，后者要计入失败并放弃。 */
function isAborted(e: unknown): boolean {
  return e instanceof Aborted || (e as { name?: string })?.name === "Aborted";
}

export interface PrefetchStats {
  /** 还排在队里的件数 */
  queued: number;
  /** 正在下的（恒为 0 或 1） */
  inFlight: number;
  /** 成功落盘的累计件数 */
  done: number;
  /** 真失败（非取消）的累计件数 */
  failed: number;
  /** 因队列超上限被丢弃的累计件数 */
  dropped: number;
  /** 已建立基线的项目数 */
  projects: number;
  /** 已见过的 URL 总数（含基线里那些从没下过的） */
  urls: number;
  paused: boolean;
}

export interface Prefetcher {
  /**
   * 报告「某项目的某条通道此刻的全部素材 URL」，返回**本次新入队**的件数。
   *
   * 第一次见到该 (项目, 通道) 时只建基线、返回 0；之后只有新 URL 进队。
   * null / 空串 / 重复项一律跳过。调用方不需要自己去重或判空。
   *
   * @param channel 素材来源通道（`"shots"` / `"audio"`）。**必填**，理由见文件头：
   *                两条通道共用一个桶会让后到的那条把自己的 URL 全当成新的。
   */
  warmNew(
    projectId: string,
    channel: string,
    urls: readonly (string | null | undefined)[],
  ): number;
  /** 让路：掐断当前这一件并停下泳道。可重入。 */
  pause(): void;
  /** 恢复泳道。可重入。 */
  resume(): void;
  /** 丢掉某项目（或全部）的基线与排队项。**切项目不该调它**，见下方注释。 */
  forget(projectId?: string): void;
  /** 可观测状态：队列/在飞/累计成败/基线规模。验证与排障用。 */
  stats(): PrefetchStats;
  /**
   * 等泳道停下来（跑空了，**或者**被 pause 停住了）。
   *
   * 刻意不是「等队列排空」：paused 时队列可以永远非空，那种 `idle()` 会一直挂着，
   * 验证脚本里就表现为超时——而超时按失败记，等于给自己埋一颗定时炸弹。
   */
  idle(): Promise<void>;
}

export interface PrefetchOpts {
  /**
   * 现在能不能预取。生产里是 `() => IS_TAURI` —— 纯浏览器里
   * `appDataDir()` 直接抛，落盘这一路整条不存在。
   *
   * 每次 `warmNew` 都会问一次（而不是构造时问一次）：模块级常量在 import 时求值，
   * 而 `IS_TAURI` 依赖 `window` 上的注入，两者的先后顺序不该由本文件来赌。
   */
  enabled: () => boolean;
  /**
   * 队列上限，缺省 5000。这是**内存护栏**，不是节流：并发恒 1 的泳道排到 5000 件
   * 本来就已经荒谬。满了之后丢**队头**（最老的）——新出炉的 AI 产物才是用户
   * 下一步最可能要的东西。被丢掉的不会重排（它已在基线里），
   * 但导出时 `cacheMedia` 仍会自己下，所以最坏结果是"回到 6.2 之前"，不是错。
   */
  max?: number;
  /** 真失败时的回调（取消不算）。缺省 `console.warn`。**不允许抛**。 */
  onError?: (url: string, e: unknown) => void;
}

interface Item { projectId: string; url: string }

/**
 * 造一个后台预取泳道。
 *
 * 状态全挂在闭包里而不是模块级 —— 与 `makeEnsureCached` 同一个理由：
 * 模块级全局会让验证脚本的用例之间串味，那种"上一条用例的残留让这一条变绿"
 * 是最难查的假绿。
 */
export function makePrefetcher(ensure: EnsureCached, opts: PrefetchOpts): Prefetcher {
  const max = opts.max ?? 5000;
  const onError = opts.onError
    ?? ((url: string, e: unknown) => console.warn("[prefetch] 预取失败（不影响导出）:", url, e));

  /**
   * `<projectId>\n<channel>` → 已见过的 URL。**这就是基线**：在里面 = 不是新的 = 不下。
   *
   * 用 `\n` 而不是空格/冒号做分隔：projectId 是 UUID、channel 是本文件内的字面量，
   * 两者都不含换行，所以这个键**不可能**被拼接歧义碰撞。
   */
  const seen = new Map<string, Set<string>>();
  const bucketKey = (projectId: string, channel: string) => `${projectId}\n${channel}`;
  const queue: Item[] = [];
  const inQueue = new Set<string>();

  let running = false;
  let paused = false;
  let cur: { item: Item; ctl: AbortController } | null = null;
  let done = 0;
  let failed = 0;
  let dropped = 0;
  const idleWaiters: (() => void)[] = [];

  const keyOf = (it: Item) => `${it.projectId} ${it.url}`;

  async function pump(): Promise<void> {
    running = true;
    try {
      while (!paused && queue.length) {
        const item = queue.shift() as Item;
        inQueue.delete(keyOf(item));
        const ctl = new AbortController();
        cur = { item, ctl };
        try {
          await ensure(item.projectId, item.url, ctl.signal);
          done++;
        } catch (e) {
          if (isAborted(e)) {
            // 只有 pause() 会掐它。原样放回**队头**：它是被让路让掉的，不是失败，
            // 排到队尾等于让最该先下的那件排在几百件后面。
            queue.unshift(item);
            inQueue.add(keyOf(item));
          } else {
            failed++;
            // 预取失败**永远不能冒泡**：用户没发起这件事，不该看见它的错误，
            // 更不该因为它中断泳道里其余几百件。导出时 `cacheMedia` 会自己再试一次。
            try { onError(item.url, e); } catch { /* 回调自己炸了也不能带走泳道 */ }
          }
        } finally {
          cur = null;
        }
      }
    } finally {
      running = false;
      // 一次性取走再逐个调：回调里若又 warmNew 起了新泳道，
      // 不该把它的等待者也在这一轮 resolve 掉。
      for (const w of idleWaiters.splice(0)) w();
    }
  }

  /**
   * 有活就把泳道叫醒。
   *
   * ⚠️ 这里的 `!paused` **不承重**，是一句纯省事：`pump()` 自己的
   * `while (!paused && …)` 已经挡住了一切 —— 去掉这里的判断，`pump()` 会被启动、
   * 然后立刻从循环条件退出，行为一字不差（已用变异测试实测：删掉它断言全绿）。
   * 留着只是为了不白起一个微任务。
   *
   * 把它写在这里是为了下一个读到这段的人：**"暂停真的停住了"这条性质由 `pump()`
   * 的循环条件承重**，改那一行才是危险的。别把这句当成实现。
   */
  function wake(): void {
    if (!running && !paused && queue.length) void pump();
  }

  return {
    warmNew(projectId, channel, urls) {
      // 关掉时连基线都不建：`enabled()` 在生产里是 `IS_TAURI`，它在一次会话里
      // 不会变。建了基线也永远没人消费，白占内存。
      if (!opts.enabled() || !projectId) return 0;

      const bk = bucketKey(projectId, channel);
      let set = seen.get(bk);
      const firstSight = set === undefined;
      if (!set) { set = new Set(); seen.set(bk, set); }

      let queued = 0;
      for (const u of urls) {
        if (!u) continue;              // null / undefined / 空串：镜头还没出片
        if (set.has(u)) continue;      // 见过了（基线里的，或已排过队的）
        set.add(u);
        // ⚠️ 第一次见到这条通道 → 只记账，**一件都不下**。
        // 否则打开一个 601 镜的老项目 = 静默拉几个 GB，而用户可能只想看眼分镜。
        if (firstSight) continue;
        const it: Item = { projectId, url: u };
        queue.push(it);
        inQueue.add(keyOf(it));
        queued++;
      }

      // 上限：丢最老的。见 PrefetchOpts.max 的注释。
      while (queue.length > max) {
        const gone = queue.shift() as Item;
        inQueue.delete(keyOf(gone));
        dropped++;
      }

      if (queued) wake();
      return queued;
    },

    pause() {
      paused = true;
      // 掐断当前这一件。安全性由 6.1 的引用计数取消承重（见文件头）：
      // 导出若也在等同一个 URL，那次 fetch 不会被掐。
      cur?.ctl.abort();
    },

    resume() {
      paused = false;
      wake();
    },

    // ⚠️ **切项目时不要调它**：回到刚才那个项目会重新建一次基线，
    // 那些"刚才已经记过账、还没下"的 URL 会被再次当成基线（照旧不下）——
    // 看着没坏，但已经排队的会被清空、已经下过的会被重新排队。
    // 基线本来就是按 (项目 × 通道) 分桶的，多留几个项目的 Set 花不了什么内存。
    forget(projectId) {
      if (projectId === undefined) {
        seen.clear();
        queue.length = 0;
        inQueue.clear();
        return;
      }
      // 一个项目有多条通道桶（shots / audio / …），要按前缀整片删，
      // 只 delete(projectId) 会留下 `<pid>\naudio` 这种孤儿桶。
      const prefix = `${projectId}\n`;
      for (const k of [...seen.keys()]) {
        if (k.startsWith(prefix)) seen.delete(k);
      }
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].projectId !== projectId) continue;
        inQueue.delete(keyOf(queue[i]));
        queue.splice(i, 1);
      }
    },

    stats() {
      let urls = 0;
      const projects = new Set<string>();
      for (const [k, s] of seen) {
        urls += s.size;
        projects.add(k.slice(0, k.indexOf("\n")));
      }
      return {
        queued: queue.length,
        inFlight: cur ? 1 : 0,
        done, failed, dropped,
        projects: projects.size,
        urls,
        paused,
      };
    },

    idle() {
      if (!running) return Promise.resolve();
      return new Promise<void>((r) => { idleWaiters.push(r); });
    },
  };
}
