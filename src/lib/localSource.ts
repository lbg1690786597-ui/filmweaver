/**
 * lib/localSource.ts — 预览「本地优先、云端兜底」（批次 6 / 6.3，可注入的纯逻辑）
 *
 * ## 要解决的是什么
 *
 * 6.1 把素材落到了盘上，6.2 让它在 AI 任务完成时就落好。但**编辑期从来不读它**：
 * 预览器的 `<video src>` 一直是 `api.mediaUrl()` 拼出来的远端地址
 * （`usePlayer.ts` 三处），波形解码是 `fetch(api.mediaUrl(url))`
 * （`Waveform.tsx`）。于是盘上那份文件只有导出时才被用到一次。
 *
 * 直接后果是 scrubbing 的手感：`<video>` 是 `key={previewUrl}` 挂的
 * （`Player.tsx`，`key` 必须保留，见 §0.5(g)），**换镜头 = 换元素 = 又一次网络请求**。
 * 3.4 已经为此做过两层规避（`preload="metadata"`、拖动中不换源），
 * 但那是在「每次都要走网」这个前提下的减害，不是解决。
 *
 * ## 规则：本地有就用本地，没有就照旧走云端 —— **不为了预览去下载**
 *
 * 最容易写错的是「没有就下一份」。那会让「随手点开素材库看一眼」「预览一次成片」
 * 变成静默的几百 MB 下载 —— 正是 6.2 的基线设计存在的理由。
 * 下载时机是 6.2 的事（AI 产物一出来就落盘），本模块**只读不写**：
 *
 * · 盘上有 → 读出来做 blob，`<video>` 走本地，零网络、seek 瞬时
 * · 盘上没有 → 原样返回 `api.mediaUrl(url)`，与 6.3 之前一字不差
 *
 * 所以最坏情况是「回到 6.3 之前」，永远不会更差。这条性质是本模块的底线，
 * `resolve` 因此**永不抛**：预览放不出来的原因不该是缓存层出了岔子。
 *
 * ## 为什么是 blob 而不是 `convertFileSrc`
 *
 * `convertFileSrc()` 能给出同步的 `asset://` 地址、支持 range 请求（不必整份进内存），
 * 单看播放它更好。但它要开 `app.security.assetProtocol`
 * （当前 `tauri.conf.json` 的 `security` 里只有 `csp: null`）——**那是扩权限**，
 * 而路线图给批次 6 划的线是「6.1~6.5 不改数据模型、不扩权限；6.6 起才涉及 fs scope
 * 扩大，属安全面变化，要单独评审」。blob 走的是 `fs:allow-app-read-recursive`
 * 对 `$APPDATA/**` **已经授予**的读权限，零配置改动。
 *
 * 代价是整份进内存，所以必须有两道闸（见 `LocalSourceOpts`）：
 * 单文件上限（一部 500 MB 的成片不该为了"预览一下"占住内存），
 * 以及活着的 blob 总量上限 + LRU 回收。
 *
 * ## ⚠️ 回收 blob 是这个设计唯一会伤到用户的地方
 *
 * `revokeObjectURL` 掉一个**正在播的** blob，画面当场变黑，而且没有任何报错。
 * 所以有一个**钉住位**：被 `pin(url)` 声明为「预览器此刻的 src」的那一个永不被回收。
 *
 * 钉子刻意**不由 `resolve` 顺手下**，而是由调用方显式调 `pin`——理由见 `pin` 的注释
 * （一句话：`resolve` 是异步的、用户会连点，最后返回的那个未必是屏幕上那个）。
 * 整个应用只有一个 `<video>`（`Player.tsx`；`previewMedia` / `previewShotVersion` /
 * `onSelectShot` 都往它身上换源），所以一个钉子够用；
 * 哪天出现第二个播放器，这里要改成集合，别指望 LRU 顺手保住它。
 *
 * ## projectId 只是目录分区，不是正确性的一部分
 *
 * 缓存文件名是 `cacheFileName(url)` —— **URL 的哈希**（见 `cacheName.ts`）。
 * 所以拿错 projectId 去查只会 miss（那个目录里没有这个哈希），
 * 不可能命中到「别的素材」。这正是 4.5 把裸 basename 换掉换来的性质。
 * `setProject` 那条便捷通路（给只有 url、没有 projectId 的调用方，如 `Waveform`）
 * 因此是安全的：最坏是查不到、退回走网。
 *
 * ## 为什么规则住在这个不 import 任何东西的文件里
 *
 * 与 `cacheName.ts` / `cacheFetch.ts` / `prefetch.ts` 同一个理由：
 * `mediaCache.ts` 必须 `import { api }`，而 `api.ts:9` 顶层读 `import.meta.env`，
 * **node 下 import 即抛**。规则写在那边就只能靠源码 grep 断言，
 * 而这里的每一条（本地优先 / 不为预览下载 / 单文件上限 / 总量 LRU / 钉住当前源 /
 * 认不出类型就不落 blob / 永不抛）都是**能被真跑出来**的行为。
 */

