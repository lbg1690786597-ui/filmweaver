/**
 * verify-recutplan.ts — 划区间面板算术的验证（3.11 R3）
 *
 * 为什么这点算术值得单独测：
 *
 * - **算错了没有任何报错**。面板上那块「A 3.0s | B 4.1s | C 2.9s」是用户
 *   对这个功能全部的认知，数字与实际划出的区间对不上时，用户要到出片
 *   才发现长度不对 —— 而那时 B 段已经花过钱了。
 * - **滑块互夹是防 422，不是防手滑**。起点越过终点时后端会拒（文案没错），
 *   但用户的感受是"我明明拖到位置了却被拒"。夹持一旦回归，这个体验
 *   就悄悄坏掉，没有任何测试会红。
 * - **下限刻意不在这里**。中间段能出多短取决于项目当前视频模型
 *   （H3 2s / seedance 4s / veo 8s），只有后端知道。这条断言是**反向**的：
 *   4s 的中间段在这个模块里必须被判为"可提交"，否则说明有人把后端的
 *   下限抄了一份到前端，两个数迟早漂移。
 */

import {
  RECUT_EDGE_SEC, dragCutA, dragCutB, planRecut, recutBlocked,
} from "../src/features/timeline/recutPlan";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}

// ── 默认切点 ────────────────────────────────────────────────
// 用户点开面板、什么都不动就提交，是最常见的一次操作。

{
  // 用户原话里的那个例子：10s 的片段，前 3 后 3 可用、中间 4 要重做。
  // 默认值给的是 3.3 / 6.7（等分），与他要的 3 / 7 差 0.4s —— 这正是
  // "默认值只是起点，他一定会去拖"的证据，不该反过来替他猜。
  const r = planRecut(10, null, null);
  check("10s 默认等分", [r.a, r.b], [3.3, 6.7]);
  check("10s 三段和等于全片", r.head + r.mid + r.tail, 10);
  check("10s 默认无阻拦", r.why, null);
}

{
  const r = planRecut(11.08, null, null);
  check("11.08s 默认切点取一位小数", [r.a, r.b], [3.7, 7.4]);
  check("11.08s 三段和等于全片", r.head + r.mid + r.tail, 11.08);
}

{
  // 3.0s 的镜头：1/3 = 1.0、2/3 = 2.0，两侧刚好压着 0.5 的边距。
  const r = planRecut(3, null, null);
  check("3s 默认切点", [r.a, r.b], [1, 2]);
  check("3s 默认可提交（边距恰好够）", r.why, null);
}

// ── 边距 ────────────────────────────────────────────────────

{
  const r = planRecut(10, 0.4, 7);
  check("起点压到 0.4 → 拦下", r.why !== null, true);
}
{
  const r = planRecut(10, 3, 9.6);
  check("终点压到 9.6 → 拦下", r.why !== null, true);
}
{
  const r = planRecut(10, 0.5, 9.5);
  check("正好 0.5 / 9.5 → 放行（>= 与 > 不能差一）", r.why, null);
}
{
  // 整镜 1s：两侧各要 0.5，中间段长度必然 <= 0，任何切点都无解。
  // 文案要说"太短"而不是"离两端 0.5s 以上"—— 后者会让用户以为
  // 拖一拖就能行，白试半天。
  const r = planRecut(1, null, null);
  check("1s 镜头 → 判为太短", r.why !== null && r.why.includes("太短"), true);
}

// ── 重合 ────────────────────────────────────────────────────

{
  const r = planRecut(10, 4, 4);
  check("两切点重合 → 拦下", r.why, "两个切点不能重合");
}
{
  const r = planRecut(10, 5, 4);
  check("起点越过终点 → 拦下", r.why, "两个切点不能重合");
}

// ── 滑块互夹 ────────────────────────────────────────────────

{
  const plan = planRecut(10, 3, 7);
  check("起点拖过终点 → 夹到 6.9", dragCutA(plan, 8), 6.9);
  check("起点拖到负数 → 夹到 0.1", dragCutA(plan, -5), 0.1);
  check("起点正常拖动 → 原值", dragCutA(plan, 2.4), 2.4);
  check("终点拖到起点之前 → 夹到 3.1", dragCutB(plan, 1, 10), 3.1);
  check("终点拖出片尾 → 夹到 9.9", dragCutB(plan, 99, 10), 9.9);
  check("终点正常拖动 → 原值", dragCutB(plan, 8.2, 10), 8.2);
}

{
  // 夹完之后**必须重新算一遍**才拿去渲染：只夹数字不改 state 的话，
  // 用户把起点拖过头，看到的还是旧终点，但提交上去的是被夹过的值。
  const plan = planRecut(10, 3, 7);
  const a = dragCutA(plan, 8);
  const after = planRecut(10, a, 7);
  check("夹持结果回灌后仍可提交", after.why, null);
  check("夹持结果回灌后中间段仍为正", after.mid > 0, true);
}

// ── 下限不归前端管（反向断言）────────────────────────────────

{
  // 0.5s 的中间段 —— 任何模型都出不了（最短的是 minimax 的 2s）。
  // 前端**必须放行**：它不知道项目用的是哪个模型，拦在这里等于
  // 把"哪个模型"这个事实在前端抄了第二份。
  const r = planRecut(10, 4, 4.5);
  check("0.5s 中间段前端放行（下限交给后端）", r.why, null);
  check("0.5s 中间段数字如实", r.mid, 0.5);
}

{
  // 边距常量必须与后端 `recut_shot` 的 margin 一致，否则前端放行的
  // 切点会被后端 422 —— 那种"按钮亮着却点不动"最难排查。
  check("边距与后端一致", RECUT_EDGE_SEC, 0.5);
  check("edge 常量参与判据（不是摆设）",
    recutBlocked(10, RECUT_EDGE_SEC - 0.01, 7) !== null, true);
}

// ── 脏输入 ──────────────────────────────────────────────────

{
  // 时长缺失/为 0 的镜头（B 段自己就是 pending，可能没有 duration_sec）。
  // 不能让 NaN 漏进浮层 —— 渲染出 "NaNs" 比报错更难懂。
  for (const bad of [0, -3, NaN, Infinity]) {
    const r = planRecut(bad, null, null);
    check(`时长 ${bad} → 不给切点`, [r.a, r.b], [0, 0]);
    check(`时长 ${bad} → 拦下`, r.why !== null, true);
  }
}

console.log(failed ? `\n❌ ${failed} 条失败` : "\n✅ 全部通过");
if (failed) process.exit(1);
