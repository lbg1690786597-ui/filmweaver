/**
 * scripts/verify-outbox.ts — 6.8 离线补发队列 + 本机项目快照
 *
 * 分六节：
 *   [1] `canQueue`：什么能排队（**POST 不能**、FormData 不能）
 *   [2] `coalesce`：同目标只留最后一笔，DELETE 的两条特例
 *   [3] `replayQueue`：状态码分类 —— 2xx/409/401/5xx/其余 4xx 各自的下场
 *   [4] 文案（承重）：`describeReplay` / `offlineBannerText` / `offlineWriteHint`
 *   [5] `outboxStore`：注入 I/O、落盘、hydrate、并发保护、引用稳定
 *   [6] 快照 + 接线（源码断言）
 *
 * ## 为什么这一条的断言要这么密
 *
 * 队列的失败形态是**静默的**，而且三种失败方向的代价完全不同：
 *   · 该排队的没排 → 用户的改动无声消失（回到 6.7 之前那个"假的已保存"）
 *   · 不该排队的排了 → 补发一个内容为空的写，或者创建出幽灵实体
 *   · 排了但补发时把 409 当成"再发一次"→ **静默覆盖掉别人的修改**
 * 第三种最坏：它没有任何症状，受害的是另一个窗口前的另一个人。
 * 所以这里对 `replayQueue` 的每一类状态码都单独钉，而不是只测"happy path 能发出去"。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canQueue, coalesce, describeReplay, offlineBannerText, offlineWriteHint,
  replayQueue, targetOf, MAX_TRIES,
  type OutboxIO, type QueuedWrite, type ReplayResult,
} from "../src/lib/outbox";
import {
  getOutbox, getOutboxCount, hydrateOutbox, isDurable, noteFailedWrite,
  resetOutbox, runReplay, setOutboxIO, subscribeOutbox,
} from "../src/lib/outboxStore";
import {
  describeSnapshotAge, isUsableSnapshot, makeSnapshot, SNAPSHOT_VERSION,
} from "../src/lib/snapshot";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};
const eq = (got: unknown, want: unknown, name: string) =>
  ok(Object.is(got, want), name, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/** 造一笔队列项。默认 PATCH，因为那是本项目里绝大多数的写。 */
const W = (p: Partial<QueuedWrite>): QueuedWrite => ({
  seq: 1, method: "PATCH", url: "/v2/shots/s1", body: "{}", at: 0, tries: 0, ...p,
});

// ───────────────────────────────────────────────────────────────────────
console.log("\n[1] canQueue：什么能进队列");

ok(canQueue("/v2/shots/s1", "PATCH", "{}"), "PATCH 能排");
ok(canQueue("/v2/shots/s1", "put", "{}"), "PUT 能排（大小写不敏感）");
ok(canQueue("/v2/shots/s1", "DELETE", null), "DELETE 能排（无 body）");
ok(!canQueue("/v2/shots", "POST", "{}"),
  "★ POST **不能**排：id 由服务端铸造，补发出来是个界面上早已存在、"
  + "而所有后续 PATCH 都填不出 id 的幽灵实体");
ok(!canQueue("/v2/shots/s1", "GET", null), "读请求不排（没什么可补发的）");
ok(!canQueue("/v2/media/upload", "PUT", "{}"),
  "上传端点不排（body 是 FormData，且自有进度与错误 UI）");
ok(!canQueue("/v2/script/import-file", "PATCH", "{}"), "导入端点同上");
ok(!canQueue("/v2/shots/s1", "PATCH", new Map()),
  "★ 非字符串 body 不排：硬塞进 JSON 会得到 `{}`，补发出去就是一笔**内容为空的写** —— 比不补发坏得多");
ok(canQueue("/v2/shots/s1", "PATCH", undefined), "undefined body 视同无 body");

eq(targetOf("/v2/shots/s1?force=true"), "/v2/shots/s1", "targetOf 去掉查询串");
eq(targetOf("/v2/shots/s1"), "/v2/shots/s1", "没有查询串时原样返回");

// ───────────────────────────────────────────────────────────────────────
console.log("\n[2] coalesce：同目标只留最后一笔");

