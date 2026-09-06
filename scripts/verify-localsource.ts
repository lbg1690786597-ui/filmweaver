/**
 * verify-localsource.ts — 预览改走本地文件，云端 URL 降级为兜底（批次 6 / 6.3）
 *
 * ## 这条为什么必须真跑
 *
 * 6.3 的收益（预览零网络、scrubbing 不再每次走网络）很容易看出来，
 * 但它的**风险全是静默的** —— 出错时不报错，只是画面黑掉或者悄悄慢回去。
 * 三条最贵的，每条对应下面一段：
 *
 * 1. **回收掉正在播的 blob = 画面当场变黑，且没有任何报错。**
 *    这是本条目唯一会真正伤到用户的失败模式。② 段钉「钉住位」：
 *    被 `pin` 的那一个在任何回收路径上都活着；③ 段钉**连点竞态**下
 *    钉子落在屏幕上那一个身上，而不是最后返回的那一个。
 * 2. **「预览一次 = 静默下几百 MB」**。`resolve` 只读不写，
 *    盘上没有就**立刻**退回云端地址。这条一旦破掉，
 *    "随手点开素材库看一眼"就变成后台狂下 —— 正是 6.2 的基线设计要防的伤害。
 *    ① 段把 `probe` 返回 null 的路径全钉死，并断言**一次 read 都没发生**。
 * 3. **退化必须是"回到 6.3 之前"，不能是"坏掉"**。`resolve` 永不抛：
 *    probe 抛、read 抛、objectUrl 抛、认不出 MIME、空文件、超大文件 ——
 *    六条路都得原样返回 `io.remote(url)`。④ 段逐条钉。
 *
 * ## 为什么钉「MIME 认不出就不材料化」
 *
 * `<video>`/`<audio>` 认的是 Blob 自己的 `type`，**不嗅探内容**。
 * 造一个 `type: ""` 的 blob 塞进去的表现是**不报错、就是不播** ——
 * 比走云端更糟（云端至少 Content-Type 是对的）。所以认不出扩展名时
 * 必须走兜底，这是一条"宁可慢也不能坏"的取舍，⑤ 段钉它。
 *
 * ## 注入的是什么
 *
 * `lib/localSource.ts` 不 import 任何东西，与 `cacheName.ts` / `cacheFetch.ts` /
 * `prefetch.ts` 同一个理由：`mediaCache.ts` 必须 `import { api }`，
 * 而 `api.ts` 顶层读 `import.meta.env`，node 下 import 即抛。
 * 所以这里 import 到的是**产品里真正在跑的那一份规则**，
 * 只有 fs / URL.createObjectURL 换成了可控的假货。
 *
 * 跑法：npx tsx scripts/verify-localsource.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeLocalSources, mimeForUrl,
  type LocalSourceIO,
} from "../src/lib/localSource";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/**
 * 剥掉注释再断言「代码里没有 X」。
 *
 * 这不是洁癖：6.3 的注释里**逐字引用了被删掉的那些写法**
 * （`url.split("/").pop()`、`setPreviewUrl(api.mediaUrl(…))`），
 * 因为"删了什么、为什么删"正是那些注释的价值。
 * 直接对全文 grep 会把这些说明当成残留代码，断言永远红 ——
 * 而红得毫无信息量的断言，下一个人只会把它删掉。
 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const LOCALSOURCE = read("lib/localSource.ts");
const MEDIACACHE = read("lib/mediaCache.ts");
const USEPLAYER = read("hooks/usePlayer.ts");
const WAVEFORM = read("features/timeline/Waveform.tsx");
const PROBE = read("features/subtitles/probeSilence.ts");
const APP = read("App.tsx");

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`   ✅ ${msg}`); }
  else { fail++; console.log(`   ❌ ${msg}`); }
}
/** 钉**取值**而不是钉"性质"：数量错了要能一眼看出错成了什么样子 */
function check(msg: string, actual: unknown, expected: unknown, detail = "") {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { pass++; console.log(`   ✅ ${msg}`); return; }
  fail++;
  console.log(`   ❌ ${msg}`);
  console.log(`      期望 ${JSON.stringify(expected)}`);
  console.log(`      实际 ${JSON.stringify(actual)}`);
  if (detail) console.log(`      ${detail}`);
}

/**
 * 假的本地盘 + 假的 objectURL 工厂。
 *
 * `live` 是**当前没被 revoke 的 blob 地址集合** —— 这是本条目最重要的
 * 可观测量：`<video src>` 指向一个已 revoke 的地址就是黑屏。
 * 断言"没黑屏"的唯一办法是断言那个地址还在 `live` 里。
 */
