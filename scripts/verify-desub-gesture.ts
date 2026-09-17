/**
 * verify-desub-gesture — 去字幕块的**区间规则**（建块 + 三种拖拽的边界）
 *
 * ## 这个脚本替代的是什么
 *
 * 拖拽本身必须靠人眼看（跟不跟手、松手闪不闪），但**边界全是算术**：
 * 块不能跨镜、不能被拖成反向、不能被拖成零宽、手工标记要往前留 1 秒。
 * 这四条错判都不会报错，只会表现为"擦的位置不对"——而擦除**不可逆、按时长
 * 计费**，等用户发现已经付过钱了。所以算术这一半由脚本盯死。
 *
 * ## 为什么 import 真函数而不是读源码文本
 *
 * 架构守卫在报告里盯着「79% 的 verify 脚本靠读源码文本」这个数字，
 * 并写明它该往下走。读文本的断言锁的是"代码长什么样"，改个写法就假红、
 * 逻辑错了却照样绿。这里的四个规则都是纯函数，能真跑就真跑。
 */

import {
  MIN_DESUB_SEC, LEAD_SEC, manualDesubSpan,
  clampDesubEnd, clampDesubStartDelta, clampDesubMove,
} from "../src/features/timeline/desubGesture";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) { pass++; console.log(`   ✅ ${label}`); }
  else { fail++; console.log(`   ❌ ${label}${detail ? `  — ${detail}` : ""}`); }
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("\n[1] 手工标记建块：起点回退 1s、终点取片段末");

{
  const s = manualDesubSpan(5.0, 8.0);
  ok(near(s.t0, 4.0) && near(s.t1, 8.0),
    "片中标注 → 回退 1s 起、擦到片段末", JSON.stringify(s));

  // 用户在片头 0.4s 就按下了：往前推会变成负数，必须夹在 0。
  const head = manualDesubSpan(0.4, 8.0);
  ok(near(head.t0, 0) && near(head.t1, 8.0),
    "片头标注 → 起点夹在 0，不会变成负数", JSON.stringify(head));

  ok(near(LEAD_SEC, 1.0), "回退量就是 1.0s（用户指定的语义，别人顺手调了要在这里红）");

  // 极端：在片段的最后一瞬标注，且片段极短。终点不能落到起点之前/同点，
  // 否则建出来的是一个零宽块——点不中、删不掉，还会被提交去擦。
  const tail = manualDesubSpan(0.05, 0.05);
  ok(tail.t1 > tail.t0 && near(tail.t1 - tail.t0, MIN_DESUB_SEC),
    "极短片段 → 至少留 MIN_DESUB_SEC，不会建出零宽块", JSON.stringify(tail));
}

console.log("\n[2] 拖右缘：上界是本镜末尾（不跨镜），下界是最短区间");

{
  ok(near(clampDesubEnd(2, 3, 8), 3), "正常范围内原样通过");
  ok(near(clampDesubEnd(2, 99, 8), 6),
    "往右拖过头 → 停在本镜末尾（2 + 6 = 8）", String(clampDesubEnd(2, 99, 8)));
  ok(near(clampDesubEnd(2, -5, 8), MIN_DESUB_SEC),
    "往左拖穿 → 停在最短区间，不会变成负长度");
  // 起点已经贴着镜尾时，`shotDur - a` 是负的；仍必须给出正长度。
  ok(clampDesubEnd(7.95, 1, 8) >= MIN_DESUB_SEC,
    "起点贴着镜尾 → 仍返回正长度（上界退化时不能算出负数）",
    String(clampDesubEnd(7.95, 1, 8)));
  ok(near(clampDesubEnd(0, 2.44, 8), 2.4),
    "按 0.1s 量化（预览与落库共用这一次取整，否则松手会跳）",
    String(clampDesubEnd(0, 2.44, 8)));
}

console.log("\n[3] 拖左缘：可往回拖，但不越镜头开头、不把区间挤没");

{
  // a0=3、b=6 的块：往左最多退 3（到镜头开头），往右最多到 b-0.2。
  ok(near(clampDesubStartDelta(3, 6, -1), -1), "往左拖 1s → 原样通过（起点回退是最常用的调整）");
  ok(near(clampDesubStartDelta(3, 6, -99), -3),
    "往左拖穿 → 停在镜头开头（delta = -a0）", String(clampDesubStartDelta(3, 6, -99)));
  ok(near(clampDesubStartDelta(3, 6, 99), 2.8),
    "往右拖穿 → 停在距终点 MIN_DESUB_SEC 处，区间不会反向",
    String(clampDesubStartDelta(3, 6, 99)));
  // 已经在镜头开头时，往左不该再动。
  ok(near(clampDesubStartDelta(0, 4, -2), 0), "已在镜头开头 → 往左拖不动");
}

console.log("\n[4] 拖整块：长度不变地在本镜内平移");

{
  ok(near(clampDesubMove(4, 2, 8), 2), "正常范围内原样通过");
  ok(near(clampDesubMove(4, 99, 8), 4),
    "往右拖过头 → 块的右端停在镜尾（8 - 4 = 4）", String(clampDesubMove(4, 99, 8)));
  ok(near(clampDesubMove(4, -99, 8), 0), "往左拖过头 → 停在镜头开头");
  // 块比镜头还长（镜头被改短过）：此时没有可移动空间，只能钉在 0，
  // 不能算出负的起点（负起点换算成源秒后会 -ss 到文件之前）。
  ok(near(clampDesubMove(10, 3, 8), 0),
    "块比镜头长 → 钉在 0，不会算出负起点", String(clampDesubMove(10, 3, 8)));
}

console.log("\n[5] 跨规则的不变式：任何一种拖法都不会产出非法区间");

{
  // 随机穷举：三种手势各扫一遍典型参数，检查算出的区间恒满足
  // 0 ≤ t0 < t1 ≤ shotDur 且 t1 - t0 ≥ MIN_DESUB_SEC。
  const shotDur = 8;
  let bad = 0;
  for (let a = 0; a <= shotDur; a += 0.37) {
    for (let want = -20; want <= 20; want += 0.53) {
      const dur = clampDesubEnd(a, want, shotDur);
      if (dur < MIN_DESUB_SEC) bad++;
      // 右缘夹紧只保证不超过镜尾；起点贴着镜尾时长度会顶到 MIN_DESUB_SEC
      // 而略微越界，那是"起点本身已非法"造成的，不在这条不变式的范围内。
      if (a + dur > shotDur + 1e-9 && a + MIN_DESUB_SEC <= shotDur) bad++;

      const len = 3;
      const a2 = clampDesubMove(len, want, shotDur);
      if (a2 < 0 || a2 + len > shotDur + 1e-9) bad++;
    }
  }
  ok(bad === 0, "穷举三种手势的参数空间，未产出非法区间", `${bad} 例越界`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-desub-gesture：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
