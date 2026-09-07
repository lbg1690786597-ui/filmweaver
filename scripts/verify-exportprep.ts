/**
 * verify-exportprep.ts — 导出前的素材准备阶段（批次 6 / 6.4）
 *
 * ## 6.4 的字面需求是个空指令，真问题在它后面
 *
 * 文档写的是「`cacheMedia` 已返回 `Map<id, 绝对路径>`，本地素材直接 early-return」。
 * 而 6.1 落地的 `makeEnsureCached` **早就**在 `exists && size>0` 时零网络返回了——
 * 照字面做只会产出一个空提交。真正还在流血的是三处：
 *
 * 1. **进度条说谎**：不管命中与否都报 `下载素材 d/t`，并为**零工作量**吃掉 0→15%。
 *    6.2 之后全命中才是常态，也就是说每次导出都在演这一段。
 * 2. **音轨探测每次从头来**：每素材一个 `ffmpeg -i`，本机实测 **29.5 ms**，
 *    170 个素材 ≈ 5 秒纯等待，而结论本可以按内容寻址存下来。
 * 3. **LUT 从来没被下载过**：`lut3d=file=` 拿到的是 `/fw/media/...` 服务器地址，
 *    实测**整段导出失败**（退出码 1）。而 EffectsPanel 的 toast 写的是「导出即生效」。
 *
 * ## 这里每一段钉的是什么
 *
 * · ① 全命中：**一次 fetch 都不发**、**只报一次**进度、且那句话不含"下载"。
 *   这条是本条目对用户体验的全部承诺，也是最容易被后人"顺手改回去"的一条。
 * · ② 部分命中：只下缺的那些，进度按**工作量**走而不是按素材数，且单调不倒退。
 * · ③ 探测表：命中就不拉 ffmpeg；键含字节数，素材换内容自动失效；
 *   **探测失败（null）绝不写表** —— 这条是承重的，理由见 ④。
 * · ④ 失败语义：`probeAudio` 返回 null 时本次按「有音轨」继续（猜错代价不对称），
 *   但**不持久化**。若持久化，一次偶发的进程启动失败就会变成这个素材永久的
 *   错误结论，而错误的 `true` 在 composite 分支意味着映射一条不存在的 `[i:a]`，
 *   后果是**整段导出失败**（见 ffmpegCompiler 的注释）。一次性故障 → 永久性故障。
 * · ⑤ LUT：装饰性素材下载失败要降级 + 出 notice，而**必需素材**失败必须抛。
 * · ⑥ 并发：断言「在飞的数量不超过上限」，**不断言那个数字是 4** ——
 *   后者是把常量抄一遍（断言在装饰），且并发数归用户掌控，不该被测试钉死。
 * · ⑦ 取消：`signal` 一置位就抛 `Aborted`，不把剩下的批次跑完。
 * · ⑧ 真 ffmpeg：转义规则和 `.cube` 扩展名这两条，只有真跑才算数。
 *   含**反证**：不转义的路径必须失败，否则这个用例什么都没证明。
 *
 * ## 为什么能在 node 下真跑
 *
 * `render/exportPrep.ts` 只 import `model`（纯类型）/`aborted`/`cacheName`，
 * 一个都不碰 `api.ts`（那个文件顶层读 `import.meta.env`，node 下 import 即抛）。
 * 所以这里 import 到的是**产品里真正在跑的那份规则**，只有 fs / ffmpeg 换成假货。
 *
 * 跑法：npx tsx scripts/verify-exportprep.ts
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareMedia, probeKey, probeTargets, DOWNLOAD_WEIGHT, MAX_PROBE_ENTRIES,
  type PrepIO,
} from "../src/render/exportPrep";
import { escFilterPath, lutFilePath } from "../src/render/ffmpegCompiler";
import { cacheFileName } from "../src/lib/cacheName";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type { RenderPlan, RenderClip, RenderMedia } from "../src/render/model";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
/** 剥注释再 grep：6.4 的注释里逐字引用了被删掉的旧写法，直接全文 grep 会误报。 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`   ✅ ${msg}`); }
  else { fail++; console.log(`   ❌ ${msg}`); }
}
function check(msg: string, actual: unknown, expected: unknown, detail = "") {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++; console.log(`   ✅ ${msg}`); return;
  }
  fail++;
  console.log(`   ❌ ${msg}`);
  console.log(`      期望 ${JSON.stringify(expected)}`);
  console.log(`      实际 ${JSON.stringify(actual)}`);
  if (detail) console.log(`      ${detail}`);
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */
function clip(i: number, over: Partial<RenderClip> = {}): RenderClip {
  return {
    id: `c${i}`, mediaId: `m${i}`, timelineStartSec: i * 3, durationSec: 3,
    sourceInSec: 0, sourceDurationSec: 3, speed: 1,
    transform: { ...DEFAULT_TRANSFORM }, effects: [], audio: { ...DEFAULT_AUDIO },
    ...over,
  };
}

