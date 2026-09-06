/**
 * verify-kfedit —— 关键帧**编辑**操作（5.6）验证
 * 跑法：npx tsx scripts/verify-kfedit.ts
 *
 * 5.5 的结构性教训写在 `verify-kfexpr.ts` 第 [0] 节：**交叉钉对「共同真源」是瞎的**。
 * 本条比 5.5 更暴露在这个风险下 —— `keyframeEdit` 的每个函数都建立在
 * `normalizeKfs` / `regionBoxAt` / `remapStroke` 之上，光比对「编辑前后两边一致」
 * 什么都证明不了。所以本脚本的骨架是：
 *
 *   [0] 给 `remapStroke` / `regionShapeAt` 一组**绝对**取值断言（共享真源，必须绝对钉）
 *   [1] `findKfIndexAt` 的命中语义
 *   [2] `applyRegionBox` 三条分支各自的绝对取值
 *   [3] **不变式**：任何操作之后 `kfCount<2` ⟹ 静态框 === 那条关键帧
 *       并用 `regionBoxAt` 反查「拖了看得见」——这条是本条最承重的断言
 *   [4] `removeKfAt` / `clearKfs`
 *   [5] `retimeKf`（含"拖动的那条赢"）
 *   [6] 变速重算：钉的是**语义**（新 t' 处的框 === 旧 t 处的框），不是"数字乘了个数"
 *   [7] `trajectory`
 *   [8] 端到端：动画区域在 t 时刻的**光栅化蒙版**，等于「把框搬到当帧位置的静态区域」的蒙版
 *       —— 预览与导出共用 `regionShapeAt` 这件事，在真正的光栅化器上收口
 */

import {
  KF_EPS_SEC, kfsOf, kfCount, staticBox, findKfIndexAt,
  applyRegionBox, insertKfAt, removeKfAt, clearKfs, retimeKf,
  trajectory, rescaleKfTimes, rescaleMosaicsForSpeed, outputSec, shotSecOf,
} from "../src/lib/keyframeEdit";
import { remapStroke, regionShapeAt, regionShapeOf } from "../src/lib/regionShape";
import type { Box } from "../src/lib/regionShape";
import { regionBoxAt, normalizeKfs } from "../src/render/maskGroups";
import { rasterGroupMask } from "../src/render/maskRaster";
import type { MosaicParams, RegionKeyframe } from "../src/render/model";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const boxEq = (a: Box, b: Box, eps = 1e-9) =>
  near(a.x, b.x, eps) && near(a.y, b.y, eps) && near(a.w, b.w, eps) && near(a.h, b.h, eps);
const fmt = (b: Box) => `${b.x.toFixed(4)},${b.y.toFixed(4)} ${b.w.toFixed(4)}×${b.h.toFixed(4)}`;

const m = (p: Partial<MosaicParams>): MosaicParams =>
  ({ x: 0.30, y: 0.30, w: 0.20, h: 0.10, style: "pixel", intensity: 50, ...p });
const kf = (tSec: number, x: number, y = 0.40, w = 0.20, h = 0.10): RegionKeyframe =>
  ({ tSec, x, y, w, h });
const kfBox = (k: RegionKeyframe): Box => ({ x: k.x, y: k.y, w: k.w, h: k.h });

