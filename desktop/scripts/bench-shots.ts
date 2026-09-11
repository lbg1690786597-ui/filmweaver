/**
 * bench-shots.ts — U2：镜头列表渲染成本实测（无头 chromium + flushSync 墙钟）
 *
 * ## 为什么要真跑浏览器
 *
 * U2 的判断题是"1424 张镜头卡到底要不要虚拟化"。这题只有三个数字能回答：
 * 一次全表重渲染多少毫秒、修好 memo 之后多少毫秒、首次挂载多少毫秒 + 多少 DOM 节点。
 * 静态分析给不出任何一个，而"跑一遍真项目看着卡不卡"既主观又要花生成的钱。
 *
 * 所以这里把真的 `ShotsPanel` 装进无头 chromium，用 `flushSync` 强制同步提交
 * 再量墙钟（Profiler 的计时在生产构建里恒为 0，第一次跑就踩到了）。
 * 被测体是 `scripts/bench/shotsBenchEntry.tsx`。
 *
 *   npx tsx scripts/bench-shots.ts            # 默认 1424 镜（dev 库最大项目）
 *   npx tsx scripts/bench-shots.ts --n 300
 *
 * ## 这不是 verify 脚本
 *
 * 刻意**不**接进 `verify:ui`：它要装浏览器、跑几秒，而且毫秒数在不同机器上
 * 天然会飘，拿它当门禁只会制造假红。它的产物是写进审查文档的那几个数字。
 * 行为正确性由 `scripts/verify-detail-reconcile.ts` 负责（纯函数，可门禁）。
 */

import { build } from "esbuild";
import { chromium } from "playwright";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const N = Number(arg("n", "1424"));

const out = mkdtempSync(join(tmpdir(), "fw-bench-"));
await build({
  entryPoints: ["scripts/bench/shotsBenchEntry.tsx"],
  bundle: true,
  outdir: out,
  entryNames: "bench",
  format: "iife",
  target: "chrome120",
  jsx: "automatic",
  loader: { ".css": "css" },
  // api.ts 顶层读 import.meta.env（Vite 的编译期替换），打包时得替掉，
  // 否则 iife 里 import.meta 直接是语法/运行期错误
  define: {
    "import.meta.env.VITE_FW_API_BASE": JSON.stringify("http://127.0.0.1:8002"),
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  logLevel: "warning",
});
const js = readFileSync(join(out, "bench.js"), "utf8");
let css = "";
try { css = readFileSync(join(out, "bench.css"), "utf8"); } catch { /* 没有 CSS 也能量 React 提交时长 */ }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs: string[] = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });

await page.setContent(
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>`
  + `<body><div id="root"></div><script>${js}</script></body></html>`,
);
await page.waitForFunction("!!window.__bench", null, { timeout: 15000 });

type Mount = { ms: number; nodes: number; layoutMs: number };
type Upd = { ms: number; layoutMs: number; cards: number };

const mount = await page.evaluate((n) => window.__bench.mount(n), N) as Mount;
// 每种更新量三次取中位数：单次受 GC/JIT 影响可差一倍
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const allRuns: number[] = [], oneRuns: number[] = [];
const allLay: number[] = [], oneLay: number[] = [];
for (let i = 0; i < 3; i++) {
  const a = (await page.evaluate(() => window.__bench.update("all"))) as Upd;
  allRuns.push(a.ms); allLay.push(a.layoutMs);
  const o = (await page.evaluate(() => window.__bench.update("one"))) as Upd;
  oneRuns.push(o.ms); oneLay.push(o.layoutMs);
}
const all = med(allRuns), one = med(oneRuns);
const allL = med(allLay), oneL = med(oneLay);

console.log(`\n镜头列表渲染成本（${N} 镜，无头 chromium，flushSync 墙钟，生产构建）\n`);
const r2 = (x: number) => `${x.toFixed(1)} ms`;
console.log(`  首次挂载            ${r2(mount.ms)}   （DOM 节点 ${mount.nodes}，强制布局 ${r2(mount.layoutMs)}）`);
console.log(`  全表重渲染（修复前） ${r2(all)} + 重排 ${r2(allL)} = ${r2(all + allL)}   ← 每镜都是新对象，memo 全失效`);
console.log(`  单镜变动（修复后）   ${r2(one)} + 重排 ${r2(oneL)} = ${r2(one + oneL)}   ← reconcileDetail 复用引用 + 稳定回调`);
console.log(`  收益                 ${((all + allL) / Math.max(one + oneL, 0.01)).toFixed(1)}×  （每次刷新少 ${r2(all + allL - one - oneL)}）`);
console.log(`  三次样本 all=[${allRuns.map((x) => x.toFixed(1)).join(", ")}]  one=[${oneRuns.map((x) => x.toFixed(1)).join(", ")}]`);
if (errs.length) {
  console.log(`\n⚠️ 页面报错 ${errs.length} 条（前 3 条）：`);
  for (const e of errs.slice(0, 3)) console.log(`   · ${e}`);
}
console.log("");
await browser.close();

declare global {
  interface Window { __bench: { mount(n: number): Promise<Mount>; update(m: "one" | "all"): Promise<Upd> } }
}
