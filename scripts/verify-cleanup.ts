/**
 * verify-cleanup.ts — 中间产物用完即删（批次 4 / 4.3）
 *
 * ## 这条为什么危险到值得单钉
 *
 * 「删中间文件」听上去是纯粹的收益，实际上是本批次**唯一一条改错了会让用户
 * 直接导不出片**的改动。原因在 docs §0.5(h)：
 *
 *     `merged.mp4` / `mixed.mp4` 不总是中间文件，**它们在降级分支里就是成片**。
 *       · 项目里没有任何音频        → 成片就是 concat 出的 merged.mp4
 *       · 老机器 ffmpeg 没有 subtitles 滤镜 → 成片停在 mixed.mp4（刻意的降级分支）
 *
 * 无条件删这两个 = 静音项目和老机器**导出直接失败**。而这两种项目在开发机上
 * 都不是默认形态：开发机的 ffmpeg 有 libass、测试工程都带旁白，
 * 所以这个 bug **在本机永远复现不了**，只会变成用户那边的「导出到最后报错」。
 *
 * ## 修法是一条规则，不是若干个 if
 *
 *     只有当下一道已经成功产出新文件、`final` 也已经指向它之后，才删上一道。
 *
 * 这样被删的那个**必然不是成片**，三种降级组合自动成立——不需要在每个分支里
 * 各写一遍条件（各写一遍正是 4.2 刚清理掉的那类漂移）。
 * 所以本脚本的重心是 ②/④：**从源码里把「事件顺序」抽出来逐项比对**，
 * 而不是复述一遍我心里想的顺序。顺序一乱（比如把 retire 挪到 runFfmpeg 之前，
 * 那等于删掉下一道的输入），②/④ 立刻红。
 *
 * 跑法：npx tsx scripts/verify-cleanup.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { retireFiles, RETIRE_BATCH } from "../src/lib/retireFiles";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** 只看代码：注释里出现 `retireFiles(` / `final = x` 会把顺序表污染成假的 */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const RENDERER = code("src/render/renderer.ts");
const LOCAL = code("src/lib/localRender.ts");
const RETIRE = read("src/lib/retireFiles.ts");

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}
function check(name: string, actual: unknown, expected: unknown, detail = "") {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!eq) failed++;
  console.log(`  ${eq ? "✅" : "❌"} ${name}`);
  if (!eq) {
    console.log(`      期望 ${JSON.stringify(expected)}`);
    console.log(`      实际 ${JSON.stringify(actual)}`);
    if (detail) console.log(`      ${detail}`);
  }
}

/* ================================================================== */
console.log("\n① retireFiles 本身：删干净、不抛错、不一次性推上千个 IPC");
/* ================================================================== */

{
  const files = Array.from({ length: 100 }, (_, i) => `f${i}`);
  const seen: string[] = [];
  let inFlight = 0, peak = 0;
  await retireFiles(files, async (p) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 0));
    seen.push(p); inFlight--;
  });
  check("每个文件都删到了，且只删一次", [seen.length, new Set(seen).size], [100, 100]);
  ok(`并发不超过 RETIRE_BATCH（实测峰值 ${peak} ≤ ${RETIRE_BATCH}）`,
    peak > 0 && peak <= RETIRE_BATCH,
    "1424 镜项目一次性推 1424 个删除 IPC 没必要；分批是为这个，不是为了限流");
}

{
  // 删除失败必须被吞掉：走到调用点时导出**已经成功**了，
  // 为一个杀毒软件占着的临时文件让整轮几十分钟的渲染报错是荒谬的。
  const seen: string[] = [];
  let threw = false;
  await retireFiles(["a", "b", "c"], async (p) => {
    if (p === "b") throw new Error("EBUSY: 被杀毒软件占用");
    seen.push(p);
  }).catch(() => { threw = true; });
  ok("单个文件删不掉不会让整个导出失败", !threw);
  check("其余文件照删不误", seen.sort(), ["a", "c"],
    "一个删不掉就放弃剩下的，等于白做——峰值压不下来");
}

{
  let calls = 0;
  await retireFiles([], async () => { calls++; });
  check("空列表不调用任何删除", calls, 0);
}

ok("默认实现走 plugin-fs 的 remove，rm 参数只是给验证脚本的注入点",
  /import \{ remove \} from "@tauri-apps\/plugin-fs";/.test(RETIRE)
  && /rm: \(path: string\) => Promise<void> = \(path\) => remove\(path\)/.test(RETIRE));
