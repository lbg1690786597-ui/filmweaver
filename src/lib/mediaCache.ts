/**
 * lib/mediaCache.ts — 本机素材缓存：**唯一**的一套命名与落地规则（批次 4 / 4.5）
 *
 * ## 修的是「两套命名」，以及其中一套里的一个正确性 bug
 *
 * 4.5 之前，同一个 AppData 目录（`cache/<projectId>/`）被两条导出链路按
 * **两套互不相同的规则**写入：
 *
 *   · `render/renderer.ts` 的 `cacheMedia` → `<8位哈希>_<basename>`
 *   · `lib/localRender.ts` 的 `cacheClip` → **裸 basename**
 *
 * 后果有两个，第二个是真 bug：
 *
 * 1. **同一个素材在盘上有两份。** 用过「经典导出」(FineCut) 的素材各存一遍，
 *    而这个目录**从来没有淘汰机制**，只增不减。
 * 2. **裸 basename 会静默取到错的素材。** `cacheClip` 的复用判据是
 *    「同名文件已存在就直接返回」，而 `output.mp4` / `final.mp4` 这类 basename
 *    在本项目里极其常见（后端按镜头目录组织，文件名重名是常态）。
 *    两个不同 URL 只要 basename 相同，第二个就会拿到第一个的画面——
 *    **不报错、不下载、直接把别的镜头剪进成片**。
 *
 * 所以这里不是「顺手统一一下命名」，而是把命名收成**一份可断言的纯函数**，
 * 两条链路都必须经过它。
 *
 * ## 顺带修掉三件同源的事
 *
 * · **`.part` 残留从来没被清理过。** `renderer.ts` 里有一段注释说要清，
 *   底下却一行代码都没有（4.5 之前实测）。断电/杀进程留下的半截文件会永久
 *   留在用户盘上：复用只认 `dest`，没有任何一处会再碰 `.part`。
 * · **`cacheClip` 的写入不是原子的**（直接 `writeFile(dest)`）：写到一半被杀，
 *   下次 `exists(dest)` 为真、`cacheClip` 直接返回，**半截文件被当成完整素材**
 *   喂给 ffmpeg。改走与 `cacheMedia` 同一套 `.part` → `rename`。
 * · **设置页「本机缓存」那一组只有一句说明，没有任何数字、也没有清理入口。**
 *   一个只增不减的目录 + 没有入口 = AppData 无限增长。
 *
 * ## ⚠️ 换命名会让老缓存整体失效一次
 *
 * 新旧哈希算法与取材范围都不同（见 `cacheFileName`），所以升级后**第一次导出
 * 会重新下载一遍素材**，而盘上的旧文件成为孤儿。这正是本条同时补上
 * 「清理入口」的原因——不给入口就等于让用户自己去 AppData 里翻。
 * 这个代价是一次性的、且换来的是 bug 2 的根除，值得。
 *
 * ## ⚠️ 6.1 起本文件只剩「接线」
 *
 * 命名规则在 `cacheName.ts`，**落地规则**（复用判据 / 原子落地 / `.part` 清理 /
 * 单飞 / 引用计数取消）在 `cacheFetch.ts`，**预取调度**在 `prefetch.ts` —— 都不 import `api`，
 * 所以验证脚本能 import 到产品里真正在跑的那一份，并**真跑**它。
 * 留在本文件里的只有 Tauri plugin-fs / `fetch` / `IS_TAURI` 的接线、
 * 以及三个纯 I/O 的统计/清理函数。
 * 往这里加规则之前先问一句：它能被断言吗？不能就该搬去隔壁。
 */

