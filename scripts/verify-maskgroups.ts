/**
 * verify-maskgroups —— 区域分组策略（5.3）验证
 * 跑法：npx tsx scripts/verify-maskgroups.ts
 *
 * 这个脚本要证的是五件承重的事：
 *
 *   1. **§5.3.1 的零回归条款成立** —— 「矩形 + 无羽化 + 无关键帧」的既有数据
 *      必须落进**唯一一个** legacy 组、索引严格是 0..n-1。只要这条成立，
 *      5.4 的编译器照旧逐个编译，导出字节就不可能变。
 *   2. **偶数对齐不是仪式** —— 第 9 节用真 ffmpeg 实测：yuv420p 下 `crop` 会把
 *      奇数 x **静默**对齐到 x-1（yuv444p 则不会）。蒙版是 gray 不参与对齐，
 *      于是奇数 x = 整体错位 1px，不报错、不崩、只是遮挡歪了。
 *   3. **合成顺序不被分组打乱** —— 分组把「按下标叠加」改成「按组叠加」，
 *      两个不同组的区域若在像素上相交且先后被颠倒，画面就变了。
 *      第 8 节正反各一例。
 *   4. **聚类阈值真的在两侧都起作用** —— 聚集必合、分散必不合、跨 style 永不合，
 *      并在 K 的两侧各钉一个 1% 之差的用例。
 *   5. **关键帧的时间并集是紧确的** —— 不是"保守放大到画布"糊弄过去。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  planMaskGroups, legacyEligible, featherPxOf, alignBox, timeUnionBox,
  boxesOverlap, isAnimated, isNoOpRegion, effectKey, CLUSTER_K, FULL_FRAME_RATIO,
} from "../src/render/maskGroups";
import type { MaskGroup } from "../src/render/maskGroups";
import type { MosaicParams, RegionKeyframe } from "../src/render/model";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};

const CW = 1080, CH = 1920;
const CANVAS = { w: CW, h: CH };
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

function m(p: Partial<MosaicParams>): MosaicParams {
  return { x: .3, y: .3, w: .1, h: .06, style: "pixel", intensity: 50, ...p } as MosaicParams;
}
const idxsOf = (gs: MaskGroup[]) => gs.flatMap((g) => g.regionIdxs);
const masksOf = (gs: MaskGroup[]) =>
  gs.filter((g): g is Extract<MaskGroup, { kind: "mask" }> => g.kind === "mask");

console.log("\n══ 5.3 区域分组策略（render/maskGroups）══\n");

// ───────────────────────────────────────────────────────────
console.log("[1] 基本契约");
{
  ok(planMaskGroups([], CANVAS).length === 0, "空输入 → 空分组（编译器一条链都不加）");

  const gs = planMaskGroups([m({}), m({ shape: "brush", stroke: [] }), m({ x: .6 })], CANVAS);
  ok(gs.length === 1 && gs[0].kind === "legacy", "空笔迹 brush 不打断 legacy 连续段");
  ok(JSON.stringify(idxsOf(gs)) === "[0,2]",
     "空笔迹 brush 被整条丢弃（今天它什么都不画，明天也不许凭空画出满框）", `${idxsOf(gs)}`);
  ok(isNoOpRegion(m({ shape: "brush", stroke: [] })) &&
     !isNoOpRegion(m({ shape: "brush", stroke: [{ x: .5, y: .5 }] })), "isNoOpRegion 只认空笔迹");

  // 索引完整性：非丢弃的区域必须**不重不漏**地出现一次，且组内递增
  const mixed = [
    m({}), m({ shape: "ellipse" }), m({ x: .7, shape: "brush", stroke: [{ x: .72, y: .32 }] }),
    m({ x: .1, feather: 20 }), m({ shape: "brush", stroke: [] }), m({ x: .5 }),
  ];
  const gm = planMaskGroups(mixed, CANVAS);
  const seen = idxsOf(gm).slice().sort((a, b) => a - b);
  const want = mixed.map((_, i) => i).filter((i) => !isNoOpRegion(mixed[i]));
  ok(JSON.stringify(seen) === JSON.stringify(want), "所有区域不重不漏各出现一次",
     `${seen} vs ${want}`);
  ok(gm.every((g) => g.regionIdxs.every((v, i, a) => i === 0 || a[i - 1] < v)),
     "每组内部索引严格递增（组内叠放顺序就是原顺序）");
}

// ───────────────────────────────────────────────────────────
console.log("\n[2] §5.3.1 零回归硬条款：老数据必须完全留在现有代码路径上");
{
  // 老数据的形态：没有 shape 字段、没有 feather、没有 keyframes，style 各异
  const legacyData: MosaicParams[] = [
    { x: .1, y: .1, w: .2, h: .1, style: "pixel", intensity: 40 },
    { x: .5, y: .2, w: .2, h: .1, style: "blackbox", intensity: 0 },
    { x: .2, y: .6, w: .3, h: .2, style: "gaussblur", intensity: 70 },
    { x: .6, y: .7, w: .2, h: .1, style: "pixel", intensity: 90 },
    { x: .12, y: .12, w: .2, h: .1, style: "blackbox", intensity: 0 },  // 与 #0 重叠
  ];
  const gs = planMaskGroups(legacyData, CANVAS);
  ok(gs.length === 1, "全部落进**一个**组（不按 style 拆 → 叠放顺序不可能被打乱）", `${gs.length} 组`);
  ok(gs[0].kind === "legacy", "该组是 legacy：不生成蒙版文件、不注册额外 -i 输入");
  ok(JSON.stringify(gs[0].regionIdxs) === "[0,1,2,3,4]", "索引严格 0..n-1，顺序原样",
     `${gs[0].regionIdxs}`);
  ok(masksOf(gs).length === 0, "一条 mask 组都没有（有一条就意味着基线要动）");

  // 混入一个椭圆：椭圆走蒙版，但矩形们**仍旧**分别留在 legacy 段里
  const mixed = [...legacyData];
  mixed.splice(2, 0, m({ x: .8, y: .05, w: .1, h: .06, shape: "ellipse" }));
  const g2 = planMaskGroups(mixed, CANVAS);
  const legacyIdxs = g2.filter((g) => g.kind === "legacy").flatMap((g) => g.regionIdxs);
  ok(JSON.stringify(legacyIdxs) === "[0,1,3,4,5]",
     "新能力只把**自己**这一条挪走，其余矩形照旧 legacy", `${legacyIdxs}`);
  ok(masksOf(g2).length === 1 && masksOf(g2)[0].regionIdxs.join() === "2",
     "椭圆单独成一个 mask 组");
  ok(g2.map((g) => Math.min(...g.regionIdxs)).every((v, i, a) => i === 0 || a[i - 1] < v),
     "组的发射顺序按最小索引升序 —— 与既有叠放顺序同向");
}

// ───────────────────────────────────────────────────────────
console.log("\n[3] legacy 判定表（表驱动）");
{
  const KF2: RegionKeyframe[] = [
    { tSec: 0, x: .3, y: .3, w: .1, h: .06 },
    { tSec: 2, x: .5, y: .4, w: .1, h: .06 },
  ];
  const TABLE: { label: string; p: Partial<MosaicParams>; want: boolean }[] = [
    { label: "老数据（无 shape 字段）", p: {}, want: true },
    { label: "显式 rect", p: { shape: "rect" }, want: true },
    { label: "rect + feather=0", p: { shape: "rect", feather: 0 }, want: true },
    { label: "rect + feather=12", p: { shape: "rect", feather: 12 }, want: false },
    { label: "rect + 关键帧 ×2", p: { keyframes: KF2 }, want: false },
    { label: "rect + 关键帧 ×1（不算动画）", p: { keyframes: [KF2[0]] }, want: true },
    { label: "rect + 关键帧 ×0", p: { keyframes: [] }, want: true },
    { label: "ellipse", p: { shape: "ellipse" }, want: false },
    { label: "brush（有笔迹）", p: { shape: "brush", stroke: [{ x: .5, y: .5 }] }, want: false },
  ];
  for (const t of TABLE) {
    ok(legacyEligible(m(t.p)) === t.want, `${t.label} → legacy=${t.want}`);
  }
  ok(isAnimated(m({ keyframes: KF2 })) && !isAnimated(m({ keyframes: [KF2[0]] })),
     "isAnimated：≥2 条才算动画（1 条没有第二个端点可插值）");
}

// ───────────────────────────────────────────────────────────
console.log("\n[4] 整数框：偶数对齐、向外扩、夹进画布");
{
  // 刻意挑会落在奇数像素上的比例：0.1009*1080 = 108.97
  const gs = masksOf(planMaskGroups([m({ x: .1009, y: .2003, w: .1007, h: .0601, shape: "ellipse" })], CANVAS));
  const b = gs[0].box;
  ok(b.x % 2 === 0 && b.y % 2 === 0 && b.w % 2 === 0 && b.h % 2 === 0,
     "x/y/w/h 全部偶数", `${b.w}×${b.h} @(${b.x},${b.y})`);
  ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= CW && b.y + b.h <= CH, "框完全落在画布内");
  const rx = .1009 * CW, ry = .2003 * CH, rw = .1007 * CW, rh = .0601 * CH;
  ok(b.x <= rx && b.y <= ry && b.x + b.w >= rx + rw && b.y + b.h >= ry + rh,
     "一律**向外**扩：宁可多遮 1px，也不能少遮",
     `原始 ${rw.toFixed(1)}×${rh.toFixed(1)} @(${rx.toFixed(1)},${ry.toFixed(1)})`);

  // ⚠️ 上面这一条**单点**测不出 `round` 与 `floor/ceil` 的差别：`evenDown` 会把 ±1
  //    一起吞掉，只有当 floor(v) 恰为奇数、而 round(v)=floor(v)+1 为偶数时才分道扬镳
  //    （如 x=109.7：floor→108 ✅ 向外；round→110 ❌ 向内，少遮 1.7px）。
  //    故改用**扫描**：亚像素偏移扫一整个周期，每一格都必须完全包住原始框。
  {
    let worstIn = 0, worstAt = "";
    for (let i = 0; i < 40; i++) {
      const rawX = 100 + i * 0.1, rawY = 200 + i * 0.1;   // 步长 0.1px，覆盖 4px 相位
      const rw2 = 53.3, rh2 = 47.7;                        // 奇数附近的非整宽高
      const a = alignBox({ x: rawX, y: rawY, w: rw2, h: rh2 }, CANVAS);
      const inset = Math.max(
        a.x - rawX, a.y - rawY,
        (rawX + rw2) - (a.x + a.w), (rawY + rh2) - (a.y + a.h),
      );
      if (inset > worstIn) { worstIn = inset; worstAt = `x=${rawX.toFixed(1)}`; }
    }
    ok(worstIn <= 0,
       "亚像素相位扫描 40 格：对齐后的框**从不**向内收（`round` 会在此变红）",
       worstIn > 0 ? `最坏内缩 ${worstIn.toFixed(2)}px @${worstAt}` : "最坏内缩 0px");
  }

  // 极小 / 出画 / 贴边
  const tiny = masksOf(planMaskGroups([m({ x: .5, y: .5, w: .0001, h: .0001, shape: "ellipse" })], CANVAS))[0].box;
  ok(tiny.w >= 2 && tiny.h >= 2, "极小区域兜到 2×2（crop 宽高为 0 会直接报错）", `${tiny.w}×${tiny.h}`);
  const out = masksOf(planMaskGroups([m({ x: 1.4, y: 1.4, w: .2, h: .2, shape: "ellipse" })], CANVAS))[0].box;
  ok(out.x + out.w <= CW && out.y + out.h <= CH && out.w >= 2 && out.h >= 2,
     "整体出画的区域仍产出合法框（夹到边上，不返回负坐标）", `${out.w}×${out.h} @(${out.x},${out.y})`);
  const edge = masksOf(planMaskGroups([m({ x: .95, y: .96, w: .2, h: .2, shape: "ellipse" })], CANVAS))[0].box;
  ok(edge.x + edge.w === CW && edge.y + edge.h === CH, "贴右下边的区域正好顶到画布边界",
     `${edge.x}+${edge.w} / ${edge.y}+${edge.h}`);

  // 奇数画布：不能因为夹持就吐出奇数宽
  const oddCanvas = alignBox({ x: 0, y: 0, w: 999, h: 555 }, { w: 999, h: 555 });
  ok(oddCanvas.w % 2 === 0 && oddCanvas.h % 2 === 0 &&
     oddCanvas.w <= 999 && oddCanvas.h <= 555,
     "画布本身是奇数尺寸时，框仍取偶且不越界", `${oddCanvas.w}×${oddCanvas.h}`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[5] 羽化：包围盒必须**预先外扩**，否则软边没地方渲染");
{
  const base = m({ shape: "ellipse", x: .3, y: .3, w: .2, h: .1 });
  const hard = masksOf(planMaskGroups([base], CANVAS))[0].box;
  const soft = masksOf(planMaskGroups([{ ...base, feather: 25 }], CANVAS))[0].box;

  // feather=25 → 短边 min(0.2*1080, 0.1*1920) = 192 → 25% = 48px
  const fp = featherPxOf({ ...base, feather: 25 }, CANVAS);
  ok(Math.abs(fp - 48) < 1e-6, "featherPxOf = 短边百分比（只有这一处做换算）", `${fp}px`);
  ok(soft.w >= hard.w + 2 * fp - 2 && soft.h >= hard.h + 2 * fp - 2,
     "羽化框比硬边框每侧宽出约 featherPx", `${hard.w}×${hard.h} → ${soft.w}×${soft.h}`);
  ok(soft.x <= hard.x - fp + 2 && soft.y <= hard.y - fp + 2, "左上角也真的往外让了");
  ok(featherPxOf(base, CANVAS) === 0 && featherPxOf({ ...base, feather: -5 }, CANVAS) === 0,
     "feather 缺省 / 负值 → 0px（不平白外扩）");
  ok(featherPxOf({ ...base, feather: 999 }, CANVAS) === featherPxOf({ ...base, feather: 100 }, CANVAS),
     "feather 夹持在 0..100");
  ok(!legacyEligible({ ...base, shape: "rect", feather: 1 }),
     "**矩形一旦开羽化就不再是 legacy** —— 否则软边没有蒙版可依附");
}

// ───────────────────────────────────────────────────────────
console.log("\n[6] 关键帧：框取整段时间的并集，且是紧确的");
{
  const kfs: RegionKeyframe[] = [
    { tSec: 0, x: .10, y: .20, w: .10, h: .10 },
    { tSec: 1, x: .40, y: .10, w: .20, h: .05 },
    { tSec: 3, x: .25, y: .50, w: .10, h: .10 },
  ];
  const u = timeUnionBox(m({ keyframes: kfs }));
  ok(Math.abs(u.x - .10) < 1e-9 && Math.abs(u.y - .10) < 1e-9 &&
     Math.abs(u.w - .50) < 1e-9 && Math.abs(u.h - .50) < 1e-9,
     "并集 = 逐关键帧取 min(x)/min(y)/max(x+w)/max(y+h)",
     `x=${u.x} y=${u.y} w=${u.w} h=${u.h}`);

  // 逐 t 线性插值（端点夹持为常量）—— 这是 5.5 `interpolateRegion` 将要实现的语义，
  // 这里写一份参考实现，用来**证明**上面那个 min/max 公式确实覆盖所有中间帧。
  const lerpAt = (t: number) => {
    if (t <= kfs[0].tSec) return kfs[0];
    if (t >= kfs[kfs.length - 1].tSec) return kfs[kfs.length - 1];
    let i = 0;
    while (i + 1 < kfs.length && kfs[i + 1].tSec < t) i++;
    const a = kfs[i], b = kfs[i + 1];
    const k = (t - a.tSec) / (b.tSec - a.tSec);
    return {
      x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k,
      w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k,
    };
  };
  let outside = 0;
  let maxR = -Infinity, maxB = -Infinity, minL = Infinity, minT = Infinity;
  // 稠密采样负责"不越界"，另把关键帧时刻本身也采进来负责"够紧" ——
  // 极值只可能出现在端点上（分段线性），稠密网格未必正好踩中 t=1。
  const times = [...Array.from({ length: 401 }, (_, s) => -0.5 + s * 4.5 / 400),
                 ...kfs.map((k) => k.tSec)];
  for (const t of times) {
    const f = lerpAt(t);
    if (f.x < u.x - 1e-9 || f.y < u.y - 1e-9 ||
        f.x + f.w > u.x + u.w + 1e-9 || f.y + f.h > u.y + u.h + 1e-9) outside++;
    minL = Math.min(minL, f.x); minT = Math.min(minT, f.y);
    maxR = Math.max(maxR, f.x + f.w); maxB = Math.max(maxB, f.y + f.h);
  }
  ok(outside === 0, "404 个采样时刻的框全部落在并集内（含端点外的夹持段）");
  ok(Math.abs(minL - u.x) < 1e-6 && Math.abs(minT - u.y) < 1e-6 &&
     Math.abs(maxR - (u.x + u.w)) < 1e-6 && Math.abs(maxB - (u.y + u.h)) < 1e-6,
     "四条边都被某个时刻**触到** —— 是紧确并集，不是保守放大");

  // 动画区域的分组框用的是并集而非静态框
  const anim = m({ x: .10, y: .20, w: .10, h: .10, keyframes: kfs, shape: "rect" });
  const box = masksOf(planMaskGroups([anim], CANVAS))[0].box;
  ok(box.w >= .5 * CW && box.h >= .5 * CH, "动画区域的 crop 框覆盖整段轨迹（w/h 不能动画）",
     `${box.w}×${box.h}`);
  const stat = masksOf(planMaskGroups([{ ...anim, keyframes: [kfs[0]] }], CANVAS));
  ok(stat.length === 0, "只有 1 条关键帧时按静态处理 → 回到 legacy，不生成蒙版");
}

// ───────────────────────────────────────────────────────────
console.log("\n[7] 空间聚类");
{
  const row = (n: number, style: MosaicParams["style"] = "pixel") =>
    Array.from({ length: n }, (_, i) => m({ x: .30 + .02 * i, y: .40, w: .08, h: .045, style, shape: "ellipse" }));
  const clustered = planMaskGroups(row(5), CANVAS);
  ok(clustered.length === 1 && clustered[0].kind === "mask",
     "5 个**聚集**区域并成一条链（实测 28.1× vs 逐区域 15.1×）", `${clustered.length} 组`);
  ok(masksOf(clustered)[0].regionIdxs.join() === "0,1,2,3,4", "并集组含全部 5 个索引");

  const spread = [
    m({ x: .02, y: .02, w: .08, h: .045, shape: "ellipse" }),
    m({ x: .85, y: .02, w: .08, h: .045, shape: "ellipse" }),
    m({ x: .02, y: .90, w: .08, h: .045, shape: "ellipse" }),
    m({ x: .85, y: .90, w: .08, h: .045, shape: "ellipse" }),
    m({ x: .45, y: .45, w: .08, h: .045, shape: "ellipse" }),
  ];
  ok(planMaskGroups(spread, CANVAS).length === 5,
     "5 个**分散**区域各走各的（并集 9.44× 是全表最差点）",
     `${planMaskGroups(spread, CANVAS).length} 组`);

  // 跨 style 永不合并：同样紧挨着，但一个 pixel 一个 gaussblur
  const twoStyles = [
    m({ x: .30, y: .40, w: .08, h: .045, style: "pixel", shape: "ellipse" }),
    m({ x: .32, y: .40, w: .08, h: .045, style: "gaussblur", shape: "ellipse" }),
  ];
  const ts = planMaskGroups(twoStyles, CANVAS);
  ok(ts.length === 2, "紧挨着但 style 不同 → 绝不合并（一条链只能施加一种效果）");
  ok(ts.every((g) => g.kind === "mask") &&
     masksOf(ts).map((g) => g.style).join() === "pixel,gaussblur", "各组保留自己的 style");

  // 同 style 但 intensity 不同：一条链上只有一个 blockSize / 一个 sigma，绝不能并
  const twoIntensity = [
    m({ x: .30, y: .40, w: .08, h: .045, style: "pixel", intensity: 90, shape: "ellipse" }),
    m({ x: .32, y: .40, w: .08, h: .045, style: "pixel", intensity: 20, shape: "ellipse" }),
  ];
  ok(planMaskGroups(twoIntensity, CANVAS).length === 2,
     "紧挨着、同 style 但 **intensity 不同** → 不合并（否则用户调的强度被悄悄丢一个）");
  ok(planMaskGroups(twoIntensity.map((r) => ({ ...r, intensity: 90 })), CANVAS).length === 1,
     "把 intensity 调成一样 → 立刻并成 1 组（可见上一条是 intensity 判出来的）");

  // blackbox 忽略 intensity（model.ts 的字段定义），故不该因它拆链
  const blackboxes = [
    m({ x: .30, y: .40, w: .08, h: .045, style: "blackbox", intensity: 0, shape: "ellipse" }),
    m({ x: .32, y: .40, w: .08, h: .045, style: "blackbox", intensity: 77, shape: "ellipse" }),
  ];
  ok(planMaskGroups(blackboxes, CANVAS).length === 1,
     "blackbox 的 intensity 本就被忽略 → 仍可合并");
  ok(effectKey(m({ style: "blackbox", intensity: 1 })) === effectKey(m({ style: "blackbox", intensity: 99 })) &&
     effectKey(m({ style: "pixel", intensity: 1 })) !== effectKey(m({ style: "pixel", intensity: 2 })),
     "effectKey：blackbox 不带 intensity，其余带");

  // 组不变式：任何 mask 组的成员必须共用同一个 effectKey
  const zoo = [
    ...twoIntensity, ...blackboxes,
    m({ x: .34, y: .40, w: .08, h: .045, style: "gaussblur", intensity: 60, shape: "ellipse" }),
    m({ x: .36, y: .40, w: .08, h: .045, style: "gaussblur", intensity: 60, shape: "brush",
        stroke: [{ x: .38, y: .42 }] }),
  ];
  const zooGroups = masksOf(planMaskGroups(zoo, CANVAS));
  ok(zooGroups.length > 0 && zooGroups.every((g) =>
       new Set(g.regionIdxs.map((i) => effectKey(zoo[i]))).size === 1),
     "组不变式：每个 mask 组的成员共用同一个 effectKey（5.4 取首个成员的参数即可）",
     `${zooGroups.length} 组`);
  ok(zooGroups.some((g) => g.regionIdxs.length > 1),
     "且这批里确实发生了合并 —— 不是因为全都单独成组才碰巧成立");

  // K 的两侧：并集/分离比 1.49 与 1.51，只差 1%
  const pair = (dx: number) => [
    m({ x: 0, y: .4, w: .1, h: .1, shape: "ellipse" }),
    m({ x: dx, y: .4, w: .1, h: .1, shape: "ellipse" }),
  ];
  const A = .1 * CW;                                   // 108px 宽
  const below = (1.49 * 2 - 1) * A / CW;               // 并集/分离 = 1.49
  const above = (1.51 * 2 - 1) * A / CW;               // = 1.51
  ok(planMaskGroups(pair(below), CANVAS).length === 1, `比值 1.49 < K=${CLUSTER_K} → 合并`);
  ok(planMaskGroups(pair(above), CANVAS).length === 2, `比值 1.51 > K=${CLUSTER_K} → 不合并`);

  // 确定性：同一份输入永远给同一个分组（导出参数要可复现）
  const once = JSON.stringify(planMaskGroups(row(5), CANVAS));
  ok(once === JSON.stringify(planMaskGroups(row(5), CANVAS)), "同输入 → 同分组（贪心但确定）");
}

// ───────────────────────────────────────────────────────────
console.log("\n[8] 合成顺序不被分组打乱");
{
  // 0 与 2 是同 style 且紧挨（本该合并），但 1 是另一种 style 且**压在 2 上**。
  // 合并 0+2 会把 1 挪到 2 之后 → 画面变了，必须拒绝合并。
  const overlapping = [
    m({ x: .30, y: .40, w: .08, h: .045, style: "pixel", shape: "ellipse" }),
    m({ x: .33, y: .41, w: .08, h: .045, style: "gaussblur", shape: "ellipse" }),
    m({ x: .34, y: .40, w: .08, h: .045, style: "pixel", shape: "ellipse" }),
  ];
  const g1 = planMaskGroups(overlapping, CANVAS);
  ok(g1.length === 3, "中间那条与后一条相交 → 拒绝跨过它合并（保住叠放顺序）", `${g1.length} 组`);

  // 对照：把中间那条挪到不相交的地方，同样的 0/2 就**应该**合并 ——
  // 证明第一例不是"一律拒绝"。
  const disjoint = [...overlapping];
  disjoint[1] = m({ x: .33, y: .70, w: .08, h: .045, style: "gaussblur", shape: "ellipse" });
  const g2 = planMaskGroups(disjoint, CANVAS);
  ok(g2.length === 2, "中间那条不相交 → 0 与 2 照常合并", `${g2.length} 组`);
  ok(masksOf(g2).some((g) => g.regionIdxs.join() === "0,2"), "合并组的索引是 0,2");

  ok(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 }) &&
     !boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }),
     "boxesOverlap：真相交才算，边贴边不算");
}

// ───────────────────────────────────────────────────────────
console.log("\n[9] 全画幅退化");
{
  const big = masksOf(planMaskGroups([m({ x: .05, y: .05, w: .9, h: .9, shape: "ellipse" })], CANVAS))[0];
  ok(big.fullFrame && big.box.x === 0 && big.box.y === 0 &&
     big.box.w === CW && big.box.h === CH,
     `框超过画布 ${FULL_FRAME_RATIO * 100}% → 退化为整幅（crop 成 no-op）`,
     `${big.box.w}×${big.box.h}`);

  const mid = masksOf(planMaskGroups([m({ x: .1, y: .1, w: .8, h: .8, shape: "ellipse" })], CANVAS))[0];
  ok(!mid.fullFrame && mid.box.w < CW, "0.64 画布的框不退化（还没到最差点）",
     `${mid.box.w}×${mid.box.h} = ${(mid.box.w * mid.box.h / (CW * CH) * 100).toFixed(0)}%`);
  ok(masksOf(planMaskGroups([m({ x: .3, y: .3, w: .1, h: .06, shape: "ellipse" })], CANVAS))[0].fullFrame === false,
     "小区域当然不是整幅");
}

// ───────────────────────────────────────────────────────────
console.log("\n[10] 真 ffmpeg：证明「偶数对齐」不是仪式");
{
  const dir = mkdtempSync(join(tmpdir(), "fw-grp-"));
  try {
    /** 横向渐变（每列一个可分辨的灰度），裁一小块后读左上角像素 */
    const probe = (fmt: string, filter: string, vertical = false) => {
      const src = vertical
        ? "gradients=s=64x16:c0=black:c1=white:x0=0:y0=0:x1=0:y1=15:d=0.1:r=1"
        : "gradients=s=64x16:c0=black:c1=white:x0=0:y0=0:x1=63:y1=0:d=0.1:r=1";
      const f = join(dir, `p${Math.random().toString(36).slice(2)}.gray`);
      execFileSync(FFMPEG, [
        "-v", "error", "-y", "-f", "lavfi", "-i", src,
        "-vf", `format=${fmt},${filter}`, "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "gray", f,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const d = readFileSync(f);
      return { first: d[0], bytes: d.length };
    };

    const x4 = probe("yuv420p", "crop=8:8:4:0");
    const x5 = probe("yuv420p", "crop=8:8:5:0");
    ok(x5.first === x4.first,
       "yuv420p：`crop` 把奇数 x **静默**对齐到 x-1（不报错、不崩）",
       `x=5 取到的是 x=4 那一列（${x5.first}）`);

    const x5_444 = probe("yuv444p", "crop=8:8:5:0");
    ok(x5_444.first !== x4.first,
       "yuv444p 则老实用 x=5 —— 说明对齐量取决于**运行时 pix_fmt**，TS 侧猜不到",
       `${x5_444.first} vs ${x4.first}`);

    const y2 = probe("yuv420p", "crop=8:8:0:2", true);
    const y3 = probe("yuv420p", "crop=8:8:0:3", true);
    ok(y3.first === y2.first, "y 方向同理：奇数 y 被对齐到 y-1", `${y3.first}`);

    ok(probe("yuv420p", "crop=9:8:0:0").bytes === 8 * 8,
       "奇数宽也被向下对齐（crop=9 实际出 8）", `${probe("yuv420p", "crop=9:8:0:0").bytes} 字节`);

    // 结论：alignBox 产出的框在 yuv420p 下**逐像素**被原样接受
    const b = alignBox({ x: 5, y: 3, w: 9, h: 7 }, { w: 64, h: 16 });
    const got = probe("yuv420p", `crop=${b.w}:${b.h}:${b.x}:${b.y}`);
    const ref = probe("yuv420p", `crop=${b.w}:${b.h}:${b.x}:${b.y}`);
    ok(got.bytes === b.w * b.h && got.first === ref.first,
       "alignBox 的框喂给 crop 后尺寸一字不差（蒙版按同一组整数光栅化才能对上）",
       `crop=${b.w}:${b.h}:${b.x}:${b.y} → ${got.bytes} 字节`);
    // 反证：若不对齐，同一个框写成奇数 x 就会取到另一列
    const odd = probe("yuv420p", `crop=${b.w}:${b.h}:${b.x + 1}:${b.y}`);
    ok(odd.first === got.first,
       "把 x 写成奇数 → ffmpeg 悄悄退回偶数列，蒙版却按奇数光栅化 = 整体错位 1px",
       `x=${b.x + 1} 实际取到 x=${b.x}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ───────────────────────────────────────────────────────────
console.log("\n[11] 自检：先证明上面的检查是承重的");
{
  // (a) 零回归检查承重：模拟「legacy 也按 style 分组」这个错误实现，
  //     它会把 [pixel, blackbox, pixel] 重排成 [0,2],[1] —— 索引断言必红。
  const data = [m({ style: "pixel" }), m({ x: .5, style: "blackbox" }), m({ x: .7, style: "pixel" })];
  const byStyle = new Map<string, number[]>();
  data.forEach((r, i) => byStyle.set(r.style, [...(byStyle.get(r.style) ?? []), i]));
  const wrongOrder = [...byStyle.values()].flat();
  ok(JSON.stringify(wrongOrder) !== "[0,1,2]",
     "若给 legacy 组加上 style 维度，索引顺序确实会乱 —— 第 2 节那条断言不是摆设",
     `会变成 ${wrongOrder}`);
  ok(JSON.stringify(idxsOf(planMaskGroups(data, CANVAS))) === "[0,1,2]", "现有实现不乱");

  // (b) 偶对齐检查承重：喂一个奇数框给 alignBox 之外的路径，断言会红
  const raw = { x: 5, y: 7, w: 9, h: 11 };
  ok(raw.x % 2 !== 0 && alignBox(raw, CANVAS).x % 2 === 0,
     "未对齐的原始框确实是奇数，alignBox 才是把它掰正的那一步");

  // (c) 聚类阈值检查承重：在 K 附近连续挪动，分组数必须**恰好**翻转一次
  const pair = (dx: number) => [
    m({ x: 0, y: .4, w: .1, h: .1, shape: "ellipse" }),
    m({ x: dx, y: .4, w: .1, h: .1, shape: "ellipse" }),
  ];
  const counts: number[] = [];
  for (let r = 1.2; r <= 1.8; r += 0.05) counts.push(planMaskGroups(pair((2 * r - 1) * .1), CANVAS).length);
  const flips = counts.filter((v, i) => i > 0 && v !== counts[i - 1]).length;
  ok(flips === 1 && counts[0] === 1 && counts[counts.length - 1] === 2,
     "比值从 1.2 扫到 1.8，分组数恰好从 1 翻到 2 一次（阈值是真的在起作用）",
     `${counts.join("")}`);

  // (d) 顺序安全检查承重：把第 8 节那个相交的中间区域换成同 style，
  //     它就该被一起并进来（说明"3 组"不是因为别的原因）
  const same = [
    m({ x: .30, y: .40, w: .08, h: .045, style: "pixel", shape: "ellipse" }),
    m({ x: .33, y: .41, w: .08, h: .045, style: "pixel", shape: "ellipse" }),
    m({ x: .34, y: .40, w: .08, h: .045, style: "pixel", shape: "ellipse" }),
  ];
  ok(planMaskGroups(same, CANVAS).length === 1,
     "同一批区域改成同 style → 并成 1 组，可见第 8 节的 3 组是**顺序**判出来的");

  // (e) 索引完整性检查承重：人为漏掉一个，检查器必须发现
  const gs = planMaskGroups(data, CANVAS);
  const broken = gs.map((g) => ({ ...g, regionIdxs: g.regionIdxs.slice(1) }));
  ok(JSON.stringify(idxsOf(broken as MaskGroup[])) !== "[0,1,2]", "抹掉一个索引 → 完整性断言会红");

  // (f) intensity 分组承重：模拟「只按 style 分组」这个计划书字面写法，
  //     它会把 intensity 90 与 20 并进同一条链 —— 一条链只有一个 blockSize，
  //     其中一个用户设定必然被悄悄丢掉。这是首轮全绿后复查出来的真缺陷。
  const mixed = [
    m({ x: .30, y: .40, w: .08, h: .045, style: "pixel", intensity: 90, shape: "ellipse" }),
    m({ x: .32, y: .40, w: .08, h: .045, style: "pixel", intensity: 20, shape: "ellipse" }),
  ];
  const byStyleOnly = new Set(mixed.map((r) => r.style)).size;   // 只按 style 分 → 1 组
  ok(byStyleOnly === 1 && planMaskGroups(mixed, CANVAS).length === 2,
     "只按 style 分会并成 1 组（丢掉一个 intensity），现有实现给 2 组 —— 第 7 节那条断言承重",
     `按 style ${byStyleOnly} 组 vs 实际 ${planMaskGroups(mixed, CANVAS).length} 组`);

  // (g) 向外扩检查承重：手算 `round` 在 x=109.7 处会给出 110（向内 0.3px），
  //     而 floor→evenDown 给 108。第 4 节那条**扫描**断言就是冲着这个相位来的；
  //     它的单点版本（x=108.97）对此完全无感 —— 是变异测试逼出来的。
  const phaseRound = Math.floor(Math.round(109.7) / 2) * 2;   // = 110，越过了原始左边
  const phaseFloor = Math.floor(Math.floor(109.7) / 2) * 2;   // = 108，仍在左边外侧
  ok(phaseRound > 109.7 && phaseFloor <= 109.7 && alignBox({ x: 109.7, y: 0, w: 4, h: 4 }, CANVAS).x === phaseFloor,
     "x=109.7：round 会内缩到 110（少遮），现有实现取 108 —— 扫描断言承重",
     `round→${phaseRound} / 实现→${alignBox({ x: 109.7, y: 0, w: 4, h: 4 }, CANVAS).x}`);
}

// 收尾：全 legacy 的输入，无论区域多少、style 怎么排，永远只有一个组
{
  let worst = 0;
  for (let n = 1; n <= 12; n++) {
    const rs = Array.from({ length: n }, (_, i) =>
      m({ x: (i % 5) * .18, y: Math.floor(i / 5) * .3, w: .15, h: .12,
          style: (["pixel", "gaussblur", "blackbox"] as const)[i % 3] }));
    worst = Math.max(worst, planMaskGroups(rs, CANVAS).length);
  }
  ok(worst === 1, "1~12 个矩形老区域、三种 style 交错 → 始终恰好 1 个 legacy 组", `最多 ${worst} 组`);
}

console.log(`\n区域分组策略：${pass} ✅ / ${fail} ❌`);
process.exit(fail ? 1 : 0);