// ═══════════════════════════════════════════════════════════
console.log("\n[0] 共享真源的**绝对**取值（5.5 的教训：交叉钉证明不了两边都对）");
// ═══════════════════════════════════════════════════════════
{
  // 平移 +0.1/+0.2，不缩放：每个点都该原样平移
  const from: Box = { x: 0.2, y: 0.2, w: 0.4, h: 0.2 };
  const to: Box = { x: 0.3, y: 0.4, w: 0.4, h: 0.2 };
  const s = remapStroke([{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.4 }, { x: 0.4, y: 0.3 }], from, to)!;
  ok(near(s[0].x, 0.3) && near(s[0].y, 0.4), "remapStroke 纯平移：左上角点跟着框走",
    `${s[0].x.toFixed(4)},${s[0].y.toFixed(4)}`);
  ok(near(s[1].x, 0.7) && near(s[1].y, 0.6), "remapStroke 纯平移：右下角点跟着框走",
    `${s[1].x.toFixed(4)},${s[1].y.toFixed(4)}`);
  ok(near(s[2].x, 0.5) && near(s[2].y, 0.5), "remapStroke 纯平移：中间点跟着框走");

  // 各轴独立缩放：x 方向 ×0.5、y 方向 ×2
  const to2: Box = { x: 0.2, y: 0.2, w: 0.2, h: 0.4 };
  const s2 = remapStroke([{ x: 0.4, y: 0.3 }], from, to2)!;
  ok(near(s2[0].x, 0.3), "remapStroke 各轴独立缩放：x 半宽后中点落在 0.3", s2[0].x.toFixed(4));
  ok(near(s2[0].y, 0.4), "remapStroke 各轴独立缩放：y 倍高后中点落在 0.4", s2[0].y.toFixed(4));

  ok(remapStroke(undefined, from, to) === undefined, "remapStroke：无笔迹返回 undefined");

  // 承重点：**笔迹必须留在框内**。这正是 move 分支那条老 bug 的形状 ——
  // 框被夹到边缘停住、笔迹还跟着指针跑，导出遮的就不是用户看到的那块。
  const wide: Box = { x: 0, y: 0, w: 1, h: 1 };
  const clamped: Box = { x: 0.8, y: 0.8, w: 0.2, h: 0.2 };   // 被夹到右下角
  const inside = remapStroke(
    [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }], wide, clamped)!;
  ok(inside.every((p) => p.x >= 0.8 - 1e-9 && p.x <= 1 + 1e-9 && p.y >= 0.8 - 1e-9 && p.y <= 1 + 1e-9),
    "remapStroke：框被夹住时笔迹仍整条落在框内（老 move 分支的分叉 bug）",
    inside.map((p) => `${p.x.toFixed(2)}`).join("/"));
}
{
  // regionShapeAt 的绝对取值：0.0s→x=0.1，1.0s→x=0.5，中点必须是 0.3
  const a = m({ keyframes: [kf(0, 0.1), kf(1, 0.5)] });
  ok(near(regionShapeAt(a, 0).box.x, 0.1), "regionShapeAt(t=0) 取首关键帧");
  ok(near(regionShapeAt(a, 0.5).box.x, 0.3), "regionShapeAt(t=中点) 线性插值到 0.3",
    regionShapeAt(a, 0.5).box.x.toFixed(4));
  ok(near(regionShapeAt(a, 1).box.x, 0.5), "regionShapeAt(t=1) 取尾关键帧");
  ok(near(regionShapeAt(a, 99).box.x, 0.5), "regionShapeAt(t 超出) 夹持为常量，不外推");

  // 恒等性：无关键帧时逐字段等于 regionShapeOf —— 老数据零影响
  const stat = m({ shape: "brush", stroke: [{ x: 0.32, y: 0.32 }, { x: 0.45, y: 0.36 }], brushSize: 0.08 });
  const s0 = regionShapeAt(stat, 3.7), s1 = regionShapeOf(stat);
  ok(JSON.stringify(s0) === JSON.stringify(s1),
    "regionShapeAt：无关键帧时**恒等**于 regionShapeOf（老数据零影响）");

  // 动画 + 画笔：笔迹必须跟着当帧的框走，而不是留在静态框上
  const anim = m({
    x: 0.1, y: 0.4, w: 0.2, h: 0.1,
    shape: "brush", brushSize: 0.08, stroke: [{ x: 0.15, y: 0.45 }],
    keyframes: [kf(0, 0.1), kf(1, 0.5)],
  });
  const sh = regionShapeAt(anim, 1);
  ok(sh.kind === "brush" && near(sh.stroke[0].x, 0.55),
    "regionShapeAt：画笔笔迹随当帧框仿射平移（0.15 → 0.55）",
    sh.kind === "brush" ? sh.stroke[0].x.toFixed(4) : sh.kind);
  ok(sh.kind === "brush" && near(sh.brushSize, 0.08),
    "regionShapeAt：笔刷粗细不随插值改变");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[1] findKfIndexAt：命中语义");
// ═══════════════════════════════════════════════════════════
{
  const a = m({ keyframes: [kf(0, 0.1), kf(1, 0.3), kf(2, 0.5)] });
  ok(findKfIndexAt(a, 1) === 1, "正中命中");
  ok(findKfIndexAt(a, 1 + KF_EPS_SEC * 0.9) === 1, "容差内命中");
  ok(findKfIndexAt(a, 1 + KF_EPS_SEC * 1.5) === -1, "容差外不命中");
  ok(findKfIndexAt(a, 1 + KF_EPS_SEC) === 1,
    "边界 == eps 算命中（浮点上 1+0.05-1 = 0.05000000000000004，故模块留了 1e-9 模糊量）");
  ok(findKfIndexAt(m({}), 0) === -1, "无关键帧恒为 -1");
  // 取**最近**而非第一条：否则实心菱形指的和点下去删掉的可能不是同一条
  const dense = m({ keyframes: [kf(1.00, 0.1), kf(1.04, 0.3)] });
  ok(findKfIndexAt(dense, 1.039) === 1,
    "两条都落在容差内时取**最近**的一条，不是第一条", `idx=${findKfIndexAt(dense, 1.039)}`);
  ok(KF_EPS_SEC === 0.05, "KF_EPS_SEC = 播放头 0.1s 步长的一半", String(KF_EPS_SEC));
}

// ═══════════════════════════════════════════════════════════
console.log("\n[2] applyRegionBox：三条分支的绝对取值");
// ═══════════════════════════════════════════════════════════
const NEW: Box = { x: 0.60, y: 0.20, w: 0.25, h: 0.15 };
{
  // ① 无关键帧 → 老行为：直接改静态框，不凭空产生 keyframes 字段
  const base = m({ shape: "brush", brushSize: 0.08, stroke: [{ x: 0.35, y: 0.35 }] });
  const r = applyRegionBox(base, 1.234, NEW);
  ok(boxEq(staticBox(r), NEW), "无关键帧：静态框被搬到目标位置", fmt(staticBox(r)));
  ok(r.keyframes === undefined, "无关键帧：**不**凭空生出 keyframes 字段");
  // 目标框同时被放大（0.20→0.25 宽、0.10→0.15 高），所以笔迹不是平移而是**仿射**：
  // 0.60 + (0.35-0.30)×1.25 = 0.6625，0.20 + (0.35-0.30)×1.5 = 0.275
  ok(r.shape === "brush" && near(r.stroke![0].x, 0.6625) && near(r.stroke![0].y, 0.275, 1e-9),
    "无关键帧：笔迹按仿射映射跟着走（含各轴独立缩放）",
    `${r.stroke![0].x.toFixed(4)},${r.stroke![0].y.toFixed(4)}`);

  // ② 命中已有关键帧 → 覆盖其值，**保留原 tSec**（反复微调不该让它慢慢漂走）
  const anim = m({ keyframes: [kf(0, 0.1), kf(1, 0.3), kf(2, 0.5)] });
  const hit = applyRegionBox(anim, 1 + KF_EPS_SEC * 0.8, NEW);
  const hk = kfsOf(hit);
  ok(hk.length === 3, "命中：关键帧条数不变（是更新不是插入）", String(hk.length));
  ok(hk[1].tSec === 1, "命中：**保留原 tSec**，不改用播放头时间", String(hk[1].tSec));
  ok(boxEq(kfBox(hk[1]), NEW), "命中：该关键帧的框被覆盖成新值", fmt(kfBox(hk[1])));
  ok(boxEq(kfBox(hk[0]), { x: 0.1, y: 0.4, w: 0.2, h: 0.1 }), "命中：相邻关键帧不受影响");

  // ③ 未命中 → 插入，且插在正确的时间位置上
  const ins = applyRegionBox(anim, 1.5, NEW);
  const ik = kfsOf(ins);
  ok(ik.length === 4, "未命中：插入一条", String(ik.length));
  ok(ik[2].tSec === 1.5 && boxEq(kfBox(ik[2]), NEW), "未命中：按时间插在正确的位置",
    ik.map((k) => k.tSec).join("/"));
  ok(ik.every((k, i) => i === 0 || k.tSec >= ik[i - 1].tSec), "未命中：结果仍按时间升序");

  // 动画区域拖动时，静态框与笔迹**不动**（否则等于动了两次：regionShapeAt 还会再映射一遍）
  const animBrush = m({
    shape: "brush", brushSize: 0.08, stroke: [{ x: 0.35, y: 0.35 }],
    keyframes: [kf(0, 0.1), kf(1, 0.3)],
  });
  const ab = applyRegionBox(animBrush, 0.5, NEW);
  ok(boxEq(staticBox(ab), staticBox(animBrush)), "动画区域：静态框不动（≥2 帧时它不参与渲染）");
  ok(near(ab.stroke![0].x, 0.35) && near(ab.stroke![0].y, 0.35),
    "动画区域：笔迹不动（regionShapeAt 会从静态框映射到当帧，这里再动就是动两次）");

  // 负时间夹到 0：播放头不可能为负，但 winIn 相减的调用方可能算出 -0.001
  const neg = applyRegionBox(m({ keyframes: [kf(1, 0.1)] }), -0.5, NEW);
  ok(kfsOf(neg)[0].tSec >= 0, "tSec 夹持到 ≥0", String(kfsOf(neg)[0].tSec));

  // insertKfAt 是**另一条**入口（◇ 按钮直接插，不经 applyRegionBox），
  // 各自 `Math.max(0, tSec)` 就得各自钉一条 —— 变异测试实测过：
  // 只钉 applyRegionBox 那条时，把 insertKfAt 的夹持删掉全场依然绿。
  // 负 tSec 会让 kfExpr 生成 `t<-0.5` 这种永假分支，遮挡在首帧凭空少一段。
  const negIns = insertKfAt(m({ keyframes: [kf(1, 0.1)] }), -0.5, NEW);
  ok(kfsOf(negIns)[0].tSec >= 0, "insertKfAt 的 tSec 同样夹持到 ≥0",
    String(kfsOf(negIns)[0].tSec));
}

// ═══════════════════════════════════════════════════════════
console.log("\n[3] 不变式：kfCount<2 ⟹ 静态框 === 那条关键帧（本条最承重）");
// ═══════════════════════════════════════════════════════════
{
  // 这条不变式的**用户可见含义**：只有 1 条关键帧时，拖动必须看得见。
  // regionBoxAt 在 <2 条时返回静态框，所以若只写进关键帧而不同步静态框，
  // 用户拖完画面纹丝不动 —— 不报错、不崩，就是"拖了没反应"。
  const one = m({ keyframes: [kf(0.5, 0.1)] });
  const r = applyRegionBox(one, 0.5, NEW);
  ok(kfCount(r) === 1, "前提：仍然只有 1 条关键帧");
  ok(boxEq(staticBox(r), NEW), "1 条关键帧：静态框被同步", fmt(staticBox(r)));
  ok(boxEq(kfBox(kfsOf(r)[0]), NEW), "1 条关键帧：关键帧自身也是新值");
  ok(boxEq(regionBoxAt(r, 0.5), NEW),
    "**拖了看得见**：regionBoxAt 在任意 t 都返回新框", fmt(regionBoxAt(r, 0.5)));
  ok(boxEq(regionBoxAt(r, 99), NEW), "**拖了看得见**：远处的 t 同样是新框");

  // 插入到只有 1 条时同理
  const ins1 = insertKfAt(m({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), 2, NEW);
  ok(kfCount(ins1) === 1 && boxEq(staticBox(ins1), NEW) && boxEq(regionBoxAt(ins1, 0), NEW),
    "insertKfAt 落到 1 条时同样同步静态框");

  // 笔迹也要跟着同步，否则 1 条关键帧的画笔区域会「框在这、笔迹在那」
  const oneBrush = m({
    shape: "brush", brushSize: 0.08, stroke: [{ x: 0.35, y: 0.35 }],
    keyframes: [kf(0.5, 0.30, 0.30, 0.20, 0.10)],
  });
  const rb = applyRegionBox(oneBrush, 0.5, NEW);
  const shp = regionShapeAt(rb, 0.5);
  ok(shp.kind === "brush"
    && shp.stroke[0].x >= NEW.x - 1e-9 && shp.stroke[0].x <= NEW.x + NEW.w + 1e-9
    && shp.stroke[0].y >= NEW.y - 1e-9 && shp.stroke[0].y <= NEW.y + NEW.h + 1e-9,
    "1 条关键帧 + 画笔：笔迹仍落在框内",
    shp.kind === "brush" ? `${shp.stroke[0].x.toFixed(4)},${shp.stroke[0].y.toFixed(4)}` : shp.kind);

  // 遍历式的不变式检查：一串编辑之后随时都得成立
  let cur = m({});
  const ops: Array<[string, () => MosaicParams]> = [
    ["插入 t=0", () => insertKfAt(cur, 0, staticBox(cur))],
    ["拖到 t=0.4", () => applyRegionBox(cur, 0.4, { x: 0.5, y: 0.5, w: 0.2, h: 0.1 })],
    ["拖到 t=0.8", () => applyRegionBox(cur, 0.8, { x: 0.7, y: 0.2, w: 0.2, h: 0.1 })],
    ["删 t=0.4", () => removeKfAt(cur, 0.4)],
    ["删 t=0.8", () => removeKfAt(cur, 0.8)],
    ["删 t=0", () => removeKfAt(cur, 0)],
  ];
  let held = true;
  for (const [label, f] of ops) {
    cur = f();
    const n = kfCount(cur);
    if (n === 1 && !boxEq(staticBox(cur), kfBox(kfsOf(cur)[0]))) { held = false; console.log(`     ↳ ${label} 破坏了不变式`); }
    // 不变式的用户可见面：<2 条时渲染出来的必须就是那条关键帧的值
    if (n === 1 && !boxEq(regionBoxAt(cur, 0.4), kfBox(kfsOf(cur)[0]))) { held = false; console.log(`     ↳ ${label} 渲染值与关键帧不符`); }
  }
  ok(held, "6 步连续编辑（插入→拖→拖→删→删→删）全程维持不变式");
  ok(kfCount(cur) === 0 && cur.keyframes === undefined, "删空后 keyframes 字段被移除，不留空数组");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[4] removeKfAt / clearKfs");
// ═══════════════════════════════════════════════════════════
{
  const a = m({ keyframes: [kf(0, 0.1), kf(1, 0.3), kf(2, 0.5)] });
  const r = removeKfAt(a, 1);
  ok(kfCount(r) === 2, "删中间一条", String(kfCount(r)));
  ok(kfsOf(r).map((k) => k.tSec).join(",") === "0,2", "删掉的正是播放头那条",
    kfsOf(r).map((k) => k.tSec).join(","));
  ok(removeKfAt(a, 1.5) === a, "未命中：原样返回同一个对象（不产生无谓的重渲染）");

  // 删到 1 条：静态框必须同步成幸存的那条，否则区域会瞬间飞回做动画之前的老位置
  const two = m({ x: 0.30, y: 0.30, w: 0.20, h: 0.10, keyframes: [kf(0, 0.1), kf(1, 0.7)] });
  const one = removeKfAt(two, 0);
  ok(kfCount(one) === 1, "前提：删到只剩 1 条");
  ok(boxEq(staticBox(one), kfBox(kf(1, 0.7))),
    "删到 1 条：静态框同步成**幸存的那条**（否则遮挡当场飞走）", fmt(staticBox(one)));
  ok(boxEq(regionBoxAt(one, 0), kfBox(kf(1, 0.7))), "删到 1 条：渲染出来的就是幸存那条");

  const zero = removeKfAt(one, 1);
  ok(zero.keyframes === undefined, "删到 0 条：字段被删除");
  ok(boxEq(staticBox(zero), kfBox(kf(1, 0.7))), "删到 0 条：静态框保持（不变式已保证它是对的）");

  const cleared = clearKfs(a);
  ok(cleared.keyframes === undefined && boxEq(staticBox(cleared), staticBox(a)),
    "clearKfs：清空关键帧、静态框不动");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[5] retimeKf：夹持与「拖动的那条赢」");
// ═══════════════════════════════════════════════════════════
{
  const a = m({ keyframes: [kf(0, 0.1), kf(1, 0.3), kf(2, 0.5)] });
  const r = retimeKf(a, 1, 1.7, 5);
  ok(kfsOf(r).map((k) => k.tSec).join(",") === "0,1.7,2", "改时刻并重新排序",
    kfsOf(r).map((k) => k.tSec).join(","));
  ok(near(kfsOf(r)[1].x, 0.3), "改时刻不改框的值");

  // 越过邻居 → 顺序真的换了（不是"数字变了但数组还是老顺序"）
  const cross = retimeKf(a, 1, 2.5, 5);
  ok(kfsOf(cross).map((k) => k.x.toFixed(1)).join(",") === "0.1,0.5,0.3",
    "拖过邻居后顺序真的交换（按值查，不是按下标）",
    kfsOf(cross).map((k) => k.x.toFixed(1)).join(","));

  ok(kfsOf(retimeKf(a, 1, -3, 5))[0].tSec === 0, "夹持到 ≥0");
  ok(kfsOf(retimeKf(a, 1, 99, 5)).slice(-1)[0].tSec === 5, "夹持到 ≤durSec",
    String(kfsOf(retimeKf(a, 1, 99, 5)).slice(-1)[0].tSec));
  ok(kfsOf(retimeKf(a, 1, 99, 0)).slice(-1)[0].tSec === 99, "durSec≤0 时不夹上界（时长未知）");
  ok(retimeKf(a, 7, 1, 5) === a, "下标越界：原样返回");

  // 撞车：拖到另一条头上 → 合并成一条，且**留下的是被拖动的那条**（后写的赢）
  const hitOn = retimeKf(a, 1, 2, 5);
  ok(kfCount(hitOn) === 2, "拖到同刻：合并成 2 条", String(kfCount(hitOn)));
  ok(near(kfsOf(hitOn)[1].x, 0.3),
    "拖到同刻：**留下的是被拖动的那条**（x=0.3 而非 0.5）", kfsOf(hitOn)[1].x.toFixed(4));

  // 撞车后只剩 1 条 → 不变式仍要成立
  const two = m({ x: 0.9, y: 0.9, w: 0.05, h: 0.05, keyframes: [kf(0, 0.1), kf(1, 0.7)] });
  const merged = retimeKf(two, 0, 1, 5);
  ok(kfCount(merged) === 1 && boxEq(staticBox(merged), kfBox(kfsOf(merged)[0])),
    "撞车后只剩 1 条：静态框同步（不变式）", fmt(staticBox(merged)));
  ok(near(kfsOf(merged)[0].x, 0.1), "撞车后剩下的是被拖动的那条", kfsOf(merged)[0].x.toFixed(4));
}

// ═══════════════════════════════════════════════════════════
console.log("\n[6] 变速重算：钉语义，不钉「数字乘了个数」");
// ═══════════════════════════════════════════════════════════
{
  const a = m({ keyframes: [kf(0, 0.1), kf(1, 0.3), kf(2, 0.5)] });

  // 语义：1× → 2× 之后，**原来 t 秒看到的框，现在应该在 t/2 秒看到**。
  // 直接断言 `tSec*0.5` 是装饰性的（把 factor 写反同样能过其中一半用例），
  // 所以这里从 regionBoxAt 反查曲线本身。
  const fast = rescaleKfTimes(a, 1 / 2);
  let curveOk = true, worst = 0;
  for (let t = 0; t <= 2.0001; t += 0.02) {
    const before = regionBoxAt(a, t);
    const after = regionBoxAt(fast, t / 2);
    worst = Math.max(worst, Math.abs(before.x - after.x));
    if (!boxEq(before, after, 1e-9)) curveOk = false;
  }
  ok(curveOk, "1×→2×：旧 t 处的框 === 新 t/2 处的框（逐点，101 个采样）",
    `最大偏差 ${worst.toExponential(1)}`);

  // 反证：把 factor 写反（新/旧 而非 旧/新）必须让上面那条红
  const wrong = rescaleKfTimes(a, 2);
  ok(!boxEq(regionBoxAt(a, 1), regionBoxAt(wrong, 0.5), 1e-9),
    "反证：factor 写反时上面那条必然失败（断言是承重的）");

  ok(rescaleKfTimes(a, 1) === a, "factor=1：原样返回");
  const empty = m({});
  ok(rescaleKfTimes(empty, 0.5) === empty, "无关键帧：原样返回同一个对象");
  ok(rescaleKfTimes(a, 0) === a && rescaleKfTimes(a, NaN) === a, "非法 factor：原样返回，不产生 NaN 时刻");

  // 批量：只有带关键帧的区域被算进 changed
  const list: MosaicParams[] = [m({}), a, m({ keyframes: [kf(3, 0.2)] })];
  const res = rescaleMosaicsForSpeed(list, 1, 2);
  ok(res.changed === 2, "rescaleMosaicsForSpeed：只统计**有关键帧**的区域", String(res.changed));
  ok(res.mosaics[0] === list[0], "无关键帧的区域对象原样保留（不制造假变更）");
  ok(near(kfsOf(res.mosaics[1])[1].tSec, 0.5), "2× 后 t=1 的关键帧落到 0.5",
    String(kfsOf(res.mosaics[1])[1].tSec));
  ok(near(kfsOf(res.mosaics[2])[0].tSec, 1.5), "单关键帧区域也被重算（UI 上它同样会被 seek 到）");

  const none = rescaleMosaicsForSpeed([m({}), m({})], 1, 2);
  ok(none.changed === 0 && none.mosaics[0] !== undefined, "全无关键帧：changed=0，调用方据此不 toast");
  ok(rescaleMosaicsForSpeed(undefined, 1, 2).changed === 0, "undefined 列表安全");
  ok(rescaleMosaicsForSpeed(list, 2, 2).changed === 0, "速度未变：changed=0");

  // 0.5× → 2×（不是从 1× 出发）：factor 必须是 0.5/2 = 0.25
  const q = rescaleMosaicsForSpeed([a], 0.5, 2);
  ok(near(kfsOf(q.mosaics[0])[2].tSec, 0.5),
    "0.5×→2×：factor = 旧/新 = 0.25（t=2 → 0.5）", String(kfsOf(q.mosaics[0])[2].tSec));

  // outputSec / shotSecOf：面板与画面共用的播放头换算
  ok(near(outputSec(2, 2), 1), "outputSec：2× 下镜内 2s = 输出 1s", String(outputSec(2, 2)));
  ok(near(outputSec(2, undefined), 2), "outputSec：speed 缺省视为 1×");
  ok(near(outputSec(2, 0.5), 4), "outputSec：0.5× 下镜内 2s = 输出 4s");
  ok(near(outputSec(-1, 1), 0), "outputSec：负值夹到 0（winIn 相减可能算出 -0.001）");
  ok(near(outputSec(2, 99), outputSec(2, 4)) && near(outputSec(2, 0.01), outputSec(2, 0.25)),
    "outputSec：speed 按 0.25..4 夹持，与 Player 的 playbackRate 同口径");
  // 往返必须闭合 —— 面板"点时间条跳播放头"走的是 shotSecOf，
  // 跳完之后播放头回来又要过 outputSec，两次换算对不上就会"点 1.0s 停在 0.9s"
  let round = true;
  for (const sp of [0.25, 0.5, 1, 1.5, 2, 4]) {
    for (const t of [0, 0.37, 1.25, 9.9]) {
      if (!near(outputSec(shotSecOf(t, sp), sp), t, 1e-12)) round = false;
    }
  }
  ok(round, "outputSec ∘ shotSecOf 往返闭合（6 档速度 × 4 个时刻）");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[7] trajectory");
// ═══════════════════════════════════════════════════════════
{
  const a = m({ keyframes: [kf(2, 0.5), kf(0, 0.1)] });   // 刻意乱序
  const tr = trajectory(a);
  ok(tr.length === 2, "每条关键帧一个点");
  ok(near(tr[0].x, 0.2) && near(tr[0].y, 0.45), "取的是**中心**点（x+w/2, y+h/2）",
    `${tr[0].x.toFixed(3)},${tr[0].y.toFixed(3)}`);
  ok(tr[0].x < tr[1].x, "按时间升序（输入乱序也一样）");
  ok(trajectory(m({})).length === 0, "无关键帧：空数组");
  ok(kfsOf(a).length === normalizeKfs(a.keyframes).length, "kfsOf 就是 normalizeKfs，没有第二套归一化");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[8] 端到端：动画区域的当帧蒙版 === 等价静态区域的蒙版");
// ═══════════════════════════════════════════════════════════
{
  // 这一节把「预览与导出共用 regionShapeAt」这件事在**真正的光栅化器**上收口：
  // 若哪天有人在组件里抄一份插值、或在光栅化器里再内联一份仿射映射，
  // 两条路各自看都自洽，只有这种"同一形状必须得到同一蒙版"的钉子会红。
  const canvas = { w: 640, h: 360 };
  const group = { box: { x: 0, y: 0, w: 640, h: 360 }, regionIdxs: [0] };
  const stroke = [{ x: 0.12, y: 0.52 }, { x: 0.20, y: 0.56 }, { x: 0.26, y: 0.50 }];

  const anim = m({
    x: 0.10, y: 0.50, w: 0.20, h: 0.10,
    shape: "brush", brushSize: 0.06, stroke,
    keyframes: [kf(0, 0.10, 0.50, 0.20, 0.10), kf(2, 0.60, 0.20, 0.20, 0.10)],
  });
  const T = 1.0;
  const at = regionBoxAt(anim, T);
  ok(near(at.x, 0.35) && near(at.y, 0.35), "前提：t=1 插值到框中点", fmt(at));

  // 等价静态区域：框搬到当帧位置，笔迹按同一映射搬过去
  const equiv = m({
    ...at, shape: "brush", brushSize: 0.06,
    stroke: remapStroke(stroke, { x: 0.10, y: 0.50, w: 0.20, h: 0.10 }, at),
  });

  const A = rasterGroupMask([anim], group, canvas, T);
  const B = rasterGroupMask([equiv], group, canvas, 0);
  let diff = 0;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) diff++;
  const cover = A.reduce((n, v) => n + (v > 127 ? 1 : 0), 0);
  ok(cover > 200, "前提：当帧蒙版确实画出了东西（不是全 0 的空转断言）", `${cover} px`);
  ok(diff === 0, "动画区域 t=1 的蒙版与等价静态区域**逐像素相同**", `差异 ${diff} px`);

  // 反证：换个时刻必须不同 —— 否则上面那条对着两张全空/全同的图也会绿
  const C = rasterGroupMask([anim], group, canvas, 2);
  let diff2 = 0;
  for (let i = 0; i < A.length; i++) if (A[i] !== C[i]) diff2++;
  ok(diff2 > 200, "反证：t=2 的蒙版与 t=1 明显不同（蒙版真的在动）", `差异 ${diff2} px`);

  // 无关键帧的老数据：任何 t 都必须给出同一张蒙版（零回归的实证）
  const stat = m({ x: 0.10, y: 0.50, w: 0.20, h: 0.10, shape: "brush", brushSize: 0.06, stroke });
  const S0 = rasterGroupMask([stat], group, canvas, 0);
  const S9 = rasterGroupMask([stat], group, canvas, 9.5);
  let diff3 = 0;
  for (let i = 0; i < S0.length; i++) if (S0[i] !== S9[i]) diff3++;
  ok(diff3 === 0, "老数据（无关键帧）：t 变化不影响蒙版，逐像素零回归");
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败");
process.exit(fail === 0 ? 0 : 1);