function mkPlan(o: {
  videoIds?: string[];
  audioIds?: string[];
  lutIds?: string[];
  hiddenVideoIds?: string[];
} = {}): RenderPlan {
  const v = o.videoIds ?? ["m0", "m1"];
  const a = o.audioIds ?? [];
  const l = o.lutIds ?? [];
  const h = o.hiddenVideoIds ?? [];
  const media: RenderMedia[] = [
    ...v.map((id) => ({ id, url: `/fw/media/p/${id}/output.mp4`, kind: "video" as const, durationSec: 3 })),
    ...h.map((id) => ({ id, url: `/fw/media/p/${id}/output.mp4`, kind: "video" as const, durationSec: 3 })),
    ...a.map((id) => ({ id, url: `/fw/media/p/${id}/voice.mp3`, kind: "audio" as const, durationSec: 3 })),
    ...l.map((id) => ({ id, url: `/fw/media/uploads/${id}.cube`, kind: "lut" as const, durationSec: 0 })),
  ];
  return {
    projectId: "proj1",
    media,
    tracks: [
      { id: "v1", kind: "video", layer: 1, muted: false, hidden: false,
        clips: v.map((id, i) => clip(i, { mediaId: id })) },
      ...(h.length ? [{ id: "v9", kind: "video" as const, layer: 2, muted: false,
        hidden: true, clips: h.map((id, i) => clip(50 + i, { mediaId: id })) }] : []),
      ...(a.length ? [{ id: "a1", kind: "audio" as const, layer: 0, muted: false,
        hidden: false, clips: a.map((id, i) => clip(90 + i, { mediaId: id })) }] : []),
    ],
    transitions: [], subtitles: [],
    output: { width: 1080, height: 1920, fps: 30, vcodec: "libx264", crf: 23, withAudio: true },
    totalSec: v.length * 3,
  };
}

/** 假的盘 + 假的 ffmpeg 探测。`calls` 是本脚本最重要的可观测量。 */
function fakeIO(o: {
  /** url → 字节数，代表"已经在盘上" */
  disk?: Record<string, number>;
  /** url → 有无音轨；缺省 true */
  audio?: Record<string, boolean>;
  /** 这些 url 的探测**失败**（返回 null） */
  probeFails?: string[];
  /** 这些 url 下载失败 */
  fetchFails?: string[];
  /**
   * 让假的 `fetch` **无视 signal**。默认 false（模拟 `ensureCached` 一路把
   * signal 带到 `fetch`）。设成 true 是为了单独钉住**批次级**的那道
   * `if (signal?.aborted) throw new Aborted()` —— 真实的 `ensureCached` 是
   * 单飞 + 引用计数取消的：一个已在飞的下载若还有别人在等，它**不会**因为
   * 我这边取消就中止。那种情况下唯一能让取消真正生效的就是批次级这道闸。
   */
  ignoreSignal?: boolean;
  table?: Record<string, boolean>;
  /** 下载出的字节数（决定探测键）；缺省 100 */
  dlSize?: number;
  saveThrows?: boolean;
} = {}) {
  const disk: Record<string, number> = { ...(o.disk ?? {}) };
  const calls = { peek: 0, fetch: 0, probe: 0, load: 0, save: 0, sweep: 0 };
  let saved: Record<string, boolean> | null = null;
  let inFlightFetch = 0, maxFetch = 0;
  let inFlightProbe = 0, maxProbe = 0;
  const io: PrepIO = {
    peek: async (url) => {
      calls.peek++;
      const size = disk[url];
      return size == null ? null : { path: `/cache/proj1/${cacheFileName(url)}`, size };
    },
    fetch: async (url, signal) => {
      calls.fetch++;
      inFlightFetch++; maxFetch = Math.max(maxFetch, inFlightFetch);
      await new Promise((r) => setTimeout(r, 1));
      inFlightFetch--;
      if (!o.ignoreSignal && signal?.aborted) {
        const e = new Error("aborted"); e.name = "Aborted"; throw e;
      }
      if (o.fetchFails?.includes(url)) throw new Error(`素材下载失败 404: ${url}`);
      disk[url] = o.dlSize ?? 100;
      return `/cache/proj1/${cacheFileName(url)}`;
    },
    probeAudio: async (path) => {
      calls.probe++;
      inFlightProbe++; maxProbe = Math.max(maxProbe, inFlightProbe);
      await new Promise((r) => setTimeout(r, 1));
      inFlightProbe--;
      const url = Object.keys(disk).find((u) => path.endsWith(cacheFileName(u)));
      if (url && o.probeFails?.includes(url)) return null;
      return url ? (o.audio?.[url] ?? true) : true;
    },
    loadProbes: async () => { calls.load++; return { ...(o.table ?? {}) }; },
    saveProbes: async (t) => {
      calls.save++;
      if (o.saveThrows) throw new Error("盘满了");
      saved = t;
    },
    sweep: async () => { calls.sweep++; return 0; },
  };
  return {
    io, calls, disk,
    get saved() { return saved; },
    get maxFetch() { return maxFetch; },
    get maxProbe() { return maxProbe; },
  };
}

