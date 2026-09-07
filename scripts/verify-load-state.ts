/**
 * verify-load-state.ts — 读路径失败的可见化（批次 2 / 2.4）
 *
 * ## 这个脚本要防的是"回到静默"
 *
 * 2.4 改掉的九处原本长这样：
 *
 *     try { setSubtitles((await api.listSubtitleClips(id)).clips); }
 *     catch { /* 旧后端无此接口时静默 *\/ }
 *
 * 那个 catch 的**理由是真的**（老客户端连新后端，接口可能真不存在），
 * 所以它极容易被"顺手"写回来 —— 下一个人加第十个列表接口时，
 * 照抄旁边的写法就又是一个静默 catch，而且**不会有任何东西报错**：
 * typecheck 过、build 过、界面看着正常，只有断网时才现形，
 * 而现形的方式是用户以为自己的编辑丢了、重做一遍、覆盖掉真数据。
 *
 * 所以这里查三类东西，其中只有第 ③ 类是静态检查抓不到的：
 *
 *   ① **静态**：九处必须都登记 noteFailed；`get()` 必须抛带状态码的错误
 *      （这是全部分类文案的地基 —— 一旦有人改回 `throw new Error(String(status))`，
 *      404 会被说成"加载失败：404"，所有分类静默退化，但脚本全绿）。
 *   ② **纯函数**：分类与汇总的措辞。它们决定用户会不会去做那个危险动作。
 *   ③ **store 行为**：会不会刷屏、成功后会不会自己消掉、面板卸载后
 *      会不会留下一个点了没反应的「重试」。这三条都是**时序**问题，
 *      读代码看不出来，必须真的按顺序调一遍。
 *
 * ⚠️ 与 2.2/2.3 同一个约束：不能 import `src/api.ts`（顶层有 `import.meta.env`，
 *    node 下拿不到）。所以 loadStateStore 刻意按 `.status` 鸭子判断，
 *    不 import ApiError —— §0.6 记为「验证手段决定了模块边界」。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  useLoadState, describeLoadError, loadSummaryOf, LOAD_LABELS,
  ANNOUNCE_GAP_MS, type LoadKey, type LoadFailure,
} from "../src/stores/loadStateStore";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* ================================================================== */
console.log("\n① 错误分类：同样是「空的」，用户能做的动作完全不同");

const cases: [string, unknown, string, string][] = [
  ["401 → 让他去重新登录", { status: 401 }, "auth", "重新登录"],
  ["403 同 401", { status: 403 }, "auth", "重新登录"],
  ["404 → 说清是功能不可用，不是数据丢了", { status: 404 }, "unsupported", "该功能不可用"],
  ["500 → 服务器出错，稍后重试", { status: 500 }, "server", "服务器出错"],
  ["503 同 500 一类", { status: 503 }, "server", "服务器出错"],
  ["429 等其他状态 → 带上状态码", { status: 429 }, "server", "429"],
];
for (const [name, err, kind, must] of cases) {
  const r = describeLoadError(err, "字幕");
  ok(name, r.kind === kind && r.message.includes(must),
     `得到 kind=${r.kind} message=${r.message}`);
}

// fetch 在断网/DNS/证书失败时抛的是 TypeError，不带 status
const net = describeLoadError(new TypeError("Failed to fetch"), "音频轨");
ok("断网（TypeError）→ network 且指向「检查网络」",
   net.kind === "network" && net.message.includes("网络"), net.message);

// 404 与断网必须**说得不一样** —— 这正是把 get() 改抛 ApiError 换来的东西
ok("404 与断网的文案不同（否则改 get() 的收益为零）",
   describeLoadError({ status: 404 }, "字幕").message
   !== describeLoadError(new TypeError("x"), "字幕").message);

// 兜底不许露出 `Error: 404` 这种给程序员看的东西
const weird = describeLoadError(new Error("boom"), "转场");
ok("未知错误也说人话（带资源名 + 原因摘要）",
   weird.kind === "unknown" && weird.message.startsWith("转场加载失败")
   && weird.message.includes("boom"), weird.message);

