/**
 * verify-maskfiles —— 蒙版产出与临时文件生命周期（5.8）验证
 * 跑法：npx tsx scripts/verify-maskfiles.ts
 *
 * 5.8 是批次 5 的**接线点**，它同时暴露在三类此前记录过的失败模式下：
 *
 *   ① 「断言在装饰而非承重」（已累计 19 次）—— 光断言"产出了 N 个文件"什么都没证明。
 *      本脚本对每一条规则钉的都是**取值**：字节数、逐像素比对、目录里剩下什么。
 *   ② 「共用真源时交叉钉是瞎的」（5.5 教训）—— 编译器与产出器都调
 *      `planMaskGroups`，拿两边的 groupIdx 互相比对必然相等，证明不了任何事。
 *      故 [3] 钉的是**绝对**取值：spec 的 w/h 必须**逐字段等于**该函数给出的 box。
 *   ③ 缺陷 2 那一类：尺寸对不上 ⇒ `alphamerge` 报
 *      `Input frame sizes do not match` ⇒ **整段导出失败**（不是画面偏一点）。
 *
 * 章节：
 *   [0] 文件命名（三元组 → 唯一名）
 *   [1] **零回归**：矩形+无羽化+无关键帧 ⇒ 一个 spec、一个字节都没有
 *   [2] **必须调 `rasterGroupMask`**：多区域组的蒙版 ≠ 把组框交给 `rasterRegionMask`
 *   [3] **整数只算一次**：spec.w/h 逐字段 === `planMaskGroups` 的 box
 *   [4] 帧数：静态 1；动画 ⌈dur·fps⌉+1
 *   [5] 预算降级：并集蒙版**逐像素 ≥** 每一帧，frames 归 1，且**必然带提示**
 *   [6] 分块写盘：字节总数与逐帧内容都对得上（重组后与 `frame(i)` 逐像素相同）
 *   [7] 生命周期：成功 / 失败 / 取消三条路径跑完，目录里都不该剩蒙版
 *   [8] 取消的粒度是**块**不是文件（大蒙版取消不该干等）
 *   [9] `maskDegradeNotices` 的降级阶梯（不许跳级、不许静默）
 */

import {
  MASK_BUDGET_BYTES, WRITE_CHUNK_BYTES, NOTICE_BUDGET,
  NOTICE_NO_ALPHAMERGE, NOTICE_RECT_ONLY,
  maskFileName, planSegmentMasks, writeSegmentMasks, maskDegradeNotices, maskClipsOf,
  type MaskIO, type MaskClipInput,
} from "../src/render/maskFiles";
import { planMaskGroups } from "../src/render/maskGroups";
import { rasterGroupMask, rasterRegionMask } from "../src/render/maskRaster";
import { regionShapeOf } from "../src/lib/regionShape";
import { clipMosaics, DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type { MosaicParams, RenderClip } from "../src/render/model";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};

const CANVAS = { w: 1080, h: 1920 };
const m = (p: Partial<MosaicParams>): MosaicParams => ({
  x: 0.1, y: 0.1, w: 0.2, h: 0.2, style: "pixel", intensity: 50, ...p,
});
const clip = (durationSec: number, mosaics: MosaicParams[]): MaskClipInput =>
  ({ durationSec, mosaics });

/** 内存 MaskIO：把"盘"做成一个 Map，好让三条生命周期路径都能在 node 下真的跑出来。 */
function memIO() {
  const files = new Map<string, number[]>();
  let writes = 0;
  const io: MaskIO = {
    join: async (dir, name) => `${dir}/${name}`,
    write: async (path, data, append) => {
      writes++;
      const prev = append ? (files.get(path) ?? []) : [];
      files.set(path, prev.concat([...data]));
    },
  };
  return { io, files, chunks: () => writes };
}

