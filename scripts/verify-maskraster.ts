/**
 * verify-maskraster —— 蒙版光栅化器（5.2）验证
 * 跑法：npx tsx scripts/verify-maskraster.ts
 *
 * 这个脚本要证的是四件承重的事，不是"函数返回了个数组"：
 *
 *   1. **它在 node 下真的跑得起来** —— 这正是把计划书里的 canvas/PNG 换成纯 TS
 *      的唯一理由。脚本本身能 import 并出结果，就是这条的实证。
 *   2. **笔刷在像素上是圆的** —— 5.1 修的那条 Y 半径 bug 在光栅化侧也不能复发。
 *      自检节里用 `canvasAspect=1` 精确复现老 bug，确认圆度检查会红。
 *   3. **蒙版覆盖 ⊇ geq 覆盖** —— 蒙版路径不抽稀、按胶囊填，只可能比 geq 多覆盖，
 *      绝不能少。少了就是导出会漏遮挡。钉的是包含关系，**不是**逐像素相等
 *      （相等本来就不该成立，见 maskRaster.ts 顶部）。
 *   4. **ffmpeg 真的肯吃这份字节** —— 实跑 `alphamerge`，采样输出像素确认遮挡
 *      落在该落的地方；并**反向**证明尺寸差 4px 时 ffmpeg 会直接失败
 *      （计划书「缺陷 2」那类整段导出崩掉的故障）。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { rasterRegionMask, featherBoxRadius } from "../src/render/maskRaster";
import {
  regionShapeOf, strokeBounds, decimateStroke, coversPoint, brushRadiiInBox,
} from "../src/lib/regionShape";
import type { RegionShape } from "../src/lib/regionShape";
import type { MosaicParams } from "../src/render/model";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};

const CW = 1080, CH = 1920;
const ASPECT = CW / CH;
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

function mosaic(p: Partial<MosaicParams>): MosaicParams {
  return { x: 0.3, y: 0.3, w: 0.4, h: 0.4, style: "blackbox", intensity: 50, ...p } as MosaicParams;
}

/** 覆盖区域（值 255）的像素包围盒，没有覆盖返回 null */
function coveredBBox(m: Uint8Array, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (m[y * w + x] === 255) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const sum = (m: Uint8Array) => m.reduce((a: number, b: number) => a + b, 0);

console.log("\n══ 5.2 蒙版光栅化器（render/maskRaster）══\n");

// ───────────────────────────────────────────────────────────
console.log("[1] 基本契约");
{
  const rect = rasterRegionMask({ kind: "rect", box: { x: .3, y: .3, w: .4, h: .4 } },
                                { w: 64, h: 48 }, 0, ASPECT);
  ok(rect.length === 64 * 48, "输出长度 = w*h（raw gray 每像素 1 字节）", `${rect.length}`);
  ok(rect instanceof Uint8Array, "返回 Uint8Array，可直接写盘喂给 -f rawvideo");
  ok(rect.every((v: number) => v === 255), "矩形无羽化 → 整框 255（全遮挡）");

  const el = rasterRegionMask({ kind: "ellipse", box: { x: 0, y: 0, w: .5, h: .5 } },
                              { w: 200, h: 200 }, 12, ASPECT);
  ok(el.every((v: number) => v >= 0 && v <= 255), "所有值落在 0..255");

  const a = rasterRegionMask({ kind: "ellipse", box: { x: 0, y: 0, w: .5, h: .5 } },
                             { w: 200, h: 200 }, 12, ASPECT);
  ok(Buffer.from(a).equals(Buffer.from(el)), "同输入 → 逐字节相同（确定性，可缓存可复现）");

  // 非整数尺寸不能把 crop 那边的整数约定带歪
  const odd = rasterRegionMask({ kind: "rect", box: { x: 0, y: 0, w: .1, h: .1 } },
                               { w: 33.7, h: 17.2 }, 0, ASPECT);
  ok(odd.length === 33 * 17, "小数尺寸向下取整（尺寸只由调用方那个整数决定）", `${odd.length}`);
  ok(rasterRegionMask({ kind: "rect", box: { x: 0, y: 0, w: .1, h: .1 } },
                      { w: 0, h: 0 }, 0, ASPECT).length === 1, "退化尺寸兜到 1×1，不返回空数组");
}

// ───────────────────────────────────────────────────────────
console.log("\n[2] 椭圆几何");
{
  const W = 240, H = 160;
  const m = rasterRegionMask({ kind: "ellipse", box: { x: .1, y: .1, w: .5, h: .5 } },
                             { w: W, h: H }, 0, ASPECT);
  const area = m.reduce((a: number, v: number) => a + (v === 255 ? 1 : 0), 0);
  const ideal = Math.PI / 4 * W * H;
  ok(Math.abs(area / ideal - 1) < 0.01, "面积 ≈ πab（内切椭圆）",
     `${area} vs ${ideal.toFixed(0)}，差 ${((area / ideal - 1) * 100).toFixed(2)}%`);

  const bb = coveredBBox(m, W, H)!;
  ok(bb.x0 === 0 && bb.y0 === 0 && bb.w === W && bb.h === H,
     "椭圆内切于框：包围盒正好是整个框", `${bb.w}×${bb.h} @(${bb.x0},${bb.y0})`);

  ok(m[(H / 2) * W + W / 2] === 255, "中心被遮挡");
  ok(m[0] === 0 && m[W - 1] === 0 && m[(H - 1) * W] === 0 && m[H * W - 1] === 0,
     "四个角都不被遮挡");

  // 左右 / 上下对称：非对称的光栅化会在动画里表现为抖动
  let asym = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) {
    if (m[y * W + x] !== m[y * W + (W - 1 - x)]) asym++;
    if (m[y * W + x] !== m[(H - 1 - y) * W + x]) asym++;
  }
  ok(asym === 0, "左右、上下均严格对称", `${W * H} 像素零不对称`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[3] 画笔：像素上必须是圆的（5.1 那条 bug 的下游）");
{
  const box = { x: .3, y: .3, w: .4, h: .4 };
  const boxW = Math.round(box.w * CW), boxH = Math.round(box.h * CH);   // 432 × 768
  const shape: RegionShape = { kind: "brush", box, stroke: [{ x: .5, y: .5 }], brushSize: .1 };
  const m = rasterRegionMask(shape, { w: boxW, h: boxH }, 0, ASPECT);
  const bb = coveredBBox(m, boxW, boxH)!;
  ok(Math.abs(bb.w - bb.h) <= 2, "单点笔迹 → 像素上是正圆（宽高之差 ≤2px）",
     `${bb.w} × ${bb.h} px`);
  ok(Math.abs(bb.w - 0.1 * CW) <= 2, "直径 = brushSize × 画面宽", `${bb.w}px vs 期望 108px`);

  // 两点 → 胶囊：中点必须被覆盖（只画两个圆的话中间是断的）
  const far = { x: .35, y: .35 }, far2 = { x: .65, y: .65 };
  const cap: RegionShape = { kind: "brush", box, stroke: [far, far2], brushSize: .02 };
  const mc = rasterRegionMask(cap, { w: boxW, h: boxH }, 0, ASPECT);
  const midU = ((far.x + far2.x) / 2 - box.x) / box.w, midV = ((far.y + far2.y) / 2 - box.y) / box.h;
  const midPx = Math.floor(midV * boxH) * boxW + Math.floor(midU * boxW);
  ok(mc[midPx] === 255, "相距很远的两点之间连成一段（胶囊，不是两个孤立圆点）");
  // 反证：同样两点走 geq 的离散圆并集时，中点是**不**被覆盖的
  ok(!coversPoint(cap, midU, midV, ASPECT),
     "同一组点在 geq 的离散圆模型下中点没被覆盖 —— 差别是真的，不是自说自话");
}

// ───────────────────────────────────────────────────────────
console.log("\n[4] 不抽稀：geq 丢掉的点，蒙版必须还在");
{
  const box = { x: .2, y: .2, w: .6, h: .6 };
  const boxW = Math.round(box.w * CW), boxH = Math.round(box.h * CH);   // 648 × 1152
  const stroke = Array.from({ length: 200 }, (_, i) => ({ x: .3 + .4 * i / 199, y: .5 }));
  stroke[1] = { x: .31, y: .75 };                       // 抽稀步长 4，下标 1 必被丢掉
  const shape: RegionShape = { kind: "brush", box, stroke, brushSize: .02 };

  const kept = decimateStroke(stroke);
  ok(!kept.some((p) => p.y === .75), "该离群点确实被 geq 的抽稀丢掉了",
     `200 点 → ${kept.length} 点`);

  const m = rasterRegionMask(shape, { w: boxW, h: boxH }, 0, ASPECT);
  const u = (.31 - box.x) / box.w, v = (.75 - box.y) / box.h;
  ok(m[Math.floor(v * boxH) * boxW + Math.floor(u * boxW)] === 255,
     "但蒙版把它画了出来（笔迹复杂度无上限）");
  ok(!coversPoint(shape, u, v, ASPECT), "而 geq 谓词在该点为 false —— 这就是升级的收益");
}

// ───────────────────────────────────────────────────────────
console.log("\n[5] 包含关系：geq 覆盖 ⊆ 蒙版覆盖（绝不能少遮）");

/** 到形状边界的归一化距离；用来只取"确凿在内部"的点，避开 1px 取整带 */
function deepInside(shape: RegionShape, u: number, v: number, margin: number): boolean {
  if (shape.kind === "rect") return u >= margin && u <= 1 - margin && v >= margin && v <= 1 - margin;
  if (shape.kind === "ellipse") {
    const dx = (u - .5) / .5, dy = (v - .5) / .5;
    return dx * dx + dy * dy <= (1 - margin) ** 2;
  }
  const { rx, ry } = brushRadiiInBox(shape.box, shape.brushSize, ASPECT);
  return decimateStroke(shape.stroke).some((p) => {
    const dx = (u - (p.x - shape.box.x) / shape.box.w) / rx;
    const dy = (v - (p.y - shape.box.y) / shape.box.h) / ry;
    return dx * dx + dy * dy <= (1 - margin) ** 2;
  });
}

/** 逐像素检查包含关系，返回 (违例数, 被检点数) */
function containment(shape: RegionShape, mask: Uint8Array, w: number, h: number, margin = 0.05) {
  let bad = 0, checked = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x + .5) / w, v = (y + .5) / h;
    if (!deepInside(shape, u, v, margin)) continue;
    checked++;
    if (mask[y * w + x] !== 255) bad++;
  }
  return { bad, checked };
}

