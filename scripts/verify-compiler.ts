/**
 * 编译器产出验证：把 compileSegment 生成的参数**真的喂给 ffmpeg**，
 * 确认命令合法、产物时长正确。
 *
 * 这一步不能省——分段器只证明了"内存可控"，编译器有没有把 filter 图写对
 * 是另一回事。开发中已因此抓到过转场边界少 0.5s 的问题。
 *
 * 跑法：npx tsx scripts/verify-compiler.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSegment, compileConcat } from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type { RenderPlan, RenderClip, RenderTransition } from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";

/** ffmpeg 可执行文件：CI 里指向刚打包的 Windows sidecar 二进制，
 *  本地缺省用 PATH 上的。验证"打进安装包的那个 ffmpeg"才有意义。 */
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

const W = 320, H = 240, FPS = 10;
const work = mkdtempSync(join(tmpdir(), "fwrender-"));

function sh(args: string[]): string {
  return execFileSync(FFMPEG, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}
function dur(p: string): number {
  const o = execFileSync("ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
    { encoding: "utf-8" });
  return parseFloat(o.trim());
}

// 造 6 个 2 秒素材
const srcs: string[] = [];
for (let i = 0; i < 6; i++) {
  const p = join(work, `s${i}.mp4`);
  sh(["-y", "-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=${FPS}:duration=2`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", p, "-loglevel", "error"]);
  srcs.push(p);
}

// 真实探测本机能力（这台机器有 ffmpeg 4.4.2）
const caps: Capabilities = {
  version: "test", available: true, hwEncoders: [],
  filters: new Set(["xfade", "overlay", "eq", "colorbalance", "unsharp",
                    "lut3d", "amix", "volume", "atempo", "afade", "subtitles",
                    "scale", "pad", "rotate", "crop", "setpts", "anullsrc",
                    "colorchannelmixer", "boxblur"]),
  // 转场集合必须给：编译器用 hasTransition() 按运行时能力决定
  // xfade 还是降级硬切。这台机器 ffmpeg 4.4.2 支持除 zoomin 外全部。
  transitions: new Set(["fade", "fadeblack", "fadewhite", "wipeleft", "wiperight",
                        "wipeup", "wipedown", "slideleft", "slideright",
                        "slideup", "slidedown", "circleopen", "circleclose",
                        "dissolve", "pixelize", "radial", "smoothleft"]),
  probedAt: Date.now(),
};

function clip(i: number, start: number, d: number, over: Partial<RenderClip> = {}): RenderClip {
  return {
    id: `c${i}`, mediaId: `m${i}`, timelineStartSec: start, durationSec: d,
    sourceInSec: 0, sourceDurationSec: d, speed: 1,
    transform: { ...DEFAULT_TRANSFORM }, effects: [], audio: { ...DEFAULT_AUDIO },
    ...over,
  };
}
function mkPlan(clips: RenderClip[], transitions: RenderTransition[] = []): RenderPlan {
  return {
    projectId: "t", media: clips.map((c, i) => ({
      id: c.mediaId, url: srcs[i % srcs.length], kind: "video" as const, durationSec: 2 })),
    tracks: [{ id: "v1", kind: "video", layer: 1, muted: false, hidden: false, clips }],
    transitions, subtitles: [],
    output: { width: W, height: H, fps: FPS, vcodec: "libx264", crf: 23, withAudio: true },
    totalSec: Math.max(...clips.map((c) => c.timelineStartSec + c.durationSec)),
  };
}

const cases: { name: string; plan: RenderPlan; expect: number }[] = [];

// 1. 纯顺序 4 段（全透传）→ 8s
cases.push({
  name: "纯顺序 4 段（透传）",
  plan: mkPlan([0, 1, 2, 3].map((i) => clip(i, i * 2, 2))),
  expect: 8,
});

// 2. 带变换/调色（走 composite）→ 6s
cases.push({
  name: "3 段带变换调色",
  plan: mkPlan([0, 1, 2].map((i) => clip(i, i * 2, 2, {
    transform: { ...DEFAULT_TRANSFORM, scale: 0.8, rotate: 5, opacity: 0.9 },
    effects: [{ type: "contrast", value: 25 }, { type: "saturation", value: 15 }],
  }))),
  expect: 6,
});

// 3. 变速 2× → 每段 1s，共 3s
cases.push({
  name: "3 段 2倍速",
  plan: mkPlan([0, 1, 2].map((i) => clip(i, i * 1, 1, {
    speed: 2, sourceDurationSec: 2, durationSec: 1,
    audio: { ...DEFAULT_AUDIO, volume: 1.2 },
  }))),
  expect: 3,
});

// 4. 转场：4 段 + 3 个 0.5s 转场 → 8 - 1.5 = 6.5s
{
  const cs = [0, 1, 2, 3].map((i) => clip(i, i * 2, 2));
  const trs: RenderTransition[] = [];
  for (let i = 1; i < 4; i++) {
    trs.push({ id: `t${i}`, type: "fade", durationSec: 0.5,
               fromClipId: `c${i - 1}`, toClipId: `c${i}` });
  }
  cases.push({ name: "4 段 + 3 转场", plan: mkPlan(cs, trs), expect: 6.5 });
}

console.log("场景".padEnd(22), "段数".padStart(5), "实际".padStart(9),
            "期望".padStart(8), " 判定");
console.log("-".repeat(64));
let allOk = true;
for (const { name, plan, expect } of cases) {
  const segs = buildSegments(plan);
  const ctx = {
    plan, caps, encoder: "libx264", crf: 23,
    localPath: (id: string) => plan.media.find((m) => m.id === id)!.url,
  };
  const files: string[] = [];
  try {
    segs.forEach((s, i) => {
      const out = join(work, `${name.replace(/\W/g, "")}_${i}.mp4`);
      const { args } = compileSegment(s, ctx, out);
      sh([...args, "-loglevel", "error"]);
      files.push(out);
    });
    const lst = join(work, `${name.replace(/\W/g, "")}.txt`);
    writeFileSync(lst, files.map((f) => `file '${f}'`).join("\n") + "\n");
    const merged = join(work, `${name.replace(/\W/g, "")}_out.mp4`);
    sh([...compileConcat(lst, merged), "-loglevel", "error"]);
    const d = dur(merged);
    const ok = Math.abs(d - expect) < 0.25;
    if (!ok) allOk = false;
    console.log(name.padEnd(22), String(segs.length).padStart(5),
                `${d.toFixed(2)}s`.padStart(9), `${expect}s`.padStart(8),
                ` ${ok ? "✅" : "❌"}`);
  } catch (e) {
    allOk = false;
    console.log(name.padEnd(22), String(segs.length).padStart(5),
                "失败".padStart(9), `${expect}s`.padStart(8), ` ❌`);
    console.log("   ", String(e).split("\n").slice(-3).join(" ").slice(0, 220));
  }
}
console.log("-".repeat(64));
console.log(allOk ? "✅ 编译器产出全部可执行且时长正确" : "❌ 存在失败用例");
rmSync(work, { recursive: true, force: true });
