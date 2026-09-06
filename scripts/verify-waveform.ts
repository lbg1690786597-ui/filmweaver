/**
 * verify-waveform.ts — 波形的内存与渲染边界（批次 3 / 3.9）
 *
 * ## 这个脚本要防的是"波形悄悄把标签页撑爆 / 悄悄变空白"
 *
 * 两件事都**不会报错**，所以只能靠断言守：
 *
 * **① 230 MB × N 的解码。** `decodeAudioData` 产出未压缩 Float32，10 分钟立体声
 * 48kHz ≈ 230 MB，而我们只要几十 KB 的包络。旧实现还**不限并发** —— 时间轴上
 * 有多少条音频 clip 就发多少次解码（本项目验证素材是 601 段），也**不管这段
 * 在不在视野里**（时间轴不做虚拟化，601 段全在 DOM 里）。三条对策各自钉：
 * 8kHz 解码上下文、`Gate` 限并发 2、IntersectionObserver 才开始解。
 *
 * **② canvas 超宽直接变空白。** 背板宽 = `时长 × pxPerSec × dpr`，10 分钟音频
 * 在 `ZOOM_MAX=60` 下是 72000px > 65535 的单边上限；分配失败**不抛异常**，
 * canvas 就是空的，用户看到的是"一放大波形就没了"。`canvasBacking` 封顶，
 * 且封顶后**不能再 scale(dpr,dpr)**（那会把波形画到画布外面）。
 *
 * ## 顺带修掉的两个既有 bug（都在旧的取桶逻辑里）
 *
 * · `per = max(1, floor(len/buckets))` 在 `len < buckets` 时恒为 1，只覆盖前
 *   `buckets` 个采样点 —— 极短音效画出来是"左边有波形、右边一条直线"。
 * · 同一个式子在不整除时会把**尾巴整段丢掉**（len=1000999 时最后 999 点不参与）。
 *
 * 两者都是"边界用 `i*len/buckets` 还是 `i*floor(len/buckets)`"的差别，
 * ③ 段逐条钉住。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PEAK_BUCKETS_PER_SEC, PEAK_BUCKETS_MIN, PEAK_BUCKETS_MAX,
  DECODE_SAMPLE_RATE, DECODE_CONCURRENCY, PEAK_CACHE_MAX, MAX_CANVAS_PX,
  bucketsFor, computePeaks, canvasBacking, peakRange, PeakCache, Gate,
} from "../src/features/timeline/waveform";
import { ZOOM_MAX } from "../src/types/timeline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const okEq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okEq) failed++;
  console.log(`  ${okEq ? "✅" : "❌"} ${name}`);
  if (!okEq) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/* ================================================================== */
console.log("\n① bucketsFor：桶数按时长定，且不超过采样点数");

check("3 秒旁白 → 下限 256（20/s 只有 60 个，太糙）", bucketsFor(3, 24000), 256);
check("30 秒 → 600 个桶（20/s）", bucketsFor(30, 240000), 600);
check("10 分钟 BGM → 撞上限 8192（不是 12000）",
  bucketsFor(600, 600 * DECODE_SAMPLE_RATE), PEAK_BUCKETS_MAX);
// ⚠️ 这条是旧实现的真 bug：len < buckets 时桶比点还多，必然出空桶，
// 画出来是"左半边有波形、右半边一条直线"。
check("采样点比桶还少 → 桶数跟着降到采样点数（否则后半段全是空桶）",
  bucketsFor(3, 100), 100);
check("时长为 0 → 0 个桶（调用方据此画中线，而不是拿 NaN 去画）",
  bucketsFor(0, 24000), 0);
check("负时长（脏数据）→ 0", bucketsFor(-5, 24000), 0);
check("采样点为 0 → 0", bucketsFor(3, 0), 0);
ok("上限 ≥ 下限（配置本身自洽）", PEAK_BUCKETS_MAX > PEAK_BUCKETS_MIN);
ok("每秒桶数在最大缩放下仍够密",
  ZOOM_MAX / PEAK_BUCKETS_PER_SEC <= 4,
  `ZOOM_MAX=${ZOOM_MAX}px/s 下一个桶要占 ${ZOOM_MAX / PEAK_BUCKETS_PER_SEC}px，`
  + "超过 4px 波形就退化成一排色块");

