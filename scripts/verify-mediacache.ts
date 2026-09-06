/**
 * verify-mediacache.ts — 本机素材缓存：命名唯一、落地原子、残留可清（批次 4 / 4.5）
 *
 * ## 这条为什么值得一个独立脚本
 *
 * 4.5 表面上是"统一两套命名 + 加个清理入口"，实际修的是一个**正确性** bug，
 * 而且是最难发现的那一类——**不报错、不下载、直接把别的镜头剪进成片**：
 *
 *   `localRender.ts`（经典导出 / FineCut 那条链）用**裸 basename** 当缓存键，
 *   复用判据是「同名文件已存在就直接返回」。后端按镜头目录组织素材，
 *   `output.mp4` / `final.mp4` 这种 basename 是常态，于是第 2 个镜头拿到了
 *   第 1 个镜头的文件。用户看到的是"这一镜画面不对"，日志里什么都没有。
 *
 * 所以 ① 段不是在测一个字符串函数，是在测**两个不同素材必须得到两个不同名字**；
 * 而 ③ 段负责证明"产品里真的只剩一套命名"——只钉纯函数、不钉调用方，
 * 等于把旧的第二套留在原地继续错。
 *
 * ## 断言尽量 import 真函数，而不是照源码再实现一遍
 *
 * 命名规则被单独放进 `lib/cacheName.ts` 就是为了这件事：`lib/mediaCache.ts`
 * 必须 `import { api }`，而 `api.ts` 顶层读 `import.meta.env`，**node 下加载即抛**。
 * 只有把纯函数拆出去，脚本才能 import 到**产品里真正在跑的那一份**。
 *
 * 唯一"再实现一遍"的地方是 ② 段的 FNV-1a 参考实现，而那里的目的**就是**交叉验证：
 * 4.5 把 `capabilities.ts` 里的内联哈希换成了共享的 `lib/fnv1a.ts`，
 * 只要取值有一个 bit 不同，全网用户的能力缓存就会集体作废、下次冷启动白等 1.2~4s。
 * "取值一字未变"这句话必须被算出来，不能靠肉眼比对两段长得一样的代码。
 *
 * ## ④ 从「源码断言」升级成「真跑」（6.1，**这是一次预期内的期望值变更**）
 *
 * 4.5 时这一段只能做源码断言，本文件头当时如实写着「它们的强度不如真跑」：
 * `ensureCached` 住在 `lib/mediaCache.ts` 里，而那个文件必须 `import { api }`，
 * `api.ts` 顶层读 `import.meta.env` → **node 下 import 即抛**，没有实现可跑。
 *
 * 6.1 把**落地规则**整体搬进了 `lib/cacheFetch.ts`（可注入 I/O 的纯逻辑，
 * 与 `lib/retireFiles.ts` 的 `rm`、`render/maskFiles.ts` 的 `MaskIO` 同一个模式），
 * `mediaCache.ts` 只剩「把 Tauri plugin-fs 接上去」。于是：
 *
 *   **为什么这个 diff 是预期的**：④ 段原有的 8 条 grep（`.part` → `rename` 两行、
 *   失败清 `.part`、`size > 0`、空响应报错、AbortError 归一化、入口查 signal、
 *   `mediaCache` 不反向 import renderer）在改动后**全部对着空气**——
 *   它们要找的代码已经不在 `mediaCache.ts` 里了。修法**不是**把 grep 重新指向
 *   `cacheFetch.ts`（那只是把同一种弱断言搬个家），而是照 4.5 自己许下的愿：
 *   给一个内存假盘、**真跑那份产品在跑的规则**。断言数因此从 8 条源码 grep
 *   变成 20 条行为断言，且新覆盖了 grep 天生盖不到的东西——单飞与引用计数取消。
 *
 * 留在 ④ 段的源码断言只剩 `sweepParts` / `localCacheStats` / `clearLocalCache`
 * 三个函数：它们直接调 plugin-fs 的 `readDir`，形状太薄、注入的收益抵不上
 * 多一层间接；且它们错了是「少清一点 / 多占一点盘」，不是「导出失败」。
 *
 * 跑法：npx tsx scripts/verify-mediacache.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheFileName, CACHE_ROOT, CAPS_CACHE_NAME, NAME_TAIL_MAX,
} from "../src/lib/cacheName";
import { fnv1a } from "../src/lib/fnv1a";
import { Aborted } from "../src/lib/aborted";
// 6.1：落地规则搬到了这里，于是 ④ 段可以**真跑**它（见文件头）。
import { makeEnsureCached, type CacheIO } from "../src/lib/cacheFetch";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

const MEDIACACHE = read("lib/mediaCache.ts");
const CACHEFETCH = read("lib/cacheFetch.ts");
const CACHENAME = read("lib/cacheName.ts");
const LOCALRENDER = read("lib/localRender.ts");
const RENDERER = read("render/renderer.ts");
const CAPS = read("render/capabilities.ts");
const SETTINGS = read("features/settings/SettingsDialog.tsx");
const APP = read("App.tsx");

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`   ✅ ${msg}`); }
  else { fail++; console.log(`   ❌ ${msg}`); }
}
/** 钉**取值**而不是钉"性质"：顺序/数量错了要能一眼看出错成了什么样子 */
function check(msg: string, actual: unknown, expected: unknown, detail = "") {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { pass++; console.log(`   ✅ ${msg}`); return; }
  fail++;
  console.log(`   ❌ ${msg}`);
  console.log(`      期望 ${JSON.stringify(expected)}`);
  console.log(`      实际 ${JSON.stringify(actual)}`);
  if (detail) console.log(`      ${detail}`);
}

