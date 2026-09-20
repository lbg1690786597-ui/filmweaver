/**
 * verify-shot-rev.ts — 乐观锁的客户端一半（批次 2 / 2.3）
 *
 * ## 分工：服务端那半由 python 脚本验，这里验"送上去的是哪个版本号"
 *
 * 后端的比对与 409 由 `backend/scripts/verify_optimistic_lock.py` 在**真实
 * 路由函数 + 真实 SQLite** 上跑（含"被拒后库里仍是先写方的值"）。
 * 但那边测不到本条真正容易做错的地方：
 *
 *   **客户端把哪个版本号当作 base。** 送"库里最新的"→ 永远相等 → 409 永不触发，
 *   锁写了等于没写，而且任何静态检查都看不出问题（代码里字段都在、值也都对）。
 *
 * 所以这里在 node 下把两个"客户端"真的跑起来：各自一份 `createRevRegistry()`
 * + `createStagedWriter()`，接到一个**按后端同一条规则实现**的假服务端上，
 * 然后重演验收场景。⑥ 会把后端源码里的那条规则抠出来核对，
 * 防止假服务端与真服务端悄悄漂移。
 *
 * ## 六节
 *   ① 注册表规则：有未落库改动时**不**采纳服务端版本号（本条的成败所在）
 *   ② 验收场景：A 拖完落库、B 正在拖 → B 被拒且本地值保留
 *   ③ 假冲突不许有：B 没有未落库改动、刷新过详情 → 再改必须成功
 *   ④ 被拒之后能继续干活（forget → 下一次以自己的版本为准）
 *   ⑤ 切项目清空，老后端不下发 rev 时退回"没有锁"而不是"全部 409"
 *   ⑥ 静态守卫：前端真的在发 base_transform_rev、真的按 409 分支处理；
 *      后端真的在比对并回 409
 *
 * ⚠️ **B4（2026-09-11）后 ⑥ 的落点换了地方**：版本号注册表的读写从
 * 「App 直接摸 `lib/shotRev` 单例」改成「经 `projectStore` 代管」——
 * 理由与断言的逐条对照写在该节开头的注释里。本节其余五节的语义一字未改。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRevRegistry } from "../src/lib/shotRev";
import { createStagedWriter } from "../src/lib/stagedWrite";

//: 读 backend/ 一律走这里 —— 公开仓（CI）没有 backend/，直接读会 ENOENT 崩掉整条发版链路
import { readBackend, skipBackend } from "./backendSrc";

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

type TM = Record<string, number>;

/** 与后端 `patch_shot_timeline` 同一条规则（⑥ 会核对后端源码确实如此）：
 *  带了 base 且与当前版本不一致 → 409 且**不写**；不带 base → 跳过校验。 */
function fakeServer() {
  let stored: TM | null = null;
  let rev = "0";
  let n = 0;
  let rejects = 0;
  return {
    get value() { return stored; },
    get rev() { return rev; },
    get rejects() { return rejects; },
    /** 客户端拉详情时看到的那一行 */
    shotRow: () => ({ id: "s1", transform_rev: rev }),
    patch(tm: TM, base?: string): { status: number; transform_rev?: string } {
      if (base !== undefined && base !== rev) { rejects++; return { status: 409 }; }
      stored = tm;
      rev = `r${++n}`;
      return { status: 200, transform_rev: rev };
    },
  };
}

class Conflict extends Error {
  status = 409;
}

/** 一个客户端 = 版本号注册表 + 落库器 + App.commitTransform 的那套处理 */
function client(srv: ReturnType<typeof fakeServer>) {
  const revs = createRevRegistry();
  const warnings: string[] = [];
  const writer = createStagedWriter<TM>({
    delayMs: 250,
    // 假时钟：不注入的话 setTimeout 会让脚本挂 250ms 且顺序不可控
    schedule: () => 0, cancel: () => {},
    commit: async (shotId, tm) => {
      const r = srv.patch(tm, revs.base(shotId));
      if (r.status === 409) {
        revs.forget(shotId);                     // 与 App.tsx 的 409 分支一致
        warnings.push("该镜头已被其他窗口修改");
        throw new Conflict("409");
      }
      revs.noteWritten(shotId, r.transform_rev);
    },
  });
  return {
    revs, writer, warnings,
    /** 拉一次详情：按规则收版本号（有未落库改动的镜头跳过） */
    refresh: () => revs.seed([srv.shotRow()], (id) => writer.peek(id) !== undefined),
    /** 拖动 n 帧再松手 */
    async drag(frames: number, to: number) {
      for (let i = 1; i <= frames; i++) writer.stage("s1", { opacity: i });
      await writer.writeNow("s1", { opacity: to }).catch(() => {});
    },
  };
}

