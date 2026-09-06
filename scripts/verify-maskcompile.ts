/**
 * verify-maskcompile —— 统一蒙版滤镜图（5.4）验证
 * 跑法：npx tsx scripts/verify-maskcompile.ts
 *
 * 5.4 是批次 5 里**唯一动到导出主路径签名**的一条，所以这个脚本要证的不是
 * "新功能能用"，而是四件承重的事：
 *
 *   1. **不传 `mask` 时逐字节退回旧实现** —— 用冻结金样本钉死六种区域形态的
 *      完整字符串。旧路径整段留在 `emitLegacyRegion` 里没动，金样本就是它的证据；
 *      谁不小心"顺手统一"了两条路径，这里立刻红。
 *   2. **空笔迹画笔不再让整段导出失败** —— 这是读代码时发现的**既有真 bug**：
 *      旧实现把"是否最后一条"挂在区域下标上，而空笔迹区域是**什么都不发射**地
 *      把 `cur` 推走的，于是 outLabel 无人定义。本节用真 ffmpeg 正反两证：
 *      旧形状必失败（且报的就是那句 `Output with label 'v0' does not exist`），
 *      新形状 EXIT=0。
 *   3. **蒙版与画面共用同一句 crop** —— `[fg]` 的 `crop=BW:BH:BX:BY`、蒙版文件的
 *      `-s BWxBH`、`overlay=BX:BY` 三者必须来自 `planMaskGroups` 的**同一组整数**。
 *      这正是「缺陷 2」那类 `Input frame sizes do not match` 整段崩掉的根因。
 *   4. **输入下标分配顺序 = args 里 `-i` 的出现顺序** —— 静音轨与蒙版现在共用
 *      `allocInput`，错一位就是"某个 clip 拿到别人的静音轨/蒙版"，不报错、只是错。
 *
 * 另外钉住 `rasterGroupMask`：接 5.4 时才暴露的缺口是
 * `rasterRegionMask(shape, group.box, …)` 会把形状**铺满组框**（组框比区域框大：
 * 向外取偶 + 羽化外扩 + 多区域并集）。本节用"圆度"与"多区域组"两条断言把它钉住。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { compileMosaicFilters, compileSegment } from "../src/render/ffmpegCompiler";
import type { MaskCompileOpts } from "../src/render/ffmpegCompiler";
import { planMaskGroups, regionBoxAt } from "../src/render/maskGroups";
import type { MaskGroup } from "../src/render/maskGroups";
import { rasterGroupMask } from "../src/render/maskRaster";
import { buildSegments } from "../src/render/segment";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type { MosaicParams, RenderClip, RenderPlan } from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const work = mkdtempSync(join(tmpdir(), "mc54-"));
const CW = 1080, CH = 1920;

const m = (p: Partial<MosaicParams>): MosaicParams =>
  ({ x: 0.2, y: 0.3, w: 0.4, h: 0.25, style: "pixel", intensity: 50, ...p }) as MosaicParams;
/** 空笔迹画笔：今天什么都不画的区域（`regionShapeOf` 会把它降成 rect 后 early return） */
const emptyBrush = (p: Partial<MosaicParams> = {}) => m({ shape: "brush", stroke: [], ...p });

const CAPS_FULL: Capabilities = {
  version: "test", available: true, hwEncoders: [],
  filters: new Set(["scale", "pad", "setpts", "crop", "overlay", "split", "drawbox",
    "geq", "format", "alphamerge", "gblur", "blend", "amix", "volume", "anullsrc", "null"]),
  transitions: new Set<string>(), probedAt: Date.now(),
};
const capsWithout = (f: string): Capabilities =>
  ({ ...CAPS_FULL, filters: new Set([...CAPS_FULL.filters].filter((x) => x !== f)) });

console.log("\n══ 5.4 统一蒙版滤镜图（compileMosaicFilters / compileSegment）══\n");

