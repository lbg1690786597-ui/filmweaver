/**
 * render/renderer.ts — Render Engine V2 执行器
 *
 * 把 RenderPlan 真正跑成一个 mp4：
 *
 *     RenderPlan → 分段 → 缓存素材 → 逐段渲染 → concat → 烧字幕 → 另存
 *
 * ## 与 legacy localRender 的区别
 *
 * legacy 是"逐段归一化再 concat"的单轨流水线，做不了转场/叠加/多轨。
 * 本模块基于 RenderPlan + 分段器，能力上是它的超集；且**内存恒定**——
 * 每段最多 6 个输入进 filter_complex，不随项目长度增长
 * （实测 1424 镜项目峰值 686MB，单图方案需 187GB）。
 *
 * legacy 保留为 fallback：sidecar 不可用、或用户选"经典导出"时走那条。
 *
 * ## 中断与清理
 *
 * 长任务必须能取消——1424 镜项目渲染要几十分钟，不给取消等于卡死软件。
 * 用 AbortSignal：每段开始前检查，已启动的 ffmpeg 进程随之 kill。
 * 无论成功失败取消，工作目录一律清理（finally）。
 */

import { Command } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join, resolveResource } from "@tauri-apps/api/path";
import { mkdir, readDir, writeTextFile, writeFile, remove, stat } from "@tauri-apps/plugin-fs";
import type { SubtitleStyleLike } from "../lib/subtitleStyle";
import { retireFiles } from "../lib/retireFiles";
import {
  ensureCached, sweepParts, peekCached, loadAudioProbes, saveAudioProbes,
} from "../lib/mediaCache";
import { Aborted } from "../lib/aborted";
import { canReadLocal, getLocalRoots } from "../lib/localRootStore";
import type { RenderPlan } from "./model";
import { prepareMedia, type PrepIO } from "./exportPrep";
import { buildSegments, segmentStats } from "./segment";
import { probeCapabilities, pickEncoder, hasFilter } from "./capabilities";
import {
  planSegmentMasks, writeSegmentMasks, maskClipsOf, maskDegradeNotices, type MaskIO,
} from "./maskFiles";
import {
  compileSegment, compileConcat, compileBurnSubtitles, compileAudioMix,
} from "./ffmpegCompiler";
import { checkBundledFonts, bundledFontsWarning, MIN_FONT_BYTES } from "./bundledFonts";

export interface RenderProgress {
  /** 0-100 */
  pct: number;
  /** 面向用户的阶段描述 */
  stage: string;
  /** 当前段 / 总段数（分段渲染阶段有效） */
  segment?: { done: number; total: number };
}

export interface RenderOptions {
  plan: RenderPlan;
  /** 期望编码器；"auto" = 有硬件编码就用硬件 */
  preferEncoder?: string;
  /** 字幕 SRT 文本；空则不烧 */
  burnSrt?: string;
  /** 字幕样式（字号/颜色/描边/底框/位置/字体）。
   *  不传则用 srtForceStyle 的短剧默认值，**而不是**此前写死的 FontSize=18。 */
  subtitleStyle?: SubtitleStyleLike | null;
  /**
   * 最终输出文件的绝对路径（含 .mp4 后缀）。
   *
   * ⚠️ 调用方必须在开始渲染**之前**用系统保存对话框问好这个值——
   * 不能再像旧版那样等渲染跑完 97% 才弹 save()：几十分钟渲染完，用户
   * 一旦手滑关掉/取消保存对话框，整轮计算全部作废。现在"选路径"和
   * "跑渲染"是两个独立步骤，取消发生在跑之前，零成本。
   */
  outputPath: string;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  /** 用户选择的保存路径；null = 用户取消了另存 */
  outputPath: string | null;
  segments: number;
  estPeakMB: number;
  encoder: string;
  elapsedMs: number;
  /**
   * 面向用户的降级提示（5.8）。导出**成功**了，但有东西没有按用户设置的样子出来 ——
   * 本机 ffmpeg 缺滤镜、动画蒙版超预算被降级等。
   *
   * 为什么必须单独有这么个出口：这几种降级都是「不报错、画面悄悄不一样」，
   * 而进度条只有一行 `stage`、跑完就没了。不把它端到用户眼前，用户只会看到
   * 「羽化没生效」而无从知道原因，回头来报一个查不出的 bug。
   */
  notices: string[];
}