/* ------------------------------------------------------------------ */
console.log("\n① 注册表规则：有未落库改动时不采纳服务端版本号");

{
  const r = createRevRegistry();
  check("初始没有任何版本号", r.size(), 0);
  check("没播种过 → 不带 base（服务端跳过校验，等同旧行为）", r.base("s1"), undefined);

  r.seed([{ id: "s1", transform_rev: "rA" }]);
  check("详情播种", r.base("s1"), "rA");

  // 关键分支：本地还有没落库的改动 → 屏幕上是用户自己的值，
  // 采纳对方的版本号等于主动放弃冲突检测
  r.seed([{ id: "s1", transform_rev: "rB" }], (id) => id === "s1");
  check("有未落库改动 → **保留旧版本号**", r.base("s1"), "rA");

  r.seed([{ id: "s1", transform_rev: "rB" }], () => false);
  check("没有未落库改动 → 采纳新版本号（否则会有假冲突）", r.base("s1"), "rB");

  r.noteWritten("s1", "rC");
  check("自己写成功 → 用服务端回的新版本号", r.base("s1"), "rC");
  r.noteWritten("s1", undefined);
  check("老后端不回版本号 → 删掉手里过期的那个，而不是留着去撞 409",
        r.base("s1"), undefined);

  r.seed([{ id: "s1", transform_rev: "rD" }, { id: "s2", transform_rev: null }]);
  check("后端没下发 rev 的镜头不进注册表", r.base("s2"), undefined);
  check("只收有 rev 的那些", r.size(), 1);

  r.forget("s1");
  check("forget 后不带 base（用户再操作一次即以自己的为准）", r.base("s1"), undefined);
  r.seed([{ id: "s1", transform_rev: "rE" }]);
  r.clear();
  check("clear 清空（切项目）", r.size(), 0);
}

/* ------------------------------------------------------------------ */
console.log("\n② 验收场景：A 拖完落库、B 正在拖 → B 被拒且本地值保留");

{
  const srv = fakeServer();
  const A = client(srv);
  const B = client(srv);
  // 两端都打开了同一个镜头（此时都还没有未落库改动）
  A.refresh(); B.refresh();
  check("两端拿到同一个版本号", [A.revs.base("s1"), B.revs.base("s1")], ["0", "0"]);

  await A.drag(180, 100);
  check("A：拖 180 帧只落 1 笔", A.writer.stats.commits, 1);
  check("A 的值进了服务端", srv.value, { opacity: 100 });
  ok("A 没有收到任何冲突提示", A.warnings.length === 0);

  // B 在 A 落库期间一直在拖 —— 于是它手里的版本号还是 "0"
  for (let i = 1; i <= 90; i++) B.writer.stage("s1", { opacity: i });
  B.refresh();          // 拖动中若刷新了详情，也必须保留旧版本号
  check("B 拖动中刷新详情 → 版本号仍是编辑所基于的那个", B.revs.base("s1"), "0");

  await B.writer.writeNow("s1", { opacity: 90 }).catch(() => {});
  check("B 的写被拒", srv.rejects, 1);
  check("服务端仍是 A 的值 —— 没有静默覆盖", srv.value, { opacity: 100 });
  check("B 收到一次提示（不是静默失败）", B.warnings.length, 1);
  check("B 本地仍保留自己的值（画面不回弹，顶栏显示未保存）",
        B.writer.peek("s1"), { opacity: 90 });
  check("B 记了一次失败（2.1 的顶栏据此报错）", B.writer.stats.failures, 1);
}

