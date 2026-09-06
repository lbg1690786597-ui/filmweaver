/** R2-1 本机渲染管线（契约 C8）：参数链 1:1 移植后端 media.py（spike 已验证）。
 *
 * 流程：素材缓存(fs) → 逐段归一化(可选 -ss/-t 裁剪) → concat → 可选烧字幕 → 另存。
 * ffmpeg 走 Tauri sidecar（binaries/ffmpeg），仅 Windows 打包分发。
 */
import { Command } from "@tauri-apps/plugin-shell";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { srtForceStyle } from "./subtitleStyle";
import { retireFiles } from "./retireFiles";
import { ensureCached, sweepParts } from "./mediaCache";
import type { SubtitleStyleLike } from "./subtitleStyle";

export interface RenderClip {
  url: string;          // /fw/media/... 或 http 完整地址
  inSec?: number;       // 裁剪入点（秒）
  durSec?: number;      // 裁剪时长（秒）；缺省=到结尾
}

export interface RenderOpts {
  width: number;
  height: number;
  fps: number;
  burnSrt?: string;     // srt 文本；有则烧录
  /** 字幕样式预设（TextPanel 存的那个结构）；缺省用短剧默认 */
  subtitleStyle?: SubtitleStyleLike | null;
  onProgress?: (pct: number, stage: string) => void;
}

async function runFfmpeg(args: string[]): Promise<void> {
  const cmd = Command.sidecar("binaries/ffmpeg", args);
  const out = await cmd.execute();
  if (out.code !== 0) {
    throw new Error(`ffmpeg 失败(${out.code}): ${(out.stderr || "").slice(-400)}`);
  }
}

/** ffprobe 不随包分发：用 `ffmpeg -i` 的 stderr 探测是否含音轨（C9） */
async function hasAudio(path: string): Promise<boolean> {
  const cmd = Command.sidecar("binaries/ffmpeg", ["-i", path]);
  const out = await cmd.execute();  // -i 无输出文件必返回非 0，只看 stderr
  return /Stream #\d+:\d+.*Audio/.test(out.stderr || "");
}

/**
 * 素材缓存到本地（存在即跳过）；返回本地绝对路径。
 *
 * ⚠️ 4.5 起这里**只是 `ensureCached` 的一层薄壳**，自己不再有任何命名或落地逻辑。
 * 原实现有两个此前一直没被发现的问题，都是"不报错"的那种：
 *
 * 1. **裸 basename 当缓存键** → 两个不同 URL 只要 basename 相同
 *    （`output.mp4` 在本项目里是常态），第二个直接返回第一个的文件：
 *    **经典导出会静默剪进别的镜头的画面**。
 * 2. **`writeFile(dest)` 不是原子写** → 写到一半被杀，下次 `exists(dest)` 为真，
 *    半截文件被当成完整素材喂给 ffmpeg。
 *
 * 保留这个函数名而不是让调用方直接用 `ensureCached`：它是 legacy 链路的既有
 * 导出符号，薄壳的成本是零，而少一次改动就少一处回归面。
 */
export async function cacheClip(projectId: string, url: string): Promise<string> {
  return ensureCached(projectId, url);
}