/** 落地所需的全部 I/O。生产实现在 `lib/mediaCache.ts`，验证脚本里是内存假货。 */
export interface LocalSourceIO {
  /** 现在能不能读本地。生产里是 `() => IS_TAURI` —— 纯浏览器里没有 plugin-fs。 */
  enabled(): boolean;
  /**
   * 这个素材**此刻**在不在盘上。在 → 绝对路径与字节数；不在 → `null`。
   *
   * ⚠️ **不允许下载**。下载时机是 6.2 的事，本模块只读不写（见文件头）。
   */
  probe(projectId: string, url: string): Promise<{ path: string; size: number } | null>;
  read(path: string): Promise<Uint8Array>;
  /** 生产里是 `URL.createObjectURL(new Blob([bytes], { type: mime }))` */
  objectUrl(bytes: Uint8Array, mime: string): string;
  revoke(objectUrl: string): void;
  /** 云端兜底地址。生产里是 `api.mediaUrl`。 */
  remote(url: string): string;
}

export interface LocalSourceOpts {
  /**
   * 单个文件落 blob 的上限，缺省 96 MB。超过就走云端。
   *
   * 这不是抠内存：一部整集成片可以是几百 MB，而"预览一下成片"是随手动作。
   * 走云端反而更好——`<video>` 会按需 range 取，用户拖到哪取到哪。
   */
  maxFileBytes?: number;
  /**
   * 同时活着的 blob 总字节上限，缺省 320 MB。超了按 LRU 回收，
   * **钉住的那一个除外**（见文件头：回收正在播的 blob = 画面变黑且无报错）。
   */
  maxLiveBytes?: number;
  /** 读盘失败时的回调。缺省 `console.warn`。**不允许抛**。 */
  onError?: (url: string, e: unknown) => void;
}

export interface LocalSourceStats {
  /** 活着的 blob 个数 */
  live: number;
  /** 活着的 blob 总字节 */
  bytes: number;
  /** 同步/异步命中已材料化的 blob 的次数 */
  hits: number;
  /** 走了云端兜底的次数（不在盘上 / 太大 / 认不出类型 / 出错 / 浏览器里） */
  remote: number;
  /** 真的读盘并造出 blob 的次数 */
  materialized: number;
  /** 被 LRU 回收掉的个数 */
  evicted: number;
  /** 当前钉住的那一个（= 预览器此刻的 src），没有则 null */
  pinned: string | null;
}

