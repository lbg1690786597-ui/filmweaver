/**
 * verify-regionshape —— 形状描述层（5.1）验证
 * 跑法：npx tsx scripts/verify-regionshape.ts
 *
 * 这个脚本要证的不是"函数返回了个数"，而是三件承重的事：
 *
 *   1. 预览与导出**用的是同一份几何** —— `strokeBounds` / SVG 的笔刷半径
 *      与编译器 geq 表达式里的半径，必须由同一个 `brushRadii` 推出来。
 *   2. 那条 Y 半径 bug **确实被修掉了，且不会被悄悄改回去** ——
 *      钉住 `rRelY = (bs/2)/m.h * (canvasW/canvasH)`，并显式断言它**不等于**
 *      老式子 `rRel*(m.w/m.h)`（画布非正方时）。
 *   3. `coversPoint` 与**真的交给 ffmpeg 的那串表达式**同义 ——
 *      不是"另写一份差不多的判断"，而是把 `compileMosaicFilters` 吐出来的字符串
 *      **解析回谓词**，再在网格上逐点比对。
 *
 * 最后有一节自检：先把比对器喂错数据，确认它会红。不会红的比对器不算断言。
 */

import { compileMosaicFilters } from "../src/render/ffmpegCompiler";
import {
  regionShapeOf, brushRadii, brushRadiiInBox, strokeBounds,
  decimateStroke, coversPoint, MIN_REGION_SIZE, BRUSH_MAX_PTS, DEFAULT_BRUSH_SIZE,
} from "../src/lib/regionShape";
import type { RegionShape, Pt } from "../src/lib/regionShape";
import type { MosaicParams } from "../src/render/model";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const CW = 1080, CH = 1920;
const ASPECT = CW / CH;

function mosaic(p: Partial<MosaicParams>): MosaicParams {
  return {
    x: 0.3, y: 0.3, w: 0.4, h: 0.4,
    style: "blackbox", intensity: 50, ...p,
  } as MosaicParams;
}

console.log("\n══ 5.1 形状描述层（lib/regionShape）══\n");

// ───────────────────────────────────────────────────────────
console.log("[1] regionShapeOf：持久态 → 形状描述");

ok(regionShapeOf(mosaic({})).kind === "rect",
   "老数据没有 shape 字段 → 当矩形（与编译器的 m.shape ?? \"rect\" 同义）");
ok(regionShapeOf(mosaic({ shape: "rect" })).kind === "rect", "shape=rect → rect");
ok(regionShapeOf(mosaic({ shape: "ellipse" })).kind === "ellipse", "shape=ellipse → ellipse");
ok(regionShapeOf(mosaic({ shape: "brush", stroke: [{ x: .5, y: .5 }] })).kind === "brush",
   "shape=brush 且有笔迹 → brush");
ok(regionShapeOf(mosaic({ shape: "brush", stroke: [] })).kind === "rect",
   "shape=brush 但笔迹为空 → 降为 rect（编译器对空笔迹本就整区跳过）");
ok(regionShapeOf(mosaic({ shape: "brush" })).kind === "rect",
   "shape=brush 但根本没有 stroke 字段 → 降为 rect");
{
  const rs = regionShapeOf(mosaic({ shape: "brush", stroke: [{ x: .5, y: .5 }] }));
  ok(rs.kind === "brush" && rs.brushSize === DEFAULT_BRUSH_SIZE,
     "没有 brushSize 的老数据用缺省值", `${DEFAULT_BRUSH_SIZE}`);
  const rs2 = regionShapeOf(mosaic({ shape: "brush", stroke: [{ x: .5, y: .5 }], brushSize: 0.2 }));
  ok(rs2.kind === "brush" && rs2.brushSize === 0.2, "有 brushSize 就用它");
  const box = regionShapeOf(mosaic({ x: .1, y: .2, w: .3, h: .4 })).box;
  ok(box.x === .1 && box.y === .2 && box.w === .3 && box.h === .4, "包围盒原样带出");
}

