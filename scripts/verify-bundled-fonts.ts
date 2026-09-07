/**
 * verify-bundled-fonts.ts — 「内置字体」这条链有没有断
 *
 * ## 这一节钉的是什么
 *
 * 「内置思源黑体/宋体随包分发」这句话要成立，四处必须同时对上，而它们
 * **写在四个互不相干的文件里**：
 *
 *   1. `src-tauri/resources/fonts/.gitignore` —— 字体二进制不进 git（46MB，合理）
 *   2. `scripts/fetch-fonts.sh`               —— 出包前把它们取回来
 *   3. `.github/workflows/build-windows.yml`  —— CI 得**真的跑**上面那个脚本
 *   4. `src/render/bundledFonts.ts` + `renderer.ts` —— 运行时校验并如实告知
 *
 * 2026-09-06 之前第 3 条**根本不存在**：脚本在 CI 与 package.json 里零引用。
 * 于是打出的安装包里 `resources/fonts/` 只有 README + LICENSE，而
 * `resolveResource` 只拼路径不校验存在 → `fontsdir` 照传 → libass 找不到
 * Noto 就静默换成系统默认字形。**用户选了「思源黑体（内置）」，导出成功，
 * 字幕却是别的字体，全程没有一条提示。**
 *
 * 这类错误没有任何运行时症状（在装了思源黑体的开发机上更是永远看不出来），
 * 只能靠交叉钉死。外加 `checkBundledFonts` 的纯逻辑单测——它是运行时那道
 * 兜底的全部，判错了就等于没兜。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_FONT_FILES, MIN_FONT_BYTES, checkBundledFonts, bundledFontsWarning,
} from "../src/render/bundledFonts";
import { BUNDLED_FONTS } from "../src/features/subtitles/fonts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
const ok = (cond: boolean, msg: string, hint = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${msg}${!cond && hint ? `\n      ${hint}` : ""}`);
};

const sh = read("scripts/fetch-fonts.sh");
const wf = read(".github/workflows/build-windows.yml");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));

// ---- ① 出包链：CI 必须真的取字体，且失败要挡住发布 ----
console.log("① 出包链（这一环缺了就是空壳包）");
ok(/fetch-fonts\.sh/.test(wf), "CI 里引用了 scripts/fetch-fonts.sh",
   "没有这一步 = clone 里没有 .ttc = 安装包里没有内置字体");
// 顺序很重要：取字体必须排在 tauri-action 打包**之前**，否则等于没取。
// ⚠️ 定位用的是 `run:` 那一行而不是 "fetch-fonts.sh" 的首次出现——后者会命中
// 上方那段注释，于是"这一步"会被划到**前一个** step（它带 continue-on-error）上去。
const iRun = wf.search(/^\s*run:\s*bash scripts\/fetch-fonts\.sh\s*$/m);
const iBuild = wf.indexOf("tauri-apps/tauri-action");
ok(iRun > 0 && iBuild > 0 && iRun < iBuild, "取字体排在 tauri-action 之前",
   `run@${iRun} build@${iBuild}`);
// continue-on-error 会让"取不到字体"变成一条黄色警告，正是我们要杜绝的那种静默。
// 步骤边界 = 上一个 `- name:` 到下一个 `- name:`。
const stepStart = wf.lastIndexOf("- name:", iRun);
const nextName = wf.indexOf("- name:", iRun);
const fetchStep = wf.slice(stepStart, nextName > 0 ? nextName : iBuild);
ok(!/continue-on-error:\s*true/.test(fetchStep),
   "取字体这一步没有 continue-on-error（失败必须挡住发布）", fetchStep);
// 体积下限两处各写一份（bash 里一个、TS 里一个），漂移了就会出现
// 「脚本放过、运行时判缺」或反过来的矛盾结论，所以逐字钉住。
const shMin = /MIN_BYTES=(\d+)/.exec(sh)?.[1];
ok(shMin === String(MIN_FONT_BYTES),
   `fetch-fonts.sh 的体积下限 == MIN_FONT_BYTES(${MIN_FONT_BYTES})`, `sh=${shMin}`);
ok(/exit 1/.test(sh), "fetch-fonts.sh 断言失败时以 exit 1 中止",
   "只下载不校验的话，弱网下的半截文件会被原样打进包里");

// ---- ② 三处文件名/家族名必须逐字一致 ----
console.log("\n② 家族名与文件名（四处写在四个文件里）");
const files = Object.values(BUNDLED_FONT_FILES);
for (const f of files) {
  ok(sh.includes(f), `fetch-fonts.sh 取了 ${f}`);
}
ok(files.every((f) => sh.includes(f)) && files.length === 2, "两个 .ttc 都在取回清单里");
const uiNames = BUNDLED_FONTS.map((f) => f.name).sort();
const mapNames = Object.keys(BUNDLED_FONT_FILES).sort();
ok(JSON.stringify(uiNames) === JSON.stringify(mapNames),
   "字体选择器列出的家族名 == bundledFonts.ts 的映射键",
   `UI=${JSON.stringify(uiNames)} MAP=${JSON.stringify(mapNames)}`);
ok(BUNDLED_FONTS.every((f) => f.source === "bundled"),
   "选择器里这几款都标着 source=bundled（否则不会传 fontsdir）");
// 打包配置得真把这个目录带上，否则前面全白做
const res: string[] = conf.bundle?.resources ?? [];
ok(res.some((r) => r.replace(/\\/g, "/").includes("resources/fonts")),
   "tauri.conf.json 的 bundle.resources 含 resources/fonts",
   JSON.stringify(res));
// 运行时解析的相对路径必须与打包路径一致
ok(read("src/render/renderer.ts").includes('resolveResource("resources/fonts")'),
   "renderer 解析的是同一个 resources/fonts");

// ---- ③ 运行时兜底的纯逻辑（它判错就等于没兜） ----
console.log("\n③ checkBundledFonts（注入判定，node 下可跑）");
const present = (set: string[]) => async (p: string) =>
  set.some((f) => p.endsWith(f));

let c = await checkBundledFonts("/app/resources/fonts", present(files));
ok(c.fontsDir === "/app/resources/fonts" && c.missing.length === 0,
   "两个字体都在 → 传 fontsdir，无告警");
ok(bundledFontsWarning(c) === null, "全在时不打扰用户");

c = await checkBundledFonts("/app/resources/fonts", present([]));
ok(c.fontsDir === null && c.missing.length === 2,
   "一个都没有 → fontsDir=null（不传一个空目录假装内置生效了）");
ok((bundledFontsWarning(c) ?? "").includes("改用系统字体"), "全缺时明确告诉用户改用了系统字体",
   String(bundledFontsWarning(c)));

c = await checkBundledFonts("/app/resources/fonts", present([files[0]]));
ok(c.fontsDir === "/app/resources/fonts" && c.missing.length === 1,
   "只缺一个 → 仍传目录（在的那款还能用），但列出缺的那个");
ok((bundledFontsWarning(c) ?? "").includes(files[1]), "告警里点名缺的是哪一个",
   String(bundledFontsWarning(c)));

c = await checkBundledFonts(null, present(files));
ok(c.fontsDir === null && c.missing.length === 2, "连目录都解析不出来 → 同样按全缺处理");

// exists 抛错（权限/插件未授权）不能把整个导出带崩——这是最后一道
c = await checkBundledFonts("/app/resources/fonts",
  async () => { throw new Error("fs scope denied"); });
ok(c.fontsDir === null && c.missing.length === 2,
   "判定抛错时按不可用处理，不冒泡打断导出");

// 0 字节占位文件必须判成"没有"——它是唯一能骗过 exists() 的失败形态
c = await checkBundledFonts("/app/resources/fonts", async () => false);
ok(c.fontsDir === null, "残缺/空文件与缺失同等处理");

// Windows 路径：resolveResource 给的是反斜杠，拼错了就永远判成"不存在"
const seen: string[] = [];
await checkBundledFonts("C:\\Program Files\\FilmWeaver\\resources\\fonts",
  async (p) => { seen.push(p); return true; });
ok(seen.every((p) => p.startsWith("C:\\Program Files\\FilmWeaver\\resources\\fonts\\")),
   "Windows 路径用反斜杠拼接", seen.join(" | "));

// ---- ④ renderer 真的用上了它（不是写完摆着） ----
console.log("\n④ renderer 接线");
const r = read("src/render/renderer.ts");
ok(/checkBundledFonts\(dir, async/.test(r), "renderer 调用 checkBundledFonts");
ok(/size >= MIN_FONT_BYTES/.test(r),
   "renderer 传的判据是「存在且够大」（只判存在会放过 0 字节占位文件）");
ok(/bundledFontsWarning\(check\)/.test(r) && /report\(\{ pct: 92, stage: warn \}\)/.test(r),
   "缺字体时用户看得见（report 到进度条），不是只写进控制台");
ok(/fontsDir = check\.fontsDir/.test(r),
   "fontsdir 取校验后的值（而不是 resolveResource 的原始返回）");

console.log(failed ? `\n❌ ${failed} 项失败` : "\n✅ 内置字体链路全绿");
process.exit(failed ? 1 : 0);
