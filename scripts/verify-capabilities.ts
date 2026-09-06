/**
 * verify-capabilities.ts — 探测清单完整性 + 真机能力核对
 *
 * ## 为什么需要这个脚本
 *
 * V2.2 加了 8 个逐帧特效，编译器里写了 `hasFilter(caps, "gblur")` 之类的判断，
 * 但 `capabilities.ts` 的 NEEDED_FILTERS 忘了同步——探测时不解析这些滤镜，
 * `hasFilter()` 就恒为 false，effectFilters() 直接不 push 对应滤镜。
 *
 * 后果是**静默失效**：用户拉了「模糊」滑块，导出的片子毫无变化，不报任何错。
 * 而 verify-effects.ts 发现不了，因为它的 mock Capabilities 直接塞了完整的
 * filters 集合，绕过了探测这一步。
 *
 * 所以这里做两件真机做不到就没意义的事：
 *   ① 静态核对：编译器查询的每个滤镜，探测清单里都必须声明
 *   ② 动态核对：本机 ffmpeg 真的有这些滤镜吗（缺哪个、哪些特效会降级）
 *
 * ③ 顺带核对 xfade 转场：UI 给了 15 种，本机到底支持几种。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HW_PAIRS, SW_CANDIDATES, qualityArgs } from "../src/render/encoderArgs";

/** ffmpeg 可执行文件：CI 里指向刚打包的 Windows sidecar 二进制，
 *  本地缺省用 PATH 上的。验证"打进安装包的那个 ffmpeg"才有意义。 */
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "render");

function ff(args: string[]): string {
  return ffRun(args).out;
}

/**
 * 带**退出码**的版本。④ 段必须用它。
 *
 * ⚠️ 只看 stderr 文本判成败会误报成功，这是 4.4 当场逮到的一次：
 * 本机 build 根本没编进 `h264_amf`，于是 `-qp_i` 成了未知选项，ffmpeg 打的是
 * 「Unrecognized option 'qp_i'. / Error splitting the argument list: Option not found」
 * ——这两句**不在**下面那条 bad 正则里，于是 amf 被打上了 ✓。
 * 判据必须与 capabilities.ts 的 encoderWorks 同口径：**先看退出码**。
 */
function ffRun(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(FFMPEG, ["-hide_banner", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : -1,
             out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

// ---- ① 静态核对：编译器查询 vs 探测清单声明 ----
const compiler = readFileSync(join(SRC, "ffmpegCompiler.ts"), "utf8");
const capsSrc = readFileSync(join(SRC, "capabilities.ts"), "utf8");

const queried = new Set(
  [...compiler.matchAll(/hasFilter\(\s*(?:ctx\.)?caps\s*,\s*"(\w+)"/g)]
    .map((m) => m[1]));
const declaredBlock = capsSrc.split("NEEDED_FILTERS = [")[1]?.split("];")[0] ?? "";
const declared = new Set(
  [...declaredBlock.matchAll(/"(\w+)"/g)].map((m) => m[1]));

const undeclared = [...queried].filter((f) => !declared.has(f)).sort();

console.log("① 探测清单完整性（编译器查询的滤镜是否都会被探测）");
if (undeclared.length) {
  console.log(`   ❌ ${undeclared.length} 个滤镜被查询却不在 NEEDED_FILTERS 里：`);
  for (const f of undeclared) console.log(`      ${f}  → hasFilter() 恒 false，功能静默失效`);
} else {
  console.log(`   ✅ 编译器查询 ${queried.size} 个滤镜，全部已声明`);
}

// ---- ② 动态核对：本机 ffmpeg 是否真有这些滤镜 ----
const haveRaw = ff(["-filters"]);
const have = new Set(
  [...haveRaw.matchAll(/^\s*[A-Z.]{3,}\s+(\w+)\s/gm)].map((m) => m[1]));

const version = (ff(["-version"]).split("\n")[0] || "").trim();
console.log(`\n② 本机 ffmpeg 能力  (${version || "未找到 ffmpeg"})`);

const missing = [...declared].filter((f) => !have.has(f)).sort();
console.log(`   声明 ${declared.size} 个 · 本机有 ${declared.size - missing.length} 个`);
if (missing.length) {
  console.log(`   ⚠️ 本机缺少：${missing.join(", ")}`);
  console.log("      （编译器会跳过对应功能，不会报错——这是设计好的降级）");
} else {
  console.log("   ✅ 全部可用");
}

// ---- ③ xfade 转场核对 ----
// UI 提供的 15 种（与 EffectsPanel 保持一致）
const UI_TRANSITIONS = [
  "fade", "fadeblack", "fadewhite", "dissolve", "wipeleft", "wiperight",
  "wipeup", "wipedown", "slideleft", "slideright", "slideup", "slidedown",
  "circleopen", "circleclose", "zoomin",
];
const trOut = ff(["-h", "filter=xfade"]);
const trHave = new Set(
  [...trOut.matchAll(/^\s{5,}(\w+)\s+-?\d+\s+\.\.[A-Z.]+\s/gm)].map((m) => m[1]));
const trMissing = UI_TRANSITIONS.filter((t) => !trHave.has(t));

console.log(`\n③ xfade 转场  (本机共 ${trHave.size} 种)`);
console.log(`   UI 提供 ${UI_TRANSITIONS.length} 种 · 本机支持 ${UI_TRANSITIONS.length - trMissing.length} 种`);
if (trMissing.length) {
  console.log(`   ⚠️ 本机不支持：${trMissing.join(", ")} → 导出时降级为硬切`);
}

// ---- ④ 编码器（实跑，不查列表）----
// `-encoders` 列出 h264_nvenc 不代表能用：没显卡驱动时实跑报
// "Cannot load libcuda.so.1"。这是本项目要分发到大量异构 Windows 机器的关键。
console.log("\n④ 编码器实跑验证");
// 4.4：清单从 encoderArgs.ts 取，且**带着真正会下发的质量参数一起实跑**——
// 与 capabilities.ts 的 encoderWorks 同一口径。这台开发机没有 GPU，所以
// 硬件那几行必然是 ✗；有意义的是「本机 build 编进了它、而且我们下发的
// 选项不会让它当场拒绝」这件事在有硬件的机器上才判得出来。
const ENCODERS = [...SW_CANDIDATES, ...HW_PAIRS.flatMap((p) => [p.h264, p.hevc])];
for (const enc of ENCODERS) {
  const qa = qualityArgs(enc, 23);
  const { code, out } = ffRun(["-f", "lavfi",
                  "-i", "testsrc=size=320x240:rate=30:duration=0.1",
                  "-c:v", enc, ...qa, "-frames:v", "1", "-f", "null", "-"]);
  // 退出码优先（见 ffRun 的注释）；正则只用来在退出码为 0 的边缘情况下补刀。
  const bad = code !== 0
    || /Cannot load|not supported|Error initializing|Unknown encoder|No such/i.test(out);
  console.log(`   ${bad ? "✗" : "✓"} ${enc}  [${qa.join(" ")}]`
    + `${bad ? "  （本机不可用，属正常——无对应硬件/驱动）" : ""}`);
}

// 只有静态核对失败才算构建级错误：它是代码 bug。
// 本机缺滤镜/编码器是环境差异，编译器有降级路径，不该让 CI 红。
if (undeclared.length) {
  console.log("\n❌ 探测清单不完整——请把上面列出的滤镜加进 NEEDED_FILTERS");
  process.exit(1);
}
console.log("\n✅ 探测清单完整");
