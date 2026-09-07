/**
 * render/exportPrep.ts — 导出前的「素材准备」阶段（纯逻辑，I/O 全靠注入）
 *
 * 这一步做三件事，从 `renderer.ts` 里抽出来：
 *   ① 把 `plan.media` 弄到本地（已在本地的**一个字节都不动**）
 *   ② 探测哪些素材含音轨（决定 passthrough 用素材原声还是补静音）
 *   ③ 沿途产出**诚实的**进度与降级提示
 *
 * ## 为什么值得单独一个文件
 *
 * 因为 6.4 的三个真问题全都是**规则**问题，而规则只有能被断言才算数：
 *
 * 1. **进度条在说谎。** 抽出来之前，这一步无条件报 `下载素材 d/t` 并吃掉进度条
 *    0→15%，哪怕 170 个素材全都命中缓存、一个请求都没发。6.2 把 AI 产物一出现
 *    就落盘之后，「全命中」才是常态 —— 于是用户每次导出都要看着进度条为**零工作量**
 *    爬 15%，还被告知在"下载"。措辞与配额必须由工作量算出来，而不是写死。
 * 2. **音轨探测每次导出都从头来。** 每个素材拉起一个 `ffmpeg -i`（本机实测均
 *    **29.5 ms**），170 个素材 ≈ 5 秒纯等待。素材是内容寻址的（同一份字节永远
 *    同一个缓存文件名），结论完全可以存下来。
 * 3. **LUT 从来没被下载过。** `lut3d=file=` 拿到的是 `/fw/media/...` 服务器地址，
 *    实测**整段导出失败**（退出码 1）。6.4 起 LUT 也是一条 `plan.media`，
 *    走同一条通路 —— 但它是**装饰性**的，下载失败该降级而不是让导出崩掉。
 *
 * ## 注入 I/O 的理由（与 `cacheFetch.ts` / `localSource.ts` 同一个理由）
 *
 * 生产侧的 `mediaCache.ts` 必须 `import { api }`，而 `api.ts` 顶层就读
 * `import.meta.env` —— **node 下 import 它当场抛**，验证脚本连模块都加载不了。
 * 所以规则住在这里、I/O 由调用方接：`verify-exportprep.ts` 注入内存假件，
 * 断言的是**产品真正在跑的那个函数**，而不是照着源码再实现一遍。
 */

import type { RenderPlan, RenderMedia } from "./model";
import { Aborted } from "../lib/aborted";
import { cacheFileName } from "../lib/cacheName";
import { explainUnreachable, type LocalRoot } from "../lib/localRoot";

/** 准备阶段需要的全部外部能力。生产接 Tauri，验证接内存假件。 */
export interface PrepIO {
  /** 素材是否已在本地；在则返回绝对路径与字节数。**不下载、不建目录。** */
  peek(url: string): Promise<{ path: string; size: number } | null>;
  /** 确保素材在本地并返回绝对路径。幂等、单飞（`ensureCached`）。 */
  fetch(url: string, signal?: AbortSignal): Promise<string>;
  /**
   * 探测本地文件是否含音轨。
   *
   * ⚠️ 返回 `null` 表示**探测本身失败**（进程拉不起来 / 超时），而不是"没有音轨"。
   * 这个第三态是承重的：失败时上层会按「有音轨」继续跑（猜错代价不对称），
   * 但那是个**猜**，绝不能写进持久表 —— 一次偶发的进程启动失败会因此变成
   * 这个素材永久的错误结论，而错误结论在 composite 分支的后果是整段导出失败。
   */
  probeAudio(path: string): Promise<boolean | null>;
  /** 读音轨探测表；读不到/坏了返回空表。 */
  loadProbes(): Promise<Record<string, boolean>>;
  /** 写回音轨探测表。失败必须自行吞掉——存不下只是慢一点，不该让导出失败。 */
  saveProbes(table: Record<string, boolean>): Promise<void>;
  /** 清掉上一轮留下的 `.part` 残留，返回删除个数。 */
  sweep(): Promise<number>;
  /**
   * 6.6：stat 一个**用户素材根里的**绝对路径。读不到（不在 scope / 文件没了）
   * 返回 `null`，不抛。
   *
   * 刻意做成**可选**：`verify-compiler.ts` 等 4 个脚本自建 `PrepIO`，
   * 不加这个字段它们一行都不用改（与 6.3 给 `CompileCtx` 加 `maskPath` 同款处理）。
   * 未提供时，带 `localPath` 的素材一律按"读不到"处理并给提示 ——
   * **不会**悄悄回退去下 `url`，那是 `localPath` 明令禁止的（见 `model.ts`）。
   */
  statLocal?(path: string): Promise<{ size: number } | null>;
}

