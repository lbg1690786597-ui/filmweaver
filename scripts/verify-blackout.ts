/**
 * verify-blackout — P2-7「留黑」的四层验证
 *
 * 跑法：npx tsx scripts/verify-blackout.ts（已挂进 `npm run verify:render`）
 *
 * ## 这个脚本要钉住的是什么
 *
 * 留黑与「停用」（7.2 的 `disabled`）是整个编辑器里**最容易混的一对**，
 * 而它们的时间语义正好相反：
 *
 *   停用 = 这一镜不在成片里（不占时间、字幕合拢到后继镜头）
 *   留黑 = 这一镜在成片里，只是画面被填黑（占满原时长、声音与字幕照旧）
 *
 * 所以本脚本的重点不是"drawbox 有没有出现在参数里"（那只是装饰性断言），
 * 而是**这四件承重的事**：
 *
 *   ① 两条编译路径**都**得盖上黑 —— composite 走 `clipVideoChain`，
 *      passthrough 有自己独立的一条 `-vf`。只改一条的后果极其隐蔽：
 *      留黑对「加了转场/叠加」的镜头生效、对普通单镜头不生效，而后者是绝大多数
 *      （`segment.ts:154` 的判据）。这与 2026-08-29 那个「passthrough 没应用
 *      音频链」是同一类漏，专门用两路对照钉住。
 *   ② 不留黑时 passthrough 的 `-vf` 必须**逐字符不变** —— 那条链被导出基线
 *      （`scripts/__baseline__/export-argv.json`，44150 字节）逐字节比对着，
 *      为了插一个滤镜把它从字符串改写成数组，就得证明改写没有副产物。
 *   ③ 时间语义 —— 留黑**不改**任何时长/起点，停用改。这是它与停用的分界线。
 *   ④ 画面**真的是黑的** —— 前三条全绿也可能只是参数拼对了，ffmpeg 未必买账。
 *      最后一节真跑一遍并逐像素采样，且带一个**对照组**（同一次导出里
 *      不留黑的那一镜必须不黑），否则"全黑"也可能是我把整段导挂了。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSegment, compileConcat } from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import { normalize } from "../src/render/normalize";
import { buildTimeline } from "../src/adapters/shotToClip";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO, clipHasMosaic, clipNeedsFilter } from "../src/render/model";
import type { RenderPlan, RenderClip, RenderOutput } from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";
// 只当类型用：`src/api.ts` 顶上读 `import.meta.env`，值导入会让本脚本在 node 下炸。
import type { ShotInfo } from "../src/api";
import { describeTransform } from "../src/lib/transformLabel";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/** 留黑滤镜的字面量。**故意在这里再写一遍**而不是从编译器导出：
 *  两边同源的话，把编译器里那句改坏了本脚本会跟着一起变，断言等于没有。 */
const DRAWBOX = "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill";

/* ================= 第 1 节：编译期（两条路径都要盖黑） ================= */

const W = 320, H = 240, FPS = 10;
const OUT: RenderOutput = {
  width: W, height: H, fps: FPS, vcodec: "libx264", crf: 23, withAudio: true,
};

const caps: Capabilities = {
  version: "test", available: true, hwEncoders: [],
  filters: new Set(["xfade", "overlay", "blend", "eq", "colorbalance", "unsharp",
    "gblur", "boxblur", "vignette", "noise", "rgbashift", "crop", "curves",
    "lut3d", "amix", "volume", "atempo", "afade", "scale", "pad", "rotate",
    "setpts", "anullsrc", "colorchannelmixer", "subtitles", "split", "drawbox",
    "alphamerge", "format", "geq"]),
  transitions: new Set<string>(),
  probedAt: Date.now(),
};

function clip(i: number, over: Partial<RenderClip> = {}): RenderClip {
  return {
    id: `c${i}`, mediaId: `m${i}`, timelineStartSec: i * 2, durationSec: 2,
    sourceInSec: 0, sourceDurationSec: 2, speed: 1,
    transform: { ...DEFAULT_TRANSFORM }, effects: [], audio: { ...DEFAULT_AUDIO },
    ...over,
  };
}

