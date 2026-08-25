/**
 * verify-export-perms.ts — 导出落盘链路的权限与调用方式校验
 *
 * ## 为什么需要
 *
 * 导出功能曾经"点了闪一下就没反应"：保存对话框弹得出来（dialog 有权限），
 * 但选完路径后 `copyFile` 被 capabilities 的 fs scope 拦下——scope 里只声明了
 * $APPDATA，而用户选的是桌面/D 盘/U 盘，无法事先枚举。
 *
 * 这类问题的特征是**只在打包后的桌面端复现**：浏览器预览走服务端导出通道，
 * 根本不碰这段代码；类型检查也看不出来（API 用法完全合法，是运行时被拒）。
 * 只能靠断言"落盘必须走 Rust 命令，不能走 fs 插件"。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
const ok = (cond: boolean, msg: string, hint = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${msg}${!cond && hint ? `\n      ${hint}` : ""}`);
};

// ---- ① 两条渲染链路都不能再用 fs 插件的 copyFile 落盘 ----
console.log("① 落盘方式（必须走 Rust 命令，绕开 fs scope）");
for (const f of ["src/render/renderer.ts", "src/lib/localRender.ts"]) {
  const s = read(f);
  const hasSave = s.includes("save({");
  if (!hasSave) continue;   // 该文件没有另存逻辑，跳过
  ok(!/await copyFile\(/.test(s),
     `${f} 未使用 fs 插件 copyFile`,
     "fs 插件受 capabilities scope 限制，存不到用户选的任意路径");
  ok(s.includes('invoke("export_copy_file"'),
     `${f} 调用了 export_copy_file`);
}

// ---- ② Rust 侧命令必须存在且已注册 ----
console.log("\n② Rust 命令定义与注册");
const rs = read("src-tauri/src/lib.rs");
ok(/#\[tauri::command\]\s*\n\s*(?:async\s+)?fn export_copy_file/.test(rs),
   "export_copy_file 已用 #[tauri::command] 标注");
ok(/generate_handler!\[[^\]]*export_copy_file/.test(rs),
   "export_copy_file 已注册进 invoke_handler",
   "只定义不注册的话，前端 invoke 会报 command not found");

// ---- ③ 保存对话框权限 ----
console.log("\n③ capabilities 权限");
const caps = JSON.parse(read("src-tauri/capabilities/default.json"));
const perms: string[] = caps.permissions.map((p: unknown) =>
  typeof p === "string" ? p : (p as { identifier: string }).identifier);
ok(perms.includes("dialog:default"), "dialog:default 已声明（保存对话框需要）");
ok(perms.includes("shell:allow-execute"), "shell:allow-execute 已声明（ffmpeg sidecar 需要）");

// ---- ④ sidecar 配置 ----
console.log("\n④ ffmpeg sidecar");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const bins: string[] = conf.bundle?.externalBin ?? [];
ok(bins.includes("binaries/ffmpeg"),
   "tauri.conf.json 声明了 binaries/ffmpeg",
   "不声明的话打包产物里没有 ffmpeg，导出必然失败");

if (failed) {
  console.log(`\n❌ ${failed} 项不通过`);
  process.exit(1);
}
console.log("\n✅ 导出落盘链路检查通过");
