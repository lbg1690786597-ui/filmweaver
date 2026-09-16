/**
 * verify-architecture.ts — 架构守卫（增长闸门 + 漂移计时器）
 *
 * ## 为什么需要这个脚本
 *
 * `docs/PLAN-编辑核心架构收敛.md`（A–E 批）全部标 ✅，但做完之后**每个规模指标都涨了**：
 *
 *   | 指标                    | 2026-09-11 | 2026-09-12 |
 *   |-------------------------|-----------|-----------|
 *   | App.tsx                 | 2853      | 3220      |
 *   | api.ts                  | 2177      | 2239      |
 *   | routes_v2.py            | 6361      | 6465      |
 *   | jobs.py                 | 4606      | 4625      |
 *   | App.tsx refreshDetail   | 28        | 32        |
 *
 * 不是那批工作没做，是**收敛的速度追不上新增的速度**：9 月 1 日起 App.tsx 被改 48 次。
 * 结论：**没有闸门的收敛一定输**。所以本脚本的第一职责不是"检查整洁"，
 * 是让"继续往巨石里加东西"变成一次红。
 *
 * ## 怎么改这些数字（唯一允许的方向）
 *
 * 数字**只许降不许升**：
 *   - 涨 1 行 → ❌ 硬失败。要么把东西放到别处，要么先还债再加。
 *   - 降了 → ✅ 通过并提示"可以把 BUDGET 调低了"。**必须**同步调低，
 *            否则还债腾出的空间会被下一次加功能悄悄吃掉（这正是 A–E 的教训）。
 *
 * ## 四条计数守卫的意义
 *
 * 四条守的都是**同一件事有两份实现**（P2.1 收掉的那批）：
 *
 *   · `useMemo<AssetDropCtx`            3 → **2**（两个入口各自的组装点，见那条 why）
 *   · `手搓 stages/ownStageIds`         3 → **0**（改走 dropContext 工厂）
 *   · `useAssetOverride.setState`       3 → **0**（收进 store 具名动作）
 *   · `createCommandStore(`             1 → **1**（撤销栈唯一所有者）
 *
 * 这几个数字**本身就是证据**：`assetDropCtx` 曾在 App.tsx 与验证台里各有一份完整
 * 复制，靠注释「与 App.tsx 同款」手工同步；`setState` 有 3 处直接写 store 内部状态，
 * 绕过了 store 的具名动作。**注释就是漂移的计时器**——加计数守卫把它们钉住。
 *
 * ⚠️ 计数跑在 `stripComments()` 之后。否则"越把规则写进文档注释、守卫越红"，
 * 最后逼着人删注释去迎合脚本 —— 那是反的。
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..");
const REPO = join(DESKTOP, "..");
const SRC = join(DESKTOP, "src");

let failed = 0;

// ============================================================
// ① 尺寸预算 —— 只许降不许升
// ============================================================

/**
 * 非空行数（去掉空行与纯注释行）。
 *
 * 为什么不用 `wc -l`：总行数会被换行风格、末尾空行、注释块影响，
 * 而我们要守的是"这个文件承载了多少逻辑"。非空行更接近那个意思，
 * 也让"删掉一段死代码"能真实反映成数字下降。
 */
function codeLines(path: string): number {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    }).length;
}

interface Budget {
  label: string;
  path: string;
  /** 允许的最大非空行数。**只许调低。** */
  max: number;
  /** 为什么钉这个文件 */
  why: string;
}

/**
 * 预算值是这样定出来的：**当前实测非空行数 + 10**。
 *
 * 为什么不是"宽松的天花板"：第一版我按总行数臆定了上限（如 App.tsx 2850），
 * 实测非空行只有 2208 —— 那种预算要涨 640 行才触发，等于**几个月内没有闸门**。
 * 闸门的价值全在"多久会响"，定高了就是自欺。
 *
 * 为什么留 10 行而不是钉死：本项目日均有 1–3 次提交落在这几个文件上，
 * 钉死会立刻红，人就开始无脑放宽预算——闸门废得更快。
 * 10 行够改 bug，**塞不进一个新功能**，这才是要挡的动作。
 *
 * **降下来了就把它调低。** 不调的话，还债腾出的空间会被下一次加功能悄悄吃掉。
 */
