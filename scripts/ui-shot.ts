/**
 * ui-shot.ts — 前端视觉自查（Playwright）
 *
 * ## 为什么需要
 *
 * 类型检查和 CSS 覆盖脚本能证明"代码自洽"，但证明不了"界面对"。
 * 实际踩过的坑：资产图明明生成好了、库里也有，轨道上就是不显示——
 * 静态检查全绿，因为 bug 在一个 useEffect 的依赖条件里。
 * 这类问题只有真跑起来看才发现得了。
 *
 * ## 用法
 *
 *   npx tsx scripts/ui-shot.ts                    # 默认截首屏
 *   npx tsx scripts/ui-shot.ts --url http://...   # 指定地址
 *   npx tsx scripts/ui-shot.ts --click ".btn"     # 截图前先点某个元素
 *   npx tsx scripts/ui-shot.ts --out /tmp/a.png
 *
 * 默认打预览地址（已发布的构建产物），不需要另起 dev server。
 *
 * ## 输出
 *
 * 除截图外还会报告**控制台错误与失败请求**——这两样静态检查完全看不到，
 * 而它们往往才是"界面看着对、功能是坏的"的根源。
 */

import { chromium } from "playwright";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const URL = arg("url", "http://127.0.0.1:9080/fw/app/");
const OUT = arg("out", "/tmp/fw-ui.png");
const CLICK = arg("click", "");
const WAIT = Number(arg("wait", "2500"));
const W = Number(arg("w", "1440"));
const H = Number(arg("h", "900"));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });

// 收集控制台错误与失败请求：界面渲染正常但功能坏掉时，线索都在这里
const errors: string[] = [];
const failed: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${String(e).slice(0, 200)}`));
page.on("requestfailed", (r) => {
  failed.push(`${r.method()} ${r.url().slice(0, 90)} — ${r.failure()?.errorText ?? ""}`);
});
page.on("response", (r) => {
  if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`);
});

console.log(`打开 ${URL}`);
await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(WAIT);

if (CLICK) {
  const el = page.locator(CLICK).first();
  if (await el.count()) {
    await el.click();
    await page.waitForTimeout(1200);
    console.log(`已点击 ${CLICK}`);
  } else {
    console.log(`⚠️ 没找到 ${CLICK}（选择器不对，或该元素当前不该出现）`);
  }
}

await page.screenshot({ path: OUT, fullPage: false });
console.log(`截图 → ${OUT}`);

// 报告运行时问题。不 exit 1——很多控制台错误来自第三方或无害的
// 资源 404，一律拦下来会让人开始无视这个脚本。
if (errors.length) {
  console.log(`\n控制台错误 ${errors.length} 条：`);
  for (const e of [...new Set(errors)].slice(0, 8)) console.log(`  ✗ ${e}`);
}
if (failed.length) {
  console.log(`\n失败请求 ${failed.length} 条：`);
  for (const f of [...new Set(failed)].slice(0, 8)) console.log(`  ✗ ${f}`);
}
if (!errors.length && !failed.length) console.log("\n✅ 无控制台错误、无失败请求");

await browser.close();
