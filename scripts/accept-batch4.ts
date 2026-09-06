/**
 * accept-batch4.ts — 批次 4「导出主链路」的**验收**（真跑 ffmpeg，不是看参数）
 *
 * ## 它和 baseline-export.ts 是两件事
 *
 * `baseline-export.ts` 钉的是「编译器吐出来的 argv 没变」。它跑得快、100% 确定，
 * 但它**从来没让 ffmpeg 执行过一次**。也就是说：一条把画面导成全黑、或者
 * 混音时 `[0:a]` 找不到流直接崩的命令，只要参数稳定，基线一样全绿。
 *
 * 本脚本补的正是那一半：
 *
 *   1. 用**真素材**把三份基线各导一次，逐条比对 argv 与黄金基线是否**同一份**，
 *      再把这份 argv **真的执行掉** —— 于是「基线里的命令」与「能出片的命令」
 *      被证明是同一个东西，而不是两套各自自洽的东西。
 *   2. 三个降级组合（4.3 的删中间文件规则最容易在这三处出事）真跑到底，
 *      并在每一步之后**按 renderer 的规则真删文件**，确认交付的那个还在。
 *   3. R5（4.5 的缓存命名）造两个 basename 相同、URL 不同的素材真导一次，
 *      确认第二镜拿到的是自己的画面 —— 并用「按老命名再导一次」证明
 *      这条断言是承重的（老命名下第二镜确实变成了第一镜的画面）。
 *
 * ## 哪些部分**不能**在这里真跑（说清楚，不拿弱检查冒充）
 *
 * · `lib/retireFiles.ts` / `renderer.ts` 的删除动作走 Tauri 的 `fs` 插件，
 *   node 下加载即抛。所以这里执行的是**同一套删除清单**（段产物 → 上一道产物，
 *   且只在下一道成功之后），落地用 node `fs`。被验证的是那条**规则**
 *   （删的永远不是成片、永远不碰缓存目录），不是插件本身。
 *   删除动作的静态钉在 `verify-cleanup.ts`，两边合起来才完整。
 * · `lib/localRender.ts`（「经典导出」/ FineCut 走的那条）顶层 import 了
 *   `@tauri-apps/api`，同样不能在 node 里执行。R5 的**命名规则**是纯函数、
 *   两条链路共用（`cacheClip` 已经是 `ensureCached` 的薄壳），
 *   所以这里真跑的是「同一个命名函数 + 真导出」，legacy 那条只做源码断言。
 * · 硬件编码器：本机无 GPU，`h264_amf` 等没编进 ffmpeg。全程 libx264，
 *   与黄金基线一致（基线的 encoder 也是 libx264）。
 *
 * ## 跑法
 *
 *   npx tsx scripts/accept-batch4.ts          # 约 2~4 分钟（真编码 1080×1920）
 *   ACCEPT_WORK=/some/dir npx tsx scripts/accept-batch4.ts
 *
 * 不进 `verify:all`：它要真编码好几分钟，而 verify:all 是每条改动都要跑的。
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  compileSegment, compileConcat, compileAudioMix, compileBurnSubtitles,
} from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type {
  RenderPlan, RenderClip, RenderTransition, RenderTrack, MosaicParams,
} from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";
import { cacheFileName } from "../src/lib/cacheName";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, "__baseline__", "export-argv.json");
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, any>;

const ROOT = process.env.ACCEPT_WORK || "/tmp/fw-accept4";
/** 冒充 `appDataDir()/cache/<projectId>/` 的素材缓存目录 —— 全程只读，一个都不许删 */
const MEDIA = join(ROOT, "cache");
/** 冒充 `appDataDir()/render_tmp` 的工作目录 —— 中间产物在这里生灭 */
const WORK = join(ROOT, "work");

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${msg}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${msg}${detail ? `  — ${detail}` : ""}`); }
}

/* ================================================================== *
 * ffmpeg 外壳（与 e2e-narration.ts 同款：只换 I/O，不换决策逻辑）
 * ================================================================== */

function ff(args: string[], label: string): boolean {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.log(`     ffmpeg 失败（${label}）:\n`
      + (r.stderr || "").split("\n").slice(-10).map((l) => "       " + l).join("\n"));
    return false;
  }
  return true;
}

function probe(f: string): any {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height:format=duration,size",
    "-of", "json", f], { encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

/** 整帧平均色（area 缩放到 1×1，纯色画面即为该色本身） */
function rgbAt(file: string, t: number): [number, number, number] | null {
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", t.toFixed(2), "-i", file,
    "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo",
    "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 20 });
  const b = r.stdout;
  if (r.status !== 0 || !b || b.length < 3) return null;
  return [b[0], b[1], b[2]];
}

/** 素材调色板：每个 mediaId 一个高饱和纯色，成片里出现过哪几段一眼可判 */
const PALETTE: { name: string; rgb: [number, number, number]; c: string; tone: number }[] = [
  { name: "红", rgb: [255, 0, 0], c: "red", tone: 220 },
  { name: "绿", rgb: [0, 255, 0], c: "lime", tone: 330 },
  { name: "蓝", rgb: [0, 0, 255], c: "blue", tone: 440 },
  { name: "黄", rgb: [255, 255, 0], c: "yellow", tone: 550 },
  { name: "品红", rgb: [255, 0, 255], c: "magenta", tone: 660 },
];

/** 把一帧归类到调色板；距离过大（转场混合帧、马赛克糊掉的帧）返回 null */
function classify(px: [number, number, number] | null): string | null {
  if (!px) return null;
  let best: string | null = null, bestD = Infinity;
  for (const p of PALETTE) {
    const d = Math.hypot(px[0] - p.rgb[0], px[1] - p.rgb[1], px[2] - p.rgb[2]);
    if (d < bestD) { bestD = d; best = p.name; }
  }
  return bestD <= 100 ? best : null;
}

/** 全片扫一遍，返回出现过的素材颜色集合 —— 用来证明"每一镜的画面都真的进了成片" */
function colourSweep(file: string, dur: number): Set<string> {
  const seen = new Set<string>();
  for (let t = 0.25; t < dur - 0.2; t += 0.5) {
    const c = classify(rgbAt(file, t));
    if (c) seen.add(c);
  }
  return seen;
}

const md5 = (f: string) => createHash("md5").update(readFileSync(f)).digest("hex");

/* ================================================================== *
 * 素材：5 个纯色 8 秒片（各带一个可分辨的正弦音）
 * ================================================================== */

function makeMedia(): boolean {
  mkdirSync(MEDIA, { recursive: true });
  let allOk = true;
  PALETTE.forEach((p, i) => {
    const out = join(MEDIA, `m${i}.mp4`);
    if (existsSync(out) && statSync(out).size > 0) return;
    allOk = ff([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=${p.c}:s=1080x1920:r=30:d=8`,
      "-f", "lavfi", "-i", `sine=frequency=${p.tone}:sample_rate=44100:duration=8`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-shortest", out,
    ], `生成素材 m${i}`) && allOk;
  });
  return allOk;
}