// ───────────────────────────────────────────────────────────
console.log("[1] 零回归金样本：不传 mask ⇒ 与批次 5 之前逐字节相同");
// ───────────────────────────────────────────────────────────
//
// 这些字符串是**冻结的**。它们不是"当前实现的回显"，而是 5.4 之前那份实现的产出：
// `effectCore` 抽取、`emitLegacyRegion` 闭包化、"最后一条"判定改法，三处改动
// 都以"这六串一个字符不变"为验收条件。
const GOLDEN: Record<string, string[]> = {
  "矩形 + pixel": [
    "[in]split=2[ms0_0_0bg][ms0_0_0fg]",
    "[ms0_0_0fg]crop=432:480:(iw*0.20000):(ih*0.30000),scale=iw/18:-1:flags=fast_bilinear,scale=iw*18:-1:flags=neighbor,scale=432:480[ms0_0_0proc]",
    "[ms0_0_0bg][ms0_0_0proc]overlay=(W*0.20000):(H*0.30000)[out]",
  ],
  "矩形 + 纯黑（drawbox 单条）": [
    "[in]drawbox=x=(iw*0.20000):y=(ih*0.30000):w=(iw*0.40000):h=(ih*0.25000):color=black@1.0:t=fill[out]",
  ],
  "矩形 + 高斯（不补 scale）": [
    "[in]split=2[ms0_0_0bg][ms0_0_0fg]",
    "[ms0_0_0fg]crop=432:480:(iw*0.20000):(ih*0.30000),gblur=sigma=21[ms0_0_0proc]",
    "[ms0_0_0bg][ms0_0_0proc]overlay=(W*0.20000):(H*0.30000)[out]",
  ],
  "椭圆 → geq": [
    "[in]split=2[ms0_0_0bg][ms0_0_0fg]",
    "[ms0_0_0fg]crop=432:480:(iw*0.20000):(ih*0.30000),scale=iw/18:-1:flags=fast_bilinear,scale=iw*18:-1:flags=neighbor,scale=432:480,format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow((X-W/2)/(W/2)\\,2)+pow((Y-H/2)/(H/2)\\,2)\\,1)\\,255\\,0)'[ms0_0_0proc]",
    "[ms0_0_0bg][ms0_0_0proc]overlay=(W*0.20000):(H*0.30000)[out]",
  ],
  "画笔 → geq（5.1 的 Y 半径修复仍在）": [
    "[in]split=2[ms0_0_0bg][ms0_0_0fg]",
    "[ms0_0_0fg]crop=432:480:(iw*0.20000):(ih*0.30000),scale=iw/18:-1:flags=fast_bilinear,scale=iw*18:-1:flags=neighbor,scale=432:480,format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(max(lte(pow((X/W-0.2500)/0.1250\\,2)+pow((Y/H-0.2000)/0.1125\\,2)\\,1)\\,lte(pow((X/W-0.6250)/0.1250\\,2)+pow((Y/H-0.4800)/0.1125\\,2)\\,1))\\,0)\\,255\\,0)'[ms0_0_0proc]",
    "[ms0_0_0bg][ms0_0_0proc]overlay=(W*0.20000):(H*0.30000)[out]",
  ],
  "两个区域串联（中间标签用区域下标）": [
    "[in]split=2[ms0_0_0bg][ms0_0_0fg]",
    "[ms0_0_0fg]crop=432:480:(iw*0.20000):(ih*0.30000),scale=iw/18:-1:flags=fast_bilinear,scale=iw*18:-1:flags=neighbor,scale=432:480[ms0_0_0proc]",
    "[ms0_0_0bg][ms0_0_0proc]overlay=(W*0.20000):(H*0.30000)[ms0_0_0out]",
    "[ms0_0_0out]drawbox=x=(iw*0.50000):y=(ih*0.30000):w=(iw*0.40000):h=(ih*0.25000):color=black@1.0:t=fill[out]",
  ],
};
const BRUSH_STROKE = [{ x: 0.3, y: 0.35 }, { x: 0.45, y: 0.42 }];
const goldenInputs: Record<string, MosaicParams[]> = {
  "矩形 + pixel": [m({})],
  "矩形 + 纯黑（drawbox 单条）": [m({ style: "blackbox" })],
  "矩形 + 高斯（不补 scale）": [m({ style: "gaussblur", intensity: 70 })],
  "椭圆 → geq": [m({ shape: "ellipse" })],
  "画笔 → geq（5.1 的 Y 半径修复仍在）": [m({ shape: "brush", brushSize: 0.1, stroke: BRUSH_STROKE })],
  "两个区域串联（中间标签用区域下标）": [m({}), m({ x: 0.5, style: "blackbox" })],
};
for (const [name, expect] of Object.entries(GOLDEN)) {
  const got = compileMosaicFilters("[in]", "[out]", goldenInputs[name], 0, 0, CW, CH);
  const same = got.length === expect.length && got.every((s, i) => s === expect[i]);
  ok(same, name, same ? `${got.length} 条` : `\n     期望 ${JSON.stringify(expect)}\n     实得 ${JSON.stringify(got)}`);
}
ok(compileMosaicFilters("[in]", "[out]", [], 0, 0, CW, CH).length === 0,
  "没有区域时返回空数组（调用方据此不接标签）");