function fakeIO(o: {
  disk?: Record<string, number>;          // url → 字节数
  enabled?: boolean;
  probeThrows?: boolean;
  readThrows?: boolean;
  objectUrlThrows?: boolean;
  revokeThrows?: boolean;
  holdProbe?: boolean;                    // probe 卡住，用来造竞态
} = {}) {
  const disk = o.disk ?? {};
  const live = new Set<string>();
  let seq = 0;
  const calls = { probe: 0, read: 0, objectUrl: 0, revoke: 0, remote: 0 };
  const held: Array<() => void> = [];
  /** `releaseHeld()` 之后不再卡新的 probe —— 否则用完竞态还要再 resolve 一次
   *  （比如"逼一次回收"）就会永远挂着，而挂着 = 脚本超时 = 按失败记。 */
  let holding = !!o.holdProbe;
  const io: LocalSourceIO = {
    enabled: () => o.enabled ?? true,
    probe: async (projectId, url) => {
      calls.probe++;
      if (holding) await new Promise<void>((r) => held.push(r));
      if (o.probeThrows) throw new Error("probe 炸了");
      const size = disk[`${projectId}::${url}`] ?? disk[url];
      return size == null ? null : { path: `/fake/${projectId}/${url}`, size };
    },
    read: async (path) => {
      calls.read++;
      if (o.readThrows) throw new Error("read 炸了");
      const key = Object.keys(disk).find((k) => path.endsWith(k.split("::").pop()!));
      return new Uint8Array(disk[key!] ?? 0);
    },
    objectUrl: (bytes, mime) => {
      calls.objectUrl++;
      if (o.objectUrlThrows) throw new Error("createObjectURL 炸了");
      const u = `blob:fake/${++seq}?mime=${mime}&len=${bytes.length}`;
      live.add(u);
      return u;
    },
    revoke: (u) => {
      calls.revoke++;
      if (o.revokeThrows) throw new Error("revoke 炸了");
      live.delete(u);
    },
    remote: (u) => {
      calls.remote++;
      return `https://cdn.example/fw${u}`;
    },
  };
  const releaseHeld = () => { holding = false; for (const r of held.splice(0)) r(); };
  return { io, live, calls, releaseHeld };
}

const REMOTE = (u: string) => `https://cdn.example/fw${u}`;
const isBlob = (u: string) => u.startsWith("blob:");

// ═════════════════════════════════════════════════════════════
console.log("\n① 盘上没有就立刻走云端 —— **绝不为预览去下载**");
// ═════════════════════════════════════════════════════════════
{
  const { io, calls } = fakeIO({ disk: {} });        // 空盘
  const ls = makeLocalSources(io);
  const got = await ls.resolve("p1", "/media/a.mp4");
  check("盘上没有 → 返回云端地址", got, REMOTE("/media/a.mp4"));
  check("  一次 read 都没发生（这就是「不下载」的全部含义）", calls.read, 0);
  check("  一个 blob 都没造", calls.objectUrl, 0);
  check("  stats().remote 记了一次", ls.stats().remote, 1);
  check("  stats().materialized 仍是 0", ls.stats().materialized, 0);
}
{
  // 探到了、但是个 0 字节文件（磁盘满 / 写了一半被杀留下的壳）。
  // 这种也必须走云端：把 0 字节喂给 <video> 是"不报错、就是不播"。
  const { io, calls } = fakeIO({ disk: { "/media/a.mp4": 0 } });
  const ls = makeLocalSources(io);
  check("盘上是 0 字节 → 走云端", await ls.resolve("p1", "/media/a.mp4"),
    REMOTE("/media/a.mp4"));
  check("  没去 read 它", calls.read, 0);
}
{
  // 超过单文件上限：一部 500 MB 成片全量读进内存不如让 <video> 走 range 请求，
  // 后者可以边下边播、只取正在看的那一段。
  const { io, calls } = fakeIO({ disk: { "/media/big.mp4": 200 * 1024 * 1024 } });
  const ls = makeLocalSources(io, { maxFileBytes: 96 * 1024 * 1024 });
  check("超过 maxFileBytes → 走云端", await ls.resolve("p1", "/media/big.mp4"),
    REMOTE("/media/big.mp4"));
  check("  没读它（这正是设上限的意义：省的是内存，不是网络）", calls.read, 0);
}
{
  const { io } = fakeIO({ disk: { "/media/a.mp4": 1024 }, enabled: false });
  const ls = makeLocalSources(io);
  check("浏览器里（enabled=false）→ 走云端", await ls.resolve("p1", "/media/a.mp4"),
    REMOTE("/media/a.mp4"));
  check("  连 probe 都不问（plugin-fs 在浏览器里调了必抛）",
    (await (async () => { const f = fakeIO({ enabled: false }); const l = makeLocalSources(f.io); await l.resolve("p", "/x.mp4"); return f.calls.probe; })()), 0);
}
{
  const { io } = fakeIO({ disk: { "/media/a.mp4": 1024 } });
  const ls = makeLocalSources(io);
  check("空 url → 走云端（不 probe 一个空字符串）", await ls.resolve("p1", ""),
    REMOTE(""));
}
{
  const { io, calls } = fakeIO({ disk: { "p1::/media/a.mp4": 2048 } });
  const ls = makeLocalSources(io);
  const got = await ls.resolve("p1", "/media/a.mp4");
  ok(isBlob(got), "盘上有 → 返回 blob 地址（预览零网络）");
  check("  读了一次", calls.read, 1);
  check("  造了一个 blob", calls.objectUrl, 1);
  check("  stats().materialized = 1", ls.stats().materialized, 1);
  check("  stats().bytes 记的是真实字节数", ls.stats().bytes, 2048);
  check("  没有回落到云端", calls.remote, 0);
}