ok("批大小标注了「与生成/任务并发无关」",
  /本地文件删除\*\*的批大小/.test(RETIRE) && /并发铁律/.test(RETIRE),
  "不写清楚的话，下次有人为了「调优」把它和 MAX_CONCURRENCY 一起改");

/* ================================================================== */
console.log("\n② 主链路 renderer.ts：从源码里抽出的事件顺序");
/* ================================================================== */

/**
 * 把 render() 里与「文件生死」有关的事件按出现顺序抽出来。
 *
 * ⚠️ 这不是复述我心里想的顺序，是**从源码正文里 parse 出来的**——
 * 任何一处挪位（尤其把 retire 挪到 runFfmpeg 之前 = 删掉下一道的输入）
 * 都会让下面那张表对不上。
 */
function events(src: string, from: string): string[] {
  const body = src.slice(src.indexOf(from));
  const RE = /await runFfmpeg\(|const prev = final;|^\s*final = (\w+);|await retireFiles\(([^)]*)\)|invoke\("export_copy_file"/gm;
  const out: string[] = [];
  for (const m of body.matchAll(RE)) {
    if (m[0].startsWith("await runFfmpeg")) out.push("ffmpeg");
    else if (m[0].startsWith("const prev")) out.push("prev=final");
    else if (m[1]) out.push(`final=${m[1]}`);
    else if (m[2] !== undefined) out.push(`retire(${m[2]})`);
    else out.push("另存");
  }
  return out;
}

/**
 * 取 `header` 那个块的 `{...}` 范围（靠配对花括号，不是靠缩进）。
 *
 * ⚠️ 为什么非要它：上面的 `events()` 是**平铺**扫描，看不见分支结构。
 * 把 `retire` 从 `if (srtText) {` 块里挪到块外，事件顺序**一模一样**，
 * 而语义已经从「烧了字幕才删 merged」变成「无论如何都删 merged」——
 * 后者正是 §0.5(h) 那条「静音项目导不出片」。变异测试实测这一条能逃过
 * 顺序断言，所以必须补一条结构断言。
 */
function blockOf(src: string, header: string): [number, number] {
  const i = src.indexOf(header);
  if (i < 0) return [-1, -1];
  let depth = 0;
  for (let j = src.indexOf("{", i); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return [i, j];
  }
  return [i, -1];
}
function inside(src: string, header: string, needle: string): boolean {
  const [s, e] = blockOf(src, header);
  const n = src.indexOf(needle, s);
  return s >= 0 && e > s && n > s && n < e;
}

check("render() 的事件顺序", events(RENDERER, "export async function render"), [
  "ffmpeg",                 // 逐段渲染（在 for 循环里）
  // ↓ 5.8 新增：本段的蒙版在**本段 ffmpeg 跑完之后**才退休。
  //   为什么这个 diff 是预期的：蒙版是这一道 ffmpeg 的**输入**（`-f rawvideo -i`），
  //   放到 runFfmpeg 之前就是把自己的输入删了。它排在 segFiles.push 之后、
  //   下一轮循环之前，峰值因此是「单段蒙版」而不是「全片蒙版」。
  //   它不参与 final 的指向，所以不需要 prev=final 的保护。
  "retire(segMaskFiles)",
  "ffmpeg",                 // concat → merged.mp4
  "retire(segFiles)",       // ← §0.5(h) 认定的唯一安全窗口
  "ffmpeg",                 // 混音 → mixed.mp4
  "prev=final",
  "final=mixOut",
  "retire([prev])",         // ← final 已指向 mixed，merged 不可能是成片
  "ffmpeg",                 // 烧字幕 → final.mp4
  "prev=final",
  "final=burned",
  "retire([prev])",         // ← final 已指向 final.mp4
  "另存",
],
  "每个 retire 都必须排在「下一道的 runFfmpeg 成功」与「final 已改指向」之后。"
  + "挪到前面 = 把下一道的输入文件删了；挪到 final 改指向之前 = 删的可能正是成片");

// 顺序表是**平铺**的，看不见循环结构：把蒙版 retire 挪出 for 循环，事件顺序一模一样，
// 而峰值会从「单段蒙版」变回「全片蒙版」（一部 60 集的片子可能是几十 GB）。
ok("蒙版 retire 在逐段渲染的 for 循环**内部**",
  inside(RENDERER, "for (let i = 0; i < segs.length; i++) {",
    "await retireFiles(segMaskFiles);"),
  "挪到循环外 = 全片蒙版全程堆在盘上，正是 5.8 引入预算机制要防的那种失败");

ok("蒙版 retire 排在本段 runFfmpeg 之后（蒙版是那一道的输入）",
  RENDERER.indexOf("await retireFiles(segMaskFiles)")
  > RENDERER.indexOf("const { args } = compileSegment("),
  "排到前面 = 编译好的 -i 指向一个已被删掉的文件，整段导出失败");

ok("retire 的实参只有 segFiles / [prev] / segMaskFiles 三种（没有 final、没有缓存路径）",
  [...RENDERER.matchAll(/await retireFiles\(([^)]*)\)/g)]
    .every((m) => m[1] === "segFiles" || m[1] === "[prev]" || m[1] === "segMaskFiles")
  && !/retireFiles\(\[?final/.test(RENDERER)
  && !/retireFiles\([^)]*paths/.test(RENDERER),
  "缓存目录一个都不能碰：同一素材可能被多镜引用，且分段渲染与混音会两次读取它");

check("`const prev = final;` 恰好两处（混音后、烧字幕后）",
  (RENDERER.match(/const prev = final;/g) ?? []).length, 2);

ok("退休 merged 那句在 `if (mixArgs)` 块**内部**（混音没跑就不许删）",
  inside(RENDERER, "if (mixArgs) {", "await retireFiles([prev]);"),
  "挪到块外 = 无论混不混都删 merged；而混音没跑时 merged 就是成片");
ok("退休 mixed/merged 那句在烧字幕的 else 块**内部**（跳过烧字幕就不许删）",
  inside(RENDERER, "} else {\n        report({ pct: 92, stage: \"烧录字幕\" });",
    "await retireFiles([prev]);"),
  "老机器没有 subtitles 滤镜时走的是 if 分支，成片停在 mixed.mp4——那时删它就是删成片");
ok("退休分段文件那句不在任何条件分支里（concat 一定跑过）",
  !inside(RENDERER, "if (mixArgs) {", "await retireFiles(segFiles);"));

ok("segFiles 只在 concat 之后退休，不在渲染循环里边渲边删",
  RENDERER.indexOf("await retireFiles(segFiles)")
    > RENDERER.indexOf("compileConcat(listPath, final"),
  "循环里删的话 list.txt 指向的文件在 concat 时已经不存在了");

ok("清理有自己的进度上报（1424 个文件的删除不是瞬时的）",
  /report\(\{ pct: 88, stage: `清理 \$\{segFiles\.length\} 个分段文件` \}\);/.test(RENDERER),
  "不报的话用户看到的是进度条在 85% 上莫名其妙停一下");

ok("finally 仍然整目录兜底删（retire 只是把峰值提前压下来，不是替代它）",
  /finally \{[\s\S]{0,300}?await remove\(work, \{ recursive: true \}\)\.catch/.test(RENDERER),
  "失败/取消路径根本走不到 retire，兜底那一句才是保证不留几十 GB 的那道");

/* ================================================================== */
console.log("\n③ 三种降级组合：被删的那个永远不是成片");
/* ================================================================== */

/**
 * 按 ② 抽出的规则重放流水线：`final` 指到哪，哪个就是成片；
 * 每一道成功后退休**上一道**的产物。断言成片始终没被删。
 *
 * 峰值是**模拟出来的**，不是套公式：每一道 ffmpeg 运行期间输入和输出**同时在盘上**，
 * 所以峰值取的是「运行中」那一刻的存活集合大小，而不是「跑完之后」。
 * 单位取「一部成片的体积」——所有分段之和 ≈ 成片，每道尾段产物也 ≈ 成片。
 */
function replay(o: { mix: boolean; burn: boolean }, cleanup: boolean) {
  const alive = new Set(["seg_*"]);
  const retired: string[] = [];
  let peak = 0;
  let final = "seg_*";
  const mark = () => { peak = Math.max(peak, alive.size); };
  /** 跑一道：产物落地（此刻输入仍在盘上 → 取峰值），再按规则退休上一道 */
  const stage = (out: string) => {
    alive.add(out);
    mark();
    const prev = final;
    final = out;
    if (cleanup) { alive.delete(prev); retired.push(prev); }
  };

  mark();
  stage("merged.mp4");
  if (o.mix) stage("mixed.mp4");
  if (o.burn) stage("final.mp4");
  return { final, retired, delivered: alive.has(final), peak };
}

const SHAPES = [
  { name: "无音频、无字幕（成片 = merged.mp4）", o: { mix: false, burn: false }, want: "merged.mp4",
    why: "§0.5(h) 第一条：静音项目的成片就是 concat 产物" },
  { name: "有音频、无字幕（成片 = mixed.mp4）", o: { mix: true, burn: false }, want: "mixed.mp4",
    why: "§0.5(h) 第二条：老机器没有 subtitles 滤镜时也停在这里" },
  { name: "无音频、烧字幕（成片 = final.mp4）", o: { mix: false, burn: true }, want: "final.mp4",
    why: "跳过混音，merged 直接进烧字幕" },
  { name: "有音频 + 烧字幕（最长的一条）", o: { mix: true, burn: true }, want: "final.mp4",
    why: "三道齐全，前两道都是纯中间产物" },
];
let worstAfter = 0;
for (const s of SHAPES) {
  const r = replay(s.o, true);
  const before = replay(s.o, false);
  worstAfter = Math.max(worstAfter, r.peak);
  ok(`${s.name} → 成片健在，退休 ${r.retired.join(" / ")}`,
    r.final === s.want && r.delivered && !r.retired.includes(r.final)
    && r.peak <= before.peak,
    `实际成片=${r.final}，被删=${r.retired.join(",")}。${s.why}`);
  console.log(`      峰值 ${before.peak}× 成片体积 → ${r.peak}×`);
}
check("清理后的最坏峰值（任何形状）", worstAfter, 2,
  "降不到 1×：任何一道 ffmpeg 运行期间输入和输出必然同时在盘上。"
  + "所以路线图里「降约 2/3」的估计偏乐观，真实上限是 4× → 2×（见 §0.6）");


/* ================================================================== */
console.log("\n④ legacy 链路 localRender.ts（「经典导出」/ sidecar 降级走它）");
/* ================================================================== */

// 它不经 render/renderer.ts，②那套断言一条都盖不到；而它的 norm_*.mp4 是
// **逐 clip 的全分辨率重编码产物**，峰值上占的正是整条成片那么大的一份。
check("localRender() 的事件顺序", events(LOCAL, "export async function localRender"), [
  "ffmpeg",                 // 逐 clip 归一化（在 for 循环里）
  "ffmpeg",                 // concat → merged.mp4
  "retire(normFiles)",      // ← concat 已出 merged，norm_* 没人再读
  "ffmpeg",                 // 烧字幕 → final.mp4
  "retire([merged])",       // ← final.mp4 已出，merged 变成纯中间产物
  "另存",
],
  "legacy 没有混音那道；但同样必须「下一道成功之后」才删上一道");

ok("legacy 也复用同一个 retireFiles，而不是自己抄一遍 Promise.all",
  /import \{ retireFiles \} from "\.\/retireFiles";/.test(LOCAL)
  && !/normFiles\.map\(\(f\) => remove/.test(LOCAL),
  "这条规则写错的代价太不对称（多删 = 导不出片），不能两边各留一份实现");

ok("legacy 无字幕时不删 merged（那时它就是成片）",
  inside(LOCAL, "if (srtText) {", "await retireFiles([merged]);"),
  "retire([merged]) 必须在 if (srtText) 块**内部**——挪到外面，无字幕项目当场导不出。"
  + "注意事件顺序断言看不出这一点（挪出去顺序不变），只能靠花括号配对");

ok("legacy 的缓存目录同样没被碰（cacheClip 落在 cache/<projectId>/，与 work 无关）",
  !/retireFiles\([^)]*cache/i.test(LOCAL)
  && [...LOCAL.matchAll(/await retireFiles\(([^)]*)\)/g)]
    .every((m) => m[1] === "normFiles" || m[1] === "[merged]"));

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 清理规则全部通过：只在「下一道成功且 final 已改指向」之后删上一道；"
    + "四种流水线形状下成片都健在；缓存目录未被触碰；两条导出链路共用同一份实现"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