const BUDGETS: Budget[] = [
  {
    label: "App.tsx",
    path: join(SRC, "App.tsx"),
    max: 2205,
    why: "36 个「---- 层 ----」块、18 useState、14 useEffect。本轮用『只许减』慢慢挤，不重写。",
  },
  {
    label: "api.ts",
    path: join(SRC, "api.ts"),
    max: 1392,
    why: "后端契约的手工镜像。P3 契约生成后应逐模块收敛到这里。",
  },
  {
    label: "Timeline.tsx",
    path: join(SRC, "features/timeline/Timeline.tsx"),
    max: 1192,
    why: "时间轴主组件。纯逻辑已拆到 gesture/snap/virtual/trim/dragGeom，剩下的应是渲染与装配。",
  },
  {
    label: "routes_v2.py",
    path: join(REPO, "backend/app/routes_v2.py"),
    max: 5657,
    why: "108 条路由。本方案 P2.3 定『只加不拆』：新路由进 routers/ 子模块，这里只许减。",
  },
  {
    label: "jobs.py",
    path: join(REPO, "backend/app/jobs.py"),
    max: 4154,
    why: "62 个顶层函数。P2.2 解循环后，绕循环的局部 import 与重复常量应下线。",
  },
];

console.log("\n① 尺寸预算（只许降不许升）");
{
  const toLower: string[] = [];
  for (const b of BUDGETS) {
    if (!existsSync(b.path)) {
      console.log(`   ❌ ${b.label} 不存在：${relative(REPO, b.path)}`);
      failed++;
      continue;
    }
    const n = codeLines(b.path);
    if (n >= b.max) {
      // 用 >= 而不是 >：预算是"允许的最大值"，顶到即不可再加。
      // 若写成 >，max 实际是"max+1 才拦"，多出来的那一行永远合法。
      console.log(`   ❌ ${b.label.padEnd(16)} ${n} 行 ≥ 上限 ${b.max}`);
      console.log(`      ${b.why}`);
      failed++;
    } else if (n < b.max) {
      console.log(`   ⚠️  ${b.label.padEnd(16)} ${n} 行 < 上限 ${b.max}（余量 ${b.max - n} 行）`);
      if (b.max - n > 20) {
        // 余量大到不合理 = 有人改过实现却没跟着调预算，闸门已经形同虚设
        toLower.push(`      ${b.label}: max: ${b.max} → ${n + 10}`);
      }
    }
  }
  if (toLower.length) {
    // 不判失败，但必须提示：不调低的话，腾出的空间会被下一次加功能吃掉。
    console.log(`   📉 下列预算余量过大，请同步调低（现状+10 行）：`);
    for (const s of toLower) console.log(s);
  }
}

// ============================================================
// ② 重复实现计数 —— 同一件事只许有一份
// ============================================================

/** 递归收集源码文件 */
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const allSources = walk(SRC);

/**
 * 剥掉注释，只留代码 —— 计数守卫**必须**跑在这个上面。
 *
 * 为什么：这些守卫的命中串（`useMemo<AssetDropCtx`、`useAssetOverride.setState`）
 * 正是重构时要写进文档注释里的东西 —— `features/assets/dropContext.ts` 的用法示例
 * 里就出现了两次 `useMemo<AssetDropCtx`。若不剥注释，**越把规则写清楚，守卫越红**，
 * 最后逼着人删注释去迎合脚本 —— 那是反的。
 *
 * 只做行注释与块注释，不处理字符串/正则里的 `//`（如 `"http://"`）。这类内容
 * 目前不含任何被守卫的串；真有的话，脚本会**多**报而不是漏报，是安全的一侧。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * 用固定处数钉住"同一件事只许有一份"。
 *
 * 语义是**"允许的最大处数"**（`hits.length > max` 才失败），与上面的行数预算不同：
 *   - 行数预算的失败线是"顶到上限"—— 因为**写代码就是在加行**，留着余量没有意义。
 *   - 计数守卫的失败线是"超过上限"—— 因为 `createCommandStore` 那 1 处是
 *     **合法且唯一正确的所有者**，不能因为"顶到 1"就判它失败。
 *
 * 于是 `max: 0` 读作"这一类不许存在"，`max: 1` 读作"只许有一处"。
 */
