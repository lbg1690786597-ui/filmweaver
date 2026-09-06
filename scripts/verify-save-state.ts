/**
 * verify-save-state.ts — 顶栏保存状态的真实性（批次 2 / 2.1）
 *
 * ## 这个脚本要防的东西
 *
 * 改之前顶栏那句 `✓ 已保存` 是写死的字面量，断网/500/token 过期一律照显示。
 * 它比"没有提示"更坏：**主动给出错误的安全感**，用户据此关窗口，改动真丢。
 *
 * 所以这里验的不是"UI 有没有三个状态"，而是三件会静默复发的事：
 *
 *   ① **漏 track**：以后有人在 api.ts 里新写一个 PATCH，直接用 `fetch` 而不是
 *      `fetchTracked` —— 那个端点失败时顶栏又会显示「已保存」。静态扫源码逮它。
 *   ② **失败被"保存中"压掉**：断网时写请求会不断进来又不断失败，若 saving
 *      优先于 error，用户看到的是一个转不停的圈，永远等不到那句"没存上"。
 *   ③ **失败被后续成功抹掉**：PATCH 是按字段发的，一笔失败就是那笔改动没落库，
 *      后面别的字段存成功救不回它。所以错误必须留到用户点掉。
 *
 * ④ 还有一条不靠"读代码觉得对"：真的把 `fetch` 换成必定 reject，
 *    跑一遍 `fetchTracked`，断言 store 里确实是失败态。这是 `fetchTracked`
 *    从 api.ts 挪进 lib/trackedFetch.ts 的唯一原因（api.ts 有 import.meta.env，
 *    node 下 import 不进来）。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  useSaveState, saveStatusOf, describeSaveError, SaveHttpError,
} from "../src/stores/saveStateStore";
import { fetchTracked, isTrackedWrite } from "../src/lib/trackedFetch";
import { getOutboxCount, resetOutbox } from "../src/lib/outboxStore";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/* ------------------------------------------------------------------ */
console.log("\n① 三态优先级：失败 > 保存中 > 已保存");

const err = { message: "连不上服务器，改动未保存 —— 请检查网络", at: 1 };
check("空闲无错 → 已保存", saveStatusOf({ inFlight: 0, lastError: null }), "saved");
check("有在飞的写 → 保存中", saveStatusOf({ inFlight: 2, lastError: null }), "saving");
check("有错 → 失败", saveStatusOf({ inFlight: 0, lastError: err }), "error");
// 这一条是 ② 的核心：断网时两者同时成立，必须显示失败
check("既有在飞的写又有错 → 仍显示失败（不许被转圈压掉）",
      saveStatusOf({ inFlight: 3, lastError: err }), "error");

/* ------------------------------------------------------------------ */
console.log("\n② 错误分类：用户能做的动作不同，话就得不同");

check("401 → 让重新登录",
      describeSaveError(new SaveHttpError(401, "401")),
      "登录已失效，改动未保存 —— 请重新登录");
check("403 同 401", describeSaveError(new SaveHttpError(403, "403")),
      "登录已失效，改动未保存 —— 请重新登录");
check("409 → 让刷新后重做（2.3 的乐观锁会用它）",
      describeSaveError(new SaveHttpError(409, "409")),
      "该镜头已被其他窗口修改，改动未保存 —— 请刷新后重做");
check("500 → 服务端错误", describeSaveError(new SaveHttpError(500, "500")),
      "服务端错误（500），改动未保存");
check("502 也算服务端错误", describeSaveError(new SaveHttpError(502, "502")),
      "服务端错误（502），改动未保存");
check("400 → 被拒绝", describeSaveError(new SaveHttpError(400, "400")),
      "保存被拒绝（400），改动未保存");
// fetch 断网时抛的就是 TypeError: Failed to fetch，原文直接给用户等于没说
check("TypeError（断网/DNS/被拦截）→ 说人话",
      describeSaveError(new TypeError("Failed to fetch")),
      "连不上服务器，改动未保存 —— 请检查网络");
ok("其它异常也一定带上「未保存」三个字",
   describeSaveError(new Error("boom")).includes("保存失败"),
   describeSaveError(new Error("boom")));
ok("非 Error 也不崩", describeSaveError("x").length > 0);
// 长 message 不能把顶栏顶爆（CSS 有 max-width，但文案本身也截）
ok("超长 message 被截断",
   describeSaveError(new Error("x".repeat(500))).length < 200);

/* ------------------------------------------------------------------ */
console.log("\n③ store 配对：计数不失衡、错误不自愈");

const S = useSaveState;
S.getState().__reset();
S.getState().beginWrite();
check("begin 一次 → inFlight=1", S.getState().inFlight, 1);
S.getState().endWrite();
check("end 成功 → inFlight=0", S.getState().inFlight, 0);
check("成功记下时刻", typeof S.getState().lastSavedAt, "number");
check("成功不留错误", S.getState().lastError, null);

