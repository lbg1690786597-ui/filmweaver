/**
 * scripts/verify-sse-poll.ts — U1 第 1、2 点：SSE 在线时的轮询降频
 *
 * 分四节：
 *   [1] `shouldSkipTick` 的真值表与不变式（纯函数，穷举）
 *   [2] 进程级 SSE 通断登记簿（`lib/sseHealth.ts`）
 *   [3] 接线（源码断言）：五处轮询各自降了什么、**没降**什么
 *   [4] 魔数一致性：每处 `shouldSkipTick(tick, baseMs, …)` 的 baseMs
 *       必须真的等于那个 `setInterval` 的间隔
 *
 * ## 这条为什么要单独钉
 *
 * 降频的失败形态是**静默的**，而且两个方向都难看：
 *
 *   · 降过头 → 进度条十几秒跳一格、资产图迟迟不点亮，用户以为卡死了又点一次
 *     （那是要花钱的）。这类错没有报错、没有红色，只有"感觉有点卡"。
 *   · 没降到 → 1400 镜项目上每 3s 拉一次 1.6 MB 的 detail（~550 KB/s 持续下行），
 *     同样没有任何报错，只是软件在拆解期间变得又慢又费流量。
 *
 * 第 [4] 节钉的是最阴的一种：`shouldSkipTick(tick, 3000, 15000)` 里那个 3000
 * 与 `setInterval(…, 3000)` 是**两处分别写死**的。哪天有人把定时器从 3s 调成 5s
 * 而忘了改参数，降频就从 15s 静默变成 25s —— 没人看得出来。
 *
 * ## 为什么第 [3] 节要断言"**没降**的那两处"
 *
 * `LibraryPanel`（资产逐张点亮）与 `TasksDrawer`（任务历史）刻意**不降频**：
 * 后端没有资产事件，抽屉要的是全量历史，SSE 都替不了它们。
 * 不把这件事钉住的话，下一个做"统一降频"的人会顺手把它们也套上，
 * 于是资产图变成 15s 一跳 —— 而这在代码里看起来完全是"更一致了"。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SSE_FALLBACK_MS, isSseUp, resetSseHealth, setSseUp, shouldSkipTick,
} from "../src/lib/sseHealth";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 在 sseUp=true 下跑 n 跳，返回真正干活的那些 tick 序号 */
const firing = (n: number, baseMs: number, slowMs: number, up = true): number[] => {
  const out: number[] = [];
  for (let t = 1; t <= n; t++) if (!shouldSkipTick(t, baseMs, slowMs, up)) out.push(t);
  return out;
};