function mkPlan(clips: RenderClip[], urls: string[]): RenderPlan {
  return {
    projectId: "bo",
    media: clips.map((c, i) => ({
      id: c.mediaId, url: urls[i % urls.length], kind: "video" as const, durationSec: 2,
    })),
    tracks: [{ id: "v1", kind: "video" as const, layer: 1, muted: false, hidden: false, clips }],
    transitions: [], subtitles: [], output: OUT,
    totalSec: Math.max(...clips.map((c) => c.timelineStartSec + c.durationSec)),
  };
}

/** 编译单 clip 的第 0 段，返回参数数组（不跑 ffmpeg） */
function argvOf(c: RenderClip): string[] {
  const plan = mkPlan([c], ["/fake/a.mp4"]);
  const ctx = {
    plan, caps, encoder: "libx264", crf: 23,
    localPath: (id: string) => plan.media.find((m) => m.id === id)!.url,
  };
  return compileSegment(buildSegments(plan)[0], ctx, "/tmp/out.mp4").args;
}
const flagOf = (argv: string[], flag: string): string => {
  const i = argv.indexOf(flag);
  return i < 0 ? "" : argv[i + 1];
};

console.log("=== 1. passthrough 路径（普通单镜头，绝大多数镜头走这里）===");

// 前提先钉住：只开留黑的镜头**仍然**符合 passthrough 的判据。
// 如果哪天有人顺手把 blackout 加进 clipNeedsFilter，这一节测的就不再是
// passthrough 了，但断言仍会全绿 —— 先在这里拦一道。
ok("只开留黑的镜头仍走 passthrough（未被挤进 composite）",
   !clipNeedsFilter(clip(0, { blackout: true })));

const ptPlain = argvOf(clip(0));
const ptBlack = argvOf(clip(0, { blackout: true }));
const vfPlain = flagOf(ptPlain, "-vf");
const vfBlack = flagOf(ptBlack, "-vf");

ok("留黑时 -vf 含 drawbox 填充", vfBlack.includes(DRAWBOX), vfBlack);
ok("不留黑时 -vf 不含 drawbox", !vfPlain.includes(DRAWBOX), vfPlain);