const url = (id: string) => `/fw/media/p/${id}/output.mp4`;
const lutUrl = (id: string) => `/fw/media/uploads/${id}.cube`;

async function run(plan: RenderPlan, f: ReturnType<typeof fakeIO>, o: {
  signal?: AbortSignal;
  dl?: number; pr?: number;
} = {}) {
  const progress: Array<{ frac: number; stage: string }> = [];
  const res = await prepareMedia({
    plan, io: f.io,
    downloadConcurrency: o.dl ?? 4,
    probeConcurrency: o.pr ?? 4,
    signal: o.signal,
    onProgress: (p) => progress.push({ ...p }),
  });
  return { res, progress };
}

/* ================================================================== *
 * ① 全命中：一次 fetch 都不发，只报一次，且那句话不能是"下载"
 * ================================================================== */
console.log("\n① 全命中（6.2 之后的常态）");
{
  const plan = mkPlan({ videoIds: ["m0", "m1", "m2"] });
  const f = fakeIO({
    disk: Object.fromEntries(["m0", "m1", "m2"].map((i) => [url(i), 500])),
    table: Object.fromEntries(["m0", "m1", "m2"].map((i) => [probeKey(url(i), 500), true])),
  });
  const { res, progress } = await run(plan, f);
  check("一次网络请求都没发", f.calls.fetch, 0);
  check("一次 ffmpeg 探测都没拉起", f.calls.probe, 0);
  check("只报一次进度", progress.length, 1,
    "6.4 之前这里会为零工作量报 N 次并爬到 15%");
  check("报的是 frac=1（不占用进度条爬升）", progress[0]?.frac, 1);
  ok(!/下载/.test(progress[0]?.stage ?? ""),
    `进度文案不含「下载」（实际：「${progress[0]?.stage}」）`);
  ok(/已在本地/.test(progress[0]?.stage ?? ""), "  说的是实话：素材已在本地");
  check("路径表齐全", res.paths.size, 3);
  check("音轨结论来自表", [...res.audio.values()], [true, true, true]);
  check("stats.hits = 全部", res.stats.hits, 3);
  check("stats.probeHits = 全部", res.stats.probeHits, 3);
  check("表没被重写（命中路径零写盘）", f.calls.save, 0);
}

/* ================================================================== *
 * ② 部分命中：只下缺的；进度按工作量走且单调不倒退
 * ================================================================== */
