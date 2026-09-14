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
// 3.13：资产轨的段几何与台账投影。它们与上面的片段拖拽是**两套**坐标
// （片段按秒、资产段按 order，但都换算成 px），而用户报的三个 bug
// （点一下缩到最短 / 拖得越长越偏 / 跨轨落错行）全在这一组函数里。
import {
  runGeometry, clampEdge, projectOrders, projectManualAdds,
  syncDiff, pruneTable, finalOps, appendOps,
} from "../src/features/assets/assetOverrides";
import type { AssetOverrideOp } from "../src/features/assets/assetOverrides";

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

console.log("⑧ runGeometry：段几何是**未量化**的，且渲染/手势共用同一个入口");
{
  // 三镜 4s/3s/5s，20px/s。order 2 的段：left = 4*20 = 80，
  // width = (7 + 5)*20 - 80 = 160
  const offsets = new Map([[1, 0], [2, 4], [3, 7]]);
  const durs = new Map([[1, 4], [2, 3], [3, 5]]);
  const durOf = (o: number) => durs.get(o) ?? 5;
  const g = runGeometry(2, 3, offsets, 20, durOf);
  near("left = 起点秒 × pxPerSec", g.left, 80);
  near("width = 末镜终点 − 起点", g.width, 160);
  near("right = left + width", g.right, 240);

  // ⚠️ 判据（用户报的"拖得越长越偏"）：同样像素位移下，几何必须**逐像素线性**。
  //    旧实现每帧 `parseFloat(el.style.width)` 读回已舍入的值，误差会随距离累加。
  const base = runGeometry(1, 1, offsets, 20, durOf);
  const shift = 137.37;   // 故意取不能整除的值
  const moved = runGeometry(1, 1, new Map([[1, shift / 20]]), 20, durOf);
  near("位移 137.37px → left 也正好 137.37（无舍入累加）", moved.left - base.left, shift, 1e-9);

  // 缺时长兜底 5s（与后端排轴一致），且这个兜底**不**影响起点
  const g2 = runGeometry(2, 2, new Map([[2, 10]]), 20, () => 5);
  near("末镜缺时长 → 按 5s 兜底", g2.width, 100);

  // minWidth 只兜渲染下限：一镜 0.1s（2px）也必须画得出
  const g3 = runGeometry(1, 1, new Map([[1, 0]]), 20, () => 0.1);
  near("极短段被 minWidth 托住", g3.width, 16);
  const g4 = runGeometry(1, 1, new Map([[1, 0]]), 20, () => 0.1, 4);
  near("minWidth 可覆盖（手势里传小值）", g4.width, 4);
}

console.log("⑨ clampEdge：两端**不许交叉**（点一下就缩到最短的根治点）");
{
  // 左边缘最右只能到"右边缘 − 一格"；右边缘最左只能到"左边缘 + 一格"
  near("左边缘想越过右边缘 → 被拦住", clampEdge(500, "from", 300, 20), 280);
  near("左边缘没越界 → 原样", clampEdge(250, "from", 300, 20), 250);
  near("右边缘想越过左边缘 → 被拦住", clampEdge(100, "to", 300, 20), 320);
  near("右边缘没越界 → 原样", clampEdge(400, "to", 300, 20), 400);
  // ⚠️ 边界相等也必须只留一格宽，不能变成 0（0 宽的段用户再也抓不住）
  near("两端正好要重合 → 仍留一格", clampEdge(300, "from", 300, 20), 280);
  near("两端正好要重合（右侧）→ 仍留一格", clampEdge(300, "to", 300, 20), 320);
}

console.log("⑩ projectOrders：底座 ∪ 台账，且后写的覆盖先写的");
{
  const base = [1, 2, 3];
  const mk = (order: number, present: boolean, manual = false, at = 1): AssetOverrideOp =>
    ({ order, present, manual, at });
  check("空台账 → 底座原样", projectOrders(base, []), [1, 2, 3]);
  check("加一镜", projectOrders(base, [mk(4, true)]), [1, 2, 3, 4]);
  check("减一镜", projectOrders(base, [mk(2, false)]), [1, 3]);
  // ⚠️ 时间线语义：同一个 order 先删后加，最终必须是**要**。
  //    只按"有没有出现过 present:false"判的实现会在这里挂掉。
  check("先删后加 → 要（后写覆盖）", projectOrders(base, [mk(2, false, false, 1), mk(2, true, true, 2)]), [1, 2, 3]);
  check("先加后删 → 不要", projectOrders(base, [mk(4, true, false, 1), mk(4, false, false, 2)]), [1, 2, 3]);
  // 特殊镜：既不显示也不注入，台账里写了也不算
  check("特殊镜被排除", projectOrders([1, 2, 9], [mk(9, true)], (o) => o === 9), [1, 2]);
  check("底座里的特殊镜也排除", projectOrders([1, 9], [], (o) => o === 9), [1]);
  // 同一毫秒内的稳定性：`at` 相同时以**数组顺序**为准（appendOps 保证了顺序）
  const t = appendOps({}, "林晚", [{ order: 5, present: false, manual: false }], 7);
  const t2 = appendOps(t, "林晚", [{ order: 5, present: true, manual: true }], 7);
  check("同毫秒按追加顺序取后者", projectOrders([], t2["林晚"]), [5]);
}