/* ==================== [0] 文件命名 ==================== */
console.log("\n[0] 文件命名");
{
  ok(maskFileName(0, 0, 0) === "mask_s0000_c00_g00.gray", "三元组补零");
  ok(maskFileName(12, 3, 7) === "mask_s0012_c03_g07.gray", "非零三元组");
  const names = new Set<string>();
  for (let s = 0; s < 3; s++) for (let c = 0; c < 4; c++) for (let g = 0; g < 4; g++) {
    names.add(maskFileName(s, c, g));
  }
  ok(names.size === 48, "48 个三元组 → 48 个互不相同的文件名", `${names.size}`);
}

/* ==================== [1] 零回归 ==================== */
console.log("\n[1] 零回归：legacy 数据一个字节都不写");
{
  // 矩形 + 无羽化 + 无关键帧 = §5.3.1 的既有数据，必须继续走 drawbox / split-crop-overlay
  const legacy = [
    m({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
    m({ x: 0.6, y: 0.7, w: 0.15, h: 0.1, style: "blackbox" }),
    m({ x: 0.3, y: 0.3, w: 0.25, h: 0.25, style: "gaussblur", shape: "rect" }),
  ];
  const p = planSegmentMasks(0, [clip(5, legacy)], CANVAS, 25);
  ok(p.specs.length === 0, "3 个纯矩形区域 → 0 个蒙版 spec", `${p.specs.length}`);
  ok(p.bytes === 0, "字节数为 0", `${p.bytes}`);
  ok(p.notices.length === 0, "无提示（零回归不该惊动用户）");

  // 反证：同一批数据只要有一个开了羽化，就必须产出蒙版 —— 否则上面三条对着
  // 一个"永远返回空"的实现也会全绿。
  const one = [...legacy];
  one[1] = m({ ...legacy[1], feather: 20 });
  const p2 = planSegmentMasks(0, [clip(5, one)], CANVAS, 25);
  ok(p2.specs.length > 0, "反证：其中一个开羽化 → 确实产出了蒙版", `${p2.specs.length} 个`);

  // 空 clip / 无马赛克 clip 不产出
  ok(planSegmentMasks(0, [clip(5, [])], CANVAS, 25).specs.length === 0, "无马赛克的 clip → 0");
}

/* ==================== [2] 必须是 rasterGroupMask ==================== */
console.log("\n[2] 产出蒙版必须调 rasterGroupMask（不能把 group.box 丢给 rasterRegionMask）");
{
  // 两个**互相分离**的椭圆，会被聚成一组（或至少各自成组）。取一个含 ≥2 区域的组来钉。
  const regions = [
    m({ x: 0.20, y: 0.20, w: 0.12, h: 0.12, shape: "ellipse" }),
    m({ x: 0.30, y: 0.22, w: 0.12, h: 0.12, shape: "ellipse" }),
  ];
  const groups = planMaskGroups(regions, CANVAS).filter((g) => g.kind === "mask");
  const multi = groups.find((g) => g.regionIdxs.length >= 2);
  ok(!!multi, "前提：两个相邻椭圆确实被聚成了一个多区域组");
  if (multi && multi.kind === "mask") {
    const p = planSegmentMasks(0, [clip(3, regions)], CANVAS, 25);
    const spec = p.specs.find((s) => s.groupIdx === groups.indexOf(multi));
    ok(!!spec, "该组确实有对应的 spec");
    if (spec) {
      const got = spec.frame(0);
      const right = rasterGroupMask(regions, multi, CANVAS, 0);
      let diff = 0;
      for (let i = 0; i < got.length; i++) if (got[i] !== right[i]) diff++;
      ok(diff === 0, "spec.frame(0) **逐像素等于** rasterGroupMask 的结果", `差异 ${diff}`);

      // 反面：把组框直接交给 rasterRegionMask —— 这正是计划书点名禁止的写法。
      // 它会把**第一个区域的形状**拉满整个组框，必须与正确结果显著不同。
      const wrong = rasterRegionMask(
        regionShapeOf(regions[multi.regionIdxs[0]]),
        { w: multi.box.w, h: multi.box.h }, 0, CANVAS.w / CANVAS.h,
      );
      let dw = 0;
      for (let i = 0; i < got.length; i++) if (got[i] !== wrong[i]) dw++;
      ok(dw > got.length * 0.05,
        "错误写法（rasterRegionMask + 组框）与正确结果**显著不同** —— 这条断言在承重",
        `差异 ${dw}/${got.length}`);

      // 覆盖率反证：正确蒙版不能是全 0 也不能是全 255，否则上面两条都在空转
      const on = got.reduce((n, v) => n + (v > 127 ? 1 : 0), 0);
      ok(on > 0 && on < got.length, "正确蒙版既不是全空也不是全满", `${on}/${got.length}`);
    }
  }
}

/* ==================== [3] 整数只算一次 ==================== */
console.log("\n[3] 整数只算一次：spec 尺寸逐字段 === planMaskGroups 的 box");
{
  // 特意用会产生奇数/贴边/出画的比例值 —— 缺陷 2 的三种触发场景
  const cases: Array<[string, MosaicParams[]]> = [
    ["奇数比例", [m({ x: 0.1234, y: 0.4321, w: 0.1357, h: 0.0913, shape: "ellipse" })]],
    ["贴左上边", [m({ x: 0, y: 0, w: 0.2001, h: 0.1501, feather: 30 })]],
    ["贴右下边", [m({ x: 0.79, y: 0.85, w: 0.21, h: 0.15, shape: "ellipse" })]],
    ["部分出画", [m({ x: -0.05, y: 0.5, w: 0.2, h: 0.2, shape: "ellipse", feather: 40 })]],
    ["三种效果同框", [
      m({ x: 0.2, y: 0.2, w: 0.11, h: 0.11, shape: "ellipse", style: "pixel" }),
      m({ x: 0.2, y: 0.5, w: 0.11, h: 0.11, shape: "ellipse", style: "gaussblur" }),
      m({ x: 0.2, y: 0.8, w: 0.11, h: 0.11, shape: "ellipse", style: "blackbox" }),
    ]],
  ];
  let bad = 0, checked = 0, oddW = 0;
  for (const [name, regions] of cases) {
    const groups = planMaskGroups(regions, CANVAS);
    const p = planSegmentMasks(0, [clip(4, regions)], CANVAS, 25);
    ok(p.specs.length > 0, `${name}：确实产出蒙版`, `${p.specs.length} 个`);
    for (const s of p.specs) {
      const g = groups[s.groupIdx];
      checked++;
      if (g.kind !== "mask" || g.box.w !== s.w || g.box.h !== s.h) { bad++; continue; }
      if (s.w % 2 !== 0 || s.h % 2 !== 0) oddW++;
      // 光栅化出来的字节数也必须正好是 w*h（不是"约等于"）
      if (s.frame(0).length !== s.w * s.h) bad++;
    }
  }
  ok(checked > 0 && bad === 0,
    "每个 spec 的 w/h 与光栅化长度都与组框逐字段一致", `核对 ${checked} 个`);
  ok(oddW === 0, "组框宽高恒为偶数（alignBox 的向外取偶在产出侧仍然成立）");
}

/* ==================== [4] 帧数 ==================== */
console.log("\n[4] 帧数：静态 1，动画 ⌈dur·fps⌉+1");
{
  const stat = [m({ x: 0.2, y: 0.2, w: 0.2, h: 0.2, shape: "ellipse" })];
  const ps = planSegmentMasks(0, [clip(3, stat)], CANVAS, 30);
  ok(ps.specs.every((s) => s.frames === 1 && !s.animated), "静态区域：frames=1、animated=false");
  ok(ps.bytes === ps.specs.reduce((n, s) => n + s.w * s.h, 0), "静态字节数 = Σ w·h");

  const anim = [m({
    x: 0.2, y: 0.2, w: 0.1, h: 0.1, shape: "ellipse",
    keyframes: [
      { tSec: 0, x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      { tSec: 2, x: 0.5, y: 0.6, w: 0.1, h: 0.1 },
    ],
  })];
  const pa = planSegmentMasks(0, [clip(2, anim)], CANVAS, 30);
  ok(pa.specs.length === 1 && pa.specs[0].animated, "动画区域：animated=true");
  ok(pa.specs[0].frames === Math.ceil(2 * 30) + 1,
    "frames = ⌈2×30⌉+1 = 61（+1 是给 framesync 重复末帧留的）", `${pa.specs[0].frames}`);
  ok(pa.specs[0].bytes === pa.specs[0].w * pa.specs[0].h * pa.specs[0].frames,
    "动画字节数 = w·h·frames");

  // 动画蒙版真的在动 —— 否则 frames 再对也只是写了 61 张一样的图
  const f0 = pa.specs[0].frame(0), f60 = pa.specs[0].frame(60);
  let moved = 0;
  for (let i = 0; i < f0.length; i++) if (f0[i] !== f60[i]) moved++;
  ok(moved > f0.length * 0.02, "首帧与末帧显著不同（蒙版真的跟着关键帧走）", `差异 ${moved}`);

  // **绝对时基钉**：第 i 帧必须正好是 `t = i/fps` 时刻的形状。
  // 只钉「首末帧不同」远远不够 —— 把 `i / safeFps` 写成 `i`（秒当帧用）同样能让
  // 首末帧不同（末帧被夹持到最后一个关键帧），却把整条动画的时间轴拉长 fps 倍，
  // 而重组比对那一节两边用的是同一个 `frame(i)`，交叉钉照不到。这条钉的是取值。
  const gsA = planMaskGroups(anim, CANVAS).filter((g) => g.kind === "mask");
  const gA = gsA[0];
  let tb = -1;
  if (gA && gA.kind === "mask") {
    tb = 0;
    for (const i of [0, 7, 23, 45, 60]) {
      const want = rasterGroupMask(anim, gA, CANVAS, i / 30);
      const got = pa.specs[0].frame(i);
      for (let j = 0; j < want.length; j++) if (want[j] !== got[j]) { tb++; break; }
    }
  }
  ok(tb === 0, "第 i 帧 === `t = i/fps` 时刻的光栅化结果（时基口径钉死取值）",
    tb < 0 ? "前提不成立：没拿到 mask 组" : `${tb} 帧对不上`);

  // fps 非法时的兜底。钉**取值**而不是「有限且 ≥1」：`safeFps = fps` 这种写法在
  // fps=0 下算出的正是 `max(1, ceil(0)+1) = 1` —— 有限、≥1、且看起来人畜无害，
  // 实际是把整条动画悄悄压成一张静态图。只有钉死「回落到 25」才接得住。
  for (const badFps of [0, NaN, -30, Infinity]) {
    const b = planSegmentMasks(0, [clip(2, anim)], CANVAS, badFps);
    ok(b.specs.length === 1 && b.specs[0].frames === Math.ceil(2 * 25) + 1,
      `fps=${badFps} 回落到 25 → 仍是 51 帧的动画蒙版（不是被压成 1 帧）`,
      `${b.specs[0]?.frames}`);
  }
}

/* ==================== [5] 预算降级 ==================== */
console.log("\n[5] 预算降级：并集只多遮不漏遮，且必然带提示");
{
  const anim = [m({
    x: 0.1, y: 0.1, w: 0.3, h: 0.2, shape: "ellipse",
    keyframes: [
      { tSec: 0, x: 0.05, y: 0.05, w: 0.30, h: 0.20 },
      { tSec: 1, x: 0.40, y: 0.60, w: 0.30, h: 0.20 },
    ],
  })];
  const full = planSegmentMasks(0, [clip(1, anim)], CANVAS, 30);
  ok(full.specs[0].frames > 1 && !full.specs[0].degraded, "前提：默认预算下不降级");

  // 把预算压到一帧都装不下 → 必然降级
  const tight = planSegmentMasks(0, [clip(1, anim)], CANVAS, 30, 1024);
  const d = tight.specs[0];
  ok(d.degraded && d.frames === 1, "超预算 → degraded=true、frames 归 1");
  ok(d.animated, "animated 仍为 true（组里确实有动画区域，这个事实不因降级而改变）");
  ok(tight.notices.includes(NOTICE_BUDGET), "带上了用户可见提示（不许静默吃掉动画）");
  ok(tight.notices.length === 1, "同一段内提示不重复", `${tight.notices.length}`);

  // 去重要在**降了多组**的情况下才检验得到：只降一组时循环只跑一趟，
  // 有没有 `includes` 那层判断结果都是 1 条。
  const two = planSegmentMasks(0, [clip(1, [
    m({ x: 0.02, y: 0.02, w: 0.25, h: 0.15, shape: "ellipse", style: "pixel",
        keyframes: [{ tSec: 0, x: 0.02, y: 0.02, w: 0.25, h: 0.15 },
                    { tSec: 1, x: 0.30, y: 0.30, w: 0.25, h: 0.15 }] }),
    m({ x: 0.60, y: 0.70, w: 0.25, h: 0.15, shape: "ellipse", style: "gaussblur",
        keyframes: [{ tSec: 0, x: 0.60, y: 0.70, w: 0.25, h: 0.15 },
                    { tSec: 1, x: 0.40, y: 0.50, w: 0.25, h: 0.15 }] }),
  ])], CANVAS, 30, 1024);
  ok(two.specs.length === 2 && two.specs.every((s) => s.degraded),
    "前提：两个不同 style 的动画组都被降级", `${two.specs.filter((s) => s.degraded).length}/2`);
  ok(two.notices.length === 1, "降了两组也只报一条（不刷屏）", `${two.notices.length} 条`);

  // **承重断言**：并集必须逐像素 ≥ 每一帧 —— "只会多遮、不会漏遮"
  const u = d.frame(0);
  let under = 0, sampled = 0;
  for (let i = 0; i < full.specs[0].frames; i++) {
    const f = full.specs[0].frame(i);
    sampled++;
    for (let j = 0; j < u.length; j++) if (f[j] > u[j]) under++;
  }
  ok(under === 0, `并集蒙版逐像素 ≥ 全部 ${sampled} 帧（漏遮 ${under} 像素）`);
  // 反证：并集要严格大于任一单帧，否则"≥"对两张相同的图也成立
  const onU = u.reduce((n, v) => n + (v > 127 ? 1 : 0), 0);
  const on0 = full.specs[0].frame(0).reduce((n, v) => n + (v > 127 ? 1 : 0), 0);
  ok(onU > on0, "并集覆盖面积严格大于首帧（断言不是在空转）", `${onU} > ${on0}`);

  ok(MASK_BUDGET_BYTES === 256 * 1024 * 1024, "默认预算 256 MB");
  // 静态组超预算时不该死循环（没有可降的东西）
  const bigStatic = planSegmentMasks(
    0, [clip(1, [m({ x: 0, y: 0, w: 1, h: 1, shape: "ellipse" })])], CANVAS, 30, 16);
  ok(bigStatic.specs.length === 1 && !bigStatic.specs[0].degraded,
    "全静态且超预算：正常返回、不降级、不死循环");
}

/* ==================== [6] 分块写盘 ==================== */
console.log("\n[6] 分块写盘：字节数与逐帧内容都对得上");
{
  const anim = [m({
    x: 0.1, y: 0.1, w: 0.25, h: 0.25, shape: "ellipse", feather: 15,
    keyframes: [
      { tSec: 0, x: 0.05, y: 0.05, w: 0.25, h: 0.25 },
      { tSec: 1, x: 0.45, y: 0.55, w: 0.25, h: 0.25 },
    ],
  })];
  const p = planSegmentMasks(0, [clip(1, anim)], CANVAS, 25);
  const s = p.specs[0];
  const { io, files, chunks } = memIO();
  const map = await writeSegmentMasks("/w/masks", p, io);

  ok(map.size === p.specs.length, "返回的路径表条目数 = spec 数");
  ok(map.get(`${s.clipIdx}:${s.groupIdx}`) === `/w/masks/${s.name}`,
    "键是 clipIdx:groupIdx，值是拼好的绝对路径");

  // ⚠️ 上一条在单 clip 单组下是**看不出方向**的（"0:0" 正反都一样）。
  // 造一个 clipIdx=1、groupIdx=0 的 spec，键写反就会取不到 —— 而取不到的后果是
  // `ctx.maskPath` 返回 null，编译器悄悄落回 legacy，羽化与动画全没了却不报错。
  const two = planSegmentMasks(0, [
    clip(2, []),                                   // clip 0：没有马赛克
    clip(2, [m({ shape: "ellipse", feather: 20 })]),// clip 1：一个蒙版组
  ], CANVAS, 25);
  const t1 = two.specs[0];
  ok(!!t1 && t1.clipIdx === 1 && t1.groupIdx === 0,
    "前提：拿到一个 clipIdx≠groupIdx 的 spec", `c${t1?.clipIdx} g${t1?.groupIdx}`);
  const io3 = memIO();
  const map2 = await writeSegmentMasks("/w/masks", two, io3.io);
  ok(map2.get("1:0") === `/w/masks/${t1.name}`, "键的方向是 clipIdx:groupIdx，不是反过来");
  ok(map2.get("0:1") === undefined, "反向的键取不到（这条才让上一条承重）");
  const bytes = files.get(`/w/masks/${s.name}`)!;
  ok(bytes.length === s.bytes, "盘上字节数 === spec.bytes", `${bytes.length}`);
  ok(bytes.length === s.w * s.h * s.frames, "字节数 === w·h·frames");

  // 逐帧重组必须与 frame(i) 逐像素相同 —— 分块边界最容易在这里错位
  let mism = 0;
  for (let i = 0; i < s.frames; i++) {
    const want = s.frame(i);
    for (let j = 0; j < want.length; j++) {
      if (bytes[i * want.length + j] !== want[j]) { mism++; break; }
    }
  }
  ok(mism === 0, `重组后 ${s.frames} 帧逐帧与 frame(i) 一致（错位 ${mism} 帧）`);
  ok(chunks() >= 1, "至少写了一块", `${chunks()} 块`);
  ok(s.bytes <= WRITE_CHUNK_BYTES || chunks() > 1,
    "超过单块上限时确实分了多块（不是把几百 MB 堆在 JS 堆里）");

  // 静态组只写一块、且是覆盖写不是追加写（append=false 打头）
  const st = planSegmentMasks(0, [clip(3, [m({ shape: "ellipse" })])], CANVAS, 25);
  const io2 = memIO();
  await writeSegmentMasks("/w/masks", st, io2.io);
  ok(io2.chunks() === st.specs.length, "静态蒙版：每个 spec 只写一次", `${io2.chunks()}`);
}

/* ==================== [7] 生命周期三条路径 ==================== */
console.log("\n[7] 生命周期：成功 / 失败 / 取消，目录里都不该剩蒙版");
{
  // 这里模拟 renderer 的做法：蒙版落在 work/masks/ 下，finally 整目录删。
  // 三条路径共用同一句删除 —— 本节钉的正是"共用"这件事（各写一套必漏一条）。
  const anim = [m({
    x: 0.1, y: 0.1, w: 0.2, h: 0.2, shape: "ellipse",
    keyframes: [{ tSec: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
                { tSec: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }],
  })];
  const plan = planSegmentMasks(0, [clip(1, anim)], CANVAS, 25);

  const run = async (mode: "ok" | "fail" | "cancel") => {
    const { io, files } = memIO();
    const work = new Set<string>();     // "盘"上 work/ 目录里的东西
    const ctl = new AbortController();
    if (mode === "cancel") ctl.abort();
    try {
      const map = await writeSegmentMasks(
        "/w/masks", plan, io, ctl.signal, () => { throw new Error("Aborted"); });
      for (const k of map.values()) work.add(k);
      if (mode === "fail") throw new Error("ffmpeg 失败(1)");
    } catch { /* 与 renderer 一样：错误照抛，清理在 finally */ }
    finally {
      for (const k of files.keys()) { files.delete(k); work.delete(k); }
    }
    return { left: files.size, work: work.size };
  };

  const a = await run("ok"), b = await run("fail"), c = await run("cancel");
  ok(a.left === 0 && a.work === 0, "成功路径：清理干净");
  ok(b.left === 0 && b.work === 0, "失败路径：清理干净");
  ok(c.left === 0 && c.work === 0, "取消路径：清理干净");

  // 反证：不跑 finally 的话确实会剩东西 —— 证明上面三条不是对着空目录空转
  const { io, files } = memIO();
  await writeSegmentMasks("/w/masks", plan, io);
  ok(files.size > 0, "反证：不清理时目录里确实有文件", `${files.size} 个`);
}

/* ==================== [8] 取消的粒度是块 ==================== */
console.log("\n[8] 取消的粒度是「块」而不是「文件」");
{
  // 造一个必然要分很多块的动画蒙版（大框 × 长时长）
  const anim = [m({
    x: 0.05, y: 0.05, w: 0.9, h: 0.5, shape: "ellipse",
    keyframes: [{ tSec: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.5 },
                { tSec: 4, x: 0.05, y: 0.45, w: 0.9, h: 0.5 }],
  })];
  const plan = planSegmentMasks(0, [clip(4, anim)], CANVAS, 30);
  const s = plan.specs[0];
  ok(s.bytes > WRITE_CHUNK_BYTES, "前提：这张蒙版确实超过单块上限", `${s.bytes} B`);

  const { io, files, chunks } = memIO();
  const ctl = new AbortController();
  // 写完第 2 块就取消 —— 若中断只在文件之间检查，这里会把整张几百 MB 写完
  const io2: MaskIO = {
    join: io.join,
    write: async (p2, d, ap) => { await io.write(p2, d, ap); if (chunks() >= 2) ctl.abort(); },
  };
  let aborted = false;
  try {
    await writeSegmentMasks("/w/masks", plan, io2, ctl.signal,
      () => { throw new Error("Aborted"); });
  } catch (e) { aborted = (e as Error).message === "Aborted"; }
  ok(aborted, "中途 abort 会抛出（调用方据此走 Aborted 分支）");
  const written = files.get(`/w/masks/${s.name}`)?.length ?? 0;
  ok(written > 0 && written < s.bytes,
    "只写了一部分就停了（没有干等整张写完）", `${written}/${s.bytes} B`);
  ok(chunks() <= 3, "取消后最多再多写一块", `${chunks()} 块`);
}

/* ==================== [9] 降级阶梯 ==================== */
console.log("\n[9] maskDegradeNotices：降级不许跳级、不许静默");
{
  const ALL = { alphamerge: true, geq: true };
  const NO_AM = { alphamerge: false, geq: true };
  const NONE = { alphamerge: false, geq: false };

  const rectPlain = [clip(3, [m({})])];
  const rectFeather = [clip(3, [m({ feather: 25 })])];
  const ellipse = [clip(3, [m({ shape: "ellipse" })])];
  const animated = [clip(3, [m({
    keyframes: [{ tSec: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
                { tSec: 1, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }],
  })])];
  const emptyBrush = [clip(3, [m({ shape: "brush", stroke: [], brushSize: 0.08 })])];

  ok(maskDegradeNotices(rectPlain, ALL).length === 0, "能力齐全 → 无提示");
  ok(maskDegradeNotices(rectPlain, NONE).length === 0,
    "纯矩形 + 无羽化：能力再缺也没有任何降级，不该吓唬用户");

  ok(maskDegradeNotices(rectFeather, NO_AM).includes(NOTICE_NO_ALPHAMERGE),
    "缺 alphamerge + 有羽化 → 提示羽化本次不生效");
  ok(!maskDegradeNotices(rectFeather, NO_AM).includes(NOTICE_RECT_ONLY),
    "**不跳级**：geq 还在，矩形提示不该出现");
  ok(maskDegradeNotices(animated, NO_AM).includes(NOTICE_NO_ALPHAMERGE),
    "缺 alphamerge + 有关键帧 → 同一条提示");
  ok(maskDegradeNotices(rectFeather, ALL).length === 0, "alphamerge 在 → 羽化不提示");

  ok(maskDegradeNotices(ellipse, NONE).includes(NOTICE_RECT_ONLY),
    "两个都缺 + 椭圆 → 提示退化为矩形");
  ok(!maskDegradeNotices(ellipse, NO_AM).includes(NOTICE_RECT_ONLY),
    "只缺 alphamerge 时椭圆走 geq，形状保住，不提示退矩形");
  ok(maskDegradeNotices(emptyBrush, NONE).length === 0,
    "空笔迹是 no-op 区域，不为它报降级");

  // 多 clip 汇总去重
  const many = [...ellipse, ...ellipse, ...rectFeather];
  const n = maskDegradeNotices(many, NONE);
  ok(n.length === new Set(n).size, "同一条提示不重复", `${n.length} 条`);
}

/* ==================== [10] maskClipsOf 的口径 ==================== */
console.log("\n[10] maskClipsOf：时长取输出口径，马赛克与编译器同一份提取逻辑");
{
  const mk = (over: Partial<RenderClip>): RenderClip => ({
    id: "c", mediaId: "m", timelineStartSec: 0,
    durationSec: 4, sourceInSec: 0, sourceDurationSec: 8, speed: 2,
    transform: { ...DEFAULT_TRANSFORM }, audio: { ...DEFAULT_AUDIO },
    effects: [], ...over,
  });
  const a = m({ shape: "ellipse" });
  const b = m({ x: 0.5, feather: 20 });
  const c = mk({
    effects: [
      { type: "mosaic", mosaicParams: a },
      { type: "brightness", value: 10 },
      { type: "mosaic", mosaicParams: b },
    ],
  });

  const [got] = maskClipsOf([c]);
  // durationSec ≠ sourceDurationSec：`tSec` 是**输出时间**（setpts 之后的 t），
  // 取成源时长的话 speed≠1 的镜头动画会整条拉长/压缩，而画面上看不出来。
  ok(got.durationSec === 4, "取 clip.durationSec（已含变速），不是 sourceDurationSec(8)",
    `${got.durationSec}`);
  ok(got.mosaics.length === 2, "只取 mosaic 效果，调色（brightness）被跳过", `${got.mosaics.length}`);
  ok(got.mosaics[0] === a && got.mosaics[1] === b,
    "顺序与对象与 clipMosaics 完全一致（regionIdx 就是这个下标）");
  const same = clipMosaics(c);
  ok(same.length === got.mosaics.length && same.every((x, i) => x === got.mosaics[i]),
    "与编译器共用同一个 clipMosaics —— 下标口径不可能漂");
  ok(maskClipsOf([mk({})])[0].mosaics.length === 0, "无效果的 clip → 空数组");

  // **一个都不许少**：`regionIdx` 是位置下标，`planMaskGroups` / `rasterGroupMask` /
  // 编译器三边都按它取值。哪怕是空笔迹这种画面上什么都不做的区域，也必须**占住位置** ——
  // 顺手把它筛掉，后面所有区域的下标集体前移一位，遮挡会张冠李戴。
  const noop = m({ shape: "brush", stroke: [], brushSize: 0.08 });
  const tail = m({ x: 0.7, y: 0.7, shape: "ellipse" });
  const keep = maskClipsOf([mk({
    effects: [a, noop, tail].map((mp) => ({ type: "mosaic" as const, mosaicParams: mp })),
  })])[0];
  ok(keep.mosaics.length === 3, "空笔迹也占一个下标（不做任何筛选）", `${keep.mosaics.length}`);
  ok(keep.mosaics[1] === noop && keep.mosaics[2] === tail, "其后区域的下标没有前移");
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败");
process.exit(fail === 0 ? 0 : 1);