async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Aborted();
  const cmd = Command.sidecar("binaries/ffmpeg", args);

  // stderr 监听必须在 spawn 之前注册，否则进程启动瞬间的输出会丢——
  // ffmpeg 的致命错误（缺编码器、参数非法）恰恰是最先打出来的那几行。
  let stderr = "";
  cmd.stderr.on("data", (line: string) => { stderr += line; });

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const onAbort = () => done(() => { void child?.kill(); reject(new Aborted()); });
    signal?.addEventListener("abort", onAbort, { once: true });

    cmd.on("close", (data: { code: number | null }) => {
      signal?.removeEventListener("abort", onAbort);
      done(() => {
        if (data.code === 0) resolve();
        // 只保留 stderr 尾部：ffmpeg 会刷几千行进度，全带上没法看。
        // 这段原始输出用户读不懂，但**不能省** —— 出错时它是唯一的线索；
        // 所以前面加一句人话，并说清这段是拿来发给我们的。
        else reject(new Error(
          `导出失败（错误码 ${data.code}）。如需帮助，请把下面这段一起发给我们：\n`
          + stderr.slice(-400)));
      });
    });
    cmd.on("error", (e: string) => {
      signal?.removeEventListener("abort", onAbort);
      done(() => reject(new Error(String(e))));
    });

    // spawn 本身会失败：sidecar 未打包、或 capabilities 缺
    // shell:allow-spawn（execute 与 spawn 是两个独立权限，只声明前者时
    // 能力探测能过、真正渲染却启动不了，表现为"点了没反应"）。
    // 这里必须把 reject 接出来，否则 Promise 永远悬着，UI 停在上一个进度不动。
    let child: Awaited<ReturnType<typeof cmd.spawn>> | undefined;
    cmd.spawn().then(
      (c) => { child = c; if (signal?.aborted) onAbort(); },
      (e) => done(() => reject(new Error(
        "导出组件没能启动，请把软件更新到新版本，或重新安装。\n"
        + `（${String(e).slice(0, 120)}）`))),
    );
  });
}

/** 探测素材是否含音轨。
 *
 *  ffprobe 不随包分发（只打了 ffmpeg.exe，见 CI 里"只放 ffmpeg.exe"的取舍），
 *  所以沿用 localRender.ts 的老办法：`ffmpeg -i` 无输出文件必然返回非 0，
 *  但 stderr 里有完整的流信息，从中匹配 Audio 流即可。
 *
 *  ⚠️ **返回 `null` 表示探测本身失败**（sidecar 拉不起来 / 权限缺失 / 超时），
 *  不是"没有音轨"。调用方（`exportPrep`）据此区分两件事：
 *    · 本次怎么办 —— 按**有音轨**继续（猜错代价不对称：当作没有会静音成片，
 *      当作有则由 `0:a:0?` 的可选映射兜住）；
 *    · 要不要记进探测表 —— **不记**。把一次偶发失败的猜持久化，会让它变成
 *      这个素材永久的错误结论，而错误的 `true` 在 composite 分支意味着去映射
 *      一条不存在的 `[i:a]`，后果是整段导出失败。 */
async function probeHasAudio(path: string): Promise<boolean | null> {
  try {
    const out = await Command.sidecar("binaries/ffmpeg", ["-i", path]).execute();
    return /Stream #\d+:\d+.*Audio/.test(out.stderr || "");
  } catch {
    return null;
  }
}

/**
 * 生产侧的准备阶段 I/O 接线。**规则一条都不在这里**——本地化判据、进度权重、
 * 探测表的键与容量策略全在 `render/exportPrep.ts`，那份能在 node 下被真跑。
 *
 * ⚠️ `peek` 走的是 `peekCached`（只 stat）而不是 `cacheDirFor`：后者会 `mkdir`，
 * 而准备阶段第一步是「先看盘上有什么」——那一步为没缓存过的项目建一串空目录，
 * 既是读操作留写痕迹，也会让 `localCacheStats` 的"有缓存的项目数"虚高。
 */