// ═════════════════════════════════════════════════════════════
console.log("\n② 钉住位：正在播的那一个永不被回收（否则画面当场变黑且无报错）");
// ═════════════════════════════════════════════════════════════
{
  // 总量 300 字节，三个各 200 字节 —— 每来一个都必然要回收。
  const { io, live } = fakeIO({
    disk: { "/a.mp4": 200, "/b.mp4": 200, "/c.mp4": 200 },
  });
  const ls = makeLocalSources(io, { maxFileBytes: 1000, maxLiveBytes: 300 });

  const a = await ls.resolve("p", "/a.mp4");
  ls.pin(a);                                   // a 正在播
  const b = await ls.resolve("p", "/b.mp4");
  const c = await ls.resolve("p", "/c.mp4");

  ok(live.has(a), "钉住的 a 在连来两个大文件之后**依然活着**（不黑屏）");
  check("  a 的地址仍是 blob（没被偷换成云端）", isBlob(a), true);
  ok(!live.has(b) || !live.has(c), "  未钉住的确实被回收了（上限是真生效的，不是摆设）");
  ok(ls.stats().evicted > 0, "  stats().evicted 记下了回收次数");
  check("  钉子指向 a 对应的那个 url", ls.stats().pinned, "/a.mp4");
}
{
  // 钉子挪走之后，老的那一个就该可以被回收了 —— 否则钉住位会变成内存泄漏点。
  const { io, live } = fakeIO({
    disk: { "/a.mp4": 200, "/b.mp4": 200, "/c.mp4": 200 },
  });
  const ls = makeLocalSources(io, { maxFileBytes: 1000, maxLiveBytes: 300 });
  const a = await ls.resolve("p", "/a.mp4");
  ls.pin(a);
  const b = await ls.resolve("p", "/b.mp4");
  ls.pin(b);                                   // 用户切到了 b
  await ls.resolve("p", "/c.mp4");
  ok(!live.has(a), "钉子挪到 b 之后，a 可以被回收（钉住位不是泄漏点）");
  ok(live.has(b), "  此刻在播的 b 活着");
}
{
  // 钉一个云端兜底地址（本地没命中时 resolve 返回的就是它）必须是**空操作**：
  // 那种情况下没有 blob 要保护，而盲目赋值会让 evict 找不到匹配项 =
  // 等于没有钉子，真正在播的那一个反而失去保护。
  const { io, live } = fakeIO({ disk: { "/a.mp4": 200, "/b.mp4": 200 } });
  const ls = makeLocalSources(io, { maxFileBytes: 1000, maxLiveBytes: 300 });
  const a = await ls.resolve("p", "/a.mp4");
  ls.pin(a);
  ls.pin(REMOTE("/nope.mp4"));                 // 云端地址：空操作
  check("  钉云端地址是空操作，钉子没被挪走", ls.stats().pinned, "/a.mp4");
  await ls.resolve("p", "/b.mp4");
  ok(live.has(a), "  于是 a 依然受保护（钉不上就保持原样，比盲目赋值安全）");
}
{
  // 钉子必须跟着被回收的条目一起消失。留着一个指向已回收条目的钉子，
  // 下次 evict 会拿它跟每个条目比、永远不相等 —— 等于悄悄失去保护。
  const { io } = fakeIO({ disk: { "/a.mp4": 200, "/b.mp4": 200, "/c.mp4": 200 } });
  const ls = makeLocalSources(io, { maxFileBytes: 1000, maxLiveBytes: 300 });
  const a = await ls.resolve("p", "/a.mp4");
  ls.pin(a);
  ls.release();
  check("release 之后钉子清零", ls.stats().pinned, null);
  const b = await ls.resolve("p", "/b.mp4");
  ls.pin(b);
  check("  重新钉得上（release 没把反查表弄脏）", ls.stats().pinned, "/b.mp4");
}
{
  // release() 是切项目那一下：全部回收、钉子清零。
  // 泄漏单位是一整个视频文件，这一句漏掉的代价按 GB 计。
  const { io, live } = fakeIO({ disk: { "/a.mp4": 200, "/b.mp4": 200 } });
  const ls = makeLocalSources(io, { maxLiveBytes: 10_000 });
  const a = await ls.resolve("p", "/a.mp4");
  ls.pin(a);
  await ls.resolve("p", "/b.mp4");
  check("release 前有 2 个活 blob", live.size, 2);
  ls.release();
  check("release 后一个不剩（切项目不泄漏）", live.size, 0);
  check("  钉子也清了", ls.stats().pinned, null);
  check("  live 计数归零", ls.stats().live, 0);
}
{
  // revoke 自己抛了不能把调用方带走：切项目正走到一半，
  // 抛出去会让 resetWorkspace 后面的清理（jobs / undo / store）全部不执行。
  const { io } = fakeIO({ disk: { "/a.mp4": 200 }, revokeThrows: true });
  const ls = makeLocalSources(io, { maxLiveBytes: 10_000 });
  await ls.resolve("p", "/a.mp4");
  let threw = false;
  try { ls.release(); } catch { threw = true; }
  ok(!threw, "revoke 抛错时 release 不抛（切项目的后续清理不能被它带走）");
  check("  账仍然平了（不能因为 revoke 失败就永远算它还占着）",
    ls.stats().bytes, 0);
}