// ───────────────────────────────────────────────────────────── ①
console.log("\n① 缓存命名：同名不同源必须分开，同源不同签名必须合并");

const A = "/fw/media/proj-1/shot-007/output.mp4";
const B = "/fw/media/proj-1/shot-008/output.mp4";

ok(cacheFileName(A) === cacheFileName(A), "确定性：同一 URL 两次结果相同");

// ★ R5 的正确性 bug 本体。裸 basename 时这两个是同一个名字。
ok(cacheFileName(A) !== cacheFileName(B),
  "同 basename 不同路径 → 不同缓存名（FineCut 剪进错镜头的根因）");
ok(cacheFileName(A).endsWith("_output.mp4") && cacheFileName(B).endsWith("_output.mp4"),
  "两者都保留可读的 basename 后缀（去 AppData 里翻得出来）");

// query 必须被剥掉：外部直链的签名参数每次都不一样，算进去就永远命中不了。
ok(cacheFileName(A) === cacheFileName(`${A}?X-Amz-Signature=abc123&e=1`),
  "同一素材、不同签名 query → 同一缓存名（否则缓存永远不命中）");
ok(cacheFileName(`${A}?a=1`) === cacheFileName(`${A}?b=2`),
  "两个不同 query 也归一到同一个名字");

// 哈希必须取**完整** URL：只取末尾 N 字符时，长路径的公共尾巴会撞在一起。
const tail = "x".repeat(NAME_TAIL_MAX + 20) + "/output.mp4";
ok(cacheFileName(`/fw/media/aaaaaaaa/${tail}`) !== cacheFileName(`/fw/media/bbbbbbbb/${tail}`),
  `哈希取完整 URL：只差前缀、末尾 ${NAME_TAIL_MAX}+ 字符相同的两个素材仍分得开`);

// 消毒与长度：文件名要能落在 Windows 上。
const dirty = cacheFileName("/fw/media/p/s/中 文:名*字?.mp4");
ok(/^[\w.\-]+$/.test(dirty), `非法字符全部消毒（实测 ${dirty}）`);
const longName = cacheFileName(`/fw/media/p/s/${"n".repeat(200)}.mp4`);
ok(longName.length === 9 + NAME_TAIL_MAX,
  `名字长度封顶：8 位哈希 + "_" + 最多 ${NAME_TAIL_MAX} 字符（实测 ${longName.length}）`);
