/**
 * scripts/verify-localroot.ts — 6.6 本地素材寻址
 *
 * 分四节：
 *   [1] 路径规范化：`..` / 重复分隔符 / 尾斜杠 / 盘符 / UNC / 相对路径
 *   [2] 归属判定：**前缀陷阱**、大小写、风格混用、根自身
 *   [3] 根列表与说人话：吸收父子、最深命中、三种读不到的原因
 *   [4] 接进导出：`localPath` 读不到时**绝不回退云端**，且身份串不互撞
 *
 * 为什么这一条值得单独一个脚本：6.6 的失败形态全是**静默**的。
 * 前缀判错、身份串撞车、悄悄回退到 `url` —— 没有一个会抛异常，
 * 用户只会拿到一条"看起来正常但内容不对"的成片。
 *
 * ⚠️ 本脚本**不验证安全性**。越权读盘由 Tauri fs 插件的 scope 在 Rust 侧拦，
 * 与这里断言了什么无关（见 `lib/localRoot.ts` 文件头）。这里验的是
 * 「挑对根」和「话说得对不对」。把它当安全测试用是误读。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addRoot, displayName, explainUnreachable, isUnder, isWindowsPath,
  normalizePath, removeRoot, rootFor, type LocalRoot,
} from "../src/lib/localRoot";
import {
  canReadLocal, forgetLocalRoot, getLocalRoots, grantLocalRoots,
  resetLocalRoots, subscribeLocalRoots,
} from "../src/lib/localRootStore";
import { mediaKey, prepareMedia, probeKey, type PrepIO } from "../src/render/exportPrep";
import type { RenderMedia, RenderPlan } from "../src/render/model";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};
const eq = (got: unknown, want: unknown, name: string) =>
  ok(Object.is(got, want), name, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// ───────────────────────────────────────────────────────────────────────
console.log("\n[1] 规范化");

eq(normalizePath("/a/b/c"), "/a/b/c", "POSIX 原样");
eq(normalizePath("/a/b/c/"), "/a/b/c", "去尾斜杠");
eq(normalizePath("/a//b///c"), "/a/b/c", "折叠重复分隔符");
eq(normalizePath("/a/./b"), "/a/b", "吃掉 . 段");
eq(normalizePath("/a/b/../c"), "/a/c", "消解 ..");
eq(normalizePath("/a/b/../.."), "/", "一路消解到根");
eq(normalizePath("/"), "/", "根本身");
eq(normalizePath("  /a/b  "), "/a/b", "两端空白不算路径的一部分");

// 这一条是**承重**的：把 `..` 夹到根（返回 "/"）看起来更宽容，实际是把
// `/a/../../etc/passwd` 悄悄扩大成 `/etc/passwd`。宁可判为不合法。
eq(normalizePath("/a/../../etc"), null, "..爬过根 → null（不夹到根，那是在扩大它指向的范围）");
eq(normalizePath("a/b"), null, "相对路径不收");
eq(normalizePath(""), null, "空串");
eq(normalizePath("   "), null, "全空白");
eq(normalizePath("./x"), null, "点开头的相对路径");

eq(normalizePath("C:\\a\\b"), "C:\\a\\b", "盘符路径");
eq(normalizePath("c:/a/b/"), "C:\\a\\b", "盘符大写 + 正斜杠归一 + 去尾斜杠");
eq(normalizePath("C:\\"), "C:\\", "盘根本身");
eq(normalizePath("C:\\a\\..\\b"), "C:\\b", "盘符路径消解 ..");
// 盘符**不是**一段目录，被 `..` 弹掉就成了别的机器/别的盘上的路径
eq(normalizePath("C:\\..\\x"), null, "..不许把盘符弹掉");
eq(normalizePath("\\\\srv\\share\\a\\"), "\\\\srv\\share\\a", "UNC");
eq(normalizePath("\\\\srv\\share\\a\\..\\..\\b"), null, "..不许把 UNC 的 share 弹掉");

ok(isWindowsPath("C:\\x") && isWindowsPath("c:/x") && isWindowsPath("\\\\srv\\sh\\x"),
  "盘符与 UNC 认作 Windows 风格");
// POSIX 下 `\` 是**合法文件名字符**：判成 Windows 会把一个文件名劈成两段目录
ok(!isWindowsPath("/tmp/a\\b"), "POSIX 路径里的反斜杠只是文件名的一部分，不据此判风格");
eq(normalizePath("/tmp/a\\b"), "/tmp/a\\b", "  于是它也不该被拆开");

// ───────────────────────────────────────────────────────────────────────
console.log("\n[2] 归属判定");

ok(isUnder("/data/mat/a.mp4", "/data/mat"), "子路径在根内");
ok(isUnder("/data/mat", "/data/mat"), "根自身算在内");
ok(isUnder("/data/mat/", "/data/mat"), "尾斜杠不影响");
ok(isUnder("/data/mat/x/y/z.mp4", "/data/mat"), "深层子路径");
ok(isUnder("/a", "/"), "根目录 / 覆盖一切（拼分隔符时不会拼出 //）");

// ★ 前缀陷阱：裸 startsWith 会把它判成 true
ok(!isUnder("/data/mat-secret/a.mp4", "/data/mat"), "前缀陷阱：/data/mat-secret 不在 /data/mat 内");
ok(!isUnder("/data/material", "/data/mat"), "  同一类：material 不在 mat 内");
ok(!isUnder("/data", "/data/mat"), "父目录不在子目录内");
ok(!isUnder("/other/a", "/data/mat"), "毫不相干");
ok(!isUnder("/data/mat/../../etc/x", "/data/mat"), "先规范化再判：..爬出去的不算在内");

ok(isUnder("C:\\Media\\X\\a.mp4", "c:\\media"), "Windows 大小写不敏感");
ok(isUnder("C:\\media", "C:\\"), "盘根覆盖整盘（同样不会拼出 C:\\\\）");
ok(!isUnder("C:\\media2\\a", "C:\\media"), "Windows 也有前缀陷阱");
ok(!isUnder("/data/MAT/a", "/data/mat"), "POSIX 大小写敏感");
ok(!isUnder("C:\\data\\a", "/data"), "风格混用一律不算命中");
ok(!isUnder("/data/a", "C:\\data"), "  反向同理");
ok(!isUnder("relative/a", "/data"), "不合法入参 → false（不抛）");

// ───────────────────────────────────────────────────────────────────────
console.log("\n[3] 根列表 / 显示名 / 说人话");

const R = (p: string): LocalRoot => ({ path: p, label: p.split("/").pop()!, grantedAt: 1 });

{
  const roots = [R("/data/mat"), R("/data/mat/本季")];
  eq(rootFor("/data/mat/本季/e03.mp4", roots)?.path, "/data/mat/本季", "命中多个时取最深的那个");
  eq(rootFor("/data/mat/别的/e03.mp4", roots)?.path, "/data/mat", "只命中外层时取外层");
  eq(rootFor("/nope/x", roots), null, "都不命中");
}

{
  const roots = [R("/data/mat")];
  eq(displayName("/data/mat/a/b.mp4", roots), "a/b.mp4", "显示名是相对根的路径（不摊开绝对路径）");
  eq(displayName("/data/mat", roots), "mat", "根自身显示为它的 label");
  eq(displayName("/other/deep/c.mp4", roots), "c.mp4", "不在任何根内时退回文件名");
  eq(displayName("不是路径", roots), "不是路径", "不合法时原样返回，不崩");
}

{
  // 空列表起步，逐步登记
  let rs = addRoot([], "/data/mat/", 100);
  eq(rs.length, 1, "登记一个根");
  eq(rs[0].path, "/data/mat", "  存的是规范化后的路径");
  eq(rs[0].label, "mat", "  label 取末段目录名");
  eq(rs[0].grantedAt, 100, "  记下授权时刻");

  const before = rs;
  rs = addRoot(rs, "/data/mat/本季", 200);
  eq(rs.length, 1, "已被覆盖的子目录不重复登记");
  eq(before.length, 1, "  addRoot 不改入参（返回新数组）");
  // 光看长度不够：`return roots` 与 `return [...roots]` 在长度上没有区别，
  // 而前者把调用方的数组**别名**了出去 —— 调用方按"这是我的了"往里 push，
  // 就会改到 React state 里那个数组，UI 不刷新且下次比对认不出变化。
  // 三条 no-op 路径都要钉，它们各自 return 一次。
  ok(rs !== before, "  ★ 覆盖分支返回的是新数组，不是入参本身");
  ok(addRoot(before, "相对路径", 500) !== before, "  ★ 非法路径分支同样返回新数组");
  ok(addRoot(before, "/data/mat", 500) !== before, "  ★ 重复登记同一个根也返回新数组");
  ok(removeRoot(before, "不是路径") !== before, "  ★ removeRoot 的非法入参分支也是");

  rs = addRoot(rs, "/data/mat2", 300);
  eq(rs.length, 2, "不相干的新根照常登记");

  // 吸收：留着父子两条会让人以为撤销子条就收回了权限，实际没有
  rs = addRoot(rs, "/data", 400);
  eq(rs.length, 1, "新根覆盖旧根时把旧根吸收掉");
  eq(rs[0].path, "/data", "  留下的是那个更大的根");

  eq(addRoot(rs, "相对路径", 500).length, 1, "不合法路径不登记");
  eq(removeRoot(rs, "/data/").length, 0, "撤销按规范化后的路径匹配");
  eq(removeRoot(rs, "/data/mat").length, 1, "撤销子目录不会误删父根");
}

{
  const roots = [R("/data/mat")];
  const inScope = explainUnreachable("/data/mat/a.mp4", roots, true);
  eq(inScope.kind, "missing", "根内读不到 = 文件真的没了");
  ok(inScope.message.includes("移动") && inScope.message.includes("a.mp4"),
    "  提示说的是去找文件（重选目录没用）");

  const out = explainUnreachable("/elsewhere/b.mp4", roots, true);
  eq(out.kind, "outofscope", "根外 = 不在授权范围");
  ok(out.message.includes("添加素材目录"), "  提示说的是把它所在文件夹选进来");

  // 这一条是 6.6 最要紧的一句话：**每次重启后都会发生**，
  // 不说清"这是正常的"，用户会以为项目损坏了。
  const fresh = explainUnreachable("/elsewhere/b.mp4", [], false);
  eq(fresh.kind, "outofscope", "本次启动一个根都没授权时也是 outofscope");
  ok(fresh.message.includes("正常") && fresh.message.includes("重新选"),
    "  且明说这是正常现象、重选一次即可（不是项目坏了）");
  ok(fresh.message !== out.message, "  与「选错了目录」是两句不同的话");

  eq(explainUnreachable("", roots, true).kind, "badpath", "空路径 = 脏数据");
  eq(explainUnreachable("../x", roots, true).kind, "badpath", "相对路径 = 脏数据");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[4] 接进导出：读不到本地素材时**绝不回退云端**");

interface Rec { peek: string[]; fetch: string[]; statLocal: string[]; probe: string[] }
function mkIO(o: {
  cache?: Record<string, number>;
  localDisk?: Record<string, number>;
  noStatLocal?: boolean;
  table?: Record<string, boolean>;
  audio?: Record<string, boolean>;
}): { io: PrepIO; rec: Rec; saved: () => Record<string, boolean> | null } {
  const rec: Rec = { peek: [], fetch: [], statLocal: [], probe: [] };
  const cache = { ...(o.cache ?? {}) };
  let saved: Record<string, boolean> | null = null;
  const io: PrepIO = {
    peek: async (url) => {
      rec.peek.push(url);
      return cache[url] == null ? null : { path: `/cache/${url}`, size: cache[url] };
    },
    fetch: async (url) => { rec.fetch.push(url); cache[url] = 7; return `/cache/${url}`; },
    probeAudio: async (p) => { rec.probe.push(p); return o.audio?.[p] ?? true; },
    loadProbes: async () => ({ ...(o.table ?? {}) }),
    saveProbes: async (t) => { saved = t; },
    sweep: async () => 0,
    ...(o.noStatLocal ? {} : {
      statLocal: async (p: string) => {
        rec.statLocal.push(p);
        const s = (o.localDisk ?? {})[p];
        return s == null ? null : { size: s };
      },
    }),
  };
  return { io, rec, saved: () => saved };
}

const mkPlan = (media: RenderMedia[], videoIds: string[] = []): RenderPlan => ({
  width: 1080, height: 1920, fps: 30, durationSec: 5,
  media,
  tracks: videoIds.length
    ? [{
        id: "t1", kind: "video", hidden: false,
        clips: videoIds.map((id, i) => ({
          id: `c${i}`, mediaId: id, startSec: 0, endSec: 1, clipInSec: 0,
        })),
      }] as unknown as RenderPlan["tracks"]
    : [],
} as unknown as RenderPlan);

const LOCAL = "/data/mat/e01.mp4";
const ROOTS = [R("/data/mat")];

{
  // ① 本地素材在盘上 → 零下载、零 peek
  const { io, rec } = mkIO({ localDisk: { [LOCAL]: 4242 } });
  const plan = mkPlan([{ id: "m1", url: "", kind: "video", durationSec: 5, localPath: LOCAL }]);
  const r = await prepareMedia({
    plan, io, downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS,
  });
  eq(rec.fetch.length, 0, "本地素材不下载");
  eq(rec.peek.length, 0, "  也不去缓存目录里找（那儿本来就没有）");
  eq(rec.statLocal[0], LOCAL, "  走的是 statLocal");
  eq(r.paths.get("m1"), LOCAL, "  路径直接就是用户盘上那个文件");
  eq(r.stats.hits, 1, "  算作命中");
  eq(r.notices.length, 0, "  没有任何降级提示");
}

{
  // ② 必需的本地素材读不到 → **抛**，且**一次 fetch 都没发**
  const { io, rec } = mkIO({ localDisk: {} });
  const plan = mkPlan([
    { id: "m1", url: "https://cdn/e01.mp4", kind: "video", durationSec: 5, localPath: LOCAL },
  ]);
  let err: unknown = null;
  try {
    await prepareMedia({
      plan, io, downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS,
    });
  } catch (e) { err = e; }
  ok(err instanceof Error, "读不到必需的本地素材 → 抛错（不静默出片）");
  // ★★ 这是 6.6 全条最承重的一条断言 ★★
  // `url` 明明填着一个能下的地址，也**不许**去下：用户预览里看的是本地那份，
  // 云端那份未必是同一个文件，换了他不会知道。
  eq(rec.fetch.length, 0, "★ 即使 url 填着能下的地址也绝不回退去下载");
  ok(String((err as Error).message).includes("没找到"),
    "  错误信息是 explainUnreachable 那句人话（根内 → 让他去找文件）");
}

{
  // ③ 根外的本地素材，说的是另一句话
  const { io } = mkIO({ localDisk: {} });
  const plan = mkPlan([
    { id: "m1", url: "", kind: "video", durationSec: 5, localPath: "/elsewhere/x.mp4" },
  ]);
  let msg = "";
  try {
    await prepareMedia({ plan, io, downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS });
  } catch (e) { msg = String((e as Error).message); }
  ok(msg.includes("添加素材目录"), "根外读不到 → 让他把所在文件夹选进来");
}

{
  // ④ 不传 localRoots（老调用方）→ 得到"授权已释放"那句，且仍不回退
  const { io, rec } = mkIO({ localDisk: {} });
  const plan = mkPlan([
    { id: "m1", url: "https://cdn/e01.mp4", kind: "video", durationSec: 5, localPath: LOCAL },
  ]);
  let msg = "";
  try {
    await prepareMedia({ plan, io, downloadConcurrency: 4, probeConcurrency: 4 });
  } catch (e) { msg = String((e as Error).message); }
  ok(msg.includes("正常"), "没有任何授权根时说的是「授权已释放，这是正常的」");
  eq(rec.fetch.length, 0, "  仍然不回退去下载");
}

{
  // ⑤ IO 没实现 statLocal（4 个老 verify 脚本就是这样）→ 按读不到处理，不回退
  const { io, rec } = mkIO({ localDisk: { [LOCAL]: 1 }, noStatLocal: true });
  const plan = mkPlan([
    { id: "m1", url: "https://cdn/e01.mp4", kind: "video", durationSec: 5, localPath: LOCAL },
  ]);
  let threw = false;
  try {
    await prepareMedia({ plan, io, downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS });
  } catch { threw = true; }
  ok(threw, "PrepIO 没实现 statLocal 时按读不到处理");
  eq(rec.fetch.length, 0, "  仍然不回退去下载（可选字段不是回退的借口）");
}

{
  // ⑥ 装饰性素材（LUT）例外：给提示，片子照出，且**不去下 url**
  const { io, rec } = mkIO({ localDisk: {}, cache: { "https://cdn/a.mp4": 9 } });
  const plan = mkPlan([
    { id: "m1", url: "https://cdn/a.mp4", kind: "video", durationSec: 5 },
    { id: "lut", url: "https://cdn/x.cube", kind: "lut", durationSec: 0, localPath: "/data/mat/x.cube" },
  ]);
  const r = await prepareMedia({
    plan, io, downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS,
  });
  eq(r.notices.length, 1, "本地 LUT 读不到 → 一条降级提示");
  ok(r.notices[0].includes("没有套用它"), "  说清代价是少一层调色");
  ok(!rec.fetch.includes("https://cdn/x.cube"), "  但也不去下云端那份 LUT");
  eq(r.stats.hits, 1, "★ 读不到的 LUT 不算命中（否则「素材已在本地(2)」下面挂着降级提示，自相矛盾）");
}

{
  // ⑥b 同一件事在**另一条返回路径**上再验一遍。
  //
  // ⑥ 里没有任何视频轨 → 探测集为空 → 工作量为 0 → 走的是 `totalUnits === 0`
  // 那条**提前返回**。而 hits 在两条路径上是各算一次的（两处 return），
  // 只钉一条就会漏掉另一条 —— 第一轮变异正是这么逃掉的：
  // 把末尾那处 hits 改回旧公式，⑥ 全绿。
  const { io } = mkIO({ localDisk: {}, cache: { "https://cdn/a.mp4": 9 } });
  const plan = mkPlan([
    { id: "m1", url: "https://cdn/a.mp4", kind: "video", durationSec: 5 },
    { id: "lut", url: "https://cdn/x.cube", kind: "lut", durationSec: 0, localPath: "/data/mat/x.cube" },
  ], ["m1"]);   // ← 有视频轨 = 要探音轨 = 工作量非零 = 走末尾那条 return
  const r = await prepareMedia({
    plan, io, downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS,
  });
  eq(r.stats.probed, 1, "  这一路确实做了活（走的不是提前返回）");
  eq(r.stats.hits, 1, "★ 末尾那处 hits 同样不把读不到的 LUT 算进去");
  eq(r.notices.length, 1, "  降级提示照样给");
}

{
  // ⑦ 身份串：两条 url 同为空串的本地素材，字节数也相同 —— 绝不能撞成一个键
  const a: RenderMedia = { id: "a", url: "", kind: "video", durationSec: 1, localPath: "/data/mat/a.mp4" };
  const b: RenderMedia = { id: "b", url: "", kind: "video", durationSec: 1, localPath: "/data/mat/b.mp4" };
  ok(mediaKey(a) !== mediaKey(b), "本地素材的身份串取各自的绝对路径");
  ok(probeKey(mediaKey(a), 100) !== probeKey(mediaKey(b), 100),
    "★ 字节数相同也不撞键（撞了 = 无声视频拿到别人「有音轨」的结论 = 整段导出失败）");
  eq(mediaKey({ id: "c", url: "https://cdn/c.mp4", kind: "video", durationSec: 1 }),
    "https://cdn/c.mp4", "云端素材的身份串仍是 URL（老数据的键一个字没变）");

  // 真跑一遍：两条本地素材各自探测、各自入表
  const { io } = mkIO({
    localDisk: { "/data/mat/a.mp4": 100, "/data/mat/b.mp4": 100 },
    audio: { "/data/mat/a.mp4": true, "/data/mat/b.mp4": false },
  });
  const r = await prepareMedia({
    plan: mkPlan([a, b], ["a", "b"]), io,
    downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS,
  });
  eq(r.audio.get("a"), true, "  a 有音轨");
  eq(r.audio.get("b"), false, "  b 没有 —— 没有被 a 的结论顶掉");
}

{
  // ⑧ 本地素材的探测结论要**能存进表**，否则每次导出白探一遍
  const { io, saved } = mkIO({
    localDisk: { [LOCAL]: 555 }, audio: { [LOCAL]: false },
  });
  const one: RenderMedia = { id: "m1", url: "", kind: "video", durationSec: 5, localPath: LOCAL };
  await prepareMedia({
    plan: mkPlan([one], ["m1"]), io, downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS,
  });
  const t = saved();
  ok(t !== null && t[probeKey(LOCAL, 555)] === false,
    "本地素材的音轨结论按「路径+字节数」入表（键取自 statLocal 的字节数，不是缓存目录的）");

  // 第二次：命中表，不再探
  const second = mkIO({ localDisk: { [LOCAL]: 555 }, table: t ?? {} });
  const r2 = await prepareMedia({
    plan: mkPlan([one], ["m1"]), io: second.io,
    downloadConcurrency: 4, probeConcurrency: 4, localRoots: ROOTS,
  });
  eq(second.rec.probe.length, 0, "  第二次导出直接命中，不再拉 ffmpeg");
  eq(r2.audio.get("m1"), false, "  且结论正确");
  eq(r2.stats.probeHits, 1, "  统计如实记为探测命中");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[5] 会话内的授权登记簿（localRootStore）");

{
  resetLocalRoots();
  const seen: number[] = [];
  const off = subscribeLocalRoots(() => seen.push(getLocalRoots().length));

  eq(getLocalRoots().length, 0, "起步是空的（授权本来就不跨重启，不读 localStorage）");

  ok(grantLocalRoots(["/data/mat"], 100), "登记一个根 → 返回「变了」");
  eq(getLocalRoots()[0].path, "/data/mat", "  存的是规范化后的路径");
  eq(seen.length, 1, "  通知了一次");

  // ★ 这一条钉的是一个**只在真机上才现形**的错法：
  // `getLocalRoots` 是 useSyncExternalStore 的 getSnapshot，而 addRoot 每次都
  // 返回新数组。若无脑存回去，重复选同一个目录就会「快照每次都变」→ 反复重渲染
  // → 界面转死。node 里测不到 React，但**引用是否稳定**测得到，那正是根因。
  const snap = getLocalRoots();
  ok(!grantLocalRoots(["/data/mat"], 200), "重复登记同一个根 → 返回「没变」");
  ok(getLocalRoots() === snap, "  ★ 且快照引用**不变**（否则 useSyncExternalStore 会一直重渲染）");
  eq(seen.length, 1, "  也不发多余的通知");

  ok(!grantLocalRoots(["相对路径", ""], 300), "全是非法路径 → 没变、不通知");
  ok(getLocalRoots() === snap, "  引用同样不变");

  // 原生对话框可以多选，整批只该通知一次（逐个通知会让列表跳着长出来）
  ok(grantLocalRoots(["/a/one", "/a/two"], 400), "一次多选两个根");
  eq(getLocalRoots().length, 3, "  都登记上了");
  eq(seen.length, 2, "  ★ 整批只通知一次，不是每个根一次");

  // 吸收也走同一条 commit，只通知一次
  ok(grantLocalRoots(["/a"], 500), "再选它们的父目录");
  eq(getLocalRoots().length, 2, "  两个子根被吸收，只剩 /data/mat 与 /a");
  eq(seen.length, 3, "  仍然只通知一次");

  off();
  ok(grantLocalRoots(["/z"], 600), "退订后照常改动");
  eq(seen.length, 3, "  但不再通知已退订者");
  resetLocalRoots();
}

{
  // 「变没变」不能只看条数：选中某个根的**父目录**时，旧根被吸收、新根加入，
  // 条数一模一样而内容全变了。只比长度的话这一步会被判成"没变" ——
  // 于是不通知、界面还显示着那个已经被吸收掉的旧目录名。
  resetLocalRoots();
  let hits = 0;
  const off = subscribeLocalRoots(() => hits++);
  grantLocalRoots(["/data/mat/本季"], 100);
  const snap = getLocalRoots();
  ok(grantLocalRoots(["/data/mat"], 200), "★ 选父目录：条数不变但内容变了，必须判成「变了」");
  eq(getLocalRoots().length, 1, "  条数确实没变（所以只比长度会漏）");
  eq(getLocalRoots()[0].path, "/data/mat", "  留下的是父根");
  ok(getLocalRoots() !== snap, "  引用换了新的");
  eq(hits, 2, "  也通知了");
  off();
  resetLocalRoots();
}

{
  // 同一件事再往后一格：已有两个根，被吸收的是**第二个**。条数不变、
  // 头一条也没变，只有后面那条换了 —— 光比首项同样会漏（列表上留着的
  // 还是那个已被吸收掉的子目录名）。用户先选 A、再选 B\子、最后选 B 就是这条路径。
  resetLocalRoots();
  let hits = 0;
  const off = subscribeLocalRoots(() => hits++);
  grantLocalRoots(["/vol/a", "/vol/b/本季"], 100);
  eq(getLocalRoots().length, 2, "两个不相干的根");
  ok(grantLocalRoots(["/vol/b"], 200), "★ 被吸收的是第二条时也要判成「变了」");
  eq(getLocalRoots().length, 2, "  条数还是 2");
  eq(getLocalRoots()[0].path, "/vol/a", "  第一条纹丝没动（所以只比首项也会漏）");
  eq(getLocalRoots()[1].path, "/vol/b", "  变的是第二条");
  eq(hits, 2, "  通知照发");
  off();
  resetLocalRoots();
}

{
  // canReadLocal：设置里那个「移出列表」是靠它才**真的**生效的
  resetLocalRoots();
  grantLocalRoots(["/data/mat"], 100);
  ok(canReadLocal("/data/mat/e01.mp4"), "根内的路径：本应用愿意读");
  ok(canReadLocal("/data/mat"), "  根自身也算");
  ok(!canReadLocal("/data/mat-secret/e01.mp4"), "  前缀陷阱在这里同样不许放行");
  ok(!canReadLocal("/elsewhere/e01.mp4"), "根外的路径：不读");
  ok(!canReadLocal("相对路径"), "非法路径：不读（不抛）");

  ok(forgetLocalRoot("/data/mat/"), "移出列表（按规范化路径匹配，尾斜杠不影响）");
  ok(!canReadLocal("/data/mat/e01.mp4"), "★ 移出之后本应用就真的不读了 —— 那个按钮不是摆设");

  const snap2 = getLocalRoots();
  ok(!forgetLocalRoot("/从来没登记过"), "移除不存在的根 → 返回「没变」");
  ok(getLocalRoots() === snap2, "  引用不变");
  resetLocalRoots();
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[6] 接线（源码断言）");
//
// 下面三个文件都**不能在 node 下 import**（React / @tauri-apps 插件），
// 所以只能读源码断言。这类断言最容易写成装饰，故每一条都对着一个
// **具体的、静默的**错法，而不是"确认这个词出现过"。

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

{
  const S = read("src/features/settings/SettingsDialog.tsx");
  const call = /await open\(\{[\s\S]*?\}\)/.exec(S)?.[0] ?? "";
  ok(/directory:\s*true/.test(call), "设置里的目录选择器用 directory: true");
  // ★ 少了 recursive，插件只把选中的那一层加进 scope，子目录里的素材全读不到；
  // 而用户选的通常正是素材根，片子躺在 `第01集/` 里 —— 表现是"选了也没用"。
  ok(/recursive:\s*true/.test(call), "★ 且带 recursive: true（否则子目录不在 scope 内）");
  ok(/multiple:\s*true/.test(call), "允许多选（一次把几个素材盘都选进来）");
  ok(/grantLocalRoots\(/.test(S), "选完登记进会话登记簿");
  ok(/forgetLocalRoot\(/.test(S), "列表项可以移出");
  // 文案不能把"移出列表"说成"撤销授权"：插件侧没有撤销 scope 的接口，
  // 系统层面的授权要到进程退出才释放。说成撤销就是骗人。
  ok(/关闭软件时才真正释放/.test(S), "★ 文案说清系统层面的授权要到关闭软件才释放");
  ok(/不是项目损坏/.test(S), "★ 也说清重启后读不到是正常现象");
}

{
  const R = read("src/render/renderer.ts");
  ok(/statLocal:/.test(R), "renderer 的 prepIO 实现了 statLocal");
  const fn = /statLocal:[\s\S]*?\n    \},/.exec(R)?.[0] ?? "";
  // ★ 不先问登记簿就 stat，「移出列表」按钮当场变成假的：
  // scope 只增不减，插件那边照样让你读。
  ok(fn.indexOf("canReadLocal") >= 0 && fn.indexOf("canReadLocal") < fn.indexOf("stat("),
    "★ 先问 canReadLocal 再碰盘（否则「移出列表」形同虚设）");
  ok(/isFile/.test(fn), "只认文件：目录也有 size，放过去会被当成素材喂给 ffmpeg");
  ok(/catch[\s\S]*?return null/.test(fn), "读不到返回 null 而不是抛（由 exportPrep 说人话）");
  ok(/localRoots:\s*getLocalRoots\(\)/.test(R), "把已授权的根传进 prepareMedia（决定提示说哪一句）");
}

{
  // node 可加载性是这两个文件的**前提**：一旦谁 import 了 @tauri-apps，
  // 本脚本连模块都加载不了，[1]~[5] 全部作废 —— 那不是"少测一点"，是全盘失效。
  for (const f of ["src/lib/localRoot.ts", "src/lib/localRootStore.ts"]) {
    ok(!/from "@tauri-apps/.test(read(f)), `${f} 不依赖 Tauri（保住 node 可验证性）`);
  }
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败");
process.exit(fail === 0 ? 0 : 1);