import { appDataDir, join } from "@tauri-apps/api/path";
import {
  exists, mkdir, readDir, readFile, readTextFile, remove, rename, stat, writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { api } from "../api";
// 命名规则住在隔壁的纯函数模块里，理由见 `cacheName.ts` 的文件头
// （一句话：本文件 import 了 api，node 下加载不了，命名就没法被真正断言）。
import {
  CACHE_ROOT, CAPS_CACHE_NAME, AUDIO_PROBE_CACHE_NAME, cacheFileName,
} from "./cacheName";
// 6.1：**落地规则**也搬去了纯逻辑模块（`cacheFetch.ts`），同一个理由。
// 本文件从此只负责「把 Tauri 的 I/O 接上去」，不再自己写复用判据 / 原子落地 / 取消语义。
import { makeEnsureCached, type CacheIO } from "./cacheFetch";
// 6.2：后台预取泳道，同理住在纯逻辑模块里；本文件只提供 `IS_TAURI` 这一条接线。
import { makePrefetcher, type Prefetcher } from "./prefetch";
// 6.3：预览「本地优先、云端兜底」的规则同样住在纯模块里。
import { makeLocalSources, type LocalSourceIO, type LocalSources } from "./localSource";
import { IS_TAURI } from "./isTauri";

export { CACHE_ROOT, CAPS_CACHE_NAME, AUDIO_PROBE_CACHE_NAME, cacheFileName };
export type { CacheIO, Prefetcher, LocalSources };

/** `appDataDir()/cache/<projectId>/`，不存在则建。 */
export async function cacheDirFor(projectId: string): Promise<string> {
  const dir = await join(await appDataDir(), CACHE_ROOT, projectId);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 生产侧的 I/O 接线：Tauri plugin-fs + 浏览器 `fetch`。
 *
 * 这里**只有接线，没有规则** —— 复用判据、原子落地、`.part` 清理、单飞、
 * 引用计数取消全部在 `cacheFetch.ts` 里，那份能在 node 下真跑。
 * 规则一旦在这里再写一遍，验证脚本证明的就又是「我抄得对」而不是「产品跑的是什么」。
 */
const tauriIO: CacheIO = {
  dirFor: cacheDirFor,
  join: (dir, name) => join(dir, name),
  exists: (p) => exists(p),
  // stat 失败一律当 0 字节 → 触发重下。判不出来就重下，是这条路上唯一安全的猜法。
  size: async (p) => (await stat(p).catch(() => null))?.size ?? 0,
  remove: (p) => remove(p),
  write: (p, data) => writeFile(p, data),
  rename: (from, to) => rename(from, to),
  fetch: async (url, signal) => {
    const resp = await fetch(api.mediaUrl(url), { signal });
    if (!resp.ok) throw new Error(`素材下载失败 ${resp.status}: ${cacheFileName(url)}`);
    return new Uint8Array(await resp.arrayBuffer());
  },
};

/**
 * 确保素材已在本地，返回绝对路径。**幂等**：已缓存则不发任何请求；
 * 同一素材并发调用只下载一次（单飞），取消按「还有没有人在等」算。
 *
 * 规则与全部注释在 `cacheFetch.ts`。
 *
 * @param signal 传了就一路带到 `fetch`：不带的话点了取消要等当前这批素材
 *               全部下完才停，慢网下一个大素材就是几十秒的"点了没反应"。
 */
export const ensureCached = makeEnsureCached(tauriIO);

/**
 * 6.2 的后台预取泳道：**AI 产物一出现在 detail 里就落盘**，而不是等到导出。
 *
 * 接线只有两点，规则全在 `prefetch.ts`：
 *
 * · 注入的是上面那个真的 `ensureCached` —— 于是预取与导出天然共用 6.1 的单飞：
 *   两边同时要一个 URL 只会下一次，谁先到谁发起。
 * · `enabled` 是 `IS_TAURI`：纯浏览器（`/fw/app/`，用来验证部署的那条路）里
 *   `appDataDir()` 调了必抛，落盘整条路不存在，所以那里一件都不排。
 *
 * 单例是刻意的：基线（"这个项目的哪些 URL 我已经见过"）必须跨 hook、跨组件重挂载
 * 存活，否则每次 `useProject` 重挂都会重建基线，第一次刷新又变回"只记账不下载"，
 * 预取就永远不会发生。
 */
export const prefetcher: Prefetcher = makePrefetcher(ensureCached, {
  enabled: () => IS_TAURI,
});

/**
 * 6.3 的 I/O 接线：只读那一半。
 *
 * ⚠️ 这里刻意**不用** `cacheDirFor` —— 它会 `mkdir`。探测是「这个素材在不在盘上」，
 * 一次预览就为没缓存过的项目建一个空目录，属于读操作留下写痕迹；
 * 而 `localCacheStats` 数的是「有缓存的项目数」，空目录会让那个数字虚高。
 */
const localSourceIO: LocalSourceIO = {
  enabled: () => IS_TAURI,
  probe: async (projectId, url) => {
    const dir = await join(await appDataDir(), CACHE_ROOT, projectId);
    const path = await join(dir, cacheFileName(url));
    if (!(await exists(path))) return null;
    // 与 `cacheFetch.ts` 的复用判据同口径：存在**且** size > 0。
    // 空文件（上次磁盘满写出来的）当作没有，让它照旧走云端。
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    return size > 0 ? { path, size } : null;
  },
  read: (path) => readFile(path),
  objectUrl: (bytes, mime) =>
    // `bytes.slice()` 造一份独立的 ArrayBuffer：plugin-fs 返回的可能是
    // 某个更大缓冲区上的视图，直接塞进 Blob 会把整块内存钉住。
    URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime })),
  revoke: (u) => URL.revokeObjectURL(u),
  remote: (u) => api.mediaUrl(u),
};

