/**
 * lib/isTauri.ts — 「现在跑在桌面壳里吗」的唯一判据（6.2 从 ExportDialog 搬出）
 *
 * 判据本身一字未改，搬家的理由是**依赖方向**：它原来住在
 * `features/export/ExportDialog.tsx` 里，而那个文件顶上 `import "./ExportDialog.css"`。
 * 于是任何想问一句"我在不在桌面端"的非 UI 模块（6.2 的预取接线就是），
 * 都会把整个导出对话框和它的 CSS 一起拖进自己的依赖图。
 *
 * ⚠️ 这个判据是**必需**的，不是可选的加固：本机缓存那一路全部要走
 * `appDataDir()`，浏览器里根本没有这个东西，**调了必抛**。
 * 而本应用确实会在纯浏览器里跑 —— `/fw/app/` 就是这么验证部署的。
 *
 * `ExportDialog` 仍然 re-export 同名常量，所以既有的 7 个 import 一行都不用改。
 */

/** 是否运行在 Tauri 容器内（网页预览下为 false） */
export const IS_TAURI = typeof window !== "undefined"
  && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