// ═════════════════════════════════════════════════════════════
console.log("\n③ 连点竞态：钉子必须落在**屏幕上那一个**，不是最后返回的那一个");
// ═════════════════════════════════════════════════════════════
{
  // 这一段钉的是 `resolve` **不自作主张钉住自己**这条设计。
  // 理由：用户连点两个镜头，先发的可能后回；调用方（usePlayer）有代次号、
  // 会丢弃过期结果，此时屏幕上是后发的那个。若 resolve 顺手钉了自己，
  // 那个已被丢弃的结果就把钉子从正在播的身上抢走了 → 它可能被回收 → 黑屏。
  const { io, live, releaseHeld } = fakeIO({
    disk: { "/slow.mp4": 200, "/fast.mp4": 200, "/x.mp4": 200 },
    holdProbe: true,
  });
  const ls = makeLocalSources(io, { maxFileBytes: 1000, maxLiveBytes: 300 });

  const slow = ls.resolve("p", "/slow.mp4");     // 先点，卡住
  const fast = ls.resolve("p", "/fast.mp4");     // 后点
  releaseHeld();
  const [slowUrl, fastUrl] = await Promise.all([slow, fast]);

  // 调用方的行为：代次守卫丢弃 slow，只把 fast 交给 <video> 并 pin。
  ls.pin(fastUrl);
  check("竞态后钉子在**后点的那个**身上", ls.stats().pinned, "/fast.mp4");

  await ls.resolve("p", "/x.mp4");               // 逼一次回收
  ok(live.has(fastUrl), "  屏幕上的 fast 活着（这就是不黑屏）");
  ok(!live.has(slowUrl), "  被丢弃的 slow 可以被回收（它不该占着钉子）");
}
{
  // 两个组件同时预览同一段素材：只能造**一个** blob。
  // 造两个的话第一个永远没人 revoke —— 泄漏一整个视频文件。
  const { io, calls, live } = fakeIO({ disk: { "/a.mp4": 200 } });
  const ls = makeLocalSources(io, { maxLiveBytes: 10_000 });
  const [u1, u2] = await Promise.all([
    ls.resolve("p", "/a.mp4"),
    ls.resolve("p", "/a.mp4"),
  ]);
  check("同一 url 并发 resolve → 造出的 blob 数", calls.objectUrl, 1,
    "造两个的话第一个永远没人 revoke = 漏一整个视频文件");
  check("  两次拿到的是同一个地址", u1 === u2, true);
  check("  只有一个活 blob", live.size, 1);
}

// ═════════════════════════════════════════════════════════════
console.log("\n④ 退化是「回到 6.3 之前」，不是「坏掉」—— resolve 永不抛");
// ═════════════════════════════════════════════════════════════
for (const [name, opt] of [
  ["probe 抛", { probeThrows: true }],
  ["read 抛", { readThrows: true }],
  ["createObjectURL 抛", { objectUrlThrows: true }],
] as const) {
  const errs: string[] = [];
  const { io } = fakeIO({ disk: { "/a.mp4": 200 }, ...opt });
  const ls = makeLocalSources(io, { onError: (u) => errs.push(u) });
  let got = "";
  let threw = false;
  try { got = await ls.resolve("p", "/a.mp4"); } catch { threw = true; }
  ok(!threw, `${name} → resolve 不抛`);
  check(`  ${name} → 原样返回云端地址`, got, REMOTE("/a.mp4"));
  check(`  ${name} → onError 收到了通知（不是静默吞掉）`, errs, ["/a.mp4"]);
}
{
  // onError 自己炸了也不能把调用方带走 —— 它是用户塞进来的回调。
  const { io } = fakeIO({ disk: { "/a.mp4": 200 }, probeThrows: true });
  const ls = makeLocalSources(io, {
    onError: () => { throw new Error("回调自己炸了"); },
  });
  let threw = false;
  let got = "";
  try { got = await ls.resolve("p", "/a.mp4"); } catch { threw = true; }
  ok(!threw, "onError 抛错时 resolve 依然不抛");
  check("  仍然返回云端地址", got, REMOTE("/a.mp4"));
}
{
  // read 返回 0 长度（文件在 probe 与 read 之间被清理掉了）。
  const { io } = fakeIO({ disk: { "/a.mp4": 0 } });
  const ls = makeLocalSources(io);
  // probe 会先因 size<=0 挡掉；这里换一条：probe 说有 200，read 给 0 字节。
  const io2: LocalSourceIO = {
    ...io,
    probe: async () => ({ path: "/fake/a.mp4", size: 200 }),
    read: async () => new Uint8Array(0),
  };
  const ls2 = makeLocalSources(io2);
  check("read 回来是空的 → 走云端（空 blob 是「不报错就是不播」）",
    await ls2.resolve("p", "/a.mp4"), REMOTE("/a.mp4"));
  void ls;
}