console.log("⑪ projectManualAdds：斜纹标的是'投影后仍在、且是人加的'");
{
  const base = [1, 2];
  const ops: AssetOverrideOp[] = [
    { order: 3, present: true, manual: true, at: 1 },
    { order: 1, present: false, manual: false, at: 2 },
  ];
  // order 3 是人工加的 → 斜纹；order 1 被删了，不在 shown 里 → 不出现
  check("只在 shown 里标", projectManualAdds([2, 3], base, ops), [3]);
  // 底座里本来就有、台账没碰 → 不是人加的（那是 AI 判定）
  check("底座自带的不标", projectManualAdds([1, 2], base, []), []);
  // 台账明确标了 manual:false 的即使不在底座里也不算人加（AI 推导补的）
  check("manual:false 不标", projectManualAdds([2, 4], base,
    [{ order: 4, present: true, manual: false, at: 1 }]), []);
}

console.log("⑫ syncDiff：只发**真差集**，本地等于服务端时不发请求");
{
  const base = [1, 2, 3];
  check("无改动 → 空对（调用方据此不发请求）", syncDiff(base, []), { add: [], remove: [] });
  check("加 4", syncDiff(base, [{ order: 4, present: true, manual: true, at: 1 }]),
        { add: [4], remove: [] });
  check("删 2", syncDiff(base, [{ order: 2, present: false, manual: false, at: 1 }]),
        { add: [], remove: [2] });
  check("同时增删", syncDiff(base, [
    { order: 2, present: false, manual: false, at: 1 },
    { order: 5, present: true, manual: true, at: 1 },
  ]), { add: [5], remove: [2] });
  // 幂等性判据：把 diff 应用回 base，再算一次必须是空 —— 这正是"重发安全"的由来
  const d = syncDiff(base, [{ order: 5, present: true, manual: true, at: 1 }]);
  const applied = [...base.filter((o) => !d.remove.includes(o)), ...d.add].sort((a, b) => a - b);
  const again = syncDiff(applied, [{ order: 5, present: true, manual: true, at: 1 }]);
  check("应用后再 diff 为空（重发安全）", again, { add: [], remove: [] });
  // 特殊镜不参与
  check("特殊镜不进差集", syncDiff([1], [{ order: 9, present: true, manual: true, at: 1 }],
        (o) => o === 9), { add: [], remove: [] });
}

console.log("⑬ pruneTable：只摘'落库截止时刻之前'的 op");
{
  const table = { 林晚: [
    { order: 1, present: false, manual: false, at: 100 },
    { order: 2, present: false, manual: false, at: 300 },
  ] };
  // 服务端回话：order 1 已按本地意图删掉，order 2 也已经删了
  const serverBase = () => [2];
  // 截止时刻 200 → 只兑现了 at=100 那条；at=300 那条服务端没见过，必须留
  const r = pruneTable(table, serverBase, () => 200);
  check("只摘截止之前的", r.table["林晚"]?.map((o) => o.at), [300]);
  check("摘掉的条数", r.pruned, 1);
  // ⚠️ 不传截止时刻（返回 undefined）→ 一条都不许摘。
  //    否则用户正在拖的那批意图会被服务端旧底座误判成"已兑现"然后删掉。
  const r2 = pruneTable(table, serverBase, () => undefined);
  check("没有截止时刻 → 一条都不摘", r2.pruned, 0);
  check("原样保留", r2.table["林晚"]?.length, 2);
  // 服务端还没回话（null）→ 原样保留
  const r3 = pruneTable(table, () => null, () => 999);
  check("底座未知 → 原样保留", r3.pruned, 0);
  // 全部兑现 → 空行要被移除（表里不留空数组，否则 flush 会为它白发一次请求）
  const r4 = pruneTable(table, () => [], () => 999);
  check("全兑现 → 行被移除", Object.keys(r4.table), []);
}

console.log("⑭ finalOps：时间线取最终态（同一 order 多条只留最后一条）");
{
  const ops: AssetOverrideOp[] = [
    { order: 1, present: true, manual: false, at: 5 },
    { order: 1, present: false, manual: false, at: 3 },
    { order: 2, present: true, manual: true, at: 9 },
  ];
  const f = finalOps(ops);
  check("后写覆盖先写（与数组顺序无关，只按 at）", f.get(1), { present: true, manual: false });
  check("另一条", f.get(2), { present: true, manual: true });
}

console.log(failed ? `\n❌ ${failed} 项未通过` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