// ───────────────────────────────────────────────────────────
console.log("\n[2] brushRadii：笔刷在**像素**上必须是圆的");

for (const [w, h, label] of [[1080, 1920, "竖屏 9:16"], [1920, 1080, "横屏 16:9"],
                             [1024, 1024, "正方"], [720, 1280, "竖屏小"]] as const) {
  const { rx, ry } = brushRadii(0.1, w / h);
  ok(near(rx * w, ry * h, 1e-9),
     `${label}：x/y 像素半径相等`, `${(rx * w).toFixed(2)}px vs ${(ry * h).toFixed(2)}px`);
}
{
  const { rx, ry } = brushRadii(0.1, 1);
  ok(near(rx, ry), "正方画布下两个方向的归一化半径相同（换算不应凭空引入差异）");
  ok(near(brushRadii(0.1, ASPECT).rx, 0.05), "rx 就是 brushSize/2（相对画面宽）");
}

// 包围盒归一化
for (const [bw, bh] of [[0.4, 0.4], [0.2, 0.6], [0.9, 0.1]] as const) {
  const box = { x: 0.05, y: 0.05, w: bw, h: bh };
  const { rx, ry } = brushRadiiInBox(box, 0.1, ASPECT);
  const boxWpx = bw * CW, boxHpx = bh * CH;
  ok(near(rx * boxWpx, ry * boxHpx, 1e-6),
     `盒 ${bw}×${bh}：盒内像素半径也相等`,
     `${(rx * boxWpx).toFixed(2)}px vs ${(ry * boxHpx).toFixed(2)}px`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[3] 钉住那条 bug 的修法（回退就红）");
{
  const box = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
  const bs = 0.1;
  const { rx, ry } = brushRadiiInBox(box, bs, ASPECT);

  const correct = (bs / 2) / box.h * ASPECT;
  const oldWrong = rx * (box.w / box.h);          // 改动前的式子

  ok(near(ry, correct, 1e-12), "rRelY = (bs/2)/m.h * (canvasW/canvasH)", ry.toFixed(6));
  ok(!near(ry, oldWrong, 1e-6),
     "且**不等于**老式子 rRel*(m.w/m.h)（画布非正方时必须不同）",
     `新 ${ry.toFixed(4)} vs 老 ${oldWrong.toFixed(4)}`);
  ok(near(oldWrong / ry, CH / CW, 1e-6),
     "老式子偏大的倍数正好是画布宽高比 —— 与实测 109×193px 的拉长量吻合",
     `${(oldWrong / ry).toFixed(3)}×`);

  // 正方画布下新旧式子必须一致：说明这次改的是"漏了的那一项"，不是换了套算法
  const sq = brushRadiiInBox(box, bs, 1);
  ok(near(sq.ry, sq.rx * (box.w / box.h), 1e-12),
     "正方画布下新旧式子等价（改的是漏项，不是换算法）");
}

// ───────────────────────────────────────────────────────────
console.log("\n[4] strokeBounds：行为与搬家前逐字一致");
{
  // 搬家前的实现（原 MosaicOverlay.tsx:64），照抄用于对拍
  const oldImpl = (stroke: Pt[], brushSize: number, aspect: number) => {
    const r = brushSize / 2, ry = r * aspect;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of stroke) {
      x0 = Math.min(x0, p.x - r); y0 = Math.min(y0, p.y - ry);
      x1 = Math.max(x1, p.x + r); y1 = Math.max(y1, p.y + ry);
    }
    const cl = (v: number) => Math.max(0, Math.min(1, v));
    x0 = cl(x0); y0 = cl(y0); x1 = cl(x1); y1 = cl(y1);
    return { x: x0, y: y0, w: Math.max(x1 - x0, 0.02), h: Math.max(y1 - y0, 0.02) };
  };
  const CASES: { s: Pt[]; bs: number; label: string }[] = [
    { s: [{ x: .5, y: .5 }], bs: .1, label: "单点" },
    { s: [{ x: .2, y: .3 }, { x: .8, y: .7 }], bs: .08, label: "两点斜线" },
    { s: [{ x: .01, y: .01 }], bs: .2, label: "贴左上角（要被夹持到 0）" },
    { s: [{ x: .99, y: .99 }], bs: .2, label: "贴右下角（要被夹持到 1）" },
    { s: [{ x: .5, y: .5 }], bs: .001, label: "笔刷极小（撞 MIN_REGION_SIZE 下限）" },
  ];
  for (const c of CASES) {
    const a = strokeBounds(c.s, c.bs, ASPECT), b = oldImpl(c.s, c.bs, ASPECT);
    ok(near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h),
       `${c.label}：与旧实现相同`,
       `x=${a.x.toFixed(4)} y=${a.y.toFixed(4)} w=${a.w.toFixed(4)} h=${a.h.toFixed(4)}`);
  }
  const tiny = strokeBounds([{ x: .5, y: .5 }], 0.0001, ASPECT);
  ok(tiny.w >= MIN_REGION_SIZE && tiny.h >= MIN_REGION_SIZE,
     "包围盒不会退化到 0（否则 crop 拿到 0 宽高会直接报错）",
     `${tiny.w} × ${tiny.h}`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[5] decimateStroke：抽稀不丢末端");
{
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i / n, y: 0.5 }));
  for (const n of [1, 5, 60, 61, 200, 1000]) {
    const s = mk(n);
    const d = decimateStroke(s);
    const lastKept = d[d.length - 1];
    ok(d.length <= BRUSH_MAX_PTS + 1 && lastKept.x === s[n - 1].x,
       `${n} 点 → ${d.length} 点，末点保留`, `末点 x=${lastKept.x.toFixed(4)}`);
  }
  ok(decimateStroke(mk(30)).length === 30, "不超上限时一点不抽");
}