/* ------------------------------------------------------------------ */
console.log("\n③ 假冲突不许有：改自己眼前看到的值必须成功");

{
  const srv = fakeServer();
  const A = client(srv);
  const B = client(srv);
  A.refresh(); B.refresh();

  await A.drag(30, 60);                       // A 改了
  B.refresh();                                 // B 刷新详情，屏幕上已是 A 的值
  ok("B 没有未落库改动时采纳了新版本号", B.revs.base("s1") === srv.rev);

  await B.drag(30, 70);                        // B 基于 A 的值继续改
  check("B 成功（这不是冲突，是接着别人的改）", srv.rejects, 0);
  check("服务端是 B 的值", srv.value, { opacity: 70 });
  ok("B 全程没有被误报冲突", B.warnings.length === 0);
}

/* ------------------------------------------------------------------ */
console.log("\n④ 被拒之后还能干活：提示给过一次，再操作即以自己的为准");

{
  const srv = fakeServer();
  const A = client(srv);
  const B = client(srv);
  A.refresh(); B.refresh();

  await A.drag(10, 40);
  await B.drag(10, 80);                        // B 手里是旧版本号 → 409
  check("第一次被拒", srv.rejects, 1);
  check("被拒后不再持有 base", B.revs.base("s1"), undefined);

  await B.drag(10, 80);                        // 用户再拖一次
  check("第二次成功（不带 base，服务端跳过校验）", srv.rejects, 1);
  check("服务端现在是 B 的值", srv.value, { opacity: 80 });
  check("只提示了一次，没有变成「怎么改都 409」", B.warnings.length, 1);
}

/* ------------------------------------------------------------------ */
console.log("\n⑤ 老后端 / 切项目");

{
  const srv = fakeServer();
  const C = client(srv);
  // 老后端不下发 transform_rev → 注册表空 → 不带 base → 退回"没有锁"，
  // 而不是把每一次写都变成 409
  C.revs.seed([{ id: "s1" }]);
  check("老后端不下发 rev → 注册表空", C.revs.size(), 0);
  await C.drag(5, 20);
  check("照样能存（向后兼容）", srv.value, { opacity: 20 });
  ok("没有任何冲突提示", C.warnings.length === 0);
}

/* ------------------------------------------------------------------ */
console.log("\n⑥ 静态守卫：前后端两侧都真的在做这件事");

