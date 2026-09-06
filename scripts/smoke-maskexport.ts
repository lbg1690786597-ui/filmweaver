/**
 * smoke-maskexport —— **真导出冒烟**：蒙版从产出到 ffmpeg 的整条链（5.8）
 * 跑法：npx tsx scripts/smoke-maskexport.ts   （需要 PATH 上有 ffmpeg / ffprobe）
 *
 * 前四步（typecheck / verify:ui / verify:render / 单测）**都测不到 ffmpeg 是否真肯跑**。
 * 本脚本走的是与产品完全相同的两个函数：
 *
 *     planSegmentMasks + writeSegmentMasks  →  ctx.maskPath  →  compileSegment  →  ffmpeg
 *
 * 蒙版是**当场光栅化**出来的（这正是 Step 2 改用纯 TS 光栅化器的理由：
 * node 下无 DOM，拿预制文件糊弄等于没测）。
 *
 * 覆盖计划书验证第 5、6 项：
 *   · T1 矩形（零回归，**不该注册任何额外输入**）
 *   · T2 静态椭圆 / 画笔
 *   · 羽化
 *   · 3 个动画区域（逐帧蒙版序列）
 *   · 像素对齐：奇数尺寸 / 贴边 / 出画 × pixel|gaussblur|blackbox 各一遍
 *     —— `pixel` 是唯一会改尺寸的效果，缺陷 2 就出在它身上，专门盯
 *
 * 速度栏与 docs/OPTIMIZATION 的性能表对照：**掉速就是悄悄退回了慢路径**。
 * 本机是 540×960 软解 + libx264 软编，绝对值必然低于文档里 `-f null` 的隔离数字；
 * 看的是**同一列内部**的相对关系（蒙版档不该显著慢于矩形档）。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSegment } from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import { planSegmentMasks, writeSegmentMasks, maskClipsOf, type MaskIO } from "../src/render/maskFiles";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type { RenderPlan, RenderClip, MosaicParams } from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const W = 540, H = 960, FPS = 25, DUR = 2;
const work = mkdtempSync(join(tmpdir(), "fwmask-"));
const masks = join(work, "masks");
execFileSync("mkdir", ["-p", masks]);

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};

const sh = (a: string[]) =>
  execFileSync(FFMPEG, a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

// 真实 h264 解码源（不用 testsrc 当输入：程序化生成本身就是瓶颈，会把所有速度压平）
const src = join(work, "src.mp4");
sh(["-y", "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${DUR}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", src, "-loglevel", "error"]);

// 采样用的白底源：testsrc2 自己就有大片深色区域，拿它判「这个点被遮黑了没有」
// 会得到一条**永远绿**的断言（本来就是黑的）。白底让"遮住 = 变黑"成为唯一解释。
const white = join(work, "white.mp4");
sh(["-y", "-f", "lavfi", "-i", `color=c=white:s=${W}x${H}:r=${FPS}:d=${DUR}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", white, "-loglevel", "error"]);

const caps: Capabilities = {
  version: "smoke", available: true, hwEncoders: [],
  filters: new Set(["alphamerge", "overlay", "crop", "scale", "format", "drawbox",
                    "geq", "gblur", "split", "pad", "setpts", "eq", "xfade"]),
  transitions: new Set(["fade"]),
  probedAt: Date.now(),
};

/** node 侧的 MaskIO —— 与 Tauri 那份逐语义对应：append=false 覆盖、true 追加 */
const io: MaskIO = {
  join: async (dir, name) => join(dir, name),
  write: async (p, data, append) => {
    if (append) appendFileSync(p, Buffer.from(data));
    else writeFileSync(p, Buffer.from(data));
  },
};

const m = (p: Partial<MosaicParams>): MosaicParams => ({
  x: 0.2, y: 0.3, w: 0.3, h: 0.2, style: "pixel", intensity: 50, ...p,
});

function mkPlan(mosaics: MosaicParams[]): RenderPlan {
  const c: RenderClip = {
    id: "c0", mediaId: "m0", timelineStartSec: 0, durationSec: DUR,
    sourceInSec: 0, sourceDurationSec: DUR, speed: 1,
    // 给个非恒等变换，强制走 composite 分支（马赛克本来也只在那条路上）
    transform: { ...DEFAULT_TRANSFORM, scale: 0.999 },
    effects: mosaics.map((mp) => ({ type: "mosaic" as const, mosaicParams: mp })),
    audio: { ...DEFAULT_AUDIO },
  };
  return {
    projectId: "smoke",
    media: [{ id: "m0", url: src, kind: "video", durationSec: DUR }],
    tracks: [{ id: "v1", kind: "video", layer: 1, muted: false, hidden: false, clips: [c] }],
    transitions: [], subtitles: [],
    output: { width: W, height: H, fps: FPS, vcodec: "libx264", crf: 28, withAudio: false },
    totalSec: DUR,
  };
}