/** 语义化进度。**不含百分比** —— 百分比是 `renderer` 分配的配额，不是本模块的事。 */
export interface PrepProgress {
  /** 0..1，本阶段完成比例 */
  frac: number;
  /** 面向用户的一句话 */
  stage: string;
}

export interface PrepResult {
  /** mediaId → 本地绝对路径。下载失败的**装饰性**素材不在其中。 */
  paths: Map<string, string>;
  /** mediaId → 是否含音轨。只包含真正需要判定的那些（见 `probeTargets`）。 */
  audio: Map<string, boolean>;
  /** 面向用户的降级提示，并进 `RenderResult.notices`。 */
  notices: string[];
  /** 可观测的账本，给验证脚本和日志用；不影响渲染。 */
  stats: {
    total: number;
    /** 已在本地、一个请求都没发的 */
    hits: number;
    /** 真的下载了的 */
    downloaded: number;
    /** 真的拉起了 ffmpeg 探测的 */
    probed: number;
    /** 命中探测表、省掉的那些 ffmpeg */
    probeHits: number;
  };
}

/**
 * 下载相对于探测的**工作量权重**。
 *
 * 存在的理由是进度条要匀速：一次探测本机实测 29.5 ms，而一次下载（几 MB 的
 * mp4，还要过网络）少说也是它的几十倍。权重取 10 是**保守**的下界 ——
 * 宁可让下载阶段走得比真实略快、探测阶段略慢，也不要出现"进度条冲到 90% 再卡住"。
 *
 * 这不是并发数，改它只影响进度条的匀速程度，不影响任何吞吐。
 */
export const DOWNLOAD_WEIGHT = 10;

/**
 * 音轨探测表的容量上限，超出按**先进先出**丢弃。
 *
 * ⚠️ 这里刻意不做 LRU：命中时**不重写表**，所以一条老而热的记录也可能被挤掉。
 * 代价是下次导出为它多花一次 29.5 ms，而收益是命中路径上零写盘 ——
 * 一次导出命中 170 条就是 170 次无谓的 JSON 序列化 + 写文件。
 * 这个取舍是有意的，别"顺手优化"成 LRU。
 */
export const MAX_PROBE_ENTRIES = 4000;

/**
 * 音轨探测表的键：**内容寻址**。
 *
 * `cacheFileName(url)` 已经是「去 query 的完整 URL 的哈希 + 可读后缀」，再缀上
 * 字节数：素材被换成另一份内容（重新生成、重新上传）时字节数几乎必然不同，
 * 旧结论就自动失效，不可能拿旧结论套新文件。
 */
export function probeKey(url: string, size: number): string {
  return `${cacheFileName(url)}:${size}`;
}

/**
 * 素材的**身份串**：本地素材（6.6）用它自己的绝对路径，云端素材用 URL。
 *
 * 为什么不能一律用 `m.url`：本地项目里的素材可能压根没有云端地址（`url` 是空串），
 * 于是所有本地素材的 `probeKey` 会撞成同一个 `${cacheFileName("")}:${size}` ——
 * 只要字节数碰巧相同，一个**无声视频**就会拿到另一个素材"有音轨"的结论，
 * 后果是 composite 分支去映射一条不存在的 `[i:a]`，**整段导出失败**
 * （与 `probeTargets` 注释里说的是同一类事故）。
 *
 * `cacheFileName` 对绝对路径同样适用：它只是"去 query + 哈希全串 + 留可读尾巴"，
 * 不要求入参是 URL。本地素材从不下载，这个名字也就永远不会变成真实文件名。
 */
