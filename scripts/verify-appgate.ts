/**
 * scripts/verify-appgate.ts — 6.7 顶层门禁 + 断线察觉
 *
 * 分五节：
 *   [1] `decideScreen` 的**穷举**：3×3×2×2 = 36 种状态全跑一遍
 *   [2] 本条目改掉的那个行为：断线时有数据留编辑器、没数据才是断线页
 *   [3] `isUnreachable`：什么算"连不上"（500 不算、取消不算、断网才算）
 *   [4] 可达性登记簿 + `mergeBackendOk`
 *   [5] 接线（源码断言）：两个请求出口都报、后台重探不清状态、横幅说的是实话
 *
 * ## 为什么这一条必须穷举
 *
 * 门禁的失败形态是**整个软件进不去**或者**白屏**，而它的输入是四个可空变量的
 * 组合。手挑几个用例测不出"某两个条件同时成立时两个分支都不返回"这类洞，
 * 而那正是顺序 `if` 最容易出的洞。36 种全跑一遍才是这条的最低要求。
 *
 * 穷举同时钉住两条**不变式**（`App.tsx` 直接依赖它们，见那边的注释）：
 *   · 任何输入都必须落到五种屏之一，不存在"什么都不返回"
 *   · `editor` ⇒ `projectId !== null`（App 用它收窄类型）
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideScreen, isUnreachable, mergeBackendOk,
  shouldLogoutOnProbeError, type GateState, type Screen,
} from "../src/lib/appGate";
import {
  getBackendReach, noteRequestFailed, noteRequestOk,
  resetBackendReach, subscribeBackendReach,
} from "../src/lib/backendReach";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};
const eq = (got: unknown, want: unknown, name: string) =>
  ok(Object.is(got, want), name, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const S = (p: Partial<GateState>): GateState => ({
  backendOk: true, loginRequired: false, projectId: "p1", hasProjectData: true, ...p,
});

// ───────────────────────────────────────────────────────────────────────
console.log("\n[1] decideScreen 穷举（36 种状态）");

const SCREENS: Screen[] = ["probing", "offline", "login", "projects", "editor"];
{
  let n = 0, bad = 0, editorWithoutId = 0;
  const seen = new Set<Screen>();
  for (const backendOk of [true, false, null]) {
    for (const loginRequired of [true, false, null]) {
      for (const projectId of ["p1", null]) {
        for (const hasProjectData of [true, false]) {
          n++;
          const s = decideScreen({ backendOk, loginRequired, projectId, hasProjectData });
          if (!SCREENS.includes(s)) bad++;
          if (s === "editor" && projectId === null) editorWithoutId++;
          seen.add(s);
        }
      }
    }
  }
  eq(n, 36, "确实跑满了 36 种组合");
  eq(bad, 0, "★ 每种状态都落到五种屏之一（没有「什么都不返回」的洞）");
  eq(editorWithoutId, 0,
    "★ 不变式：editor ⇒ projectId !== null（App.tsx 靠它收窄类型）");
  eq(seen.size, 5, "五种屏都是可达的（没有写了却永远进不去的分支）");
}

// 逐条钉死每一屏的判据，穷举只保证"有返回"，不保证"返回对"
eq(decideScreen(S({ backendOk: null, loginRequired: null })), "probing", "启动探测中");
eq(decideScreen(S({ backendOk: true, loginRequired: null })), "probing",
  "★ 后端通了但登录状态还没结论 —— 仍是探测中，不能掉进项目列表闪一下空态");
eq(decideScreen(S({ loginRequired: true })), "login", "要求登录");
eq(decideScreen(S({ projectId: null, hasProjectData: false })), "projects", "没项目 → 列表");
eq(decideScreen(S({})), "editor", "一切正常 → 编辑器");
eq(decideScreen(S({ loginRequired: true, projectId: null })), "login",
  "登录优先于项目列表（顺序不能反，否则未登录也能看到列表壳）");

// ───────────────────────────────────────────────────────────────────────
console.log("\n[2] 断线：分得清「手上有数据」和「只有一个 id」");

eq(decideScreen(S({ backendOk: false, loginRequired: null })), "editor",
  "★ 编辑到一半断线 —— 留在编辑器（换成断线页 = 销毁选中态/播放头/未落库的调整）");
eq(decideScreen(S({ backendOk: false, hasProjectData: false })), "offline",
  "★ 断网启动：localStorage 有 id 但详情从没拿到 → 断线页，不摆空壳编辑器");
eq(decideScreen(S({ backendOk: false, projectId: null, hasProjectData: false })), "offline",
  "断线且没项目 → 断线页");
eq(decideScreen(S({ backendOk: false, projectId: null, hasProjectData: true })), "offline",
  "断线时用户点了「返回项目列表」→ 回到断线页（残留的 detail 不该把他钉在编辑器里）");
eq(decideScreen(S({ backendOk: false, loginRequired: true })), "editor",
  "断线时 loginRequired 的陈旧值不该把正在编辑的人踢去登录页");

// ───────────────────────────────────────────────────────────────────────
console.log("\n[3] isUnreachable：只有「后端没回话」才算连不上");

ok(isUnreachable(new TypeError("Failed to fetch")), "★ 断网：fetch 抛 TypeError");
ok(isUnreachable(new TypeError("fetch failed")), "node 下的措辞不同，同样算");
ok(!isUnreachable({ status: 500, message: "boom" }),
  "★ 500 不算：后端回了状态码就说明它活着，判成断线会让一次报错宣布离线");
ok(!isUnreachable({ status: 401 }), "401 不算（是票的问题，不是网的问题）");
ok(!isUnreachable({ status: 404 }), "404 不算");
ok(!isUnreachable({ name: "AbortError" }),
  "★ 主动取消不算：预取/渲染随时在 abort，算进去会天天误报离线");
ok(!isUnreachable(new SyntaxError("Unexpected token")),
  "解析失败不算：后端回了东西，只是内容不对");
ok(!isUnreachable(null) && !isUnreachable(undefined), "空值不算");
{
  // 带状态码的 TypeError 是构造出来的极端情况，但判据的**顺序**要正确：
  // "有没有回话"优先于"是不是 TypeError"。
  const e = new TypeError("weird"); (e as unknown as { status: number }).status = 502;
  ok(!isUnreachable(e), "★ 状态码优先于类型：有 502 就说明后端回话了");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[4] 可达性登记簿 / 合并");

{
  resetBackendReach();
  eq(getBackendReach(), null, "初始没有结论");
  let hits = 0;
  const off = subscribeBackendReach(() => hits++);

  ok(noteRequestOk(), "第一次成功 → 变了");
  eq(getBackendReach(), true, "记成连得上");
  ok(!noteRequestOk(), "★ 再成功不再通知（每个请求都通知会把 React 刷爆）");
  eq(hits, 1, "  只通知了一次");

  ok(!noteRequestFailed({ status: 500 }), "★ 500 不改变结论");
  eq(getBackendReach(), true, "  仍然是连得上");
  ok(!noteRequestFailed({ name: "AbortError" }), "取消不改变结论");

  ok(noteRequestFailed(new TypeError("Failed to fetch")), "★ 断网 → 变了");
  eq(getBackendReach(), false, "记成连不上");
  eq(hits, 2, "  通知了第二次");

  ok(noteRequestOk(), "恢复 → 又变了");
  eq(getBackendReach(), true, "记回连得上");
  eq(hits, 3, "  通知了第三次");
  off();
  noteRequestFailed(new TypeError("x"));
  eq(hits, 3, "退订之后不再收到");
  resetBackendReach();
}

eq(mergeBackendOk(true, false), false,
  "★ 真实请求刚断 → 判离线（它比上一次探测新）");
eq(mergeBackendOk(null, false), false, "探测还没结论时，断线也算数");
eq(mergeBackendOk(null, true), null,
  "★ 某个 GET 通了**不能**把探测顶成 true —— 那时登录状态还是 null，"
  + "硬判 true 会从 probing 掉进 projects 闪一下空列表");
eq(mergeBackendOk(true, null), true, "没有请求结论时听探测的");
eq(mergeBackendOk(false, true), false, "探测说不行就是不行");

ok(shouldLogoutOnProbeError({ status: 401 }), "401 该登出");
ok(shouldLogoutOnProbeError({ status: 403 }), "403 该登出");
ok(!shouldLogoutOnProbeError({ status: 503 }),
  "★ 503 不该登出：断网恢复头几秒常见，按它登出 = 一次抖动就要重扫码");
ok(!shouldLogoutOnProbeError(new TypeError("Failed to fetch")), "网络错不该登出");
ok(!shouldLogoutOnProbeError(undefined), "没错误信息时不登出");

/* 🔀 6.8 预期 diff：`reconnectNotice` 的三条断言搬走了，不是删掉了。
 *
 * 为什么这个 diff 是预期的：那三条钉的是「恢复文案不许说得比事实好听」，
 * 而 6.7 的事实是**没人重放**，所以它们钉的具体字眼是「不许出现同步/已保存」。
 * 6.8 上了补发队列，事实变成**真的会重放**，那个函数连同它的前提一起作废
 * （`appGate.ts` 里留了墓碑说明为什么不能只改字符串：`failedCount` 会和
 * 补发结果重复计数）。
 *
 * **不变式一个字没变**，只是换了归属：现在由 `verify-outbox.ts` 对
 * `describeReplay` 钉同一条 —— 有冲突/有放弃时不许出现「全部/已同步」。
 * 那边比这里更严，因为它区分得出 applied / conflicted / rejected 三种下场。
 * 如果哪天两处都没有这条断言，那就是真的丢了守护，而不是搬了家。 */