interface Res { err: string; sec: number; maskInputs: number; masks: number; out: string }

/** 跑完整一段：产蒙版 → 编译 → 真跑 ffmpeg。返回耗时与实际注册的蒙版输入数。 */
async function runCase(name: string, mosaics: MosaicParams[], from = src): Promise<Res> {
  for (const f of readdirSync(masks)) rmSync(join(masks, f));
  const plan = mkPlan(mosaics);
  const segs = buildSegments(plan);
  const mplan = planSegmentMasks(0, maskClipsOf(segs[0].clips), { w: W, h: H }, FPS);
  const table = await writeSegmentMasks(masks, mplan, io);
  const ctx = {
    plan, caps, encoder: "libx264", crf: 28,
    localPath: () => from,
    hasAudio: () => false,
    maskPath: (ci: number, gi: number) => table.get(`${ci}:${gi}`) ?? null,
  };
  const out = join(work, `${name.replace(/\W/g, "")}.mp4`);
  const { args } = compileSegment(segs[0], ctx, out);
  // 数 `-f rawvideo` 而不是 `-i`：额外输入里还有一路补静音的 anullsrc，
  // 数 `-i` 会把它一起算进来，得到一个"总是多 1"的假数字。
  const maskInputs = args.filter((a) => a === "rawvideo").length;
  const t0 = Date.now();
  let err = "";
  try { sh([...args, "-loglevel", "error"]); }
  catch (e: unknown) {
    const x = e as { stderr?: string; message?: string };
    err = String(x.stderr || x.message || e);
  }
  return { err, sec: (Date.now() - t0) / 1000, maskInputs, masks: table.size, out };
}

/** 取成片首帧的某个像素亮度（rgb24 的 R 通道） */
function pixel(mp4: string, x: number, y: number): number {
  const raw = join(work, "f.rgb");
  sh(["-y", "-i", mp4, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw, "-loglevel", "error"]);
  return readFileSync(raw)[(y * W + x) * 3];
}

const rows: string[] = [];
const record = (name: string, r: Res) =>
  rows.push(`${name.padEnd(28)} ${(DUR / r.sec).toFixed(2).padStart(6)}×  `
    + `${String(r.maskInputs).padStart(2)} 路蒙版输入  ${r.err ? "❌" : "EXIT=0"}`);