// ② 基线保护：把 -vf 从"一整条字符串"改写成数组是为了能插滤镜，
//    改写本身**不允许**改变输出。这里不是比"看起来一样"，是比字符串相等。
ok("不留黑时 -vf 与改造前逐字符一致",
   vfPlain === `scale=${W}:${H}:force_original_aspect_ratio=decrease,`
             + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS}`,
   vfPlain);
// 顺带把整条 argv 也比一遍：确认没有别的参数被顺手动了（-map / -af / -t …）
ok("不留黑时整条 argv 与留黑版只差 -vf 一项",
   JSON.stringify(ptPlain.filter((a) => a !== vfPlain))
   === JSON.stringify(ptBlack.filter((a) => a !== vfBlack)));

// 插入位置：黑要盖在**画面**上，不能盖到 pad 补出来的黑边之外的口径上 ——
// 即 scale 之后、pad 之前。写死下标会随链条增删而假绿，所以比的是次序。
const idx = (s: string, needle: string) => s.split(",").findIndex((f) => f.startsWith(needle));
ok("drawbox 排在 scale 之后、pad 之前",
   idx(vfBlack, "scale") < idx(vfBlack, "drawbox")
   && idx(vfBlack, "drawbox") < idx(vfBlack, "pad"),
   vfBlack);

console.log("\n=== 2. composite 路径（clipVideoChain）===");

// 用 scale 把它挤出 passthrough（transform 非恒等 → clipNeedsFilter 为真）
// ⚠️ 缩放取 **0.8 而不是 1.2**：编译器的位移是靠 `pad` 实现的，放大到超过画布
// 时 `pad` 会直接报「Padded dimensions cannot be smaller than input dimensions」
// 而整段导出失败（本机 ffmpeg 4.4.2 实测复现）。那是一个**与留黑无关的既有缺陷**，
// 不在本条目范围内；这里避开它，免得本脚本变成在测那个 bug。
const bigT = { ...DEFAULT_TRANSFORM, scale: 0.8, opacity: 0.5 };
const cpBlack = argvOf(clip(0, {
  blackout: true, transform: bigT,
  effects: [{ type: "contrast", value: 40 }, { type: "mosaic", mosaicParams: {
    x: 0.1, y: 0.1, w: 0.2, h: 0.2, style: "pixel", intensity: 30 } }],
}));
const cpPlain = argvOf(clip(0, {
  transform: bigT,
  effects: [{ type: "contrast", value: 40 }, { type: "mosaic", mosaicParams: {
    x: 0.1, y: 0.1, w: 0.2, h: 0.2, style: "pixel", intensity: 30 } }],
}));
const fcBlack = flagOf(cpBlack, "-filter_complex");
const fcPlain = flagOf(cpPlain, "-filter_complex");

ok("composite 留黑时 filter_complex 含 drawbox", fcBlack.includes(DRAWBOX));
ok("对照：不留黑时不含 drawbox", !fcPlain.includes(DRAWBOX));
// 位置：几何之后（黑的形状由本镜画面决定）、不透明度之前（opacity 仍作用在黑上）
ok("drawbox 在 scale 之后",
   fcBlack.indexOf("scale=") < fcBlack.indexOf(DRAWBOX));
ok("drawbox 在 opacity（colorchannelmixer）之前",
   fcBlack.indexOf(DRAWBOX) < fcBlack.indexOf("colorchannelmixer="));
// 跳过特效不是"省点 CPU"，是**可证的**：整幅填黑之后调色一个像素都透不出来。
ok("留黑时调色被跳过（不含 eq= 调色）",
   !fcBlack.includes("eq=brightness="), fcBlack.slice(0, 200));
ok("对照：不留黑时调色仍在", fcPlain.includes("eq=brightness="));

console.log("\n=== 3. 蒙版链对留黑镜头根本不启动 ===");
ok("clipHasMosaic(留黑) === false",
   clipHasMosaic(clip(0, { blackout: true, effects: [
     { type: "mosaic", mosaicParams: { x: 0, y: 0, w: 1, h: 1, style: "pixel", intensity: 30 } }] })) === false);
ok("对照：不留黑时 clipHasMosaic === true",
   clipHasMosaic(clip(0, { effects: [
     { type: "mosaic", mosaicParams: { x: 0, y: 0, w: 1, h: 1, style: "pixel", intensity: 30 } }] })));
ok("留黑时 filter_complex 不含 alphamerge（没为看不见的遮挡写蒙版）",
   !fcBlack.includes("alphamerge"));

/* ================= 第 4 节：时间语义（留黑 ≠ 停用） ================= */

console.log("\n=== 4. 时间语义：留黑占时间，停用不占 ===");

const shot = (order: number, over: Partial<ShotInfo> = {}): ShotInfo => ({
  id: `s${order}`, order, prompt: "", video_url: `/m/s${order}.mp4`,
  duration_sec: 10, disabled: false, characters: [], refs_stale: false,
  script_ref: null, is_special: false, status: "done",
  ...over,
} as unknown as ShotInfo);

const nPlain = normalize({ projectId: "p", shots: [shot(1), shot(2), shot(3)], output: OUT });
const nBlack = normalize({
  projectId: "p", output: OUT,
  shots: [shot(1), shot(2, { transform_meta: { blackout: true } }), shot(3)],
});
const nDis = normalize({
  projectId: "p", output: OUT,
  shots: [shot(1), shot(2, { disabled: true }), shot(3)],
});
const vclips = (p: RenderPlan) => p.tracks.find((t) => t.id === "v1")!.clips;

ok("留黑：总时长与未留黑完全相同", nBlack.totalSec === nPlain.totalSec,
   `${nBlack.totalSec} vs ${nPlain.totalSec}`);
ok("留黑：clip 数量不变（这一镜仍在成片里）", vclips(nBlack).length === 3);
ok("留黑：第 3 镜起点不变（前面那一镜没被抽走）",
   vclips(nBlack)[2].timelineStartSec === vclips(nPlain)[2].timelineStartSec);
ok("对照 —— 停用：总时长少一镜", nDis.totalSec === nPlain.totalSec - 10,
   `${nDis.totalSec} vs ${nPlain.totalSec}`);
ok("对照 —— 停用：只剩 2 个 clip", vclips(nDis).length === 2);
ok("留黑镜头的 blackout 标志被传下来", vclips(nBlack)[1].blackout === true);
ok("未留黑镜头的标志为 false（不是 undefined，避免下游 ?? 兜底走岔）",
   vclips(nBlack)[0].blackout === false);
// 留黑**不动声音**：这是它与停用的另一半分界，光看时长测不出来。
ok("留黑不改音频参数", JSON.stringify(vclips(nBlack)[1].audio)
   === JSON.stringify(vclips(nPlain)[1].audio));

console.log("\n--- 叠加层同样可留黑（两处 normalize 分支，最容易只改一处）---");
const nOv = normalize({
  projectId: "p", output: OUT,
  shots: [shot(1), shot(2, {
    track_index: 1, overlay_start_sec: 1, transform_meta: { blackout: true },
  })],
});
const ov = nOv.tracks.find((t) => t.id === "v2");
ok("叠加轨存在", !!ov);
ok("叠加层的 blackout 被传下来", ov?.clips[0].blackout === true);

console.log("\n--- 时间轴（Clip 镜像值，画角标用）---");
const tl = buildTimeline({
  shots: [shot(1), shot(2, { transform_meta: { blackout: true } })],
});
const tlClips = tl.tracks.flatMap((t) => t.clips).filter((c) => c.entity === "shot");
ok("时间轴上留黑镜头 clip.blackout === true",
   tlClips.find((c) => c.shotId === "s2")?.blackout === true);
ok("时间轴上普通镜头 clip.blackout === false",
   tlClips.find((c) => c.shotId === "s1")?.blackout === false);
ok("留黑镜头**不被折叠**（折叠是停用专属，它不占时间才折叠）",
   tlClips.find((c) => c.shotId === "s2")?.collapsedIndex === undefined);

console.log("\n--- 写通路（源码断言：留黑存在 transform_meta，不能走 disabled 那条）---");
// 这一条是 grep，够不着运行时。留着的理由：走错通路（onPatch）时前面所有断言
// 依然全绿 —— 编译器和 normalize 都没错，只是用户点了没反应。
const tlSrc = readFileSync(join(ROOT, "src/features/timeline/Timeline.tsx"), "utf8");
// ⚠️ 结束锚点必须从 blackout 之后再找 —— 文件里前面还有一个音频段的
// `id: "delete"`（795 行），从头找会切出一段空串，然后**所有断言都假绿**。
const boAt = tlSrc.indexOf('id: "blackout"');
const boItem = boAt < 0 ? "" : tlSrc.slice(boAt, tlSrc.indexOf('id: "delete"', boAt));
ok("菜单项存在", boItem.length > 0);
ok("留黑走 onPatchTransform（带乐观锁与撤销栈）", boItem.includes("p.onPatchTransform"));
ok("留黑**不**走 onPatch（那是 disabled 顶层字段的通路）", !boItem.includes("p.onPatch("));
ok("取消时删键而不是写 false", boItem.includes("delete next.blackout"));
ok("在已有 transform_meta 上合并（否则会抹掉该镜的缩放/调色/特效）",
   boItem.includes("...(shot?.transform_meta ?? {})"));

console.log("\n--- 撤销标签（Ctrl+Z 之前顶栏显示的那句）---");
// 留黑是这一组里唯一**改变成片能不能看**的开关，撤销时用户最需要一眼认出它，
// 所以它单列一组而不是并进「画面」——否则「我刚把这镜遮黑了」与「我调了下缩放」
// 会显示成同一句话。
ok('describeTransform({ blackout: true }) === "留黑"',
   describeTransform({ blackout: true }) === "留黑",
   describeTransform({ blackout: true }));
ok("与画面同时改动时两组并列显示",
   describeTransform({ blackout: true, scale: 120 }) === "画面+留黑",
   describeTransform({ blackout: true, scale: 120 }));

/* ================= 第 5 节：真跑一遍，逐像素看它是不是真黑 ================= */

console.log("\n=== 5. 真导出：画面是不是真的黑（含对照组）===");

const work = mkdtempSync(join(tmpdir(), "blackout-"));
const sh = (a: string[]) =>
  execFileSync(FFMPEG, a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

/** 取 out.mp4 第 tSec 秒那一帧的灰度最大值。全黑 → 接近 0（limited range 下 16）。 */
function maxLuma(file: string, tSec: number): number {
  const buf = execFileSync(FFMPEG,
    ["-v", "error", "-ss", tSec.toFixed(2), "-i", file, "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { maxBuffer: 1 << 26 });
  let m = 0;
  for (const b of buf) if (b > m) m = b;
  return m;
}

try {
  // 素材必须是**有画面的**：全黑素材会让"留黑生效"和"什么都没做"分不开。
  const srcs = [0, 1].map((i) => {
    const p = join(work, `s${i}.mp4`);
    sh(["-y", "-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=${FPS}:duration=2`,
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", p, "-loglevel", "error"]);
    return p;
  });

  /** 两镜串接导出：第 0 镜正常（对照），第 1 镜按 over 配置。 */
  const exportTwo = (tag: string, over: Partial<RenderClip>): string => {
    const plan = mkPlan([clip(0), clip(1, over)], srcs);
    const ctx = {
      plan, caps, encoder: "libx264", crf: 23,
      localPath: (id: string) => plan.media.find((m) => m.id === id)!.url,
    };
    const files = buildSegments(plan).map((s, i) => {
      const o = join(work, `${tag}_${i}.mp4`);
      sh([...compileSegment(s, ctx, o).args, "-loglevel", "error"]);
      return o;
    });
    const lst = join(work, `${tag}.txt`);
    writeFileSync(lst, files.map((f) => `file '${f}'`).join("\n") + "\n");
    const out = join(work, `${tag}.mp4`);
    sh([...compileConcat(lst, out, { faststart: true }), "-loglevel", "error"]);
    return out;
  };

  for (const [label, over] of [
    ["passthrough", { blackout: true }],
    // 加个 scale 把它挤进 composite —— 同一件事的另一条编译路径
    ["composite", { blackout: true, transform: { ...DEFAULT_TRANSFORM, scale: 0.8 } }],
  ] as const) {
    const out = exportTwo(label, over);
    const black = maxLuma(out, 3.0);   // 第 1 镜（2~4s）
    const ctrl = maxLuma(out, 1.0);    // 第 0 镜（0~2s）：对照，必须不黑
    ok(`${label}：留黑那一镜真的是黑的（最亮像素 ${black} ≤ 20）`, black <= 20);
    ok(`${label}：对照组那一镜不黑（最亮像素 ${ctrl} > 100）`, ctrl > 100,
       "对照组也黑 → 说明整段导挂了或采样点错位，本节结论作废");
  }

  // 时长：留黑不能把这一镜缩短或拉长。
  // ⚠️ 用 spawnSync 读 **stderr** —— ffmpeg 的进度行走的是 stderr，而
  // execFileSync 的返回值只有 stdout，拿它去 match 永远是 0.00s 的假绿。
  // 这里也不用 ffprobe：app 里根本没打包 ffprobe（探测音轨都是靠解析
  // `ffmpeg -i` 的 stderr），验证脚本没道理比运行时多要一个外部依赖。
  const durOf = (f: string): number => {
    const r = spawnSync(FFMPEG, ["-i", f, "-f", "null", "-"], { encoding: "utf-8" });
    const last = (r.stderr || "").match(/time=(\d+):(\d+):([\d.]+)/g)?.pop();
    if (!last) return NaN;
    const [h, mm, ss] = last.slice(5).split(":");
    return +h * 3600 + +mm * 60 + +ss;
  };
  const d = durOf(join(work, "passthrough.mp4"));
  ok(`留黑不改时长（${d.toFixed(2)}s ≈ 4s）`, Math.abs(d - 4) < 0.3);
} catch (e) {
  ok("真导出", false, String(e).split("\n").slice(0, 3).join(" ").slice(0, 300));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "✅ 全部通过" : `❌ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