/* ================================================================== */
console.log("\n② computePeaks：包络取绝对值峰值，不丢头也不丢尾");

const ramp = new Float32Array(1000);
for (let i = 0; i < 1000; i++) ramp[i] = i / 1000;
const p10 = computePeaks(ramp, 10);
// 期望值取自**输入数组本身**而不是写死字面量：Float32 的舍入不是 Float64 的舍入
// （0.099 存进 Float32Array 再读出来是 0.0989999994635582），写死一个手算的
// 小数只会钉住"我当时猜的那个舍入"，与被测逻辑无关。
check("均匀分 10 桶，每桶取的是本段最后一个（也就是最大的）那个点",
  [p10.length, p10[0], p10[9]], [10, ramp[99], ramp[999]]);
ok("单调上升的输入 → 桶也单调上升", p10.every((v, i) => i === 0 || v > p10[i - 1]));

const neg = new Float32Array([0.1, -0.9, 0.2, -0.3]);
check("取的是**绝对值**峰值（音频是双极的，只看正半轴会漏掉一半）",
  [...computePeaks(neg, 2)], [-neg[1], -neg[3]]);

// ⚠️ 旧实现 `from = i * floor(len/buckets)` 在不整除时会把尾巴整段丢掉。
const tail = new Float32Array(1009);
tail[1008] = 1;                        // 全零，只有最后一个点是 1
const pt = computePeaks(tail, 10);
ok("不整除时**尾巴不丢**：最后一个采样点仍进了最后一桶",
  pt[9] === 1,
  "旧式 from = i*floor(len/buckets) 在 len=1009/buckets=10 时最后 9 个点不参与；"
  + "误差随桶数增大而增大");
const head = new Float32Array(1009);
head[0] = 1;
check("第一个采样点进第一桶", computePeaks(head, 10)[0], 1);

check("桶数为 0 → 空数组（不是崩，也不是 [NaN]）",
  [...computePeaks(ramp, 0)], []);
check("空输入 → 全零桶，长度仍是要的桶数（调用方据此画一条平线）",
  [...computePeaks(new Float32Array(0), 3)], [0, 0, 0]);
check("桶数 = 采样点数 → 一一对应，一个不丢",
  [...computePeaks(neg, 4)], [neg[0], -neg[1], neg[2], -neg[3]]);
// 桶比点多是 bucketsFor 挡住的；万一挡漏了，这里保证不出空桶而不是崩
ok("桶比采样点还多（防守路径）→ 每桶至少取一个点，不出 0",
  [...computePeaks(neg, 8)].every((v) => v > 0));

/* ================================================================== */
console.log("\n③ canvasBacking：给背板封顶，否则整块 canvas 变空白");

check("常规尺寸：背板 = css × dpr，没撞顶", canvasBacking(300, 40, 2),
  { bw: 600, bh: 80, truncated: false });
check("dpr=1", canvasBacking(300, 40, 1), { bw: 300, bh: 40, truncated: false });
// 10 分钟音频 @ ZOOM_MAX=60 → 36000 css px，dpr=2 → 72000 背板 px
const long = canvasBacking(600 * ZOOM_MAX, 40, 2);
check("10 分钟音频在最大缩放下：背板被截到上限而不是 72000",
  [long.bw, long.truncated], [MAX_CANVAS_PX, true]);
ok("上限低于浏览器的单边硬上限 65535（且留足余量）",
  MAX_CANVAS_PX < 65535,
  "超过硬上限时分配**不抛异常**，canvas 直接是空的——"
  + "用户看到的是「一放大波形就没了」，没有任何报错可查");