ok(/^[0-9a-f]{8}_/.test(cacheFileName(A)), "前缀恒为 8 位小写十六进制 + 下划线");
ok(cacheFileName("/fw/media/p/s/").endsWith("_media"),
  "URL 以 / 结尾（取不到 basename）时回落到 media，不产生空后缀");

// 一批真实形态的素材，两两不许撞。
const urls = [
  "/fw/media/p1/s1/output.mp4", "/fw/media/p1/s2/output.mp4",
  "/fw/media/p1/s1/final.mp4", "/fw/media/p2/s1/output.mp4",
  "/fw/media/p1/s1/audio/bgm.mp3", "/fw/media/p1/s1/audio/vo.mp3",
  "https://oss.example.com/a/b/output.mp4?sig=1",
  "https://oss.example.com/a/c/output.mp4?sig=2",
];
ok(new Set(urls.map(cacheFileName)).size === urls.length,
  `${urls.length} 个真实形态素材两两不撞`);

ok(CACHE_ROOT === "cache" && CAPS_CACHE_NAME === "capabilities.json",
  "目录名与能力缓存文件名是导出常量（清理逻辑要显式绕开后者）");

// ───────────────────────────────────────────────────────────── ②
console.log("\n② FNV-1a 去重后取值必须逐字不变（否则全网能力缓存作废）");