console.log("\n② 部分命中");
{
  const plan = mkPlan({ videoIds: ["m0", "m1", "m2", "m3"] });
  const f = fakeIO({ disk: { [url("m0")]: 500, [url("m1")]: 500 } });
  const { res, progress } = await run(plan, f);
  check("只下缺的两个", f.calls.fetch, 2);
  check("四个素材都探了（表是空的）", f.calls.probe, 4);
  check("stats", [res.stats.total, res.stats.hits, res.stats.downloaded, res.stats.probed],
    [4, 2, 2, 4]);
  const fracs = progress.map((p) => p.frac);
  ok(fracs.every((v, i) => i === 0 || v >= fracs[i - 1]),
    `进度单调不倒退（${fracs.map((v) => v.toFixed(2)).join(" → ")}）`);
  check("最后一次是 1", fracs[fracs.length - 1], 1);
  ok(fracs.every((v) => v >= 0 && v <= 1), "  始终落在 [0,1]");
  // 下载权重承重：2 次下载 + 4 次探测，下载那 2 次应该占掉大部分进度
  const afterDownloads = progress.filter((p) => /下载素材 2\//.test(p.stage))[0];
  ok((afterDownloads?.frac ?? 0) > 0.7,
    `两个下载跑完时进度已过 70%（实际 ${((afterDownloads?.frac ?? 0) * 100).toFixed(0)}%）——`
    + `一次下载按 ${DOWNLOAD_WEIGHT} 次探测计`);
}

/* ================================================================== *
 * ③ 探测表：命中免探；键含字节数，换内容自动失效
 * ================================================================== */
console.log("\n③ 音轨探测表");
{
  const plan = mkPlan({ videoIds: ["m0", "m1"] });
  const f = fakeIO({
    disk: { [url("m0")]: 500, [url("m1")]: 500 },
    table: { [probeKey(url("m0"), 500)]: false },
    audio: { [url("m1")]: true },
  });
  const { res } = await run(plan, f);
  check("只探没记过的那一个", f.calls.probe, 1);
  check("命中的取表里的值（false）", res.audio.get("m0"), false);
  check("新探的写了表", f.calls.save, 1);
  ok(!!f.saved?.[probeKey(url("m1"), 500)], "  新结论进表了");
  ok(f.saved?.[probeKey(url("m0"), 500)] === false, "  老结论没被抹掉");
}
{
  // 素材换了内容（字节数变了）→ 旧键不再命中
  const plan = mkPlan({ videoIds: ["m0"] });
  const f = fakeIO({
    disk: { [url("m0")]: 777 },
    table: { [probeKey(url("m0"), 500)]: false },
    audio: { [url("m0")]: true },
  });
  const { res } = await run(plan, f);
  check("字节数变了就重探（内容寻址）", f.calls.probe, 1);
  check("拿到的是新结论而不是旧的 false", res.audio.get("m0"), true);
}
{
  // 反证：键若不含字节数，上一条就会静默取到旧结论
  ok(probeKey(url("m0"), 500) !== probeKey(url("m0"), 777),
    "反证：同 URL 不同字节数 → 不同的键");
  ok(probeKey(url("m0"), 500).startsWith(cacheFileName(url("m0"))),
    "  键的前半段就是缓存文件名（与盘上的命名同源）");
}

/* ================================================================== *
 * ④ 探测失败绝不写表 —— 一次性故障不能变成永久性故障
 * ================================================================== */
console.log("\n④ 探测失败的语义");
{
  const plan = mkPlan({ videoIds: ["m0", "m1"] });
  const f = fakeIO({
    disk: { [url("m0")]: 500, [url("m1")]: 500 },
    probeFails: [url("m0")],
    audio: { [url("m1")]: false },
  });
  const { res } = await run(plan, f);
  check("探测失败时本次按「有音轨」继续", res.audio.get("m0"), true,
    "猜错代价不对称：当作没有会静音成片，当作有则由 0:a:0? 兜住");
  ok(f.saved?.[probeKey(url("m0"), 500)] === undefined,
    "**失败的猜没有进表**（否则一次偶发失败 = 这个素材永久的错误结论）");
  ok(f.saved?.[probeKey(url("m1"), 500)] === false,
    "  同一批里成功的那条照常进表");
}
{
  // 全部探测都失败 → 一个字都不该写，连 save 都不该调
  const plan = mkPlan({ videoIds: ["m0"] });
  const f = fakeIO({ disk: { [url("m0")]: 500 }, probeFails: [url("m0")] });
  await run(plan, f);
  check("全失败时连 save 都不调（表没脏）", f.calls.save, 0);
}
{
  // 写表失败必须被吞掉：存不下只是下次慢一点
  const plan = mkPlan({ videoIds: ["m0"] });
  const f = fakeIO({ disk: { [url("m0")]: 500 }, saveThrows: true });
  const { res } = await run(plan, f);
  ok(res.paths.size === 1, "写表失败不影响导出（异常被吞）");
}

/* ================================================================== *
 * ⑤ LUT：装饰性素材降级，必需素材照旧抛
 * ================================================================== */
console.log("\n⑤ LUT 与降级边界");
{
  const plan = mkPlan({ videoIds: ["m0"], lutIds: ["lut0"] });
  const f = fakeIO({});
  const { res } = await run(plan, f);
  check("LUT 和视频一起下了", f.calls.fetch, 2);
  ok(res.paths.has("lut0"), "  LUT 拿到了本地路径");
  check("LUT **不探音轨**（拿 ffmpeg -i 读 .cube 是纯浪费）", f.calls.probe, 1);
}
{
  const plan = mkPlan({ videoIds: ["m0"], lutIds: ["lut0"] });
  const f = fakeIO({ fetchFails: [lutUrl("lut0")] });
  const { res } = await run(plan, f);
  ok(!res.paths.has("lut0"), "LUT 下载失败 → 没有路径");
  check("  但导出继续（不抛）", res.paths.has("m0"), true);
  check("  出一条面向用户的降级提示", res.notices.length, 1);
  // 文案已从「LUT」改成人话「调色文件」（用户不认识 LUT），判据跟着改，
  // 守的仍是同一件事：提示必须点明是哪一类素材没用上。
  ok(/调色文件|LUT/.test(res.notices[0] ?? ""), `  提示说得清楚：「${res.notices[0]}」`);
}
{
  const plan = mkPlan({ videoIds: ["m0"] });
  const f = fakeIO({ fetchFails: [url("m0")] });
  let threw = "";
  try { await run(plan, f); } catch (e) { threw = String((e as Error).message); }
  ok(/下载失败/.test(threw), `**必需**素材下载失败必须抛（实际：${threw.slice(0, 40)}）`);
  ok(!/notices/.test(threw), "  不是悄悄降级——画面素材缺了片子就不对");
}

/* ================================================================== *
 * ⑥ 探测集合：视频轨的超集，排除音频与 LUT
 * ================================================================== */
console.log("\n⑥ 探测集合");
{
  const plan = mkPlan({
    videoIds: ["m0", "m1"], audioIds: ["bgm"], lutIds: ["lut0"],
    hiddenVideoIds: ["hid"],
  });
  const t = probeTargets(plan);
  check("视频轨的 media 都在", [t.has("m0"), t.has("m1")], [true, true]);
  ok(!t.has("bgm"),
    "音频轨不探（compileAudioMix 拿的是 {path,startSec,volume,muted}，不读 hasAudio）");
  ok(!t.has("lut0"), "LUT 不探");
  ok(t.has("hid"),
    "**隐藏轨也探**（刻意取超集：与 buildSegments 的判据一旦漂移，"
    + "漏探的素材会落到默认 true，而 composite 分支的错误 true = 整段导出失败）");
}
{
  // 上面那条 `!t.has("lut0")` 其实**证明不了**排除逻辑：正常 plan 里
  // LUT 从来不会出现在视频轨的 clip 上（`lutIdOf` 只登记 media，不建 clip），
  // 所以那一行不删也不会有 lut 进集合。而 `probeTargets` 的注释承诺的是
  // 「**即便被误引用**也不该探」—— 那就必须真的构造一次误引用。
  const plan = mkPlan({ videoIds: ["m0"], lutIds: ["lut0"] });
  plan.tracks[0].clips.push(clip(7, { mediaId: "lut0" }));
  const t = probeTargets(plan);
  ok(!t.has("lut0"),
    "视频轨**误引用**了 LUT 时也不探（拿 ffmpeg -i 读 .cube 是纯浪费）");
  ok(t.has("m0"), "  同一条轨上的正常素材不受影响");
}

/* ================================================================== *
 * ⑦ 并发：断言「不超过上限」，不断言那个数字是几
 * ================================================================== */
console.log("\n⑦ 并发上限");
{
  const ids = Array.from({ length: 9 }, (_, i) => `m${i}`);
  const plan = mkPlan({ videoIds: ids });
  const f = fakeIO({});
  await run(plan, f, { dl: 2, pr: 3 });
  ok(f.maxFetch <= 2, `下载在飞数不超过给定上限（峰值 ${f.maxFetch} ≤ 2）`);
  ok(f.maxProbe <= 3, `探测在飞数不超过给定上限（峰值 ${f.maxProbe} ≤ 3）`);
  ok(f.maxFetch > 1 && f.maxProbe > 1, "  确实是并发跑的（峰值 > 1，不是串行）");
}
{
  // 生产接的是 4/4，钉住 renderer 没有偷偷改并发数（并发数归用户掌控）
  const R = code(read("render/renderer.ts"));
  ok(/downloadConcurrency:\s*4/.test(R) && /probeConcurrency:\s*4/.test(R),
    "renderer 仍传 4/4（6.4 是重构，不许顺手动并发数）");
}

/* ================================================================== *
 * ⑧ 取消
 * ================================================================== */
console.log("\n⑧ 取消");
{
  const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
  const plan = mkPlan({ videoIds: ids });
  const f = fakeIO({});
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 3);
  let name = "";
  try { await run(plan, f, { signal: ctl.signal, dl: 2, pr: 2 }); }
  catch (e) { name = (e as Error).name; }
  check("抛的是 Aborted（App.tsx 靠 name 决定静默收场还是弹错）", name, "Aborted");
  ok(f.calls.fetch < 12, `  没把剩下的批次跑完（发了 ${f.calls.fetch}/12 次）`);
}
{
  // 上面那条只证明了「signal 被带到了 fetch」，而那是**假件自己**的行为。
  // 真实的 `ensureCached` 是单飞 + 引用计数取消：一个已在飞的下载若还有
  // 别的调用方在等，它**不会**因为本次取消而中止，会正常 resolve。
  // 那种情况下唯一能让取消真正生效的，是 `inBatches` 每批开头那道闸。
  // 所以这里让假 fetch **完全无视 signal**，单独把那道闸钉住。
  const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
  const plan = mkPlan({ videoIds: ids });
  const f = fakeIO({ ignoreSignal: true });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 3);
  let name = "";
  try { await run(plan, f, { signal: ctl.signal, dl: 2, pr: 2 }); }
  catch (e) { name = (e as Error).name; }
  check("fetch 不认 signal 时，**批次闸**照样把取消变成 Aborted", name, "Aborted");
  ok(f.calls.fetch < 12,
    `  且确实提前收手了（发了 ${f.calls.fetch}/12 次，不是跑完再抛）`);
}
{
  // Aborted 必须**穿透**下载的 try/catch，不能被当成"这个素材下载失败了"。
  // 若被吞掉：可选素材（LUT）会静默降级、必需素材会抛一个措辞是"下载失败"的
  // 普通 Error —— App.tsx 靠 `name === "Aborted"` 决定静默收场还是弹错误框，
  // 于是用户点了取消却收到一个红色报错。
  const plan = mkPlan({ videoIds: ["m0"], lutIds: ["lut0"] });
  const f = fakeIO({});
  const ctl = new AbortController();
  ctl.abort();
  let name = "", msg = "";
  try { await run(plan, f, { signal: ctl.signal, dl: 4 }); }
  catch (e) { name = (e as Error).name; msg = (e as Error).message; }
  check("已取消的 signal 一进来就 Aborted", name, "Aborted");
  ok(!/下载失败/.test(msg), `  不是伪装成下载失败的普通 Error（「${msg}」）`);
}
{
  // 取消发生在**下载 LUT 的当口**：LUT 是可选素材，走的是那条会吞异常的路，
  // 所以这里是"Aborted 被吞掉"最容易发生的地方。
  const plan = mkPlan({ videoIds: [], lutIds: ["lut0", "lut1", "lut2", "lut3"] });
  const f = fakeIO({ ignoreSignal: false });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 1);
  let name = "";
  try { await run(plan, f, { signal: ctl.signal, dl: 4 }); }
  catch (e) { name = (e as Error).name; }
  check("取消撞上**可选**素材（那条吞异常的路）时也必须穿透", name, "Aborted");
}

