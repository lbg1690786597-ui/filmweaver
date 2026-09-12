/**
 * verify-draggeom.ts — 拖动几何纯计算验证（3.11）
 *
 * 验的是**拖动被拆成"块跟手走 / 落点离散跳"之后，两边各自的判据**。
 * 三条最容易写错的：
 *   ① 连续位移**不许**被量化 —— 一旦量化，用户看到的就是"不跟手"
 *   ② 落点是**区间归属**不是最近邻 —— 长片段上两者的结果差半个身位
 *   ③ 自动滚动必须能在拖到边缘时**停下来** —— 正反馈会让它越滚越快
 *
 * 这三条在真机上分别表现为"不跟手""松手回跳""拖到边缘就失控"，都属于
 * 拿鼠标去试才发现的类型，所以钉在脚本里。
 */

import {
  buildSlots, continuousOffsetPx, centerSecOf, targetSlotAt,
  autoScrollStep, scrollCompensatedSec, dropLabel,
} from "../src/features/timeline/dragGeom";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function near(name: string, actual: number, expected: number, eps = 1e-9) {
  const ok = Math.abs(actual - expected) < eps;
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${expected}  实际 ${actual}`);
}

console.log("① buildSlots：order→start + order→duration 拼成有序区间");
{
  // 三镜 4s/3s/5s
  const offsets = new Map([[1, 0], [2, 4], [3, 7]]);
  const durs = new Map([[1, 4], [2, 3], [3, 5]]);
  const slots = buildSlots(offsets, durs);
  check("槽位表按 start 排序", slots.map((s) => s.order), [1, 2, 3]);
  check("区间首尾", slots.map((s) => [s.start, s.end]),
        [[0, 4], [4, 7], [7, 12]]);

  // 时长缺失：用"到下一个槽的距离"兜底（末槽没有下一个 → 0 宽）
  const slots2 = buildSlots(new Map([[1, 0], [2, 4]]), new Map([[1, 4]]));
  check("末槽缺时长 → 0 宽但仍在表里", slots2.map((s) => [s.order, s.start, s.end]),
        [[1, 0, 4], [2, 4, 4]]);

  check("空表不炸", buildSlots(new Map(), new Map()), []);
}

console.log("② continuousOffsetPx：位移就是位移，一个像素都不许少");
{
  // ⚠️ 这条是"跟手"的判据。旧实现是 Math.round(Δx / slotPx) * slotPx，
  //    容差再小也会在槽边界处跳 —— 所以这里用**逐像素**断言。
  const step = 1;
  let allExact = true;
  for (let dx = -50; dx <= 50; dx += step) {
    if (continuousOffsetPx(200 + dx, 200) !== dx) allExact = false;
  }
  check("±50px 内逐像素精确（无量化）", allExact, true);
  near("小数位移也精确", continuousOffsetPx(200.5, 200), 0.5);
}

console.log("③ centerSecOf：块中心 = 起点 + 半身位 + 位移");
{
  near("未移动时是几何中心", centerSecOf(10, 4, 0, 20), 12);
  near("右移 40px（20px/s）= +2s", centerSecOf(10, 4, 40, 20), 14);
  near("左移 40px = -2s", centerSecOf(10, 4, -40, 20), 10);
}

console.log("④ targetSlotAt：区间归属 + 两端钳制");
{
  const slots = buildSlots(
    new Map([[1, 0], [2, 4], [3, 7]]),
    new Map([[1, 4], [2, 3], [3, 5]]),
  );
  check("中心在首槽 → 1", targetSlotAt(slots, 1.0, 99), 1);
  check("中心在首槽右边界内侧 → 1", targetSlotAt(slots, 3.99, 99), 1);
  check("中心正好在缝上 → 归后一槽（区间左闭）", targetSlotAt(slots, 4.0, 99), 2);
  check("中心在末槽 → 3", targetSlotAt(slots, 9.0, 99), 3);
  check("拖到最左端外 → 钳到首槽", targetSlotAt(slots, -100, 99), 1);
  check("拖到最右端外 → 钳到末槽", targetSlotAt(slots, 9999, 99), 3);
  check("正好落在末槽终点（闭区间）→ 3", targetSlotAt(slots, 12, 99), 3);
  check("空表 → fallback（宁可不动，不许跳到 1）", targetSlotAt([], 3, 7), 7);

  // ⚠️ 区间归属 vs 最近邻：长片段上的分歧。
  //    20s 的块从 order 1 拖到"中心落在第 2 槽区间内"时，两种算法都给 2；
  //    但块中心刚过首槽终点一点点时，最近邻会因为"离槽 2 起点更近"而提前判给 2，
  //    区间归属则要求中心真的进入槽 2 —— 这里各钉一条，防止日后被"优化"成最近邻。
  const long = buildSlots(new Map([[1, 0], [2, 20]]), new Map([[1, 20], [2, 10]]));
  check("长块中心仍在槽 1 内 → 1", targetSlotAt(long, 19.9, 99), 1);
  check("长块中心越过缝 → 2", targetSlotAt(long, 20.1, 99), 2);
}

console.log("⑤ autoScrollStep：贴边才滚，且越贴越快、到顶封住");
{
  // 视口 [0, 1000]，触发带 40px
  check("居中 → 不滚", autoScrollStep(500, 0, 1000), 0);
  check("刚好在左触发带外 → 不滚", autoScrollStep(41, 0, 1000), 0);
  check("刚进左触发带 → 微滚（负=回看）", autoScrollStep(39, 0, 1000) < 0, true);
  check("贴到左边缘 → 满步进 −12", autoScrollStep(0, 0, 1000), -12);
  check("超出左边界 → 仍封在 −12（不许越滚越快）", autoScrollStep(-500, 0, 1000), -12);
  check("贴到右边缘 → 满步进 +12", autoScrollStep(1000, 0, 1000), 12);
  check("超出右边界 → 封在 +12", autoScrollStep(5000, 0, 1000), 12);
  // ⚠️ 正反馈判据：视口宽度 ≤ 2×触发带时整条都是触发带，
  //    此时若还滚，块会被自己推动的滚动无限加速。必须返回 0。
  check("视口窄到全是触发带 → 不滚（防正反馈）", autoScrollStep(30, 0, 60), 0);
}

console.log("⑥ scrollCompensatedSec：滚动补偿，防「滚动→指针前进→再滚」死循环");
{
  const slots = buildSlots(new Map([[1, 0], [2, 4]]), new Map([[1, 4], [2, 2]]));
  // 20px/s，容器右滚 40px：指针指着的绝对秒要**减去** 2s
  near("右滚 40px → 时间倒退 2s", scrollCompensatedSec(12, 40, 20), 10);
  near("没滚 → 不变", scrollCompensatedSec(12, 0, 20), 12);
  near("回滚 → 时间前进", scrollCompensatedSec(12, -40, 20), 14);

  // 死循环判据：把补偿后的秒喂回落点，落点不该推动滚动继续加速。
  // 构造"指针停在右边缘、容器按限速滚"，连着跑 10 帧看落点是否收敛。
  let scroll = 0;
  let sec = 6;
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    scroll += 12;                                  // 一帧滚 12px（限速）
    sec = scrollCompensatedSec(6, scroll, 20);     // 指针没动，只是容器滚了
    seen.push(targetSlotAt(slots, sec + 1 /* 半身位 */, 1));
  }
  check("容器持续滚动时，落点单调收敛而不是来回跳",
        seen.every((v, i) => i === 0 || v <= seen[i - 1]), true);
}

console.log("⑦ dropLabel：起点=终点时不显示（闪烁三个成因之一）");
{
  check("没换位 → null", dropLabel(3, 3), null);
  check("还没算出来 → null", dropLabel(3, null), null);
  check("换位 → 读数", dropLabel(3, 5), "#3 → #5");
  check("往前拖也给读数", dropLabel(5, 3), "#5 → #3");
}

console.log(failed ? `\n❌ ${failed} 项未通过` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