// ───────────────────────────────────────────────────────────
console.log("\n[2] 既有 bug：空笔迹画笔让 outLabel 无人定义");
// ───────────────────────────────────────────────────────────
{
  const onlyEmpty = compileMosaicFilters("[in]", "[out]", [emptyBrush()], 0, 0, CW, CH);
  ok(onlyEmpty.length === 1 && onlyEmpty[0] === "[in]null[out]",
    "唯一区域是空笔迹 ⇒ 用 null 直通接出 outLabel", JSON.stringify(onlyEmpty));

  const lastEmpty = compileMosaicFilters("[in]", "[out]", [m({}), emptyBrush({ x: 0.5 })], 0, 0, CW, CH);
  ok(lastEmpty.some((s) => s.endsWith("[out]")),
    "**最后**一个区域是空笔迹 ⇒ outLabel 仍由真正发射的那条产出");
  ok(!lastEmpty.some((s) => s.includes("[ms0_0_0out]")),
    "且不再留下一个没人定义的中间标签");

  const midEmpty = compileMosaicFilters("[in]", "[out]", [m({}), emptyBrush({ x: 0.5 }), m({ x: 0.6, style: "blackbox" })], 0, 0, CW, CH);
  // 标签链必须首尾相接：每条的输入标签都得是上一条的输出
  const chainOk = midEmpty.length === 4
    && midEmpty[0].startsWith("[in]")
    && midEmpty[2].endsWith("[ms0_0_0out]")
    && midEmpty[3].startsWith("[ms0_0_0out]") && midEmpty[3].endsWith("[out]");
  ok(chainOk, "**中间**是空笔迹 ⇒ 标签链首尾相接，不跳号", JSON.stringify(midEmpty.map((s) => s.slice(0, 24))));

  ok(compileMosaicFilters("[in]", "[out]", [emptyBrush(), emptyBrush({ x: 0.5 })], 0, 0, CW, CH)
    .join("|") === "[in]null[out]",
    "全部区域都是空笔迹 ⇒ 仍然只有一条 null 直通");

  // 蒙版路径同样要跳过空笔迹：`buildEmitUnits` 里那句 `isNoOpRegion` 是**承重**的。
  // `planMaskGroups` 自己已经先滤掉空笔迹，所以只有手工构造的 groups（或将来分组器
  // 与编译器失配）才会把空笔迹送到编译器面前 —— 守卫一旦去掉，最后那个"什么都不发射"
  // 的单元就会拿走 outLabel，原样重演本节开头那条整段导出失败。故这里手工构造。
  const gEllipse = planMaskGroups([m({ shape: "ellipse" })], { w: CW, h: CH });
  const handGroups: MaskGroup[] = [...gEllipse, { kind: "legacy", regionIdxs: [1] }];
  const withNoOp = compileMosaicFilters(
    "[in]", "[out]", [m({ shape: "ellipse" }), emptyBrush({ x: 0.5 })], 0, 0, CW, CH,
    { groups: handGroups, inputIdx: (gi) => (handGroups[gi].kind === "mask" ? 1 : null) },
  );
  ok(withNoOp.some((s) => s.endsWith("[out]")),
    "蒙版路径：末位是空笔迹的 legacy 组 ⇒ outLabel 仍由真正发射的单元接出",
    JSON.stringify(withNoOp[withNoOp.length - 1]?.slice(-24)));
  ok(!withNoOp.some((s) => s.includes("[mu0_0_0out]")),
    "且不留下没人定义的中间标签");
}

// ───────────────────────────────────────────────────────────
console.log("\n[3] 蒙版路径的滤镜图形状");
// ───────────────────────────────────────────────────────────
const maskOpts = (mosaics: MosaicParams[], base = 1): MaskCompileOpts => {
  const groups = planMaskGroups(mosaics, { w: CW, h: CH });
  const idx = new Map<number, number>();
  groups.forEach((g, gi) => { if (g.kind === "mask") idx.set(gi, base + idx.size); });
  return { groups, inputIdx: (gi) => idx.get(gi) ?? null };
};
{
  const ms = [m({ shape: "ellipse" })];
  const opts = maskOpts(ms);
  const g0 = opts.groups[0];
  if (g0.kind !== "mask") throw new Error("椭圆本该走蒙版组");
  const { x, y, w, h } = g0.box;
  const parts = compileMosaicFilters("[in]", "[out]", ms, 0, 0, CW, CH, opts);
  const joined = parts.join(";");

  ok(parts.length === 5, "一组蒙版 = 5 条滤镜（split / crop+效果 / gray / alphamerge / overlay）", `${parts.length} 条`);
  ok(joined.includes(`crop=${w}:${h}:${x}:${y}`), "crop 用的是组框的四个整数", `crop=${w}:${h}:${x}:${y}`);
  ok(joined.includes(`overlay=${x}:${y}`), "overlay 用的是**同一对** x/y（不是 W/H 表达式）");
  ok(joined.includes(`scale=${w}:${h},format=yuva420p`),
    "效果之后无条件补 scale=BW:BH —— 尺寸差一个像素就是整段导出失败");
  ok(joined.includes("[1:v]format=gray[") && joined.includes("alphamerge"),
    "蒙版输入按 gray 接进 alphamerge");
  ok(!joined.includes("geq="), "蒙版路径不再产生 geq（逐像素解释器已让位）");
  ok(x % 2 === 0 && y % 2 === 0 && w % 2 === 0 && h % 2 === 0,
    "组框 x/y/w/h 全为偶数（gray 蒙版不会跟着 yuv420p 的 crop 一起对齐）", `${w}x${h}+${x}+${y}`);

  // 高斯/纯黑同样要补 scale：它们本身不改尺寸，但蒙版尺寸容不得"看情况"
  for (const st of ["gaussblur", "blackbox"] as const) {
    const mm = [m({ shape: "ellipse", style: st })];
    const o = maskOpts(mm);
    const gg = o.groups[0];
    if (gg.kind !== "mask") throw new Error("unreachable");
    const j = compileMosaicFilters("[in]", "[out]", mm, 0, 0, CW, CH, o).join(";");
    ok(j.includes(`scale=${gg.box.w}:${gg.box.h},format=yuva420p`),
      `${st} 也补 scale=BW:BH（不靠"只有 pixel 需要"这种知识兜底）`);
  }
}
{
  // 同一组里多个区域：只发一条链，效果取首个区域（同组 effectKey 相同）
  const ms = [m({ shape: "ellipse", x: 0.2, y: 0.3, w: 0.2, h: 0.1 }),
              m({ shape: "ellipse", x: 0.45, y: 0.32, w: 0.2, h: 0.1 })];
  const opts = maskOpts(ms);
  const parts = compileMosaicFilters("[in]", "[out]", ms, 0, 0, CW, CH, opts);
  ok(opts.groups.length === 1 && parts.length === 5,
    "聚集的两个同效果区域 ⇒ 合成一组、一条链", `${opts.groups.length} 组 / ${parts.length} 条`);
  ok(parts.filter((s) => s.includes("alphamerge")).length === 1, "只 alphamerge 一次");
}

