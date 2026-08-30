/**
 * features/subtitles/probeSilence.ts — 本机停顿检测
 *
 * 用 Tauri sidecar 的 ffmpeg 跑一遍 `silencedetect`，把停顿位置读出来。
 * **零网络、零模型、零费用**——这是"字幕对齐尽量在用户本地完成"的关键一步。
 *
 * `-f null -` 表示不写任何输出文件，只让滤镜跑一遍；结果打在 stderr 上。
 * 用 `.execute()` 而不是 renderer.ts 里的 runFfmpeg：后者只在**失败**时
 * 保留 stderr，而我们要的恰恰是成功时的 stderr。
 */

import { Command } from "@tauri-apps/plugin-shell";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { api } from "../../api";
import { parseSilence, type Silence } from "./align";

/** 静音判定阈值。-32dB / 0.18s 是对实际 TTS 产物调出来的：
 *  更严（如 -40dB）会漏掉带底噪的停顿，更松（如 -25dB）会把气口也算进去。
 *  实测 34.66s 旁白得 21 段静音，几乎覆盖每一处句读。 */
export const NOISE_DB = -32;
export const MIN_SILENCE_SEC = 0.18;

/** 下载远端音频到本机缓存（重复对齐时直接命中，不重复下载） */
async function cacheAudio(url: string, projectId: string): Promise<string> {
  const base = await appDataDir();
  const dir = await join(base, "cache", projectId, "audio");
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  const name = url.split("/").pop()!.split("?")[0];
  const dest = await join(dir, name);
  if (!(await exists(dest))) {
    const resp = await fetch(api.mediaUrl(url));
    if (!resp.ok) throw new Error(`旁白下载失败 ${resp.status}: ${name}`);
    await writeFile(dest, new Uint8Array(await resp.arrayBuffer()));
  }
  return dest;
}

/**
 * 探测一段音频里的停顿。
 *
 * 探测失败**返回空数组而不是抛错**：拿不到停顿只是让对齐退化成纯字符比例
 * 分配（实测误差 < 5%），不该让整个"生成字幕"操作失败。
 */
export async function probeSilence(url: string, projectId: string): Promise<Silence[]> {
  let path: string;
  try {
    path = await cacheAudio(url, projectId);
  } catch (e) {
    console.warn("[probeSilence] 音频缓存失败，退化为比例分配:", e);
    return [];
  }
  try {
    const out = await Command.sidecar("binaries/ffmpeg", [
      "-hide_banner", "-nostats", "-i", path,
      "-af", `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SILENCE_SEC}`,
      "-f", "null", "-",
    ]).execute();
    return parseSilence(out.stderr || "");
  } catch (e) {
    console.warn("[probeSilence] silencedetect 失败，退化为比例分配:", e);
    return [];
  }
}