// ───────────────────────────────────────────────────────────────────────
console.log("\n[1] shouldSkipTick 真值表与不变式");
{
  // SSE 断线：一跳都不许跳过 —— 那时轮询是唯一的更新来源
  ok(firing(40, 3000, SSE_FALLBACK_MS, false).length === 40,
    "SSE 断线时每一跳都干活（40/40）");

  // 3s 定时器 + 15s 兜底 = 每 5 跳干一次，且与改造前的 `tick % 5 !== 0` 完全一致
  const f3 = firing(20, 3000, 15000);
  ok(JSON.stringify(f3) === JSON.stringify([5, 10, 15, 20]),
    "3s/15s：第 5、10、15、20 跳干活（与改造前 tick%5 逐跳相同）",
    JSON.stringify(f3));

  // 就绪度：5s 定时器 + 30s 兜底
  const f5 = firing(18, 5000, 30000);
  ok(JSON.stringify(f5) === JSON.stringify([6, 12, 18]),
    "5s/30s：第 6、12、18 跳干活", JSON.stringify(f5));

  // 旁白：5s 定时器 + 15s 兜底
  const fa = firing(9, 5000, 15000);
  ok(JSON.stringify(fa) === JSON.stringify([3, 6, 9]),
    "5s/15s：第 3、6、9 跳干活", JSON.stringify(fa));

  /* 不变式一：等效间隔 ≈ slowMs（四舍五入误差内），**且永远不会比 slowMs 慢一半以上**。
     这条是"降过头"的唯一防线：比例算错时（比如把 slowMs 当秒传）这里会立刻红。 */
  let worst = 0, worstCase = "";
  for (const base of [500, 800, 1000, 2000, 3000, 4000, 5000, 7000, 10000]) {
    for (const slow of [3000, 15000, 30000, 60000]) {
      if (!(slow > base)) continue;   // slow <= base 是「不降频」退化分支，不适用本不变式
      const f = firing(200, base, slow);
      if (f.length < 2) continue;
      const eff = (f[1] - f[0]) * base;
      const ratio = eff / slow;
      if (Math.abs(ratio - 1) > worst) { worst = Math.abs(ratio - 1); worstCase = `${base}/${slow} → ${eff}ms`; }
    }
  }
  ok(worst <= 0.5, `任意 base/slow 组合的等效间隔都在 slowMs 的 ±50% 内（最差 ${worstCase}）`);

  /* 不变式二：**永不整体停摆**。比例再大也必须每 ratio 跳里恰好有一跳干活 ——
     "一跳都不干"意味着进度条永远不动，是比多刷几次严重得多的故障。 */
  let neverFires = 0;
  for (const base of [500, 1000, 3000, 5000, 9999]) {
    for (const slow of [0, 1, 3000, 15000, 30000, 600000]) {
      // 观察窗必须覆盖两个完整周期，否则"窗口太短"会被误判成停摆
      const win = Math.max(20, Math.ceil(slow / Math.max(base, 1)) * 2);
      if (firing(win, base, slow).length === 0) neverFires++;
    }
  }
  ok(neverFires === 0, "任何参数组合下都不会整体停摆（每 ratio 跳必有一跳干活）");

  // 退化输入一律保守：算不出比例就每跳都干活
  ok(firing(6, 3000, 3000).length === 6, "slowMs == baseMs → 不降频");
  ok(firing(6, 3000, 1000).length === 6, "slowMs < baseMs → 不降频（不会反向变快）");
  ok(firing(6, 0, 15000).length === 6, "baseMs = 0 → 不降频（不做除零）");
  ok(firing(6, -3000, 15000).length === 6, "baseMs 为负 → 不降频");
  ok(!shouldSkipTick(1, 3000, 15000, false) && shouldSkipTick(1, 3000, 15000, true),
    "同一跳：SSE 断=干活 / SSE 通=跳过（sseUp 是唯一开关）");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[2] 进程级 SSE 通断登记簿");
{
  resetSseHealth();
  ok(isSseUp() === false, "初始值为 false（没连上之前一律全速轮询）");
  setSseUp(true);
  ok(isSseUp() === true, "setSseUp(true) 后为 true");
  setSseUp(false);
  ok(isSseUp() === false, "setSseUp(false) 后为 false");
  setSseUp(true); resetSseHealth();
  ok(isSseUp() === false, "resetSseHealth() 归零（验证脚本用）");
  ok(SSE_FALLBACK_MS === 15000, "兜底节奏统一口径为 15s");

  const src = read("src/lib/sseHealth.ts");
  ok(!/from "react"/.test(src) && !/from "@tauri-apps/.test(src),
    "sseHealth 不依赖 React/Tauri（保住 node 可验证性 + 能在 interval 回调里读）");
  ok(/export function isSseUp/.test(src) && !/export (const|let) up/.test(src),
    "★ 读取口是**函数**不是导出变量（导出变量会被闭包快照成旧值）");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[3] 接线：谁降了、降的是什么");

const JOBS = read("src/hooks/useProdJobs.ts");
const BD = read("src/hooks/useBreakdown.ts");
const SP = read("src/components/ShotsPanel.tsx");
const AU = read("src/hooks/useAudioTrack.ts");
const LIB = read("src/components/LibraryPanel.tsx");
const TD = read("src/features/tasks/TasksDrawer.tsx");

{
  // —— useProdJobs：SSE 通断的**唯一写入点**，且自己的 job 轮询整跳降频
  ok(/setSseUp\(true\)/.test(JOBS) && /setSseUp\(false\)/.test(JOBS),
    "useProdJobs 的 onUp/onDown 写进共享登记簿");
  ok(/return \(\) => \{ close\(\); setSseUp\(false\); \}/.test(JOBS),
    "★ 切项目/卸载时把 SSE 置为断（否则订阅已关，其余四处还以为通着 → 一直兜底节奏）");
  ok(!/sseUp\s*=\s*useRef/.test(JOBS),
    "★ 旧的私有 sseUp ref 已不存在（它是「只有一处降频」的病根）");
  ok(!/tick % 5/.test(JOBS), "手写的 tick % 5 已换成 shouldSkipTick");
  ok(/shouldSkipTick\(tick, 3000, SSE_FALLBACK_MS, isSseUp\(\)\)\) return;/.test(JOBS),
    "job 轮询整跳降频（它拉的 jobStatus 与 SSE 的 job 事件是同一份信息）");

  // —— useBreakdown：只降 refreshDetail，**不降** jobStatus
  ok(/setBdProgress\(s\.progress\);/.test(BD),
    "拆解进度仍每跳更新（bdProgress 只有这里在写）");
  const gate = BD.indexOf("shouldSkipTick(tick");   // 不能用 indexOf("shouldSkipTick")：会命中顶部的 import
  const prog = BD.indexOf("setBdProgress(s.progress)");
  ok(prog > 0 && gate > prog,
    "★ 降频判据在 setBdProgress **之后** —— 进度条不跟着降频（否则 15s 跳一格像卡死）");
  ok(/if \(!shouldSkipTick\(tick, 3000, SSE_FALLBACK_MS, isSseUp\(\)\)\) \{\s*\n\s*void refreshDetail\(\);/.test(BD),
    "被降频的是 refreshDetail（1400 镜项目上 1.6 MB/次）");
  ok(/clearInterval\(bdTimer\.current\);[\s\S]{0,120}void refreshDetail\(\);/.test(BD),
    "★ 收尾那一次 refreshDetail 无条件执行（最后一集必须落地，不能被降频吃掉）");

  // —— ShotsPanel 就绪度：30s 兜底
  ok(/const READINESS_FALLBACK_MS = 30000;/.test(SP),
    "就绪度兜底 30s（1400 镜项目上是服务端全量重算）");
  ok(/shouldSkipTick\(tick, 5000, READINESS_FALLBACK_MS, isSseUp\(\)\)\) return;/.test(SP),
    "就绪度轮询按 5s/30s 降频");
  ok(/useEffect\(\(\) => \{ loadRd\(\); \}, \[loadRd, ffDone, videoDone, p\.generating\]\);/.test(SP),
    "★ 事件驱动那条仍在（首帧/成片签名变即重拉 —— 降频的前提就是它还管用）");

  // —— useAudioTrack：只降 refreshAudio，**不降** jobStatus（要保 pollMisses 提示）
  ok(/pollMisses\.current = 0;[\s\S]{0,400}shouldSkipTick\(tick, 5000, SSE_FALLBACK_MS/.test(AU),
    "★ jobStatus 与 pollMisses 仍每跳跑（「连不上服务器」那句提示不能迟到）");
  ok(/if \(!shouldSkipTick\(tick, 5000, SSE_FALLBACK_MS, isSseUp\(\)\)\) \{\s*\n\s*refreshAudio\(\);/.test(AU),
    "被降频的是 refreshAudio（SSE 的 audio 事件已在逐段点亮）");
  ok(/setTtsJobId\(null\);\s*\n\s*refreshAudio\(\);/.test(AU),
    "★ 收尾那一次 refreshAudio 无条件执行");

  // —— 刻意不降的两处
  for (const [name, src] of [["LibraryPanel", LIB], ["TasksDrawer", TD]] as const) {
    ok(!/lib\/sseHealth/.test(src),
      `${name} 不引入降频（刻意：SSE 覆盖不到它要的数据）`);
    ok(/刻意不做 SSE 降频/.test(src),
      `★ ${name} 把「为什么不降」写在代码里（否则下一个统一降频的人会顺手降掉）`);
  }
  ok(/console\.warn\("\[LibraryPanel\]/.test(LIB),
    "顺手修：资产轮询回调自己吞异常（原来裸 await 会 unhandled rejection）");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[4] 魔数一致性：baseMs 必须等于真实的 setInterval 间隔");
{
  for (const [name, src] of [
    ["useProdJobs.ts", JOBS], ["useBreakdown.ts", BD],
    ["ShotsPanel.tsx", SP], ["useAudioTrack.ts", AU],
  ] as const) {
    // shouldSkipTick(tick, <base>, …) 里的 base 字面量
    const bases = [...src.matchAll(/shouldSkipTick\(tick,\s*(\d+)\s*,/g)]
      .map((m) => Number(m[1]));
    // setInterval(…, <ms>) 的间隔字面量（收尾形如 `}, 3000);`）
    const ivals = new Set([...src.matchAll(/\}\s*,\s*(\d+)\s*\)\s*;/g)]
      .map((m) => Number(m[1])));
    ok(bases.length > 0, `${name} 里找到了 ${bases.length} 处降频判据`);
    const orphan = bases.filter((b) => !ivals.has(b));
    ok(orphan.length === 0,
      `★ ${name} 的 baseMs ${JSON.stringify(bases)} 都能对上真实间隔 `
      + `${JSON.stringify([...ivals])}`,
      `对不上：${JSON.stringify(orphan)}`);
    // 每处降频前面必须有 tick 自增，否则 tick 恒为 0 → `0 % ratio === 0` → 永不降频
    ok(/tick \+= 1;/.test(src), `${name} 的回调里有 tick += 1（tick 从 1 起算）`);
  }
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0
  ? "✅ SSE 在线时：job 轮询降 15s、拆解 detail 降 15s、就绪度降 30s、旁白列表降 15s；"
    + "进度条/收尾/资产点亮/任务历史一律不降；断线时全部恢复全速。"
  : "❌ 降频规则有断言不过 —— 别发布，先看上面第一条 ❌。");
process.exit(fail === 0 ? 0 : 1);
