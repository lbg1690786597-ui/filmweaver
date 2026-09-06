/**
 * features/subtitles/probeSilence.ts — 本机停顿检测
 *
 * 用 Tauri sidecar 的 ffmpeg 跑一遍 `silencedetect`，把停顿位置读出来。
 * **零网络、零模型、零费用**——这是"字幕对齐尽量在用户本地完成"的关键一步。
 *
 * `-f null -` 表示不写任何输出文件，只让滤镜跑一遍；结果打在 stderr 上。
 * 用 `.execute()` 而不是 renderer.ts 里的 runFfmpeg：后者只在**失败**时
 * 保留 stderr，而我们要的恰恰是成功时的 stderr。
 *
 * ## 6.3：这里曾经是**第四套**素材缓存实现，已删除
 *
 * 原先本文件自带一个 `cacheAudio`，把旁白下到 `cache/<projectId>/audio/` 下，
 * 文件名取 **裸 basename**（`url.split("/").pop()`）。那正是 4.5 从
 * `localRender.ts` 里挖掉的那套命名，连 bug 都是同一个：
 *
 * · **裸 basename 会静默取到错的音频。** 复用判据是"同名文件已存在就直接用"，
 *   而后端按镜头目录组织，`narration.mp3` / `output.mp3` 这类重名是常态。
 *   两条不同旁白只要 basename 相同，第二次对齐就会拿第一条的停顿位置去排字幕 ——
 *   不报错、不下载，字幕**整段对错地方**。
 * · **写入不是原子的**（直接 `writeFile(dest)`）：写到一半被杀，下次
 *   `exists(dest)` 为真、直接返回半截文件，ffmpeg 读出来的停顿是残缺的。
 * · **不校验空文件**：磁盘满写出的 0 字节文件同样会被当成"已缓存"。
 * · 那个 `audio/` 子目录还是个**统计盲区**：`localCacheStats` 只数目录下的
 *   直接文件（`if (!f.isFile) continue`），所以这些字节在设置页的"本机缓存"
 *   数字里根本不出现，清理按钮倒是会连它一起删——用户看到的数字和删掉的量对不上。
 *
 * 现在直接用 `ensureCached`（6.1 的那一份）：同一套 URL 哈希命名、同一套
 * `.part` → rename 原子落地、同一个单飞。**顺带的好处**：旁白从此和其他素材
 * 共用一份缓存，6.2 的预取一落盘，第一次点"生成字幕"就是零下载。
 */

import { Command } from "@tauri-apps/plugin-shell";
import { ensureCached } from "../../lib/mediaCache";
import { parseSilence, type Silence } from "./align";

/** 静音判定阈值。-32dB / 0.18s 是对实际 TTS 产物调出来的：
 *  更严（如 -40dB）会漏掉带底噪的停顿，更松（如 -25dB）会把气口也算进去。
 *  实测 34.66s 旁白得 21 段静音，几乎覆盖每一处句读。 */
export const NOISE_DB = -32;
export const MIN_SILENCE_SEC = 0.18;

/**
 * 探测一段音频里的停顿。
 *
 * 探测失败**返回空数组而不是抛错**：拿不到停顿只是让对齐退化成纯字符比例
 * 分配（实测误差 < 5%），不该让整个"生成字幕"操作失败。
 */
export async function probeSilence(url: string, projectId: string): Promise<Silence[]> {
  let path: string;
  try {
    // 6.3：走 6.1 的统一落地实现（URL 哈希命名 / 原子落地 / 单飞），
    // 不再自己下一份。已被 6.2 预取过的旁白在这里是零网络。
    path = await ensureCached(projectId, url);
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