// ───────────────────────────────────────────────────────────
console.log("\n[6] coversPoint 与**真交给 ffmpeg 的表达式**同义");

/** 从编译产物里拿出 geq 的 alpha 表达式 */
function alphaExprOf(m: MosaicParams): string {
  const parts = compileMosaicFilters("[in]", "[out]", [m], 0, 0, CW, CH);
  const line = parts.find((p) => p.includes("geq="));
  if (!line) throw new Error("没找到 geq —— 这个用例走的不是蒙版分支");
  const mt = /:a='([^']*)'/.exec(line);
  if (!mt) throw new Error("geq 里没有 alpha 表达式");
  return mt[1];
}

const TERM_RE = /lte\(pow\(\(X\/W-(-?[\d.]+)\)\/([\d.]+)\\,2\)\+pow\(\(Y\/H-(-?[\d.]+)\)\/([\d.]+)\\,2\)\\,1\)/g;

/** 把表达式解析回谓词。解析的是 ffmpeg 真正会看到的那串字符。 */
function predicateFromExpr(expr: string): { pred: (u: number, v: number) => boolean; terms: number } {
  const ts: { cx: number; rx: number; cy: number; ry: number }[] = [];
  TERM_RE.lastIndex = 0;
  let mt: RegExpExecArray | null;
  while ((mt = TERM_RE.exec(expr)) !== null) {
    ts.push({ cx: +mt[1], rx: +mt[2], cy: +mt[3], ry: +mt[4] });
  }
  return {
    terms: ts.length,
    pred: (u, v) => ts.some((t) => {
      const dx = (u - t.cx) / t.rx, dy = (v - t.cy) / t.ry;
      return dx * dx + dy * dy <= 1;
    }),
  };
}

