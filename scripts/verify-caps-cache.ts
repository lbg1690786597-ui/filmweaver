/**
 * verify-caps-cache.ts — 能力探测的磁盘缓存：作废判定一条都不能少（批次 4 / 4.1）
 *
 * ## 为什么这条最需要断言
 *
 * 4.1 的收益是"导出不再空白 1.2~4s"，代价是**引入了一份会过期的事实**。
 * 缓存到过期数据比不缓存更糟，而且糟得完全静默：
 *
 *   · 缓存里没有某个滤镜 → `hasFilter()` 恒 false → 编译器直接不 push 那段滤镜
 *     → 用户拉了滑块导出后毫无变化，**不报任何错**。这正是 `capabilities.ts`
 *     开头那段注释警告过的失效模式，只是这次的成因从"清单漏写"变成"缓存过期"。
 *   · 缓存里 `hwEncoders` 是空的 → 明明装了显卡驱动却一直软件编码，慢一个量级，
 *     用户只会觉得"这软件就是慢"。
 *
 * 所以键必须挡住三类作废、TTL 必须挡住第四类，而**任何一条挡漏了都不会有人发现**。
 * ① ~ ③ 段逐条钉住。
 *
 * ## 键为什么要从清单本身算指纹，而不是写一个手动版本号
 *
 * 手动版本号必然被忘——本项目已经在 `NEEDED_FILTERS` 上栽过一次同类事故
 * （V2.2 加了 8 个特效滤镜、忘了同步清单，`verify-capabilities.ts` 就是为此写的）。
 * 现在把指纹直接从 `NEEDED_FILTERS` + `HW_CANDIDATES` 算出来：加一个滤镜，
 * 全网旧缓存自动失效，**没有人需要记得做任何事**。① 段用**独立重算**的方式
 * 交叉验证这件事是真的（把两份清单从源码里抠出来自己算一遍 FNV-1a，
 * 与 `probeCacheKey` 的输出比对），而不是只 grep 一句"看起来用了"。
 *
 * ## 解析失败必须"重探"而不是"抛"
 *
 * 这个文件用户能手改，也可能被断电写成半截。它的消费者是**导出主链路**：
 * 解析崩一次就是导出崩一次，而重探的代价只是 1.2~4s。② 段把每一种坏输入
 * 都喂一遍，要求一律返回 null 且不抛。
 *
 * 跑法：npx tsx scripts/verify-caps-cache.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeCacheKey, serializeCaps, deserializeCaps, shouldPersist, CACHE_TTL_MS,
} from "../src/render/capabilities";
import type { Capabilities } from "../src/render/capabilities";
import { qualityArgs } from "../src/render/encoderArgs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SRC = read("src/render/capabilities.ts");
const ENCSRC = read("src/render/encoderArgs.ts");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown, detail = "") {
  const okEq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okEq) failed++;
  console.log(`  ${okEq ? "✅" : "❌"} ${name}`);
  if (!okEq) {
    console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
    if (detail) console.log(`      ${detail}`);
  }
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

const NOW = 1_757_000_000_000;   // 固定"现在"，断言不随真实时间漂移

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    version: "ffmpeg version 4.4.2-0ubuntu0.22.04.1",
    available: true,
    hwEncoders: ["h264_nvenc"],
    filters: new Set(["scale", "overlay", "xfade"]),
    transitions: new Set(["fade", "wipeleft"]),
    probedAt: NOW - 1000,
    ...over,
  };
}

/* ================================================================== */
console.log("\n① 缓存键：三段各挡一类作废，且指纹真的来自两份清单");
/* ================================================================== */