// ═════════════════════════════════════════════════════════════
console.log("\n⑤ MIME：认不出就别材料化（媒体元素不嗅探内容）");
// ═════════════════════════════════════════════════════════════
check("mp4", mimeForUrl("/media/a.mp4"), "video/mp4");
check("带查询串也认得", mimeForUrl("/media/a.mp4?token=abc&x=1"), "video/mp4");
check("带 # 也认得", mimeForUrl("/media/a.mp4#t=3"), "video/mp4");
check("大写扩展名", mimeForUrl("/media/A.MP4"), "video/mp4");
check("mp3", mimeForUrl("/media/n.mp3"), "audio/mpeg");
check("wav", mimeForUrl("/media/n.wav"), "audio/wav");
check("png", mimeForUrl("/media/f.png"), "image/png");
check("jpeg", mimeForUrl("/media/f.jpeg"), "image/jpeg");
check("mov", mimeForUrl("/media/f.mov"), "video/quicktime");
check("没有扩展名 → 空串", mimeForUrl("/media/whatever"), "");
check("认不出的扩展名 → 空串", mimeForUrl("/media/f.xyz"), "");
// ⚠️ 这一条要用**表里有的**扩展名做例子。拿 `.gitignore` 试是测不出东西的：
// 它切出来的 "gitignore" 本来就不在表里，`dot <= 0` 写成 `dot < 0` 照样返回空串
// （变异测试实测逃逸）。`.mp4` 才逼得出那个边界。
check("点号开头的隐藏文件不算扩展名（哪怕后半段正好是已知类型）",
  mimeForUrl("/media/.mp4"), "");
check("目录里有点、文件名没点 → 空串", mimeForUrl("/a.b/c"), "");
{
  const { io, calls } = fakeIO({ disk: { "/media/f.xyz": 200 } });
  const ls = makeLocalSources(io);
  check("认不出 MIME → 走云端", await ls.resolve("p", "/media/f.xyz"),
    REMOTE("/media/f.xyz"));
  check("  连 probe 都省了（认不出就没必要问盘）", calls.probe, 0);
  check("  更不会造一个 type 为空的 blob", calls.objectUrl, 0);
}
{
  const { io } = fakeIO({ disk: { "/a.mp4": 200 } });
  const ls = makeLocalSources(io);
  const u = await ls.resolve("p", "/a.mp4");
  ok(u.includes("mime=video/mp4"), "材料化时 MIME 被正确带进 Blob（否则不播）");
}