ok("上限 == 峰值桶上限（背板再宽也画不出比桶更多的信息）",
  MAX_CANVAS_PX === PEAK_BUCKETS_MAX,
  "两者同值意味着背板永远够表达手上的每一个桶：一个像素不浪费、一个桶不丢");
check("宽度为 0（clip 被缩到看不见）→ 至少 1px，不是 0（0 宽 canvas 会抛）",
  canvasBacking(0, 0, 2), { bw: 2, bh: 2, truncated: false });
check("dpr 非法（0 / 负）→ 当作 1", canvasBacking(100, 20, 0),
  { bw: 100, bh: 20, truncated: false });
// ⚠️ 这条一开始写成 `long.bh === 80`，**变异测试当场证明它是装饰品**：
// 把高度也 clamp 到 8192 之后它照样绿——因为真实轨高只有几十 px，
// 离上限差三个数量级。改成直接拿一个荒谬的高度去问，才真的在钉
// 「上限只管宽度」这条规则本身，而不是钉一个碰巧没撞线的数。
check("撞顶时高度**不跟着截**（只有宽度会超，截高度会把波形压扁）",
  [long.bh, canvasBacking(100, MAX_CANVAS_PX * 3, 2).bh],
  [80, MAX_CANVAS_PX * 6]);

/* ================================================================== */
console.log("\n④ peakRange：每个背板像素列取哪几个桶");

check("桶比列多：每列覆盖多个桶（缩小时的降采样）", peakRange(100, 0, 10), [0, 10]);
check("最后一列覆盖到最后一个桶（不丢尾）", peakRange(100, 9, 10), [90, 100]);
check("列比桶多：相邻列可能落在同一个桶上（放大时的拉伸）",
  [peakRange(10, 0, 100), peakRange(10, 1, 100)], [[0, 1], [0, 1]]);
ok("任何一列的区间都非空（空区间 → max=0 → 那一列画成中线，看着像断了）",
  Array.from({ length: 100 }, (_, x) => peakRange(10, x, 100))
    .every(([a, b]) => b > a));
ok("区间不越界", Array.from({ length: 100 }, (_, x) => peakRange(37, x, 100))
  .every(([a, b]) => a >= 0 && b <= 37));
// ⚠️ 上面那条**够不到 i0 的夹持**：x < columns 时 `floor(x/columns*peakCount)`
// 天然 ≤ peakCount-1，夹持是纯防守。变异测试把夹持删掉后它照样绿，
// 说明只有喂一个越界的列号才能真正问到它。调用方是 `for (x=0; x<bw; x++)`，
// 循环边界写成 `<=` 是最常见的一种手滑，届时最后一列会拿到 `[pc, pc]`
// 这个**空且越界**的区间 —— 画出来是最右边一列突然变成中线。
check("列号越界（调用方循环写成 <=）→ 仍给一个合法且非空的区间",
  peakRange(37, 100, 100), [36, 37]);
check("没有桶 → 空区间（调用方据此画中线）", peakRange(0, 0, 10), [0, 0]);
check("没有列 → 空区间", peakRange(10, 0, 0), [0, 0]);
// 覆盖完整性：每个桶至少被某一列看到（否则波形上会有"看不见的响声"）
const seenBuckets = new Set<number>();
for (let x = 0; x < 200; x++) {
  const [a, b] = peakRange(50, x, 200);
  for (let i = a; i < b; i++) seenBuckets.add(i);
}
check("列多于桶时，每个桶都至少被一列覆盖到", seenBuckets.size, 50);
const seen2 = new Set<number>();
for (let x = 0; x < 20; x++) {
  const [a, b] = peakRange(1000, x, 20);
  for (let i = a; i < b; i++) seen2.add(i);
}
check("列少于桶时也全覆盖（峰值不会被跳过 → 不会漏掉一声爆音）",
  seen2.size, 1000);

/* ================================================================== */
console.log("\n⑤ PeakCache：定容 LRU，且**负结果也要缓存**");