/* ================================================================== *
 * ⑨ 表的容量上限
 * ================================================================== */
console.log("\n⑨ 探测表容量");
{
  const plan = mkPlan({ videoIds: ["m0"] });
  const big: Record<string, boolean> = {};
  for (let i = 0; i < MAX_PROBE_ENTRIES + 50; i++) big[`old${i}:1`] = true;
  const f = fakeIO({ disk: { [url("m0")]: 500 }, table: big });
  await run(plan, f);
  const n = Object.keys(f.saved ?? {}).length;
  check("裁到上限", n, MAX_PROBE_ENTRIES);
  ok(f.saved?.[probeKey(url("m0"), 500)] !== undefined,
    "  新写的那条一定在（丢的是最早的，不是刚写的）");
  ok(f.saved?.["old0:1"] === undefined, "  丢的是最早那批");
}

/* ================================================================== *
 * ⑩ LUT 路径解析：有 id 就绝不回退 URL
 * ================================================================== */
console.log("\n⑩ lutFilePath");
{
  check("有 id 且解析得到 → 本地路径",
    lutFilePath({ type: "lut", assetUrl: "/fw/x.cube", assetMediaId: "a" },
                () => "/cache/x.cube"), "/cache/x.cube");
  check("有 id 但解析不到 → null（**绝不回退 assetUrl**）",
    lutFilePath({ type: "lut", assetUrl: "/fw/x.cube", assetMediaId: "a" },
                () => null), null);
  check("有 id 但没给解析器 → null",
    lutFilePath({ type: "lut", assetUrl: "/fw/x.cube", assetMediaId: "a" }), null);
  check("没有 id（手工构造的老 plan）→ 用 assetUrl",
    lutFilePath({ type: "lut", assetUrl: "/BASE/legacy.cube" }, () => "/never"),
    "/BASE/legacy.cube");
  check("两个都没有 → null", lutFilePath({ type: "lut" }), null);
}

