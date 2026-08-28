/**
 * verify-form-state.ts — F17 乐观覆盖自愈 / F18 集数输入校验
 *
 * 两段判定都曾内联在组件里并各自出过静默 bug，提到 lib/formState.ts 后
 * 可以直接跑。重点验的是"修复前会怎样错"：
 *   F17 无条件覆盖 → 服务端后来重生的新图永远显示不出来
 *   F18 Number("")=0 → 400；Number("abc")=NaN → 序列化成 null → 静默忽略
 */

import { effectiveUrl, parseEpisodeInput, type Override } from "../src/lib/formState";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}

console.log("\n① F17 首帧乐观覆盖：立即生效，且 props 追上后自动让位");

// 场景：卡片显示服务端的 old.png，用户点「重生首帧」拿到 new.png
const server0: string | null = "/media/old.png";
check("无覆盖时用服务端值", effectiveUrl(null, server0), "/media/old.png");

const ov: Override = { base: server0, url: "/media/new.png" };
check("刚重生（props 还没刷新）→ 显示新图",
      effectiveUrl(ov, server0), "/media/new.png");

// refreshDetail 回来了，服务端也变成 new.png：覆盖与 props 一致，谁赢都对
check("props 追上（同一张）→ 仍是新图",
      effectiveUrl(ov, "/media/new.png"), "/media/new.png");

// 关键用例：之后批量首帧 job 又重生了这一镜，服务端换成 batch.png。
// 修复前 `override ?? server` 会永久返回 new.png —— 新图永远看不到。
check("服务端后来又变了（批量 job 重生）→ 覆盖自动失效，显示最新",
      effectiveUrl(ov, "/media/batch.png"), "/media/batch.png");

// 从"本来没有首帧"变成有：base 为 null 的覆盖同样要能自愈
const ovFromNull: Override = { base: null, url: "/media/first.png" };
check("原本无首帧 → 覆盖生效", effectiveUrl(ovFromNull, null), "/media/first.png");
check("原本无首帧 → 服务端有值后让位",
      effectiveUrl(ovFromNull, "/media/server.png"), "/media/server.png");

console.log("\n② F18 集数输入：非法回填、无变化不发请求");

check("正常修改 → 保存", parseEpisodeInput("5", 3), { kind: "save", value: 5 });
check("带空格照样识别", parseEpisodeInput("  7 ", 3), { kind: "save", value: 7 });
check("值没变 → 不发请求（修复前每次失焦都 PATCH）",
      parseEpisodeInput("3", 3), { kind: "noop" });

// 修复前：Number("") === 0 → 后端 400「ep_from 不能小于 1」
check("删空 → 拒绝（修复前发 0 触发后端 400）",
      parseEpisodeInput("", 3).kind, "reject");
check("纯空格 → 拒绝", parseEpisodeInput("   ", 3).kind, "reject");

// 修复前：Number("abc") === NaN → JSON 里是 null → 后端当"没传"忽略 → 静默无操作
check("非数字 → 拒绝（修复前 NaN→null，后端静默忽略）",
      parseEpisodeInput("abc", 3).kind, "reject");
check("非数字的提示里带上原输入",
      parseEpisodeInput("abc", 3).kind === "reject"
        && (parseEpisodeInput("abc", 3) as { message: string }).message.includes("abc"),
      true);

check("0 → 拒绝（后端要求 >=1）", parseEpisodeInput("0", 3).kind, "reject");
check("负数 → 拒绝", parseEpisodeInput("-2", 3).kind, "reject");
check("小数 → 拒绝（集数是整数）", parseEpisodeInput("2.5", 3).kind, "reject");
check("Infinity → 拒绝", parseEpisodeInput("Infinity", 3).kind, "reject");
// "1e3" 是合法整数 1000，不该被当成乱输入拦掉
check("科学计数法 1e3 → 视为 1000", parseEpisodeInput("1e3", 3),
      { kind: "save", value: 1000 });

console.log();
if (failed) {
  console.log(`❌ ${failed} 个用例失败`);
  process.exit(1);
}
console.log("✅ F17/F18 表单与乐观更新判定全部通过");
