/**
 * V2.2 逐帧特效 + 混合模式验证：每个特效都真的喂给 ffmpeg 跑一遍。
 * 跑法：npx tsx scripts/verify-effects.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSegment, compileConcat } from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type {
  RenderPlan, RenderClip, RenderEffectType, BlendMode,
} from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";

/** ffmpeg 可执行文件：CI 里指向刚打包的 Windows sidecar 二进制，
 *  本地缺省用 PATH 上的。验证"打进安装包的那个 ffmpeg"才有意义。 */
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

const W = 320, H = 240, FPS = 10;
const work = mkdtempSync(join(tmpdir(), "fxv22-"));
const sh = (a: string[]) => execFileSync(FFMPEG, a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
const dur = (p: string) => parseFloat(execFileSync("ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
  { encoding: "utf-8" }).trim());

const srcs: string[] = [];
for (let i = 0; i < 2; i++) {
  const p = join(work, `s${i}.mp4`);
  sh(["-y", "-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=${FPS}:duration=2`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", p, "-loglevel", "error"]);
  srcs.push(p);
}

// 用真实探测到的滤镜集（本机 ffmpeg 4.4.2 全部支持）
const caps: Capabilities = {
  version: "test", available: true, hwEncoders: [],
  filters: new Set(["xfade", "overlay", "blend", "eq", "colorbalance", "unsharp",
    "gblur", "boxblur", "vignette", "noise", "rgbashift", "crop", "curves",
    "lut3d", "amix", "volume", "atempo", "afade", "scale", "pad", "rotate",
    "setpts", "anullsrc", "colorchannelmixer", "subtitles", "split"]),
  // 本用例只测特效滤镜，不走 xfade；给空集即可（编译器会降级硬切）
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
function mkPlan(clips: RenderClip[], layers = 1): RenderPlan {
  const tracks = layers === 1
    ? [{ id: "v1", kind: "video" as const, layer: 1, muted: false, hidden: false, clips }]
    : [
        { id: "v1", kind: "video" as const, layer: 1, muted: false, hidden: false, clips: [clips[0]] },
        { id: "v2", kind: "video" as const, layer: 2, muted: false, hidden: false, clips: clips.slice(1) },
      ];
  return {
    projectId: "fx",
    media: clips.map((c, i) => ({ id: c.mediaId, url: srcs[i % srcs.length],
                                  kind: "video" as const, durationSec: 2 })),
    tracks, transitions: [], subtitles: [],
    output: { width: W, height: H, fps: FPS, vcodec: "libx264", crf: 23, withAudio: true },
    totalSec: Math.max(...clips.map((c) => c.timelineStartSec + c.durationSec)),
  };
}

function run(name: string, plan: RenderPlan, expect: number): boolean {
  const segs = buildSegments(plan);
  const ctx = {
    plan, caps, encoder: "libx264", crf: 23,
    localPath: (id: string) => plan.media.find((m) => m.id === id)!.url,
  };
  const tag = name.replace(/\W/g, "");
  try {
    const files: string[] = [];
    segs.forEach((s, i) => {
      const o = join(work, `${tag}_${i}.mp4`);
      sh([...compileSegment(s, ctx, o).args, "-loglevel", "error"]);
      files.push(o);
    });
    const lst = join(work, `${tag}.txt`);
    writeFileSync(lst, files.map((f) => `file '${f}'`).join("\n") + "\n");
    const out = join(work, `${tag}_o.mp4`);
    sh([...compileConcat(lst, out), "-loglevel", "error"]);
    const d = dur(out);
    const ok = Math.abs(d - expect) < 0.3;
    console.log(`  ${ok ? "✅" : "❌"} ${name.padEnd(16)} ${d.toFixed(2)}s (期望 ${expect}s)`);
    return ok;
  } catch (e) {
    console.log(`  ❌ ${name.padEnd(16)} 失败`);
    console.log(`      ${String(e).split("\n").filter((l) => /Error|Invalid|not|fail/i.test(l))
      .slice(0, 2).join(" ").slice(0, 200)}`);
    return false;
  }
}

let allOk = true;

console.log("=== 逐帧特效（单 clip）===");
const FX: RenderEffectType[] = ["blur", "vignette", "grain", "glitch",
                                "shake", "zoomPulse", "flash", "glow"];
for (const fx of FX) {
  const ok = run(fx, mkPlan([clip(0, { effects: [{ type: fx, value: 60 }] })]), 2);
  if (!ok) allOk = false;
}

console.log("\n=== 组合特效 ===");
if (!run("多特效叠加", mkPlan([clip(0, {
  effects: [{ type: "vignette", value: 50 }, { type: "grain", value: 40 },
            { type: "contrast", value: 20 }, { type: "blur", value: 15 }],
})]), 2)) allOk = false;

console.log("\n=== 混合模式（叠加层）===");
const MODES: BlendMode[] = ["multiply", "screen", "overlay", "darken", "lighten"];
for (const m of MODES) {
  const base = clip(0);
  const over = clip(1, { timelineStartSec: 0.5, blendMode: m });
  // 主轨 1 段(2s) + 叠加层 → 总长仍是主轨 2s
  const ok = run(`blend=${m}`, mkPlan([base, over], 2), 2);
  if (!ok) allOk = false;
}

console.log(`\n${allOk ? "✅ V2.2 全部特效与混合模式可执行" : "❌ 存在失败项"}`);
rmSync(work, { recursive: true, force: true });
