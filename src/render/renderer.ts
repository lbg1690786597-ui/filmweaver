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
import { exists, mkdir, writeFile, writeTextFile, remove, rename, stat } from "@tauri-apps/plugin-fs";
import { api } from "../api";
import type { SubtitleStyleLike } from "../lib/subtitleStyle";
import type { RenderPlan } from "./model";
import { buildSegments, segmentStats } from "./segment";
import { probeCapabilities, pickEncoder, hasFilter } from "./capabilities";
import {
  compileSegment, compileConcat, compileBurnSubtitles, compileAudioMix,
} from "./ffmpegCompiler";

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
}

class Aborted extends Error {
  constructor() { super("用户已取消渲染"); this.name = "Aborted"; }
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
        // 只保留 stderr 尾部：ffmpeg 会刷几千行进度，全带上没法看
        else reject(new Error(`ffmpeg 失败(${data.code}): ${stderr.slice(-500)}`));
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
        `无法启动 ffmpeg：${String(e)}\n`
        + "（若提示权限不足，说明安装包的 capabilities 缺 shell:allow-spawn）"))),
    );
  });
}

/** 把 RenderPlan 里的媒体缓存到本地；返回 mediaId → 本地绝对路径 */
/** 探测素材是否含音轨。
 *
 *  ffprobe 不随包分发（只打了 ffmpeg.exe，见 CI 里"只放 ffmpeg.exe"的取舍），
 *  所以沿用 localRender.ts 的老办法：`ffmpeg -i` 无输出文件必然返回非 0，
 *  但 stderr 里有完整的流信息，从中匹配 Audio 流即可。
 *
 *  探测失败（异常/超时）一律当作**有音轨**：猜错的代价不对称——
 *  当作没有会静音成片，当作有则由 `0:a:0?` 的可选映射兜住。 */
async function probeHasAudio(path: string): Promise<boolean> {
  try {
    const out = await Command.sidecar("binaries/ffmpeg", ["-i", path]).execute();
    return /Stream #\d+:\d+.*Audio/.test(out.stderr || "");
  } catch {
    return true;
  }
}