// ───────────────────────────────────────────────────────────
console.log("\n[4] 降级阶梯：拿不到蒙版就回落旧路径，形状不静默丢失");
// ───────────────────────────────────────────────────────────
{
  const ms = [m({ shape: "ellipse" })];
  const legacy = compileMosaicFilters("[in]", "[out]", ms, 0, 0, CW, CH);

  const allNull: MaskCompileOpts = { groups: planMaskGroups(ms, { w: CW, h: CH }), inputIdx: () => null };
  const got = compileMosaicFilters("[in]", "[out]", ms, 0, 0, CW, CH, allNull);
  ok(JSON.stringify(got) === JSON.stringify(legacy),
    "`inputIdx` 全返回 null ⇒ 与不传 mask **逐字节**相同（椭圆仍走 geq，形状保住）");

  // 一半拿得到、一半拿不到：拿不到的那组逐区域回落，拿得到的走蒙版
  const two = [m({ shape: "ellipse", x: 0.05, y: 0.05, w: 0.2, h: 0.1 }),
               m({ shape: "ellipse", x: 0.7, y: 0.8, w: 0.2, h: 0.1 })];
  const groups = planMaskGroups(two, { w: CW, h: CH });
  const half: MaskCompileOpts = { groups, inputIdx: (gi) => (gi === 0 ? 1 : null) };
  const mixed = compileMosaicFilters("[in]", "[out]", two, 0, 0, CW, CH, half).join(";");
  ok(groups.length === 2, "分散的两个区域不合并（并集面积超阈值）", `${groups.length} 组`);
  ok(mixed.includes("alphamerge") && mixed.includes("geq="),
    "混合降级：一组走 alphamerge、另一组回落 geq，两种形状都还在");
  ok(mixed.split(";").pop()!.endsWith("[out]"), "混合降级后 outLabel 仍由最后一条产出");
}

