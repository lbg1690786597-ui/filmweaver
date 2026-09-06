/**
 * lib/retireFiles.ts — 中间产物「用完即删」（批次 4 / 4.3）
 *
 * ## 为什么单独一个模块
 *
 * 两条导出链路都要遵守**同一条**安全规则，而这条规则写错的代价极不对称：
 *
 *     只有当下一道已经成功产出新文件、`final` 也已经指向它之后，
 *     才删上一道的产物。
 *
 * 多删一次 = 用户**导不出片**（`merged.mp4` / `mixed.mp4` 在降级分支里
 * 就是成片，见 docs §0.5(h)）；少删一次 = 只是占点盘。所以它值得有个名字、
 * 有个单一实现、被断言钉住，而不是在两个文件里各抄一遍 `Promise.all(...)`
 * ——各抄一遍正是 4.2 刚清理掉的那种漂移。
 *
 * ## 为什么删除失败要吞掉
 *
 * 调用点都在「这一道已经成功」之后。为了一个清不掉的临时文件让整轮几十分钟的
 * 渲染报错是荒谬的（Windows 上杀毒软件短暂占用刚写完的文件很常见）。
 * 两条链路的 `finally` 都会把整个 work 目录再删一次，这里只是把**峰值**提前压下来。
 */

import { remove } from "@tauri-apps/plugin-fs";

/**
 * 分批只是为了不把上千次删除一次性全推给 Tauri 的 IPC。
 *
 * ⚠️ 它是**本地文件删除**的批大小，与生成/任务并发（MAX_CONCURRENCY 等）
 * 完全无关，不受"并发铁律"约束——调大调小只影响清理这几百毫秒。
 */
export const RETIRE_BATCH = 32;

/**
 * 删除一批已经没人再读的中间文件。永不抛错。
 *
 * @param rm 注入点：仅供 node 下的验证脚本替换：Tauri 的 fs 插件在浏览器/客户端
 *           之外跑不起来，而这条规则恰恰必须能在无 Tauri 环境里测。
 */
export async function retireFiles(
  files: string[],
  rm: (path: string) => Promise<void> = (path) => remove(path),
): Promise<void> {
  for (let i = 0; i < files.length; i += RETIRE_BATCH) {
    await Promise.all(
      files.slice(i, i + RETIRE_BATCH).map((f) => rm(f).catch(() => {})),
    );
  }
}