async function cacheMedia(
  plan: RenderPlan,
  report: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const base = await appDataDir();
  const cacheDir = await join(base, "cache", plan.projectId);
  if (!(await exists(cacheDir))) await mkdir(cacheDir, { recursive: true });

  // 清理上一轮留下的 .part 残留（断电/Kill 后的遗留），避免下一次误判为完整文件。
  // exists 检查只用于目录，不逐一列文件，所以这里不做全量扫描——
  // 原子化下载（先写 .part 再 rename）本身已经保证 dest 不会是半截文件。

  const map = new Map<string, string>();
  let done = 0;

  // 并发下载上限（每次导出通常有几十至几百个素材，串行太慢；
  // 并发上限保守取 4，避免把 HTTP 连接池打爆。如需调整请改这一行）。
  const CONCURRENCY = 4;

  async function fetchOne(m: { id: string; url: string }) {
    if (signal?.aborted) throw new Aborted();

    // 缓存键包含 URL 哈希，避免同名但不同来源的素材互相覆盖。
    // 简单哈希：取 URL 的最后 64 字节的 charCode 异或，足够区分。
    let h = 0;
    const s = m.url.slice(-64);
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    const hx = (h >>> 0).toString(16).padStart(8, "0");
    const name = `${hx}_${m.url.split("/").pop()!.split("?")[0]}`;
    const dest = await join(cacheDir, name);
    const part = dest + ".part";

    // 复用校验：存在 + size > 0（.part 是独立路径，永远不会被当成 dest，
    // 所以原子 rename 之前的半截文件不会被当作完整缓存复用）。
    if (await exists(dest)) {
      const st = await stat(dest);
      if (st.size > 0) {
        map.set(m.id, dest);
        report(++done, plan.media.length);
        return;
      }
      // size === 0：之前写出了空文件（磁盘满？），删掉重下。
      await remove(dest).catch(() => {});
    }

    // 下载 → 写 .part → rename（原子落地）。plugin-fs 的 rename 在同一
    // 文件系统内是原子操作；写 .part 失败或进程被杀，dest 永远不会
    // 出现半截内容——下轮 exists(dest) 判否，重新走一遍下载。
    //
    // fetch 必须带 signal：不带的话点了取消要等当前这批（最多 4 个）素材
    // 全部下完才停，慢网下一个大素材就是几十秒的"点了没反应"。
    const resp = await fetch(api.mediaUrl(m.url), { signal }).catch((e) => {
      // fetch 被 signal 中断时抛的是 DOMException(name="AbortError")，
      // 而调用方只认我们自己的 Aborted（靠 e.name 判断要不要静默）。
      // 不归一化的话取消导出会弹成"导出失败：AbortError"。
      if (signal?.aborted) throw new Aborted();
      throw e;
    });
    if (!resp.ok) throw new Error(`素材下载失败 ${resp.status}: ${name}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.length === 0) throw new Error(`素材下载为空: ${name}`);
    try {
      await writeFile(part, bytes);
      await rename(part, dest);
    } catch (e) {
      // 半截 .part 不清掉会永久留在用户盘上（缓存目录只按 dest 名复用，
      // 没有任何一处会再碰它）。失败路径顺手删掉。
      await remove(part).catch(() => {});
      throw e;
    }

    map.set(m.id, dest);
    report(++done, plan.media.length);
  }

  // 限并发：把任务切成 CONCURRENCY 宽的批次顺序执行，每批内并发。
  for (let i = 0; i < plan.media.length; i += CONCURRENCY) {
    if (signal?.aborted) throw new Aborted();
    const batch = plan.media.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(fetchOne));
  }

  return map;
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
    throw new Error("本机渲染不可用：未找到 ffmpeg（网页预览环境请改用服务端导出）");
  }
  const encoder = pickEncoder(caps, opts.preferEncoder);

  const segs = buildSegments(plan);
  if (!segs.length) throw new Error("没有可渲染的片段");
  const stats = segmentStats(segs);

  const base = await appDataDir();
  const work = await join(base, "render_v2");
  if (await exists(work)) await remove(work, { recursive: true });
  await mkdir(work, { recursive: true });

  try {
    // 1) 缓存素材（0-15%）
    report({ pct: 0, stage: "准备素材" });
    const paths = await cacheMedia(plan, (d, t) => {
      report({ pct: Math.round((d / t) * 15), stage: `下载素材 ${d}/${t}` });
    }, signal);

    // 逐个素材探一次音轨（每个素材一次，不是每段一次）。
    // 这决定 passthrough 段该用素材自己的声音还是补静音。
    //
    // 并发探测：每次探测要拉起一个 ffmpeg 进程（约 30-80ms），
    // 串行跑 170 个素材就是十几秒的纯等待，而且这段**没有进度反馈**，
    // 用户看到的是进度条卡在 15% 不动。并发上限与素材下载一致（4）。
    const audioMap = new Map<string, boolean>();
    {
      const media = plan.media;
      let probed = 0;
      const PROBE_CONCURRENCY = 4;
      for (let i = 0; i < media.length; i += PROBE_CONCURRENCY) {
        if (signal?.aborted) throw new Aborted();
        const batch = media.slice(i, i + PROBE_CONCURRENCY);
        await Promise.all(batch.map(async (m) => {
          audioMap.set(m.id, await probeHasAudio(paths.get(m.id) ?? ""));
          probed++;
        }));
        report({ pct: 15 + Math.round((probed / Math.max(media.length, 1)) * 3),
                 stage: `检查素材音轨 ${probed}/${media.length}` });
      }
    }

    const ctx = {
      plan, caps, encoder,
      crf: plan.output.crf,
      localPath: (id: string) => {
        const p = paths.get(id);
        if (!p) throw new Error(`素材未缓存: ${id}`);
        return p;
      },
      hasAudio: (id: string) => audioMap.get(id) ?? true,
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
      const { args } = compileSegment(segs[i], ctx, out);
      await runFfmpeg(args, signal);
      segFiles.push(out);
      report({
        pct: 18 + Math.round(((i + 1) / segs.length) * 67),
        stage: `渲染片段 ${i + 1}/${segs.length}`,
        segment: { done: i + 1, total: segs.length },
      });
    }

    // 3) concat（85-92%）——各段编码参数一致，-c copy 安全
    report({ pct: 85, stage: "拼接片段" });
    const listPath = await join(work, "list.txt");
    await writeTextFile(listPath,
      segFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n") + "\n");
    let final = await join(work, "merged.mp4");
    await runFfmpeg(
      compileConcat(listPath, final, plan.output.withAudio), signal);

    // 3.5) 混入音频轨（旁白 / 配乐 / 镜头原声）
    //
    // 分段渲染只处理视频轨（buildSegments 按 kind==="video" 过滤），
    // 音频轨必须在这里单独混一次——否则成片里没有旁白也没有配乐。
    // 对"镜头原声"尤其关键：normalize.ts 已把被剥离的镜头视频静音，
    // 这一步不做的话那些镜头会彻底没声音。
    if (plan.output.withAudio) {
      const audioClips = plan.tracks
        .filter((t) => t.kind === "audio" && !t.muted)
        .flatMap((t) => t.clips)
        .map((c) => ({
          path: paths.get(c.mediaId) ?? "",
          startSec: c.timelineStartSec,
          volume: c.audio.volume,
          muted: c.audio.muted,
        }))
        .filter((c) => c.path);
      const mixArgs = audioClips.length
        ? compileAudioMix(final, audioClips, await join(work, "mixed.mp4"))
        : null;
      if (mixArgs) {
        report({ pct: 90, stage: `混音 ${audioClips.length} 段` });
        await runFfmpeg(mixArgs, signal);
        final = await join(work, "mixed.mp4");
      }
    }

    // 4) 烧字幕（92-97%）——放最后，避免每段各烧一次导致时间码错位
    if (opts.burnSrt?.trim()) {
      if (!hasFilter(caps, "subtitles")) {
        // 能力不足时跳过而不是失败：没字幕的成片仍然可用
        report({ pct: 92, stage: "当前 ffmpeg 不支持字幕烧录，已跳过" });
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
          fontsDir = await resolveResource("resources/fonts").catch(() => null);
        }
        await runFfmpeg(
          compileBurnSubtitles(final, srt, burned, encoder, plan.output.crf,
                               opts.subtitleStyle, plan.output.height, fontsDir),
          signal);
        final = burned;
      }
    }

    // 5) 另存（97-100%）
    report({ pct: 97, stage: "保存文件" });
    const dest = opts.outputPath;
    // 走 Rust 侧的 export_copy_file 而不是 fs 插件的 copyFile：
    // fs 插件受 capabilities scope 限制（只允许 $APPDATA 等预声明目录），
    // 而这里的 dest 来自系统保存对话框，用户可能选任意盘符，无法事先枚举。
    // 此前导出"闪一下就没反应"正是 copyFile 被 scope 拦下所致。
    await invoke("export_copy_file", { src: final, dst: dest });

    // 落地校验：若拷贝写了 0 字节（磁盘满/被安全软件拦截），不能假装成功。
    const finalStat = await stat(dest).catch(() => null);
    if (!finalStat || finalStat.size === 0) {
      throw new Error(`保存失败：目标文件未写入或为空 —— 请检查目标磁盘空间和写入权限 (${dest})`);
    }

    report({ pct: 100, stage: "已导出" });

    return {
      outputPath: dest, segments: segs.length,
      estPeakMB: stats.estPeakMB, encoder, elapsedMs: Date.now() - t0,
    };
  } finally {
    // 成功/失败/取消都要清工作目录，否则几十 GB 中间文件会堆在用户盘上
    await remove(work, { recursive: true }).catch(() => {});
  }
}

export { Aborted };
