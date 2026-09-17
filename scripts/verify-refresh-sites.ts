/**
 * verify-refresh-sites —— B3：`refreshDetail` 调用点的**账本守卫**。
 *
 * 背景（一个 1.17 MiB 的坑）
 * -------------------------
 * `detail` 是全应用最大的一个对象（实测 1.17 MiB）。以前"改了点什么"之后
 * 统一动作就是 `await refreshDetail()` —— 一次全量 GET + 一次整树 reconcile。
 * 组件从 `App.tsx` 的 props 里逐个接手之后（B2），每个调用点要不要走全量
 * 就变成了一件**必须逐个交代清楚**的事：省掉是对的，但省错的地方会静默丢更新。
 *
 * B0 已经干掉了纯浪费的那一批（shot 表已有列 → `patchDetail` 就地回填，
 * 见 App 的 `doPatchBreakdown` / `doSwitchVersion` 那几处）。本脚本把
 * **B3 的审计结论**钉住，让"还剩下的这些为什么不能省"不会随时间流失。
 *
 * 四类调用点（数字以 `docs/PLAN-编辑核心架构收敛.md` §12.2 为准）
 * ------------------------------------------------------------
 *   ① 增删镜头 —— 必须全量。`patchDetail` 只能合并**已存在的行**，
 *      插不进新行；而且这些端点的回包只有 id / order（见各 route 的 return），
 *      拼不出完整的一行 ShotInfo。
 *   ② 改顺序 —— 必须全量。服务端会连带重排**别的**镜头，本地拼不出一致结果。
 *   ③ 非镜头数据 —— 必须全量。资产 / 分集 / 项目元数据不在 `patchDetail`
 *      的能力范围内（它只认 shot 表上已有的列）。
 *   ④ 事件驱动 —— 合法。SSE 推来的状态流转，全量是唯一正确的对齐方式。
 *
 * ⚠️ 本脚本的立场是**守卫现状**，不是"证明现状最优"。若哪天给
 * `split_shot` 之类的端点补全了回包（返回完整的两行 ShotInfo），
 * ① 类就能降级 —— 那时**先改这里和 §12.2，再改 App**，别只改一头。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
//: 读 backend/ 一律走这里 —— 公开仓（CI）没有 backend/，判失败会钉死发版链路
import { readBackend, skipBackend } from "./backendSrc";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) { pass++; console.log(`   ✅ ${label}`); }
  else { fail++; console.log(`   ❌ ${label}${detail ? `  — ${detail}` : ""}`); }
}

/** 读源码并剥掉注释行 —— 注释里提到 `refreshDetail` 是在解释，不是在调用。 */
function codeLines(p: string): { n: number; t: string }[] {
  return readFileSync(p, "utf8").split("\n").map((t, i) => ({ n: i + 1, t }))
    .filter(({ t }) => {
      const s = t.trim();
      return s && !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
    });
}

// ---------------------------------------------------------------- ① 增删镜头

/** 函数名 → 它"为什么必须全量"的一句话。 */
const B3_ADD_DELETE: Record<string, string> = {
  addToTimeline: "addSpecialShot 回包只有 shot_id/order，拼不出整行；且是**插入新行**",
  deleteSpecialShot: "deleteShot 硬删，撤销要重插一条 —— 集合变了，patchDetail 管不了",
  doPaste: "批量插新行（addSpecialShot × N），order 全段重排",
  doSplit: "splitShot 切出**新的一行**（tail），且后续所有 order +1",
  doRecut: "recutShot 切成三行，中间那行是新增的",
  doUndoRecut: "undoRecutShot 删掉一行 + 合并前段时长",
};

// ------------------------------------------------------------ ③ 非镜头数据

/** App 侧回调里那些"刷的不是镜头表"的站点，按 JSX 属性名登记。 */
const B3_NON_SHOT_CALLBACKS: { prop: string; why: string }[] = [
  { prop: "onProjectChanged", why: "项目元数据（剧型/画幅等），不在 shot 表" },
  { prop: "onAssetsChanged", why: "资产集合会**增长**，patchDetail 合并不了新资产" },
  { prop: "onRefresh", why: "面板自己的「重新拉一次」，语义就是全量" },
  { prop: "onNarrationVoiceChanged", why: "narration_voice_url 挂在 Project 上，不在 shot 表" },
  { prop: "onSaved", why: "ShotAdvanced 保存 profile_override —— 见 §12.4.2，D 批的现成入口" },
];

// ------------------------------------------------------------------ 跑检查

const appPath = `${DESKTOP}/src/App.tsx`;
ok(existsSync(appPath), "App.tsx 存在");
const app = readFileSync(appPath, "utf8");
const appLines = app.split("\n");