// ───────────────────────────────────────────────────────────
console.log("\n[5] compileSegment：输入下标分配顺序 = args 里 -i 的顺序");
// ───────────────────────────────────────────────────────────
function clip(i: number, over: Partial<RenderClip> = {}): RenderClip {
  return {
    id: `c${i}`, mediaId: `m${i}`, timelineStartSec: 0, durationSec: 2,
    sourceInSec: 0, sourceDurationSec: 2, speed: 1,
    transform: { ...DEFAULT_TRANSFORM }, effects: [], audio: { ...DEFAULT_AUDIO },
    ...over,
  };
}
function planOf(clips: RenderClip[], w = CW, h = CH): RenderPlan {
  return {
    projectId: "p", media: clips.map((c) => ({ id: c.mediaId, url: `/tmp/${c.mediaId}.mp4`, kind: "video" as const, durationSec: 2 })),
    tracks: clips.map((c, i) => ({ id: `t${i}`, kind: "video" as const, layer: i + 1, muted: false, hidden: false, clips: [c] })),
    transitions: [], subtitles: [],
    output: { width: w, height: h, fps: 25, vcodec: "libx264", crf: 23, withAudio: true },
    totalSec: 2,
  };
}
/** args 里第 n 个 `-i` 的位置（n 从 0 起） */
function inputArgOf(args: string[], n: number): string {
  let seen = -1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-i") continue;
    if (++seen === n) return args[i + 1];
  }
  return "";
}
{
  // clip0：无音轨（要补静音）+ 一个椭圆（要蒙版）；clip1：有音轨 + 一个椭圆
  const c0 = clip(0, { effects: [{ type: "mosaic", mosaicParams: m({ shape: "ellipse" }) }] });
  const c1 = clip(1, { effects: [{ type: "mosaic", mosaicParams: m({ shape: "ellipse", x: 0.5 }) }] });
  const plan = planOf([c0, c1]);
  const segs = buildSegments(plan);
  ok(segs.length === 1, "两条叠加轨归成一个 composite 段", `${segs.length} 段`);
  const { args, inputCount } = compileSegment(segs[0], {
    plan, caps: CAPS_FULL, encoder: "libx264", crf: 23,
    localPath: (id) => `/tmp/${id}.mp4`,
    hasAudio: (id) => id !== "m0",                    // clip0 无音轨
    maskPath: (ci, gi) => `/tmp/mask_c${ci}_g${gi}.gray`,
  }, "/tmp/out.mp4");

  ok(inputCount === 5, "输入总数 = 2 素材 + 2 蒙版 + 1 静音轨", `inputCount=${inputCount}`);
  // 分配顺序：clip0 的蒙版(2) → clip0 的静音(3) → clip1 的蒙版(4)
  ok(inputArgOf(args, 2) === "/tmp/mask_c0_g0.gray", "输入 #2 = clip0 的蒙版", inputArgOf(args, 2));
  ok(inputArgOf(args, 3).startsWith("anullsrc"), "输入 #3 = clip0 的静音轨", inputArgOf(args, 3));
  ok(inputArgOf(args, 4) === "/tmp/mask_c1_g0.gray", "输入 #4 = clip1 的蒙版", inputArgOf(args, 4));

  const fc = args[args.indexOf("-filter_complex") + 1];
  ok(fc.includes("[2:v]format=gray"), "clip0 的滤镜图引用 [2:v] —— 与 -i 的位置一致");
  ok(fc.includes("[4:v]format=gray"), "clip1 的滤镜图引用 [4:v]");
  ok(fc.includes("[3:a]"), "clip0 的音频引用 [3:a]（静音轨），不是 [0:a]");
  ok(!fc.includes("[0:a]"), "无音轨素材绝不直接引用 [0:a]（那是整段导出失败）");

  // 蒙版输入的 -s 必须等于该组框
  const g = planMaskGroups([m({ shape: "ellipse" })], { w: CW, h: CH })[0];
  if (g.kind !== "mask") throw new Error("unreachable");
  const si = args.indexOf("-s");
  ok(si > 0 && args[si + 1] === `${g.box.w}x${g.box.h}`,
    "蒙版输入的 -s 就是组框尺寸（与 crop 同一组整数）", args[si + 1]);
  ok(args.slice(si - 4, si).join(" ") === "-f rawvideo -pix_fmt gray",
    "蒙版按 rawvideo/gray 喂入，不经 PNG 编解码");
  ok(!args.includes("-framerate"), "静态组不加 -framerate（framesync 会重复末帧）");
}
{
  // 动画组要 -framerate；且没有 maskPath 时整段回落
  const anim = m({ shape: "ellipse", keyframes: [
    { tSec: 0, x: 0.2, y: 0.3, w: 0.2, h: 0.1 },
    { tSec: 1.5, x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
  ] });
  const c = clip(0, { effects: [{ type: "mosaic", mosaicParams: anim }] });
  const plan = planOf([c]);
  const base = { plan, caps: CAPS_FULL, encoder: "libx264", crf: 23, localPath: (id: string) => `/tmp/${id}.mp4` };
  const withMask = compileSegment(buildSegments(plan)[0],
    { ...base, maskPath: () => "/tmp/anim.gray" }, "/tmp/o.mp4");
  const fri = withMask.args.indexOf("-framerate");
  ok(fri > 0 && withMask.args[fri + 1] === "25", "动画组加 -framerate=fps（蒙版序列按帧切）");

  const noMask = compileSegment(buildSegments(plan)[0], base, "/tmp/o.mp4");
  ok(noMask.inputCount === 1, "不提供 maskPath ⇒ 不注册任何额外输入", `inputCount=${noMask.inputCount}`);
  ok(!noMask.args.join(" ").includes("alphamerge"), "…且滤镜图里没有 alphamerge");

  const noAlpha = compileSegment(buildSegments(plan)[0],
    { ...base, caps: capsWithout("alphamerge"), maskPath: () => "/tmp/anim.gray" }, "/tmp/o.mp4");
  ok(noAlpha.inputCount === 1 && !noAlpha.args.join(" ").includes("alphamerge"),
    "caps 缺 alphamerge ⇒ 连蒙版输入都不注册（省下白写的文件）");
  ok(noAlpha.args.join(" ").includes("geq="), "…且椭圆回落 geq，形状没有静默丢失");
}

// ───────────────────────────────────────────────────────────
console.log("\n[6] rasterGroupMask：组框 ≠ 区域框，形状不能被铺满拉伸");
// ───────────────────────────────────────────────────────────
{
  // 正圆（1080×1920 上取 w:h = 1:0.5625 才是像素正圆）
  const circle = m({ shape: "ellipse", x: 0.3, y: 0.3, w: 0.2, h: 0.2 * (CW / CH) });
  const g = planMaskGroups([circle], { w: CW, h: CH })[0];
  if (g.kind !== "mask") throw new Error("unreachable");
  const buf = rasterGroupMask([circle], g, { w: CW, h: CH });
  ok(buf.length === g.box.w * g.box.h, "输出字节数 = 组框宽 × 高", `${buf.length}`);

  // 圆度：覆盖像素的宽高之比应≈1（被铺满拉伸时会跟着组框的宽高比走）
  let x0 = g.box.w, x1 = -1, y0 = g.box.h, y1 = -1;
  for (let y = 0; y < g.box.h; y++) for (let x = 0; x < g.box.w; x++) {
    if (buf[y * g.box.w + x] > 127) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  ok(Math.abs(cw / ch - 1) < 0.03, "圆在像素上仍是圆（不随组框宽高比被拉伸）", `${cw}×${ch}`);
  ok(cw <= g.box.w && ch <= g.box.h, "覆盖不超出组框");

  // 多区域组：两个都要出现，不能只有第一个被铺满整框
  const two = [m({ shape: "ellipse", x: 0.2, y: 0.3, w: 0.12, h: 0.07 }),
               m({ shape: "ellipse", x: 0.4, y: 0.3, w: 0.12, h: 0.07 })];
  const g2 = planMaskGroups(two, { w: CW, h: CH })[0];
  if (g2.kind !== "mask" || g2.regionIdxs.length !== 2) throw new Error("本用例需要两区域合成一组");
  const b2 = rasterGroupMask(two, g2, { w: CW, h: CH });
  // 沿中间行扫描：应有两段覆盖被一段空隙隔开
  const midY = Math.floor(g2.box.h / 2);
  let runs = 0, prev = 0;
  for (let x = 0; x < g2.box.w; x++) {
    const v = b2[midY * g2.box.w + x] > 127 ? 1 : 0;
    if (v && !prev) runs++;
    prev = v;
  }
  ok(runs === 2, "两区域组的中间行有**两段**覆盖（铺满拉伸时只会有一段）", `runs=${runs}`);

  // 羽化：软边要真的出现在硬边之外，而不是把形状撑大
  const soft = m({ shape: "ellipse", x: 0.3, y: 0.3, w: 0.2, h: 0.2 * (CW / CH), feather: 20 });
  const gs = planMaskGroups([soft], { w: CW, h: CH })[0];
  if (gs.kind !== "mask") throw new Error("unreachable");
  const bs = rasterGroupMask([soft], gs, { w: CW, h: CH });
  const uniq = new Set<number>();
  for (const v of bs) uniq.add(v);
  ok(uniq.size > 16, "羽化产生连续灰阶（不是二值）", `${uniq.size} 级`);
  const hardCore = bs.filter((v) => v === 255).length;
  const anyCover = bs.filter((v) => v > 0).length;
  ok(hardCore > 0 && anyCover > hardCore * 1.2,
    "软边落在实心区之外（实心 < 总覆盖）", `实心 ${hardCore} / 总 ${anyCover}`);

  // 羽化的外半边必须真的落在**区域自身的框之外**。否则说明模糊是在"刚好贴边"的
  // 缓冲里做的，外半边被盒子直接切掉 —— 画面上只剩向内的一半渐变，看起来像
  // "羽化调了没反应"。`rasterGroupMask` 里那圈 pad = 3r+1 就是为这条存在的。
  const relSoft = regionBoxAt(soft, 0);
  const rox = Math.round(relSoft.x * CW), roy = Math.round(relSoft.y * CH);
  const rwPx = Math.round(relSoft.w * CW), rhPx = Math.round(relSoft.h * CH);
  let outside = 0;
  for (let y = 0; y < gs.box.h; y++) for (let x = 0; x < gs.box.w; x++) {
    if (bs[y * gs.box.w + x] === 0) continue;
    const ax = gs.box.x + x, ay = gs.box.y + y;
    if (ax < rox || ax >= rox + rwPx || ay < roy || ay >= roy + rhPx) outside++;
  }
  ok(outside > 500, "软边展开到了区域框之外（缓冲留够了羽化边距）",
    `框外 ${outside} 像素 / 区域框 ${rwPx}×${rhPx} / 组框 ${gs.box.w}×${gs.box.h}`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[6b] regionBoxAt：动画区域在 t 时刻的框（5.5 的 interpolateRegion 就是它）");
// ───────────────────────────────────────────────────────────
{
  const kf = (tSec: number, x: number) => ({ tSec, x, y: 0.4, w: 0.2, h: 0.1 });
  const anim = m({ shape: "ellipse", keyframes: [kf(1, 0.1), kf(3, 0.5)] });
  ok(regionBoxAt(anim, 0).x === 0.1 && regionBoxAt(anim, 1).x === 0.1,
    "首帧之前夹持为常量（不外推）", `t=0 → x=${regionBoxAt(anim, 0).x}`);
  ok(regionBoxAt(anim, 3).x === 0.5 && regionBoxAt(anim, 99).x === 0.5,
    "末帧之后夹持为常量", `t=99 → x=${regionBoxAt(anim, 99).x}`);
  ok(Math.abs(regionBoxAt(anim, 2).x - 0.3) < 1e-9,
    "区间内线性插值", `t=2 → x=${regionBoxAt(anim, 2).x}`);
  ok(Math.abs(regionBoxAt(anim, 1.5).x - 0.2) < 1e-9, "非中点也线性", `t=1.5 → x=${regionBoxAt(anim, 1.5).x}`);

  const unsorted = m({ shape: "ellipse", keyframes: [kf(3, 0.5), kf(1, 0.1)] });
  ok(Math.abs(regionBoxAt(unsorted, 2).x - 0.3) < 1e-9,
    "关键帧乱序也给同一个结果（UI 可能乱序插入）");

  const one = m({ x: 0.7, keyframes: [kf(1, 0.1)] });
  ok(regionBoxAt(one, 5).x === 0.7,
    "只有 1 条关键帧 ⇒ 按静态处理，用区域自身的 x（与 isAnimated 的判定一致）");

  // tSec 真的被用上了：同一动画组，两个时刻的蒙版必须不同
  const g = planMaskGroups([anim], { w: CW, h: CH })[0];
  if (g.kind !== "mask") throw new Error("unreachable");
  const at1 = rasterGroupMask([anim], g, { w: CW, h: CH }, 1);
  const at3 = rasterGroupMask([anim], g, { w: CW, h: CH }, 3);
  let diff = 0;
  for (let i = 0; i < at1.length; i++) if (at1[i] !== at3[i]) diff++;
  ok(diff > at1.length * 0.05, "动画组在不同 t 上光栅化出不同的蒙版", `${diff} 像素不同`);
  ok(g.box.w >= Math.round(0.5 * CW) - Math.round(0.1 * CW),
    "组框覆盖整段时间的并集（crop 的 w/h 不能动画）", `组框宽 ${g.box.w}`);
}

// ───────────────────────────────────────────────────────────
console.log("\n[7] 真 ffmpeg：新旧两条路径各跑一遍");
// ───────────────────────────────────────────────────────────
const VW = 320, VH = 240;
const src = join(work, "src.mp4");
const run = (a: string[]) => execFileSync(FFMPEG, a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
try {
  run(["-y", "-f", "lavfi", "-i", `color=c=white:s=${VW}x${VH}:r=10:d=1`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", src, "-loglevel", "error"]);
} catch (e) { console.log("  ⚠️ 无法生成测试源：", String(e).slice(0, 160)); }

/** 把一串 mosaic 滤镜包成完整命令跑一遍，返回 stderr（成功则为 ""） */
function runGraph(parts: string[], extraInputs: string[] = [], out?: string): string {
  const o = out ?? join(work, `o${Math.random().toString(36).slice(2)}.mp4`);
  try {
    run(["-y", "-i", src, ...extraInputs,
      "-filter_complex", parts.join(";"), "-map", "[v0]",
      "-frames:v", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", o, "-loglevel", "error"]);
    return "";
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return String(err.stderr || err.message || e);
  }
}
{
  const regions = [m({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }), emptyBrush({ x: 0.6 })];
  // ---- 反证：旧形状（"最后"挂在区域下标上）确实让 ffmpeg 硬失败 ----
  const buggy = compileMosaicFilters("[0:v]", "[v0]", [regions[0]], 0, 0, VW, VH)
    .map((s) => s.replace("[v0]", "[ms0_0_0out]"));      // 手工复现：outLabel 被空笔迹吞掉
  const errOld = runGraph(buggy);
  ok(/does not exist in any defined filter graph/.test(errOld),
    "旧形状：ffmpeg 报 `Output with label 'v0' does not exist…`（整段导出失败）",
    errOld ? errOld.split("\n").filter((l) => /label/.test(l))[0]?.slice(0, 96) : "竟然没报错");

  // ---- 正证：现在同样的区域组合 EXIT=0 ----
  ok(runGraph(compileMosaicFilters("[0:v]", "[v0]", regions, 0, 0, VW, VH)) === "",
    "新形状：矩形 + 末尾空笔迹 ⇒ EXIT=0");
  ok(runGraph(compileMosaicFilters("[0:v]", "[v0]", [emptyBrush()], 0, 0, VW, VH)) === "",
    "新形状：只有一个空笔迹 ⇒ null 直通，EXIT=0");
}
{
  // ---- 蒙版路径实跑 + 像素采样 ----
  const region = m({ shape: "ellipse", style: "blackbox", x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  const groups = planMaskGroups([region], { w: VW, h: VH });
  const g = groups[0];
  if (g.kind !== "mask") throw new Error("unreachable");
  const mp = join(work, "m0.gray");
  writeFileSync(mp, Buffer.from(rasterGroupMask([region], g, { w: VW, h: VH })));
  const opts: MaskCompileOpts = { groups, inputIdx: (gi) => (gi === 0 ? 1 : null) };
  const outMp4 = join(work, "masked.mp4");
  const err = runGraph(compileMosaicFilters("[0:v]", "[v0]", [region], 0, 0, VW, VH, opts),
    ["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${g.box.w}x${g.box.h}`, "-i", mp], outMp4);
  ok(err === "", "蒙版路径实跑 EXIT=0（alphamerge 尺寸对上了）", err.split("\n").slice(-2)[0]?.slice(0, 120) ?? "");

  if (!err) {
    const raw = join(work, "f.rgb");
    run(["-y", "-i", outMp4, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw, "-loglevel", "error"]);
    const px = readFileSync(raw);
    const at = (x: number, y: number) => px[(y * VW + x) * 3];
    const cx = Math.round(VW * 0.5), cy = Math.round(VH * 0.5);
    ok(at(cx, cy) < 40, "椭圆中心被遮成黑", `亮度 ${at(cx, cy)}`);
    ok(at(g.box.x + 1, g.box.y + 1) > 200,
      "组框**角落**（椭圆之外）仍是原图 —— 蒙版真的按形状生效，不是整框糊掉",
      `亮度 ${at(g.box.x + 1, g.box.y + 1)}`);
    ok(at(4, 4) > 200, "区域之外不受影响", `亮度 ${at(4, 4)}`);
  }

  // 反证：蒙版尺寸差 2px ⇒ ffmpeg 硬失败（「缺陷 2」那一整类）
  const bad = join(work, "bad.gray");
  writeFileSync(bad, Buffer.alloc((g.box.w - 2) * g.box.h, 255));
  const errBad = runGraph(compileMosaicFilters("[0:v]", "[v0]", [region], 0, 0, VW, VH, opts),
    ["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${g.box.w - 2}x${g.box.h}`, "-i", bad]);
  ok(/Input frame sizes do not match|do not match/.test(errBad),
    "蒙版宽度差 2px ⇒ `Input frame sizes do not match`（证明「整数只算一次」是承重的）",
    errBad.split("\n").filter((l) => /match/.test(l))[0]?.slice(0, 96) ?? "竟然没报错");
}

// ───────────────────────────────────────────────────────────
console.log("\n[8] 自检：断言真的会红");
// ───────────────────────────────────────────────────────────
{
  // (a) 金样本编的是**真实量化规则**，不是随手抄的一串字符：
  //     blockSize = round(intensity/100*28)+4，sigma = round(intensity/100*30)。
  //     两个数各自独立算一遍再去金样本里找 —— 量化规则一改，这里先红。
  const blockSize50 = Math.round(50 / 100 * 28) + 4;      // = 18
  const sigma70 = Math.round(70 / 100 * 30);              // = 21
  const boxW = Math.max(2, Math.floor(CW * 0.4) & ~1);    // = 432（向下取偶，与 crop 同规则）
  ok(GOLDEN["矩形 + pixel"][1].includes(`scale=iw/${blockSize50}:`)
    && GOLDEN["矩形 + 高斯（不补 scale）"][1].includes(`gblur=sigma=${sigma70}`)
    && GOLDEN["矩形 + pixel"][1].includes(`crop=${boxW}:`),
    "(a) 金样本里的 blockSize/sigma/crop 宽由独立算式复现（改量化规则必红）",
    `blockSize=${blockSize50} sigma=${sigma70} boxW=${boxW}`);

  // (b) 中间标签用的是**区域下标**而不是"第几个发射的"——两种实现在这里才分得开。
  //     区域 0 是空笔迹被跳过，于是真正发射的第一条对应区域 **1**：
  //     标签必须是 ms0_0_1out（若改成按发射序号编号会是 ms0_0_0out）。
  const skipFirst = compileMosaicFilters("[in]", "[out]",
    [emptyBrush(), m({ x: 0.1 }), m({ x: 0.5, style: "blackbox" })], 0, 0, CW, CH);
  ok(skipFirst.length === 4 && skipFirst[2].endsWith("[ms0_0_1out]") && skipFirst[3].startsWith("[ms0_0_1out]"),
    "(b) 跳过空笔迹后中间标签仍按**区域下标**编号（ms0_0_1out）",
    skipFirst[2]?.slice(-16));

  // (c) 组框确实比区域框大：否则 [6] 的"拉伸"根本无从谈起
  const r = m({ shape: "ellipse", x: 0.3, y: 0.3, w: 0.2, h: 0.2 * (CW / CH), feather: 20 });
  const gg = planMaskGroups([r], { w: CW, h: CH })[0];
  if (gg.kind !== "mask") throw new Error("unreachable");
  ok(gg.box.w > Math.round(r.w * CW) + 2,
    "(c) 羽化区域的组框明显大于区域框（拉伸风险是真实存在的）",
    `组框 ${gg.box.w} vs 区域 ${Math.round(r.w * CW)}`);

  // (d) 输入下标不是"猜"出来的：把 maskPath 换成另一批路径，引用必须跟着变
  const c = clip(0, { effects: [{ type: "mosaic", mosaicParams: m({ shape: "ellipse" }) }] });
  const plan = planOf([c], VW, VH);
  const a1 = compileSegment(buildSegments(plan)[0], {
    plan, caps: CAPS_FULL, encoder: "libx264", crf: 23, localPath: () => src,
    hasAudio: () => false, maskPath: () => "/tmp/z.gray",
  }, "/tmp/o.mp4").args;
  // 无音轨 ⇒ 静音输入先于蒙版还是后于蒙版？按代码是"蒙版先分配"（视频段在音频段之前）
  ok(inputArgOf(a1, 1) === "/tmp/z.gray" && inputArgOf(a1, 2).startsWith("anullsrc"),
    "(d) 同一 clip 内：蒙版先分配、静音后分配（顺序被钉住，改了就红）",
    `#1=${inputArgOf(a1, 1)} #2=${inputArgOf(a1, 2).slice(0, 12)}`);
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} ✅ / ${fail} ❌`);
if (fail) process.exit(1);
console.log("✅ 全部通过\n");