/** 4.5 之前 `capabilities.ts` 里内联的那一份，原样抄来做交叉验证。 */
function reference(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
const samples = ["", "a", "libx264", "scale|crop|overlay|alphamerge",
  "中文素材名.mp4", " ￿", ...Array.from({ length: 200 },
    (_, i) => `sample-${i}-${"x".repeat(i % 37)}`)];
const drift = samples.filter((s) => fnv1a(s) !== reference(s));
ok(drift.length === 0, `${samples.length} 个样本与旧内联实现逐字一致（0 处漂移）`);
ok(fnv1a("") === "811c9dc5", "空串命中 FNV-1a 32 位的 offset basis（811c9dc5）");
ok(fnv1a("a") === "e40c292c", '单字符 "a" 命中标准向量（e40c292c）');
ok(fnv1a("x").length === 8 && fnv1a(" ").length === 8,
  "输出恒为 8 位（padStart 没被漏掉，否则短哈希会让名字长度不定）");

// ───────────────────────────────────────────────────────────── ③
console.log("\n③ 结构：两条导出链路真的只剩一套命名");

ok(/return ensureCached\(projectId, url\)/.test(LOCALRENDER),
  "localRender 的 cacheClip 是 ensureCached 的薄壳，自己不再命名");
ok(!/const name = url\.split\("\/"\)\.pop\(\)/.test(LOCALRENDER),
  "localRender 里再没有「裸 basename 当缓存键」的写法");
ok(!/\bwriteFile\b/.test(LOCALRENDER.replace(/\/\*[\s\S]*?\*\//g, "")),
  "localRender 的代码区不再直接 writeFile（原来那句不是原子写）");
ok(/import \{ ensureCached, sweepParts \} from "\.\/mediaCache"/.test(LOCALRENDER),
  "localRender 从 mediaCache 取 ensureCached + sweepParts");
ok(/await sweepParts\(projectId\)/.test(LOCALRENDER),
  "localRender 也扫 .part：两条链路写同一个目录，只在 V2 扫等于经典导出用户永远清不掉");

// 6.4：这三条原来钉的是 `renderer.ts` 里 `cacheMedia` 的函数体，而 6.4 把整个
// 准备阶段搬去了 `render/exportPrep.ts`（纯逻辑 + 注入 I/O），`cacheMedia` 已删除。
// **要守的性质一条没变**，只是它们现在分别落在两个地方，所以断言跟着规则走：
//   · 扫 `.part` / 走 `ensureCached` / 透传 signal —— 现在是 `prepIO` 这个接线表；
//   · 并发数 4 —— 现在是传给 `prepareMedia` 的参数。
// 照旧 grep 一个已经不存在的函数体，就是「断言在装饰而非承重」的典型：
// 只要有人把它删掉，断言会从"守住了"直接变成"对着空气"。
ok(/sweep: \(\) => sweepParts\(projectId\)/.test(RENDERER),
  "renderer 的准备阶段仍扫 .part（4.5 之前这里只有注释、没有代码；6.4 后由 prepIO 接线）");
ok(/fetch: \(url, signal\) => ensureCached\(projectId, url, signal\)/.test(RENDERER),
  "renderer 仍走 ensureCached，并把 signal 透传下去");
ok(!/Math\.imul/.test(RENDERER) && !/\.part/.test(RENDERER.replace(/\/\/[^\n]*/g, "")),
  "renderer 里不再有第二份哈希实现、也不再自己拼 .part");
ok(/downloadConcurrency: 4,/.test(RENDERER) && /probeConcurrency: 4,/.test(RENDERER),
  "下载并发仍是 4（并发数铁律：重构不许顺手改并发）");


// 哈希在 src/ 下只能有一处实现。
const IMPLS = ["lib/fnv1a.ts", "lib/cacheName.ts", "lib/mediaCache.ts",
  "render/capabilities.ts", "render/renderer.ts", "lib/localRender.ts"]
  .filter((p) => /16777619/.test(read(p)));
ok(IMPLS.length === 1 && IMPLS[0] === "lib/fnv1a.ts",
  `src/ 下 FNV-1a 只有一份实现（实测：${IMPLS.join(", ") || "无"}）`);
ok(/const fingerprint = fnv1a;/.test(CAPS) && /from "\.\.\/lib\/fnv1a"/.test(CAPS),
  "capabilities 的 fingerprint 就是共享的 fnv1a，不是长得像的另一份");

ok(/from "\.\/cacheName"/.test(MEDIACACHE) && !/16777619/.test(MEDIACACHE),
  "mediaCache 的命名来自 cacheName.ts，自己不实现");
const CN_CODE = CACHENAME.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
ok(!/\bimport\b[^\n]*(api|@tauri-apps)/.test(CN_CODE),
  "cacheName 保持纯净（不 import api / tauri），本脚本才能 import 到真函数");

// ───────────────────────────────────────────────────────────── ④
console.log("\n④ 落地规则：给一个内存假盘，把 cacheFetch 真跑一遍");

/**
 * 一块内存假盘 + 一个可编排的 `fetch`。
 *
 * 这不是"模拟 ensureCached 的行为"——`makeEnsureCached` 是从
 * `src/lib/cacheFetch.ts` **import 进来的产品代码本体**，这里只提供它要的 I/O。
 * 断言因此钉的是「产品真跑起来会怎样」，而不是「源码里出现过这几个字」。
 */
function fake(o: {
  /** 预置在盘上的文件：路径 → 字节数（0 表示空文件，正是要被重下的那种） */
  disk?: Record<string, number>;
  /** true = fetch 不立即返回，等 `release()`；用于编排并发与取消 */
  gate?: boolean;
  bytes?: number;
  fetchThrows?: () => unknown;
  failWrite?: boolean;
  failRename?: boolean;
} = {}) {
  const disk = new Map<string, number>(Object.entries(o.disk ?? {}));
  const log: string[] = [];
  const fetches: string[] = [];
  /** 每次 fetch 拿到的 signal —— 「底层那条下载到底有没有被掐」只能问它 */
  const signals: AbortSignal[] = [];
  const gates: Array<(b: number) => void> = [];

  const io: CacheIO = {
    dirFor: async (pid) => { log.push(`dir:${pid}`); return `/app/cache/${pid}`; },
    join: async (d, n) => `${d}/${n}`,
    exists: async (p) => disk.has(p),
    size: async (p) => disk.get(p) ?? 0,
    remove: async (p) => { log.push(`remove:${p}`); disk.delete(p); },
    write: async (p, data) => {
      if (o.failWrite) { log.push(`write!:${p}`); throw new Error("磁盘已满"); }
      log.push(`write:${p}`); disk.set(p, data.length);
    },
    rename: async (from, to) => {
      if (o.failRename) { log.push(`rename!:${from}`); throw new Error("重命名失败"); }
      // 真实 rename 对不存在的源会失败。假盘也照做，否则"下载两遍"这种 bug
      // 在假盘上会一路绿灯——正是 6.1 单飞要修的那个症状。
      if (!disk.has(from)) throw new Error(`rename: 源不存在 ${from}`);
      log.push(`rename:${from}→${to}`);
      disk.set(to, disk.get(from) ?? 0); disk.delete(from);
    },
    fetch: async (url, signal) => {
      fetches.push(url); signals.push(signal);
      if (o.fetchThrows) throw o.fetchThrows();
      if (!o.gate) return new Uint8Array(o.bytes ?? 8);
      return new Promise<Uint8Array>((res) => { gates.push((b) => res(new Uint8Array(b))); });
    },
  };
  return {
    io, disk, log, fetches, signals,
    release: (i = 0, bytes = 8) => gates[i]?.(bytes),
  };
}

const P = "proj-1";
const U = "/fw/media/proj-1/shot-007/output.mp4";
const DEST = `/app/cache/${P}/${cacheFileName(U)}`;
/** 让已排上队的微任务跑完（编排并发时用，不是 sleep 凑时间） */
const tick = () => new Promise((r) => setTimeout(r, 0));
async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => null, (e: unknown) => e);
}

{
  const f = fake({ disk: { [DEST]: 1234 } });
  const got = await makeEnsureCached(f.io)(P, U);
  ok(got === DEST && f.fetches.length === 0,
    `幂等：盘上已有非空文件 → 一次网络请求都不发（实测 ${f.fetches.length} 次）`);
}

{
  // 上次写出了 0 字节（磁盘满/被拦截）。判"存在即返回"的写法会把这个素材
  // **永远**焊死在盘上——它每次都命中缓存，每次都取不到内容。
  const f = fake({ disk: { [DEST]: 0 } });
  const got = await makeEnsureCached(f.io)(P, U);
  ok(got === DEST && f.fetches.length === 1 && f.log.includes(`remove:${DEST}`),
    "盘上是 0 字节 → 删掉重下（否则这个素材永远取不到内容）");
}

{
  const f = fake();
  await makeEnsureCached(f.io)(P, U);
  const io = f.log.filter((l) => l.startsWith("write:") || l.startsWith("rename:"));
  check("落地顺序：先写 .part，再 rename 到 dest",
    io, [`write:${DEST}.part`, `rename:${DEST}.part→${DEST}`],
    "反过来或直接写 dest = 进程被杀时 dest 是半截文件，而复用只认 dest 存在与否");
  ok(f.disk.has(DEST) && f.disk.get(DEST) === 8 && ![...f.disk.keys()].some((k) => k.endsWith(".part")),
    "跑完盘上只剩 dest，没有 .part 残留");
}

{
  const f = fake({ failRename: true });
  const e = await caught(makeEnsureCached(f.io)(P, U));
  ok(e instanceof Error && !(e instanceof Aborted),
    "rename 失败照样抛错（不能吞掉，调用方要知道这个素材没下来）");
  ok(f.log.includes(`remove:${DEST}.part`),
    "rename 失败路径删掉 .part（否则永久留在用户盘上：复用只认 dest，没人会再碰它）");
}

{
  const f = fake({ failWrite: true });
  await caught(makeEnsureCached(f.io)(P, U));
  ok(f.log.includes(`remove:${DEST}.part`), "write 失败路径同样删 .part");
}

{
  const f = fake({ bytes: 0 });
  const e = await caught(makeEnsureCached(f.io)(P, U));
  ok(e instanceof Error && /下载为空/.test(e.message),
    "下到空响应直接报错（说人话，不是 rename 失败那种二手错误）");
  ok(!f.log.some((l) => l.startsWith("write:")),
    "空响应一个字节都不写进缓存（写进去就是上面那条「永远取不到」的成因）");
}

{
  // 取消必须以 `Aborted` 的形态到达调用方：`App.tsx:732` 靠 `e.name === "Aborted"`
  // 决定静默收场还是弹红框，拿到 DOMException("AbortError") 就会弹
  // 「导出失败：AbortError」。
  //
  // ⚠️ 这条断言一开始写在「fetch 抛 AbortError → 归一化」上，变异测试当场逮到它
  //    **在装饰而非承重**：把 `download` 里那两句归一化全删掉，断言照样绿。
  //    实测原因是引用计数下 `ctl.abort()` 只在等待者归零时发生，那一刻取消者
  //    早已被 `attach` 里的 `reject(new Aborted())` 打发走了 —— 承重的是 attach。
  //    所以断言改成钉「无论 fetch 抛什么，取消者拿到的都是 Aborted」，
  //    并额外用一个**根本不认 signal**的 fetch 实现把 download 那条路彻底堵死。
  const ctl = new AbortController();
  const f = fake({ fetchThrows: () => new Error("连 signal 都不认的实现") });
  const p = makeEnsureCached(f.io)(P, U, ctl.signal);
  ctl.abort();
  const e = await caught(p);
  ok(e instanceof Aborted,
    "取消者拿到的是 Aborted 本身（不是 AbortError，也不是底层的网络错误）");
}

{
  // ⚠️ 反向：**没取消**时的网络错误绝不能被伪装成「用户已取消」——
  // 那会让真正的失败被 App.tsx 静默吞掉，用户以为自己点了取消。
  const f = fake({ fetchThrows: () => new Error("素材下载失败 502: x") });
  const e = await caught(makeEnsureCached(f.io)(P, U));
  ok(e instanceof Error && !(e instanceof Aborted) && /502/.test(e.message),
    "没取消时的网络错误原样抛出，不冒充 Aborted");
}

{
  const ctl = new AbortController();
  ctl.abort();
  const f = fake();
  const e = await caught(makeEnsureCached(f.io)(P, U, ctl.signal));
  ok(e instanceof Aborted && f.log.length === 0,
    "进门就已取消 → 立刻 Aborted，连缓存目录都不去建（实测 I/O 调用 0 次）");
}

/* ── 单飞与引用计数取消：6.1 新增的性质，源码 grep 天生盖不到 ── */

{
  // 6.2 一上，预览与「AI 产物即时落盘」会在同一瞬间要同一个素材。
  // 没有单飞时：下载两遍 → 两次写同一个 .part → 后到的 rename 对着一个
  // 已经不存在的 .part → 调用方收到一个**假的**「素材下载失败」。
  const f = fake({ gate: true });
  const ec = makeEnsureCached(f.io);
  const a = ec(P, U);
  const b = ec(P, U);
  await tick();
  ok(f.fetches.length === 1, `同一素材并发两次 → 只下载一次（实测 ${f.fetches.length} 次）`);
  f.release();
  const [ra, rb] = await Promise.all([a, b]);
  ok(ra === DEST && rb === DEST, "两个调用方拿到同一个绝对路径，且都成功");
  ok(f.log.filter((l) => l.startsWith("rename:")).length === 1,
    "只发生一次 rename（没有单飞时这里是 2 次，第 2 次必炸）");
}

{
  const f = fake({ gate: true });
  const ec = makeEnsureCached(f.io);
  const V = "/fw/media/proj-1/shot-008/output.mp4";
  void ec(P, U); void ec(P, V); void ec("proj-2", U);
  await tick();
  ok(f.fetches.length === 3,
    "合流只发生在同 project + 同素材之间（不同素材 / 不同项目各走各的）");
}

{
  // 取消要按「还有没有人在等」算。把发起者的 signal 直接交给 fetch 的写法，
  // 会让**搭车的人**跟着遭殃：预览取消了，正在等同一素材的导出也失败。
  const f = fake({ gate: true });
  const ec = makeEnsureCached(f.io);
  const c1 = new AbortController();
  const p1 = ec(P, U, c1.signal);
  const p2 = ec(P, U);
  await tick();
  c1.abort();
  const e1 = await caught(p1);
  ok(e1 instanceof Aborted, "取消的那一个立刻收到 Aborted，不用等下载结束");
  ok(f.signals[0].aborted === false,
    "还有人在等 → 底层那条下载**没有**被掐（搭车者不该被别人的取消连累）");
  f.release();
  ok(await p2 === DEST, "没取消的那一个照常拿到文件");
}

{
  // 反过来：一个都不剩了还不掐 fetch，就成了「点了取消要等这批素材全部下完」，
  // 慢网下一个大素材就是几十秒的"点了没反应"。
  const f = fake({ gate: true });
  const ec = makeEnsureCached(f.io);
  const c1 = new AbortController(), c2 = new AbortController();
  const p1 = ec(P, U, c1.signal), p2 = ec(P, U, c2.signal);
  await tick();
  c1.abort(); c2.abort();
  ok(await caught(p1) instanceof Aborted && await caught(p2) instanceof Aborted,
    "两个等待者都取消 → 两边都是 Aborted");
  ok(f.signals[0].aborted === true,
    "等待者归零 → 底层 fetch 被 abort（不掐就是「点了取消没反应」）");

  // 已经被掐掉的那一班不能再上人：它必然以 Aborted 收场，
  // 新来的人明明没取消，却会拿到一个「用户已取消」。
  const p3 = ec(P, U);
  await tick();
  ok(f.fetches.length === 2, "取消之后新发起的调用另起一班下载，不去搭那班已经掐掉的车");
  f.release(1);
  ok(await p3 === DEST, "新来的这一个正常成功（不会莫名其妙收到「用户已取消」）");
}

{
  // 飞行表必须在结束后清掉，否则第二次调用会拿到一个早就 settled 的旧 promise，
  // 缓存被外部清掉（用户点了「清空本机缓存」）之后就再也下不回来了。
  const f = fake();
  const ec = makeEnsureCached(f.io);
  await ec(P, U);
  f.disk.delete(DEST);
  await ec(P, U);
  ok(f.fetches.length === 2,
    "上一次飞行结束后表已清空：缓存被清掉后同一素材能重新下载");
}

/* ── 结构：规则确实只有一份，且住在能被真跑的地方 ── */

ok(/export const ensureCached = makeEnsureCached\(tauriIO\);/.test(MEDIACACHE)
  && !/const part = `\$\{dest\}\.part`/.test(MEDIACACHE),
  "mediaCache 只剩接线（`makeEnsureCached(tauriIO)`），落地规则一行都不留在这边",
);
const CF_CODE = CACHEFETCH.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
ok(!/\bimport\b[^\n]*(\.\.\/api|@tauri-apps)/.test(CF_CODE),
  "cacheFetch 保持纯净（不 import api / tauri），本脚本才能真跑它而不是 grep 它");
ok(/const bytes = await io\.fetch\(/.test(CF_CODE) && /await io\.rename\(part, dest\)/.test(CF_CODE),
  "cacheFetch 的一切副作用都经注入的 io（没有偷偷直连的 fs/fetch）");
/* ── 统计 / 清理：这三个直接调 plugin-fs 的 readDir，仍用源码断言（理由见文件头） ── */

const sweepBody = MEDIACACHE.slice(
  MEDIACACHE.indexOf("export async function sweepParts"),
  MEDIACACHE.indexOf("export interface LocalCacheStats"));
ok(/\.endsWith\("\.part"\)/.test(sweepBody),
  "sweepParts 只删 .part，不碰正常缓存文件");

const clearBody = MEDIACACHE.slice(MEDIACACHE.indexOf("export async function clearLocalCache"));
ok(/if \(!proj\.isDirectory\) continue;/.test(clearBody),
  `clearLocalCache 只删项目子目录 → 根下的 ${CAPS_CACHE_NAME} 得以保留（删它要付 1.2~4s 重探）`);
ok(!new RegExp(CAPS_CACHE_NAME.replace(".", "\\.") + '"\\s*\\)').test(clearBody),
  "clearLocalCache 没有任何一条会点名删掉能力缓存的路径");
const statsBody = MEDIACACHE.slice(
  MEDIACACHE.indexOf("export async function localCacheStats"),
  MEDIACACHE.indexOf("export async function clearLocalCache"));
ok(/if \(!proj\.isDirectory\) continue;/.test(statsBody),
  "localCacheStats 同样只统计项目子目录，能力缓存不计入「素材占用」");
ok(/out\.parts\+\+/.test(statsBody) && /parts: number/.test(MEDIACACHE),
  ".part 残留单列一项统计（它属于「本不该存在」的那部分）");

// ───────────────────────────────────────────────────────────── ⑤
console.log("\n⑤ Aborted 的契约（改一个字符串就会天天弹红框）");

ok(new Aborted().name === "Aborted", 'Aborted.name 恒为 "Aborted"');
ok(new Aborted() instanceof Error, "Aborted 是 Error 子类（instanceof 判定要成立）");
ok(/e instanceof Error && e\.name === "Aborted"/.test(APP),
  "App.tsx 靠 name 判定「用户取消」并静默收场——这就是上一条的消费者");
ok(/export \{ Aborted \};/.test(RENDERER),
  "renderer 仍 re-export Aborted（挪到 lib 只为断环，对外符号不变）");
// 6.1 起 Aborted 的消费方从 mediaCache 变成了 cacheFetch（落地规则搬过去了），
// 但要守的性质一字未变：**只有一处定义，且缓存这边不反向 import renderer**
// （反向 import = mediaCache ↔ renderer 成环）。所以断言跟着规则走，而不是跟着文件走。
ok(/from "\.\/aborted"/.test(CACHEFETCH) && !/class Aborted/.test(RENDERER)
  && !/from "\.\.\/render\/renderer"/.test(MEDIACACHE)
  && !/from "\.\.\/render\/renderer"/.test(CACHEFETCH),
  "Aborted 只有一处定义，缓存侧不反向 import renderer（否则成环）");

// ───────────────────────────────────────────────────────────── ⑥
console.log("\n⑥ 设置页：一个只增不减的目录必须有数字和入口");

// 只 grep 函数名会被 import 那一行顶掉（变异测试逮到过）：要钉的是**调用点**。
ok(/localCacheStats\(\)\.then\(setLocal\)|await localCacheStats\(\)/.test(SETTINGS),
  "设置页真的去拉了本机统计，而不是只 import 了函数名");
ok(/const r = await clearLocalCache\(\);/.test(SETTINGS),
  "清空按钮真的调 clearLocalCache（一个只增不减的目录必须有出口）");
ok(/setLocal\(await localCacheStats\(\)\)/.test(SETTINGS),
  "清完立刻重新统计（不留一个已经不对的数字在屏幕上）");
ok(/local\.files/.test(SETTINGS) && /local\.bytes/.test(SETTINGS) && /local\.projects/.test(SETTINGS),
  "文件数 / 体积 / 项目数三个数字都展示（「本机缓存」不再是一句空话）");
ok(/local\.parts > 0/.test(SETTINGS),
  ".part 残留只在真有残留时才占一行（没残留时不吓用户）");
ok(/!IS_TAURI/.test(SETTINGS) || /tab !== "cache" \|\| !IS_TAURI/.test(SETTINGS),
  "只在桌面端拉本机统计（浏览器里没有 appDataDir，调了必抛）");
// 4.5 的新 UI 一律复用既有 class。这里不猜"哪些是新的"，直接要求本文件用到的
// 每一个 fw-set-* 都在同目录 CSS 里有定义——与 verify-css-coverage 同口径，
// 但把失败点提前到本条目自己的脚本里，改坏了当场知道是谁改的。
const SETTINGS_CSS = read("features/settings/SettingsDialog.css");
const used = [...new Set((SETTINGS.match(/fw-set-[\w-]+/g) ?? []))];
const missing = used.filter((c) => !new RegExp(`\\.${c}\\b`).test(SETTINGS_CSS));
ok(used.length > 0 && missing.length === 0,
  `设置页用到的 ${used.length} 个 fw-set-* class 都有 CSS${missing.length ? "：缺 " + missing.join(",") : "（未引入无样式的新 class）"}`);

// ─────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} 本机素材缓存：${pass} ✅ / ${fail} ❌`);
if (fail > 0) process.exit(1);