const c = new PeakCache(3);
c.set("a", new Float32Array([1]));
c.set("b", new Float32Array([2]));
c.set("c", new Float32Array([3]));
check("装满不淘汰", c.keys(), ["a", "b", "c"]);
c.set("d", new Float32Array([4]));
check("超容淘汰最旧的", c.keys(), ["b", "c", "d"]);
c.get("b");
check("命中把它提到最新", c.keys(), ["c", "d", "b"]);
c.set("e", new Float32Array([5]));
check("再超容时淘汰的是「最久没被用过的」而不是最早插入的",
  c.keys(), ["d", "b", "e"]);
// ⚠️ 变异测试逮到的第三处：上面全程没有**重复 set 同一个键**，
// 于是 `set` 里那句 `this.m.delete(k)` 删掉照样绿。Map.set 对已有键
// **保留原插入位置**，不先删就等于「重写一个热条目反而不算用过它」——
// 而这恰恰会发生：同一段音频在时间轴上出现多次，排队时会重查缓存再 set。
const c3 = new PeakCache(3);
c3.set("x", new Float32Array([1]));
c3.set("y", new Float32Array([2]));
c3.set("z", new Float32Array([3]));
c3.set("x", new Float32Array([9]));      // 重写最旧的那个
c3.set("w", new Float32Array([4]));
check("重复 set 同一个键 = 用过它一次，淘汰时轮到下一个",
  c3.keys(), ["z", "x", "w"]);

// ⚠️ 这是旧实现的第二个真 bug：失败什么都不记，于是解不了的音频
// 每次重挂都重 fetch + 重解，永远失败、永远重试。
const c2 = new PeakCache(3);
c2.set("bad", null);
ok("解不出来的音频也进缓存（has=true，值为 null）",
  c2.has("bad") && c2.get("bad") === null,
  "不记的话每次重挂都重 fetch + 重解，永远失败、永远重试");
check("没见过的 key → undefined（与「见过但解不出」的 null 区分开）",
  c2.get("never"), undefined);
ok("undefined 与 null 必须可区分：前者「还没试过，去解」后者「试过了，别再试」",
  c2.get("never") === undefined && c2.get("bad") === null);
c2.clear();
check("clear 清空（切项目时调用）", [c2.size, c2.has("bad")], [0, false]);
ok("默认容量足够装下一整集的旁白且内存可控",
  PEAK_CACHE_MAX >= 200 && PEAK_CACHE_MAX * PEAK_BUCKETS_MAX * 4 < 16 * 1024 * 1024,
  `最坏 ${(PEAK_CACHE_MAX * PEAK_BUCKETS_MAX * 4 / 1024 / 1024).toFixed(1)} MB`);

/* ================================================================== */
console.log("\n⑥ Gate：解码闸门（601 段不能一起解）");

const g = new Gate(2);
const done: number[] = [];
const mk = (n: number) => g.acquire().then(() => { done.push(n); });
void mk(1); void mk(2); void mk(3); void mk(4);
await Promise.resolve();
check("同时最多 2 个在跑，其余排队", [g.inFlight, g.queued, done.length], [2, 2, 2]);
g.release();
await Promise.resolve(); await Promise.resolve();
check("放掉一个，队首顶上", [g.inFlight, g.queued, done], [2, 1, [1, 2, 3]]);
g.release(); await Promise.resolve(); await Promise.resolve();
g.release(); await Promise.resolve(); await Promise.resolve();
check("排干净", [g.inFlight, g.queued, done], [1, 0, [1, 2, 3, 4]]);
g.release();
check("最后一个放掉 → 归零", g.inFlight, 0);
g.release();
check("多放一次不会变成负数（release 放在 finally，异常路径可能重入）",
  g.inFlight, 0);
ok("并发上限是小数字：解码峰值是每段几十 MB",
  DECODE_CONCURRENCY >= 1 && DECODE_CONCURRENCY <= 4,
  "⚠️ 这是**浏览器端解码**的内存闸门，不是生成/任务并发——"
  + "后者一律由用户掌控、严禁擅自改");

