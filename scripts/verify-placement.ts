/**
 * verify-placement —— 画面定位（缩放 / 位移 / 铺回画布）验证
 * 跑法：npx tsx scripts/verify-placement.ts
 *
 * 这个脚本是 `src/render/placement.ts` 那 5 个缺陷的**回归网**。每一条都不是
 * "函数返回了个对象"，而是**当年那个故障会以什么形式重现**：
 *
 *   缺陷 1 放大 >100% → `pad` 报 `Padded dimensions cannot be smaller than
 *          input dimensions`，**整段导出失败**。→ 断言真 ffmpeg EXIT=0。
 *   缺陷 2 位移在 scale=1 下完全无效，且 EXIT=0 不报错。
 *          → 断言画面**真的挪了**：采样输出帧的亮度剖面，不是断言滤镜串里有个数。
 *   缺陷 3 叠加层补边是不透明黑，把下层整个盖住。→ 断言底层像素还在。
 *   缺陷 4 非等比缩放被 `foar=decrease` 压成等比。→ 断言宽被拉、高没动。
 *   缺陷 5 `isIdentityTransform` 漏看 scaleX/scaleY → 单轴拉伸的镜头被判 passthrough，
 *          变换整个丢掉。→ 断言 `buildSegments` 给的是 composite。
 *
 * 还有一条**反向**承重断言：`needsPlacement` 返回 false 那一档，滤镜串必须与
 * 老写法**逐字一致**。它是导出基线只动了 1 个场景的依据；这条一红，说明
 * "只有带位移/放大/非等比的镜头受影响"这个说法就不成立了。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  planPlacement, needsPlacement, fitFilters, placeFilters,
} from "../src/render/placement";
import type { PlacementInput } from "../src/render/placement";
import { compileSegment } from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import {
  DEFAULT_TRANSFORM, DEFAULT_AUDIO, isIdentityTransform, clipNeedsFilter,
} from "../src/render/model";
import type { RenderPlan, RenderClip, RenderTransform } from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const W = 320, H = 240, FPS = 10;

console.log("\n══ 画面定位（render/placement）══\n");

/* ═══════════════════════════════════════════════════════════════════
 * [1] planPlacement：整数几何
 * ═══════════════════════════════════════════════════════════════ */
console.log("[1] planPlacement 的整数几何");

const pin = (o: Partial<PlacementInput> = {}): PlacementInput =>
  ({ scaleX: 1, scaleY: 1, x: 0, y: 0, ...o });