/** 找 `<name>` 这个函数的声明行号（`const name = async (` / `const name = (`）。 */
function findFnLine(name: string): number {
  const re = new RegExp(`^\\s*const\\s+${name}\\s*=\\s*(async\\s*)?\\(`);
  for (let i = 0; i < appLines.length; i++) if (re.test(appLines[i])) return i + 1;
  return -1;
}

/** 从 declLine 起，按大括号配对找函数体的结束行。 */
function findFnEnd(declLine: number): number {
  let started = false;
  let depth = 0;
  for (let i = declLine - 1; i < appLines.length; i++) {
    for (const ch of appLines[i]) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; if (started && depth === 0) return i + 1; }
    }
  }
  return appLines.length;
}

console.log("\n[1] ① 增删镜头：这些函数里必须**仍然**有 refreshDetail（patchDetail 插不进新行）");

for (const [fn, why] of Object.entries(B3_ADD_DELETE)) {
  const decl = findFnLine(fn);
  if (decl < 0) { ok(false, `找得到 ${fn}`, "函数被改名/搬走了 —— 若确实重构过，请同步本表"); continue; }
  const end = findFnEnd(decl);
  const body = appLines.slice(decl - 1, end)
    .filter((t) => { const s = t.trim(); return s && !s.startsWith("//") && !s.startsWith("*"); });
  ok(body.some((t) => /\brefreshDetail\s*\(/.test(t)),
    `${fn} 仍走全量 refreshDetail`,
    `函数体里已经没有 refreshDetail 了。**这未必是错的** —— 但意味着你把增删改成了局部更新，`
    + `那么请确认：新增的行是从哪来的？（${why}）`);
}

console.log("\n[2] ① 增删镜头：这些函数的**回包拼得出一行 ShotInfo 吗** —— 拼不出就不许降级");

{
  /**
   * 逐条核对端点回包。表里写的是"后端 return 了哪些键"，
   * 少一个必填字段（id/order/...）就足以让本地拼出的行与真源漂移。
   */
  // 后端源码只在全仓里有；公开仓（CI）没有 backend/，见 backendSrc.ts 的文件头。
  // ⚠️ 这里原本是 `ok(false, ...)`——把"读不到对面"判成不通过。那在全仓里没错，
  // 但 CI 跑的是只含 desktop/ 的公开仓，等于让一条跨仓断言把发版链路钉死。
  const rs = readBackend("app/routes_v2.py");
  if (rs === null) {
    skipBackend("端点回包字段核对（①类端点能否降级）");
  } else {
    /**
     * 每条 = 一个①类端点的**回包形状**。`path` 是路由字面量（用来确认端点还在），
     * `has` 是回包**确实给了**的键，`lacks` 是拼一行完整 ShotInfo 所必需、
     * 但**服务端没下发**的键 —— 只要 `lacks` 有一个命中，① 类就不能降级。
     */
    /**
     * 每条 = 一个①类端点的**回包形状**。`path` 是路由字面量（用来确认端点还在），
     * `has` 是回包**确实给了**的键，`lacks` 是拼一行完整 ShotInfo 所必需、
     * 但**服务端没下发**的键 —— 只要 `lacks` 有一个命中，① 类就不能降级。
     *
     * ⚠️ 只在**这个函数的函数体**里找 `lacks`，不能全文 grep：
     * `"status"` / `"characters"` 在 routes_v2.py 别处俯拾皆是，全文比对必假红。
     */
    const RETURNS: { path: string; has: string[]; lacks: string[]; why: string }[] = [
      { path: "/shots/special", has: ["shot_id", "order"],
        lacks: ["characters", "ref_overrides", "status"],
        why: "缺 characters / ref_overrides / status 等十几个字段，拼不出 ShotInfo" },
      { path: "/shots/{shot_id}/split", has: ["head_shot_id", "tail_shot_id"],
        lacks: ["status", "characters"],
        why: "只给了 id 与 order/时长；tail 那一行有二十多个字段没下发" },
      { path: "/shots/{shot_id}/recut", has: ["head_shot_id", "mid_shot_id"],
        lacks: ["status", "characters"],
        why: "同上，且 mid 段还是「待生成」态，本地更编不出它的 status" },
      { path: "/shots/{shot_id}/undo-recut", has: ["shot_id"],
        lacks: ["status", "characters"],
        why: "合并后的时长给了，但被删的那一行本地删不干净（order 会连带重排）" },
    ];
    /** 从装饰器行起，圈出这个 endpoint 的**函数体**（到下一个顶层 `@router.` 为止）。 */
    const routeBody = (path: string): string => {
      const rl = rs.split("\n");
      const at = rl.findIndex((t) => t.includes(`"${path}"`) && t.trim().startsWith("@router."));
      if (at < 0) return "";
      const rest = rl.slice(at + 1);
      const stop = rest.findIndex((t) => t.trim().startsWith("@router."));
      return (stop < 0 ? rest : rest.slice(0, stop)).join("\n");
    };
    for (const r of RETURNS) {
      ok(rs.includes(`"${r.path}"`), `${r.path} 端点还在（回包：${r.has.join(" / ")}）`);
      const body = routeBody(r.path);
      // 回包里出现这些键就说明"服务端其实给了整行" —— 那 ① 类就能降级，
      // 本脚本与 §12.2 都得跟着改，不能只改一头。
      const leaked = r.lacks.filter((k) => body.includes(`"${k}"`));
      ok(leaked.length === 0,
        `   · 仍不足以本地拼行：${r.why}`,
        `${r.path} 的回包里出现了 ${leaked.join(" / ")} —— 若它已开始回整行，`
        + `请把该端点从本表移出、降级 App 侧调用点，并同步 §12.2`);
    }
  }
}

console.log("\n[3] ② 改顺序：两条守卫必须保留（服务端会连带重排别的镜头）");

{
  // 只取声明后的一小段，不用 `findFnEnd`：那个大括号配对是**朴素计数**，
  // 碰到字符串/模板字面量里的 `{`（`${r.head_order}` 这种）会数歪。
  // 这里要看的只是开头那三行守卫，固定窗口更稳。
  const decl = findFnLine("applyTimelineResult");
  const body = decl > 0 ? appLines.slice(decl - 1, decl + 14) : [];
  const bodyCode = body.filter((t) => { const s = t.trim(); return s && !s.startsWith("//") && !s.startsWith("*"); });
  ok(bodyCode.some((t) => /toOrder\s*!==\s*undefined/.test(t) && /refreshDetail/.test(t)),
    "toOrder 变更时退回全量（顺序表已不是本地那张）");
  ok(bodyCode.some((t) => /!\s*cur\s*\|\|/.test(t) && /refreshDetail/.test(t)),
    "本地没有这一行 / order 对不上时退回全量（该镜可能已被别处删掉）");
  ok(bodyCode.some((t) => /patchDetail\s*\(/.test(t)),
    "两条守卫之外仍然走 patchDetail 就地回填（否则 B0 的收益被吃回去了）");
}

console.log("\n[4] ③ 非镜头数据：App 侧这些回调仍走全量 refreshDetail");

for (const c of B3_NON_SHOT_CALLBACKS) {
  // 回调可能跨行，退化成"属性名出现过 + 它附近 3 行内提到 refreshDetail"
  const idx = appLines.findIndex((t) => t.includes(`${c.prop}=`));
  const near = idx >= 0 ? appLines.slice(idx, idx + 4).join(" ") : "";
  ok(idx >= 0 && /refreshDetail\s*\(/.test(near),
    `${c.prop} 仍走全量`, c.why);
}

console.log("\n[5] ④ 事件驱动：refreshSoon 只出现在 push 侧，不在 App 里被直接调");

{
  // `refreshSoon` 的语义是"800ms 合并后全量拉一次"，它是**接收事件**的一方该用的，
  // App 里出现 `refreshSoon(` 的调用说明有人在用户操作路径上用了轮询语义。
  const calls = codeLines(appPath).filter(({ t }) => /\brefreshSoon\s*\(/.test(t));
  ok(calls.length === 0, "App.tsx 里没有 refreshSoon 调用点（它是事件侧的工具）",
    calls.map((c) => `App.tsx:${c.n}`).join(", "));
  const prod = `${DESKTOP}/src/hooks/useProdJobs.ts`;
  const pCode = codeLines(prod).filter(({ t }) => /\brefreshSoon\s*\(/.test(t));
  ok(pCode.length >= 4, `useProdJobs 里 refreshSoon 用在 SSE 事件分流上（实测 ${pCode.length} 处）`);
}

console.log("\n[6] 全部调用点都还在「账本」里 —— 没有凭空多出来的第 N 个");

{
  const all = codeLines(appPath).filter(({ t }) => /\brefreshDetail\s*\(/.test(t));
  const known = 29;   // §12.2 实点：①12 + ②2 + ④6 + 首载 1 + 挂载回调 2 + 其余 6
  ok(all.length === known,
    `App.tsx 的真调用数是 ${known}（实测 ${all.length}）`,
    all.length > known
      ? `多出来的是：${all.slice(known).map((c) => `\n         App.tsx:${c.n}  ${c.t.trim()}`).join("")}`
        + "\n       → 新加的调用点请先在 §12.2 归类，再更新本脚本的 known。"
      : `少了 ${known - all.length} 处。若是有意降级，请同步 §12.2 与本文件的 known。`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-refresh-sites：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