const kA = probeCacheKey("ffmpeg version 4.4.2");
const kB = probeCacheKey("ffmpeg version 6.1.1");
ok("同一版本串两次调用得到同一个键", kA === probeCacheKey("ffmpeg version 4.4.2"));
ok("ffmpeg 换版本 → 键变（滤镜集与转场集都可能跟着变）", kA !== kB);
check("键是「schema | 版本 | 指纹」三段", kA.split("|").length, 3);
check("第一段是 schema 号", kA.split("|")[0], "1");
check("第二段原样带着版本串", kA.split("|")[1], "ffmpeg version 4.4.2");
ok("同一次构建里指纹与版本无关（只随清单变）",
  kA.split("|")[2] === kB.split("|")[2]);

// —— 独立重算：把清单从源码里抠出来，自己算一遍 FNV-1a ——
// 只 grep「用了 NEEDED_FILTERS」是不够的：把编码器候选从指纹里漏掉照样能过。
//
// 4.4 起指纹有**三**段：滤镜清单、编码器候选（搬到了 encoderArgs.ts）、
// 以及**质量参数本身**。第三段是新加的，理由见 capabilities.ts：探测用的
// 就是这份参数，改了 `-cq` 的写法却不换键 = 拿旧写法的探测结论背书新写法。
function arrayLiteral(src: string, name: string): string[] {
  const i = src.indexOf(`const ${name}`);
  if (i < 0) throw new Error(`源码里找不到 ${name}`);
  // 用 `];` 而不是 `\n];` 收尾：单行数组用 `\n];` 会一路吃到下一个数组的结尾去
  // （曾经抠出 38 项就是这么来的）。
  const body = src.slice(src.indexOf("[", i), src.indexOf("];", i));
  // 去掉注释再取字符串字面量，免得把注释里的引号也算进去
  const clean = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
const NEEDED = arrayLiteral(SRC, "NEEDED_FILTERS");
// HW_PAIRS 的字面量是 `{ h264: "...", hevc: "..." }`，按出现顺序抠出来
// 正好等于源码里 `flatMap((p) => [p.h264, p.hevc])` 的展开顺序。
const ENC = [...arrayLiteral(ENCSRC, "HW_PAIRS"),
             ...arrayLiteral(ENCSRC, "SW_CANDIDATES")];
ok(`从源码抠到 ${NEEDED.length} 个滤镜 / ${ENC.length} 个编码器候选`,
  NEEDED.length > 20 && ENC.length >= 6 && ENC.length < 16
  && ENC.every((h) => /^(h264|hevc)_|^libx26/.test(h)) && !ENC.includes("scale"),
  "抠错了后面的比对就没有意义——上限与前缀这两条是防止把 NEEDED_FILTERS 一起吃进来");
ok("候选里 H.264 与 HEVC 都有（4.4 之前只有 H.264，导致选 H.265 拿到的是 H.264）",
  ENC.some((e) => e.startsWith("h264_")) && ENC.some((e) => e.startsWith("hevc_")));
const QSPEC = ENC.map((e) => qualityArgs(e, 23).join(" ")).join("|");
check("指纹 = FNV-1a(滤镜 + '#' + 编码器候选 + '#' + 各自的质量参数)",
  kA.split("|")[2], fnv1a(`${NEEDED.join(",")}#${ENC.join(",")}#${QSPEC}`),
  "键若不真的覆盖这三段，加一个滤镜后老用户的 hasFilter() 会永远 false；"
  + "改了硬件质量参数后老用户的探测结论也会继续沿用旧写法的结果");
ok("往清单里加一项确实会换掉指纹（不是恒等函数）",
  fnv1a(`${[...NEEDED, "newfilter"].join(",")}#${ENC.join(",")}#${QSPEC}`)
    !== kA.split("|")[2]);
ok("只改质量参数、清单不变，指纹同样会变",
  fnv1a(`${NEEDED.join(",")}#${ENC.join(",")}#${QSPEC.replace("-cq", "-qp")}`)
    !== kA.split("|")[2],
  "这一条是 4.4 新增的那一段的存在理由");

/* ================================================================== */
console.log("\n② 反序列化：坏输入一律「重探」，不许抛");
/* ================================================================== */

const good = caps();
const KEY = probeCacheKey(good.version);
const text = serializeCaps(good);

const back = deserializeCaps(text, KEY, NOW);
ok("正常往返能读回来", back !== null);
check("版本一致", back?.version, good.version);
check("hwEncoders 一致", back?.hwEncoders, ["h264_nvenc"]);
check("filters 还原成 Set", [...(back?.filters ?? [])].sort(), ["overlay", "scale", "xfade"]);
check("transitions 还原成 Set", [...(back?.transitions ?? [])].sort(), ["fade", "wipeleft"]);
check("probedAt 原样带回（TTL 从它算起）", back?.probedAt, good.probedAt);
check("读回来的一律标 available", back?.available, true);

const bad = (name: string, t: string, k = KEY, now = NOW) => {
  let threw = false;
  let r: Capabilities | null = null;
  try { r = deserializeCaps(t, k, now); } catch { threw = true; }
  ok(name, !threw && r === null, threw ? "抛异常了——导出主链路会跟着崩" : "没判成作废");
};

bad("键不符（ffmpeg 换了版本 / 清单改了 / schema 变了）", text, probeCacheKey("别的版本"));
bad("超过 TTL", text, KEY, good.probedAt + CACHE_TTL_MS + 1);
ok("正好卡在 TTL 边界内仍可用",
  deserializeCaps(text, KEY, good.probedAt + CACHE_TTL_MS) !== null);
bad("未来时间戳（改过系统时钟 / AppData 从别的机器拷来的）",
  text, KEY, good.probedAt - 10 * 60_000);
bad("滤镜集为空（只可能来自一次失败的探测，见 shouldPersist）",
  serializeCaps(caps({ filters: new Set() })));
bad("坏 JSON（断电写了半截）", '{"key":"1|x|y","filters":[');
bad("根本不是 JSON", "这不是 json");
bad("JSON 但不是对象", '"just a string"');
bad("JSON 是数组", "[1,2,3]");
// ⚠️ 上面这条**当前是靠键校验拦下的**（JSON 数组不可能带 `key` 字段），
// `Array.isArray(raw)` 那道闸是纵深防御：把它删掉行为不变，所以没有任何夹具
// 能让它转红。这不是"断言没写好"，是个语义等价变异——故改在 ⑤ 段静态钉住，
// 并在此注明，免得后人以为这条行为断言承住了那道闸。
bad("null", "null");
bad("filters 里混进了非字符串", JSON.stringify({
  ...JSON.parse(text), filters: ["scale", 42],
}));
bad("hwEncoders 不是数组", JSON.stringify({ ...JSON.parse(text), hwEncoders: "nvenc" }));
bad("probedAt 是字符串", JSON.stringify({ ...JSON.parse(text), probedAt: "刚刚" }));
bad("probedAt 是 NaN（JSON 里会变成 null）",
  JSON.stringify({ ...JSON.parse(text), probedAt: NaN }));
bad("version 是空串", JSON.stringify({ ...JSON.parse(text), version: "" }));

/* ================================================================== */
console.log("\n③ 什么样的探测结果才配落盘");
/* ================================================================== */

ok("正常结果落盘", shouldPersist(caps()));
ok("sidecar 不可用（网页预览环境）不落盘", !shouldPersist(caps({
  available: false, version: "", filters: new Set(), transitions: new Set(),
})));
ok("滤镜集为空不落盘（能跑的 ffmpeg 不可能没有 scale——那是探测失败）",
  !shouldPersist(caps({ filters: new Set() })),
  "写进去等于把一次偶发失败固化成这个版本生命周期内的永久静默失效");
ok("hwEncoders 为空**照常**落盘（纯软件编码的机器是正常结果，不是失败）",
  shouldPersist(caps({ hwEncoders: [] })),
  "把它也当失败就等于在软编机器上永远不缓存，4.1 的收益直接归零");
ok("转场集为空照常落盘（老 ffmpeg 解析不出枚举，hasTransition 有保守放行）",
  shouldPersist(caps({ transitions: new Set() })));

/* ================================================================== */
console.log("\n④ 序列化格式：人能读、能 diff");
/* ================================================================== */

const parsed = JSON.parse(text);
check("filters 排过序", parsed.filters, ["overlay", "scale", "xfade"],
  "不排序的话每次重探都可能生成不同顺序的同一份内容，人工 diff 没法看");
check("transitions 排过序", parsed.transitions, ["fade", "wipeleft"]);
check("键写在文件里（不是只靠文件名区分）", parsed.key, KEY);
ok("带缩进（这文件是给人看的，不是热路径）", text.includes("\n  "));

/* ================================================================== */
console.log("\n⑤ 静态钉：读在重探之前、force 绕过磁盘、写走原子落地");
/* ================================================================== */

ok("先跑 -version 拿到版本，再拿它去查磁盘缓存",
  SRC.indexOf('run(["-hide_banner", "-version"])') < SRC.indexOf("readDiskCache(key)"),
  "顺序反了就没法按版本作废——那正是缓存最需要挡住的那一类");
ok("命中磁盘缓存时**跳过**后面的探测（否则一点都没省）",
  /if \(disk\) \{ cache = disk; return disk; \}/.test(SRC));
ok("force=true 绕过磁盘缓存（用户/设置页要有办法强制重探）",
  /if \(!force\) \{\s*const disk = await readDiskCache/.test(SRC));
ok("落盘前过 shouldPersist",
  /async function writeDiskCache[\s\S]{0,120}if \(!shouldPersist\(caps\)\) return;/.test(SRC));
// 只 grep 全文会被 writeDiskCache 的**定义**满足（定义在、就是没人调）。
// 这里只看 probeCapabilities 里那次真正的探测收尾。——同 4.0 在 App.tsx 上的教训。
const tail = SRC.slice(SRC.indexOf("cache = { version, available: true"));
ok("探测完**真的调用了** writeDiskCache（否则下次冷启动照样白等 1.2~4s）",
  /await writeDiskCache\(cache\);/.test(tail.slice(0, tail.indexOf("return cache;"))),
  "4.1 的全部收益就在这一行上");
ok("先挡住非对象/数组再读字段（纵深防御：单看行为它与只靠键校验等价）",
  /if \(!raw \|\| typeof raw !== "object" \|\| Array\.isArray\(raw\)\) return null;/.test(SRC),
  "哪天有人把键校验挪到后面或改宽，这道闸就是唯一还站着的那个");
ok("落盘走 .part → rename 的原子写",
  /const part = `\$\{p\}\.part`;/.test(SRC) && /await rename\(part, p\)/.test(SRC),
  "半截 JSON 会让此后每次启动都解析失败、白白重探，而且完全静默");
ok("三个 IO 函数各自把异常吞掉（缓存是加速，不是正确性依赖）",
  (SRC.match(/\} catch \{/g) ?? []).length >= 4);
ok("TTL 是 7 天，且注释写明它挡的是「版本没变但装了驱动」",
  /CACHE_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/.test(SRC)
  && /驱动/.test(SRC.slice(SRC.indexOf("CACHE_TTL_MS") - 500, SRC.indexOf("CACHE_TTL_MS"))));
ok("CACHE_SCHEMA 只在解析逻辑变时手动 +1（清单变化由指纹自动覆盖）",
  /只在解析\/序列化逻辑本身变化时手动 \+1/.test(SRC));

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 能力缓存全部通过：键覆盖 schema/版本/清单指纹（独立重算交叉验证），"
    + "TTL 兜住「装了驱动但版本没变」，坏文件一律重探且不抛，"
    + "探测失败的空滤镜集不会被固化"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