function prepIO(projectId: string): PrepIO {
  return {
    peek: (url) => peekCached(projectId, url),
    fetch: (url, signal) => ensureCached(projectId, url, signal),
    probeAudio: (path) => probeHasAudio(path),
    loadProbes: () => loadAudioProbes(),
    saveProbes: (t) => saveAudioProbes(t),
    sweep: () => sweepParts(projectId),
    // 6.6：用户自己盘上的素材。**先问登记簿再碰盘** —— 那份列表是设置里
    // 「移出列表」唯一真正生效的地方（插件侧没有撤销 scope 的接口，
    // 见 `lib/localRootStore.ts`）。跳过这一句，那个按钮就成了假的。
    statLocal: async (path) => {
      if (!canReadLocal(path)) return null;
      try {
        const st = await stat(path);
        // 目录也有 size，放过去会让一个目录被当成素材喂给 ffmpeg。
        return st.isFile ? { size: st.size } : null;
      } catch {
        // 不在 scope（重启后授权已释放）/ 文件没了 / 盘拔了 —— 都是**正常输入**。
        // 由 exportPrep 按 `explainUnreachable` 分辨原因并说人话，这里不抛。
        return null;
      }
    },
  };
}

/** 认得出时间戳的工作目录，多久之后算"没人要了"。 */
const STALE_RUN_MS = 2 * 3600_000;

/**
 * 清掉历史遗留的渲染工作目录（上次崩溃 / 断电 / 进程被杀留下的）。
 *
 * ## 为什么工作目录要一次渲染一个（6.0 修「按集导出只出第一集」）
 *
 * 此前工作目录是**固定的** `appDataDir()/render_v2`，且入口那句
 * `if (await exists(work)) await remove(work, {recursive:true})` **没有 catch**。
 *
 * 按集导出是同一进程内**连续 5 次** `render()`。第 1 次收尾时 `finally` 里的
 * `remove(work).catch(() => {})` 一旦失败就被静默吞掉——Windows 上这很常见：
 * 刚退出的 ffmpeg 子进程、或正在扫描新写入 mp4 的杀软，都还握着 `seg_*.mp4`
 * 的句柄，DeleteFile 直接 Access denied。POSIX 的 unlink 允许删有开着句柄的
 * 文件，所以**这个错误在 Linux 上永远测不出来**（与 Windows 大小写敏感那类
 * 同源：本地全绿正是它的表现）。
 *
 * 于是第 2 次 `render()` 进来，`exists(work)` 为真、`remove()` 抛异常，
 * 而这句在 `try` **之前**——`App.doLocalExport` 的 for 循环当场 break，
 * 用户只拿到第一集加一条 4 秒就消失的红字。手动一集一集导则每次都是"第一次"，
 * 中间隔了几十秒句柄早已释放，所以又都能成功：与用户描述的现象逐条对得上。
 *
 * 两条修法都要，因为它们防的是不同的东西：
 *   ① 每次渲染用自己的目录 —— 两次渲染不再争同一个路径（治本）；
 *   ② 清理一律 best-effort —— 盘上留着个删不掉的旧目录，也不能阻断新导出（兜底）。
 *
 * ⚠️ **本函数整体不抛**。它是清洁工，不是前置条件。
 */
async function sweepStaleRuns(runsRoot: string, now: number): Promise<void> {
  try {
    for (const e of await readDir(runsRoot)) {
      const m = /^run_([0-9a-z]+)_/.exec(e.name);
      // 认得出时间戳的只删够老的：万一将来有并发导出，不至于把别人正在写的目录端了。
      // 认不出的（≤0.8.6 直接堆在 render_v2 根下的 seg_*.mp4 / masks/ / list.txt）
      // 是升级前的遗留，直接带走，否则它们会永远占着用户的盘。
      if (m && now - parseInt(m[1], 36) < STALE_RUN_MS) continue;
      await remove(await join(runsRoot, e.name), { recursive: true }).catch(() => {});
    }
  } catch {
    // readDir 失败（目录还不存在 / 权限）——没有可清的，也没有可报的。
  }
}

/**
 * 执行渲染。抛 Aborted 表示用户取消（调用方应静默处理，不当作错误弹窗）。
 */