/* ================================================================== */
console.log("\n⑦ 静态钉：三条省内存的措施都还在");

const wf = read("src/features/timeline/Waveform.tsx");
const mod = read("src/features/timeline/waveform.ts");
const app = read("src/App.tsx");

ok("解码上下文指定 8kHz（不指定就按设备默认 48kHz，内存 6 倍）",
  /new Ctor\(1, 1, DECODE_SAMPLE_RATE\)/.test(wf)
  && DECODE_SAMPLE_RATE <= 16000,
  "波形只看包络，8kHz 与 48kHz 肉眼无差；"
  + "10 分钟立体声 48kHz 是 230 MB，8kHz 单声道是 19 MB");
ok("用 OfflineAudioContext 而不是 AudioContext",
  /OfflineAudioContext/.test(wf) && !/new window\.AudioContext/.test(wf),
  "AudioContext 每个实例占一个硬件音频线程，且它的采样率不能自选");
ok("解码走 Gate（不是一次全发出去）",
  /await GATE\.acquire\(\)/.test(wf) && /GATE\.release\(\)/.test(wf));
ok("release 在 finally 里（解码失败也要放行，否则闸门永久关死）",
  /finally \{\s*\n\s*GATE\.release\(\);/.test(wf));
ok("进视野才开始解（时间轴不做虚拟化，601 段全在 DOM 里）",
  /new IntersectionObserver/.test(wf) && /if \(!seen\) return;/.test(wf),
  "不加这一层 = 打开项目就把整部剧的音频下载并解码一遍");
ok("没有 IntersectionObserver 的环境退化为「直接解」而不是永远不解",
  /typeof IntersectionObserver === "undefined"/.test(wf));
ok("排队期间会重查缓存（同一段音频在时间轴上会出现多次）",
  /if \(PEAK_CACHE\.has\(url\)\) return PEAK_CACHE\.get\(url\) \?\? null;/.test(wf));
ok("失败也写进缓存",
  /catch \{[\s\S]{0,300}PEAK_CACHE\.set\(url, null\);/.test(wf));
ok("同一 url 的并发请求合并成一个 promise（PENDING）",
  /const inflight = PENDING\.get\(url\);/.test(wf)
  && /PENDING\.delete\(url\)/.test(wf));

ok("背板尺寸走 canvasBacking，不再直接 width*dpr",
  /canvasBacking\(width, height, window\.devicePixelRatio \|\| 1\)/.test(wf)
  && !/cv\.width = w \* dpr/.test(wf));
// ⚠️ 撞顶后 css 与背板不再是 dpr 倍关系，scale(dpr,dpr) 会把波形画到画布外面
ok("撞顶后不再 scale(dpr,dpr)：直接在背板坐标系里画",
  !/ctx\.scale\(dpr, dpr\)/.test(wf),
  "封顶后 css/背板不是 dpr 倍关系，再 scale 就把波形画到画布外面了——"
  + "表现同样是「波形不见了」，只是原因换了一个");
ok("未解完时画中线而不是空着（空着看起来像这段没有声音）",
  /if \(!peaks \|\| peaks\.length === 0\)/.test(wf)
  && /ctx\.fillRect\(0, mid - unit \/ 2, bw, unit\);/.test(wf));

ok("切项目清波形缓存",
  /clearWaveformCache\(\);/.test(app)
  && /import \{ clearWaveformCache \}/.test(app),
  "峰值按 url 缓存，跨项目零复用价值，留着只会把新项目的条目挤出 LRU");

ok("waveform.ts 是纯模块：不 import React / store / api",
  !/from "react"/.test(mod) && !/stores\//.test(mod) && !/\.\.\/\.\.\/api/.test(mod),
  "它要能被本脚本在 node 下直接跑");

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 波形全部通过：解码降到 8kHz 且限并发 2、只解进了视野的；"
    + "canvas 背板封顶（且封顶后不再 scale）；峰值 LRU 定容、"
    + "失败也缓存、切项目即清；取桶不丢头也不丢尾"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