export interface LocalSources {
  /** 同步问一句「已经材料化了吗」。命中返回 blob 地址，否则 null。**不读盘**。 */
  peek(url: string): string | null;
  /**
   * 拿一个能直接喂给 `<video src>` 的地址。**永不抛**：
   * 拿不到本地就返回 `io.remote(url)`，与 6.3 之前一字不差。
   *
   * ⚠️ **它不钉住任何东西**，钉子要调用方自己按 `pin` 来下。理由见 `pin`。
   */
  resolve(projectId: string, url: string): Promise<string>;
  /**
   * 「**本地有没有**」的直问直答：有就给 blob 地址，没有就 `null` ——
   * 不做云端兜底（6.5 跟踪用）。
   *
   * 跟踪与预览的需求在这里是反的：预览拿不到本地也要**照样能播**，所以
   * `resolve` 兜底到云端；而跟踪拿远端地址是**跑不通的**（跨源 canvas 的
   * `getImageData` 直接抛，且每次 seek 都是一轮 range 请求）。
   * 让跟踪去 `resolve` 再靠 `startsWith("blob:")` 猜自己拿到了什么，
   * 等于把一个本模块才知道的事实变成调用方的字符串嗅探。
   *
   * 命中与不命中都**不动钉子**：钉子是预览器的（见 `pin`），跟踪不许抢。
   * 跟踪期间这个 blob 有被 LRU 回收的可能，但 `<video>` 在 `src` 生效后
   * 已经把整份取走，revoke 不影响已开始的加载；真被影响到也只是抽帧返回 null，
   * `runTrack` 会如实报「读不到画面，已保留前段结果」，不会写坏数据。
   */
  localBlob(projectId: string, url: string): Promise<string | null>;
  /**
   * 声明「预览器此刻播的就是它」——**传的是你交给 `<video src>` 的那个字符串**，
   * 也就是 `resolve` 的返回值（blob 地址或云端地址），不是原始素材 url。
   *
   * 之所以按返回值而不是按素材 url 认：调用方手里真正确定的就是"我把哪个字符串
   * 塞进了元素"。要求它反查素材 url 等于把一次映射的责任推给每个调用点，
   * 而拿错了的表现是**钉子悄悄落空**（见下文），没有任何报错。
   *
   * 被钉住的那一个不会被 LRU 回收，直到钉子挪走。
   *
   * **为什么不由 `resolve` 顺手钉**：`resolve` 是异步的，而用户会连点。
   * 连点两个镜头、先发的后回时，最后一次 `resolve` 返回的**不是**屏幕上那一个；
   * 谁在播只有调用方知道（它有代次号，会丢弃过期结果）。
   * 让 `resolve` 自作主张地钉，等于让一个已被丢弃的结果把钉子从正在播的那一个身上
   * 抢走 —— 于是它可能被 LRU 回收，**画面当场变黑且无任何报错**（见文件头）。
   * 所以规则是：**谁把地址交给了 `<video>`，谁来钉。**
   *
   * 传云端地址（本地没命中时的兜底）是**空操作**：那种情况下没有 blob 要保护。
   * 传一个已被回收的 blob 地址同样是空操作 —— 钉一个不在表里的东西会让 evict
   * 找不到匹配项，等于没有钉子，真正在播的那一个反而失去保护；
   * 钉不上就保持原样，比盲目赋值安全。
   */
  pin(objectUrl: string): void;
  /**
   * 拿本地字节（给波形解码、静音探测这类只要字节、不要 URL 的调用方）。
   * 盘上没有 → `null`，调用方自己走网。**不造 blob，因此没有回收问题**。
   */
  bytes(projectId: string, url: string): Promise<Uint8Array | null>;
  /**
   * 记下当前打开的项目，供只有 url、拿不到 projectId 的调用方使用
   * （`Waveform` 挂在 `ClipView` 上，那条链上没有项目 id）。
   * 切/关项目时由 `App` 调用；传 null 表示没有项目。
   */
  setProject(projectId: string | null): void;
  /**
   * `setProject` 记下的那个项目 id，没有则 null。
   *
   * 给的是**别的模块**要用的：跟踪拿不到本地副本时要调 `ensureCached` 下一份，
   * 而那是**写**操作 —— 本模块只读不写（见文件头），所以下载这一步留在调用方，
   * 这里只把它已经知道的 projectId 说出来。
   */
  currentProject(): string | null;
  /** 同 `bytes`，用 `setProject` 记下的项目。没有项目 → `null`。 */
  bytesForCurrent(url: string): Promise<Uint8Array | null>;
  /**
   * 同 `localBlob`，用 `setProject` 记下的项目。没有项目 → `null`。
   *
   * 跟踪走这条：面板挂在 `Inspector` 上，那条链上没有 projectId
   * （与 `Waveform` 同样的处境）。拿错项目只会 miss —— 缓存文件名是 URL 的哈希，
   * 不可能命中到别的素材（见文件头「projectId 只是目录分区」）。
   */
  localBlobForCurrent(url: string): Promise<string | null>;
  /** 全部回收（切/关项目）。钉子一并松开。 */
  release(): void;
  stats(): LocalSourceStats;
}

/** 已知扩展名 → MIME。认不出的一律不落 blob（见 `mimeForUrl`）。 */
const MIME: Readonly<Record<string, string>> = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/mp4", wav: "audio/wav",
  ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif",
};