export function mediaKey(m: RenderMedia): string {
  return m.localPath ?? m.url;
}

/**
 * 哪些素材需要探音轨。
 *
 * 判据是「**被视频轨的 clip 引用**」，因为 `ctx.hasAudio` 只有两个消费点，
 * 都在编译 segment 时，而 segment 只由视频轨的 clip 构成
 * （`buildSegments`）。音频轨走的是 `compileAudioMix`，它拿的是
 * `{path,startSec,volume,muted}`，**一个字都不读 hasAudio**；LUT 更不用说。
 *
 * ⚠️ 这里刻意取**超集**：连 `hidden` 的视频轨也算。
 * `buildSegments` 会滤掉隐藏轨，所以照它的判据取交集本可以再省几次探测 ——
 * 但两处判据一旦漂移，漏探的那个素材在 renderer 里会落到
 * `audioMap.get(id) ?? true`，而 `true` 在 composite 分支意味着去映射
 * 一条不存在的 `[i:a]`，后果是**整段导出失败**（见 ffmpegCompiler 里那段注释）。
 * 用超集换掉这一整类风险，代价是几次 30 ms 的探测，非常划算。
 */
export function probeTargets(plan: RenderPlan): Set<string> {
  const out = new Set<string>();
  for (const t of plan.tracks) {
    if (t.kind !== "video") continue;
    for (const c of t.clips) out.add(c.mediaId);
  }
  // LUT 这种资源文件即便被误引用也不该探：拿 `ffmpeg -i` 去读 `.cube`
  // 只会白花 30 ms 再得到一个"没有音轨"。
  for (const m of plan.media) if (m.kind === "lut") out.delete(m.id);
  return out;
}

/** 装饰性素材：下载不到就少一层效果，不该让整个导出失败。 */
function isOptional(m: RenderMedia): boolean {
  return m.kind === "lut";
}

/** 按上限裁剪探测表，丢最早写入的（Record 的字符串键保持插入顺序）。 */
function capTable(table: Record<string, boolean>): Record<string, boolean> {
  const keys = Object.keys(table);
  if (keys.length <= MAX_PROBE_ENTRIES) return table;
  const keep = keys.slice(keys.length - MAX_PROBE_ENTRIES);
  const out: Record<string, boolean> = {};
  for (const k of keep) out[k] = table[k];
  return out;
}

/** 限并发跑一批任务。**上限由调用方给定，本模块不自作主张调它。** */
async function inBatches<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    if (signal?.aborted) throw new Aborted();
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

export interface PrepOptions {
  plan: RenderPlan;
  io: PrepIO;
  /** 下载并发上限（生产传 4）。 */
  downloadConcurrency: number;
  /** 音轨探测并发上限（生产传 4）。 */
  probeConcurrency: number;
  onProgress?: (p: PrepProgress) => void;
  signal?: AbortSignal;
  /**
   * 6.6：本次启动已授权的素材根。只用来**把话说清楚** —— 某个 `localPath`
   * 读不到时，是"重启后授权没了、重选一下就行"还是"文件真的不见了"，
   * 处置办法完全不同（见 `explainUnreachable`）。
   *
   * 缺省空数组：老调用方不传，得到的是"授权已释放，请重新选目录"那一句 ——
   * 对一个没有任何授权根的进程来说，这**恰好是实话**。
   */
  localRoots?: readonly LocalRoot[];
}