/**
 * 6.3：预览的素材地址解析器。**本地有就用本地，没有就照旧走云端，绝不为预览去下载。**
 *
 * 单例是刻意的：blob 的生命周期（钉住当前播放源、LRU 回收）必须跨组件重挂载存活，
 * 否则每次 `usePlayer` 重挂都会漏掉一批没 revoke 的 blob —— 那是纯粹的内存泄漏，
 * 而且泄漏的单位是「一整个视频文件」。
 */
export const localSources: LocalSources = makeLocalSources(localSourceIO);

/**
 * 6.4：素材**在不在盘上**（只 stat，不下载、不建目录）。在则返回路径与字节数。
 *
 * 直接复用 6.3 那份 `localSourceIO.probe`，而不是在这里再写一遍 stat + size>0：
 * 「存在且非空才算数」这条判据在 `cacheFetch` / `localSource` 里已经各自承重，
 * 再抄第三份的下场是三处慢慢漂移，而漂移的表现是"预览说有、导出说没有"。
 *
 * 字节数是承重的：导出准备阶段拿它当音轨探测表的键的一半（内容寻址），
 * 素材换了内容字节数就变，旧结论自动失效。
 */
export function peekCached(
  projectId: string, url: string,
): Promise<{ path: string; size: number } | null> {
  return localSourceIO.probe(projectId, url);
}

/**
 * 清掉一个项目缓存目录里的 `.part` 残留，返回删除个数。
 *
 * 这些是断电 / 任务管理器杀进程留下的：正常失败路径已经在 `ensureCached` 的
 * catch 里删过了，能活到这里的都是**没走到 catch** 的那种死法。
 * 复用逻辑只认 `dest`，所以它们永远不会被读到，也永远不会被覆盖——
 * 不主动扫一遍就是纯粹的盘空间泄漏。
 *
 * 失败一律吞掉：清残留只是卫生，不该让一次导出因此失败。
 */