interface CountGuard {
  label: string;
  /** 返回命中**处数**（不是"这个文件有没有"）—— 同一文件里的多次重复必须都数出来 */
  count: (src: string) => number;
  /** **允许的最大处数。只许调低。** */
  max: number;
  /** 命中点在哪个文件里 —— 只统计这些文件 */
  in?: (rel: string) => boolean;
  why: string;
}

const COUNT_GUARDS: CountGuard[] = [
  {
    label: "useMemo<AssetDropCtx",
    count: (s) => (s.match(/useMemo<AssetDropCtx/g) ?? []).length,
    max: 2,
    why:
      "assetDropCtx 曾在 App.tsx 与 dev/AssetTrackHarness.tsx 各有一份**完整重复实现**，" +
      "靠注释「与 App.tsx 同款」手工同步 —— 那才是被消灭的东西（现由 " +
      "features/assets/dropContext.ts 的 assetDropStageFacts 单点提供底座与归属）。" +
      "剩下的 2 处是**两个入口各自的组装点**（环境事实本就不同：一个读 store、一个读" +
      "fixture 常量），留在原处是为了不把 store 拖进 dev 台。**新增第三处即失败**。" +
      "⚠️ 手搓 `stages:` / `ownStageIds:` 由下一条守卫单独钉住。",
  },
  {
    label: "手搓 stages/ownStageIds（绕过 dropContext）",
    count: (s) =>
      (s.match(/(?:^|\W)stages:\s*[A-Za-z_$][\w$]*\s*\.\s*map\s*\(/g) ?? []).length +
      (s.match(/ownStageIds:\s*(?:new Set\(|\()/g) ?? []).length,
    max: 0,
    why:
      "这两行是「这次注入记在哪套造型名下」的全部依据（见 stageIdAt）。手搓一份 = " +
      "又出现一个能各自漂移的口径，最终表现是 toast 说注入成功、轨道上却看不到段。" +
      "唯一合法来源是 features/assets/dropContext.ts 的 assetDropStageFacts()。",
  },
  {
    label: "useAssetOverride.setState",
    count: (s) => (s.match(/useAssetOverride\s*\.\s*setState\s*\(/g) ?? []).length,
    max: 0,
    in: (rel) => rel.startsWith("dev/"),
    why:
      "3 处都在 dev/AssetTrackHarness.tsx，绕过 store 的具名动作直接写内部状态。" +
      "P2.1 收进 store 动作后应为 0。**新增一处即失败** —— 这是『两份真相』的入口。",
  },
  {
    label: "createCommandStore(",
    count: (s) =>
      // 减去定义本身那一处（`export function createCommandStore`），只数调用点
      (s.match(/createCommandStore\s*\(/g) ?? []).length -
      (s.match(/export function createCommandStore/g) ?? []).length,
    max: 1,
    why:
      "撤销栈必须只有一个所有者。第二处出现即意味着两个互不知情的撤销历史，" +
      "在时间轴上会出现『Ctrl+Z 撤掉了别的东西』。",
  },
];

console.log("\n② 重复实现计数（同一件事只许有一份）");
for (const g of COUNT_GUARDS) {
  let hits = 0;
  const where: string[] = [];
  for (const f of allSources) {
    const rel = relative(SRC, f).replace(/\\/g, "/");
    if (g.in && !g.in(rel)) continue;
    const n = g.count(stripComments(readFileSync(f, "utf8")));
    if (n > 0) {
      hits += n;
      where.push(n > 1 ? `${rel}（本文件 ${n} 处）` : rel);
    }
  }
  if (hits > g.max) {
    console.log(`   ❌ ${g.label.padEnd(30)} ${hits} 处 > 允许 ${g.max}`);
    for (const h of where) console.log(`        ${h}`);
    console.log(`      ${g.why}`);
    failed++;
  } else if (hits === g.max && g.max > 0) {
    console.log(`   ✅ ${g.label.padEnd(30)} ${hits} 处（顶到允许值，不能再加）`);
  } else if (hits === 0) {
    console.log(`   ✅ ${g.label.padEnd(30)} 0 处 —— 这一类已经不存在了`);
  } else {
    console.log(`   ✅ ${g.label.padEnd(30)} ${hits} 处（允许 ${g.max}）`);
  }
}

// ============================================================
// ③ 验证策略漂移计时器 —— 只报告，不拦截
// ============================================================

/**
 * 方案 P4 的核心指标：**有多少验证脚本在"读源码文本"而不是"跑行为"**。
 *
 * 62/81 这个比例是"重构必红、结构缺陷漏过"的机制来源：
 * 锁源码形状的断言会在**正确**的重构里变红，于是人不重构了，只打补丁。
 *
 * 这里只报告数字，**不判失败**——强制降低会诱人把脚本藏到别的目录。
 * 数字上升时会在 verify 输出里显形，这是它存在的意义。
 */
console.log("\n③ 验证策略（只报告，不拦截）");
{
  const scriptsDir = join(DESKTOP, "scripts");
  const scripts = existsSync(scriptsDir)
    ? readdirSync(scriptsDir).filter((f) => /^verify-.*\.ts$/.test(f))
    : [];
  const textAsserts = scripts.filter((f) =>
    readFileSync(join(scriptsDir, f), "utf8").includes("readFileSync"),
  );
  const pct = scripts.length ? ((textAsserts.length / scripts.length) * 100).toFixed(0) : "0";
  console.log(`   ${scripts.length} 个 verify 脚本，${textAsserts.length} 个读源码文本（${pct}%）`);
  console.log(`   目标：P4 完成后这个数字应持续下降。上升=有人在用『锁形状』的断言补漏。`);
}

// ============================================================
// ④ 契约规模 —— 只报告
// ============================================================

console.log("\n④ 契约规模（只报告，不拦截）");
{
  const backendApp = join(REPO, "backend/app");
  let models = 0;
  const pyFiles: string[] = [];
  const walkPy = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walkPy(p);
      else if (p.endsWith(".py")) pyFiles.push(p);
    }
  };
  walkPy(backendApp);
  for (const f of pyFiles) {
    const t = readFileSync(f, "utf8");
    models += (t.match(/^class \w+\(.*BaseModel\)/gm) ?? []).length;
  }
  let frontendTypes = 0;
  for (const f of allSources) {
    const t = readFileSync(f, "utf8");
    frontendTypes += (t.match(/^(export )?(interface|type) \w+/gm) ?? []).length;
  }
  const generated = existsSync(join(SRC, "api/generated.ts"));
  console.log(`   后端 Pydantic 模型 ${models} 个 / 前端手写类型 ${frontendTypes} 个`);
  console.log(`   契约生成：${generated ? "✅ 已接入 src/api/generated.ts" : "❌ 未接入（P3 待做）"}`);
}

// ============================================================

if (failed) {
  console.log(`\n❌ 架构守卫 ${failed} 项失败`);
  console.log(`   这些数字只许往好的方向走。把它加回去之前，先问：`);
  console.log(`   「这个东西能不能放到一个更小的文件/模块里，而不是往巨石里塞？」\n`);
  process.exit(1);
}
console.log("\n✅ 架构守卫通过\n");