// ───────────────────────────────────────────────────────────────────────
console.log("\n[5] 接线（源码断言）");

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

{
  const T = read("src/lib/trackedFetch.ts");
  // 写请求的两条路径（成功 / 抛异常）都要报，少一条就是"只有失败的写才算数"
  ok((T.match(/noteRequestOk\(\)/g) ?? []).length >= 2,
    "★ 写与非写两条路径都报「连得上」（少一条 = 只浏览的用户断网察觉不到）");
  ok((T.match(/noteRequestFailed\(/g) ?? []).length >= 2,
    "★ 两条路径的 catch 都报「连不上」");
  ok(!/noteRequestFailed\(\s*resp/.test(T),
    "非 2xx **不**报连不上（那是「没存上」，不是「没连上」）");

  const A = read("src/api.ts");
  ok(/async function get<T>[\s\S]{0,600}?fetchTracked\(/.test(A),
    "★ 读请求也走 fetchTracked（全软件绝大多数请求是读，只盯写会漏）");

  const U = read("src/hooks/useAuth.ts");
  ok(/probe\(true\)/.test(U), "★ 15 秒轮询走后台模式");
  ok(/background\s*=\s*false/.test(U), "前台仍是默认（首次探测要清空旧结论）");
  ok(/if\s*\(!background\)\s*\{[\s\S]{0,120}?setLoginRequired\(null\)/.test(U),
    "★ 后台重探**不清**既有结论（清了 = 每 15 秒把编辑器卸载重建一次）");
  ok(/mergeBackendOk\(/.test(U) && /subscribeBackendReach/.test(U),
    "把真实请求的可达性并进 backendOk");
  ok(/shouldLogoutOnProbeError\(/.test(U), "authMe 失败按状态码决定登不登出");
  // 用调用形式 `reconnectNotice(` 而不是裸名字：文件头的注释里还提着它
  // （指路到 appGate 的墓碑），那是文档不是依赖，不该被判失败。
  ok(/onReconnect\?\.\(\)/.test(U) && !/reconnectNotice\(/.test(U),
    "★ 断→通只**回调**，不自己造句（说什么取决于补发结果，而队列不该被会话层知道）");
  ok(/wasDown\.current = false;\s*\n\s*onReconnect/.test(U),
    "★ 先落旗再回调：回调里是发请求，会再碰 backendReach，旗子还举着就可能补发两趟");

  const App = read("src/App.tsx");
  ok(/decideScreen\(\{/.test(App), "App 用 decideScreen 而不是自己写顺序 if");
  ok(/hasProjectData:\s*detail\s*!==\s*null/.test(App),
    "★ 用 detail 而不是 projectId 判「手上有没有数据」");
  ok(!/if \(backendOk === false\) \{\s*\n\s*return \(/.test(App),
    "旧的「断线一律换页」门禁已经拆掉");
  /* 🔀 6.8 预期 diff：横幅原来钉「保存不上」+「不会自动重发」两句字面量。
   *
   * 为什么这个 diff 是预期的：那两句在 6.7 时是**实话**，现在两句都成了假话 ——
   * 改动会先记在本机、联网会自动补发。断言若原样留着，就是拿测试把一句谎话
   * 焊死在界面上，这比没有断言更坏。
   *
   * 不变式仍然是同一条「断线不换页的代价是必须把话说清楚」，
   * 只是"实话"的内容跟着行为一起变了。所以这里改成钉**文案的来源**：
   * 横幅必须调 `offlineBannerText`，而那句话的措辞由 `verify-outbox.ts`
   * 与队列的真实行为一起钉。把字面量钉在 App.tsx 里的老办法反而钉不住 ——
   * 行为改了字面量不会自己报警，正是这次踩到的。 */
  ok(/offlineBannerText\(pendingWrites\)/.test(App),
    "★ 横幅文案取自 `lib/outbox.ts`（与队列同文件：改行为的人一眼看见要改的话）");
  ok(!/不会自动重发/.test(App),
    "★ 6.7 那句「不会自动重发」必须已经拿掉（现在会重发，留着是反向的谎）");
  ok(/isDurable\(\)/.test(App),
    "★ 浏览器里队列只在内存，横幅要如实改口（假装能持久化 = 又一个假的已保存）");
  ok(/fw-net-bar/.test(App) && /fw-net-bar/.test(read("src/styles.css")),
    "横幅的 class 有对应 CSS");
  ok(/cursor:\s*auto/.test(read("src/styles.css").split(".fw-net-bar")[1] ?? ""),
    "★ 横幅不可点掉（.banner 的 pointer 是给 toast 用的；能关掉就又回到假装没事）");
}

{
  // node 可加载性是 [1]~[4] 的前提：谁 import 了 @tauri-apps 或 react，
  // 本脚本连模块都加载不进来，前四节全部作废。
  for (const f of ["src/lib/appGate.ts", "src/lib/backendReach.ts"]) {
    const src = read(f);
    ok(!/from "@tauri-apps/.test(src) && !/from "react"/.test(src),
      `${f} 不依赖 Tauri/React（保住 node 可验证性）`);
  }
  ok(!/from "\.\.\/stores\//.test(read("src/lib/appGate.ts")),
    "appGate 不 import saveStateStore（判据是「有没有状态码」，不是「是哪个类」）");
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败");
process.exit(fail === 0 ? 0 : 1);