/**
 * 准备素材：本地化 + 音轨探测。抛 `Aborted` 表示用户取消。
 *
 * 命中率高时这个函数几乎瞬时返回，并且**只报一次**进度
 * （`素材已在本地 (N)`）—— 不再有"为零工作量爬 15%"那一段。
 */
export async function prepareMedia(opts: PrepOptions): Promise<PrepResult> {
  const { plan, io, signal } = opts;
  const report = (frac: number, stage: string) =>
    opts.onProgress?.({ frac: Math.min(1, Math.max(0, frac)), stage });

  await io.sweep();

  const paths = new Map<string, string>();
  const audio = new Map<string, boolean>();
  const notices: string[] = [];
  const targets = probeTargets(plan);

  // ---- 第 0 步：看看盘上已经有什么（只 stat，不下载、不建目录）----
  // 这一步存在的全部意义是**先把工作量算出来再报进度**：不知道要下几个、
  // 要探几个，就只能像 6.4 之前那样按"素材总数"报，那正是说谎的来源。
  const local = new Map<string, { path: string; size: number } | null>();
  await inBatches(plan.media, opts.downloadConcurrency, signal, async (m) => {
    // 6.6：本地素材走**另一条**探路 —— stat 用户盘上那个文件，而不是缓存目录。
    // 这里的 `?? null` 与下面的"不进 toDownload"合起来才是那条纪律的落点：
    // 读不到就是读不到，不许换成 `url` 那份。
    if (m.localPath !== undefined) {
      const st = await io.statLocal?.(m.localPath).catch(() => null) ?? null;
      local.set(m.id, st ? { path: m.localPath, size: st.size } : null);
      return;
    }
    local.set(m.id, await io.peek(m.url).catch(() => null));
  });

  const probeTable = await io.loadProbes().catch(() => ({} as Record<string, boolean>));
  let tableDirty = false;

  const toDownload = plan.media.filter((m) => m.localPath === undefined && !local.get(m.id));

  // ---- 6.6：本地素材读不到就在这里收场，**绝不混进 toDownload** ----
  // 混进去就等于「读不到你的文件，那我下云端那份给你」—— 用户在预览里看到的
  // 和导出的会是两个东西，且全程无提示。宁可导出失败，也不出一条错的片子。
  // 装饰性素材（LUT）例外：少一层调色，片子照出，与 6.4 的降级口径一致。
  {
    const roots = opts.localRoots ?? [];
    for (const m of plan.media) {
      if (m.localPath === undefined || local.get(m.id)) continue;
      const why = explainUnreachable(m.localPath, roots, roots.length > 0);
      if (isOptional(m)) {
        notices.push(`调色文件读不到，这次导出没有套用它 —— ${why.message}`);
        continue;
      }
      throw new Error(why.message);
    }
  }
  // 已在本地的素材里，哪些还需要真的拉 ffmpeg 探一次
  const toProbeNow: RenderMedia[] = [];
  let probeHits = 0;
  for (const m of plan.media) {
    if (!targets.has(m.id)) continue;
    const hit = local.get(m.id);
    if (!hit) continue;                       // 还没下载，下完再决定
    const known = probeTable[probeKey(mediaKey(m), hit.size)];
    if (known === undefined) toProbeNow.push(m);
    else { audio.set(m.id, known); probeHits++; }
  }
  for (const [id, hit] of local) if (hit) paths.set(id, hit.path);

  // 待下载的素材**下完还得探一次**，所以它在总工作量里占 权重 + 1。
  const downloadTargets = toDownload.filter((m) => targets.has(m.id)).length;
  const totalUnits =
    toDownload.length * DOWNLOAD_WEIGHT + toProbeNow.length + downloadTargets;
  let doneUnits = 0;

  if (totalUnits === 0) {
    // 全命中：**只报一次**，说的是实话。
    // 6.6 起「零工作量」不再等价于「全都在」：一个读不到的本地 LUT 既不用下载
    // 也不用探测，同样落进这里。所以数字取 stat 的实际命中数，措辞也照它来说，
    // 否则会出现「素材已在本地 (12)」下面挂着一条"少了一层调色"的提示。
    const hits = [...local.values()].filter(Boolean).length;
    report(1, `素材已在本地 (${hits})`);
    return {
      paths, audio, notices,
      stats: {
        total: plan.media.length, hits,
        downloaded: 0, probed: 0, probeHits,
      },
    };
  }

  // ---- 第 1 步：下载缺的那些 ----
  let downloaded = 0;
  if (toDownload.length) {
    report(0, `下载素材 0/${toDownload.length}`);
    await inBatches(toDownload, opts.downloadConcurrency, signal, async (m) => {
      try {
        paths.set(m.id, await io.fetch(m.url, signal));
      } catch (e) {
        if ((e as Error)?.name === "Aborted") throw e;
        if (!isOptional(m)) throw e;
        // 装饰性素材（LUT）：少一层调色，片子照出。
        notices.push(`调色文件下载失败，这次导出没有套用它（${cacheFileName(m.url)}）`);
      }
      doneUnits += DOWNLOAD_WEIGHT;
      downloaded++;
      report(doneUnits / totalUnits, `下载素材 ${downloaded}/${toDownload.length}`);
    });
    // 下完了才知道字节数，这时才能定探测键
    for (const m of toDownload) {
      if (!targets.has(m.id) || !paths.has(m.id)) continue;
      toProbeNow.push(m);
    }
  }

  // ---- 第 2 步：探音轨 ----
  let probed = 0;
  if (toProbeNow.length) {
    report(doneUnits / totalUnits, `检查素材声音 0/${toProbeNow.length}`);
    await inBatches(toProbeNow, opts.probeConcurrency, signal, async (m) => {
      const p = paths.get(m.id);
      // 拿不到路径不该发生（targets ⊆ 必需素材），但真发生时按"有音轨"处理，
      // 与 renderer 的缺省一致，绝不在这里悄悄写成 false。
      const res = p ? await io.probeAudio(p) : null;
      audio.set(m.id, res ?? true);
      // **只把成功的探测记下来**（`res === null` 是"探测失败"，不是结论）。
      // 把失败时的那个猜持久化，会让一次偶发的进程启动失败变成这个素材永久的
      // 错误结论；而错误的 `true` 在 composite 分支意味着去映射一条不存在的
      // `[i:a]`，后果是整段导出失败 —— 一次性的失败因此变成永久性的失败。
      if (res !== null && p) {
        // 本地素材（6.6）的字节数要 stat 用户那个文件，不能问缓存目录 ——
        // `io.peek(m.url)` 对它必然是 null，于是结论永远存不进表，
        // 每次导出都白探一遍（29.5 ms × N），且没有任何现象提示。
        const st = m.localPath !== undefined
          ? await io.statLocal?.(m.localPath).catch(() => null) ?? null
          : await io.peek(m.url).catch(() => null);
        if (st && st.size > 0) {
          probeTable[probeKey(mediaKey(m), st.size)] = res;
          tableDirty = true;
        }
      }
      doneUnits += 1;
      probed++;
      report(doneUnits / totalUnits, `检查素材声音 ${probed}/${toProbeNow.length}`);
    });
  }

  if (tableDirty) await io.saveProbes(capTable(probeTable)).catch(() => {});

  report(1, "素材就绪");
  return {
    paths, audio, notices,
    stats: {
      total: plan.media.length,
      // 「已在本地」= 第 0 步 stat 到了的那些。6.6 之前它恒等于
      // `总数 − 待下载数`，因为两者互补；现在多了第三种结局
      // （本地素材读不到、又是装饰性的，于是既没下载也不算命中），
      // 照旧式减法算会把它记成命中，导出报告里就会出现
      // 「素材已在本地 (N)」却少了一层调色 —— 直接按 stat 结果数更不容易漂。
      hits: [...local.values()].filter(Boolean).length,
      downloaded, probed, probeHits,
    },
  };
}