// ═════════════════════════════════════════════════════════════
console.log("\n⑥ 环境项目：Waveform 那条链路只有 url，靠 setProject 定位");
// ═════════════════════════════════════════════════════════════
{
  const { io, calls } = fakeIO({ disk: { "p1::/n.mp3": 512 } });
  const ls = makeLocalSources(io);
  check("没 setProject 时 bytesForCurrent 返回 null（不猜项目）",
    await ls.bytesForCurrent("/n.mp3"), null);
  check("  也没去问盘", calls.probe, 0);
  ls.setProject("p1");
  const b = await ls.bytesForCurrent("/n.mp3");
  check("setProject 之后能拿到字节", b?.length ?? -1, 512);
  ls.setProject(null);
  check("setProject(null) 之后又回到 null（切项目不串台）",
    await ls.bytesForCurrent("/n.mp3"), null);
}
{
  // 拿错项目只会 miss，不会命中到别的素材 —— 因为文件名是 URL 的哈希（4.5）。
  // 这条性质是"环境项目"这个简化能成立的全部依据。
  const { io } = fakeIO({ disk: { "p1::/n.mp3": 512 } });
  const ls = makeLocalSources(io);
  ls.setProject("p2");
  check("项目对不上 → 拿不到（最坏退回走网络，绝不会拿到别的素材）",
    await ls.bytesForCurrent("/n.mp3"), null);
}
{
  // bytes() 不造 blob：波形只要字节喂给 decodeAudioData，
  // 造 blob 反而多一条要 revoke 的生命周期。
  const { io, calls, live } = fakeIO({ disk: { "p::/n.mp3": 512 } });
  const ls = makeLocalSources(io);
  const b = await ls.bytes("p", "/n.mp3");
  check("bytes() 拿到字节", b?.length ?? -1, 512);
  check("  但一个 blob 都没造", calls.objectUrl, 0);
  check("  于是没有任何要 revoke 的东西", live.size, 0);
}
{
  // 同一段音频在时间轴上会出现很多次（601 段 clip）。并发读必须合并，
  // 否则打开项目那一下会同时发起几百次读盘。
  const { io, calls } = fakeIO({ disk: { "p::/n.mp3": 512 } });
  const ls = makeLocalSources(io);
  const rs = await Promise.all([
    ls.bytes("p", "/n.mp3"), ls.bytes("p", "/n.mp3"), ls.bytes("p", "/n.mp3"),
  ]);
  check("同一 url 并发 bytes() → 只读一次盘（单飞）", calls.read, 1);
  check("  三次都拿到了字节", rs.map((r) => r?.length ?? -1), [512, 512, 512]);
}
{
  const { io, calls } = fakeIO({ disk: {}, enabled: false });
  const ls = makeLocalSources(io);
  ls.setProject("p1");
  check("浏览器里 bytesForCurrent 直接 null（走 fetch 兜底）",
    await ls.bytesForCurrent("/n.mp3"), null);
  void calls;
}
{
  // 读盘出错这条路 `bytes()` 有自己的一份（`readBytes` 里的 catch），
  // 与 `resolve` 的那份是**两段独立代码**。④ 段只钉了 `resolve` 那份，
  // 于是把这里的 `try { onError(…) } catch {}` 摘成裸调用曾经整个逃逸掉。
  //
  // 后果不是"波形没画出来"这么轻：`decode` 的 catch 会把这次失败**当成负结果
  // 缓存进 `PeakCache`**（`Waveform.tsx` 的 `PEAK_CACHE.set(url, null)`），
  // 于是那段音频**这辈子都不会再解**——一个用户自己塞进来的日志回调，
  // 把一段本来能画的波形永久变成了中线。
  const { io } = fakeIO({ disk: { "p::/n.mp3": 512 }, probeThrows: true });
  const ls = makeLocalSources(io, {
    onError: () => { throw new Error("回调自己炸了"); },
  });
  let threw = false;
  let got: Uint8Array | null | undefined;
  try { got = await ls.bytes("p", "/n.mp3"); } catch { threw = true; }
  ok(!threw, "bytes() 里 onError 抛错也不能带走调用方");
  check("  仍然是 null（调用方照旧走网络）", got ?? null, null);
  // 而且失败之后不能把单飞表堵住 —— 堵住等于「第一次失败后永远返回那次失败」。
  const { io: io2 } = fakeIO({ disk: { "p::/n.mp3": 512 } });
  const ls2 = makeLocalSources(io2, { onError: () => {} });
  await ls2.bytes("p", "/n.mp3");
  check("  失败/成功后单飞表都清干净了（下一次是真的重读）",
    (await ls2.bytes("p", "/n.mp3"))?.length ?? -1, 512);
}

