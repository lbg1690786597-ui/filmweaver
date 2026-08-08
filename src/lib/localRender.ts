/** R2-1 本机渲染管线（契约 C8）：参数链 1:1 移植后端 media.py（spike 已验证）。
 *
 * 流程：素材缓存(fs) → 逐段归一化(可选 -ss/-t 裁剪) → concat → 可选烧字幕 → 另存。
 * ffmpeg 走 Tauri sidecar（binaries/ffmpeg），仅 Windows 打包分发。
 */
import { Command } from "@tauri-apps/plugin-shell";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, writeFile, writeTextFile, remove, copyFile } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../api";

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

/** 素材缓存到本地（存在即跳过）；返回本地绝对路径 */
export async function cacheClip(projectId: string, url: string): Promise<string> {
  const base = await appDataDir();
  const dir = await join(base, "cache", projectId);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  const name = url.split("/").pop()!.split("?")[0];
  const dest = await join(dir, name);
  if (await exists(dest)) return dest;  // 已缓存
  const resp = await fetch(api.mediaUrl(url));
  if (!resp.ok) throw new Error(`素材下载失败 ${resp.status}: ${name}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await writeFile(dest, buf);
  return dest;
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
        "-shortest", "-movflags", "+faststart", dst);
      await runFfmpeg(args);
      normFiles.push(dst);
      report(15 + Math.round(((i + 1) / clips.length) * 55), `归一化 ${i + 1}/${clips.length}`);
    }

    // 2) concat（各段参数一致，-c copy 安全）
    const lst = await join(work, "list.txt");
    await writeTextFile(lst, normFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n") + "\n");
    const merged = await join(work, "merged.mp4");
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", lst,
      "-fflags", "+genpts", "-c", "copy", "-movflags", "+faststart", merged]);
    report(80, "拼接完成");

    // 3) 可选烧字幕
    let final = merged;
    if (opts.burnSrt?.trim()) {
      const srt = await join(work, "subs.srt");
      await writeTextFile(srt, opts.burnSrt);
      final = await join(work, "final.mp4");
      // Windows 路径给 subtitles 滤镜需转义盘符冒号
      const srtEsc = srt.replace(/\\/g, "/").replace(":", "\\:");
      await runFfmpeg(["-y", "-i", merged,
        "-vf", `subtitles='${srtEsc}':force_style='FontSize=18'`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "copy", "-movflags", "+faststart", final]);
    }
    report(95, "渲染完成");

    // 4) 用户另存
    const dest = await save({
      defaultPath: `film_${Date.now()}.mp4`,
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
    });
    if (!dest) return null;
    await copyFile(final, dest);
    report(100, "已导出");
    return dest;
  } finally {
    await remove(work, { recursive: true }).catch(() => {});
  }
}