/**
 * URL → MIME；**认不出返回空串**。
 *
 * 为什么认不出就不落 blob：`<video>`/`<audio>` 认的是 **Blob 自己的 `type`**，
 * 不会去嗅探内容。给一个空类型或 `application/octet-stream` 的 blob，
 * 表现是「不报错、就是不播」—— 那比走云端糟得多。后端产出的扩展名就那么几种，
 * 表里全都有；真冒出新的，走云端照旧能播，然后往表里加一行即可。
 */
export function mimeForUrl(url: string): string {
  // 先剥查询串与锚点：`…/a.mp4?token=x` 的扩展名是 mp4，不是 `mp4?token=x`
  const clean = url.split(/[?#]/)[0];
  const slash = clean.lastIndexOf("/");
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";          // `dot === 0` 是 `.gitignore` 这种，不是扩展名
  return MIME[base.slice(dot + 1).toLowerCase()] ?? "";
}

interface Entry { url: string; blobUrl: string; bytes: number }

/**
 * 造一套本地源解析器。
 *
 * 状态挂在闭包里而不是模块级 —— 与 `makeEnsureCached` / `makePrefetcher` 同理：
 * 模块级全局会让验证脚本的用例之间串味。
 */
export function makeLocalSources(io: LocalSourceIO, opts: LocalSourceOpts = {}): LocalSources {
  const maxFileBytes = opts.maxFileBytes ?? 96 * 1024 * 1024;
  const maxLiveBytes = opts.maxLiveBytes ?? 320 * 1024 * 1024;
  const onError = opts.onError
    ?? ((url: string, e: unknown) => console.warn("[localSource] 读本地失败（已走云端）:", url, e));

  /** LRU：`Map` 的插入序就是使用序，命中时 delete + set 挪到队尾。 */
  const lru = new Map<string, Entry>();
  /**
   * blob 地址 → 素材 url 的反查表，只为 `pin` 而存在。
   *
   * 调用方手里只有"我塞进 `<video>` 的那个字符串"，而 LRU 是按素材 url 建的。
   * 不留这张表，`pin` 就只能要求调用方自己反查 —— 那是一次每个调用点都要做对、
   * 做错了却毫无提示（钉子静默落空 → 正在播的被回收 → 黑屏）的映射。
   */
  const byBlob = new Map<string, string>();
  /** 正在读盘的 url → promise，避免同一素材被读两遍。 */
  const reading = new Map<string, Promise<Uint8Array | null>>();
  let liveBytes = 0;
  let pinned: string | null = null;
  let project: string | null = null;
  let hits = 0, remote = 0, materialized = 0, evicted = 0;

  const touch = (url: string): Entry | undefined => {
    const e = lru.get(url);
    if (!e) return undefined;
    lru.delete(url);
    lru.set(url, e);
    return e;
  };

  const drop = (e: Entry) => {
    lru.delete(e.url);
    byBlob.delete(e.blobUrl);
    // ⚠️ 这一句**不承重**，是一句防御：`drop` 的两个调用方都已经保证钉子不会
    // 变成悬空指针 —— `evict` 明确跳过钉住的那一个，`release` 自己会把钉子清零。
    // 已用变异测试实测：改成 `if (false)` 断言全绿。
    // 留着是为了「再加一个 drop 的调用方」那一天：忘了清钉子的后果是
    // 钉子指向一个已回收的条目，之后 evict 拿它跟谁比都不相等 = 悄悄失去保护。
    // 把这句话写在这里，是为了下一个人别把它当成"正在起作用的机制"去依赖。
    if (pinned === e.url) pinned = null;
    liveBytes -= e.bytes;
    try { io.revoke(e.blobUrl); } catch { /* revoke 失败也不能带走调用方 */ }
  };

  /**
   * 回收到总量以下。
   *
   * `keep` 是「这一次刚造出来、马上要 return 给调用方的那一个」：它还没来得及被
   * `pin`（调用方拿到才能钉），而把它回收掉意味着**返回一个已经 revoke 的地址**——
   * `<video>` 收到后画面全黑且无报错。缺省的两道闸（单文件 96 MB < 总量 320 MB）
   * 让这条路走不到，但那是参数巧合，不是性质；显式护住才是。
   */
  function evict(keep?: string): void {
    // 从最老的开始丢；钉住的那一个跳过（它是预览器此刻的 src，
    // 丢掉 = 画面当场变黑且无任何报错，见文件头）。
    for (const e of [...lru.values()]) {
      if (liveBytes <= maxLiveBytes) return;
      if (e.url === pinned || e.url === keep) continue;
      drop(e);
      evicted++;
    }
  }

  /** 读盘 → 字节。合流；失败一律 null（调用方走云端）。 */
  function readBytes(projectId: string, url: string): Promise<Uint8Array | null> {
    const flying = reading.get(url);
    if (flying) return flying;
    const task = (async () => {
      try {
        const p = await io.probe(projectId, url);
        // 不在盘上：**不下载**（下载时机是 6.2 的事，见文件头）
        if (!p || p.size <= 0) return null;
        return await io.read(p.path);
      } catch (e) {
        try { onError(url, e); } catch { /* 回调自己炸了也不能带走调用方 */ }
        return null;
      } finally {
        reading.delete(url);
      }
    })();
    reading.set(url, task);
    return task;
  }

  /**
   * 「盘上有就给 blob，没有就 `null`」—— `resolve` 与 `localBlob` 的共同本体。
   *
   * 抽出来是因为两者只差最后一步（兜不兜底到云端）。各写一份的话，
   * 「单文件上限」「认不出类型不落 blob」「读盘期间别造第二个 blob」这几条
   * 就会有两份实现，而它们**都是静默失效**的那类规则：错了不报错，
   * 只是内存里多一个永不回收的 blob，或者一个不报错也不播的 `<video>`。
   */
  async function materialize(projectId: string, url: string): Promise<string | null> {
    if (!url) return null;
    if (!io.enabled()) return null;                 // 浏览器：没有 plugin-fs

    const hit = touch(url);
    if (hit) { hits++; return hit.blobUrl; }

    // 认不出类型的 blob「不报错、就是不播」，比走云端糟得多（见 mimeForUrl）
    const mime = mimeForUrl(url);
    if (!mime) return null;

    try {
      const p = await io.probe(projectId, url);
      if (!p || p.size <= 0) return null;
      // 一部几百 MB 的成片不该为了"预览一下"整份进内存；
      // 走云端反而更好——`<video>` 按需 range 取，拖到哪取到哪。
      if (p.size > maxFileBytes) return null;

      const bytes = await io.read(p.path);
      if (bytes.length === 0) return null;

      // 读盘期间可能已经有别的调用把它材料化了，别造第二个 blob（会漏一个）
      const again = touch(url);
      if (again) { hits++; return again.blobUrl; }

      const blobUrl = io.objectUrl(bytes, mime);
      const e: Entry = { url, blobUrl, bytes: bytes.length };
      lru.set(url, e);
      byBlob.set(blobUrl, url);
      liveBytes += e.bytes;
      materialized++;
      // 刚造出来的这一个排在队尾（最新），evict 从队头开始丢，所以它不会当场被
      // 自己挤掉——除非它自己就超了总量上限。`keep` 显式护住这种情况：
      // 返回一个已 revoke 的地址就是黑屏且无报错。
      evict(url);
      return blobUrl;
    } catch (e) {
      try { onError(url, e); } catch { /* 同上 */ }
      return null;
    }
  }

  return {
    peek(url) {
      const e = touch(url);
      return e ? e.blobUrl : null;
    },

    async resolve(projectId, url) {
      const blob = await materialize(projectId, url);
      if (blob) return blob;
      remote++;
      return io.remote(url);
    },

    localBlob(projectId, url) {
      return materialize(projectId, url);
    },

    pin(objectUrl) {
      // 反查得到 = 它确实是本模块造的、且还活着；否则（云端兜底地址、
      // 已被回收的旧 blob）保持原样。见接口注释：钉不上就别动钉子。
      const url = byBlob.get(objectUrl);
      if (url !== undefined) pinned = url;
    },

    async bytes(projectId, url) {
      if (!url || !io.enabled()) return null;
      return readBytes(projectId, url);
    },

    setProject(projectId) { project = projectId; },

    currentProject() { return project; },

    async bytesForCurrent(url) {
      if (!project) return null;
      if (!url || !io.enabled()) return null;
      return readBytes(project, url);
    },

    async localBlobForCurrent(url) {
      if (!project) return null;
      return materialize(project, url);
    },

    release() {
      for (const e of [...lru.values()]) drop(e);
      pinned = null;
    },

    stats() {
      return {
        live: lru.size, bytes: liveBytes,
        hits, remote, materialized, evicted, pinned,
      };
    },
  };
}
