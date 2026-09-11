/**
 * scripts/verify-candidate-stills.ts — U6 候选定妆图：这次出几张、花多少钱、会不会顶掉当前图
 *
 * ## 为什么这几条值得钉
 *
 * 候选图是**按张计费**的，而"点一次生成出几张"由一个默认值说了算。这个默认值
 * 写错不会报错、tsc 也抓不到，只会让用户第一次给新角色出图时**花四倍的钱**，
 * 其中三张注定被丢掉。反过来把默认值一律设成 1，则"换一张"失去了挑选的意义。
 * 所以默认张数必须随处境变，并且按钮上要写清这次出几张 —— 这就是下面 [1][2]。
 *
 * [3] 钉的是**只有一条路**：候选图曾经有两套实现（同步 `api.stageCandidates`
 * 与 job 化的 `submitAssetCandidates`）。两套并存的代价已经真实发生过一次 ——
 * 2026-09-11 的复审只看到那个同步包装，就误判成"前端从来没有候选图入口、
 * 重新生成会直接覆盖定妆图"，进而差点去实现一个早已存在的功能。所以这里静态
 * 断言 `desktop/src` 里不再有第二条路。
 *
 * [4] 钉的是**文案不许说谎**：job 化之后，候选不落库、挑中才写回，所以任何
 * "重新生成会覆盖当前定妆图"的措辞都是错的；反过来"关掉弹窗就丢了"也是错的。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_COUNTS, candidateButtonLabel, candidateCostHint,
  clampCandidateCount, defaultCandidateCount,
} from "../src/features/assets/candidatePlan";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};

console.log("\n[1] 默认张数随处境变（这是花钱口径，不是审美）");
ok(defaultCandidateCount(false) === 1,
  "★ 还没有图 → 默认 1 张（第一次只求有，别一上手就花四倍钱）",
  `实际 ${defaultCandidateCount(false)}`);
ok(defaultCandidateCount(true) === 4,
  "★ 已有图 → 默认 4 张（这是「换一张」，没有对比就没得挑）",
  `实际 ${defaultCandidateCount(true)}`);
ok(CANDIDATE_COUNTS.length === 4 && CANDIDATE_COUNTS[0] === 1
  && CANDIDATE_COUNTS[CANDIDATE_COUNTS.length - 1] === 4,
  "选择器档位是 1–4（后端上限 9，界面刻意只开到 4）");
ok(CANDIDATE_COUNTS.every((n) => clampCandidateCount(n) === n),
  "每个档位本身都是合法值（clamp 不会悄悄改掉用户选的数）");
ok(clampCandidateCount(0) === 1 && clampCandidateCount(99) === 4
  && clampCandidateCount(Number.NaN) === 1 && clampCandidateCount(2.4) === 2,
  "脏值被夹回 1–4（0/超大/NaN/小数各测一遍）");

console.log("\n[2] 按钮与提示必须报出张数");
for (const n of CANDIDATE_COUNTS) {
  for (const hasImage of [false, true]) {
    const label = candidateButtonLabel({ hasImage, n, submitting: false, running: false });
    ok(label.includes(String(n)),
      `hasImage=${hasImage} n=${n}：按钮上带着张数（「${label}」）`,
      "点下去之前看不见张数 = 看不见这次花多少钱");
    ok(candidateCostHint(n, hasImage).includes(`${n} 张`),
      `hasImage=${hasImage} n=${n}：花费提示报出具体张数`);
  }
}
ok(candidateButtonLabel({ hasImage: true, n: 4, submitting: false, running: false })
  .includes("换一张"),
  "★ 已有图时说「换一张」而不是「生成」（说「生成」会让人以为当前那张要被顶掉）");
ok(candidateButtonLabel({ hasImage: false, n: 1, submitting: false, running: false })
  .includes("生成定妆图"),
  "没有图时说「生成定妆图」");
ok(candidateButtonLabel({ hasImage: true, n: 4, submitting: false, running: true })
  .includes("可关掉弹窗"),
  "★ job 在跑时明说可以关掉弹窗（它确实关了也在跑，不说用户会一直干等）");
ok(candidateButtonLabel({ hasImage: true, n: 4, submitting: true, running: false })
  === "提交中…",
  "提交在途时是「提交中…」（与「生成中」区分：这时还没开始出图）");

console.log("\n[3] 候选图只有一条路（job 化那条）");
const apiSrc = read("src/api.ts");
ok(!/\bstageCandidates\b\s*:/.test(apiSrc),
  "★★ api.ts 不再封装同步版 stageCandidates",
  "两条路并存正是 2026-09-11 复审误判「前端没有候选图入口」的原因");
ok(/stages\/\{id\}\/candidates|stages\/\$\{stageId\}\/candidates|stageCandidates/.test(apiSrc),
  "但 api.ts 里留了字面说明（为什么刻意不封装），不是悄悄删掉",
  "无痕删除会让下一个人以为这条后端路由根本不存在，进而再封一次");
ok(/submitAssetCandidates/.test(apiSrc) && /latestAssetCandidates/.test(apiSrc),
  "job 化的提交 + 接回两个入口都在");
const srcFiles = ["src/components/AssetDialog.tsx", "src/api.ts"];
for (const f of srcFiles) {
  ok(!/api\.stageCandidates/.test(read(f)), `${f} 里没有 api.stageCandidates 的调用`);
}
const routes = readFileSync(
  join(ROOT, "..", "backend/app/routes_v2.py"), "utf8");
ok(/已被取代，新代码不要用/.test(routes),
  "★ 后端那条同步路由仍在（旧客户端要用），但 docstring 已标明弃用与保留理由",
  "删路由会让已安装的旧 Beta 资产弹窗当场报错；不标注则会被当成现役入口");

console.log("\n[4] 弹窗接线：候选不落库、挑中才写");
const dlg = read("src/components/AssetDialog.tsx");
ok(/defaultCandidateCount\(!!t\.imageUrl\)/.test(dlg),
  "★ 默认张数按「进弹窗时有没有图」取，不是写死 4");
ok(/CANDIDATE_COUNTS\.map/.test(dlg), "张数选择器用的是同一份档位常量");
ok(/candidateButtonLabel\(\{/.test(dlg) && /candidateCostHint\(genN/.test(dlg),
  "按钮文案与花费提示都来自本模块（不在 JSX 里另写一套）");
ok(!/重新生成会覆盖|会覆盖当前定妆图|覆盖现有定妆图/.test(dlg),
  "★ 没有「重新生成会覆盖」这类过时措辞（job 化之后候选不落库，挑中才写）");
ok(/pick\(/.test(dlg) && /(patchStage|patchAsset|upsertAssetImage)/.test(dlg),
  "★ 落库只发生在 pick（点选）里 —— 生成本身不碰资产图");
ok(/可以关掉弹窗，回来接着挑/.test(dlg),
  "提交成功的 toast 也讲明可关窗（与按钮上的说法一致）");

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0
  ? "✅ 默认张数随处境变（无图 1 张 / 有图 4 张），按钮与提示都报出这次的张数与计费，"
    + "候选图只剩 job 化一条路，生成永远不会顶掉当前定妆图。"
  : "❌ 有断言不过 —— 这条链路直接对应用户花的钱，先修上面第一条 ❌。");
process.exit(fail === 0 ? 0 : 1);