// 多笔并发（拖滑块时很常见）
S.getState().__reset();
S.getState().beginWrite(); S.getState().beginWrite(); S.getState().beginWrite();
check("三笔在飞", S.getState().inFlight, 3);
S.getState().endWrite();
check("回来一笔 → 2", S.getState().inFlight, 2);

// 配对失误不该把计数带成负数：负数会让 inFlight > 0 永久失灵
S.getState().__reset();
S.getState().endWrite();
check("凭空 end 也不会变负数（否则「保存中」永久失灵）", S.getState().inFlight, 0);

S.getState().__reset();
S.getState().beginWrite();
S.getState().endWrite(new SaveHttpError(500, "500"));
check("失败计数 1", S.getState().failedCount, 1);
check("失败态", saveStatusOf(S.getState()), "error");
S.getState().beginWrite();
S.getState().endWrite(new TypeError("Failed to fetch"));
check("连续失败累加", S.getState().failedCount, 2);
check("显示最近一条", S.getState().lastError?.message,
      "连不上服务器，改动未保存 —— 请检查网络");

// ③ 的核心：后来的成功不许把"有东西没存上"抹掉
S.getState().beginWrite();
S.getState().endWrite();
check("之后某笔存成功 → 错误仍在（旧改动救不回来）",
      saveStatusOf(S.getState()), "error");
check("失败计数不被成功清零", S.getState().failedCount, 2);
S.getState().clearError();
check("只有用户点掉才回到已保存", saveStatusOf(S.getState()), "saved");
check("点掉同时清计数", S.getState().failedCount, 0);

/* ------------------------------------------------------------------ */
console.log("\n④ 哪些请求算数（表驱动）");

check("PATCH 算", isTrackedWrite("http://h/v2/shots/1", "PATCH"), true);
check("POST 算", isTrackedWrite("http://h/v2/assets", "POST"), true);
check("PUT 算", isTrackedWrite("http://h/v2/x", "PUT"), true);
check("DELETE 算", isTrackedWrite("http://h/v2/x", "DELETE"), true);
check("GET 不算", isTrackedWrite("http://h/v2/x", "GET"), false);
check("小写 patch 也算（init.method 大小写不受控）",
      isTrackedWrite("http://h/v2/x", "patch"), true);
check("素材上传豁免（有自己的进度 UI，失败不代表编辑丢了）",
      isTrackedWrite("http://h/v2/media/upload", "POST"), false);
check("剧本导入豁免", isTrackedWrite("http://h/v2/script/import-file", "POST"), false);

/* ------------------------------------------------------------------ */
console.log("\n⑤ 真跑一遍 fetchTracked：断网 / 500 / 成功");

