/**
 * e2e-narration.ts — 解说剧全链路离线验收（不是单元测试，是真跑）
 *
 * 用**真项目的真数据**（69f8276b1101：15 镜 15 旁白）驱动与桌面端**同一套**
 * 生产代码：
 *
 *   api 真实响应 → normalize → buildSegments → compileSegment → ffmpeg
 *                → compileAudioMix → compileBurnSubtitles → ffprobe 验收
 *
 * 与 renderer.ts 的唯一区别是 I/O 外壳（Tauri sidecar/fs → node child_process/fs）；
 * 所有决策逻辑走的都是同一批函数，所以这里过了 = 桌面端导出会过。
 *
 * 为什么必须真跑：音画同步、旁白有没有被镜头原声盖住、字幕烧没烧上，
 * 这些都不是读代码能确认的。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { normalize } from "../src/render/normalize";
import { buildSegments, segmentStats } from "../src/render/segment";
import {
  compileSegment, compileConcat, compileAudioMix, compileBurnSubtitles,
} from "../src/render/ffmpegCompiler";
import type { Capabilities } from "../src/render/capabilities";
import type { ShotInfo, AudioClipInfo, SubtitleClipInfo } from "../src/api";

/** 后端数据的离线快照：由「直连路由函数」导出，**不走 HTTP**——
 *  CLAUDE.md 禁止为验证签发真实令牌。导出方式（在 backend/ 下跑）：
 *
 *    detail = project_detail(PID); audio = list_audio_clips(PID); ...
 *    json.dump({detail, audio, subs, style, transitions, srt}, f)
 *
 *  用 DATA_JSON / PID / WORK 三个环境变量指到自己的快照上。 */
const DATA_JSON = process.env.DATA_JSON || "./.e2e-data.json";
const PID = process.env.PID || "69f8276b1101";
const WORK = process.env.WORK || "/tmp/fw-e2e";
/** 素材根目录（后端 `/fw/media/` 映射到的磁盘路径）。 */
const DATA = process.env.FW_DATA
  || "/root/filmweaver-data";