const CONTAIN_CASES: { label: string; m: MosaicParams }[] = [
  { label: "矩形", m: mosaic({ shape: "rect" }) },
  { label: "椭圆", m: mosaic({ shape: "ellipse" }) },
  { label: "单点笔迹", m: mosaic({ shape: "brush", brushSize: .1, stroke: [{ x: .5, y: .5 }] }) },
  { label: "三点折线", m: mosaic({ shape: "brush", brushSize: .06,
      stroke: [{ x: .35, y: .35 }, { x: .5, y: .5 }, { x: .62, y: .4 }] }) },
  { label: "扁盒 w≫h", m: mosaic({ x: .05, y: .45, w: .9, h: .1, shape: "brush",
      brushSize: .05, stroke: [{ x: .2, y: .5 }, { x: .8, y: .5 }] }) },
  { label: "300 点（触发抽稀）", m: mosaic({ shape: "brush", brushSize: .05,
      stroke: Array.from({ length: 300 }, (_, i) => ({ x: .32 + .36 * i / 299, y: .5 })) }) },
];

for (const c of CONTAIN_CASES) {
  const shape = regionShapeOf(c.m);
  const bw = Math.round(shape.box.w * CW), bh = Math.round(shape.box.h * CH);
  const mask = rasterRegionMask(shape, { w: bw, h: bh }, 0, ASPECT);
  const r = containment(shape, mask, bw, bh);
  ok(r.bad === 0 && r.checked > 100, `${c.label}：geq 覆盖的点蒙版全都覆盖`,
     `检查 ${r.checked} 点 / ${bw}×${bh}`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[6] 羽化");
{
  const box = { x: .3, y: .3, w: .4, h: .4 };
  const boxW = Math.round(box.w * CW), boxH = Math.round(box.h * CH);
  const shape: RegionShape = { kind: "brush", box, stroke: [{ x: .5, y: .5 }], brushSize: .25 };
  const hard = rasterRegionMask(shape, { w: boxW, h: boxH }, 0, ASPECT);

  ok(hard.every((v: number) => v === 0 || v === 255), "feather=0 → 严格二值，没有中间值");
  ok(featherBoxRadius(0) === 0 && featherBoxRadius(-5) === 0, "featherBoxRadius(0) = 0（不做多余的模糊）");

  const mid = (m: Uint8Array) => m.reduce((a: number, v: number) => a + (v > 0 && v < 255 ? 1 : 0), 0);
  const bands: number[] = [];
  const row = Math.floor(boxH / 2);
  for (const F of [8, 16, 32]) {
    const m = rasterRegionMask(shape, { w: boxW, h: boxH }, F, ASPECT);
    ok(mid(m) > 0, `feather=${F}：出现中间灰度（软边）`, `${mid(m)} 个过渡像素`);

    // 中心行向右扫，量 90%→10% 的过渡带宽
    let x90 = -1, x10 = -1;
    for (let x = Math.floor(boxW / 2); x < boxW; x++) {
      const v = m[row * boxW + x];
      if (x90 < 0 && v < 255 * 0.9) x90 = x;
      if (x10 < 0 && v < 255 * 0.1) { x10 = x; break; }
    }
    bands.push(x10 - x90);

    // 单调：从中心往外不能回升，否则是振铃
    let nonMono = 0;
    for (let x = Math.floor(boxW / 2); x + 1 < boxW; x++) {
      if (m[row * boxW + x + 1] > m[row * boxW + x]) nonMono++;
    }
    ok(nonMono === 0, `feather=${F}：由内向外单调不回升（三次 box blur 无振铃）`);
    ok(m[row * boxW + Math.floor(boxW / 2)] === 255, `feather=${F}：形状中心仍是全遮挡`);
  }
  ok(bands[0] < bands[1] && bands[1] < bands[2],
     "过渡带宽随 featherPx 严格变宽", `${bands.join(" → ")} px`);
  // 窗口收得足够紧，才能钉住"σ = featherPx/2.563"这个换算。
  // 初版把三次 box blur 的方差公式写错（多除了个 3），实测带宽是 6/12/25，
  // 即 0.75×/0.75×/0.78× —— 下界 0.8 正是为了让那种错误必红。
  ok(bands.every((b, i) => {
    const F = [8, 16, 32][i];
    return b >= F * 0.8 && b <= F * 1.4;
  }), "10%→90% 过渡带宽 ≈ featherPx（0.8×~1.4×，小值受 box 半径取整影响偏大）",
     `实测 ${bands.join("/")} vs 请求 8/16/32`);

  // 直接钉闭式解：三次 box blur 总方差 ((2r+1)²−1)/4 应当 ≈ σ² = (F/2.563)²
  for (const F of [16, 40, 100]) {
    const r = featherBoxRadius(F);
    const sigmaEff = Math.sqrt(((2 * r + 1) ** 2 - 1) / 4);
    ok(Math.abs(sigmaEff / (F / 2.563) - 1) < 0.08,
       `featherPx=${F}：r=${r} 对应的等效 σ 与 F/2.563 相符（±8%，差在整数取整上）`,
       `σ_eff=${sigmaEff.toFixed(2)} vs ${(F / 2.563).toFixed(2)}`);
  }

  // 归一化正确性：形状离边界很远时，模糊应当近似保质量
  const soft = rasterRegionMask(shape, { w: boxW, h: boxH }, 16, ASPECT);
  ok(Math.abs(sum(soft) / sum(hard) - 1) < 0.02,
     "羽化前后总量守恒（核归一化正确，没把蒙版整体调暗/调亮）",
     `${(sum(soft) / sum(hard) * 100).toFixed(2)}%`);

  // 零补边：矩形铺满整框时，羽化必须真的在框边产生软边
  const rectSoft = rasterRegionMask({ kind: "rect", box }, { w: 200, h: 200 }, 24, ASPECT);
  ok(rectSoft[100 * 200 + 0] < 200 && rectSoft[100 * 200 + 100] === 255,
     "矩形 + 羽化：框边变软、中心不变（边界按 0 补，不是复制边缘）",
     `边 ${rectSoft[100 * 200]} / 中心 ${rectSoft[100 * 200 + 100]}`);

  ok(featherBoxRadius(4) < featherBoxRadius(20) && featherBoxRadius(20) < featherBoxRadius(60),
     "featherBoxRadius 随羽化宽度单调递增",
     `${featherBoxRadius(4)} < ${featherBoxRadius(20)} < ${featherBoxRadius(60)}`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[7] 性能：整画幅 + 长笔迹也要能在剪辑期同步算完");
{
  const shape: RegionShape = {
    kind: "brush", box: { x: 0, y: 0, w: 1, h: 1 }, brushSize: .05,
    stroke: Array.from({ length: 500 }, (_, i) => ({ x: .1 + .8 * i / 499, y: .5 + .3 * Math.sin(i / 20) })),
  };
  const t0 = Date.now();
  const m = rasterRegionMask(shape, { w: CW, h: CH }, 24, ASPECT);
  const ms = Date.now() - t0;
  ok(sum(m) > 0, "1080×1920 + 500 点 + 羽化：真的画出了东西");
  ok(ms < 3000, "耗时可接受（逐段只扫自己的包围盒，不是每像素遍历全部笔迹点）", `${ms} ms`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[8] 真 ffmpeg：alphamerge 吃得下这份字节");

const dir = mkdtempSync(join(tmpdir(), "fw-mask-"));
try {
  const SW = 320, SH = 240;
  const BX = 60, BY = 40, BW = 200, BH = 160;
  const shape: RegionShape = { kind: "ellipse", box: { x: BX / SW, y: BY / SH, w: BW / SW, h: BH / SH } };

  const run = (args: string[]) => {
    try {
      execFileSync(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
      return { code: 0, err: "" };
    } catch (e: unknown) {
      const x = e as { status?: number; stderr?: string; message?: string };
      return { code: x.status ?? 1, err: String(x.stderr ?? x.message ?? "") };
    }
  };
  /**
   * 计划书「缺陷 4 已结案」定下的统一滤镜图：蒙版与画面**共用同一句 crop 参数**。
   * 注意 `scale=${BW}:${BH}` 是强制项而非优化 —— `pixel` 的两次整除截断会改尺寸，
   * 不补这一句就会撞上下面 ② 那个失败。
   */
  const GRAPH =
    `[0:v]split=2[bg][fg];` +
    `[fg]crop=${BW}:${BH}:${BX}:${BY},drawbox=0:0:iw:ih:color=black@1:t=fill,` +
      `scale=${BW}:${BH},format=yuva420p[p];` +
    `[1:v]format=gray[m];[p][m]alphamerge[pa];[bg][pa]overlay=${BX}:${BY}[o]`;

  // 只有蒙版**输入声明**的尺寸随用例变化，滤镜图一字不动 —— 这样 ② 的失败
  // 只可能来自尺寸不匹配，不会是滤镜图被改坏了。
  const render = (maskFile: string, mw: number, mh: number, outFile: string) => run([
    "-y", "-f", "lavfi", "-i", `color=c=white:s=${SW}x${SH}:d=0.5:r=10`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${mw}x${mh}`, "-i", maskFile,
    "-filter_complex", GRAPH, "-map", "[o]",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", outFile,
  ]);

  // ① 尺寸正确 → 必须成功，且遮挡落在椭圆内
  const hardFile = join(dir, "mask.gray");
  writeFileSync(hardFile, rasterRegionMask(shape, { w: BW, h: BH }, 0, ASPECT));
  const outFile = join(dir, "out.gray");
  const r1 = render(hardFile, BW, BH, outFile);
  ok(r1.code === 0, "蒙版尺寸与 crop 一致 → ffmpeg 退出码 0",
     r1.code === 0 ? "" : r1.err.split("\n").slice(-3).join(" / "));

  if (r1.code === 0) {
    const out = readFileSync(outFile);
    ok(out.length === SW * SH, "输出帧尺寸如实", `${out.length} = ${SW}×${SH}`);
    const at = (x: number, y: number) => out[y * SW + x];
    ok(at(BX + BW / 2, BY + BH / 2) < 16, "椭圆中心被涂黑（蒙版真的起了作用）", `${at(160, 120)}`);
    ok(at(BX + 2, BY + 2) > 240, "框内、椭圆外保持原样（不是整框糊掉）", `${at(62, 42)}`);
    ok(at(5, 5) > 240 && at(SW - 5, SH - 5) > 240, "框外完全没被动到");
  }

  // ② 尺寸差 4px → 必须**失败**。这是计划书「缺陷 2」那一整类故障，
  //    也是"整数只算一次"这条纪律的存在理由；证明它真会炸，纪律才不是空话。
  const badFile = join(dir, "bad.gray");
  writeFileSync(badFile, rasterRegionMask(shape, { w: BW - 4, h: BH - 4 }, 0, ASPECT));
  const r2 = render(badFile, BW - 4, BH - 4, join(dir, "bad-out.gray"));
  ok(r2.code !== 0 && /do not match|Invalid argument/i.test(r2.err),
     "蒙版尺寸差 4px → ffmpeg 直接失败（不是画面错位，是整段导出崩）",
     r2.code !== 0 ? "Input frame sizes do not match" : "竟然成功了？！");

  // ③ 羽化蒙版经 alphamerge 出来的是连续软边，不是二值
  const softFile = join(dir, "soft.gray");
  writeFileSync(softFile, rasterRegionMask(shape, { w: BW, h: BH }, 24, ASPECT));
  const softOut = join(dir, "soft-out.gray");
  const r3 = render(softFile, BW, BH, softOut);
  ok(r3.code === 0, "羽化蒙版同样跑通", r3.code === 0 ? "" : r3.err.split("\n").slice(-2).join(" / "));
  if (r3.code === 0) {
    const out = readFileSync(softOut);
    const rowY = BY + BH / 2;
    const vals = new Set<number>();
    for (let x = BX; x < BX + BW; x++) {
      const v = out[rowY * SW + x];
      if (v > 12 && v < 243) vals.add(v);
    }
    ok(vals.size >= 5, "沿中心行采到多级中间灰 —— 软边是连续过渡，不是二值",
       `${vals.size} 种中间灰度`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────
console.log("\n[9] 自检：先证明上面那些检查是承重的");
{
  // (a) 圆度检查：canvasAspect=1 精确复现 5.1 之前那条 bug（漏乘画布宽高比）
  const box = { x: .3, y: .3, w: .4, h: .4 };
  const boxW = Math.round(box.w * CW), boxH = Math.round(box.h * CH);
  const shape: RegionShape = { kind: "brush", box, stroke: [{ x: .5, y: .5 }], brushSize: .1 };
  const buggy = rasterRegionMask(shape, { w: boxW, h: boxH }, 0, 1);
  const bb = coveredBBox(buggy, boxW, boxH)!;
  ok(Math.abs(bb.h / bb.w - CH / CW) < 0.05,
     "复现老 bug（漏乘画布宽高比）→ 圆变成竖椭圆，圆度检查会红",
     `${bb.w}×${bb.h}，拉长 ${(bb.h / bb.w).toFixed(3)}× vs 画布比 ${(CH / CW).toFixed(3)}`);

  // (b) 包含关系检查：把蒙版换成半径减半的，必须报违例
  const shrunk = rasterRegionMask({ ...shape, brushSize: .05 }, { w: boxW, h: boxH }, 0, ASPECT);
  const bad = containment(shape, shrunk, boxW, boxH);
  ok(bad.bad > 0, "喂一份缩水的蒙版 → 包含关系检查确实报违例（不是摆设）",
     `${bad.bad} / ${bad.checked} 点漏遮`);

  // (c) 对称性检查：人为破坏一格，必须被抓到
  const W = 60, H = 40;
  const el = rasterRegionMask({ kind: "ellipse", box }, { w: W, h: H }, 0, ASPECT);
  el[(H / 2) * W + 1] = el[(H / 2) * W + 1] === 255 ? 0 : 255;
  let asym = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) {
    if (el[y * W + x] !== el[y * W + (W - 1 - x)]) asym++;
  }
  ok(asym > 0, "人为翻转一个像素 → 对称性检查报警", `${asym} 处`);

  // (d) 覆盖为空时 coveredBBox 老实返回 null，不会用"空图"骗过前面的断言
  ok(coveredBBox(new Uint8Array(100), 10, 10) === null, "全 0 蒙版的包围盒是 null（不会静默当成通过）");

  // (e) 前面所有断言都建立在"蒙版非空"上，这里再确认一次三种形状都真有内容
  for (const [label, s] of [
    ["矩形", { kind: "rect", box } as RegionShape],
    ["椭圆", { kind: "ellipse", box } as RegionShape],
    ["画笔", shape],
  ] as const) {
    ok(sum(rasterRegionMask(s, { w: 120, h: 120 }, 0, ASPECT)) > 0, `${label}：蒙版非空`);
  }
}

// 收尾：strokeBounds 仍是包围盒的唯一来源 —— 光栅化器不该自己再算一遍盒子
{
  const stroke = [{ x: .4, y: .4 }, { x: .6, y: .55 }];
  const b = strokeBounds(stroke, .08, ASPECT);
  const shape: RegionShape = { kind: "brush", box: b, stroke, brushSize: .08 };
  const bw = Math.round(b.w * CW), bh = Math.round(b.h * CH);
  const m = rasterRegionMask(shape, { w: bw, h: bh }, 0, ASPECT);
  const bb = coveredBBox(m, bw, bh)!;
  ok(bb.x0 <= 1 && bb.y0 <= 1 && bb.w >= bw - 2 && bb.h >= bh - 2,
     "笔迹正好填满 strokeBounds 算出的盒子（两边用的是同一套半径）",
     `覆盖 ${bb.w}×${bb.h} / 盒 ${bw}×${bh}`);
}

console.log(`\n蒙版光栅化器：${pass} ✅ / ${fail} ❌`);
process.exit(fail ? 1 : 0);