async function main() {
  // ───────── [1] T1 零回归：矩形不该产生任何蒙版 ─────────
  console.log("\n[1] T1 矩形（零回归）");
  {
    const r = await runCase("t1-rect", [m({}), m({ x: 0.6, y: 0.1, style: "blackbox" })]);
    ok(r.err === "", "两个纯矩形区域 EXIT=0", r.err.split("\n").slice(-2)[0]?.slice(0, 110) ?? "");
    ok(r.masks === 0, "没有产出任何蒙版文件", `${r.masks}`);
    ok(r.maskInputs === 0, "**没有注册任何蒙版输入** —— 走的还是既有 drawbox/overlay 路径");
    ok(readdirSync(masks).length === 0, "蒙版目录是空的");
    record("T1 矩形（legacy）", r);
  }

  // ───────── [2] T2 静态形状 ─────────
  console.log("\n[2] T2 静态椭圆 / 画笔 / 羽化");
  {
    const r = await runCase("t2-ellipse",
      [m({ shape: "ellipse", style: "blackbox", x: 0.25, y: 0.35, w: 0.5, h: 0.3 })], white);
    ok(r.err === "", "静态椭圆 EXIT=0", r.err.split("\n").slice(-2)[0]?.slice(0, 110) ?? "");
    ok(r.maskInputs === 1, "注册了 1 路蒙版输入", `${r.maskInputs}`);
    if (!r.err) {
      const cx = Math.round(W * 0.5), cy = Math.round(H * 0.5);
      ok(pixel(r.out, cx, cy) < 40, "椭圆中心被遮黑", `亮度 ${pixel(r.out, cx, cy)}`);
      // 包围盒左上角在椭圆之外 —— 若误用 rasterRegionMask 把形状铺满整框，这里会变黑
      const bx = Math.round(W * 0.25) + 3, by = Math.round(H * 0.35) + 3;
      ok(pixel(r.out, bx, by) > 200,
        "包围盒角落（椭圆外）**没有**被遮 —— 蒙版按形状生效，不是整框糊掉",
        `亮度 ${pixel(r.out, bx, by)}`);
      ok(pixel(r.out, 4, 4) > 200, "区域之外完全不受影响", `亮度 ${pixel(r.out, 4, 4)}`);
    }
    record("T2 静态椭圆", r);

    const stroke = Array.from({ length: 24 }, (_, i) =>
      ({ x: 0.25 + i * 0.02, y: 0.5 + Math.sin(i / 3) * 0.06 }));
    const rb = await runCase("t2-brush",
      [m({ shape: "brush", stroke, brushSize: 0.07, style: "gaussblur", intensity: 70 })]);
    ok(rb.err === "", "24 点画笔笔迹 EXIT=0（不再受 MAX_PTS=60 的表达式长度限制）",
      rb.err.split("\n").slice(-2)[0]?.slice(0, 110) ?? "");
    record("T2 画笔（gaussblur）", rb);

    const rf = await runCase("t2-feather",
      [m({ shape: "ellipse", feather: 40, style: "blackbox", x: 0.3, y: 0.4, w: 0.4, h: 0.2 })]);
    ok(rf.err === "", "羽化 40% EXIT=0", rf.err.split("\n").slice(-2)[0]?.slice(0, 110) ?? "");
    record("羽化 40%", rf);
  }

  // ───────── [3] 动画：3 个区域 ─────────
  console.log("\n[3] 3 个动画区域（逐帧蒙版序列）");
  {
    const kf = (x0: number, y0: number, x1: number, y1: number) => [
      { tSec: 0, x: x0, y: y0, w: 0.16, h: 0.09 },
      { tSec: DUR, x: x1, y: y1, w: 0.16, h: 0.09 },
    ];
    const r = await runCase("t3-anim", [
      m({ shape: "ellipse", keyframes: kf(0.05, 0.10, 0.60, 0.20) }),
      m({ shape: "ellipse", style: "gaussblur", intensity: 60, keyframes: kf(0.70, 0.40, 0.10, 0.50) }),
      m({ shape: "rect", style: "blackbox", feather: 20, keyframes: kf(0.20, 0.75, 0.55, 0.85) }),
    ]);
    ok(r.err === "", "3 个动画区域 EXIT=0", r.err.split("\n").slice(-2)[0]?.slice(0, 110) ?? "");
    ok(r.masks >= 1, "确实产出了蒙版", `${r.masks} 个`);
    const files = readdirSync(masks);
    const big = files.map((f) => readFileSync(join(masks, f)).length);
    ok(big.every((b) => b > 0), "每个蒙版文件都不是 0 字节");
    ok(Math.max(...big) > W * H / 8,
      "至少有一个是**多帧序列**（不是被悄悄退化成单帧）", `${Math.max(...big)} B`);
    record("T3 3 个动画区域", r);
  }

  // ───────── [4] 像素对齐 ×（奇数 / 贴边 / 出画）×（三种效果）─────────
  console.log("\n[4] 像素对齐：奇数尺寸 / 贴边 / 出画 × pixel|gaussblur|blackbox");
  {
    const geo: Array<[string, Partial<MosaicParams>]> = [
      ["奇数尺寸", { x: 0.1237, y: 0.4319, w: 0.1357, h: 0.0913 }],
      ["贴左上边", { x: 0, y: 0, w: 0.2001, h: 0.1501 }],
      ["贴右下边", { x: 0.7899, y: 0.8501, w: 0.2101, h: 0.1499 }],
      ["部分出画", { x: -0.07, y: 0.55, w: 0.22, h: 0.14 }],
    ];
    const styles: MosaicParams["style"][] = ["pixel", "gaussblur", "blackbox"];
    let bad = 0, mismatch = 0, n = 0;
    for (const [gname, g] of geo) {
      for (const style of styles) {
        n++;
        const r = await runCase(`al-${n}`,
          [m({ ...g, style, intensity: 60, shape: "ellipse", feather: 15 })]);
        if (r.err) {
          bad++;
          if (/do not match/.test(r.err)) mismatch++;
          console.log(`     ↳ ${gname} · ${style}: ${r.err.split("\n").filter((l) => l.trim())[0]?.slice(0, 120)}`);
        }
      }
    }
    ok(mismatch === 0,
      `没有一例报 \`Input frame sizes do not match\`（「整数只算一次」成立）`, `${n} 例`);
    ok(bad === 0, `${n} 例像素对齐用例全部 EXIT=0`, bad ? `${bad} 例失败` : "");
  }

  console.log("\n速度对照（540×960 软解软编，看的是同列相对关系）：");
  console.log("-".repeat(70));
  for (const r of rows) console.log("  " + r);
  console.log("-".repeat(70));

  console.log(`\n${pass} ✅ / ${fail} ❌`);
  console.log(fail === 0 ? "✅ 真导出冒烟全部通过" : "❌ 存在失败");
  rmSync(work, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

void main();