{
  const p = planPlacement(1080, 1920, pin());
  ok(p.scaledW === 1080 && p.scaledH === 1920, "恒等：尺寸就是画布", `${p.scaledW}×${p.scaledH}`);
  ok(p.padX === 0 && p.padY === 0 && p.cropX === 0 && p.cropY === 0, "恒等：四个落点全 0");
  ok(placeFilters(1080, 1920, p, false).length === 0, "恒等：一条滤镜都不产出（不是产出 no-op）");
}
{
  // fitFilters：把源钉成已知的 W×H —— 后面每个整数偏移都建立在这一步上
  const f = fitFilters(1080, 1920, false);
  ok(f.length === 2 && f[0].includes("force_original_aspect_ratio=decrease")
     && f[1].startsWith("pad=1080:1920:"),
     "fitFilters：先按比例装进画布，再补边把尺寸钉死（RenderClip 不带源宽高，"
     + "不钉死就没法在 TS 里算整数偏移）", f.join(","));
  const ft = fitFilters(1080, 1920, true);
  ok(ft.includes("format=yuva420p") && ft[2].endsWith(":black@0"),
     "叠加层：补边透明，且先切到带 alpha 的像素格式（少这一句 @0 会被当成不透明黑）",
     ft.join(","));
}
{
  // 正向位移：画面往右挪 100 → pad 落点 100，crop 落点 0
  const p = planPlacement(1080, 1920, pin({ x: 100 }));
  ok(p.offsetX === 100 && p.padX === 100 && p.cropX === 0, "正向位移落在 pad 上", `padX=${p.padX}`);
  ok(p.padW === 1180, "中间画布装得下挪过的画面", `padW=${p.padW}`);
}
{
  // 负向位移：画面往左挪 100 → 画面自己不能挪到负坐标，改由取景窗右移
  const p = planPlacement(1080, 1920, pin({ x: -100 }));
  ok(p.offsetX === -100 && p.padX === 0 && p.cropX === 100, "负向位移落在 crop 上", `cropX=${p.cropX}`);
  ok(p.padW === 1180, "中间画布装得下挪过的取景窗", `padW=${p.padW}`);
}
{
  // 缺陷 1 的算术侧：放大 1.2 不再产出"比 pad 目标还大"的中间尺寸
  const p = planPlacement(1080, 1920, pin({ scaleX: 1.2, scaleY: 1.2 }));
  ok(p.scaledW === 1296 && p.scaledH === 2304, "放大后的尺寸如实", `${p.scaledW}×${p.scaledH}`);
  ok(p.padW >= p.scaledW && p.padH >= p.scaledH,
     "中间画布 ≥ 画面（老写法正是在这里报 Padded dimensions cannot be smaller）",
     `${p.padW}×${p.padH} ≥ ${p.scaledW}×${p.scaledH}`);
  ok(p.offsetX === -108 && p.cropX === 108, "放大时取景窗内缩，多出来的部分被裁", `cropX=${p.cropX}`);
}
{
  // 缺陷 4 的算术侧：两个轴各算各的，不互相牵制
  const p = planPlacement(1080, 1920, pin({ scaleX: 0.5, scaleY: 1 }));
  ok(p.scaledW === 540 && p.scaledH === 1920, "非等比：宽减半、高不动", `${p.scaledW}×${p.scaledH}`);
  ok(!placeFilters(1080, 1920, p, false)[0].includes("force_original_aspect_ratio"),
     "非等比这句 scale **不带** foar（带上就又被压回等比了）");
}
{
  // 取偶：yuv420p 的色度是 2×2 抽样，奇数偏移会被 ffmpeg **自己**改掉
  const p = planPlacement(1080, 1920, pin({ x: 101 }));
  ok(p.padX % 2 === 0 && p.padY % 2 === 0 && p.cropX % 2 === 0 && p.cropY % 2 === 0,
     "落点一律偶数（把'谁来对齐'这件事定死在 TS 里）", `padX=${p.padX}`);
  ok(planPlacement(1080, 1920, pin({ scaleX: 0.333, scaleY: 0.333 })).scaledW % 2 === 0,
     "缩放尺寸也取偶");
  ok(planPlacement(100, 100, pin({ scaleX: 0.001, scaleY: 0.001 })).scaledW === 2,
     "缩到 0 也保底 2px（scale=0 会让整条链失败）");
}

/* ═══════════════════════════════════════════════════════════════════
 * [2] needsPlacement：快路径边界（基线不变的依据）
 * ═══════════════════════════════════════════════════════════════ */
console.log("\n[2] needsPlacement 的快路径边界");

ok(needsPlacement(pin(), false) === false, "恒等、非叠加 → 走老路径");
ok(needsPlacement(pin({ scaleX: 0.8, scaleY: 0.8 }), false) === false,
   "等比**缩小** → 仍走老路径（老写法这一档本来就是对的，不为整齐多一次重采样）");
ok(needsPlacement(pin(), true) === true,
   "叠加层即使恒等也要走新路径（否则黑边盖住下层 = 缺陷 3）");
ok(needsPlacement(pin({ x: 1 }), false) === true, "有位移 → 新路径（缺陷 2）");
ok(needsPlacement(pin({ y: -1 }), false) === true, "有垂直位移 → 新路径");
ok(needsPlacement(pin({ scaleX: 1.01, scaleY: 1.01 }), false) === true,
   "放大 → 新路径（缺陷 1）");
ok(needsPlacement(pin({ scaleX: 0.5, scaleY: 1 }), false) === true,
   "非等比 → 新路径（缺陷 4）");

/* ═══════════════════════════════════════════════════════════════════
 * [3] 缺陷 5：isIdentityTransform 必须看 scaleX/scaleY
 * ═══════════════════════════════════════════════════════════════ */
console.log("\n[3] 缺陷 5：单轴拉伸不能被判成'什么都没做'");

