/**
 * 一次性：用真实浏览器渲染火山文档页，取出正文里关于文件大小上限与 TOS 的段落。
 * 文档站是 JS 注水的，curl 拿到的 HTML 里没有正文。
 */
import { chromium } from "playwright";

const URL = process.argv[2] || "https://www.volcengine.com/docs/82379/1895586";
const KEYS = ["2 GB", "2GB", "512", "TOS", "tos", "存储空间", "Bucket"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);

const text = await page.evaluate(() => document.body.innerText);
console.log("正文长度:", text.length);

const seen = new Set<string>();
for (const kw of KEYS) {
  let i = -1;
  let n = 0;
  while ((i = text.indexOf(kw, i + 1)) >= 0 && n < 3) {
    const seg = text.slice(Math.max(0, i - 320), i + 320).replace(/\n{2,}/g, "\n");
    const key = seg.slice(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`\n===== 命中「${kw}」=====\n${seg}`);
      n++;
    }
  }
}

// 顺便把含 curl / 参数表的代码块打出来
const blocks = await page.evaluate(() =>
  Array.from(document.querySelectorAll("pre, code"))
    .map((e) => (e as HTMLElement).innerText)
    .filter((t) => t.length > 40 && (t.includes("files") || t.includes("curl") || t.includes("tos"))));
if (blocks.length) {
  console.log("\n===== 相关代码块 =====");
  for (const b of blocks.slice(0, 4)) console.log(b.slice(0, 700) + "\n---");
}

await browser.close();
