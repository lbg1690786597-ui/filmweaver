/**
 * verify-resolutions.ts — 分辨率档位完整性校验
 *
 * ## 为什么需要
 *
 * 后端 RESOLUTION_TIERS 是 480p/720p/1080p/2k 四档，前端 RESOLUTIONS 表
 * 必须每种画幅都覆盖到——少列一档，用户就永远选不到它。
 *
 * 实际发生过：**480p 整个缺失**（6 种画幅一个都没有）。它是最便宜的档位、
 * 试片正需要，用户点开「本次参数」只看到 2-3 个选项。
 * 类型检查发现不了这种"数据表不全"，只能靠断言。
 *
 * ## 顺带校验编码器友好性
 *
 * H.264 要求宽高为 2 的倍数，部分硬件编码器要 16 的倍数。
 * 按比例硬算会出 1088×1451 这种尺寸，编码时报错或静默降级。
 */

import { RESOLUTIONS, ASPECTS, resListOf } from "../src/lib/resolutions";

const TIERS = ["480p", "720p", "1080p", "2k"] as const;

let failed = 0;
const fail = (msg: string) => { failed++; console.log(`  ❌ ${msg}`); };

console.log("① 每种画幅是否覆盖全部四档");
for (const aspect of ASPECTS) {
  const list = RESOLUTIONS[aspect];
  const tiers = new Set(list.map((r) => r.tier));
  const missing = TIERS.filter((t) => !tiers.has(t));
  if (missing.length) {
    fail(`${aspect} 缺档: ${missing.join(", ")}`);
  } else {
    console.log(`  ✅ ${aspect.padEnd(6)} ${list.length} 档齐全`);
  }
}

console.log("\n② 宽高比是否与声明的画幅相符（容差 3%）");
for (const aspect of ASPECTS) {
  const [aw, ah] = aspect.split(":").map(Number);
  const want = aw / ah;
  for (const r of RESOLUTIONS[aspect]) {
    const got = r.w / r.h;
    const dev = Math.abs(got - want) / want;
    if (dev > 0.03) {
      fail(`${aspect} ${r.w}×${r.h} 实际比例 ${got.toFixed(3)}，期望 ${want.toFixed(3)}（偏差 ${(dev * 100).toFixed(1)}%）`);
    }
  }
}
if (!failed) console.log("  ✅ 全部符合");

console.log("\n③ 编码器友好性（宽高须为 2 的倍数）");
let odd = 0;
for (const aspect of ASPECTS) {
  for (const r of RESOLUTIONS[aspect]) {
    if (r.w % 2 || r.h % 2) { fail(`${aspect} ${r.w}×${r.h} 含奇数边`); odd++; }
  }
}
if (!odd) console.log("  ✅ 全部为偶数边");

console.log("\n④ 推荐档（首项）应为 1080p");
for (const aspect of ASPECTS) {
  const first = RESOLUTIONS[aspect][0];
  if (first.tier !== "1080p") {
    fail(`${aspect} 首项是 ${first.tier}，应为 1080p（用户默认选中它）`);
  }
}
if (!failed) console.log("  ✅ 全部正确");

console.log("\n⑤ 未知画幅回退");
const fb = resListOf("99:1");
console.log(`  ${fb === RESOLUTIONS["9:16"] ? "✅" : "❌"} 未知画幅回退到 9:16`);
if (fb !== RESOLUTIONS["9:16"]) failed++;

if (failed) {
  console.log(`\n❌ ${failed} 项不通过`);
  process.exit(1);
}
console.log(`\n✅ ${ASPECTS.length} 种画幅 × 4 档全部通过`);