{
  const api = readFileSync(join(ROOT, "src/api.ts"), "utf8");
  ok("api.ts 的 ShotInfo 有 transform_rev", /transform_rev\?: string \| null/.test(api));
  ok("patchShotTimeline 收 baseTransformRev", /baseTransformRev\?: string/.test(api));
  ok("并且真的发到 base_transform_rev 字段上",
     /base_transform_rev: patch\.baseTransformRev \?\? null/.test(api),
     "字段名对不上后端就永远读不到 base，锁静默失效");
  // ⚠️ 这条**不能**写成 `/transform_rev\?: string \| null;\s*\}>;/` ——
  // 那样是在钉"它必须是响应类型的最后一个字段"，而不是"它存在"。
  // 3.1 在后面追加了 clip_in_sec / clip_dur_sec，这条就假红了一次。
  // 改成：先框出 patchShotTimeline 的响应类型，再在框内找它。
  const patchResp = api.match(
    /patchShotTimeline:[\s\S]*?return r\.json\(\) as Promise<\{([\s\S]*?)\}>;/)?.[1] ?? "";
  ok("patchShotTimeline 的响应类型被扫到", patchResp.length > 0);
  ok("响应类型里有 transform_rev（否则拿不到新版本号）",
     /transform_rev\?: string \| null;/.test(patchResp));
  ok("非 2xx 抛 SaveHttpError（调用方要靠 status 认 409）",
     /throw new SaveHttpError\(r\.status/.test(api),
     "抛裸 Error 就只能靠正则去认 '409:' 前缀，迟早被改坏");
}

{
  const app = readFileSync(join(ROOT, "src/App.tsx"), "utf8");
  // ⚠️ 3.7 把落库拆成了两层：乐观锁这一整套（base / noteWritten / 409 处理）
  // 住在 `writeTransform` 里，`commitTransform` 只是在它外面加了入撤销栈。
  // 断言随之下移一层。按**真实边界**切（下一个声明当终点），不用固定字符数 ——
  // 固定窗口够不到函数末尾时断言会长期红着，而变异测试还会因为"基线本来就红"
  // 把每个变异都报成"转红"，等于什么都没测。
  const i = app.indexOf("const writeTransform");
  const body = app.slice(i, app.indexOf("const commitTransform"));
  // ⚠️ B4（2026-09-11）把这一整套从"App 直接摸 `lib/shotRev` 的单例"
  // 改成了"经 `projectStore` 代管"——因为版本号注册表与 `detail` 是同一份
  // 事实的两半，而 `detail` 归 store 所有。
  //
  // 本节的**断言意图一个字没改**（base 送对了没有 / 新版本号收下了没有 /
  // 409 有没有 forget 并 rethrow / 详情回来有没有按 hasPending 播种 /
  // 切项目有没有清空），改的只是"这些调用现在长什么样"。
  // 下面一律用**行为**（哪个方法名、传了什么参数）而不是"摸的是哪个模块"来断言。
  ok("writeTransform 带上 base 版本号",
     /baseTransformRev: transformRevBase\(shotId\)/.test(body));
  ok("落库成功后记下新版本号（连着改不会撞上自己刚写的值）",
     /noteTransformRev\(shotId, r\.transform_rev\)/.test(body));
  ok("有 409 专属分支", /e\.status === 409/.test(body));
  ok("409 时 forget（否则用户被锁死在冲突里）", /forgetTransformRev\(shotId\)/.test(body));
  ok("409 时给用户看得懂的提示", /say\("该镜头已被其他窗口修改/.test(body));
  // 切段查，不用通配跨段：body 里有两条 rethrow，通配段会从 forget 一路够到
  // 后面那条 `say(String(e)); throw e;`，于是"删掉 409 的 rethrow"照样绿。
  const c409 = body.slice(body.indexOf("forgetTransformRev(shotId);"),
                          body.indexOf("say(String(e))"));
  ok("409 仍然 rethrow（stagedWrite 靠异常保留本地值）",
     c409.length > 0 && /throw e;/.test(c409));
  // 撤销/重做闭包也必须走这一层，否则撤销那次写不带 base、绕过乐观锁
  ok("撤销/重做闭包走 writeTransform（否则撤销的那次写会绕过乐观锁）",
     /async \(\) => \{ await writeTransform\(shotId, prev\); \}/.test(app));

  // ---- B4：播种与清空的**新家** ----
  // 这两条以前断言的是 App 里的 `useEffect([detail])` 与 `resetWorkspace()`。
  // 现在它们住在 store 里，断言随之搬家 —— 但**必须真的检查新位置**，
  // 不能改成"反正某处有就行"：播种要在 `refreshDetail` 内部、紧挨 `set`
  // 之前（差一帧就是"用上一轮的版本号发这次写"），清空要在 `clearDetail`
  // 内部（差一句就是"新项目带着旧项目的版本号"）。两处都钉到具体函数体里。
  const store = readFileSync(join(ROOT, "src/stores/projectStore.ts"), "utf8");
  const iR = store.indexOf("refreshDetail: async");
  const rBody = store.slice(iR, store.indexOf("refreshSoon: () =>", iR));
  ok("详情回来时按 hasPending 播种版本号（在 refreshDetail 内部）",
     /shotRev\.seed\(d\.shots, hasPendingFn\)/.test(rBody),
     "不传 hasPending 就会采纳对方版本号 → 409 永不触发，锁形同不存在");
  ok("……且播种早于 set（同一拍，不许隔一帧）",
     rBody.indexOf("shotRev.seed(d.shots, hasPendingFn)") > 0
     && rBody.indexOf("shotRev.seed(d.shots, hasPendingFn)")
        < rBody.indexOf("set({ detail: d, snapshotAt: null })"),
     "挂在 effect 上时 set 与 seed 之间隔着一次渲染，那一帧里发出的写带的是旧版本号");
  // 播种也不能插在 `detailRef = d` 与 `set(...)` **中间** —— 那两句的相邻
  // 是承重的（`verify-detail-reconcile.ts`：state 与 detailRef 必须是同一个
  // 复用后的对象，否则下一轮整份复用不上，1424 张卡片全部重渲染）。
  // 这条不是重复：它防的是"为了让播种更靠近 set 而把它挪进去"这个很自然的改动。
  ok("……且没插进 detailRef 与 set 之间（那两句必须相邻）",
     /detailRef = d;\s*\n\s*set\(\{ detail: d, snapshotAt: null \}\);/
       .test(rBody),
     "插在中间会切断 detailRef/set 的相邻关系，reconcileDetail 的复用随之失效");
  const iC = store.indexOf("clearDetail: () => {");
  const cBody = store.slice(iC, store.indexOf("transformRevBase:", iC));
  ok("清 detail 时一并清空注册表（clearDetail 内部）",
     /shotRev\.clear\(\)/.test(cBody),
     "两句话分处两个文件时，新加一条离开项目的路径只会记得调其中一句");
  ok("hasPending 探针由 App 注入（store 不 import React 侧的暂存层）",
     /setPendingProbe\(stagedTransform\.hasPending\)/.test(app)
     && /export function setPendingProbe/.test(store));
  // 探针不能是"注册一次就完事"的：stagedTransform 换实例后仍须指到新的
  ok("探针在 stagedTransform 变化时重新注入",
     /\}, \[stagedTransform\]\);/.test(
       app.slice(app.indexOf("setPendingProbe(stagedTransform.hasPending)"),
                 app.indexOf("setPendingProbe(stagedTransform.hasPending)") + 200)));
  ok("App 里不再直接摸注册表单例（唯一入口是 store）",
     !/from "\.\/lib\/shotRev"/.test(app),
     "两处事实来源 = 将来谁改了 store 那侧的口径，App 这侧会把旧口径盖回去");
}

{
  // 假服务端与真服务端的规则必须是同一条
  // 后端源码只在全仓里有；公开仓（CI）没有 backend/，见 backendSrc.ts 的文件头。
  // ⚠️ 按域搬过家：镜头编辑现在在 routers/shots.py（2026-09-18 拆分）。
  // 不写死单路径 —— 读不到会 null → 整段静默跳过。
  const be = [
    readBackend("app/routers/shots.py"),
    readBackend("app/routes_v2.py"),
  ].filter((x): x is string => x !== null).join("\n") || null;
  if (be === null) skipBackend("后端 transform_rev 与 409 冲突");
  else {
  ok("后端有 transform_rev()", /def transform_rev\(raw: str \| None\) -> str:/.test(be));
  ok("后端把 rev 下发在 /detail 里", /"transform_rev": transform_rev\(s\.transform_meta\)/.test(be));
  ok("后端 PATCH 响应回新 rev", /"transform_rev": transform_rev\(shot\.transform_meta\)\}/.test(be));
  ok("后端收 base_transform_rev", /base_transform_rev: Optional\[str\] = None/.test(be));
  ok("后端：带了 base 且不一致才拒（不带 = 跳过校验）",
     /body\.transform_meta is not None and body\.base_transform_rev is not None/.test(be));
  ok("后端回 409", /status_code=409/.test(be));
  // 校验必须在任何字段改动之前，否则会出现"时长存了、画面没存"的半成功
  const iChk = be.indexOf("body.base_transform_rev is not None");
  const iDur = be.indexOf("if body.duration_sec is not None:", be.indexOf("def patch_shot_timeline"));
  ok("后端把校验放在所有改动之前（拒绝是整笔拒绝）", iChk > 0 && iDur > iChk,
     `校验在 ${iChk}，第一处改动在 ${iDur}`);
  }
}

/* ------------------------------------------------------------------ */
console.log(failed === 0
  ? "\n✅ 2.3 客户端侧通过：后写方被拒且本地值保留，改自己眼前的值不会假冲突"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