/* ================================================================== *
 * 夹具：与 baseline-export.ts 逐字同构，只把两个根路径换成真目录
 *
 * ⚠️ 这里的重复是**自校验**的：夹具但凡与 baseline-export.ts 有一丝出入，
 *    下面的「逐条比对」当场就红 —— 比对的对象是同一份黄金 JSON。
 * ================================================================== */

const W = 1080, H = 1920, FPS = 30;
const src = (i: number) => join(MEDIA, `m${i}.mp4`);

const FULL_FILTERS = [
  "xfade", "overlay", "blend", "split", "scale", "pad", "rotate", "crop",
  "setpts", "trim", "concat", "eq", "colorbalance", "unsharp", "lut3d",
  "curves", "colorchannelmixer", "gblur", "boxblur", "vignette", "noise",
  "rgbashift", "atempo", "afade", "amix", "volume", "anull", "anullsrc",
  "subtitles", "silencedetect", "geq", "format", "drawbox", "alphamerge",
];
const FULL_TRANSITIONS = [
  "fade", "fadeblack", "fadewhite", "wipeleft", "wiperight", "wipeup",
  "wipedown", "slideleft", "slideright", "slideup", "slidedown",
  "circleopen", "circleclose", "dissolve", "pixelize", "radial", "smoothleft",
];

function caps(opts: { drop?: string[] } = {}): Capabilities {
  const drop = new Set(opts.drop ?? []);
  return {
    version: "4.4.2-baseline", available: true, hwEncoders: [],
    filters: new Set(FULL_FILTERS.filter((f) => !drop.has(f))),
    transitions: new Set(FULL_TRANSITIONS),
    probedAt: 0,
  };
}

function clip(i: number, start: number, d: number, over: Partial<RenderClip> = {}): RenderClip {
  return {
    id: `c${i}`, mediaId: `m${i}`, timelineStartSec: start, durationSec: d,
    sourceInSec: 0, sourceDurationSec: d, speed: 1,
    transform: { ...DEFAULT_TRANSFORM }, effects: [], audio: { ...DEFAULT_AUDIO },
    ...over,
  };
}