// 每条文案都必须点名是哪个资源 —— "加载失败"三个字用户没法据此判断屏幕上哪块不可信
ok("九个资源的文案都带资源名",
   (Object.keys(LOAD_LABELS) as LoadKey[]).every((k) =>
     describeLoadError({ status: 500 }, LOAD_LABELS[k]).message.includes(LOAD_LABELS[k])));

/* ================================================================== */
console.log("\n② 汇总措辞：用「未加载」而不是「加载失败」");

const mk = (key: LoadKey, kind: string, at: number): LoadFailure =>
  ({ key, label: LOAD_LABELS[key], message: "x", kind: kind as LoadFailure["kind"], at, count: 1 });

check("无失败 → 空文案（顶栏什么都不显示）",
      loadSummaryOf({}), { list: [], text: "", kind: null });
check("单项 → 点名资源",
      loadSummaryOf({ subtitles: mk("subtitles", "network", 1) }).text, "字幕未加载");
check("多项 → 报数量（逐条列在 title 里，不挤爆顶栏）",
      loadSummaryOf({
        subtitles: mk("subtitles", "unsupported", 2),
        audio: mk("audio", "network", 1),
        clips: mk("clips", "server", 3),
      }).text, "3 项数据未加载");
// 多项一起失败时取最"可行动"的那一类：断网是用户能动手解决的，unsupported 不是
check("多类混在一起时取 network（最可行动的那一类）",
      loadSummaryOf({
        subtitles: mk("subtitles", "unsupported", 2),
        audio: mk("audio", "network", 1),
      }).kind, "network");
check("network 与 auth 同时 → 取 network", loadSummaryOf({
  audio: mk("audio", "network", 1), clips: mk("clips", "auth", 2),
}).kind, "network");
check("auth 与 server 同时 → 取 auth（不重新登录永远好不了）", loadSummaryOf({
  audio: mk("audio", "server", 1), clips: mk("clips", "auth", 2),
}).kind, "auth");
check("按首次失败时刻排序（先坏的先说）",
      loadSummaryOf({
        clips: mk("clips", "server", 30), audio: mk("audio", "network", 10),
        subtitles: mk("subtitles", "server", 20),
      }).list.map((f) => f.key), ["audio", "subtitles", "clips"]);
ok("措辞是「未加载」而不是「加载失败」（用户要判断的是「这个空列表可不可信」）",
   loadSummaryOf({ audio: mk("audio", "network", 1) }).text.includes("未加载"));

/* ================================================================== */
console.log("\n③ store 时序：会不会刷屏 / 会不会自己消掉 / 会不会留下死按钮");

const S = () => useLoadState.getState();
S().__reset();

// --- 刷屏：refreshAudio 被 TTS 轮询每 5 秒调一次，断网时就是每 5 秒一次失败 ---
const first = S().noteFailed("audio", new TypeError("x"));
ok("首次失败 → 值得提示一次", first === true);
const second = S().noteFailed("audio", new TypeError("x"));
ok("同一资源持续失败 → 不再提示（否则断网时每 5 秒一条 toast）", second === false);
check("但失败次数要累加（用来区分「抖了一下」与「一直连不上」）", S().failures.audio?.count, 2);

// --- 项目打开时五个资源同时失败：useToast 只有一个槽，逐条提示会互相顶掉 ---
const burst = (["subtitles", "transitions", "clips", "stages"] as LoadKey[])
  .map((k) => S().noteFailed(k, new TypeError("x")));
check("同一时刻的其余四个资源都不再单独提示（间隔内去重）", burst, [false, false, false, false]);
check("但五条都进了顶栏（顶栏才是完整清单）", loadSummaryOf(S().failures).text, "5 项数据未加载");

// --- 间隔之外的新失败仍要提示：那是一次新的、用户还不知道的事 ---
useLoadState.setState({ lastAnnouncedAt: Date.now() - ANNOUNCE_GAP_MS - 1000 });
ok("超过去重间隔后的新资源失败 → 重新提示一次",
   S().noteFailed("jobs", new TypeError("x")) === true);

// --- 加载成功要自己消掉（这是"持久指示器"能被接受的前提）---
S().noteLoaded("audio");
ok("成功后该资源的条目消失", S().failures.audio === undefined);
ok("其他资源的条目不受影响", S().failures.subtitles !== undefined);

