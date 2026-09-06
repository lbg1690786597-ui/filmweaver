/**
 * lib/snapshot.ts — 项目详情的本机快照（6.8，纯规则 + 可注入 I/O）
 *
 * ## 它解决的是 6.7 留下的另一半
 *
 * 6.7 把断线分成了两种：手上有详情就留在编辑器，只有一个 id 就进断线页。
 * 但「手上有详情」这件事**只存在于内存里** —— 关掉软件再断网启动，
 * `detail` 必然是 null，于是必然落到断线页。也就是说 6.7 的好处只在
 * "软件一直开着"时成立，而离线最常见的场景恰恰是"回到家/上了飞机才打开"。
 *
 * 快照把 `projectDetail` 落到盘上，于是：
 *   · 断网启动 → 读盘 → `hasProjectData` 为真 → 直接进编辑器（配横幅）
 *   · 素材在 6.1~6.4 已经缓存到本机 → **离线导出真的能跑通**
 *
 * ## 快照是缓存，不是真源
 *
 * 只在**成功从服务端拿到详情**之后写；**永远不往服务端写回**。
 * 用户离线期间的编辑，其去向是 `lib/outbox.ts` 的队列，不是这里。
 * 两者刻意分开：快照答"上次看到的世界长什么样"，队列答"我改了什么还没送出去"。
 * 混成一个"本地真源"就等于要在客户端做三方合并，那是另一个数量级的工程。
 *
 * ## 为什么带版本号
 *
 * `ProjectDetail` 的形状随后端演进。旧结构的快照喂给新代码，症状是
 * 编辑器里零星字段是 undefined —— 比打不开更难查。版本对不上就**当没有快照**，
 * 老老实实走联网加载。
 */

/** 快照结构版本。`ProjectDetail` 的形状变了就 +1，旧快照随即作废。 */
export const SNAPSHOT_VERSION = 1;

export interface ProjectSnapshot<T = unknown> {
  version: number;
  projectId: string;
  /** 写入时刻（Date.now()），用来告诉用户"这是什么时候的样子" */
  savedAt: number;
  detail: T;
}

export interface SnapshotIO {
  read(projectId: string): Promise<ProjectSnapshot | null>;
  write(snap: ProjectSnapshot): Promise<void>;
  remove(projectId: string): Promise<void>;
}

/** 快照文件名（放在该项目自己的缓存目录下，跟着素材一起被清理）。 */
export const SNAPSHOT_NAME = "detail.json";

export function makeSnapshot<T>(
  projectId: string, detail: T, now: number,
): ProjectSnapshot<T> {
  return { version: SNAPSHOT_VERSION, projectId, savedAt: now, detail };
}

/**
 * 这份快照能不能用。
 *
 * 三项都必须查：
 *   · 版本 —— 见文件头；
 *   · **项目 id 相符** —— 读错目录会把别的项目的镜头摆进当前项目，
 *     那比空编辑器坏得多，而且用户不一定看得出来；
 *   · `detail` 非空对象 —— 写了一半的文件（断电/磁盘满）解析出来可能是 null。
 */
export function isUsableSnapshot(
  snap: unknown, projectId: string,
): snap is ProjectSnapshot {
  if (snap === null || typeof snap !== "object") return false;
  const s = snap as Partial<ProjectSnapshot>;
  if (s.version !== SNAPSHOT_VERSION) return false;
  if (s.projectId !== projectId) return false;
  if (typeof s.savedAt !== "number" || !Number.isFinite(s.savedAt)) return false;
  return s.detail !== null && typeof s.detail === "object";
}

/**
 * 「这份快照有多旧」的人话。
 *
 * 断线横幅上必须显示它：用户看到的是一个**看起来完全正常**的编辑器，
 * 唯一能提醒他"这不是最新的"的，就是这一句。不显示的话，多人协作时
 * 他会以为自己看到的是别人刚改完的版本。
 */
export function describeSnapshotAge(savedAt: number, now: number): string {
  // ⚠️ `Math.max(0, …)` 今天是**冗余**的（变异测试实测逃逸）：任何负数都 < 60，
  // 本来就会落进下面那句"刚刚"。留着是因为下面的分档随时可能加一档更细的
  // （比如"N 秒前"），那一刻负数就会印成「-5 秒前」——时钟回拨在跨时区/校时的
  // 机器上并不罕见。删它省不了什么，留它挡住的是改下一行时的连带回归。
  const sec = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}