const tr = (o: Partial<RenderTransform> = {}): RenderTransform =>
  ({ ...DEFAULT_TRANSFORM, ...o });

ok(isIdentityTransform(tr()) === true, "对照组：真恒等仍判恒等");
ok(isIdentityTransform(tr({ scaleX: 0.5 })) === false, "scaleX 单轴 → 非恒等");
ok(isIdentityTransform(tr({ scaleY: 1.5 })) === false, "scaleY 单轴 → 非恒等");
ok(isIdentityTransform(tr({ scaleX: 1, scaleY: 1 })) === true,
   "显式写了 1 的 scaleX/scaleY 仍算恒等（老数据不写、新数据写 1，两者不能分家）");
ok(clipNeedsFilter({ ...mkClip(0), transform: tr({ scaleX: 0.5 }) }) === true,
   "单轴拉伸的 clip 需要滤镜");

/* ═══════════════════════════════════════════════════════════════════
 * 以下要真 ffmpeg
 * ═══════════════════════════════════════════════════════════════ */
function mkClip(i: number, over: Partial<RenderClip> = {}): RenderClip {
  return {
    id: `c${i}`, mediaId: `m${i}`, timelineStartSec: 0, durationSec: 1,
    sourceInSec: 0, sourceDurationSec: 1, speed: 1,
    transform: { ...DEFAULT_TRANSFORM }, effects: [], audio: { ...DEFAULT_AUDIO },
    ...over,
  };
}

const caps: Capabilities = {
  version: "test", available: true, hwEncoders: [],
  filters: new Set(["xfade", "overlay", "blend", "eq", "crop", "scale", "pad",
    "rotate", "setpts", "format", "colorchannelmixer", "split", "volume",
    "anullsrc", "amix", "afade", "atempo"]),
  transitions: new Set<string>(),
  probedAt: Date.now(),
};