// --- 成功刷新每 5 秒一次；没失败过时不许 set，否则订阅方无谓重渲染 ---
const refBefore = S().failures;
S().noteLoaded("audio");         // 本来就没失败
S().noteLoaded("versions");      // 从来没失败过
ok("无失败时 noteLoaded 不制造新引用（避免每次轮询都重渲染顶栏）",
   S().failures === refBefore);

// --- 恢复后再次失败，应视为"新的一次"，而不是接着上次的 count / 上次的时刻 ---
// 把上一条失败的时刻改成一个明显很久以前的值再走一遍：直接比 Date.now() 会
// 在同一毫秒内跑完而恒等，测不出东西。
useLoadState.setState((s) => ({
  failures: { ...s.failures, audio: { ...s.failures.audio!, at: 1000 } },
}));
S().noteLoaded("audio");
S().noteFailed("audio", new TypeError("x"));
check("恢复后再失败 → count 从 1 重新数", S().failures.audio?.count, 1);
ok("首次失败时刻也重新记（不沿用上一轮的 at，否则顶栏排序会把新失败排到最前面之外）",
   (S().failures.audio?.at ?? 0) > 1000);

/* --- registerRetry：注销必须连带清掉条目 --- */
S().__reset();
let retried = 0;
const un = S().registerRetry("jobs", () => { retried++; });
S().noteFailed("jobs", { status: 500 });
ok("注册后能取到重试回调", typeof S().retries.jobs === "function");
S().retries.jobs?.();
check("重试回调可用", retried, 1);
un();
ok("注销后回调没了", S().retries.jobs === undefined);
ok("注销同时清掉该条失败（面板一关，「空列表」这句谎话就不在屏幕上了）",
   S().failures.jobs === undefined,
   "留着会给出一个点了没反应的「重试」，比不提示更糟");

// 注销一个资源不许波及别人
S().__reset();
const unA = S().registerRetry("jobs", () => {});
S().registerRetry("audioLib", () => {});
S().noteFailed("jobs", { status: 500 });
S().noteFailed("audioLib", { status: 500 });
unA();
ok("注销 jobs 不影响 audioLib 的条目与回调",
   S().failures.audioLib !== undefined && typeof S().retries.audioLib === "function");

// 切项目：条目全清，且去重计时器也归零（新项目的第一次失败必须提示）
S().clearAll();
check("clearAll 清空所有条目", Object.keys(S().failures).length, 0);
ok("clearAll 后新项目的首次失败仍会提示",
   S().noteFailed("audio", new TypeError("x")) === true);
S().__reset();

/* ================================================================== */
console.log("\n④ 九处读路径：静默 catch 不许回来");

/** [文件, 资源 key, 该处失败时屏幕上会撒的谎] */
const SITES: [string, LoadKey, string][] = [
  ["src/hooks/useAudioTrack.ts", "audio", "音频轨空着 = 旁白丢了 → 重新合成（花钱且覆盖）"],
  ["src/hooks/useSubtitles.ts", "subtitles", "字幕轨空着 = 字幕丢了 → 重新对齐"],
  ["src/hooks/useTransitions.ts", "transitions", "接缝无标记 → 再拖一个转场上去就是真覆盖"],
  ["src/hooks/useLibClips.ts", "clips", "素材池显示内存快照 → 同一文件重传两份"],
  ["src/hooks/useStages.ts", "stages", "人物轨空着 → 重跑「AI 识别服装」凭空多一批草稿"],
  ["src/features/audio/AudioPanel.tsx", "audioLib", "音效库显示空 → 重传已有音效"],
  ["src/features/tasks/TasksDrawer.tsx", "jobs", "「还没有任务记录」→ 以为没发起，再点一次一键成片"],
  ["src/components/ShotsPanel.tsx", "versions", "版本条不显示 = 只有一版 → 一遍遍重生成找回旧画面"],
  ["src/components/FineCut.tsx", "exportSrt", "「字幕（0 条）」→ 导出一条字幕都没有的成片"],
];

for (const [file, key, harm] of SITES) {
  const src = read(file);
  ok(`${file} 登记 noteFailed("${key}")`,
     src.includes(`noteFailed("${key}"`), `失败后果：${harm}`);
  ok(`${file} 成功时清掉失败态（noteLoaded("${key}")）`,
     src.includes(`noteLoaded("${key}"`));
  ok(`${file} 注册了重试（否则顶栏只能报告、不能修）`,
     src.includes(`registerRetry(\n    "${key}"`) || src.includes(`registerRetry("${key}"`));
}