/** 到最近一个圆边界的"归一化距离"，用来识别 4 位小数取整会翻转的那条细带 */
function boundaryQ(shape: RegionShape, u: number, v: number): number {
  if (shape.kind !== "brush") return Infinity;
  const { rx, ry } = brushRadiiInBox(shape.box, shape.brushSize, ASPECT);
  let best = Infinity;
  for (const p of decimateStroke(shape.stroke)) {
    const cx = (p.x - shape.box.x) / shape.box.w;
    const cy = (p.y - shape.box.y) / shape.box.h;
    const dx = (u - cx) / rx, dy = (v - cy) / ry;
    best = Math.min(best, Math.abs(dx * dx + dy * dy - 1));
  }
  return best;
}

const GRID = 60;
function gridCompare(
  shape: RegionShape, pred: (u: number, v: number) => boolean,
): { mismatch: number; band: number; total: number } {
  let mismatch = 0, band = 0, total = 0;
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      const u = i / GRID, v = j / GRID;
      total++;
      // 4 位小数取整只可能在边界一条细带上翻转，那一带不计入
      if (boundaryQ(shape, u, v) < 0.02) { band++; continue; }
      if (coversPoint(shape, u, v, ASPECT) !== pred(u, v)) mismatch++;
    }
  }
  return { mismatch, band, total };
}

const BRUSH_CASES: { label: string; m: MosaicParams }[] = [
  { label: "单点", m: mosaic({ shape: "brush", brushSize: .1, stroke: [{ x: .5, y: .5 }] }) },
  { label: "三点折线", m: mosaic({ shape: "brush", brushSize: .06,
      stroke: [{ x: .35, y: .35 }, { x: .5, y: .5 }, { x: .62, y: .4 }] }) },
  { label: "扁盒（w≫h，最能暴露宽高比算错）", m: mosaic({
      x: .05, y: .45, w: .9, h: .1, shape: "brush", brushSize: .05,
      stroke: [{ x: .2, y: .5 }, { x: .8, y: .5 }] }) },
  { label: "300 点（触发抽稀）", m: mosaic({ shape: "brush", brushSize: .05,
      stroke: Array.from({ length: 300 }, (_, i) => ({ x: .32 + .36 * i / 299, y: .5 })) }) },
];

for (const c of BRUSH_CASES) {
  const expr = alphaExprOf(c.m);
  const { pred, terms } = predicateFromExpr(expr);
  const shape = regionShapeOf(c.m);
  const expectTerms = decimateStroke((c.m.stroke ?? [])).length;
  ok(terms === expectTerms && terms > 0,
     `${c.label}：表达式里的圆项数 = 抽稀后点数`, `${terms} 项`);
  const r = gridCompare(shape, pred);
  ok(r.mismatch === 0,
     `${c.label}：${r.total} 个网格点上 coversPoint 与表达式一致`,
     `边界带跳过 ${r.band} 点`);
  ok(r.band < r.total * 0.25,
     `${c.label}：跳过的边界带够薄（不是靠"全跳过"蒙混）`,
     `${(r.band / r.total * 100).toFixed(1)}%`);
}

// 椭圆：表达式是定式，直接钉字符串 + 网格对拍
{
  const m = mosaic({ shape: "ellipse" });
  const expr = alphaExprOf(m);
  ok(expr === `if(lte(pow((X-W/2)/(W/2)\\,2)+pow((Y-H/2)/(H/2)\\,2)\\,1)\\,255\\,0)`,
     "椭圆的 alpha 表达式与预期逐字相同");
  const shape = regionShapeOf(m);
  let bad = 0;
  for (let i = 0; i <= GRID; i++) for (let j = 0; j <= GRID; j++) {
    const u = i / GRID, v = j / GRID;
    const dx = (u - .5) / .5, dy = (v - .5) / .5;
    const q = dx * dx + dy * dy;
    if (Math.abs(q - 1) < 0.02) continue;
    if (coversPoint(shape, u, v, ASPECT) !== (q <= 1)) bad++;
  }
  ok(bad === 0, "椭圆：coversPoint 与内切椭圆方程一致");
  ok(coversPoint(shape, .5, .5, ASPECT) && !coversPoint(shape, .02, .02, ASPECT),
     "椭圆：中心在内、角落在外");
}