// ═════════════════════════════════════════════════════════════
console.log("\n⑦ localBlob：跟踪要的是「有没有本地」的直问直答（6.5）");
// ═════════════════════════════════════════════════════════════
//
// 跟踪与预览的需求在这里是**反的**：预览拿不到本地也要照样能播，所以
// `resolve` 兜底到云端；而跟踪拿到云端地址是**跑不通的** —— 跨源 canvas 的
// `getImageData` 直接抛 SecurityError。若 `localBlob` 也顺手兜底，
// 跟踪就只能靠 `startsWith("blob:")` 猜自己拿到了什么，
// 而猜错的表现是一个从未见过的浏览器安全异常，不是「拿不到本地副本」。
{
  const { io, calls } = fakeIO({ disk: {} });          // 空盘
  const ls = makeLocalSources(io);
  check("盘上没有 → localBlob 给 null，**不是**云端地址",
    await ls.localBlob("p1", "/media/a.mp4"), null);
  check("  也没有记一次 remote（它压根没走兜底那条路）", ls.stats().remote, 0);
  check("  更没有去 read", calls.read, 0);
}
{
  const { io } = fakeIO({ disk: { "p1::/media/a.mp4": 2048 } });
  const ls = makeLocalSources(io);
  const got = await ls.localBlob("p1", "/media/a.mp4");
  ok(got !== null && isBlob(got), "盘上有 → 给 blob 地址");
  check("  与 resolve 拿到的是**同一个** blob（不会为跟踪再造一份）",
    await ls.resolve("p1", "/media/a.mp4"), got);
  check("  只造了一次", ls.stats().materialized, 1);
}
{
  // 跟踪不许抢预览器的钉子：整个应用只有一个 <video>，钉子是它的。
  // 抢了的后果是**预览器那一个失去保护**，被 LRU 回收 → 画面变黑且无报错。
  const { io } = fakeIO({ disk: { "p::/a.mp4": 1024, "p::/b.mp4": 1024 } });
  const ls = makeLocalSources(io);
  const a = await ls.resolve("p", "/a.mp4");
  ls.pin(a);
  await ls.localBlob("p", "/b.mp4");
  check("localBlob 不动钉子（钉子是预览器的）", ls.stats().pinned, "/a.mp4");
}
{
  // 认不出类型 / 超大文件这两条静默规则，localBlob 与 resolve 必须同款 ——
  // 它们共用 `materialize`，这里钉的就是"确实共用了"。
  const { io } = fakeIO({ disk: { "p::/x.bin": 1024, "p::/big.mp4": 200 * 1024 * 1024 } });
  const ls = makeLocalSources(io, { maxFileBytes: 96 * 1024 * 1024 });
  check("认不出扩展名 → null", await ls.localBlob("p", "/x.bin"), null);
  check("超过单文件上限 → null", await ls.localBlob("p", "/big.mp4"), null);
}
{
  // 读盘炸了也不许抛：跟踪的收场应当是「拿不到本地副本」这句人话，
  // 不是一个红色异常弹窗。
  const { io } = fakeIO({ disk: { "p::/a.mp4": 1024 }, readThrows: true });
  const ls = makeLocalSources(io, { onError: () => { } });
  check("read 抛 → null（不外泄异常）", await ls.localBlob("p", "/a.mp4"), null);
}
{
  const { io } = fakeIO({ disk: { "p::/a.mp4": 1024 } });
  const ls = makeLocalSources(io);
  check("没设过项目时 currentProject() 是 null", ls.currentProject(), null);
  check("  localBlobForCurrent 也直接 null（不拿 null 去 probe）",
    await ls.localBlobForCurrent("/a.mp4"), null);
  ls.setProject("p");
  check("setProject 之后 currentProject() 说得出是谁", ls.currentProject(), "p");
  ok(isBlob((await ls.localBlobForCurrent("/a.mp4"))!),
    "  localBlobForCurrent 用它定位并命中");
  ls.setProject(null);
  check("关项目后又回到 null", ls.currentProject(), null);
}
{
  // currentProject 的用途是让**调用方**去调 ensureCached（那是写操作，
  // 本模块只读不写）。所以它必须只是个读取器 —— 问一句不该有任何副作用。
  const { io, calls } = fakeIO({ disk: { "p::/a.mp4": 1024 } });
  const ls = makeLocalSources(io);
  ls.setProject("p");
  ls.currentProject(); ls.currentProject();
  check("currentProject 是纯读取：不 probe", calls.probe, 0);
  check("  不 read", calls.read, 0);
  check("  不造 blob", calls.objectUrl, 0);
}
{
  // 拿错项目只会 miss —— 缓存文件名是 URL 的哈希，不可能命中到别的素材。
  const { io } = fakeIO({ disk: { "p1::/a.mp4": 1024 } });
  const ls = makeLocalSources(io);
  ls.setProject("p2");
  check("项目对不上 → miss，而不是命中别人的素材",
    await ls.localBlobForCurrent("/a.mp4"), null);
}

// ═════════════════════════════════════════════════════════════
console.log("\n⑧ 接线：规则住在纯模块里，各处只有一条接线");
// ═════════════════════════════════════════════════════════════
ok(!/\bimport\b/.test(code(LOCALSOURCE)),
  "localSource.ts 一行 import 都没有（所以本脚本跑的是产品那一份规则，不是抄件）");
ok(/makeLocalSources\(localSourceIO\)/.test(MEDIACACHE),
  "mediaCache.ts 里只有一条接线，没有第二份规则");
ok(/remote: \(u\) => api\.mediaUrl\(u\)/.test(MEDIACACHE),
  "兜底走的是 api.mediaUrl（与 6.3 之前逐字一致，不是自己拼 URL）");
ok(/enabled: \(\) => IS_TAURI/.test(MEDIACACHE),
  "enabled 是 IS_TAURI：浏览器里 appDataDir() 调了必抛");
{
  // 只看 localSourceIO 这个对象字面量本身：`cacheDirFor` 在别处（sweepParts）
  // 是正当用法，整份文件 grep 会把它算进来 —— 那种红是断言写错了，不是代码错了。
  const m = code(MEDIACACHE);
  const i = m.indexOf("const localSourceIO");
  const body = m.slice(i, m.indexOf("\n};", i));
  ok(i > 0 && !/cacheDirFor/.test(body),
    "probe 不用 cacheDirFor（它会 mkdir：读操作不该留下写痕迹、空目录会让缓存统计虚高）");
  ok(/exists\(path\)/.test(body) && /stat\(path\)/.test(body),
    "  改成直接 exists + stat 探一下（与 cacheFetch 的复用判据同口径：存在且非空）");
}