let failed = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) { console.log(`  ✓ ${label}${detail ? `  (${detail})` : ""}`); return; }
  failed++;
  console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`);
}

function ff(args: string[], label: string): boolean {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.log(`     ffmpeg 失败 (${label}):\n` +
      (r.stderr || "").split("\n").slice(-12).map((l) => "       " + l).join("\n"));
    return false;
  }
  return true;
}

function probe(f: string): any {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,duration,sample_rate,channels"
    + ":format=duration,size", "-of", "json", f], { encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

/** 音频响度。用来证明"成片里真的有声音"而不只是有条空音轨。 */
function loudness(f: string): number | null {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f,
    "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = (r.stderr || "").match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? parseFloat(m[1]) : null;
}

/** URL → 本地绝对路径。桌面端这一步是"下载到缓存"，本脚本直接指素材目录。
 *  刻意**不走 HTTP**：CLAUDE.md 禁止为验证签发真实令牌，后端数据改由
 *  直连路由函数导出成 JSON（见 DATA_JSON）。 */
const local = (url: string) =>
  url.replace(/^\/fw\/media\//, `${DATA}/`).replace(/^.*\/fw\/media\//, `${DATA}/`);

async function main() {
  console.log(`\n══ 解说剧全链路验收 · 项目 ${PID} ══`);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // ---------------------------------------------------------------- 1. 取数
  console.log("\n[1] 后端数据");
  const D = JSON.parse(readFileSync(DATA_JSON, "utf8"));
  const detail = D.detail;
  const shots: ShotInfo[] = detail.shots ?? [];
  const audioClips: AudioClipInfo[] = D.audio.clips ?? [];
  const subtitleClips: SubtitleClipInfo[] = D.subs.clips ?? [];
  const style = D.style.style;

  console.log(`  项目「${detail.title}」 mode=${detail.production_mode}`);
  ok(shots.length > 0, "拿到镜头", `${shots.length} 个`);
  ok(shots.filter((s) => s.video_url).length > 0, "有已出片镜头",
     `${shots.filter((s) => s.video_url).length} 个`);
  ok(audioClips.length > 0, "拿到旁白", `${audioClips.length} 段`);
  ok(audioClips.every((a) => a.status === "done"), "旁白全部合成完成");

  // 素材必须真实存在——桌面端此处是下载，缺文件会在渲染中途才炸
  const missing = [
    ...shots.filter((s) => s.video_url).map((s) => local(s.video_url!)),
    ...audioClips.map((a) => local(a.url!)),
  ].filter((p) => !existsSync(p));
  ok(missing.length === 0, "所有素材文件存在", missing.slice(0, 3).join(", "));

  // ------------------------------------------------------ 2. 字幕：本地对齐
  console.log("\n[2] 字幕生成（本地强制对齐）");
  const { alignText } = await import("../src/features/subtitles/align");
  const { parseSilence } = await import("../src/features/subtitles/align");
  const { stripScriptMarkup } = await import("../src/features/subtitles/markup");
  const { narrationClips } = await import("../src/features/subtitles/sources");

  const sources = narrationClips(audioClips);
  ok(sources.length === audioClips.length, "旁白全部可用于对齐",
     `${sources.length}/${audioClips.length}`);

  const cues: { text: string; startShot: number; start: number; dur: number }[] = [];
  let degraded = 0;
  for (const src of sources) {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", local(src.url!),
      "-af", "silencedetect=noise=-32dB:d=0.18", "-f", "null", "-"], { encoding: "utf8" });
    const sil = parseSilence(r.stderr || "");
    if (!sil.length) degraded++;
    for (const c of alignText(stripScriptMarkup(src.text || ""), sil, src.duration)) {
      cues.push({ text: c.text, startShot: src.start_shot_order,
                  start: src.start_offset_sec + c.start, dur: c.end - c.start });
    }
  }
  ok(cues.length > 0, "生成了字幕", `${cues.length} 条`);
  ok(degraded === 0, "所有旁白都探到了真实停顿（无退化）", `退化 ${degraded} 段`);
  ok(cues.every((c) => c.text.length <= 15), "每条 ≤15 字",
     `最长 ${Math.max(...cues.map((c) => c.text.length))}`);
  ok(cues.every((c) => c.dur > 0 && c.dur <= 5.001), "时长都在 (0,5] 秒内");
  ok(!cues.some((c) => /[△▲【】]/.test(c.text)), "字幕里没有剧本标记符号");

  // 同镜内不重叠
  let ovl = 0;
  for (let i = 1; i < cues.length; i++) {
    const a = cues[i - 1], b = cues[i];
    if (a.startShot === b.startShot && b.start < a.start + a.dur - 1e-6) ovl++;
  }
  ok(ovl === 0, "同镜内字幕不重叠", `${ovl} 处重叠`);

  // ------------------------------------------------- 3. normalize → RenderPlan
  console.log("\n[3] Timeline → RenderPlan");
  const plan = normalize({
    projectId: PID, shots, audioClips, subtitleClips,
    transitions: D.transitions?.transitions ?? [],
    output: { width: 1080, height: 1920, fps: 30,
              vcodec: "libx264", crf: 20, withAudio: true },
    scope: "generated",
  });
  const vTrack = plan.tracks.find((t) => t.kind === "video")!;
  const aTracks = plan.tracks.filter((t) => t.kind === "audio");
  console.log(`  时长 ${plan.totalSec.toFixed(2)}s · 视频 ${vTrack.clips.length} 段`
    + ` · 音频轨 ${aTracks.length} 条/${aTracks.reduce((n, t) => n + t.clips.length, 0)} 段`);
  ok(vTrack.clips.length === shots.filter((s) => s.video_url).length,
     "已出片镜头全部进入视频轨");
  ok(aTracks.reduce((n, t) => n + t.clips.length, 0) === audioClips.length,
     "旁白全部进入音频轨");

  // ⚠️ 解说剧的命门：镜头自带原声必须被静音，否则旁白被环境音盖住
  const unmuted = vTrack.clips.filter((c) => !c.audio.muted);
  ok(unmuted.length === 0,
     "镜头原声已全部静音（否则旁白会被画面原声盖住）",
     `${unmuted.length} 个未静音`);

  // ----------------------------------------------------------- 4. 分段
  console.log("\n[4] 分段");
  const segs = buildSegments(plan);
  const stats = segmentStats(segs);
  console.log(`  ${segs.length} 段 · 峰值输入 ${stats.maxInputs}`
    + ` · 透传 ${stats.passthrough}/合成 ${stats.composite}`
    + ` · 预计峰值内存 ${stats.estPeakMB}MB`);
  ok(segs.length > 0, "产出了分段");
  ok(stats.oversized === 0, "没有超限段", `${stats.oversized} 段超限`);
  ok(stats.maxInputs <= 12, "单段输入数受控（内存恒定的前提）",
     `峰值 ${stats.maxInputs}`);

  // -------------------------------------------------------- 5. 真渲染
  console.log("\n[5] 逐段渲染 → 拼接 → 混音 → 烧字幕");
  const caps: Capabilities = {
    version: "local", available: true, hwEncoders: [],
    filters: new Set(["xfade", "overlay", "blend", "split", "scale", "pad", "rotate",
      "crop", "setpts", "trim", "concat", "eq", "colorbalance", "colortemperature",
      "unsharp", "gblur", "vignette", "noise", "hue", "curves", "lut3d", "atempo",
      "adelay", "amix", "volume", "subtitles", "silencedetect", "format", "fps"]),
    transitions: new Set(["fade", "wipeleft", "wiperight", "slideup", "slidedown",
      "circleopen", "dissolve"]),
    probedAt: Date.now(),
  };
  const ctx = {
    plan, caps, encoder: "libx264", crf: plan.output.crf,
    localPath: (id: string) => {
      const m = plan.media.find((x) => x.id === id);
      if (!m) throw new Error(`未知素材 ${id}`);
      return local(m.url);
    },
    hasAudio: () => true,
  };

  const segFiles: string[] = [];
  const t0 = Date.now();
  for (let i = 0; i < segs.length; i++) {
    const out = `${WORK}/seg_${String(i).padStart(4, "0")}.mp4`;
    const { args } = compileSegment(segs[i], ctx, out);
    if (!ff(args, `段 ${i + 1}`)) { failed++; break; }
    segFiles.push(out);
    process.stdout.write(`\r  渲染 ${i + 1}/${segs.length}`);
  }
  console.log("");
  ok(segFiles.length === segs.length, "所有分段渲染成功",
     `${segFiles.length}/${segs.length}`);
  if (segFiles.length !== segs.length) { report(); return; }

  const listPath = `${WORK}/list.txt`;
  writeFileSync(listPath, segFiles.map((f) => `file '${f}'`).join("\n") + "\n");
  let final = `${WORK}/merged.mp4`;
  ok(ff(compileConcat(listPath, final, true), "concat"), "拼接成功");

  // 混音（旁白）
  const mixClips = aTracks.filter((t) => !t.muted).flatMap((t) => t.clips).map((c) => ({
    path: ctx.localPath(c.mediaId),
    startSec: c.timelineStartSec, volume: c.audio.volume, muted: c.audio.muted,
  }));
  const mixArgs = compileAudioMix(final, mixClips, `${WORK}/mixed.mp4`);
  ok(!!mixArgs, "生成了混音命令", `${mixClips.length} 段旁白`);
  if (mixArgs) {
    ok(ff(mixArgs, "混音"), "混音成功");
    final = `${WORK}/mixed.mp4`;
  }

  // 烧字幕。SRT 用 [2] 的对齐产物按**镜头绝对起点**换算成时间码——
  // 与后端 export_subtitles_srt 同一套语义（锚点=镜序+镜内偏移）。
  // 这里自己算而不是拉后端：本项目字幕轨尚未落库，而要验的正是
  // "本地对齐出来的时间，烧到画面上对不对得上旁白"。
  const shotStart = new Map<number, number>();
  {
    let cur = 0;
    for (const s of [...shots].sort((a, b) => a.order - b.order)) {
      if (s.disabled || !s.video_url) continue;
      shotStart.set(s.order, cur);
      cur += s.duration_sec ?? 5;
    }
  }
  const tc = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60;
    const s2 = Math.floor(ms / 1000) % 60, mm = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:`
         + `${String(s2).padStart(2, "0")},${String(mm).padStart(3, "0")}`;
  };
  const abs = cues
    .map((c) => ({ ...c, at: (shotStart.get(c.startShot) ?? 0) + c.start }))
    .filter((c) => shotStart.has(c.startShot))
    .sort((a, b) => a.at - b.at);
  ok(abs.length === cues.length, "所有 cue 都能锚到已出片镜头",
     `${abs.length}/${cues.length}`);

  // ⚠️ 字幕与旁白的**同步**判据：字幕时间码这里是自己按镜头起点累加算的，
  // 旁白的时间码是 normalize 算的。两者若有任何偏差，字幕就会与念的话错开。
  // 逐段比对同一条旁白在两套算法下的绝对起点——这是"音画同步"唯一能离线证的事。
  {
    const planAudio = [...aTracks.flatMap((t) => t.clips)]
      .sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    let maxDrift = 0;
    sources.forEach((src, i) => {
      const mine = (shotStart.get(src.start_shot_order) ?? 0) + src.start_offset_sec;
      const theirs = planAudio[i]?.timelineStartSec ?? NaN;
      maxDrift = Math.max(maxDrift, Math.abs(mine - theirs));
    });
    ok(maxDrift < 0.05, "字幕时间码与旁白时间码同源（无漂移）",
       `最大偏差 ${maxDrift.toFixed(3)}s`);
  }

  const srtText = abs.map((c, i) =>
    `${i + 1}\n${tc(c.at)} --> ${tc(c.at + c.dur)}\n${c.text}\n`).join("\n") + "\n";
  const srt = `${WORK}/subs.srt`;
  writeFileSync(srt, srtText);

  const outBurn = `${WORK}/final.mp4`;
  const burnArgs = compileBurnSubtitles(final, srt, outBurn, "libx264", plan.output.crf,
    style, plan.output.height, new URL("../src-tauri/resources/fonts", import.meta.url).pathname);
  ok(ff(burnArgs, "烧字幕"), "字幕烧录成功", `${abs.length} 条`);
  final = outBurn;
  const burned = true;

  // 字幕时间不能超出成片
  ok(abs[abs.length - 1].at + abs[abs.length - 1].dur <= plan.totalSec + 0.5,
     "末条字幕不超出成片时长",
     `${(abs[abs.length - 1].at + abs[abs.length - 1].dur).toFixed(2)}s `
     + `vs ${plan.totalSec.toFixed(2)}s`);

  // -------------------------------------------------------- 6. 成片验收
  console.log("\n[6] 成片验收");
  const info = probe(final);
  ok(!!info, "成片可被 ffprobe 解析");
  if (info) {
    const v = info.streams.find((s: any) => s.codec_type === "video");
    const a = info.streams.find((s: any) => s.codec_type === "audio");
    const dur = parseFloat(info.format.duration);
    const mb = +(info.format.size / 1048576).toFixed(1);
    console.log(`  ${v?.codec_name} ${v?.width}x${v?.height} ${v?.r_frame_rate}`
      + ` · ${a?.codec_name} ${a?.sample_rate}Hz ${a?.channels}ch · ${dur.toFixed(2)}s · ${mb}MB`);

    ok(!!v, "有视频流");
    ok(!!a, "有音频流（旁白已混入）");
    ok(v?.width === 1080 && v?.height === 1920, "分辨率符合导出设置",
       `${v?.width}x${v?.height}`);
    ok(Math.abs(dur - plan.totalSec) < 1.5, "成片时长与计划一致",
       `${dur.toFixed(2)}s vs 计划 ${plan.totalSec.toFixed(2)}s`);
    ok(mb > 1, "文件大小合理", `${mb}MB`);

    const lu = loudness(final);
    console.log(`  平均响度 ${lu} dB`);
    ok(lu !== null && lu > -50, "音轨确实有声音（不是静音轨）", `${lu} dB`);

    // 抽帧：证明画面不是全黑
    const frames = [1, Math.floor(dur / 2), Math.floor(dur) - 2];
    let blank = 0;
    frames.forEach((t, i) => {
      const p = `${WORK}/f${i}.png`;
      spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", final,
        "-frames:v", "1", p], { stdio: "ignore" });
      const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", p,
        "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
        "-f", "null", "-"], { encoding: "utf8" });
      const m = (r.stderr || "").match(/YAVG=([\d.]+)/);
      const y = m ? parseFloat(m[1]) : 0;
      if (y < 8) blank++;
      console.log(`    ${t}s 帧亮度 YAVG=${y.toFixed(1)}`);
    });
    ok(blank === 0, "抽检帧都不是黑屏", `${blank}/${frames.length} 黑`);
    if (burned) console.log(`  （成片含烧录字幕，人工核对：${WORK}/f1.png）`);
  }

  console.log(`\n  产物: ${final}`);
  console.log(`  耗时: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  report();
}

function report() {
  console.log(failed === 0
    ? "\n✅ 解说剧全链路验收：全部通过\n"
    : `\n❌ 解说剧全链路验收：${failed} 项失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\n💥", e); process.exit(1); });