export async function sweepParts(projectId: string): Promise<number> {
  try {
    const dir = await cacheDirFor(projectId);
    let n = 0;
    for (const e of await readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".part")) continue;
      if (await remove(await join(dir, e.name)).then(() => true, () => false)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 6.4：音轨探测结果表的读写。**只是接线**，键的规则与容量策略在 `exportPrep.ts`。
 *
 * 放在 `cache/` 根下（与 `capabilities.json` 并列）而不是项目子目录里，有两个理由：
 * · 键是内容寻址的，跨项目天然可复用——同一个素材被复制进另一个项目不必重探；
 * · `localCacheStats` / `clearLocalCache` 都只遍历根下的**目录**，所以它自动
 *   被统计和清理绕开。这是刻意的：用户点"清理缓存"是为了腾盘，而这张表
 *   只有几十 KB，删掉却要付下次导出 N×30ms 的重探。
 *
 * 读写失败一律吞掉：这张表纯属加速，读不到就重探一遍，写不进就下次再说，
 * **绝不能让一次导出因为存不下缓存而失败**。
 */
async function probeTablePath(): Promise<string> {
  const root = await join(await appDataDir(), CACHE_ROOT);
  if (!(await exists(root))) await mkdir(root, { recursive: true });
  return join(root, AUDIO_PROBE_CACHE_NAME);
}

export async function loadAudioProbes(): Promise<Record<string, boolean>> {
  try {
    const p = await probeTablePath();
    if (!(await exists(p))) return {};
    const raw = JSON.parse(await readTextFile(p)) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // 逐项校验类型：这个文件在用户盘上，可能被手改坏、也可能是旧版本写的。
    // 混进一个非布尔值会一路流到 `hasAudio`，而那里的错误取值代价是整段导出失败。
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveAudioProbes(table: Record<string, boolean>): Promise<void> {
  try {
    await writeTextFile(await probeTablePath(), JSON.stringify(table));
  } catch {
    /* 存不下只是下次慢一点，不该影响导出 */
  }
}

export interface LocalCacheStats {
  /** 有缓存的项目数 */
  projects: number;
  files: number;
  bytes: number;
  /** `.part` 残留个数（单列出来：它是"本不该存在"的那部分） */
  parts: number;
}

/** 统计 `cache/` 下的素材缓存。**不含**能力探测缓存（见 CAPS_CACHE_NAME）。 */
export async function localCacheStats(): Promise<LocalCacheStats> {
  const out: LocalCacheStats = { projects: 0, files: 0, bytes: 0, parts: 0 };
  const root = await join(await appDataDir(), CACHE_ROOT);
  if (!(await exists(root))) return out;

  for (const proj of await readDir(root)) {
    if (!proj.isDirectory) continue;
    const dir = await join(root, proj.name);
    let seen = false;
    for (const f of await readDir(dir).catch(() => [])) {
      if (!f.isFile) continue;
      seen = true;
      if (f.name.endsWith(".part")) out.parts++;
      else out.files++;
      const st = await stat(await join(dir, f.name)).catch(() => null);
      out.bytes += st?.size ?? 0;
    }
    if (seen) out.projects++;
  }
  return out;
}

/**
 * 清空素材缓存，返回删除个数与释放字节数。
 *
 * **只删项目子目录**，`capabilities.json` 保留：用户点这个按钮是为了腾盘，
 * 而那个文件 ~1 KB、删掉却要付下次冷启动重探硬件编码器的 1.2~4s。
 *
 * 素材本身**全部可以重新下载**（缓存的定义），所以这里不需要二次确认之外的
 * 任何保护；真正不可再生的东西（上传素材、AI 生成结果）在服务端，
 * 那边本来就不提供清理入口。
 */
export async function clearLocalCache(): Promise<{ removed: number; freed: number }> {
  const before = await localCacheStats();
  const root = await join(await appDataDir(), CACHE_ROOT);
  if (!(await exists(root))) return { removed: 0, freed: 0 };

  for (const proj of await readDir(root)) {
    if (!proj.isDirectory) continue;
    await remove(await join(root, proj.name), { recursive: true }).catch(() => {});
  }
  const after = await localCacheStats();
  return {
    removed: before.files + before.parts - after.files - after.parts,
    freed: Math.max(0, before.bytes - after.bytes),
  };
}