{
  const q = [W({ seq: 1, body: '{"a":1}' })];
  const next = coalesce(q, W({ seq: 2, body: '{"a":2}' }));
  eq(next.length, 1, "同 method 同目标 → 合并成一笔");
  eq(next[0].body, '{"a":2}', "留的是**后**一笔的值（PATCH 是绝对值语义）");
  eq(next[0].seq, 1, "★ 保留原 seq：它在队列里的资历没变，变的只是要写的值");
  eq(q.length, 1, "不改原数组");
}
{
  // 位置必须原地保留：先改镜头时长、再改依附其上的字幕，顺序是有意义的
  const q = [W({ seq: 1, url: "/v2/shots/a" }), W({ seq: 2, url: "/v2/shots/b" })];
  const next = coalesce(q, W({ seq: 3, url: "/v2/shots/a", body: "new" }));
  eq(next.length, 2, "合并不新增");
  eq(next[0].url, "/v2/shots/a", "★ 原地替换，不移到队尾（移位会打乱资源之间的相对顺序）");
  eq(next[0].body, "new", "值已更新");
}
{
  const q = [W({ seq: 1, url: "/v2/shots/a?x=1" })];
  const next = coalesce(q, W({ seq: 2, url: "/v2/shots/a?x=2" }));
  eq(next.length, 1, "查询串不同也算同一个目标");
}
{
  const q = [W({ seq: 1, url: "/v2/shots/a" }), W({ seq: 2, url: "/v2/shots/a", method: "PUT" })];
  const next = coalesce(q, W({ seq: 3, url: "/v2/shots/a", method: "DELETE", body: null }));
  eq(next.length, 1, "★ DELETE 吃掉同目标的所有既有笔（删都删了，补发那些改字段只会 404）");
  eq(next[0].method, "DELETE", "留下的是 DELETE");
}
{
  const q = [W({ seq: 1, url: "/v2/shots/a", method: "DELETE", body: null })];
  const next = coalesce(q, W({ seq: 2, url: "/v2/shots/a", body: "late" }));
  eq(next.length, 1, "★ 目标已排 DELETE，后来的非 DELETE 被丢弃");
  eq(next[0].method, "DELETE", "队列内容不变");
}
{
  const q = [W({ seq: 1, url: "/v2/shots/a", method: "DELETE", body: null })];
  const next = coalesce(q, W({ seq: 2, url: "/v2/shots/a", method: "DELETE", body: null }));
  eq(next.length, 1, "重复 DELETE 不堆积");
}
{
  const q = [W({ seq: 1, url: "/v2/shots/a", method: "PATCH" })];
  const next = coalesce(q, W({ seq: 2, url: "/v2/shots/a", method: "PUT" }));
  eq(next.length, 2, "★ 同目标但不同 method **不**合并（PUT 与 PATCH 语义不同，替换会丢掉一个）");
}
{
  const q = [W({ seq: 1, tries: 2 })];
  const next = coalesce(q, W({ seq: 9, body: "x" }));
  eq(next[0].tries, 2, "★ 合并保留 tries：否则用户每改一次就把重试次数清零，5xx 时无限重试");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[3] replayQueue：每一类状态码的下场");

const sender = (codes: (number | null)[]) => {
  let i = 0;
  const seen: QueuedWrite[] = [];
  // ⚠️ 不能写 `codes[i++] ?? 200`：`null` 是本用例**刻意**要送出去的"又断了"，
  // 而 `??` 会把它一起吞成 200 —— 断线那三条断言会全绿地测了个 happy path。
  const fn = async (w: QueuedWrite) => {
    seen.push(w);
    return i < codes.length ? codes[i++] : (i++, 200);
  };
  return { fn, seen, sent: () => i };
};

{
  const s = sender([200, 204]);
  const { result, remaining } = await replayQueue([W({ seq: 1 }), W({ seq: 2 })], s.fn);
  eq(result.applied, 2, "2xx 计入 applied");
  eq(remaining.length, 0, "成功的不留在队列");
  eq(result.remaining, 0, "result.remaining 与真实剩余一致");
}
{
  const s = sender([409]);
  const { result, remaining } = await replayQueue([W({})], s.fn);
  eq(result.conflicted, 1, "409 计入 conflicted");
  eq(remaining.length, 0,
    "★ 409 丢出队列、**绝不**去掉版本号重发 —— 那正是静默覆盖掉别人修改的做法，"
    + "而防住它是 2.3 乐观锁存在的唯一理由");
}
{
  const s = sender([null, 200]);
  const { result, remaining } = await replayQueue([W({ seq: 1 }), W({ seq: 2 })], s.fn);
  eq(s.sent(), 1, "★ 又断了就立刻停，不继续发（继续只是把每一笔都撞成失败，还白白累加 tries）");
  eq(remaining.length, 2, "剩下的原样留着，包括撞断的那一笔");
  eq(result.applied, 0, "没有任何一笔算成功");
  eq(remaining[0].tries, 0, "★ 断线不算 tries：网络问题不是这笔请求的错");
}
{
  const s = sender([401, 200]);
  const { result, remaining } = await replayQueue([W({ seq: 1 }), W({ seq: 2 })], s.fn);
  ok(result.authBlocked, "401 置 authBlocked");
  eq(s.sent(), 1, "撞上 401 立刻停（票不认了，后面全是 401）");
  eq(remaining.length, 2,
    "★ 401/403 **留着**队列：重新登录之后这些改动仍然有效、仍然是用户想要的。"
    + "丢掉才是真损失，而这是用户唯一无法自己补救的一类");
}
{
  const s = sender([403]);
  const { result } = await replayQueue([W({})], s.fn);
  ok(result.authBlocked, "403 同 401");
}
{
  const s = sender([500]);
  const { result, remaining } = await replayQueue([W({ tries: 0 })], s.fn);
  eq(remaining.length, 1, "5xx 留着重试");
  eq(remaining[0].tries, 1, "tries 累加");
  eq(result.rejected, 0, "还没到顶不算放弃");
}
{
  const s = sender([503]);
  const { result, remaining } = await replayQueue([W({ tries: MAX_TRIES - 1 })], s.fn);
  eq(remaining.length, 0, `★ 5xx 到 MAX_TRIES(${MAX_TRIES}) 就放弃，不无限重试`);
  eq(result.rejected, 1, "并如实计入 rejected（不是悄悄丢掉）");
}
{
  const s = sender([400]);
  const { result, remaining } = await replayQueue([W({})], s.fn);
  eq(result.rejected, 1, "其余 4xx 直接放弃（请求本身不合法，发一百次也一样）");
  eq(remaining.length, 0, "不留在队列");
}
{
  const s = sender([404]);
  const { result } = await replayQueue([W({})], s.fn);
  eq(result.rejected, 1, "404 也是放弃（资源没了，补发无意义）");
}
{
  // 顺序：队列必须按给定顺序发。乱序补发会让"先改时长、再改依附其上的字幕"倒过来。
  const s = sender([200, 200, 200]);
  await replayQueue([W({ seq: 1, url: "a" }), W({ seq: 2, url: "b" }), W({ seq: 3, url: "c" })], s.fn);
  eq(s.seen.map((w) => w.url).join(""), "abc", "★ 按队列顺序补发");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[4] 文案（承重）");

const R = (p: Partial<ReplayResult>): ReplayResult => ({
  applied: 0, conflicted: 0, rejected: 0, remaining: 0, authBlocked: false, ...p,
});

eq(describeReplay(R({})), "已恢复与服务器的连接", "什么都没发生时只报恢复");
ok(describeReplay(R({ applied: 3 })).includes("3 处"), "报出补发笔数");
{
  const m = describeReplay(R({ applied: 2, conflicted: 1 }));
  ok(m.includes("2 处") && m.includes("1 处"), "两种下场都报");
  ok(!/全部|已同步/.test(m),
    "★ 有冲突时不许出现「全部/已同步」—— 说圆一次用户就不去核对，而那一笔是真没了"
    + "（6.7 的教训原样适用）");
  ok(/核对|重做/.test(m), "★ 冲突要告诉用户该做什么，不是只报个数字");
}
{
  const m = describeReplay(R({ rejected: 2 }));
  ok(!/全部|已同步/.test(m), "★ 有放弃时同样不许说圆");
  ok(/手动|重做/.test(m), "放弃的要说明需要人来补");
}
{
  const m = describeReplay(R({ authBlocked: true, remaining: 4 }));
  ok(/登录/.test(m) && m.includes("4 处"), "★ 登录失效要说清还剩几处等重新登录");
}
{
  // authBlocked 与普通 remaining 是互斥的两句：都说等于把同一批笔数报两遍
  const m = describeReplay(R({ authBlocked: true, remaining: 4 }));
  eq((m.match(/4 处/g) ?? []).length, 1, "★ 同一批 remaining 只报一次");
}

ok(offlineBannerText(0).includes("联网后自动补发"),
  "★ 横幅必须说清改动会被补发（6.7 那句「不会自动重发」已经不是实话）");
ok(!/不会自动重发|保存不上/.test(offlineBannerText(0)),
  "★ 反过来也不许留着旧口径 —— 反向的谎比乐观的谎更难纠正");
ok(offlineBannerText(3).includes("3 处"), "有暂存时报出笔数");
ok(!offlineBannerText(0).includes("已暂存"), "一笔都没有时不说「已暂存」");

eq(offlineWriteHint(false, false, "PATCH"), undefined,
  "★ 不是断线（500/409…）时不插嘴，交给 describeSaveError 按状态码分类");
ok((offlineWriteHint(true, true, "PATCH") ?? "").includes("暂存"),
  "★ 进了队列要明说暂存住了，否则用户会去重做（补发跑完就是白干一遍）");
ok(/新建|联网/.test(offlineWriteHint(true, false, "POST") ?? ""),
  "★ POST 没进队列要说清「要联网才能新建」，不然用户只会反复点那个按钮");
ok(/编号|服务端/.test(offlineWriteHint(true, false, "POST") ?? ""),
  "★ 并要说明为什么 —— 它同时解释了「为什么别的改动能暂存、偏偏新建不行」");
ok(!/暂存/.test(offlineWriteHint(true, false, "POST") ?? ""),
  "★ 没排队的绝不能说成暂存住了（那才是真正的假的已保存）");
ok((offlineWriteHint(true, false, "PATCH") ?? "").includes("未保存"),
  "断线但没排上队（理论上罕见）仍如实说未保存");

// ───────────────────────────────────────────────────────────────────────
console.log("\n[5] outboxStore：注入 / 落盘 / hydrate / 并发");

/** 内存假 I/O。真实现（`lib/persistIO.ts`）import 了 @tauri-apps，node 下加载不了 ——
 *  规则层与 store 刻意不碰那些，这一节才验得成。 */
const fakeIO = () => {
  const state: { saved: QueuedWrite[] | null; saves: number } = { saved: null, saves: 0 };
  const io: OutboxIO = {
    async load() { return state.saved ? [...state.saved] : []; },
    async save(q) { state.saves++; state.saved = [...q]; },
  };
  return { io, state };
};

resetOutbox();
setOutboxIO(null);
ok(!isDurable(), "★ 没注入 I/O 时 isDurable 为假（浏览器下队列只在内存，界面据此如实改口）");

{
  const { io, state } = fakeIO();
  setOutboxIO(io);
  ok(isDurable(), "注入后 isDurable 为真");

  let notified = 0;
  const unsub = subscribeOutbox(() => { notified++; });

  ok(noteFailedWrite("/v2/shots/a", "PATCH", '{"x":1}', 100), "断线的 PATCH 入队");
  eq(getOutboxCount(), 1, "队列长度 1");
  eq(notified, 1, "订阅者收到通知");
  await new Promise((r) => setTimeout(r, 0));
  eq(state.saves, 1, "★ 入队即落盘（等重启再存 = 崩溃时全丢）");

  ok(!noteFailedWrite("/v2/shots", "POST", "{}", 100), "POST 不入队（canQueue 挡住）");
  eq(getOutboxCount(), 1, "队列没变");

  const before = getOutbox();
  ok(!noteFailedWrite("/v2/media/upload", "PUT", "{}", 100), "上传端点不入队");
  ok(getOutbox() === before,
    "★ 没入队时引用**不变**（useSyncExternalStore 要求 getSnapshot 引用稳定，"
    + "每次返回新数组会无限重渲染）");

  ok(noteFailedWrite("/v2/shots/a", "PATCH", '{"x":2}', 200), "同目标再改一次");
  eq(getOutboxCount(), 1, "合并，不堆积");
  eq(getOutbox()[0].body, '{"x":2}', "留的是新值");

  unsub();
  const n0 = notified;
  noteFailedWrite("/v2/shots/b", "PATCH", "{}", 300);
  eq(notified, n0, "退订后不再收到通知");
}

{
  // hydrate：上次残留的队列要读回来，且 seq 要接着最大的往下走
  resetOutbox();
  const { io, state } = fakeIO();
  state.saved = [W({ seq: 7, url: "/v2/shots/old" }), W({ seq: 3, url: "/v2/shots/older" })];
  setOutboxIO(io);
  eq(await hydrateOutbox(), 2, "读回两笔");
  eq(getOutbox().map((w) => w.seq).join(","), "3,7", "★ 按 seq 排序（落盘顺序不保证）");
  noteFailedWrite("/v2/shots/new", "PATCH", "{}", 400);
  ok(getOutbox()[2].seq > 7,
    "★ 新笔的 seq 接在最大值之后（重号会让排序错乱，补发顺序跟着乱）");
}
{
  // 坏 I/O 不能让启动挂掉，也不能把内存队列清空
  resetOutbox();
  setOutboxIO({
    async load() { throw new Error("disk on fire"); },
    async save() { throw new Error("disk on fire"); },
  });
  eq(await hydrateOutbox(), 0, "★ 读盘失败按空队列继续（不能因此打不开软件）");
  ok(noteFailedWrite("/v2/shots/a", "PATCH", "{}", 1), "写盘会失败也照样入队");
  // ⚠️ 必须**先**让那个被吞掉的 rejection 结算，再查队列。
  // 反过来写（变异测试实测逃逸）：`save()` 的 catch 还没跑，此刻队列当然还在，
  // 于是"落盘失败不丢队列"这条断言测的是"落盘还没失败时队列在" —— 纯装饰。
  await new Promise((r) => setTimeout(r, 0));
  eq(getOutboxCount(), 1,
    "★ 落盘失败**不丢**内存队列 —— 为一次写盘失败就丢掉用户的改动是本末倒置");
}

{
  resetOutbox();
  const { io } = fakeIO();
  setOutboxIO(io);
  noteFailedWrite("/v2/shots/a", "PATCH", "{}", 1);
  noteFailedWrite("/v2/shots/b", "PATCH", "{}", 2);

  // 并发保护：恢复连接的那一下可能同时来自探测轮询和某个成功的请求
  let inFlight = 0, maxInFlight = 0;
  const slow = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--; return 200;
  };
  const [a, b] = await Promise.all([runReplay(slow), runReplay(slow)]);
  eq(maxInFlight, 1, "★ 同一时刻只有一趟补发在跑（两趟并行会把同一笔发两次）");
  ok(a !== null || b !== null, "至少一趟真的跑了");
  eq(b === null || a === null, true, "★ 另一趟直接返回 null，不排队等着再发一遍");
  eq(getOutboxCount(), 0, "补发成功后队列清空");
}
{
  resetOutbox();
  setOutboxIO(null);
  eq(await runReplay(async () => 200), null, "★ 空队列时 runReplay 返回 null（调用方据此不报补发结果）");
}
resetOutbox();
setOutboxIO(null);

// ───────────────────────────────────────────────────────────────────────
console.log("\n[6] 快照 + 接线（源码断言）");

{
  const snap = makeSnapshot("p1", { shots: [] }, 1000);
  eq(snap.version, SNAPSHOT_VERSION, "带版本号");
  eq(snap.projectId, "p1", "带项目 id");
  eq(snap.savedAt, 1000, "带时刻");
  ok(isUsableSnapshot(snap, "p1"), "自己造的快照可用");
  ok(!isUsableSnapshot(snap, "p2"),
    "★ 项目 id 不符即作废 —— 读错目录会把别的项目的镜头摆进当前项目，"
    + "那比空编辑器坏得多，而且用户不一定看得出来");
  ok(!isUsableSnapshot({ ...snap, version: SNAPSHOT_VERSION + 1 }, "p1"),
    "★ 版本不符即作废（旧结构喂给新代码 = 零星字段 undefined，比打不开更难查）");
  ok(!isUsableSnapshot({ ...snap, detail: null }, "p1"),
    "detail 为 null 作废（写了一半的文件解析出来可能就是这样）");
  ok(!isUsableSnapshot({ ...snap, savedAt: NaN }, "p1"), "savedAt 非有限数作废");
  ok(!isUsableSnapshot(null, "p1"), "null 作废");
  ok(!isUsableSnapshot("{}", "p1"), "字符串作废");
}
{
  const t = 10_000_000;
  eq(describeSnapshotAge(t, t), "刚刚", "同一刻");
  eq(describeSnapshotAge(t, t + 59_000), "刚刚", "不到一分钟");
  eq(describeSnapshotAge(t, t + 60_000), "1 分钟前", "一分钟");
  eq(describeSnapshotAge(t, t + 3600_000), "1 小时前", "一小时");
  eq(describeSnapshotAge(t, t + 86400_000 * 3), "3 天前", "三天");
  eq(describeSnapshotAge(t, t - 5000), "刚刚", "★ 时钟回拨不给出负数（夹持到 0）");
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

{
  const T = read("src/lib/trackedFetch.ts");
  ok(/noteFailedWrite\(/.test(T),
    "★ 入队挂在写请求的**唯一出口**上（写请求 25+ 处，逐个接必漏 —— "
    + "本文件第三次因为这个理由被选中当接线点）");
  ok(/isUnreachable\(e\)/.test(T),
    "★ 只有连不上才排队：一次 500 是「服务端拒绝了」，补发一百次还是同一个 500");
  const iQueue = T.indexOf("const queued =");
  const iEnd = T.indexOf("endWrite(e,");
  ok(iQueue >= 0 && iEnd >= 0 && iQueue < iEnd,
    "★ 入队在 endWrite 之前：顶栏那句话的内容取决于这一笔到底暂存住了没有");

  const A = read("src/api.ts");
  ok(/export async function sendQueuedWrite/.test(A), "补发发送器在 api.ts（authHeaders 只在那里）");
  ok(/sendQueuedWrite[\s\S]{0,900}?await fetch\(/.test(A)
     && !/sendQueuedWrite[\s\S]{0,900}?fetchTracked\(/.test(A),
    "★ 补发**不走** fetchTracked：它的 catch 会把失败的这笔重新塞回我们正在遍历的队列");
  ok(/sendQueuedWrite[\s\S]{0,900}?authHeaders\(\)/.test(A),
    "★ 补发时**现取** Authorization（队列刻意不存 token：磁盘明文 JSON 不该有它）");

  const M = read("src/main.tsx");
  ok(/setOutboxIO\(tauriOutboxIO\)/.test(M) && /hydrateOutbox\(\)/.test(M), "启动时注入并读回队列");
  const iInject = M.indexOf("setOutboxIO(");
  const iRender = M.indexOf("createRoot(");
  ok(iInject >= 0 && iRender >= 0 && iInject < iRender,
    "★ 注入在 render **之前**：晚一步，断网启动时最早那几笔失败就只进内存队列，关掉软件即丢");
  ok(/if \(IS_TAURI\) \{/.test(M) && !/if \(!IS_TAURI\)/.test(M),
    "★ 条件的方向：**桌面端**注入。写反了就是桌面端丢盘、浏览器里注入一个"
    + "调不通的 appDataDir —— 两头都坏，而且都不报错"); 

  const App = read("src/App.tsx");
  ok(/runReplay\(sendQueuedWrite\)/.test(App), "断→通跑补发");
  ok(/describeReplay\(r\)/.test(App), "并把结果原原本本说出来");
  ok(/useSyncExternalStore\(subscribeOutbox, getOutboxCount\)/.test(App),
    "★ 待补发笔数靠订阅而不是轮询（入队发生在 trackedFetch 里，不在任何组件中）");
  ok(/describeSnapshotAge\(snapshotAt/.test(App),
    "★ 用着本机快照时必须说出来 —— 编辑器看起来完全正常，这是唯一的提醒");

  const P = read("src/hooks/useProject.ts");
  const iSeqGuard = P.indexOf("if (my !== seq.current) return;");
  const iWrite = P.indexOf("tauriSnapshotIO.write(");
  ok(iSeqGuard >= 0 && iWrite >= 0 && iSeqGuard < iWrite,
    "★ 落盘在序号校验**之后**：过期响应覆盖盘上更新的快照 = 下次断网启动读回一个"
    + "比内存里更旧的世界，且完全看不出来");
  ok(/tauriSnapshotIO\.remove\(/.test(P), "项目 404/410 时删掉快照（不留着骗下一次启动）");
  ok(/detailRef/.test(P) && !/\}, \[projectId, detail\]\)/.test(P),
    "★ 用 ref 读「内存里有没有数据」，不把 detail 放进 refreshDetail 的依赖"
    + "（那会让每次数据变化都换新引用，连锁触发一串多余的全量刷新）");
}
{
  // 规则层必须留在 node 可加载的范围内 —— 否则这整个脚本都跑不起来
  for (const f of ["src/lib/outbox.ts", "src/lib/outboxStore.ts", "src/lib/snapshot.ts"]) {
    const src = read(f);
    ok(!/@tauri-apps/.test(src) && !/from "react"/.test(src) && !/\.\.\/api/.test(src),
      `${f} 不依赖 Tauri/React/api（保住 node 可验证性）`);
  }
  ok(/@tauri-apps/.test(read("src/lib/persistIO.ts")),
    "落盘实现单独一个文件（它必须 import @tauri-apps，所以规则层不能碰它）");
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败");
process.exit(fail === 0 ? 0 : 1);