// 矩形：不该走 geq
{
  const parts = compileMosaicFilters("[in]", "[out]", [mosaic({ shape: "rect" })], 0, 0, CW, CH);
  ok(!parts.some((p) => p.includes("geq=")),
     "矩形不生成 geq（§5.3.1 零回归：矩形必须留在既有快路径上）");
  const parts2 = compileMosaicFilters("[in]", "[out]",
    [mosaic({ shape: "brush", stroke: [] })], 0, 0, CW, CH);
  // 5.4 修正：这里原本断言 `parts2.length === 0`（"整区跳过、一条滤镜都不产"）。
  // 那个期望本身就是 bug：调用方在 `mosaics.length > 0` 时已经先发了
  // `[i:v]{chain}[vc_i]`，然后**指望**本函数产出 `[v_i]`。一条都不产 ⇒ `[v_i]`
  // 无人定义，ffmpeg 直接报 `Output with label 'v0' does not exist in any defined
  // filter graph`，**整段导出失败**（verify-maskcompile 的 [7] 用真 ffmpeg 正反两证）。
  // 现在改为发一条 `null` 直通：效果仍是"什么都不遮"，但标签链是完整的。
  ok(parts2.length === 1 && parts2[0] === "[in]null[out]",
     "空笔迹整区跳过，但仍用 null 直通接出 outLabel（否则标签断链、整段导出失败）",
     JSON.stringify(parts2));
}

// ───────────────────────────────────────────────────────────
console.log("\n[7] 自检：先证明上面的比对器是承重的");
{
  const c = BRUSH_CASES[2];               // 扁盒，宽高比算错时差异最大
  const shape = regionShapeOf(c.m);
  const expr = alphaExprOf(c.m);

  // (a) 把老式子（错的 Y 半径）塞进谓词 → 网格比对必须红
  const box = shape.kind === "brush" ? shape.box : { x: 0, y: 0, w: 1, h: 1 };
  const rxOld = (0.05 / 2) / box.w;
  const ryOld = rxOld * (box.w / box.h);          // 改动前的算法
  const strokeOld = shape.kind === "brush" ? decimateStroke(shape.stroke) : [];
  const predOld = (u: number, v: number) => strokeOld.some((p) => {
    const dx = (u - (p.x - box.x) / box.w) / rxOld;
    const dy = (v - (p.y - box.y) / box.h) / ryOld;
    return dx * dx + dy * dy <= 1;
  });
  const rOld = gridCompare(shape, predOld);
  ok(rOld.mismatch > 0,
     "喂老式子的谓词 → 网格比对确实报不一致（比对器不是摆设）",
     `${rOld.mismatch} 个点不一致`);

  // (b) 删掉表达式里一项 → 解析出的项数必须跟着变
  const cut = expr.slice(0, expr.lastIndexOf("max("));
  const nFull = predicateFromExpr(expr).terms;
  const nCut = predicateFromExpr(cut).terms;
  ok(nFull > 0 && nCut < nFull,
     "截短表达式 → 解析出的项数严格下降（解析器真的在读字符串）",
     `${nFull} → ${nCut} 项`);

  // (c) 表达式里确实有真数字，不是空壳
  ok(/[\d]\.[\d]{4}/.test(expr), "表达式里带 4 位小数的真实参数");

  // (d) 网格本身不是空跑
  ok(gridCompare(shape, predicateFromExpr(expr).pred).total === (GRID + 1) ** 2,
     "网格点数如实", `${(GRID + 1) ** 2} 点`);
}

console.log(`\n形状描述层：${pass} ✅ / ${fail} ❌`);
process.exit(fail ? 1 : 0);