export async function render(opts: RenderOptions): Promise<RenderResult> {
  const t0 = Date.now();
  const { plan, signal } = opts;
  const report = (p: RenderProgress) => opts.onProgress?.(p);

  const caps = await probeCapabilities();
  if (!caps.available) {
    throw new Error("导出功能不可用：没有找到导出组件。网页版请改用桌面客户端导出。");
  }
  // 4.4：编码器要**先看用户选的 codec、再看硬件**。此前这里只传 preferEncoder，
  // 而 pickEncoder 直接拿 hwEncoders[0]，于是 plan.output.vcodec 从来没被读过——
  // 导出对话框里的「H.265」选了等于没选。
  const encoder = pickEncoder(caps, {
    preferred: opts.preferEncoder,
    vcodec: plan.output.vcodec,
  });

  const segs = buildSegments(plan);
  if (!segs.length) throw new Error("没有可渲染的片段");
  const stats = segmentStats(segs);

  // ---- 工作目录：**每次渲染一个**，见 sweepStaleRuns 的注释 ----
  const base = await appDataDir();
  const runsRoot = await join(base, "render_v2");
  const work = await join(runsRoot,
    `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(work, { recursive: true });
  await sweepStaleRuns(runsRoot, Date.now());

  try {
    // 1) 准备素材（0-18%）：本地化 + 音轨探测
    //
    // 规则全在 `render/exportPrep.ts`（含"该报什么话"），这里只做两件事：
    // 接 I/O、把它的语义化 `frac` 映射进本阶段的百分比配额。
    //
    // ⚠️ 6.4 之前这里是「无条件报 `下载素材 d/t` 并吃掉 0→15%」：6.2 让 AI 产物
    // 一出现就落盘之后，全命中才是常态，于是每次导出都要看着进度条为**零工作量**
    // 爬 15%，还被告知在"下载"。现在没活干就只报一次「素材已在本地 (N)」。
    const prep = await prepareMedia({
      plan,
      io: prepIO(plan.projectId),
      // 并发上限保持 4（与 6.4 之前逐字相同）：下载怕打爆 HTTP 连接池，
      // 探测怕同时拉起太多 ffmpeg 进程。**这两个数字不因本次重构而改动。**
      downloadConcurrency: 4,
      probeConcurrency: 4,
      // 6.6：只用来**把话说清楚** —— 某个本地素材读不到时，是"重启后授权没了、
      // 重选一下就行"还是"文件真的不见了"，两句话的处置办法完全不同。
      localRoots: getLocalRoots(),
      signal,
      onProgress: (p) => report({ pct: Math.round(p.frac * 18), stage: p.stage }),
    });
    const paths = prep.paths;
    const audioMap = prep.audio;

    // ---- 5.8 蒙版接线 ----
    //
    // 蒙版落在 work/masks/ 下，于是 **本函数末尾那句 `remove(work, {recursive:true})`
    // 就是它的清理**——成功 / 失败 / 取消三条路径共用同一句，不需要再写一套。
    // （再写一套的下场是三条路径里迟早漏掉一条，而漏掉的那条通常是"取消"。）
    const masksDir = await join(work, "masks");
    await mkdir(masksDir, { recursive: true });
    const maskIO: MaskIO = {
      join: (dir, name) => join(dir, name),
      write: (path, data, append) => writeFile(path, data, { append }),
    };
    // 本段的 (clipIdx,groupIdx) → 蒙版路径。编译器只通过 ctx.maskPath 读它，
    // 每段渲染前重填 —— 段与段之间的蒙版不共享（文件名里的 segIdx 就是这个意思）。
    let segMasks = new Map<string, string>();

    const notices = new Set<string>(prep.notices);
    // 缺滤镜的降级提示要在**开跑前**就算出来：它取决于 caps 和素材，与跑到第几段无关，
    // 而放在段内算会随段重复判断、还可能因为某段恰好没有马赛克而漏报。
    for (const n of maskDegradeNotices(
      segs.flatMap((s) => maskClipsOf(s.clips)),
      { alphamerge: hasFilter(caps, "alphamerge"), geq: hasFilter(caps, "geq") },
    )) notices.add(n);

    const ctx = {
      plan, caps, encoder,
      crf: plan.output.crf,
      localPath: (id: string) => {
        const p = paths.get(id);
        if (!p) throw new Error(`素材未缓存: ${id}`);
        return p;
      },
      hasAudio: (id: string) => audioMap.get(id) ?? true,
      // 6.4：效果依赖的资源文件（当前只有 LUT）。拿不到返回 null 而不是 throw ——
      // LUT 是装饰性的，下载失败该少一层调色，不该让整个导出崩掉。
      assetPath: (id: string) => paths.get(id) ?? null,
      // 与 localPath / hasAudio 同一个模式：编译器不产生文件，只拼参数。
      maskPath: (clipIdx: number, groupIdx: number) =>
        segMasks.get(`${clipIdx}:${groupIdx}`) ?? null,
    };

    // 2) 逐段渲染（18-85%）——内存在这里恒定，是整个方案的关键
    const segFiles: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      if (signal?.aborted) throw new Aborted();
      // 进入本段前先报一次：单段（尤其 30s 长镜）可能跑好几分钟，
      // 只在**完成后**报进度的话，用户看到的是长时间不动的进度条。
      report({
        pct: 18 + Math.round((i / segs.length) * 67),
        stage: `渲染片段 ${i + 1}/${segs.length}`,
        segment: { done: i, total: segs.length },
      });
      const out = await join(work, `seg_${String(i).padStart(4, "0")}.mp4`);

      // 先产蒙版、再编译：`compileSegment` 通过 ctx.maskPath 读的就是这一份，
      // 拿不到路径时它整段落回 legacy 的 drawbox / split-crop-overlay（§5.3.1 零回归）。
      segMasks = new Map();
      if (segs[i].kind === "composite" && hasFilter(caps, "alphamerge")) {
        const mplan = planSegmentMasks(
          i, maskClipsOf(segs[i].clips),
          { w: plan.output.width, h: plan.output.height }, plan.output.fps,
        );
        if (mplan.specs.length) {
          report({
            pct: 18 + Math.round((i / segs.length) * 67),
            stage: `处理遮挡 ${i + 1}/${segs.length}`,
            segment: { done: i, total: segs.length },
          });
          segMasks = await writeSegmentMasks(
            masksDir, mplan, maskIO, signal, () => { throw new Aborted(); });
          for (const n of mplan.notices) notices.add(n);
        }
      }

      const { args } = compileSegment(segs[i], ctx, out);
      await runFfmpeg(args, signal);
      segFiles.push(out);
      // 本段已出片 → 它的蒙版再没人读了。峰值磁盘因此是「单段蒙版」而不是「全片蒙版」；
      // 就算这里漏了，finally 的整目录删仍然兜底，二者不是替代关系。
      const segMaskFiles = [...segMasks.values()];
      if (segMaskFiles.length) await retireFiles(segMaskFiles);
      report({
        pct: 18 + Math.round(((i + 1) / segs.length) * 67),
        stage: `渲染片段 ${i + 1}/${segs.length}`,
        segment: { done: i + 1, total: segs.length },
      });
    }

    // 4.3：中间产物用完即删。
    //
    // 峰值磁盘 = 所有分段之和 + 尾段每一道的产物。四道齐全时约是成片体积的
    // **4 倍**（1424 镜 4K 项目动辄几十 GB），而用户盘满的表现是导出跑了半小时
    // 之后在最后一步失败——最贵的一种失败。
    //
    // ⚠️ 安全规则只有一条，但必须严格遵守：
    //    **只有当下一道已经成功产出新文件、`final` 也已经指向它之后，
    //      才删上一道的产物。**
    // §0.5(h) 记了反面教材：`merged.mp4` / `mixed.mp4` **在降级分支里就是成片**
    // （无音频时成片是 merged；老机器 ffmpeg 没有 subtitles 滤镜时成片是 mixed，
    // 那是刻意保留的降级分支）。无条件删这两个 = 静音项目和老机器直接导不出来。
    // 而按「下一道成功后才删上一道」来写，被删的那个**必然不是成片**——
    // 三种降级组合自动成立，不需要在每个分支里各写一遍条件。
    //
    // 缓存目录（cache/<projectId>/）一个都不能碰：同一素材可能被多镜引用，
    // 且分段渲染与混音会**两次读取**它。这里删的全部在 work 目录内。
    //
    // 具体的删除动作（分批 + 吞错）在 lib/retireFiles.ts，与 legacy localRender
    // 共用同一份实现——这条规则写错的代价太不对称，不能两边各抄一遍。

    // 3) concat（85-92%）——各段编码参数一致，-c copy 安全
    report({ pct: 85, stage: "拼接片段" });
    const listPath = await join(work, "list.txt");
    await writeTextFile(listPath,
      segFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n") + "\n");
    let final = await join(work, "merged.mp4");

    // 4.2：`+faststart` 只给**最后一道**产物。它靠整文件重写把 moov 挪到文件头，
    // 而中间产物没有一个会被播放器打开（下一道 ffmpeg 读本地文件不在乎 moov 位置），
    // 加了纯属白做几次全文件读写。
    //
    // 哪一道是最后一道取决于后面两步跑不跑，所以两个判据都必须**提前**定下来。
    // 混音这一步尤其要小心：能不能混不是看「有没有音频 clip」，而是看
    // `compileAudioMix` 过完自己那道 `!muted && volume > 0 && path` 的筛之后
    // 还剩不剩东西（全部静音时它返回 null）。若在这里另写一个近似判据，
    // 就会出现「以为要混音、于是 concat 不加 faststart，结果混音没跑，
    // 交付的 merged.mp4 没有 moov 前置」——静默、且只有网页边下边播的用户会遇到。
    // 故直接把 mixArgs **算出来**当判据，让同一个对象决定两件事。
    const audioClips = plan.output.withAudio
      ? plan.tracks
        .filter((t) => t.kind === "audio" && !t.muted)
        .flatMap((t) => t.clips)
        .map((c) => ({
          path: paths.get(c.mediaId) ?? "",
          startSec: c.timelineStartSec,
          volume: c.audio.volume,
          muted: c.audio.muted,
        }))
        .filter((c) => c.path)
      : [];
    const mixOut = await join(work, "mixed.mp4");
    const willBurn = !!opts.burnSrt?.trim() && hasFilter(caps, "subtitles");
    const mixArgs = audioClips.length
      ? compileAudioMix(final, audioClips, mixOut, { faststart: !willBurn })
      : null;

    await runFfmpeg(
      compileConcat(listPath, final, {
        withAudio: plan.output.withAudio,
        faststart: !mixArgs && !willBurn,
      }), signal);

    // concat 已经成功产出 merged.mp4，分段文件就此退休（§0.5(h) 认定的唯一安全窗口）。
    // 单独报一次进度：1424 个文件的删除不是瞬时的，不报的话用户看到的是
    // 进度条在 85% 上莫名其妙地停一下。
    report({ pct: 88, stage: `清理 ${segFiles.length} 个分段文件` });
    await retireFiles(segFiles);

    // 3.5) 混入音频轨（旁白 / 配乐 / 镜头原声）
    //
    // 分段渲染只处理视频轨（buildSegments 按 kind==="video" 过滤），
    // 音频轨必须在这里单独混一次——否则成片里没有旁白也没有配乐。
    // 对"镜头原声"尤其关键：normalize.ts 已把被剥离的镜头视频静音，
    // 这一步不做的话那些镜头会彻底没声音。
    if (mixArgs) {
      report({ pct: 90, stage: `混音 ${audioClips.length} 段` });
      await runFfmpeg(mixArgs, signal);
      const prev = final;
      final = mixOut;
      // final 已经指向 mixed.mp4 → merged.mp4 不可能是成片了（4.3）
      await retireFiles([prev]);
    }

    // 4) 烧字幕（92-97%）——放最后，避免每段各烧一次导致时间码错位
    if (opts.burnSrt?.trim()) {
      // ⚠️ 这里刻意复用上面那个 willBurn，而不是把 `hasFilter(caps,"subtitles")`
      // 再写一遍：它同时决定了「前一道要不要 faststart」。两处各写一份判据一旦漂移，
      // 症状是成片**一个 faststart 都没有**（前一道以为字幕会烧、字幕这边却跳过了）。
      if (!willBurn) {
        // 能力不足时跳过而不是失败：没字幕的成片仍然可用
        report({ pct: 92, stage: "当前版本不支持烧录字幕，已跳过" });
      } else {
        report({ pct: 92, stage: "烧录字幕" });
        const srt = await join(work, "subs.srt");
        await writeTextFile(srt, opts.burnSrt);
        const burned = await join(work, "final.mp4");
        // 内置字体才传 fontsdir。
        //
        // 实测（ffmpeg 6.x + libass）：fontsdir 是**追加**搜索路径，不是限定——
        // 传了它 fontconfig 仍会去找系统字体。所以"内置字体在没装它的机器上
        // 也能用"靠的正是这条追加路径；而对系统字体它不起作用，白白让 libass
        // 去挨个打开目录里的 README/LICENSE 报一串 "Error opening memory font"。
        // 故只在 bundled 时传。
        let fontsDir: string | null = null;
        if (opts.subtitleStyle?.fontSource === "bundled") {
          // ⚠️ resolveResource **只拼路径、不校验存在**。字体二进制不进 git，
          // 而 CI 以前从不跑 fetch-fonts.sh —— 于是这里拿到一个"存在但空的"
          // 目录，fontsdir 照传，libass 找不到 Noto 就悄悄换字形：用户选了
          // 内置字体、导出成功、字幕却是别的样子，全程零提示。
          // 现在真去看那两个 .ttc 在不在，不在就明说并回落（见 bundledFonts.ts）。
          const dir = await resolveResource("resources/fonts").catch(() => null);
          // 判据是"存在**且**够大"而不是单纯存在：安装中断留下的 0 字节占位文件
          // 与完全没有这个文件，对 libass 是同一件事（都换字形），却只有前者
          // 能骗过 exists()。stat 抛错由 checkBundledFonts 兜成"不可用"。
          const check = await checkBundledFonts(dir, async (p) =>
            (await stat(p)).size >= MIN_FONT_BYTES);
          fontsDir = check.fontsDir;
          const warn = bundledFontsWarning(check);
          if (warn) report({ pct: 92, stage: warn });
        }
        await runFfmpeg(
          compileBurnSubtitles(final, srt, burned, encoder, plan.output.crf, {
            style: opts.subtitleStyle, videoH: plan.output.height, fontsDir,
            faststart: true,   // 烧字幕永远是最后一道
          }),
          signal);
        const prev = final;
        final = burned;
        // final 已经指向 final.mp4 → 上一道（mixed 或 merged）不可能是成片了（4.3）。
        // 注意 retire 必须排在 runFfmpeg **之后**：prev 正是烧字幕这一道的
        // **输入文件**，提前删就等于抽掉它脚下的地板。混音那道同理。
        await retireFiles([prev]);
      }
    }

    // 5) 另存（97-100%）
    report({ pct: 97, stage: "保存文件" });
    const dest = opts.outputPath;
    // 走 Rust 侧的 export_copy_file 而不是 fs 插件的 copyFile：
    // fs 插件受 capabilities scope 限制（只允许 $APPDATA 等预声明目录），
    // 而这里的 dest 来自系统保存对话框，用户可能选任意盘符，无法事先枚举。
    // 此前导出"闪一下就没反应"正是 copyFile 被 scope 拦下所致。
    //
    // 落地校验用**它的返回值**（`std::fs::copy` 报的字节数），不用 `stat(dest)`：
    // 若拷贝写了 0 字节（磁盘满 / 被安全软件拦截），不能假装成功；但 `stat` 是
    // fs 插件的 API，对 dest 同样越 scope —— 上面刚说清楚这一点，紧接着又用它，
    // 那句 `.catch(() => null)` 会把"权限查不到"和"文件是空的"混成同一个结论，
    // 于是拷贝明明成了却报「保存失败」。字节数由拷贝本身给出，不需要再查一次盘。
    const copied = await invoke<number>("export_copy_file", { src: final, dst: dest });
    if (!copied) {
      throw new Error(`保存失败：文件没能写入 —— 请检查磁盘空间和写入权限（${dest}）`);
    }

    report({ pct: 100, stage: "已导出" });

    return {
      outputPath: dest, segments: segs.length,
      estPeakMB: stats.estPeakMB, encoder, elapsedMs: Date.now() - t0,
      notices: [...notices],
    };
  } finally {
    // 成功/失败/取消都要清工作目录，否则几十 GB 中间文件会堆在用户盘上
    await remove(work, { recursive: true }).catch(() => {});
  }
}

export { Aborted };
