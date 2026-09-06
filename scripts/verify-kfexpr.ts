/**
 * verify-kfexpr —— 关键帧 → ffmpeg 表达式（5.5）验证
 * 跑法：npx tsx scripts/verify-kfexpr.ts
 *
 * 本条要证的核心只有一句：**表达式与 `regionBoxAt` 是同一条曲线**。
 * "预览按 A 插值、导出按 B 插值"这种分叉不会报错、不会崩，只会让导出的遮挡
 * 比预览晚半拍或偏几十像素，而且没有任何既有断言会自然发现它。
 *
 * 所以第 [3] 节的做法是：把本模块吐出的**字符串解析回一个函数**
 * （求值器是本脚本独立实现的，不 import 产品代码），再与 `regionBoxAt`
 * 在密集网格上逐点比对 —— 与 5.1 「把 geq 解析回谓词」同一套路子。
 * 第 [2] 节先证明求值器本身承重（篡改表达式必须让它给出不同结果）。
 *
 * 第 [4] 节用**真 ffmpeg** 收口：转义、夹持、以及"表达式真的会动"。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { kfExpr, escapeFilterExpr, isPureTranslation, regionExprs } from "../src/render/kfExpr";
import { regionBoxAt, normalizeKfs, timeUnionBox, isAnimated } from "../src/render/maskGroups";
import { DEFAULT_TRANSFORM } from "../src/render/model";
import type { MosaicParams, RegionKeyframe } from "../src/render/model";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const work = mkdtempSync(join(tmpdir(), "kf55-"));
const CW = 1080, CH = 1920;

const m = (p: Partial<MosaicParams>): MosaicParams =>
  ({ x: 0.3, y: 0.3, w: 0.2, h: 0.2, style: "pixel", intensity: 50, ...p });
const kf = (tSec: number, x: number, y = 0.4, w = 0.2, h = 0.1): RegionKeyframe => ({ tSec, x, y, w, h });

// ───────────────────────────────────────────────────────────
// 独立求值器：只认本模块会产出的那个子集。**刻意不 import 产品代码**。
// ───────────────────────────────────────────────────────────
function evalExpr(src: string, env: Record<string, number>): number {
  let i = 0;
  const ws = () => { while (i < src.length && src[i] === " ") i++; };
  const eat = (c: string) => { ws(); if (src[i] !== c) throw new Error(`期望 '${c}' @${i}: ${src.slice(i, i + 20)}`); i++; };

  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      ws();
      if (src[i] === "+") { i++; v += parseTerm(); }
      else if (src[i] === "-") { i++; v -= parseTerm(); }
      else return v;
    }
  }
  function parseTerm(): number {
    let v = parseFactor();
    for (;;) {
      ws();
      if (src[i] === "*") { i++; v *= parseFactor(); }
      else if (src[i] === "/") { i++; v /= parseFactor(); }
      else return v;
    }
  }
  function parseFactor(): number {
    ws();
    if (src[i] === "-") { i++; return -parseFactor(); }
    if (src[i] === "(") { i++; const v = parseExpr(); eat(")"); return v; }
    const num = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
    if (num) { i += num[0].length; return parseFloat(num[0]); }
    const id = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i));
    if (!id) throw new Error(`无法解析 @${i}: ${src.slice(i, i + 20)}`);
    i += id[0].length;
    ws();
    if (src[i] !== "(") {
      if (!(id[0] in env)) throw new Error(`未知变量 ${id[0]}`);
      return env[id[0]];
    }
    i++;
    const args: number[] = [];
    for (;;) {
      args.push(parseExpr());
      ws();
      if (src[i] === ",") { i++; continue; }
      eat(")"); break;
    }
    switch (id[0]) {
      case "if": return args[0] !== 0 ? args[1] : args[2];
      case "lt": return args[0] < args[1] ? 1 : 0;
      case "gte": return args[0] >= args[1] ? 1 : 0;
      case "min": return Math.min(...args);
      case "max": return Math.max(...args);
      default: throw new Error(`未知函数 ${id[0]}`);
    }
  }
  const v = parseExpr();
  ws();
  if (i !== src.length) throw new Error(`尾部残留 @${i}: ${src.slice(i)}`);
  return v;
}

// ───────────────────────────────────────────────────────────
console.log("\n[0] normalizeKfs 的**绝对**钉");
// ───────────────────────────────────────────────────────────
// 为什么单独一节：第 [3] 节是**交叉**钉（表达式 vs regionBoxAt），而两者都从
// `normalizeKfs` 取关键帧 —— **交叉钉对共同真源是瞎的**。把去重规则从"后者胜"
// 改成"前者胜"，两条曲线会一起挪，交叉钉照样全绿（变异 M19 实测存活）。
// 所以共同真源必须另有一组**说死取值**的断言，不能只靠"两边一致"。
{
  const n1 = normalizeKfs([kf(3, 0.3), kf(1, 0.1), kf(2, 0.2)]);
  ok(n1.map((k) => k.tSec).join(",") === "1,2,3", "乱序输入 → 按 tSec 升序");

  const n2 = normalizeKfs([kf(1, 0.1), kf(2, 0.9), kf(2, 0.3), kf(4, 0.5)]);
  ok(n2.length === 3 && n2[1].x === 0.3,
    "同刻重复只留**一条**，且取**后者**（把关键帧拖到另一条头上，后写的赢）",
    `${n2.length} 条，t=2 处 x=${n2[1].x}`);

  const n3 = normalizeKfs([kf(2, 0.9), kf(2, 0.3), kf(2, 0.7)]);
  ok(n3.length === 1 && n3[0].x === 0.7, "三条同刻 → 只剩最后那条", `x=${n3[0].x}`);
  ok(normalizeKfs(undefined).length === 0 && normalizeKfs([]).length === 0, "空输入 → 空数组");
  const src0 = [kf(3, 0.3), kf(1, 0.1)];
  normalizeKfs(src0);
  ok(src0[0].tSec === 3, "不就地改调用方的数组（UI 持有的是同一个引用）");

  // timeUnionBox 也必须走同一个归一化，否则会出现
  // 「isAnimated 说不是动画、却仍按并集扩框」这种自相矛盾的状态
  const dup = m({ x: 0.1, y: 0.1, w: 0.2, h: 0.2, keyframes: [kf(1, 0.1, 0.1, 0.2, 0.2), kf(1, 0.8, 0.8, 0.1, 0.1)] });
  const ub = timeUnionBox(dup);
  ok(!isAnimated(dup) && ub.x === 0.1 && ub.w === 0.2,
    "两条同刻关键帧：不算动画 ⇒ 框就是静态框，**不是**两条的并集",
    `box=${ub.x},${ub.y},${ub.w},${ub.h}`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[1] 表达式形状");
// ───────────────────────────────────────────────────────────
{
  ok(kfExpr(undefined, (k) => k.x, { fallback: 42 }) === "42.0000",
    "无关键帧 ⇒ 退化成常量（用 fallback，不是 0）", kfExpr(undefined, (k) => k.x, { fallback: 42 }));
  ok(kfExpr([kf(1, 0.5)], (k) => k.x, { scale: CW, fallback: 7 }) === "7.0000",
    "只有 1 条关键帧 ⇒ 取 **fallback（静态框）**，不是那条关键帧的值 —— "
    + "与 regionBoxAt 的「<2 条不算动画」逐字一致（写第 [3] 节交叉钉时撞出来的真分叉）");

  const e = kfExpr([kf(1, 0.1), kf(3, 0.5)], (k) => k.x, { scale: CW });
  ok(e.startsWith("if(lt(t,1.0000),108.0000,"), "首端单独夹持成常量（否则第一段会外推）", e.slice(0, 34));
  ok(/,540\.0000\)+$/.test(e), "末端常量收尾", e.slice(-14));
  ok(!e.includes("/"), "段内写成 V+K*(t-T)，不留运行期除法", e);

  const c = kfExpr([kf(1, 0.1), kf(3, 0.5)], (k) => k.x, { scale: CW, clampLo: "0", clampHi: "iw-432" });
  ok(c.startsWith("max(0,min(iw-432,") && c.endsWith("))"),
    "给了 clamp 就整体包一层 max(lo,min(hi,…))", `${c.slice(0, 20)}…${c.slice(-4)}`);
  ok(kfExpr([kf(1, 0.1), kf(3, 0.5)], (k) => k.x, { scale: CW, clampLo: "0" }).startsWith("if("),
    "只给半边 clamp ⇒ 不包（避免只夹一侧的半吊子表达式）");

  // 值恒定的一段不该留下 *0 的死项
  const flat = kfExpr([kf(0, 0.2), kf(2, 0.2), kf(4, 0.6)], (k) => k.x, { scale: CW });
  ok(!flat.includes("+0.0000*"), "斜率为 0 的段直接写常量，不留 +0*(t-T)", flat);

  const neg = kfExpr([kf(0, -1e-9), kf(2, 0.5)], (k) => k.x, { scale: CW });
  // 只找**字面量**位置的负零（`(t-0.0000)` 里那个减号不算 —— 首轮就是这么误判的）
  ok(!/[,(]-0\.0000/.test(neg), "四舍五入出来的负零归一成 0.0000", neg.slice(0, 32));

  const down = kfExpr([kf(0, 0.5), kf(2, 0.1)], (k) => k.x, { scale: CW });
  ok(down.includes("+-216.0000*"),
    "斜率为负时写成 `V+-K*(t-T)` —— 形状本身很刺眼，故第 [6] 节用真 ffmpeg 实跑一遍", down);
}

// ───────────────────────────────────────────────────────────
console.log("\n[2] 自检：先证明求值器是承重的");
// ───────────────────────────────────────────────────────────
{
  const e = kfExpr([kf(1, 0.1), kf(3, 0.5)], (k) => k.x, { scale: CW });
  ok(Math.abs(evalExpr(e, { t: 2 }) - 324) < 1e-3, "求值器能算出中点 324px", `${evalExpr(e, { t: 2 })}`);
  // 篡改：把斜率改掉，结果必须跟着变（证明它真的在读字符串，不是在猜）
  const tampered = e.replace("216.0000*", "999.0000*");
  ok(tampered !== e && Math.abs(evalExpr(tampered, { t: 2 }) - evalExpr(e, { t: 2 })) > 100,
    "改掉表达式里的斜率 ⇒ 求值结果跟着变（求值器不是摆设）");
  let threw = false;
  try { evalExpr("if(lt(t,1),2", { t: 0 }); } catch { threw = true; }
  ok(threw, "截断的表达式会抛错，不会被悄悄当成合法");
  ok(evalExpr("max(0,min(10,-5))", {}) === 0 && evalExpr("max(0,min(10,50))", {}) === 10,
    "求值器的 max/min 语义与 ffmpeg 一致");
}

// ───────────────────────────────────────────────────────────
console.log("\n[3] 承重：表达式与 regionBoxAt 必须是同一条曲线");
// ───────────────────────────────────────────────────────────
const CASES: { name: string; m: MosaicParams }[] = [
  { name: "两帧纯位移", m: m({ keyframes: [kf(1, 0.1), kf(3, 0.5)] }) },
  { name: "四帧折返", m: m({ keyframes: [kf(0, 0.1), kf(1, 0.6), kf(2.5, 0.2), kf(4, 0.45)] }) },
  { name: "乱序插入", m: m({ keyframes: [kf(2.5, 0.2), kf(0, 0.1), kf(4, 0.45), kf(1, 0.6)] }) },
  { name: "同刻重复（后者胜）", m: m({ keyframes: [kf(1, 0.1), kf(2, 0.9), kf(2, 0.3), kf(4, 0.5)] }) },
  { name: "中间一段不动", m: m({ keyframes: [kf(0, 0.2), kf(2, 0.2), kf(4, 0.6)] }) },
  { name: "尺寸也在变（非纯位移）", m: m({ keyframes: [kf(0, 0.1, 0.4, 0.1, 0.1), kf(3, 0.4, 0.2, 0.35, 0.3)] }) },
  { name: "只有一条关键帧", m: m({ x: 0.7, keyframes: [kf(1, 0.1)] }) },
  { name: "完全没有关键帧", m: m({ x: 0.7 }) },
];

for (const c of CASES) {
  const picks: { label: string; pick: (k: RegionKeyframe) => number; get: (b: { x: number; y: number; w: number; h: number }) => number; scale: number; fb: number }[] = [
    { label: "x", pick: (k) => k.x, get: (b) => b.x, scale: CW, fb: c.m.x * CW },
    { label: "y", pick: (k) => k.y, get: (b) => b.y, scale: CH, fb: c.m.y * CH },
    { label: "w", pick: (k) => k.w, get: (b) => b.w, scale: CW, fb: c.m.w * CW },
    { label: "h", pick: (k) => k.h, get: (b) => b.h, scale: CH, fb: c.m.h * CH },
  ];
  // 网格：区间内密集 + 每个关键帧时刻本身 + 两端之外（5.3 的教训：分段线性的
  // 极值与不连续点只在断点上取到，密集采样不能替代端点）
  const ts = new Set<number>();
  for (let t = -1; t <= 6; t += 0.017) ts.add(Number(t.toFixed(4)));
  for (const k of normalizeKfs(c.m.keyframes)) {
    ts.add(k.tSec); ts.add(k.tSec - 1e-6); ts.add(k.tSec + 1e-6);
  }
  let worst = 0, worstAt = "";
  for (const p of picks) {
    const expr = kfExpr(c.m.keyframes, p.pick, { scale: p.scale, fallback: p.fb });
    for (const t of ts) {
      const a = evalExpr(expr, { t });
      const b = p.get(regionBoxAt(c.m, t)) * p.scale;
      const d = Math.abs(a - b);
      if (d > worst) { worst = d; worstAt = `${p.label}@t=${t}: 表达式 ${a.toFixed(4)} vs regionBoxAt ${b.toFixed(4)}`; }
    }
  }
  // 容差 = 表达式字面量的 4 位小数取整（斜率与端点各一次）
  ok(worst < 2e-3, `${c.name}：${ts.size} 个 t × 4 个分量逐点一致`,
    worst > 0 ? `最大偏差 ${worst.toExponential(1)} px${worst >= 2e-3 ? ` @ ${worstAt}` : ""}` : "完全相同");
}

// ───────────────────────────────────────────────────────────
console.log("\n[4] 夹持与转义");
// ───────────────────────────────────────────────────────────
{
  const e = kfExpr([kf(0, -0.5), kf(4, 2)], (k) => k.x, { scale: 320, clampLo: "0", clampHi: "iw-40" });
  ok(evalExpr(e, { t: 0, iw: 320 }) === 0, "区域跑到画面左外 ⇒ 夹到 0（crop 拿到负坐标会直接报错）");
  ok(evalExpr(e, { t: 4, iw: 320 }) === 280, "跑到右外 ⇒ 夹到 iw-boxW", `${evalExpr(e, { t: 4, iw: 320 })}`);

  const raw = kfExpr([kf(0, 0.1), kf(2, 0.5)], (k) => k.x, { scale: 320, clampLo: "0", clampHi: "iw-40" });
  const esc = escapeFilterExpr(raw);
  ok(!raw.includes("\\"), "kfExpr 产出的是**未**转义的原串（转义是嵌入时才做的事）");
  ok(esc.split("\\,").length - 1 === raw.split(",").length - 1
    && esc.split("\\:").length - 1 === raw.split(":").length - 1,
    "escapeFilterExpr 把每个 , 和 : 都转义了", `${raw.split(",").length - 1} 个逗号`);
  // ⚠️ 上面那条对**冒号**是空转的：kfExpr 的产出里根本没有 `:`（只有数字、
  // `.,+-*()`、`t`/`iw`/`min`/`max`/`if`/`lt`）。所以冒号那一半必须直接按**契约**钉，
  // 否则"漏掉 : 不转义"这条变异照样全绿（实测 M12 存活）。
  ok(raw.indexOf(":") === -1, "前提：kfExpr 的产出本身不含冒号（所以上一条对 : 是空转的）");
  ok(escapeFilterExpr("a,b:c") === "a\\,b\\:c",
    "契约钉：, 与 : 都要转义（冒号这一半只有直接喂才测得到）", escapeFilterExpr("a,b:c"));
  ok(escapeFilterExpr("abc") === "abc", "没有特殊字符就原样返回");
  ok(evalExpr(esc.replace(/\\/g, ""), { t: 1, iw: 320 }) === evalExpr(raw, { t: 1, iw: 320 }),
    "转义只加反斜杠，不改变表达式本身");
}

// ───────────────────────────────────────────────────────────
console.log("\n[5] isPureTranslation / regionExprs");
// ───────────────────────────────────────────────────────────
{
  ok(isPureTranslation(m({ keyframes: [kf(0, 0.1), kf(2, 0.5)] })), "w/h 不变 ⇒ 纯位移（可用静态蒙版 + 会动的坐标）");
  ok(!isPureTranslation(m({ keyframes: [kf(0, 0.1, 0.4, 0.2, 0.1), kf(2, 0.5, 0.4, 0.3, 0.1)] })),
    "w 变了 ⇒ 不是纯位移（必须走蒙版序列）");
  // h 单独变一条：只比 w 的实现会在这里放行（实测 M14 存活于只有上一条时）
  ok(!isPureTranslation(m({ keyframes: [kf(0, 0.1, 0.4, 0.2, 0.1), kf(2, 0.5, 0.4, 0.2, 0.25)] })),
    "**只有 h 变**也不是纯位移（两个轴都得比，不能只比 w）");
  ok(!isPureTranslation(m({})) && !isPureTranslation(m({ keyframes: [kf(0, 0.1)] })),
    "静态区域不算纯位移（没有可动的坐标，直接走静态那条）");
  ok(isPureTranslation(m({ keyframes: [kf(0, 0.1), kf(2, 0.5), kf(2, 0.5)] })),
    "同刻重复不影响判定（归一化后再看）");

  const anim = m({ keyframes: [kf(0, 0.1), kf(2, 0.5)] });
  const ex = regionExprs(anim, { w: CW, h: CH }, { w: 216, h: 192 })!;
  ok(ex !== null && ex.cropX.includes("iw-216") && ex.cropY.includes("ih-192"),
    "crop 用 iw/ih 夹持");
  ok(ex.ovX.includes("W-216") && ex.ovY.includes("H-192") && !ex.ovX.includes("iw"),
    "overlay 用 W/H —— 它**不认识** iw/ih（编译器 176-178 行已记载，本节第 [6] 段实测复现）");
  ok(evalExpr(ex.cropX, { t: 1, iw: CW }) === evalExpr(ex.ovX, { t: 1, W: CW }),
    "同一时刻 crop 与 overlay 取值相同（否则遮挡与被遮挡处会错开）");

  // 四条表达式都要**逐点等于** regionBoxAt —— 上面那几条只看了结构（含不含 iw/W），
  // 结构对、换算错照样全绿：把 cropY 的 scale 写成 canvas.w 就是这么溜过去的（M18）。
  let worstE = 0, worstEAt = "";
  for (let t = -0.5; t <= 3; t += 0.05) {
    const b = regionBoxAt(anim, t);
    const probes: [string, number, number][] = [
      ["cropX", evalExpr(ex.cropX, { t, iw: CW }), b.x * CW],
      ["cropY", evalExpr(ex.cropY, { t, ih: CH }), b.y * CH],
      ["ovX", evalExpr(ex.ovX, { t, W: CW }), b.x * CW],
      ["ovY", evalExpr(ex.ovY, { t, H: CH }), b.y * CH],
    ];
    for (const [label, got, want] of probes) {
      const d = Math.abs(got - want);
      if (d > worstE) { worstE = d; worstEAt = `${label}@t=${t.toFixed(2)}: ${got.toFixed(3)} vs ${want.toFixed(3)}`; }
    }
  }
  ok(worstE < 2e-3, "regionExprs 的四条表达式逐点 == regionBoxAt（含 y 用画布**高**换算）",
    worstE ? `最大偏差 ${worstE.toExponential(1)}${worstE >= 2e-3 ? ` @ ${worstEAt}` : ""}` : "完全相同");
  ok(regionExprs(m({ keyframes: [kf(0, 0.1, 0.4, 0.2, 0.1), kf(2, 0.5, 0.4, 0.3, 0.1)] }),
    { w: CW, h: CH }, { w: 216, h: 192 }) === null,
    "非纯位移 ⇒ 返回 null，调用方退回蒙版序列");
}

// ───────────────────────────────────────────────────────────
console.log("\n[6] 真 ffmpeg：表达式必须被接受、必须真的会动");
// ───────────────────────────────────────────────────────────
const run = (a: string[]) => execFileSync(FFMPEG, a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
const SW = 320, SH = 240, FPS = 10, DUR = 4;
const src = join(work, "ramp.mp4");
try {
  // 每一列的亮度 = 列号：裁到 x 处取到的灰度**就是** x，于是"框有没有动到该到的位置"
  // 可以逐像素量出来，而不是靠肉眼看
  run(["-y", "-f", "lavfi", "-i", `nullsrc=s=${SW}x${SH}:d=${DUR}:r=${FPS}`,
    "-vf", "geq=lum=X:cb=128:cr=128,format=yuv420p", "-c:v", "libx264", "-qp", "0", src]);

  const BOX = 40;
  const kfs = [kf(0, 20 / SW), kf(2, 200 / SW)];   // 20px → 200px，2 秒
  const raw = kfExpr(kfs, (k) => k.x, { scale: SW, clampLo: "0", clampHi: `iw-${BOX}` });

  // 反证 ①：不转义直接塞进 filter_complex —— 逗号会把滤镜切碎
  let unescapedErr = "";
  try {
    run(["-y", "-i", src, "-filter_complex", `[0:v]crop=${BOX}:${BOX}:${raw}:0[o]`,
      "-map", "[o]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", join(work, "bad.gray")]);
  } catch (e) {
    unescapedErr = String((e as { stderr?: string }).stderr ?? e).trim().split("\n").pop() ?? "";
  }
  ok(unescapedErr !== "", "反证：未转义的表达式被 ffmpeg 拒绝（逗号被当成滤镜分隔）",
    unescapedErr.slice(0, 96));

  // 正证：转义后跑通，并把每一帧的左上角像素读出来
  //
  // ⚠️ 输出**必须**用 yuv420p 而不是 gray：`-pix_fmt gray` 会让 swscale 把 Y 平面
  // 从 limited(16..235) 展开成 full(0..255)，实测 20→5、200→214，正好是
  // (v-16)*255/219。那不是裁错了位置，是读数被换算了 —— 首轮就是这么两条红的。
  // 输入输出同为 yuv420p 则完全不过 swscale，第一个字节就是原始 Y 值。
  const outRaw = join(work, "moving.yuv");
  const FRAME_BYTES = BOX * BOX * 3 / 2;
  run(["-y", "-i", src, "-filter_complex",
    `[0:v]crop=${BOX}:${BOX}:${escapeFilterExpr(raw)}:0[o]`,
    "-map", "[o]", "-f", "rawvideo", "-pix_fmt", "yuv420p", outRaw]);
  const buf = readFileSync(outRaw);
  const frames = buf.length / FRAME_BYTES;
  ok(frames === DUR * FPS, "转义后 EXIT=0 且帧数正确", `${frames} 帧`);

  // 逐帧核对：第 n 帧（t = n/FPS）左上角的灰度 == 表达式在该 t 的取值**向下取偶**。
  // 不写成"误差 ≤1"：那种容差是装饰的（真错开 1px 也照样绿）。这里直接钉死
  // `vf_crop` 在 yuv420p 下把 x 向下对齐到偶数这条行为 —— 它正是 5.3 的 `alignBox`
  // 强制 x/y 取偶的原因（蒙版是 gray、不会被对齐，两边不一致就是静默错位 1px）。
  const evenDown = (v: number) => Math.floor(Math.floor(Number(v.toFixed(6))) / 2) * 2;
  let bad = 0, firstBad = "";
  for (let n = 0; n < frames; n++) {
    const want = evenDown(evalExpr(raw, { t: n / FPS, iw: SW }));
    const got = buf[n * FRAME_BYTES];
    if (got !== want) { bad++; if (!firstBad) firstBad = `帧 ${n}: 实测 ${got} vs 期望 ${want}`; }
  }
  ok(bad === 0, "每一帧裁到的位置 = 表达式取值向下取偶（真的在动、动到正确的地方、且对齐行为如实）",
    bad ? `${bad}/${frames} 帧不符，首个 ${firstBad}` : `${frames} 帧逐帧吻合`);

  const first = buf[0], mid = buf[Math.floor(frames / 2) * FRAME_BYTES], last = buf[(frames - 1) * FRAME_BYTES];
  ok(first < mid && mid <= last && last - first > 100,
    "首/中/末三帧的位置单调推进（不是「跑通了但其实没动」）", `${first} → ${mid} → ${last}`);
  ok(last === 200, "2 秒后夹持为常量，末帧仍停在 200（不外推冲出画面）", `末帧 ${last}`);

  // 把上面那个读数陷阱本身钉住：谁改回 `-pix_fmt gray` 就会看到这条说明为什么不行
  const outGray = join(work, "moving.gray");
  run(["-y", "-i", src, "-filter_complex",
    `[0:v]crop=${BOX}:${BOX}:${escapeFilterExpr(raw)}:0[o]`,
    "-map", "[o]", "-f", "rawvideo", "-pix_fmt", "gray", outGray]);
  const g = readFileSync(outGray);
  const gLast = g[(frames - 1) * BOX * BOX];
  ok(gLast !== last && Math.abs(gLast - ((last - 16) * 255 / 219)) <= 1,
    "反证：同一条命令输出 gray 时 Y 被 limited→full 展开（所以本节读 yuv420p）",
    `gray ${gLast} vs yuv420p ${last}，(v-16)*255/219 = ${((last - 16) * 255 / 219).toFixed(1)}`);

  // 负斜率会写成 `200.0000+-100.0000*(t-0.0000)`，`+-` 这个形状够刺眼，实跑一遍
  const dn = kfExpr([kf(0, 200 / SW), kf(1, 100 / SW)], (k) => k.x,
    { scale: SW, clampLo: "0", clampHi: `iw-${BOX}` });
  const dnOut = join(work, "down.yuv");
  run(["-y", "-i", src, "-filter_complex", `[0:v]crop=${BOX}:${BOX}:${escapeFilterExpr(dn)}:0[o]`,
    "-map", "[o]", "-f", "rawvideo", "-pix_fmt", "yuv420p", dnOut]);
  const db = readFileSync(dnOut);
  ok(dn.includes("+-") && db[0] === 200 && db[5 * FRAME_BYTES] === 150 && db[(DUR * FPS - 1) * FRAME_BYTES] === 100,
    "负斜率的 `V+-K*(t-T)` 被 ffmpeg 正确求值（不是语法错、也不是被当成加法）",
    `${db[0]} → ${db[5 * FRAME_BYTES]} → ${db[(DUR * FPS - 1) * FRAME_BYTES]}`);

  // 反证 ②：overlay 里写 iw —— 编译器注释里那条「必现报错」，这里复测一次
  let ovErr = "";
  try {
    run(["-y", "-i", src, "-filter_complex",
      `[0:v]split=2[bg][fg];[fg]crop=${BOX}:${BOX}:0:0[c];[bg][c]overlay=(iw*0.3):0[o]`,
      "-map", "[o]", "-frames:v", "1", "-f", "null", "-"]);
  } catch (e) {
    ovErr = String((e as { stderr?: string }).stderr ?? e);
  }
  ok(/Undefined constant|Invalid|error/i.test(ovErr),
    "反证：overlay 里写 iw 必报错 —— 所以 regionExprs 的 ovX/ovY 只能用 W/H",
    (ovErr.trim().split("\n").filter((l) => /iw/.test(l)).pop() ?? ovErr.trim().split("\n").pop() ?? "").slice(0, 90));
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 让 DEFAULT_TRANSFORM 的 import 有意义：确认 model 的默认值没被本条改动波及
ok(DEFAULT_TRANSFORM.scale === 1, "DEFAULT_TRANSFORM 未被本条波及");

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败");
process.exit(fail === 0 ? 0 : 1);
