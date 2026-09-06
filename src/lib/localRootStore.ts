/**
 * lib/localRootStore.ts — 本次启动已授权的素材根（会话级登记簿，6.6）
 *
 * ## 为什么是模块级单例，而不是 React state
 *
 * 因为它描述的东西**本来就是进程级的**：fs scope 是用户在原生对话框里选目录时，
 * dialog 插件对**整个进程**授予的（见 `localRoot.ts` 文件头）。谁问都该得到同一个
 * 答案，而且提问的不只有 React —— `render/renderer.ts` 里的 `prepIO()` 也要问，
 * 它不在任何组件里。把它做成组件状态就得从设置面板一路往下穿到渲染器，
 * 穿的过程中还会多出"两处副本不一致"这种本可以不存在的失败形态。
 *
 * ## 它不持久化，这是刻意的
 *
 * 授权本身就不跨重启，登记簿跟着一起清空才是**诚实**的。写进 localStorage
 * 会让重启后的列表显示"已授权 3 个目录"，而实际一个都读不了 —— 那正是
 * 6.6 最想避免的那种界面。
 *
 * ## `canReadLocal()`：让这份列表**说了算**，而不是只用来显示
 *
 * 插件那边没有"撤销某个路径"的 JS 接口，scope 一旦授予就只增不减、直到进程退出。
 * 所以如果这份列表只用于显示，设置里那个「移出列表」按钮就是**假的** ——
 * 点完之后本应用照样读得到那个目录。于是把读取入口统一收在
 * `canReadLocal()` 后面：列表里没有的路径，**本应用自己不读**。
 *
 * ⚠️ 说清楚它是什么、不是什么：
 *   · 它**不是**安全边界（真边界仍在 Rust 侧的 scope，见 `localRoot.ts`）；
 *   · 它是**一致性**机制 —— 让界面上写的和程序实际干的是同一件事。
 * 相应地，「移出列表」的文案必须说实话：本软件不再读它，而系统层面的授权
 * 要到关闭软件时才真正释放。
 */

import { addRoot, removeRoot, rootFor, type LocalRoot } from "./localRoot";

let roots: readonly LocalRoot[] = [];
const listeners = new Set<() => void>();

/**
 * 两份列表是不是同一批根。
 *
 * 只比 `path`：`label` 由 path 推导，`grantedAt` 只在**新增**时才产生，
 * 而 `addRoot` 对已覆盖的路径根本不新增（`isUnder(p, p)` 为真），
 * 所以"路径逐个相同"必然意味着"这就是原来那批根"。
 */
function sameList(a: readonly LocalRoot[], b: readonly LocalRoot[]): boolean {
  return a.length === b.length && a.every((r, i) => r.path === b[i].path);
}

/**
 * 换上新列表并通知订阅者。**没变化就不换、也不通知**，返回是否真的变了。
 *
 * 「没变化就不换引用」是**承重**的：`getLocalRoots` 是
 * `useSyncExternalStore` 的 getSnapshot，而 `addRoot` 每次都返回新数组 ——
 * 若原样存回去，每次 `grantLocalRoots` 都会产生一个新引用，React 判定
 * "快照变了"就再渲染一次、再读一次快照…… 重复选同一个目录会直接把界面转死。
 */
function commit(next: LocalRoot[]): boolean {
  if (sameList(roots, next)) return false;
  roots = next;
  for (const fn of [...listeners]) fn();
  return true;
}

/** 当前已授权的素材根。引用稳定：内容没变时永远是同一个数组。 */
export function getLocalRoots(): readonly LocalRoot[] {
  return roots;
}

/** 订阅变化（配 `useSyncExternalStore`）。返回退订函数。 */
export function subscribeLocalRoots(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 登记一批刚授权的根（原生对话框可以多选，所以收的是数组）。
 *
 * 整批算完**只通知一次**：一次多选逐个通知会让列表在界面上跳着长出来，
 * 也会让订阅者收到若干个中间态。
 */
export function grantLocalRoots(paths: readonly string[], now: number): boolean {
  let next = [...roots];
  for (const p of paths) next = addRoot(next, p, now);
  return commit(next);
}

/** 把一个根移出列表。之后 `canReadLocal` 对它一律返回 false。 */
export function forgetLocalRoot(path: string): boolean {
  return commit(removeRoot(roots, path));
}

/**
 * 本应用**愿不愿意**读这个路径。
 *
 * 生产侧的 `statLocal` 必须先过这一关再碰盘 —— 这是「移出列表」真正生效的地方。
 */
export function canReadLocal(path: string): boolean {
  return rootFor(path, roots) !== null;
}

/** 清空登记簿。给验证脚本用；产品里没有"一键取消全部授权"这个入口。 */
export function resetLocalRoots(): boolean {
  return commit([]);
}