const realFetch = globalThis.fetch;
async function withFetch<T>(stub: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

// 断网：fetch 直接 reject（浏览器里就是 TypeError）
S.getState().__reset();
await withFetch(
  (async () => { throw new TypeError("Failed to fetch"); }) as typeof globalThis.fetch,
  async () => {
    await fetchTracked("http://h/v2/shots/1", { method: "PATCH", body: "{}" })
      .then(() => { failed++; console.log("  ❌ 断网时 fetchTracked 竟然 resolve 了"); },
            () => { /* 期望：原样抛给调用方 */ });
  });
check("断网 → 顶栏必须是失败，不许是「已保存」", saveStatusOf(S.getState()), "error");
/* 🔀 6.8 预期 diff：这里原来钉的是「连不上服务器，改动未保存 —— 请检查网络」。
 *
 * 为什么这个 diff 是预期的：那句话在 6.7 时是实话 —— 断线失败的 PATCH 确实
 * 就没了。6.8 上了补发队列之后**这一笔真的被暂存住了**，还说"未保存"是
 * 反向的谎，而反向的谎比乐观的谎更难纠正：用户照着它去重做，等补发跑完
 * 就是同一处改了两遍。
 *
 * **不变式一个字没变**：顶栏必须是失败态（上一条断言，没动），文案必须与
 * 这一笔的真实下场一致。变的只是"真实下场"。
 * 下面顺带补了 POST 那条对照 —— 它**没有**队列可进，所以必须仍然说"要联网"；
 * 两条一起才钉得住"暂存"这个词只在真暂存住时才出现。 */
check("断网 → 文案说清已暂存、会补发", S.getState().lastError?.message,
      "连不上服务器 —— 改动已暂存在本机，联网后会自动补发");
check("断网 → inFlight 归零（不会卡在保存中）", S.getState().inFlight, 0);
check("断网的 PATCH 真的进了补发队列（文案不是空口说的）", getOutboxCount(), 1);

// 对照组：POST 排不进队列（id 由服务端铸造），文案必须**不能**说成暂存住了
S.getState().__reset();
resetOutbox();
await withFetch(
  (async () => { throw new TypeError("Failed to fetch"); }) as typeof globalThis.fetch,
  async () => {
    await fetchTracked("http://h/v2/shots", { method: "POST", body: "{}" }).catch(() => {});
  });
check("断网的 POST 不入队", getOutboxCount(), 0);
ok("★ POST 文案说「必须联网」而不是「已暂存」（说成暂存 = 又一个假的已保存）",
   !!S.getState().lastError?.message.includes("必须联网")
   && !S.getState().lastError!.message.includes("暂存"));
resetOutbox();

// 500：fetch 是**成功 resolve** 的 —— 旧代码正是在这里把没存上当成了已保存
S.getState().__reset();
const resp500 = await withFetch(
  (async () => new Response("boom", { status: 500 })) as typeof globalThis.fetch,
  () => fetchTracked("http://h/v2/shots/1", { method: "PATCH", body: "{}" }));
check("500 → 失败态（fetch 本身没抛，光看 catch 会漏）",
      saveStatusOf(S.getState()), "error");
check("500 → 文案带状态码", S.getState().lastError?.message,
      "服务端错误（500），改动未保存");
ok("500 的 body 没被消费（调用方还要读它拼错误信息）", !resp500.bodyUsed);
check("500 的响应原样返回给调用方", resp500.status, 500);

// 成功
S.getState().__reset();
const resp200 = await withFetch(
  (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch,
  () => fetchTracked("http://h/v2/shots/1", { method: "PATCH", body: "{}" }));
check("成功 → 已保存", saveStatusOf(S.getState()), "saved");
ok("成功也不消费 body", !resp200.bodyUsed);

// 豁免端点不该影响顶栏
S.getState().__reset();
await withFetch(
  (async () => { throw new TypeError("Failed to fetch"); }) as typeof globalThis.fetch,
  async () => { await fetchTracked("http://h/v2/media/upload", { method: "POST" }).catch(() => {}); });
check("豁免端点失败 → 顶栏不动（它有自己的错误 UI）",
      saveStatusOf(S.getState()), "saved");

// GET 失败同样不该污染保存状态
S.getState().__reset();
await withFetch(
  (async () => { throw new TypeError("Failed to fetch"); }) as typeof globalThis.fetch,
  async () => { await fetchTracked("http://h/v2/shots").catch(() => {}); });
check("GET 失败 → 顶栏不动", saveStatusOf(S.getState()), "saved");

/* ------------------------------------------------------------------ */
console.log("\n⑥ 静态守卫：不许再有绕过 fetchTracked 的写请求");

const apiSrc = readFileSync(join(ROOT, "src/api.ts"), "utf8");

// 逐个写方法字面量往前找最近的一次 fetch 调用，确认是 fetchTracked。
// 这样即使以后有人复制粘贴一段旧写法进来，也会在这里红掉。
const bypass: string[] = [];
for (const m of apiSrc.matchAll(/method:\s*"(POST|PATCH|PUT|DELETE)"/gi)) {
  const before = apiSrc.slice(0, m.index!);
  const lastTracked = before.lastIndexOf("fetchTracked(");
  // "fetch(" 不会命中 "fetchTracked("（后者 fetch 之后是 T 不是括号），
  // 所以两个下标比大小就够：谁更靠后，这处写请求就是谁发的。
  const lastRaw = before.lastIndexOf("fetch(");
  if (lastRaw > lastTracked) {
    const line = apiSrc.slice(0, m.index!).split("\n").length;
    bypass.push(`src/api.ts:${line} 的 ${m[1]} 没走 fetchTracked`);
  }
}
ok(`api.ts 里 ${[...apiSrc.matchAll(/method:\s*"(POST|PATCH|PUT|DELETE)"/gi)].length} 处写请求全部走 fetchTracked`,
   bypass.length === 0, bypass.join("\n      "));

// 顶栏不许再出现写死的「已保存」
const topbar = readFileSync(join(ROOT, "src/features/editor/TopBar.tsx"), "utf8");
ok("TopBar 里不再有写死的「已保存」字面量",
   !topbar.includes("已保存"),
   "顶栏又出现了不接状态的「已保存」——那正是 2.1 要消灭的东西");
ok("TopBar 渲染 SaveIndicator", topbar.includes("<SaveIndicator"));

// SaveIndicator 必须真的订阅 store（而不是又写死一个）
const ind = readFileSync(join(ROOT, "src/features/editor/SaveIndicator.tsx"), "utf8");
ok("SaveIndicator 订阅 useSaveState", ind.includes("useSaveState("));
ok("SaveIndicator 用 saveStatusOf 判定三态（不自己再写一套优先级）",
   ind.includes("saveStatusOf("));
ok("失败态可点掉（clearError）", ind.includes("clearError"));

/* ------------------------------------------------------------------ */
console.log(failed === 0
  ? "\n✅ 保存状态全部通过：断网/500/401 都会如实显示，且失败不会被抹掉"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