/** 本机渲染主流程；成功返回用户另存的输出路径，用户取消另存返回 null */
export async function localRender(
  projectId: string, clips: RenderClip[], opts: RenderOpts,
): Promise<string | null> {
  const report = (pct: number, stage: string) => opts.onProgress?.(pct, stage);
  const base = await appDataDir();
  const work = await join(base, "render_tmp");
  if (await exists(work)) await remove(work, { recursive: true });
  await mkdir(work, { recursive: true });

  // 4.5：两条链路写的是**同一个**缓存目录，所以残留也得两边都扫——
  // 只在 Render V2 里扫的话，只用「经典导出」的用户永远清不掉自己的 .part。
  await sweepParts(projectId);

  try {
    // 1) 缓存 + 逐段归一化（参数链与 media.py 完全一致；裁剪为 R2 新增前置 -ss/-t）
    const normFiles: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      report(Math.round((i / clips.length) * 15), "下载素材");
      const src = await cacheClip(projectId, clips[i].url);
      const dst = await join(work, `norm_${String(i).padStart(3, "0")}.mp4`);
      const vf = `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,`
        + `pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${opts.fps}`;
      const audio = await hasAudio(src);
      const args = ["-y"];
      if (clips[i].inSec) args.push("-ss", String(clips[i].inSec));
      if (clips[i].durSec) args.push("-t", String(clips[i].durSec));
      args.push("-i", src,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
        "-shortest", dst);
      await runFfmpeg(args);
      normFiles.push(dst);
      report(15 + Math.round(((i + 1) / clips.length) * 55), `归一化 ${i + 1}/${clips.length}`);
    }

    // 2) concat（各段参数一致，-c copy 安全）
    const lst = await join(work, "list.txt");
    await writeTextFile(lst, normFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n") + "\n");
    const merged = await join(work, "merged.mp4");
    // 4.2：`+faststart` 只给用户真正拿到的那个文件。
    //
    // 这条 legacy 链路此前是**每一道都加**，而上面那句 `-movflags` 还在
    // 逐 clip 的循环里 —— 1424 镜的项目就是 1424 次白做的全文件重写
    // （faststart 的实现是把 moov 挪到文件头，手段就是整个文件再读写一遍）。
    // norm_*.mp4 与（要烧字幕时的）merged.mp4 都只是下一道 ffmpeg 的输入，
    // 而 ffmpeg 读本地文件根本不在乎 moov 在哪。
    //
    // 与 render/renderer.ts 的判据同构，但这里简单得多：legacy 不探测
    // capabilities，有 srt 就一定会烧，所以不存在「以为要烧、结果跳过了」
    // 那种降级分支。
    // 判据用「字幕文本本身」而不是一个 boolean：boolean 会让 tsc 丢掉对
    // opts.burnSrt 的收窄，下面 writeTextFile 就得补一个非空断言。
    const srtText = opts.burnSrt?.trim() ? opts.burnSrt : null;
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", lst,
      "-fflags", "+genpts", "-c", "copy",
      ...(srtText ? [] : ["-movflags", "+faststart"]), merged]);
    report(80, "拼接完成");

    // 4.3：归一化产物用完即删。规则与 render/renderer.ts 同构——
    // **下一道成功产出之后，才删上一道**，所以被删的那个必然不是成片。
    // 这里 concat 已经出了 merged.mp4，norm_*.mp4 就没人再读了；
    // 它们是全分辨率重编码产物，峰值上占的正是成片那么大的一份。
    // 删除失败一律吞掉（导出此时已经成功），finally 还会整目录再删一次。
    await retireFiles(normFiles);

    // 3) 可选烧字幕
    let final = merged;
    if (srtText) {
      const srt = await join(work, "subs.srt");
      await writeTextFile(srt, srtText);
      final = await join(work, "final.mp4");
      // Windows 路径给 subtitles 滤镜需转义盘符冒号
      // replace(":") 不带 /g 只换第一个冒号；盘符之外若再出现冒号就漏了
      const srtEsc = srt.replace(/\\/g, "/").replace(/:/g, "\\:");
      await runFfmpeg(["-y", "-i", merged,
        "-vf", `subtitles='${srtEsc}':force_style='${srtForceStyle(opts.subtitleStyle, opts.height)}'`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "copy", "-movflags", "+faststart", final]);
      // final.mp4 已经出来了，merged.mp4 就此变成纯中间产物（4.3）。
      // ⚠️ 这一句必须留在 if (srtText) 块**内部**：没字幕时 merged 就是成片。
      await retireFiles([merged]);
    }
    report(95, "渲染完成");

    // 4) 用户另存
    const dest = await save({
      defaultPath: `film_${Date.now()}.mp4`,
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
    });
    if (!dest) return null;
    // 同 render/renderer.ts：fs 插件的 copyFile 受 capabilities scope 限制，
    // 存不到用户在保存框里选的任意路径，改走 Rust 侧命令。
    await invoke("export_copy_file", { src: final, dst: dest });
    report(100, "已导出");
    return dest;
  } finally {
    await remove(work, { recursive: true }).catch(() => {});
  }
}