const work = mkdtempSync(join(tmpdir(), "fw-place-"));
try {
  const sh = (a: string[]) => execFileSync(FFMPEG, a,
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

  /** 纯色素材。用纯色而不是 testsrc：要断言的是"哪块地方是什么颜色"，
   *  花纹只会让采样读到的数字没法解释。 */
  const solid = (name: string, color: string): string => {
    const p = join(work, `${name}.mp4`);
    sh(["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:d=1:r=${FPS}`,
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p",
        "-loglevel", "error", p]);
    return p;
  };
  const white = solid("white", "white");
  const black = solid("black", "black");

  function mkPlan(clips: RenderClip[], urls: string[], layers = 1): RenderPlan {
    const tracks = layers === 1
      ? [{ id: "v1", kind: "video" as const, layer: 1, muted: false, hidden: false, clips }]
      : [
          { id: "v1", kind: "video" as const, layer: 1, muted: false, hidden: false, clips: [clips[0]] },
          { id: "v2", kind: "video" as const, layer: 2, muted: false, hidden: false, clips: clips.slice(1) },
        ];
    return {
      projectId: "place",
      media: clips.map((c, i) => ({
        id: c.mediaId, url: urls[i], kind: "video" as const, durationSec: 1,
      })),
      tracks, transitions: [], subtitles: [],
      output: { width: W, height: H, fps: FPS, vcodec: "libx264", crf: 18, withAudio: false },
      totalSec: 1,
    };
  }

  /** 编译并渲染一个 plan，返回**第一帧的灰度像素**（长度 W*H）。
   *  编译失败/渲染失败都返回 null，并把 stderr 尾巴带出来。 */
  function renderGray(tag: string, plan: RenderPlan): { px: Uint8Array | null; err: string } {
    const segs = buildSegments(plan);
    const ctx = {
      plan, caps, encoder: "libx264", crf: 18,
      localPath: (id: string) => plan.media.find((m) => m.id === id)!.url,
    };
    const mp4 = join(work, `${tag}.mp4`);
    const raw = join(work, `${tag}.gray`);
    try {
      // 只测单段：这些用例都只有一两个同时存在的 clip
      sh([...compileSegment(segs[0], ctx, mp4).args, "-loglevel", "error"]);
      sh(["-y", "-i", mp4, "-frames:v", "1",
          "-f", "rawvideo", "-pix_fmt", "gray", "-loglevel", "error", raw]);
      return { px: new Uint8Array(readFileSync(raw)), err: "" };
    } catch (e: unknown) {
      const x = e as { stderr?: string; message?: string };
      return { px: null, err: String(x.stderr ?? x.message ?? "").split("\n")
        .filter((l) => /Error|Invalid|cannot|failed/i.test(l)).slice(0, 2).join(" / ") };
    }
  }

  /** 中间那一行的横向亮度剖面，切成 n 段取均值 —— 比逐像素断言耐编码噪声。 */
  const rowProfile = (px: Uint8Array, n: number, row = H >> 1): number[] => {
    const out: number[] = [];
    const seg = W / n;
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let x = Math.ceil(i * seg); x < Math.ceil((i + 1) * seg); x++) { s += px[row * W + x]; c++; }
      out.push(Math.round(s / c));
    }
    return out;
  };
  const colProfile = (px: Uint8Array, n: number, col = W >> 1): number[] => {
    const out: number[] = [];
    const seg = H / n;
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let y = Math.ceil(i * seg); y < Math.ceil((i + 1) * seg); y++) { s += px[y * W + col]; c++; }
      out.push(Math.round(s / c));
    }
    return out;
  };

  /* ---------------- [4] 快路径逐字不变 ---------------- */
  console.log("\n[4] 快路径的滤镜串与老写法逐字一致（基线只动 1 个场景的依据）");
  {
    const plan = mkPlan([mkClip(0, { transform: tr({ scale: 0.8, scaleX: 0.8, scaleY: 0.8 }) })], [white]);
    const segs = buildSegments(plan);
    const ctx = { plan, caps, encoder: "libx264", crf: 18,
                  localPath: (id: string) => plan.media.find((m) => m.id === id)!.url };
    const argv = compileSegment(segs[0], ctx, join(work, "fast.mp4")).args.join(" ");
    const legacy = `scale=${Math.round(W * 0.8)}:${Math.round(H * 0.8)}`
      + `:force_original_aspect_ratio=decrease`;
    ok(argv.includes(legacy), "老那句 scale 原样还在", legacy);
    ok(argv.includes(`pad=${W}:${H}:(ow-iw)/2+(0):(oh-ih)/2+(0):black`),
       "老那句 pad 原样还在（含 +(0) 这种看着多余、但基线逐字节靠它的写法）");
    ok(!argv.includes(`scale=${Math.round(W * 0.8)}:${Math.round(H * 0.8)},`),
       "快路径**没有**混进新链那句无 foar 的 scale");
  }

  /* ---------------- [5] 缺陷 1：放大 >100% 不再整段失败 ---------------- */
  console.log("\n[5] 缺陷 1：放大 120% —— 老写法在这里整段导出失败");
  {
    const r = renderGray("zoomin", mkPlan(
      [mkClip(0, { transform: tr({ scale: 1.2, scaleX: 1.2, scaleY: 1.2 }) })], [white]));
    ok(r.px !== null, "EXIT=0（不再报 Padded dimensions cannot be smaller）", r.err);
    if (r.px) {
      ok(r.px.length === W * H, "输出仍是画布尺寸（放大溢出的部分被裁掉，不是把画布撑大）",
         `${r.px.length} = ${W}×${H}`);
      const prof = rowProfile(r.px, 8);
      ok(prof.every((v) => v > 200), "整幅仍是白的（放大后铺满，不该出现黑边）", prof.join(","));
    }
  }

  /* ---------------- [6] 缺陷 2：位移在 scale=1 下真的生效 ---------------- */
  console.log("\n[6] 缺陷 2：scale=100% 时的位移 —— 老写法在这里静默无效");
  {
    const dx = 80;   // 画布 320 宽，往右挪 1/4
    const r = renderGray("shift", mkPlan(
      [mkClip(0, { transform: tr({ x: dx }) })], [white]));
    ok(r.px !== null, "EXIT=0", r.err);
    if (r.px) {
      const prof = rowProfile(r.px, 8);       // 每段 40px
      // 左边两段（0..80）应当是补边的黑，右边应当是白
      ok(prof[0] < 40 && prof[1] < 40, "左侧 80px 变成补边（画面确实往右挪了）", prof.join(","));
      ok(prof[3] > 200 && prof[7] > 200, "右侧仍是画面", prof.join(","));
    }
    // 反向：往左挪，黑边应当出现在**右**边。同一个量、镜像的结论 ——
    // 只测一个方向的话，"整幅都黑"这种坏掉的实现也会让上面那条变绿。
    const r2 = renderGray("shiftneg", mkPlan(
      [mkClip(0, { transform: tr({ x: -dx }) })], [white]));
    ok(r2.px !== null, "反向位移 EXIT=0", r2.err);
    if (r2.px) {
      const prof = rowProfile(r2.px, 8);
      ok(prof[6] < 40 && prof[7] < 40, "右侧 80px 变成补边", prof.join(","));
      ok(prof[0] > 200 && prof[4] > 200, "左侧仍是画面", prof.join(","));
    }
  }

  /* ---------------- [7] 缺陷 4：非等比真的单轴拉伸 ---------------- */
  console.log("\n[7] 缺陷 4：非等比缩放 —— 老写法在这里被压成等比");
  {
    // 宽减半、高不变：竖直方向必须**满幅**白，横向必须只有中间一半白。
    // 若被压成等比（老行为），高也会缩一半，纵向剖面首尾就是黑的。
    const r = renderGray("nonuni", mkPlan(
      [mkClip(0, { transform: tr({ scaleX: 0.5, scaleY: 1 }) })], [white]));
    ok(r.px !== null, "EXIT=0", r.err);
    if (r.px) {
      const row = rowProfile(r.px, 8);
      ok(row[0] < 40 && row[7] < 40, "横向：两侧被补边（宽确实减半了）", row.join(","));
      ok(row[3] > 200 && row[4] > 200, "横向：中间是画面", row.join(","));
      const col = colProfile(r.px, 8);
      ok(col.every((v) => v > 200), "纵向：**满幅**白 —— 高没有跟着缩（这条就是缺陷 4）",
         col.join(","));
    }
  }

  /* ---------------- [8] 缺陷 3：叠加层不再把下层涂黑 ---------------- */
  console.log("\n[8] 缺陷 3：画中画 —— 老写法的黑色补边会盖住整个下层");
  {
    // 底层白、叠加层黑且缩到 40%。补边若是不透明黑，整幅都会变黑；
    // 补边若是透明的，只有中间 40% 是黑、四周仍见白底。
    const base = mkClip(0);
    const over = mkClip(1, { transform: tr({ scale: 0.4, scaleX: 0.4, scaleY: 0.4 }) });
    const r = renderGray("pip", mkPlan([base, over], [white, black], 2));
    ok(r.px !== null, "EXIT=0", r.err);
    if (r.px) {
      const row = rowProfile(r.px, 10);
      ok(row[0] > 200 && row[9] > 200,
         "四周仍是白底 —— 叠加层的补边是透明的（这条就是缺陷 3）", row.join(","));
      ok(row[4] < 40 && row[5] < 40, "中间是叠加进来的黑画面", row.join(","));
    }
  }

  /* ---------------- [9] 缺陷 5：单轴拉伸不会被路由到 passthrough ---------------- */
  console.log("\n[9] 缺陷 5：分段器不能把单轴拉伸的镜头判成 passthrough");
  {
    const stretched = mkPlan([mkClip(0, { transform: tr({ scaleX: 0.5, scaleY: 1 }) })], [white]);
    ok(buildSegments(stretched)[0].kind === "composite",
       "单轴拉伸 → composite（passthrough 的 -vf 里根本没有 transform，会静默丢掉整个变换）",
       buildSegments(stretched)[0].kind);
    const plain = mkPlan([mkClip(0)], [white]);
    ok(buildSegments(plain)[0].kind === "passthrough",
       "对照组：真恒等仍走 passthrough（没有把所有镜头都推进慢路径）",
       buildSegments(plain)[0].kind);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 画面定位：${pass} ✅ / ${fail} ❌\n`);
process.exit(fail === 0 ? 0 : 1);
