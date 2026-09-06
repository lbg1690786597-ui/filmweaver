/**
 * lib/cacheName.ts — 本机素材缓存的**命名规则**（纯函数，无任何 I/O 依赖）
 *
 * ## 为什么它不和 `mediaCache.ts` 待在一起
 *
 * 4.5 修的核心是一个**正确性** bug：`localRender.ts` 用**裸 basename** 当缓存键，
 * 于是两个不同 URL 只要 basename 相同（`output.mp4` 在本项目里是常态），
 * 第二个就会静默拿到第一个的画面。修法是把命名收成一份纯函数，两条链路都走它。
 *
 * 「一份纯函数」只有在**能被断言**时才算数。而 `mediaCache.ts` 必须
 * `import { api }`（`mediaUrl` 要剥 `/fw` 前缀再拼 BASE，那段逻辑不该抄第二份），
 * `api.ts` 顶层又是 `import.meta.env.VITE_FW_API_BASE` ——
 * **node 下 import 它当场抛 TypeError**，验证脚本连模块都加载不了。
 *
 * 所以命名规则单独一个文件：`verify-mediacache.ts` 直接 import 真函数来断言，
 * 而不是在脚本里照着源码"再实现一遍"——那种断言只能证明我抄得对，
 * 证明不了产品里跑的是什么。
 */

import { fnv1a } from "./fnv1a";

/** 缓存根目录名（`appDataDir()/cache`）。与 4.1 的能力缓存同一个目录。 */
export const CACHE_ROOT = "cache";

/**
 * 能力探测缓存（4.1）的文件名。它就躺在 `cache/` 根下、不在任何项目子目录里，
 * 所以**统计与清理都必须显式绕开它**：
 * 它只有 ~1 KB，而删掉的代价是下次冷启动白等 1.2~4s 重探一遍硬件编码器。
 */
export const CAPS_CACHE_NAME = "capabilities.json";

/**
 * 音轨探测结果表（6.4）的文件名。与 `CAPS_CACHE_NAME` 同样躺在 `cache/` 根下，
 * 因此同样被统计与清理自动绕开（`localCacheStats`/`clearLocalCache` 只遍历
 * 根下的**目录**）——这是刻意的：
 *
 * · 表里每条的键是 `${cacheFileName(url)}:${字节数}`，即**内容寻址**。
 *   用户清掉素材缓存后重新下载，只要文件还是同一个，旧结论仍然有效，
 *   不该被一起清掉（清掉的代价是导出前白等 N×30ms 重探一遍）。
 * · 反过来，素材换了内容（字节数变了）键就不同，绝不会拿旧结论套新文件。
 */
export const AUDIO_PROBE_CACHE_NAME = "audioprobe.json";

/** basename 后缀保留的最大字符数，见 `cacheFileName`。 */
export const NAME_TAIL_MAX = 64;

/**
 * 素材在缓存目录里的文件名。**两条导出链路唯一的命名来源。**
 *
 * 形如 `1f3a9c02_shot_007.mp4`。两段各有各的用处：
 *
 * · **哈希前缀**决定身份。取的是**去掉 query 之后的完整 URL**：
 *   - 必须是**完整** URL 而不是"末尾 64 个字符"。后端的素材路径形如
 *     `/fw/media/<projectId>/<shotId>/output.mp4`，区分度恰恰在**前面**的
 *     id 段；只取末尾若干字符时，路径较长的两个素材可能末尾完全相同，
 *     于是撞成同一份缓存——那就是把刚修掉的 bug 换个写法重新引入。
 *   - 必须**去掉** query：外部对象存储的直链带签名参数，每次拿到的都不一样，
 *     把它算进哈希会让缓存**永远命中不了**（每次下载都是个新名字），
 *     那比不缓存还糟——盘还在涨。
 * · **basename 后缀**主要为人眼服务（去 AppData 里翻的时候能认出是哪个）。
 *   非法字符换成 `_`，并截到 64 字符：Windows 的单段路径上限 255，
 *   而 `projectId` 目录本身也占位置。
 *   ⚠️ **但它顺带承担了一件正确性职责**：`slice(-64)` 是从**尾部**截的，
 *   所以扩展名一定活着。6.4 起 LUT 文件也走这套缓存，而 ffmpeg 的 `lut3d`
 *   **按扩展名分派解析器**（`.cube` 与 `.3dl`/`.dat` 格式完全不同）——
 *   实测同一份字节存成无扩展名的文件，`lut3d` 直接
 *   `Invalid data found when processing input`。
 *   若哪天把截取改成从头截（`slice(0, 64)`），LUT 导出会当场全挂。
 */
export function cacheFileName(url: string): string {
  const clean = url.split("?")[0];
  const base = (clean.split("/").pop() || "media").replace(/[^\w.\-]/g, "_");
  return `${fnv1a(clean)}_${base.slice(-NAME_TAIL_MAX)}`;
}
