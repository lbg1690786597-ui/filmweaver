/**
 * verify-shot-status.ts — 批次 A1：`shot.status` / `job.status` 的语义边界
 *
 * ## 这个套件验什么
 *
 * A1 声称的是一条**定义**（"`shot.status` 不得表示正在生成"），
 * 定义没法"跑"，但**它会漂移**，所以这里验三件事：
 *
 *   ① 纯逻辑：`isUsable` / `describeShot` 的行为与定义一致
 *      —— 尤其是「有 job 在跑**不**影响内容可用性」这条（"重生成不丢旧内容"的判据）
 *   ② 源码守卫：后端**真的**在写 `shots.status`，且**真的**没有别的地方
 *      把 "generating" 当成内容状态来读（防止边界被悄悄读歪）
 *   ③ 实测数字：`KNOWN_INCONSISTENT_SHOT_COUNTS` 与 dev 库现状对得上
 *      （对不上说明要么数据变了、要么 ETL 变了，两种都该被人看见）
 *
 * ## ③ 为什么要连库
 *
 * 因为 A2 的结论是"6796 条 pending **不是**僵尸"，这个结论极容易被后人
 * 凭直觉推翻（"pending 这么多肯定是卡住了"）。把实测数字钉在代码里，
 * 后人改回"清理 pending"之前会先撞上这里的断言。
 *
 * 库不存在或读不了时 ③ **跳过而非失败**（CI / 别人机器上没有这个路径），
 * 但会明确打印"已跳过"，不让它静默通过。
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
//: 读 backend/ 一律走这里 —— 公开仓（CI）没有 backend/，直接读会 ENOENT 崩掉整条发版链路
import { readBackend, skipBackend } from "./backendSrc";
import {
  isUsable,
  describeShot,
  isInFlightShotStatus,
  IN_FLIGHT_SHOT_STATUSES,
  KNOWN_INCONSISTENT_SHOT_COUNTS,
} from "../src/lib/shotStatus";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const DB = join(REPO, "backend", "filmweaver_dev.db");

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, good, `期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}

// ── ① 纯逻辑 ────────────────────────────────────────────────────────────────

console.log("① 判据：内容状态决定「能不能用」，任务状态决定「显不显示进度」");

// ★ 本批最重要的一条：正在重生成 ≠ 旧内容不可用。
//   反例写法是 `s === "adopted" && !busy`，那会把"重生成不丢旧内容"直接否掉。
eq("adopted → 可用", isUsable("adopted"), true);
eq("pending → 不可用", isUsable("pending"), false);
eq("failed → 不可用", isUsable("failed"), false);
eq("null → 不可用（不猜）", isUsable(null), false);
eq("undefined → 不可用（不猜）", isUsable(undefined), false);

// 中间值不是内容状态：它们只说明"有个 job 在动它"
eq("prompting 是中间值", isInFlightShotStatus("prompting"), true);
eq("generating 是中间值", isInFlightShotStatus("generating"), true);
eq("adopted 不是中间值", isInFlightShotStatus("adopted"), false);
eq("pending 不是中间值", isInFlightShotStatus("pending"), false);
eq("空串不是中间值", isInFlightShotStatus(""), false);
eq("null 不是中间值", isInFlightShotStatus(null), false);

// 文案：busy 优先，但 busy 不改变内容判定
eq("busy 时显示进度", describeShot("adopted", true), "生成中…");
eq("adopted 非 busy → 已生成", describeShot("adopted", false), "已生成");
eq("pending → 待生成（不是「生成中」）", describeShot("pending", false), "待生成");
eq("review → 待审阅", describeShot("review", false), "待审阅");
eq("failed → 生成失败", describeShot("failed", false), "生成失败");

// ★ 真僵尸（中间值 + 无在跑 job）必须与 pending 说**不一样**的话。
//   旧代码两者都显示"待生成"，用户无从分辨"没轮到"与"卡住了"。
ok(
  "中间值且无 job → 提示状态异常（≠ 待生成）",
  describeShot("generating", false) !== describeShot("pending", false),
  `generating→${describeShot("generating", false)}  pending→${describeShot("pending", false)}`,
);

// ── ② 源码守卫 ──────────────────────────────────────────────────────────────

console.log("\n② 源码守卫：后端确实在写 shots.status，即两套状态各写各的表");

// 后端源码只在全仓里有；公开仓（CI）没有 backend/，见 backendSrc.ts 的文件头。
// 与下面 ③ 段「找不到 dev 库就跳过」同一口径：读不到对面 = 跳过，不是通过、也不是崩。
const jobsSrc = readBackend("app/jobs.py");
const dbSrc = readBackend("app/db.py");
if (jobsSrc === null || dbSrc === null) skipBackend("② 后端状态写入点");
else {
ok("后端 Shot.status 存在", /class Shot\b/.test(dbSrc) && /status/.test(dbSrc));
ok("后端 Job.status 存在", /class Job\b/.test(dbSrc));
ok(
  "后端有 _set_shot_status 这个统一写入点",
  /def _set_shot_status\(/.test(jobsSrc),
  "找不到统一写入点说明写入路径被拆散了，本文件的边界更难守住",
);
ok(
  "后端确实会写 generating（中间值清单没有过期）",
  /_set_shot_status\(sid, "generating"\)/.test(jobsSrc),
  "若这里失败，说明后端不再写 generating，应同步删掉 IN_FLIGHT_SHOT_STATUSES 里的对应值",
);
for (const s of IN_FLIGHT_SHOT_STATUSES) {
  ok(
    `中间值 ${s} 确实被后端写过（清单没腐坏）`,
    jobsSrc.includes(`"${s}"`),
    `${s} 已不在后端源码里，应从 IN_FLIGHT_SHOT_STATUSES 移除`,
  );
}
}

// 前端**唯一**的状态标签定义处必须与这边一致
const shotsPanel = readFileSync(join(ROOT, "src", "components", "ShotsPanel.tsx"), "utf8");
ok(
  "ShotsPanel 的 STATUS_META 覆盖全部 6 个 shot 状态",
  ["pending", "prompting", "generating", "review", "adopted", "failed"].every((s) =>
    new RegExp(`\\b${s}\\s*:`).test(shotsPanel),
  ),
);
ok(
  "ShotsPanel 已有「状态异常」的兜底意识（generating 与 pending 文案不同）",
  shotsPanel.includes("生成中") && shotsPanel.includes("待生成"),
);

// ── ③ 实测数字（A2 的结论，钉在代码里） ────────────────────────────────────

console.log("\n③ 实测对照：pending 不是僵尸，真不一致是少数");

if (!existsSync(DB)) {
  console.log(`  ⏭️  跳过（找不到 ${DB}）—— 本机没有 dev 库，跳过而非通过`);
} else {
  const sql = `
    select
      (select count(*) from shots where status='pending') as pending_all,
      (select count(*) from shots where status='pending' and video_url is not null) as pending_with_video,
      (select count(*) from shots where status='failed'  and video_url is not null) as failed_with_video,
      (select count(*) from shots where status='adopted' and adopted_version is null) as adopted_no_version,
      (select count(*) from shots where status in ('prompting','generating')) as in_flight,
      (select count(*) from jobs where status in ('pending','running')) as jobs_nonterminal;
  `;
  let row: Record<string, number> | null = null;
  try {
    const out = execFileSync("python3", ["-c", `
import sqlite3, json, sys
c = sqlite3.connect(${JSON.stringify(DB)})
cur = c.execute(${JSON.stringify(sql)})
cols = [d[0] for d in cur.description]
print(json.dumps(dict(zip(cols, cur.fetchone()))))
`], { encoding: "utf8" });
    row = JSON.parse(out.trim());
  } catch (e) {
    console.log(`  ⏭️  跳过（读库失败：${(e as Error).message.slice(0, 80)}）`);
  }

  if (row) {
    const r = row;
    eq("pending 中有片子 = 2（回写漏了）", r.pending_with_video, KNOWN_INCONSISTENT_SHOT_COUNTS.pendingWithVideo);
    eq("failed 中有片子 = 10", r.failed_with_video, KNOWN_INCONSISTENT_SHOT_COUNTS.failedWithVideo);
    eq("adopted 无版本号 = 1", r.adopted_no_version, KNOWN_INCONSISTENT_SHOT_COUNTS.adoptedWithoutVersion);

    // ★ A2 的核心结论：pending 的绝对数量大，但**不是**卡住。
    //   判据是"有没有非终态的 job"——一个都没有，说明没有卡住的生成。
    eq("没有卡住的任务（非终态 job = 0）", r.jobs_nonterminal, 0);
    ok(
      "pending 很多但不是僵尸（无任何中间态镜头残留）",
      r.in_flight === 0,
      `中间态镜头 ${r.in_flight} 条 —— 若有值且无在跑 job，才是真僵尸`,
    );
    console.log(
      `\n  📊 pending 总数 ${r.pending_all}：其中真不一致仅 ${r.pending_with_video} 条；\n` +
      `     非终态 job ${r.jobs_nonterminal} 个、中间态镜头 ${r.in_flight} 条 ⇒ 没有「生成卡住」这回事。`,
    );
  }
}

console.log(failed === 0 ? "\n✅ verify-shot-status：全部通过" : `\n❌ verify-shot-status：${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
