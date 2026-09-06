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
 *
 * ## ③c 是后加的，管的是另一件事：**授权面有没有被改宽**
 *
 * 前面几节问的是"权限够不够用"（不够就静默失灵）。③c 反过来问"权限是不是给多了"，
 * 因为批次 6 的批次级验收第 4 条「fs scope：确认无法访问素材根之外的路径」
 * 在此之前**一条断言都没有** —— 唯一写下这件事的地方是 `lib/localRoot.ts:22`
 * 的一句注释，而注释不会变红。
 *
 * ⚠️ 它**不证明**越权读不到（那是 Rust 侧插件的裁决，前端断言不了），
 * 只证明**这个仓里能看到的授权面没被人动过**。两者别混为一谈，
 * 具体哪几句测不了、欠什么实测，记在 ③c 末尾。
 */

import { readFileSync, readdirSync } from "node:fs";
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

// ---- ③c fs 的**静态授权面**：没有人偷偷放宽过 ----
//
// 批次 6 的批次级验收第 4 条是「fs scope：确认无法访问素材根之外的路径」。
// 查下来这一条在此之前**一条断言都没有**：`verify-localroot.ts` 的文件头
// 明说「本脚本不验证安全性」（它验的是挑对根、话说得对不对），而
// `lib/localRoot.ts:22` 那句「capabilities 里 fs 的静态 scope 至今仍只有
// `$APPDATA/**`，6.6 一个字都没加」是**散文**——写在注释里，没人核对。
// 谁往 capabilities 里加一行 `$HOME/**`，全套脚本照样全绿。
//
// 所以这一节钉的不是"越权能不能发生"（那由 Rust 侧的插件裁决，前端断言不了），
// 而是**授权面有没有被改宽**——这是本仓能验、且一旦变了必须有人过目的那部分。
console.log("\n③c fs 静态 scope（批次 6 验收第 4 条）");

interface CapEntry { identifier: string; allow?: Array<{ path?: string }> }
const capObjs: CapEntry[] = caps.permissions.filter(
  (p: unknown): p is CapEntry => typeof p === "object" && p !== null);

// 带路径授权的 fs 条目：逐条列出它到底放开了哪些路径。
const fsGrants = capObjs
  .filter((p) => p.identifier.startsWith("fs:"))
  .flatMap((p) => (p.allow ?? []).map((a) => ({ id: p.identifier, path: a.path ?? "" })));

ok(fsGrants.length > 0 && fsGrants.every((g) => g.path === "$APPDATA/**"),
   "★ fs 的每一条路径授权都恰好是 $APPDATA/**",
   `实际: ${JSON.stringify(fsGrants)}\n`
   + "      多出来的任何一条都意味着素材根之外的路径变成了可读/可写——"
   + "而这正是批次 6 验收第 4 条要拦的");
ok(fsGrants.length === 2,
   "  且只有读、写两条（多一条就说明有人加了新授权而没在这里过目）",
   `实际 ${fsGrants.length} 条: ${fsGrants.map((g) => g.id).join(", ")}`);

// 不带 `allow` 块的 fs 权限里，有一类**自带 scope**（`fs:allow-desktop-read-recursive`
// 之类的目录预设），加进来等于凭空放开一整个目录，且从 `allow` 字段上完全看不出来。
// 所以裸声明的 fs 权限必须逐个白名单化，不能只看"有没有 allow"。
const BARE_FS_OK = ["fs:default"];
const bareFs = perms.filter((p) => p.startsWith("fs:")
  && !capObjs.some((o) => o.identifier === p && o.allow));
ok(bareFs.every((p) => BARE_FS_OK.includes(p)),
   "★ 裸声明的 fs 权限仍只有 fs:default",
   `多出: ${bareFs.filter((p) => !BARE_FS_OK.includes(p)).join(", ")}\n`
   + "      `fs:allow-<目录>-read-recursive` 这类预设自带 scope，"
   + "不出现在 allow 字段里，只能靠白名单拦");

// asset protocol 一旦打开，`convertFileSrc()` 就能把本地文件喂进 <img>/<video>，
// 那是与 fs scope **并行的第二条读盘通道**。6.6 刻意没走这条路（blob 方案零配置），
// 这里钉住它没被顺手打开。
const secConf = JSON.parse(read("src-tauri/tauri.conf.json")).app?.security ?? {};
ok(secConf.assetProtocol?.enable !== true,
   "★ assetProtocol 未启用（否则多出一条绕过 fs scope 的读盘通道）",
   `实际: ${JSON.stringify(secConf.assetProtocol)}`);

// 「授权不跨重启」是 6.6 明写的特性而非缺陷（见 lib/localRoot.ts 文件头）：
// 官方的持久化方案 tauri-plugin-persisted-scope 会把"这次选了这个目录"
// 变成重启后依然有效的常驻授权，那正是风险表第 12 行要拦的安全面扩大。
// 它是 Rust 依赖，加了本机（无 cargo）根本验不了，只能靠这条挡在入口。
const cargo = read("src-tauri/Cargo.toml");
ok(!cargo.includes("persisted-scope"),
   "★ 未引入 tauri-plugin-persisted-scope（授权不跨重启是特性，不是缺陷）");

// 运行期唯一能把新路径加进 scope 的入口是 dialog 的 `open()`。
// 每多一个调用点就多一个授权入口，必须有人过目——所以这里钉的是**入口集合**，
// 不是某一处的写法（那一处的 directory/recursive 由 verify-localroot [6] 钉）。
const OPEN_SITES = ["src/App.tsx", "src/features/settings/SettingsDialog.tsx"];
const walk = (rel: string): string[] => readdirSync(join(ROOT, rel), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${rel}/${e.name}`)
    : /\.tsx?$/.test(e.name) ? [`${rel}/${e.name}`] : []));
const openSites = walk("src").filter((f) => {
  const imp = /import\s*\{([^}]*)\}\s*from\s*"@tauri-apps\/plugin-dialog"/.exec(read(f));
  return !!imp && imp[1].split(",").some((s) => s.trim().split(/\s+as\s+/)[0] === "open");
}).sort();
ok(JSON.stringify(openSites) === JSON.stringify(OPEN_SITES),
   "★ 能扩大 scope 的 dialog.open() 入口仍只有已知的两处",
   `实际: ${JSON.stringify(openSites)}\n`
   + "      新增一处就是新增一个授权入口；它该不该带 recursive、"
   + "选进来的目录会不会被当素材根，都得当场想清楚，不能顺手加");

// ⚠️ 这一节**不能**断言的部分，如实记在这里而不是假装测过：
//   · `fs:default` 具体展开成哪些权限，要靠 `src-tauri/gen/schemas/` —— 本机没有
//     cargo，那个目录不存在，所以"它有没有夹带路径授权"只能等 CI 或真机确认；
//   · 插件真的会拒掉 scope 外的 readFile，是 Rust 侧行为，前端断言不了。
//     批次 6 验收第 4 条里"真的读不到"那半句，仍欠一次桌面端实测。

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
