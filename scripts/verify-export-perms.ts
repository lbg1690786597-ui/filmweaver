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
// 覆盖确认用的存在性探测。导出位置改到对话框里当场选之后，「开始导出」不再弹
// 系统保存框，同名覆盖的确认得靠它——漏注册的话导出会静默盖掉上一版成片。
ok(/#\[tauri::command\]\s*\n\s*(?:async\s+)?fn export_paths_exist/.test(rs),
   "export_paths_exist 已用 #[tauri::command] 标注");
ok(/generate_handler!\[[^\]]*export_paths_exist/.test(rs),
   "export_paths_exist 已注册进 invoke_handler");
ok(read("src/App.tsx").includes('invoke<string[]>("export_paths_exist"'),
   "App.tsx 在开跑前做了覆盖探测");

// ---- ③ 保存对话框权限 ----
console.log("\n③ capabilities 权限");
const caps = JSON.parse(read("src-tauri/capabilities/default.json"));
const perms: string[] = caps.permissions.map((p: unknown) =>
  typeof p === "string" ? p : (p as { identifier: string }).identifier);
ok(perms.includes("dialog:default"), "dialog:default 已声明（保存对话框需要）");

// ---- ③b shell 权限必须覆盖实际用到的每种调用方式 ----
//
// 踩过的坑：capabilities 只声明了 shell:allow-execute，但 renderer 用的是
// cmd.spawn()。在 Tauri v2 里 execute 与 spawn 是**两个独立权限**——
// 能力探测走 execute（通过），真正渲染走 spawn（被拒），
// 表现为"素材下载完就毫无反应"，且不弹任何错误。
// 所以不能只检查"有没有 shell 权限"，要检查**用到的调用方式都有对应权限**。
console.log("\n③b shell 调用方式与权限匹配");
const SHELL_API: Array<{ call: string; perm: string }> = [
  { call: ".execute()", perm: "shell:allow-execute" },
  { call: ".spawn()", perm: "shell:allow-spawn" },
  { call: ".kill()", perm: "shell:allow-kill" },
];
const renderSrcs = ["src/render/renderer.ts", "src/render/capabilities.ts",
                    "src/lib/localRender.ts"]
  .map((f) => { try { return read(f); } catch { return ""; } }).join("\n");
for (const { call, perm } of SHELL_API) {
  if (!renderSrcs.includes(call)) continue;   // 没用到这种调用方式就不要求权限
  ok(perms.includes(perm),
     `用到 ${call}，已声明 ${perm}`,
     `Tauri v2 中 execute/spawn/kill 是独立权限；缺了会静默拒绝，表现为"点了没反应"`);
}

// 同一 identifier 不能既裸声明又带 scope 声明——裸的会覆盖掉 scope 限制，
// 要么放宽了权限，要么让 scope 失效，两种都不是本意。
const dupes = perms.filter((p, i) => perms.indexOf(p) !== i);
ok(dupes.length === 0, "无重复的权限 identifier",
   `重复项: ${[...new Set(dupes)].join(", ")}`);

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
