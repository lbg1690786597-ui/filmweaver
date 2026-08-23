/**
 * 多轨 + 转场端到端验证：normalize → segment → compile → 真实 ffmpeg。
 * 跑法：npx tsx scripts/verify-multitrack.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize } from "../src/render/normalize";
import { buildSegments, segmentStats } from "../src/render/segment";
import { compileSegment, compileConcat } from "../src/render/ffmpegCompiler";
import type { ShotInfo, TransitionInfo } from "../src/api";
import type { Capabilities } from "../src/render/capabilities";

/** ffmpeg 可执行文件：CI 里指向刚打包的 Windows sidecar 二进制，
 *  本地缺省用 PATH 上的。验证"打进安装包的那个 ffmpeg"才有意义。 */
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

const W = 320, H = 240, FPS = 10;
const work = mkdtempSync(join(tmpdir(), "fwmt-"));
const sh = (a: string[]) => execFileSync(FFMPEG, a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
const dur = (p: string) => parseFloat(execFileSync("ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
  { encoding: "utf-8" }).trim());

// 素材
const urls: string[] = [];
for (let i = 0; i < 4; i++) {
  const p = join(work, `s${i}.mp4`);
  sh(["-y", "-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=${FPS}:duration=3`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", p, "-loglevel", "error"]);
  urls.push(p);
}

const caps: Capabilities = {
  version: "test", available: true, hwEncoders: [],
  filters: new Set(["xfade", "overlay", "eq", "colorbalance", "unsharp", "amix",
                    "volume", "atempo", "afade", "scale", "pad", "rotate",
                    "setpts", "anullsrc", "colorchannelmixer", "subtitles"]),
  // 转场集合必须给：编译器用 hasTransition() 按运行时能力决定
  // xfade 还是降级硬切。这台机器 ffmpeg 4.4.2 支持除 zoomin 外全部。
  transitions: new Set(["fade", "fadeblack", "fadewhite", "wipeleft", "wiperight",
                        "wipeup", "wipedown", "slideleft", "slideright",
                        "slideup", "slidedown", "circleopen", "circleclose",
                        "dissolve", "pixelize", "radial", "smoothleft"]),
  probedAt: Date.now(),
};

function shot(i: number, over: Partial<ShotInfo> = {}): ShotInfo {
  return {
    id: `s${i}`, order: i + 1, episode: 1, script_ref: `镜${i}`,
    link_to_prev: "cut", characters: [], location: null,
    video_url: urls[i % urls.length], thumb_url: null, status: "adopted",
    adopted_version: 1, is_special: false, gen_prompt: null, stale: false,
    prompt_state: null, duration_sec: 3, disabled: false, special_name: null,
    ref_overrides: null, refs_stale: false, first_frame_url: null,
    profile_override: null, ...over,
  } as ShotInfo;
}

const out = { width: W, height: H, fps: FPS, vcodec: "libx264", crf: 23, withAudio: true };

interface Case { name: string; shots: ShotInfo[]; transitions: TransitionInfo[]; expect: number }
const cases: Case[] = [
  {
    name: "主轨 3 段（基线）",
    shots: [0, 1, 2].map((i) => shot(i)),
    transitions: [],
    expect: 9,
  },
  {
    name: "主轨 3 段 + 2 转场",
    shots: [0, 1, 2].map((i) => shot(i)),
    transitions: [
      { id: "t1", type: "fade", duration: 0.5, from_shot_id: "s0", to_shot_id: "s1", params: null },
      { id: "t2", type: "fadeblack", duration: 0.5, from_shot_id: "s1", to_shot_id: "s2", params: null },
    ],
    expect: 8,     // 9 - 2×0.5
  },
  {
    // 叠加层不参与主轨累加 → 总长仍是主轨的 6s
    name: "主轨 2 段 + 1 叠加层",
    shots: [
      shot(0), shot(1),
      shot(2, { id: "s2", track_index: 1, overlay_start_sec: 1.0,
                transform_meta: { scale: 50, x: 60, y: -40 } }),
    ],
    transitions: [],
    expect: 6,
  },
];

console.log("场景".padEnd(24), "轨数".padStart(5), "段数".padStart(5),
            "峰值MB".padStart(8), "实际".padStart(8), "期望".padStart(7), " 判定");
console.log("-".repeat(76));
let allOk = true;
for (const c of cases) {
  const plan = normalize({
    projectId: "mt", shots: c.shots, transitions: c.transitions,
    output: out, scope: "generated",
  });
  const segs = buildSegments(plan);
  const st = segmentStats(segs);
  const ctx = {
    plan, caps, encoder: "libx264", crf: 23,
    localPath: (id: string) => plan.media.find((m) => m.id === id)!.url,
  };
  try {
    const files: string[] = [];
    segs.forEach((s, i) => {
      const o = join(work, `${c.name.replace(/\W/g, "")}_${i}.mp4`);
      sh([...compileSegment(s, ctx, o).args, "-loglevel", "error"]);
      files.push(o);
    });
    const lst = join(work, `${c.name.replace(/\W/g, "")}.txt`);
    writeFileSync(lst, files.map((f) => `file '${f}'`).join("\n") + "\n");
    const merged = join(work, `${c.name.replace(/\W/g, "")}_out.mp4`);
    sh([...compileConcat(lst, merged), "-loglevel", "error"]);
    const d = dur(merged);
    const ok = Math.abs(d - c.expect) < 0.3;
    if (!ok) allOk = false;
    console.log(c.name.padEnd(24),
      String(plan.tracks.filter((t) => t.kind === "video").length).padStart(5),
      String(segs.length).padStart(5), String(st.estPeakMB).padStart(8),
      `${d.toFixed(2)}s`.padStart(8), `${c.expect}s`.padStart(7),
      ` ${ok ? "✅" : "❌"}`);
  } catch (e) {
    allOk = false;
    console.log(c.name.padEnd(24), "—".padStart(5), String(segs.length).padStart(5),
      "—".padStart(8), "失败".padStart(8), `${c.expect}s`.padStart(7), " ❌");
    console.log("   ", String(e).split("\n").slice(-3).join(" ").slice(0, 240));
  }
}
console.log("-".repeat(76));
console.log(allOk ? "✅ 多轨 + 转场全部通过" : "❌ 存在失败用例");
rmSync(work, { recursive: true, force: true });