// usePlayer：三处换源都走 swapSource，一处都不许漏。
check("usePlayer 里 swapSource 的调用点数量",
  (code(USEPLAYER).match(/swapSource\(/g) ?? []).length, 3,
  "onSelectShot / previewMedia / previewShotVersion 三处换源，一处都不许漏");
ok(!/setPreviewUrl\(api\.mediaUrl\(/.test(code(USEPLAYER)),
  "usePlayer 里再没有直接 setPreviewUrl(api.mediaUrl(…)) 的漏网之鱼");
ok(!/\bapi\./.test(code(USEPLAYER)),
  "usePlayer 不再用到 api（兜底已经收进 localSources）");
ok(/if \(my !== gen\.current\) return;/.test(USEPLAYER),
  "代次守卫在：连点两个镜头时过期结果整份作废");
ok(/localSources\.pin\(src\)/.test(USEPLAYER),
  "  拿到地址后钉住它（钉的是真正交给 <video> 的那一个）");
{
  const iGuard = USEPLAYER.indexOf("if (my !== gen.current) return;");
  const iPin = USEPLAYER.indexOf("localSources.pin(src)");
  const iSet = USEPLAYER.indexOf("setPreviewUrl(src)");
  ok(iGuard > 0 && iPin > iGuard && iSet > iGuard,
    "  pin 与 setPreviewUrl 都排在守卫之后（否则过期结果会抢钉子 / 抢画面）");
}
ok(/gen\.current\+\+;/.test(USEPLAYER),
  "clearPlayer 自增代次：切项目后在飞的 resolve 回来不会把预览器填回去");
{
  // key={previewUrl} 意味着换 src 就是换元素，所以必须**解析完再落 state**，
  // 不能先塞云端地址再偷偷换成 blob —— 那会让播到一半的画面从头重播。
  const swap = USEPLAYER.slice(USEPLAYER.indexOf("const swapSource"),
    USEPLAYER.indexOf("const onSelectShot"));
  check("swapSource 里 setPreviewUrl 只出现一次（不做中途换源）",
    (swap.match(/setPreviewUrl\(/g) ?? []).length, 1);
}

// Waveform：本地优先，但保留 fetch 兜底。
//
// ⚠️ 这里只能做源码断言（`.tsx` 在 node 下加载不了），所以要钉**整个分支**，
// 不能只钉「调了 bytesForCurrent」——把 `if (local)` 改成 `if (false && local)`
// 照样能通过那种断言，而行为已经悄悄退回每次走网络（变异测试实测逃逸过一次）。
{
  const c = code(WAVEFORM);
  ok(/const local = await localSources\.bytesForCurrent\(url\);\s*\n\s*if \(local\) \{/.test(c),
    "Waveform 先问本地，且**真的用**拿到的结果（钉的是分支，不是那一句调用）");
  ok(/return local\.slice\(\)\.buffer as ArrayBuffer;/.test(c),
    "  命中时直接返回本地字节（不再 fetch 一遍）");
  ok(/await fetch\(api\.mediaUrl\(url\)\)/.test(c),
    "  兜底仍是原来那句 fetch（拿不到本地就退回 6.3 之前）");
  const i = c.indexOf("bytesForCurrent");
  const j = c.indexOf("await fetch(api.mediaUrl(url))");
  ok(i > 0 && j > i, "  顺序是「先本地、后网络」");
}
ok(/local\.slice\(\)\.buffer/.test(code(WAVEFORM)),
  "喂给 decodeAudioData 的是独立 buffer（它会 detach 传进去的那块）");

// probeSilence：第四套缓存实现已经删掉。
ok(/ensureCached\(projectId, url\)/.test(PROBE),
  "probeSilence 改用 6.1 的 ensureCached");
ok(!/cacheAudio/.test(code(PROBE)),
  "  自带的 cacheAudio 已删除（代码里，注释里的说明保留）");
ok(!/url\.split\("\/"\)\.pop\(\)/.test(code(PROBE)),
  "  裸 basename 命名随之消失（那正是 4.5 挖掉的那套，会静默取到错的音频）");
ok(!/@tauri-apps\/plugin-fs/.test(code(PROBE)),
  "  不再自己碰 fs（少一处要维护的落盘路径）");

// App.tsx：切项目要清，进项目要设。
ok(/localSources\.release\(\);/.test(APP),
  "App.tsx 切项目时 release（blob 只有 revoke 才还内存，GC 管不着）");
ok(/localSources\.setProject\(projectId\)/.test(APP),
  "  用 effect 跟着 projectId 设环境项目（覆盖所有进项目的路径）");
{
  const iClear = APP.indexOf("clearPlayer();");
  const iRel = APP.indexOf("localSources.release();");
  ok(iClear > 0 && iRel > iClear,
    "  release 排在 clearPlayer 之后（<video> 的 src 已摘掉，回收谁都不黑屏）");
}
check("localSources.release() 只有一处调用点",
  (APP.match(/localSources\.release\(\)/g) ?? []).length, 1);

// ─────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} 预览改走本地文件：${pass} ✅ / ${fail} ❌`);
if (fail > 0) process.exit(1);
