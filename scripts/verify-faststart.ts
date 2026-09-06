/**
 * verify-faststart.ts — `+faststart` 只给最后一道产物（批次 4 / 4.2）
 *
 * ## 为什么这条值得单独立一个脚本
 *
 * `+faststart` 把 moov 原子挪到文件头，手段是**整个文件再读写一遍**。
 * 这条流水线最多有四道产物（seg_*.mp4 → merged.mp4 → mixed.mp4 → final.mp4），
 * 4.2 之前**五个输出全带**，等于在一次导出里白做四五遍全文件重写；
 * 1424 镜项目的分段产物几十 GB，段数越多亏得越多。
 *
 * 改完之后，正确性靠的是一条**动态**不变式：
 *
 *     段上一处都没有；尾段恰好一处；且它落在「实际交付给用户的那个文件」那一道。
 *
 * 「哪一道是最后一道」不是常量——取决于混音跑不跑、字幕烧不烧。所以这不能
 * 静态写成"只有 burnSubtitles 加 faststart"，必须把流水线的每种形状都走一遍。
 *
 * ## 两个方向的错都不会报错，这才是要钉住它的真正原因
 *
 *   · 中间产物多带了 → 只是慢。没有任何人会把"导出有点慢"归因到这里。
 *   · 成片少带了     → 本地播放**完全正常**，只有网页边下边播的用户会遇到
 *                      "要整包下完才起播"。测试机上永远复现不了。
 *
 * 两个方向都静默，所以它只能靠断言守，不能靠"下次注意"。
 *
 * ## 最阴的那条：`mixArgs` 而不是 `audioClips.length`
 *
 * 「有没有音频 clip」≠「混音会不会跑」：`compileAudioMix` 内部还要过一道
 * `!muted && volume > 0 && path` 的筛，全部静音时它返回 null。若拿
 * `audioClips.length > 0` 当判据，concat 会以为"后面还有混音"而不加 faststart，
 * 结果混音没跑，交付的 merged.mp4 一处 faststart 都没有。③ 段的「全部静音」
 * 用例专门盯这个。
 *
 * 跑法：npx tsx scripts/verify-faststart.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileSegment, compileConcat, compileAudioMix, compileBurnSubtitles,
} from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type { RenderPlan, RenderClip, RenderTrack } from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const COMPILER = read("src/render/ffmpegCompiler.ts");
const RENDERER = read("src/render/renderer.ts");
const BASELINE_SRC = read("scripts/baseline-export.ts");

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}
function check(name: string, actual: unknown, expected: unknown, detail = "") {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!eq) failed++;
  console.log(`  ${eq ? "✅" : "❌"} ${name}`);
  if (!eq) {
    console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
    if (detail) console.log(`      ${detail}`);
  }
}

/** argv 里 `-movflags +faststart` 出现了几次 */
function count(args: string[]): number {
  let n = 0;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-movflags" && args[i + 1] === "+faststart") n++;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * 夹具（与 baseline-export.ts 同款：路径写死，与机器无关）
 * ------------------------------------------------------------------ */
const W = 1080, H = 1920;
const FULL = [
  "xfade", "overlay", "scale", "pad", "setpts", "trim", "concat", "eq",
  "subtitles", "format", "drawbox", "geq", "gblur", "unsharp",
];

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    version: "4.4.2-faststart", available: true, hwEncoders: [],
    filters: new Set(FULL), transitions: new Set(["fade"]),
    probedAt: 0, ...over,
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

function mkPlan(o: {
  audio?: RenderClip[]; withAudio?: boolean; composite?: boolean;
} = {}): RenderPlan {
  // composite=true 时给两镜加缩放，逼出 filter_complex 那条路径
  const vclips = o.composite
    ? [0, 1].map((i) => clip(i, i * 4, 4, {
        transform: { ...DEFAULT_TRANSFORM, scale: 0.9 },
      }))
    : [0, 1].map((i) => clip(i, i * 4, 4));
  const tracks: RenderTrack[] = [
    { id: "v1", kind: "video", layer: 1, muted: false, hidden: false, clips: vclips },
  ];
  if (o.audio) {
    tracks.push({ id: "a1", kind: "audio", layer: 0, muted: false, hidden: false, clips: o.audio });
  }
  const ids = [...new Set([...vclips, ...(o.audio ?? [])].map((c) => c.mediaId))];
  return {
    projectId: "faststart",
    media: ids.map((id, i) => ({ id, url: `/BASE/cache/m${i}.mp4`, kind: "video" as const, durationSec: 8 })),
    tracks, transitions: [], subtitles: [],
    output: { width: W, height: H, fps: 30, vcodec: "libx264", crf: 23, withAudio: o.withAudio ?? true },
    totalSec: 8,
  };
}

/* ================================================================== */
console.log("\n① 段产物：一处都不许有（它们只是下一道 ffmpeg 的输入）");
/* ================================================================== */

for (const composite of [false, true]) {
  const plan = mkPlan({ composite });
  const ctx = {
    plan, caps: caps(), encoder: "libx264", crf: 23,
    localPath: (id: string) => `/BASE/cache/${id}.mp4`,
    hasAudio: () => true,
  };
  const segs = buildSegments(plan);
  ok(`buildSegments 真的产出了${composite ? " composite" : " passthrough"}段（夹具没跑空）`,
    segs.length > 0 && segs.some((s) => s.kind === (composite ? "composite" : "passthrough")),
    `实际段：${segs.map((s) => s.kind).join(",") || "（空）"}`);
  const total = segs.reduce(
    (n, s, i) => n + count(compileSegment(s, ctx, `/BASE/work/seg_${i}.mp4`).args), 0);
  check(`${composite ? "composite" : "passthrough"} 段的 faststart 总数`, total, 0,
    "分段产物动辄几 GB，段数越多亏得越多；而它们从不被播放器打开");
}

/* ================================================================== */
console.log("\n② 尾段三个编译器：faststart 是必填开关，位置在输出文件名之前");
/* ================================================================== */

const MIX_CLIPS = [{ path: "/BASE/cache/bgm.mp4", startSec: 0, volume: 0.4, muted: false }];
const tailOf = (fs: boolean) => ({
  concat: compileConcat("/BASE/work/list.txt", "/BASE/work/merged.mp4", { withAudio: true, faststart: fs }),
  mix: compileAudioMix("/BASE/work/merged.mp4", MIX_CLIPS, "/BASE/work/mixed.mp4", { faststart: fs })!,
  burn: compileBurnSubtitles("/BASE/work/mixed.mp4", "/BASE/work/subs.srt", "/BASE/work/final.mp4",
    "libx264", 23, { videoH: H, faststart: fs }),
});
const on = tailOf(true), off = tailOf(false);
for (const k of ["concat", "mix", "burn"] as const) {
  check(`${k}: faststart=true → 恰好一处`, count(on[k]), 1);
  check(`${k}: faststart=false → 零处`, count(off[k]), 0);
  const i = on[k].indexOf("-movflags");
  ok(`${k}: -movflags 排在输出文件名之前`, i >= 0 && i < on[k].length - 2,
    "ffmpeg 把输出路径之后的参数当成下一个输出的选项，放错位置会直接报错");
  check(`${k}: 除 faststart 外两者逐字节相同`,
    on[k].filter((a) => a !== "-movflags" && a !== "+faststart"), off[k],
    "这个开关只许影响这一对参数，不许顺带改别的");
}

ok("TailOpts.faststart 是必填（没有 `?`，也没给默认值）",
  /export interface TailOpts \{[\s\S]{0,200}?\n  faststart: boolean;/.test(COMPILER)
  && !/faststart\?:/.test(COMPILER)
  && !/faststart \?\?/.test(COMPILER),
  "给了默认值就等于允许「忘了想」，而忘了想的两个方向都不报错——"
  + "必填才能让 tsc 在每个调用点上逼一次决定");
ok("三个尾段编译器都只经 faststartArgs 产出这对参数（没人再手写字面量）",
  (COMPILER.match(/\.\.\.faststartArgs\(o\), outPath/g) ?? []).length === 3
  && (COMPILER.match(/"\+faststart"/g) ?? []).length === 1,
  "手写第二处的话，这里的开关就管不住它了");
// 只看**代码**：切片的终点若取 `export interface TailOpts`，会把它上面那段
// 讲 faststart 的文档注释一起吃进来，于是断言恒假（第一版就是这么红的）。
const segBody = COMPILER
  .slice(COMPILER.indexOf("export function compileSegment"),
         COMPILER.indexOf("export interface TailOpts"))
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
ok("compileSegment 那两条路径的代码里没有任何 faststart 字面量",
  !/faststart/.test(segBody),
  "段产物加 faststart 是 4.2 之前的老账，回潮了这里就该红");

/* ================================================================== */
console.log("\n③ 整条流水线：每种形状都恰好一处，且落在成片那一道");
/* ================================================================== */

/**
 * 复刻 renderer.ts 的尾段决策。
 * ⚠️ 这里必须与 renderer.ts **同构**——④ 段用静态断言钉住两边没有漂移。
 */
function pipeline(o: {
  audio?: RenderClip[]; withAudio?: boolean; srt?: string; noSubtitleFilter?: boolean;
}): { stages: Record<string, number>; finalFile: string } {
  const plan = mkPlan({ audio: o.audio, withAudio: o.withAudio });
  const c = o.noSubtitleFilter
    ? caps({ filters: new Set(FULL.filter((f) => f !== "subtitles")) })
    : caps();

  const audioClips = plan.output.withAudio
    ? plan.tracks.filter((t) => t.kind === "audio" && !t.muted)
      .flatMap((t) => t.clips)
      .map((cl) => ({
        path: `/BASE/cache/${cl.mediaId}.mp4`, startSec: cl.timelineStartSec,
        volume: cl.audio.volume, muted: cl.audio.muted,
      }))
      .filter((cl) => cl.path)
    : [];

  const willBurn = !!o.srt?.trim() && c.filters.has("subtitles");
  const mixArgs = audioClips.length
    ? compileAudioMix("/BASE/work/merged.mp4", audioClips, "/BASE/work/mixed.mp4",
      { faststart: !willBurn })
    : null;
  const concat = compileConcat("/BASE/work/list.txt", "/BASE/work/merged.mp4",
    { withAudio: plan.output.withAudio, faststart: !mixArgs && !willBurn });

  let finalFile = "merged.mp4";
  if (mixArgs) finalFile = "mixed.mp4";
  const burn = willBurn
    ? compileBurnSubtitles(`/BASE/work/${finalFile}`, "/BASE/work/subs.srt",
      "/BASE/work/final.mp4", "libx264", 23, { videoH: H, faststart: true })
    : null;
  if (burn) finalFile = "final.mp4";

  return {
    stages: {
      concat: count(concat),
      mix: mixArgs ? count(mixArgs) : 0,
      burn: burn ? count(burn) : 0,
    },
    finalFile,
  };
}

const bgm = (over: Partial<RenderClip> = {}) =>
  [clip(90, 0, 8, { mediaId: "bgm", audio: { ...DEFAULT_AUDIO, volume: 0.4 }, ...over })];
const SRT = "1\n00:00:00,000 --> 00:00:02,000\n你好\n";

const SHAPES: { name: string; why: string; run: () => ReturnType<typeof pipeline>; want: string }[] = [
  { name: "concat 独一道（无音频、无字幕）", want: "merged.mp4",
    why: "§0.5(h)：成片就是 merged.mp4，它必须自己带",
    run: () => pipeline({ withAudio: false }) },
  { name: "concat + 混音", want: "mixed.mp4",
    why: "成片是 mixed.mp4，concat 不该带",
    run: () => pipeline({ audio: bgm() }) },
  { name: "concat + 烧字幕（无音轨）", want: "final.mp4",
    why: "跳过混音，concat 仍不该带——因为后面还有烧字幕",
    run: () => pipeline({ withAudio: false, srt: SRT }) },
  { name: "concat + 混音 + 烧字幕（最长的一条）", want: "final.mp4",
    why: "只有最后的 burn 带；前两道都是中间产物",
    run: () => pipeline({ audio: bgm(), srt: SRT }) },
  { name: "降级：有字幕但 ffmpeg 无 subtitles 滤镜 + 有音轨", want: "mixed.mp4",
    why: "烧字幕被跳过，成片停在 mixed.mp4——混音那道必须**提前知道**自己是最后一道",
    run: () => pipeline({ audio: bgm(), srt: SRT, noSubtitleFilter: true }) },
  { name: "降级：无 subtitles 滤镜且无音轨", want: "merged.mp4",
    why: "两步都被跳过，成片一路退回 merged.mp4",
    run: () => pipeline({ withAudio: false, srt: SRT, noSubtitleFilter: true }) },
  { name: "有音频 clip 但**全部静音** → 混音不跑", want: "merged.mp4",
    why: "audioClips.length > 0 而 compileAudioMix 返回 null。"
       + "拿 length 当判据的话这里会一处 faststart 都没有",
    run: () => pipeline({ audio: bgm({ audio: { ...DEFAULT_AUDIO, muted: true } }) }) },
  { name: "有音频 clip 但音量为 0 → 混音不跑", want: "merged.mp4",
    why: "同上，走的是 compileAudioMix 里 `volume > 0` 那道筛",
    run: () => pipeline({ audio: bgm({ audio: { ...DEFAULT_AUDIO, volume: 0 } }) }) },
  { name: "withAudio=false 但工程里有音频轨 → 混音不跑", want: "merged.mp4",
    why: "用户取消勾选「包含音轨」；concat 会加 -an，成片就是 merged.mp4",
    run: () => pipeline({ audio: bgm(), withAudio: false }) },
];

const STAGE_OF: Record<string, string> = {
  "merged.mp4": "concat", "mixed.mp4": "mix", "final.mp4": "burn",
};
for (const s of SHAPES) {
  const r = s.run();
  const total = r.stages.concat + r.stages.mix + r.stages.burn;
  const want = STAGE_OF[r.finalFile];
  const good = r.finalFile === s.want && total === 1 && r.stages[want] === 1;
  ok(`${s.name} → 成片=${r.finalFile}，faststart 在 ${want}`, good,
    `期望成片=${s.want}；实际 concat=${r.stages.concat} mix=${r.stages.mix} `
    + `burn=${r.stages.burn} 成片=${r.finalFile}。${s.why}`);
}

/* ================================================================== */
console.log("\n④ 静态钉：renderer 与 baseline 的判据必须是同一套");
/* ================================================================== */

ok("renderer：混音判据用的是 mixArgs 本身，不是 audioClips.length",
  /const mixArgs = audioClips\.length\s*\n?\s*\? compileAudioMix/.test(RENDERER)
  && /if \(mixArgs\) \{/.test(RENDERER)
  && !/audioClips\.length > 0/.test(RENDERER),
  "让同一个对象决定「混不混」和「concat 是不是最后一道」，两者就不可能漂移");
ok("renderer：concat 的判据是 `!mixArgs && !willBurn`",
  /faststart: !mixArgs && !willBurn,/.test(RENDERER));
ok("renderer：混音的判据是 `!willBurn`",
  /compileAudioMix\(final, audioClips, mixOut, \{ faststart: !willBurn \}\)/.test(RENDERER));
ok("renderer：willBurn 只算一次，烧字幕分支复用它而不是重算 hasFilter",
  (RENDERER.match(/const willBurn =/g) ?? []).length === 1
  && (RENDERER.match(/hasFilter\(caps, "subtitles"\)/g) ?? []).length === 1
  && /if \(!willBurn\) \{/.test(RENDERER),
  "两处各写一份判据一旦漂移，症状是成片**一处 faststart 都没有**——"
  + "前一道以为字幕会烧、字幕这边却跳过了");
ok("renderer：烧字幕永远 faststart: true",
  /faststart: true,\s*\/\/ 烧字幕永远是最后一道/.test(RENDERER));
ok("renderer：willBurn 定在 concat 调用之前（顺序反了就拿不到判据）",
  RENDERER.indexOf("const willBurn =") < RENDERER.indexOf("compileConcat(listPath, final"));

ok("baseline-export 与 renderer 用同一套判据（否则基线钉的是不存在的分布）",
  /faststart: !mixArgs && !willBurn,/.test(RENDERER)
  && /faststart: !mix && !willBurn,/.test(BASELINE_SRC)
  && /\{ faststart: !willBurn \}/.test(BASELINE_SRC)
  && /faststart: true \}/.test(BASELINE_SRC));
ok("baseline-export 里 willBurn 也定在 mix / concat 之前",
  BASELINE_SRC.indexOf("const willBurn =") < BASELINE_SRC.indexOf("const mix =")
  && BASELINE_SRC.indexOf("const mix =") < BASELINE_SRC.indexOf("const concat ="));

/* ================================================================== */
console.log("\n⑤ 黄金基线文件本身也要满足这条不变式");
/* ================================================================== */

const golden = JSON.parse(read("scripts/__baseline__/export-argv.json")) as Record<string, unknown>;
function deepCount(v: unknown): number {
  if (Array.isArray(v)) {
    return count(v.filter((x): x is string => typeof x === "string"))
      + v.reduce<number>((n, x) => n + (typeof x === "string" ? 0 : deepCount(x)), 0);
  }
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).reduce<number>((n, x) => n + deepCount(x), 0);
  }
  return 0;
}
let chains = 0, violations = 0;
for (const [name, sc] of Object.entries(golden)) {
  if (name === "__meta__") continue;
  const s = sc as Record<string, unknown>;
  if (!("segments" in s)) continue;   // 09 是 compileMosaicFilters 的直接快照，不走链路
  chains++;
  const fin = String(s.finalFile).split("/").pop()!;
  const got = {
    segments: deepCount(s.segments), concat: deepCount(s.concat),
    mix: deepCount(s.mix), burn: deepCount(s.burn),
  };
  const want = STAGE_OF[fin];
  const good = got.segments === 0 && got.concat + got.mix + got.burn === 1
    && got[want as "concat" | "mix" | "burn"] === 1;
  if (!good) violations++;
  ok(`基线 ${name}：成片=${fin}，faststart 在 ${want}`, good, JSON.stringify(got));
}
// 写死个数是故意的：某个场景 build 抛异常时会被写成 `__error__`（没有 segments），
// 于是它悄悄从上面的循环里消失、一条 ❌ 都不留。数一遍才抓得到。
// 4.6 加了 10/11 两个轨道开关场景，8 → 10（09 是滤镜片段快照，从来不走链路）。
check("基线里参与完整链路的场景数", chains, 10,
  "少了说明有场景没跑通（build 抛异常会写成 __error__）");
check("基线违规场景数", violations, 0);

/* ================================================================== */
console.log("\n⑥ legacy 链路（lib/localRender.ts，「经典导出」/ sidecar 降级时走它）");
/* ================================================================== */

// 这条链是 norm_000.mp4 … norm_NNN.mp4 → merged.mp4 → [final.mp4]，
// 4.2 之前**每一道都带** faststart，而第一句还在**逐 clip 的循环里**——
// 1424 镜的项目就是 1424 次白做的全文件重写。它不经 ffmpegCompiler，
// 所以上面①~⑤ 一条都盖不到它，必须单钉。
const LOCAL = read("src/lib/localRender.ts");
const normStmt = LOCAL.slice(LOCAL.indexOf("const args = [\"-y\"];"),
                             LOCAL.indexOf("await runFfmpeg(args);"));
ok("逐 clip 归一化（循环体内）不带 faststart",
  normStmt.length > 100 && !/movflags/.test(normStmt),
  `切到的语句长度 ${normStmt.length}；这一句在 for 循环里，每个镜头执行一次`);
ok("concat 那道由「有没有字幕要烧」决定，不是无条件带",
  /"-fflags", "\+genpts", "-c", "copy",\s*\n\s*\.\.\.\(srtText \? \[\] : \["-movflags", "\+faststart"\]\), merged\]/.test(LOCAL),
  "无字幕时 merged.mp4 就是成片，必须带；有字幕时它只是烧字幕那道的输入");
ok("烧字幕那道无条件带（它永远是最后一道）",
  /"-c:a", "copy", "-movflags", "\+faststart", final\]/.test(LOCAL));
check("整个 localRender 里 -movflags 只剩两处（concat + burn）",
  (LOCAL.match(/"-movflags"/g) ?? []).length, 2,
  "多出来的那一处必然落在循环里，也就是按镜头数线性放大的那种浪费");
ok("判据用字幕文本本身而不是 boolean（否则 tsc 丢掉收窄，得补非空断言）",
  /const srtText = opts\.burnSrt\?\.trim\(\) \? opts\.burnSrt : null;/.test(LOCAL)
  && /if \(srtText\) \{/.test(LOCAL)
  && !/opts\.burnSrt!/.test(LOCAL));

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ faststart 全部通过：段上一处不带，尾段恰好一处且落在成片那一道；"
    + "9 种流水线形状（含 3 种「有音频 clip 但混音不跑」和 2 种降级）逐一走过；"
    + "renderer / baseline-export / 黄金基线三者判据一致；legacy 链路同步收敛"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