function mkPlan(
  clips: RenderClip[],
  extra: {
    transitions?: RenderTransition[];
    audioTrack?: RenderClip[];
    withAudio?: boolean;
    mediaIds?: string[];
  } = {},
): RenderPlan {
  const ids = extra.mediaIds ?? [...new Set(clips.map((c) => c.mediaId))];
  const tracks: RenderTrack[] = [
    { id: "v1", kind: "video", layer: 1, muted: false, hidden: false, clips },
  ];
  if (extra.audioTrack) {
    tracks.push({
      id: "a1", kind: "audio", layer: 0, muted: false, hidden: false,
      clips: extra.audioTrack,
    });
  }
  return {
    projectId: "baseline",
    media: ids.map((id, i) => ({ id, url: src(i), kind: "video" as const, durationSec: 8 })),
    tracks,
    transitions: extra.transitions ?? [],
    subtitles: [],
    output: {
      width: W, height: H, fps: FPS, vcodec: "libx264", crf: 23,
      withAudio: extra.withAudio ?? true,
    },
    totalSec: Math.max(...clips.map((c) => c.timelineStartSec + c.durationSec)),
  };
}

const mosaic = (p: Partial<MosaicParams>): RenderClip["effects"][number] => ({
  type: "mosaic",
  mosaicParams: {
    x: 0.2, y: 0.3, w: 0.25, h: 0.2, style: "pixel", intensity: 50, ...p,
  },
});

const SRT_TEXT = "1\n00:00:00,000 --> 00:00:02,000\n你好\n";

/* ------------------------------------------------------------------ *
 * 编译整条链（顺序与 renderer.ts 一致，与 baseline-export.ts 的 fullChain 同构）
 * ------------------------------------------------------------------ */
interface Chain {
  segCount: number;
  segments: { kind: string; startSec: number; endSec: number;
              boundaryOverlapSec: number; inputCount: number; args: string[] }[];
  concat: string[];
  mix: string[] | null;
  burn: string[] | null;
  finalFile: string;
}

function fullChain(
  plan: RenderPlan,
  o: { caps?: Capabilities; burnSrt?: string; encoder?: string;
       hasAudio?: (id: string) => boolean;
       /** R5 用：把 mediaId 换算成本地缓存文件名（默认按 plan.media 的 url） */
       localPath?: (id: string) => string } = {},
): Chain {
  const c = o.caps ?? caps();
  const ctx = {
    plan, caps: c, encoder: o.encoder ?? "libx264", crf: plan.output.crf,
    localPath: o.localPath ?? ((id: string) => {
      const idx = plan.media.findIndex((m) => m.id === id);
      return plan.media[idx]?.url ?? join(MEDIA, `${id}.mp4`);
    }),
    ...(o.hasAudio ? { hasAudio: o.hasAudio } : {}),
  };

  const segs = buildSegments(plan);
  const segments = segs.map((s, i) => {
    const { args, inputCount } = compileSegment(s, ctx, join(WORK, `seg_${i}.mp4`));
    return {
      kind: s.kind, startSec: s.startSec, endSec: s.endSec,
      boundaryOverlapSec: s.boundaryOverlapSec, inputCount, args,
    };
  });

  const audioClips = plan.tracks
    .filter((t) => t.kind === "audio" && !t.muted)
    .flatMap((t) => t.clips)
    .map((cl) => ({
      path: ctx.localPath(cl.mediaId),
      startSec: cl.timelineStartSec,
      volume: cl.audio.volume,
      muted: cl.audio.muted,
    }))
    .filter((cl) => cl.path);

  const willBurn = !!(o.burnSrt && c.filters.has("subtitles"));
  let final = join(WORK, "merged.mp4");
  const mix = plan.output.withAudio && audioClips.length
    ? compileAudioMix(final, audioClips, join(WORK, "mixed.mp4"), { faststart: !willBurn })
    : null;

  const concat = compileConcat(join(WORK, "list.txt"), final, {
    withAudio: plan.output.withAudio,
    faststart: !mix && !willBurn,
  });
  if (mix) final = join(WORK, "mixed.mp4");

  const burn = willBurn
    ? compileBurnSubtitles(final, join(WORK, "subs.srt"), join(WORK, "final.mp4"),
                           ctx.encoder, plan.output.crf,
                           { videoH: plan.output.height, faststart: true })
    : null;
  if (burn) final = join(WORK, "final.mp4");

  return { segCount: segs.length, segments, concat, mix, burn, finalFile: final };
}

/* ------------------------------------------------------------------ *
 * 真路径 → 基线占位路径
 * ------------------------------------------------------------------ */
function toBase<T>(v: T): T {
  if (typeof v === "string") {
    return v.split(`${MEDIA}/`).join("/BASE/cache/")
            .split(WORK).join("/BASE/work") as unknown as T;
  }
  if (Array.isArray(v)) return v.map(toBase) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = toBase(x);
    return out as unknown as T;
  }
  return v;
}