/* ================================================================== *
 * ⑪ 真 ffmpeg：转义规则 + `.cube` 扩展名（只有真跑才算数）
 * ================================================================== */
console.log("\n⑪ 真 ffmpeg 验证");
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const CUBE = 'TITLE "t"\nLUT_3D_SIZE 2\n'
  + [0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${r} ${g} ${b}`))).join("\n")
  + "\n";
const Q = String.fromCharCode(39);

function ffOk(vf: string): { rc: number; msg: string } {
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-y", "-f", "lavfi",
      "-i", "testsrc=size=64x64:rate=5", "-frames:v", "2",
      "-vf", vf, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    return { rc: 0, msg: "" };
  } catch (e) {
    const err = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
    const bad = err.split("\n").filter((l) => /No such file|Invalid|Error/.test(l))[0] ?? "";
    return { rc: 1, msg: bad.slice(-70) };
  }
}

let ffAvailable = true;
try { execFileSync(FFMPEG, ["-version"], { stdio: "ignore" }); }
catch { ffAvailable = false; }

if (!ffAvailable) {
  // 不静默跳过：跳过要是看不见的，这一段就等于不存在。
  fail++;
  console.log(`   ❌ 找不到 ffmpeg（${FFMPEG}），⑪ 段无法执行 —— `
    + "设 FFMPEG_BIN 指向可执行文件后重跑");
} else {
  const work = mkdtempSync(join(tmpdir(), "prep64-"));
  const cases: Array<[string, string]> = [
    ["普通", "plain"],
    ["含空格", "My Films"],
    ["含单引号", `O${Q}Brien`],
    ["含冒号", "C:dir"],
    ["单引号+冒号", `C:O${Q}B`],
  ];
  for (const [name, dir] of cases) {
    const d = join(work, dir);
    mkdirSync(d, { recursive: true });
    const cube = join(d, "look.cube");
    writeFileSync(cube, CUBE);
    const r = ffOk(`lut3d=file=${Q}${escFilterPath(cube)}${Q}`);
    ok(r.rc === 0, `lut3d 吃得下${name}的路径${r.msg ? `  ${r.msg}` : ""}`);
  }
  {
    // 反证：不转义的含引号路径必须失败，否则上面那条什么都没证明
    const d = join(work, `O${Q}Brien`);
    const cube = join(d, "look.cube");
    const r = ffOk(`lut3d=file=${Q}${cube}${Q}`);
    ok(r.rc !== 0,
      `反证：**不**转义时必须失败（引号被静默吞掉 → 打开一个不存在的路径）`);
  }
  {
    // 对照组：一个"等价改写"，应当**逃逸**（不被上面的断言抓住），
    // 用来证明这张表不是"随便一改就红"
    const d = join(work, "plain");
    const cube = join(d, "look.cube");
    const r = ffOk(`lut3d=file=${escFilterPath(cube)}`);   // 去掉外层引号
    ok(r.rc === 0,
      "对照组：普通路径去掉外层引号也能跑（说明红不是因为「一动就红」）");
  }
  {
    // `.cube` 扩展名是承重的：lut3d 按扩展名分派解析器
    const d = join(work, "plain");
    const noext = join(d, "noext_file");
    writeFileSync(noext, CUBE);
    const r = ffOk(`lut3d=file=${Q}${escFilterPath(noext)}${Q}`);
    ok(r.rc !== 0,
      `同样的字节、没有 .cube 扩展名 → lut3d 认不出（${r.msg.slice(0, 40)}）`);
    ok(cacheFileName("/fw/media/uploads/abc.cube").endsWith(".cube"),
      "  所以 cacheFileName 必须保住扩展名（slice 从尾部截，正是为此）");
  }
  {
    // 6.4 之前的写法：服务器 URL 直接进滤镜 → 整段导出失败
    const r = ffOk(`lut3d=file=${Q}/fw/media/uploads/abc123.cube${Q}`);
    ok(r.rc !== 0,
      `6.4 之前的写法（服务器 URL 直接拼）确实是硬失败：${r.msg.slice(0, 45)}`);
  }
}

/* ================================================================== *
 * ⑫ 接线：产品侧真的走了这条路
 * ================================================================== */
console.log("\n⑫ 接线");
{
  const R = code(read("render/renderer.ts"));
  ok(/prepareMedia\(/.test(R), "renderer 调 prepareMedia");
  ok(!/async function cacheMedia/.test(R), "  旧的 cacheMedia 已删除");
  ok(!/`下载素材 \$\{d\}\/\$\{t\}`/.test(R),
    "  写死的「下载素材 d/t」文案随之消失（措辞现在由工作量算出来）");
  ok(/assetPath:/.test(R), "  ctx 接上了 assetPath（LUT 才能拿到本地路径）");
  ok(/probeHasAudio\(path: string\): Promise<boolean \| null>/.test(read("render/renderer.ts")),
    "  probeHasAudio 返回三态（null = 探测失败，不是「没音轨」）");
  {
    // 光钉签名不够：`catch { return false }` 也过得了类型检查（false 是
    // `boolean | null` 的合法取值），而那正是 6.4 之前的行为 ——
    // 一次 sidecar 拉不起来就被记成"这个素材没有音轨"，并且**进表永久生效**。
    // 所以要钉的是 catch 体本身。
    const body = /async function probeHasAudio[\s\S]*?\n}/.exec(read("render/renderer.ts"))?.[0] ?? "";
    ok(/catch\s*{\s*return null;\s*}/.test(body),
      "  它的 catch 返回的是 null（不是 false —— 那会让偶发失败变成永久错误结论）");
    ok(!/return (true|false);/.test(body.replace(/return \/Stream[\s\S]*?;/, "")),
      "  catch 里没有任何写死的布尔返回");
  }

  const C = code(read("render/ffmpegCompiler.ts"));
  check("escFilterPath 只有一份定义",
    (C.match(/function escFilterPath/g) ?? []).length, 1);
  ok(!/const esc = \(p: string\) =>/.test(C),
    "  compileBurnSubtitles 里那份重复的 esc 已删（撇号 bug 一并修掉）");
  ok(/subtitles='\$\{escFilterPath\(srtPath\)\}'/.test(C),
    "  烧字幕改用同一份转义");

  const N = code(read("render/normalize.ts"));
  ok(/assetMediaId: registerAsset\(tm\.lut\)/.test(N),
    "normalize 把 LUT 登记进 plan.media");
  ok(/mediaIdOf\(url, 0, "lut"\)/.test(N),
    "  LUT 的 kind 是 lut（不占音轨探测的名额）");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 导出前素材准备：${pass} ✅ / ${fail} ❌`);
if (fail > 0) process.exit(1);
