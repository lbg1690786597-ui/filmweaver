/**
 * stagedWrite — 拖拽期间的"本地先走、落库延后"通用机制（批次 2 / 2.2）
 *
 * ## 要解决的具体毛病
 *
 * 画布拖拽（`CropZoomOverlay`）与属性滑块（`ClipProperties`）此前是**每个
 * pointermove 事件发一次 PATCH**，而 `App.doPatchTransform` 每次 PATCH 后还
 * `await refreshDetail()` —— 也就是每帧一次写 + 一次全项目详情 GET。
 * 拖 3 秒能打出上百组请求，后果不只是慢：
 *
 *   - 这些请求**返回顺序不保证**。`useProject` 的 seq 守卫会丢弃过期响应，
 *     但被丢弃的可能正是最后那一次 —— 表现为松手后画面弹回中途的值。
 *   - 每帧 PATCH 都是一次"整体替换 transform_meta"的写，任何一次失败都
 *     可能把整组参数写成半路状态（2.3 的乐观锁要处理的正是这条路）。
 *
 * ## 机制
 *
 * `stage(key, value)`：立刻记进内存并通知 UI（**所以画面依然跟手**），
 * 同时把真正的落库推到 `delayMs` 之后；期间再有 stage 就重置计时器（尾防抖）。
 * `writeNow(key, value)`：松手/离焦时用，跳过等待直接落库。
 *
 * 两者配合的结果：拖 3 秒 = 1 次 PATCH（松手那一次），
 * 且**松手后的值一定是最终值**。计时器是兜底 —— 万一没收到 pointerup
 * （pointercancel、窗口失焦、拖到浏览器外面松手），最后一次 stage 之后
 * `delayMs` 也会自己落库，不会静默丢掉用户的改动。
 *
 * ## 为什么失败时**保留**本地值
 *
 * 落库失败（断网/500）时不把本地值回滚：用户看到的仍是自己刚调的画面，
 * 而顶栏的保存状态（2.1）会明确显示「未保存」。反过来做——悄悄回滚到服务端
 * 旧值——等于在用户不知情的时候丢掉他的操作，比留着一个"未落库的正确画面"坏得多。
 *
 * ## 为什么定时器可注入
 *
 * 「拖 3 秒只发 1 次 PATCH」是本条的验收标准，得**能测**。
 * 注入假时钟后 `verify-staged-write.ts` 可以模拟 180 次 stage 再断言
 * commit 次数，而不是跑 3 秒真实时间去赌。
 */

export interface StagedWriterOpts<V> {
  /** 最后一次 stage 之后多久落库；只是兜底，正常路径靠 writeNow */
  delayMs?: number;
  /** 真正的落库动作。抛异常即视为失败（本地值保留） */
  commit: (key: string, value: V) => Promise<void>;
  /** 待写集合发生变化时调用，用来触发 UI 重渲染 */
  onChange?: () => void;
  /** 落库失败时调用（提示由调用方决定，本模块不认识 toast） */
  onError?: (key: string, err: unknown) => void;
  /** 可注入的定时器，缺省用 window/global 的 */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (t: unknown) => void;
}

export interface StagedWriter<V> {
  /** 拖拽中每帧调用：本地立即生效，落库延后 */
  stage: (key: string, value: V) => void;
  /** 松手 / 离焦 / 离散操作：立即落库，不等防抖 */
  writeNow: (key: string, value: V) => Promise<void>;
  /** 立刻落库所有待写项（卸载前、导出前用） */
  flush: () => Promise<void>;
  /** 取某 key 的待写值；没有返回 undefined */
  peek: (key: string) => V | undefined;
  /** 是否有任何待写项 */
  hasPending: () => boolean;
  /** 丢掉计时器（不落库）。仅用于组件卸载后不再回调 */
  dispose: () => void;
  /** 供验证脚本断言：stage / commit 各发生了多少次 */
  readonly stats: { staged: number; commits: number; failures: number };
}

interface Entry<V> { value: V; seq: number }

export function createStagedWriter<V>(opts: StagedWriterOpts<V>): StagedWriter<V> {
  const delayMs = opts.delayMs ?? 250;
  const schedule = opts.schedule
    ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const cancel = opts.cancel ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));

  const pending = new Map<string, Entry<V>>();
  let seq = 0;
  let timer: unknown = null;
  let disposed = false;
  const stats = { staged: 0, commits: 0, failures: 0 };

  const clearTimer = () => {
    if (timer !== null) { cancel(timer); timer = null; }
  };

  const armTimer = () => {
    // 尾防抖：每次 stage 都重置，所以连续拖动期间一次都不落库
    clearTimer();
    timer = schedule(() => { timer = null; void flush(); }, delayMs);
  };

  async function commitOne(key: string, entry: Entry<V>): Promise<void> {
    try {
      await opts.commit(key, entry.value);
      stats.commits++;
      // 期间又 stage 了新值 → 这条待写还没落库完，别删
      if (pending.get(key)?.seq === entry.seq) {
        pending.delete(key);
        opts.onChange?.();
      }
    } catch (e) {
      stats.failures++;
      // 失败**保留**本地值（见文件头）。顶栏的保存状态会显示未保存。
      opts.onError?.(key, e);
    }
  }

  async function flush(): Promise<void> {
    clearTimer();
    const batch = [...pending.entries()];
    if (!batch.length) return;
    // 不同 key 是不同镜头，互不相干，并行即可；同 key 不会并发（Map 只有一条）
    await Promise.all(batch.map(([k, e]) => commitOne(k, e)));
  }

  return {
    stage(key, value) {
      if (disposed) return;
      stats.staged++;
      pending.set(key, { value, seq: ++seq });
      opts.onChange?.();
      armTimer();
    },

    async writeNow(key, value) {
      if (disposed) return;
      pending.set(key, { value, seq: ++seq });
      opts.onChange?.();
      await flush();
    },

    flush,
    peek: (key) => pending.get(key)?.value,
    hasPending: () => pending.size > 0,
    dispose() { disposed = true; clearTimer(); },
    stats,
  };
}

/**
 * 把待写值盖到一组带 id 的对象上 —— 这就是"画面依然跟手"的实现。
 *
 * 抽成纯函数（而不是留在 `useStagedTransform` 里）有两个原因：
 *  1. **可测**：hook 里的分支在 node 下跑不起来，而这几行正是"拖动中画面不冻结"
 *     这件事的全部逻辑，必须有验证脚本盯着（见 verify-staged-write.ts ⑤）。
 *  2. 没有待写项时**原样返回同一个数组引用**：新引用会让下游所有
 *     `useMemo`/依赖数组每帧失效，把省下来的请求又用渲染赔回去。
 */
export function overlayPending<T extends { id: string }, V>(
  writer: Pick<StagedWriter<V>, "hasPending" | "peek">,
  items: readonly T[],
  apply: (item: T, value: V) => T,
): readonly T[] {
  if (!writer.hasPending()) return items;
  let touched = false;
  const out = items.map((it) => {
    const v = writer.peek(it.id);
    if (v === undefined) return it;
    touched = true;
    return apply(it, v);
  });
  // 待写的 key 不在这批 items 里（切了项目、镜头被删）→ 同样不制造新引用
  return touched ? out : items;
}