/** 逐条比对：返回第一处差异的「路径 + 两边的值」，完全一致返回 null */
function firstDiff(a: unknown, b: unknown, path = ""): string | null {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: 一边是数组一边不是`;
    if (a.length !== b.length) return `${path}: 长度 ${a.length} vs 基线 ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    if (ka.join() !== kb.join()) return `${path}: 字段集不同 ${ka.join()} vs ${kb.join()}`;
    for (const k of ka) {
      const d = firstDiff((a as any)[k], (b as any)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return JSON.stringify(a) === JSON.stringify(b)
    ? null : `${path}: ${JSON.stringify(a)} vs 基线 ${JSON.stringify(b)}`;
}

/* ------------------------------------------------------------------ *
 * 执行整条链 + **按 renderer 的规则真删中间文件**
 *
 * renderer.ts 的规则（4.3）：下一道成功产出之后，才删上一道。
 * 这里逐字照做，只是删除动作换成 node fs（`retireFiles` 是 Tauri 插件，见文件头）。
 * ------------------------------------------------------------------ */
interface RunResult { finalPath: string; retired: string[]; okAll: boolean }

function runChain(ch: Chain, o: { srt?: string } = {}): RunResult {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const retired: string[] = [];
  const retire = (files: string[]) => {
    for (const f of files) { rmSync(f, { force: true }); retired.push(f); }
  };

  const segFiles: string[] = [];
  for (let i = 0; i < ch.segments.length; i++) {
    if (!ff(ch.segments[i].args, `段 ${i + 1}/${ch.segments.length}`)) {
      return { finalPath: "", retired, okAll: false };
    }
    segFiles.push(join(WORK, `seg_${i}.mp4`));
  }

  writeFileSync(join(WORK, "list.txt"),
    segFiles.map((f) => `file '${f}'`).join("\n") + "\n");
  if (!ff(ch.concat, "concat")) return { finalPath: "", retired, okAll: false };
  retire(segFiles);                                   // renderer.ts:333

  let final = join(WORK, "merged.mp4");
  if (ch.mix) {
    if (!ff(ch.mix, "混音")) return { finalPath: "", retired, okAll: false };
    const prev = final; final = join(WORK, "mixed.mp4");
    retire([prev]);                                   // renderer.ts:347
  }
  if (ch.burn) {
    writeFileSync(join(WORK, "subs.srt"), o.srt ?? SRT_TEXT);
    if (!ff(ch.burn, "烧字幕")) return { finalPath: "", retired, okAll: false };
    const prev = final; final = join(WORK, "final.mp4");
    retire([prev]);                                   // renderer.ts:385（必须在 runFfmpeg 之后）
  }
  return { finalPath: final, retired, okAll: true };
}

/** 每次运行后都查一遍：删掉的东西里绝不能有缓存目录里的素材 */
function assertCacheUntouched(r: RunResult, label: string) {
  const bad = r.retired.filter((f) => f.startsWith(MEDIA));
  ok(bad.length === 0, `${label}：清理清单一个都没碰缓存目录`,
     bad.length ? bad.join(", ") : `删了 ${r.retired.length} 个中间产物`);
}

/* ================================================================== *
 * ① 三份基线：各导一次，逐条比对 + 真出片
 * ================================================================== */
interface Case {
  key: string;                       // 黄金基线里的场景名
  title: string;
  plan: RenderPlan;
  chainOpts: Parameters<typeof fullChain>[1];
  /** 期望在成片里看到的素材颜色（证明每一镜的画面都真的进去了） */
  wantColours: string[];
  wantAudio: boolean;
  /** 成片实际该有多长。缺省 = plan.totalSec；转场会吃掉重叠，必须写明白而不是放宽容差 */
  expectDur?: number;
}

function baseCases(): Case[] {
  return [
    {
      key: "01-纯AI镜头带字幕",
      title: "① 纯 AI 镜头带字幕（passthrough + concat + 混音 + 烧字幕）",
      plan: mkPlan(
        [0, 1, 2, 3].map((i) => clip(i, i * 4, 4)),
        { audioTrack: [clip(90, 0, 16, { mediaId: "bgm", audio: { ...DEFAULT_AUDIO, volume: 0.4 } })],
          mediaIds: ["m0", "m1", "m2", "m3", "bgm"] },
      ),
      chainOpts: { burnSrt: SRT_TEXT },
      wantColours: ["红", "绿", "蓝", "黄"],
      wantAudio: true,
    },
    {
      key: "02-合拢后带转场",
      title: "② 合拢后带转场（composite + xfade）",
      plan: (() => {
        const cs = [0, 1, 2, 3].map((i) => clip(i, i * 3, 3));
        const trs: RenderTransition[] = [1, 2, 3].map((i) => ({
          id: `t${i}`, type: "fade", durationSec: 0.5,
          fromClipId: `c${i - 1}`, toClipId: `c${i}`,
        }));
        return mkPlan(cs, { transitions: trs });
      })(),
      chainOpts: {},
      wantColours: ["红", "绿", "蓝", "黄"],
      // 4 镜各 3s = 12s，但 3 段 0.5s 转场各吃掉一次重叠 → 12 - 1.5 = 10.5s。
      // 写死这个值而不是放宽容差：转场若悄悄没生效，时长会变回 12s，必须红。
      wantAudio: true, expectDur: 12 - 3 * 0.5,
    },
    {
      key: "03-马赛克三形状",
      title: "③ 马赛克三形状（drawbox / split-crop-overlay / geq）",
      plan: mkPlan([
        clip(0, 0, 3, { effects: [mosaic({ style: "blackbox" })] }),
        clip(1, 3, 3, { effects: [mosaic({ style: "pixel", intensity: 60 })] }),
        clip(2, 6, 3, { effects: [mosaic({ style: "gaussblur", shape: "ellipse" })] }),
        clip(3, 9, 3, { effects: [mosaic({
          style: "pixel", shape: "brush", brushSize: 0.08,
          stroke: Array.from({ length: 12 }, (_, i) => ({ x: 0.2 + i * 0.05, y: 0.4 + (i % 3) * 0.03 })),
        })] }),
        clip(4, 12, 3, { effects: [
          mosaic({ x: 0.1, y: 0.1, w: 0.2, h: 0.15 }),
          mosaic({ x: 0.6, y: 0.7, w: 0.2, h: 0.15, style: "gaussblur" }),
        ] }),
      ]),
      chainOpts: {},
      wantColours: ["红", "绿", "蓝", "黄", "品红"],
      wantAudio: true,
    },
  ];
}

/** 时长容差：mp4 时基取整 + 末帧时长，正常只差几十毫秒。放宽等于不查 */
const DUR_TOL = 0.3;

function checkFinal(
  file: string, plan: RenderPlan, want: { colours: string[]; audio: boolean; dur?: number },
  label: string,
) {
  const wantDur = want.dur ?? plan.totalSec;
  ok(existsSync(file) && statSync(file).size > 0, `${label}：成片文件真的在（清理没删掉它）`,
     existsSync(file) ? `${(statSync(file).size / 1048576).toFixed(1)}MB` : "不存在");
  const info = probe(file);
  ok(!!info, `${label}：成片可被 ffprobe 解析`);
  if (!info) return;
  const v = info.streams.find((s: any) => s.codec_type === "video");
  const a = info.streams.find((s: any) => s.codec_type === "audio");
  const dur = parseFloat(info.format.duration);
  ok(v?.width === W && v?.height === H, `${label}：分辨率 ${W}×${H}`,
     `${v?.width}×${v?.height}`);
  ok(Math.abs(dur - wantDur) <= DUR_TOL, `${label}：时长 ${wantDur.toFixed(2)}s（±${DUR_TOL}）`,
     `实测 ${dur.toFixed(2)}s`);
  ok(want.audio ? !!a : !a,
     `${label}：${want.audio ? "有音频流" : "没有音频流（-an 生效）"}`,
     a ? `${a.codec_name}` : "无音轨");

  const seen = colourSweep(file, dur);
  const missing = want.colours.filter((c) => !seen.has(c));
  ok(missing.length === 0, `${label}：每一镜的画面都出现在成片里`,
     missing.length ? `缺 ${missing.join("/")}，只看到 ${[...seen].join("/") || "（全黑）"}`
                    : `${[...seen].join("/")}`);
}

/* ================================================================== */
async function main() {
  console.log(`\n══ 批次 4「导出主链路」验收 · 真跑 ffmpeg ══`);
  console.log(`   工作目录 ${ROOT}`);

  const ver = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (ver.status !== 0) { console.log("💥 找不到 ffmpeg"); process.exit(1); }
  console.log(`   ${(ver.stdout || "").split("\n")[0]}\n`);

  console.log("[0] 生成纯色测试素材");
  if (!makeMedia()) { console.log("💥 素材生成失败"); process.exit(1); }
  ok(PALETTE.every((_, i) => existsSync(src(i))), "5 个素材就绪",
     PALETTE.map((p) => p.name).join("/"));

  /* ---------------------------------------------------------------- *
   * [0.5] 先证明「逐条比对」本身是承重的
   *
   * 下面 [1] 的核心断言是 `firstDiff(toBase(chain), golden) === null`。
   * 这条断言有两种**假绿**的死法，且两种都不会报错：
   *   · toBase 没真替换 → 但凡 golden 里也存的是真路径，就恒等（这里不会，
   *     所以反过来：不替换必须**红**，红了才说明比对确实在看路径）；
   *   · firstDiff 写漏了某种情形（长度、缺字段、null vs 数组）→ 恒返回 null，
   *     那么 [1] 的三条 ✅ 全是装饰。
   * 所以先在这里把它逐种打红一遍。这一段不跑 ffmpeg，零成本。
   * ---------------------------------------------------------------- */
  console.log("\n[0.5] 自检：先证明「与黄金基线逐条比对」这条断言是承重的");
  {
    const probeCase = baseCases()[0];
    const raw = fullChain(probeCase.plan, probeCase.chainOpts);
    const g = golden[probeCase.key];

    const rawJson = JSON.stringify(raw);
    ok(rawJson.includes(MEDIA) && rawJson.includes(WORK),
       "编译出来的链里确实是**真机路径**（说明它真的能拿去跑）");
    const mapped = JSON.stringify(toBase(raw));
    ok(!mapped.includes(MEDIA) && !mapped.includes(WORK)
       && mapped.includes("/BASE/cache/") && mapped.includes("/BASE/work"),
       "toBase 把两个根路径都换成了基线占位（一个残留都没有）");
    ok(firstDiff(raw, g) !== null,
       "**不**做路径替换直接比对 → 必须红（否则说明比对根本没在看路径）",
       String(firstDiff(raw, g)).slice(0, 80));
    ok(firstDiff(toBase(raw), g) === null, "做了替换才相同（对照）");

    // firstDiff 的每一种差异形态都要能抓住
    const clone = () => JSON.parse(JSON.stringify(toBase(raw)));
    const cases: { name: string; break: (c: any) => void }[] = [
      { name: "改掉一个 argv token（-crf 的值）",
        break: (c) => { c.segments[0].args[c.segments[0].args.indexOf("23")] = "18"; } },
      { name: "少一个 argv token",
        break: (c) => { c.segments[0].args.splice(3, 1); } },
      { name: "多一段",
        break: (c) => { c.segments.push(c.segments[0]); } },
      { name: "段数字段与实际不符",
        break: (c) => { c.segCount = 99; } },
      { name: "数值字段变了（段的起止秒）",
        break: (c) => { c.segments[0].endSec = 3.5; } },
      { name: "该有的整道没了（burn 变 null）",
        break: (c) => { c.burn = null; } },
      { name: "成片文件名变了",
        break: (c) => { c.finalFile = "/BASE/work/merged.mp4"; } },
      { name: "多出一个字段",
        break: (c) => { c.extra = 1; } },
    ];
    let escaped = 0;
    for (const t of cases) {
      const c = clone();
      t.break(c);
      const d = firstDiff(c, g);
      if (d === null) escaped++;
      ok(d !== null, `firstDiff 抓得住：${t.name}`, d ?? "**逃逸了**");
    }
    ok(escaped === 0, `${cases.length} 种差异形态无一逃逸`);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n[1] 三份基线各导一次：argv 与黄金基线逐条比对，然后**真的执行它**");

  for (const c of baseCases()) {
    console.log(`\n  ── ${c.title}`);
    const ch = fullChain(c.plan, c.chainOpts);
    const g = golden[c.key];
    ok(!!g && !g.__error__, `黄金基线里有「${c.key}」这个场景`);
    const diff = g ? firstDiff(toBase(ch), g) : "基线缺失";
    ok(diff === null, "编译出的整条链与黄金基线**逐条**相同（argv 是同一份）",
       diff ?? `${ch.segCount} 段`);

    const t0 = Date.now();
    const r = runChain(ch, { srt: SRT_TEXT });
    ok(r.okAll, "这份 argv 真的能跑完（每一道 ffmpeg 退出码 0）",
       `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (!r.okAll) continue;
    ok(r.finalPath === ch.finalFile, "交付的文件就是链路声明的成片",
       `${basename(r.finalPath)}`);
    assertCacheUntouched(r, "  清理");
    checkFinal(r.finalPath, c.plan,
      { colours: c.wantColours, audio: c.wantAudio, dur: c.expectDur }, "  成片");
  }

  /* ---------------------------------------------------------------- */
  console.log("\n[2] 三个降级组合：必须成功出片，且成片不能被 4.3 的清理删掉");

  // ② -1 完全无音频 → 成片 = merged.mp4
  {
    console.log("\n  ── ① 完全无音频（成片=merged.mp4）");
    const plan = mkPlan([0, 1].map((i) => clip(i, i * 4, 4)), { withAudio: false });
    const ch = fullChain(plan);
    const diff = firstDiff(toBase(ch), golden["04-降级-无音频"]);
    ok(diff === null, "与黄金基线 04 逐条相同", diff ?? "");
    ok(ch.mix === null && ch.burn === null, "混音与烧字幕都不跑");
    ok(basename(ch.finalFile) === "merged.mp4", "成片就是 merged.mp4",
       basename(ch.finalFile));
    const r = runChain(ch);
    ok(r.okAll, "真跑通");
    assertCacheUntouched(r, "  清理");
    ok(!r.retired.includes(join(WORK, "merged.mp4")),
       "merged.mp4 **没有**被列进清理清单（§0.5(h) 的第一颗雷）");
    if (r.okAll) {
      checkFinal(r.finalPath, plan, { colours: ["红", "绿"], audio: false }, "  成片");
    }
  }

  // ② -2 有字幕但探测不到 subtitles 滤镜 → 成片 = mixed.mp4
  {
    console.log("\n  ── ② 有字幕但 ffmpeg 无 subtitles 滤镜（成片=mixed.mp4）");
    const plan = mkPlan([0, 1].map((i) => clip(i, i * 4, 4)),
      { audioTrack: [clip(90, 0, 8, { mediaId: "bgm" })], mediaIds: ["m0", "m1", "bgm"] });
    const ch = fullChain(plan, { caps: caps({ drop: ["subtitles"] }), burnSrt: SRT_TEXT });
    const diff = firstDiff(toBase(ch), golden["05-降级-无字幕滤镜"]);
    ok(diff === null, "与黄金基线 05 逐条相同", diff ?? "");
    ok(ch.burn === null, "烧字幕这一道被跳过（能力不足时降级而非失败）");
    ok(basename(ch.finalFile) === "mixed.mp4", "成片停在 mixed.mp4", basename(ch.finalFile));
    const r = runChain(ch);
    ok(r.okAll, "真跑通");
    assertCacheUntouched(r, "  清理");
    ok(!r.retired.includes(join(WORK, "mixed.mp4")),
       "mixed.mp4 **没有**被列进清理清单（§0.5(h) 的第二颗雷）");
    if (r.okAll) {
      checkFinal(r.finalPath, plan, { colours: ["红", "绿"], audio: true }, "  成片");
    }
  }

  // ② -3 同一素材被多个镜头引用 → 缓存文件不能被提前删
  {
    console.log("\n  ── ③ 同一素材被多个镜头引用（缓存文件要活到最后）");
    const plan = mkPlan([
      clip(0, 0, 3, { mediaId: "m0" }),
      clip(1, 3, 3, { mediaId: "m0" }),
      clip(2, 6, 3, { mediaId: "m0", transform: { ...DEFAULT_TRANSFORM, scale: 0.8 } }),
    ], { mediaIds: ["m0"] });
    const ch = fullChain(plan);
    const diff = firstDiff(toBase(ch), golden["06-同素材多镜引用"]);
    ok(diff === null, "与黄金基线 06 逐条相同", diff ?? "");

    const before = md5(src(0));
    const refs = ch.segments.flatMap((s) => s.args.filter((a) => a === src(0))).length;
    ok(refs >= 3, "同一个缓存文件在多段 argv 里被引用", `${refs} 次`);

    const r = runChain(ch);
    ok(r.okAll, "真跑通");
    assertCacheUntouched(r, "  清理");
    ok(existsSync(src(0)) && md5(src(0)) === before,
       "跑完之后缓存素材仍在、且逐字节没变（不能因为「用完了」就删）");
    if (r.okAll) {
      // 三镜同源，颜色只有红一种；这里要证的是"三段都在"，用时长
      checkFinal(r.finalPath, plan, { colours: ["红"], audio: true }, "  成片");
    }
  }

  /* ---------------------------------------------------------------- */
  console.log("\n[3] R5：两个 basename 相同、URL 不同的素材，导出必须各是各的画面");

  {
    const urlA = "/fw/media/proj-1/shot-aaaa/output.mp4";
    const urlB = "/fw/media/proj-1/shot-bbbb/output.mp4";
    ok(basename(urlA) === basename(urlB),
       "两个素材的 basename 完全相同（output.mp4 在本项目里是常态）", basename(urlA));

    const nA = cacheFileName(urlA), nB = cacheFileName(urlB);
    ok(nA !== nB, "真命名函数把它们分到两个缓存文件", `${nA} / ${nB}`);
    // 反证：4.5 之前用的是裸 basename，两者会撞成同一份
    ok(basename(urlA) === basename(urlB) && nA !== nB,
       "而 4.5 之前的裸 basename 命名会把它们撞成同一份 —— 这正是当时的 bug");

    // 把两个不同颜色的素材按**真命名**落进缓存目录
    const cacheOf = (u: string) => join(MEDIA, cacheFileName(u));
    writeFileSync(cacheOf(urlA), readFileSync(src(0)));   // 红
    writeFileSync(cacheOf(urlB), readFileSync(src(1)));   // 绿

    const r5plan: RenderPlan = {
      projectId: "r5",
      media: [
        { id: "sa", url: urlA, kind: "video", durationSec: 8 },
        { id: "sb", url: urlB, kind: "video", durationSec: 8 },
      ],
      tracks: [{
        id: "v1", kind: "video", layer: 1, muted: false, hidden: false,
        clips: [
          clip(0, 0, 3, { id: "ca", mediaId: "sa" }),
          clip(1, 3, 3, { id: "cb", mediaId: "sb" }),
        ],
      }],
      transitions: [], subtitles: [],
      output: { width: W, height: H, fps: FPS, vcodec: "libx264", crf: 23, withAudio: true },
      totalSec: 6,
    };

    // 修好之后：localPath 走真命名函数（与 ensureCached 同一份）
    const fixed = fullChain(r5plan, {
      localPath: (id) => cacheOf(r5plan.media.find((m) => m.id === id)!.url),
    });
    const rf = runChain(fixed);
    ok(rf.okAll, "按真命名导出，跑通");
    if (rf.okAll) {
      const c1 = classify(rgbAt(rf.finalPath, 1.5));
      const c2 = classify(rgbAt(rf.finalPath, 4.5));
      ok(c1 === "红" && c2 === "绿",
         "第一镜是自己的画面、第二镜也是自己的画面",
         `1.5s=${c1 ?? "?"} 4.5s=${c2 ?? "?"}`);
    }

    // 反向对照：把 localPath 换成 4.5 之前的裸 basename 命名，同一条链再导一次。
    // 它**必须**导出两段一样的画面 —— 否则上面那条断言根本不承重。
    const naiveDir = join(ROOT, "naive");
    mkdirSync(naiveDir, { recursive: true });
    const naiveOf = (u: string) => join(naiveDir, basename(u));
    writeFileSync(naiveOf(urlA), readFileSync(src(0)));   // 后写的会覆盖先写的
    writeFileSync(naiveOf(urlB), readFileSync(src(0)));   // ← 裸 basename 的真实后果
    ok(naiveOf(urlA) === naiveOf(urlB), "裸 basename 下两个 URL 指向同一个文件路径");
    const broken = fullChain(r5plan, {
      localPath: (id) => naiveOf(r5plan.media.find((m) => m.id === id)!.url),
    });
    const rb = runChain(broken);
    if (rb.okAll) {
      const b1 = classify(rgbAt(rb.finalPath, 1.5));
      const b2 = classify(rgbAt(rb.finalPath, 4.5));
      ok(b1 === "红" && b2 === "红",
         "对照组（老命名）确实两镜同画面 —— 上面那条断言是承重的，不是摆设",
         `1.5s=${b1 ?? "?"} 4.5s=${b2 ?? "?"}`);
    } else {
      ok(false, "对照组没跑起来，无法证明上面那条断言承重");
    }

    // legacy（FineCut / 经典导出）那条链：Tauri 绑定，node 下跑不了，只做源码断言
    const LOCAL = readFileSync(join(HERE, "..", "src/lib/localRender.ts"), "utf8");
    ok(/export async function cacheClip\([^)]*\): Promise<string> \{\s*\n\s*return ensureCached\(projectId, url\);/
       .test(LOCAL),
       "FineCut 走的 cacheClip 已是 ensureCached 的薄壳（与上面用的是同一个命名函数）");
    ok(!/split\("\/"\)\.pop\(\)/.test(LOCAL),
       "localRender 里不再有第二份 basename 命名逻辑");
  }

  /* ---------------------------------------------------------------- */
  console.log(fail === 0
    ? `\n✅ 批次 4 验收全部通过：${pass} 项。`
      + "\n   三份基线的 argv 与黄金基线逐条一致且真的跑得出片；"
      + "\n   三个降级组合都出片、成片没被清理误删、缓存目录一个文件没动；"
      + "\n   同 basename 不同 URL 的素材各是各的画面（老命名对照组确实撞车）。"
      + `\n   产物留在 ${WORK}，素材在 ${MEDIA}\n`
    : `\n❌ 批次 4 验收：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\n💥", e); process.exit(1); });