// 空 catch 是这一条目的原罪，专门扫一遍：`catch {` / `catch (e) {}` 里空无一物
for (const [file] of SITES) {
  const src = read(file);
  const bare = [...src.matchAll(/catch\s*(?:\([^)]*\)\s*)?\{\s*\}/g)].length;
  ok(`${file} 没有空 catch 块`, bare === 0, `发现 ${bare} 处`);
}

/* ================================================================== */
console.log("\n⑤ 地基：get() 必须抛带状态码的错误");

const apiSrc = read("src/api.ts");
// 这是全部分类文案的地基。改回 `throw new Error(String(resp.status))` 的话，
// 所有 status 判断静默失效、404 变成"加载失败：404"，而上面①的纯函数测试**照样全绿**
// （它们喂的是构造出来的 {status}）。所以必须在源码层面钉住。
const getFn = apiSrc.match(/async function get<T>[\s\S]{0,900}?\n\}/)?.[0] ?? "";
// 去注释再查：get() 里那段注释**引用了**旧写法（`new Error(String(resp.status))`）
// 来解释为什么要改，扫原文会把这句解释本身当成违规。守的是代码，不是行文。
const getCode = getFn.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
ok("api.ts 的 get() 存在且被扫到", getFn.length > 0);
ok("get() 抛 toApiError（携带状态码），不是 new Error(String(status))",
   getCode.includes("toApiError(resp.status"),
   "一旦改回裸 Error，describeLoadError 只能落到 unknown 分支，"
   + "404 与断网又变成同一句话 —— 而且没有任何测试会红");
ok("get() 的代码里不再出现 new Error(String(", !getCode.includes("new Error(String("));

// ApiError 必须真的带 status 字段，否则鸭子判断取不到
ok("ApiError 带 status 字段", /class ApiError[\s\S]{0,300}?status/.test(apiSrc));

/* ================================================================== */
console.log("\n⑥ 顶栏：指示器要真的挂上去、且订阅的是 store");

const topbar = read("src/features/editor/TopBar.tsx");
ok("TopBar 渲染 LoadIndicator", topbar.includes("<LoadIndicator"));
ok("LoadIndicator 紧挨 SaveIndicator（两者是同一个问题的两半）",
   /<SaveIndicator \/>[\s\S]{0,300}<LoadIndicator \/>/.test(topbar));

const ind = read("src/features/editor/LoadIndicator.tsx");
ok("LoadIndicator 订阅 useLoadState", ind.includes("useLoadState("));
ok("用 loadSummaryOf 判定文案（不自己再写一套措辞）", ind.includes("loadSummaryOf("));
ok("无失败时返回 null（正常状态不占顶栏）", ind.includes("return null"));
ok("提供重试入口", ind.includes("retries["));
// 只订阅 failures：retries 变化不该触发重渲染
ok("不订阅 retries（注册回调不该引起重渲染）",
   !/useLoadState\(\(s\) => s\.retries\)/.test(ind));
ok("title 里明确写出「显示为空不代表数据没了」",
   ind.includes("不代表数据没了"));

// 切项目必须清空，否则新项目顶栏会挂着上一个项目的失败
const app = read("src/App.tsx");
const reset = app.match(/function resetWorkspace\(\)[\s\S]*?\n  \}/)?.[0] ?? "";
ok("resetWorkspace 被扫到", reset.length > 0);
ok("切项目清空读失败条目", reset.includes("clearAll()"),
   "否则新项目顶栏会挂着上一个项目的「字幕未加载」");

// 新增的 className 必须有 CSS（css-coverage 只查 fw-/sp- 前缀，finecut- 不在其列，手动钉一下）
const styles = read("src/styles.css");
ok(".finecut-srtfail 有样式定义", styles.includes(".finecut-srtfail"));
ok(".sp-ver-fail 有样式定义", styles.includes(".sp-ver-fail"));

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 读路径全部通过：九处失败都会说出来、说得准、能重试，且不会刷屏"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
