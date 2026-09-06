/**
 * verify-trackflags.ts — 轨道静音 / 独奏 / 隐藏真的进导出（批次 4 / 4.6）
 *
 * ## 这条为什么值得一个独立脚本
 *
 * 4.6 之前这三个按钮是**死开关**：`track.muted` / `track.solo` 除了 `TrackHeader`
 * 自己画图标之外没有任何读取方，`normalize.ts` 把三处 RenderTrack 的
 * `muted/hidden` 一律写死 `false`。点了静音再导出，BGM 照样在成片里 ——
 * 不报错、不提示，用户只会觉得"这软件的静音是坏的"。
 *
 * 接通之后风险反过来了：**少放进成片的东西在成片里是看不出来的**。
 * 所以这个脚本盯三类事，每一类漏掉都会静默出事：
 *
 *   ① **映射**：编辑态与导出态是两套 id 命名空间，音频侧还是 3 轨 : 4 kind。
 *      对错了就是"点了静音但那一类音频还在"，且只在有那种 kind 的项目上复现。
 *   ② **折算**：独奏 = 其余音频轨视作静音；隐藏只对视频/叠加轨。
 *      折算是纯函数，这里能真跑，不必退而求其次做源码断言。
 *   ③ **贯通**：三处 RenderTrack 构造必须都读 trackFlags（"只有视频轨认隐藏、
 *      音频轨不认静音"是最可能的半截实现），而且真的**流到下游**——
 *      `segment.ts` 的 `!t.hidden` 与 `renderer.ts` 的 `!t.muted` 早就在筛了，
 *      这里用真 plan 跑 `buildSegments` 证明它确实少了那一段。
 *
 * ## 能真跑的部分一律真跑
 *
 * `trackFlags.ts` / `normalize.ts` / `segment.ts` 都不 import `api`，
 * node 下能直接加载（`src/api.ts:9` 的 `import.meta.env` 是这个项目里
 * 唯一会让脚本加载即抛的东西，4.5 上栽过）。所以 ①②③ 全部是行为断言，
 * 只有"App 有没有把开关接上去""文案有没有跟着改"这两类才用源码断言。
 *
 * 跑法：npx tsx scripts/verify-trackflags.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectTrackFlags, audioTrackKindOf, renderAudioTrackId, renderVideoTrackId,
  AUDIO_CLIP_KINDS,
} from "../src/render/trackFlags";
import type { TrackFlagSource } from "../src/render/trackFlags";
import { normalize } from "../src/render/normalize";
import { buildSegments } from "../src/render/segment";
import type { ShotInfo, AudioClipInfo } from "../src/api";
import type { RenderOutput } from "../src/render/model";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

const NORM = read("render/normalize.ts");
const FLAGS = read("render/trackFlags.ts");
const APP = read("App.tsx");
const TH = read("features/timeline/TrackHeader.tsx");
const SHOT2CLIP = read("adapters/shotToClip.ts");

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`   ✅ ${msg}`); }
  else { fail++; console.log(`   ❌ ${msg}`); }
}

/** 造一条时间轴轨道（只带本模块要读的字段） */
function tk(
  id: string, kind: string, label: string,
  over: Partial<TrackFlagSource> = {},
): TrackFlagSource {
  return {
    id, kind, label,
    hidden: false, muted: false, solo: false, clipCount: 1,
    ...over,
  };
}

const VOICE = () => tk("track-voice", "voice", "旁白");
const MUSIC = () => tk("track-music", "music", "配乐");
const SFX = () => tk("track-audio", "audio", "音效");
const MAIN = () => tk("track-video-1", "video", "视频 1");
const OVER = () => tk("track-video-2", "overlay", "叠加 1");

// ───────────────────────────────────────────────────────────── ①
console.log("\n① id 映射：编辑态与导出态不是同一套命名");

ok(renderVideoTrackId("track-video-1") === "v1"
  && renderVideoTrackId("track-video-7") === "v7",
  "track-video-N → vN（normalize 的主轨是 v1、叠加轨是 v{idx+1}）");
ok(renderVideoTrackId("track-voice") === null
  && renderVideoTrackId("track-subtitle") === null
  && renderVideoTrackId("track-asset-char") === null,
  "非视频形态的轨 id 一律返回 null，不会误映射到某条 v{n} 上");

// 音频侧是 1:N —— 时间轴按听感分三轨，导出按后端 kind 分四轨。
ok(audioTrackKindOf("tts") === "voice" && audioTrackKindOf("narration") === "voice",
  "tts 与 narration 都归「旁白」轨（都是人在说话那一层）");
ok(audioTrackKindOf("music") === "music", "music 归「配乐」轨");
ok(audioTrackKindOf("shot") === "audio", "shot（镜头原声）归「音效」轨");
// 穷尽性：后端加了新 kind 却忘了归轨，静音就会漏掉那一类。
const kinds = new Set(AUDIO_CLIP_KINDS);
ok(kinds.size === 4 && ["tts", "music", "shot", "narration"].every((k) => kinds.has(k as never)),
  "AUDIO_CLIP_KINDS 覆盖后端全部四种 kind（漏一种就会有一类音频静不掉）");
ok(AUDIO_CLIP_KINDS.every((k) => ["voice", "music", "audio"].includes(audioTrackKindOf(k))),
  "每一种 kind 都归得到一条真实存在的时间轴音频轨");
ok(renderAudioTrackId("tts") === "audio_tts" && renderAudioTrackId("shot") === "audio_shot",
  "RenderTrack 的音频 id 拼法是 audio_{kind}");
// 排片与静音必须用同一份映射，否则两边会各自漂移。
ok(/audioTrackKindOf\(a\.kind\)/.test(SHOT2CLIP)
  && /from "\.\.\/render\/trackFlags"/.test(SHOT2CLIP),
  "shotToClip 排片也走 audioTrackKindOf（3↔4 的对应关系只有一份）");
ok(!/a\.kind === "music" \? musicTrack/.test(SHOT2CLIP),
  "shotToClip 里不再有第二份写死的 kind→轨 映射");

// ───────────────────────────────────────────────────────────── ②
console.log("\n② 折算：静音 / 独奏 / 隐藏各自的边界");

const clean = collectTrackFlags([MAIN(), OVER(), VOICE(), MUSIC(), SFX()]);
ok(clean.muted.length === 0 && clean.hidden.length === 0,
  "全默认时不产生任何标志");
ok(clean.notes.length === 0,
  "全默认时 notes 为空 —— App 据此决定「一句话都不弹」");
ok(clean.noVideo === false, "全默认时不触发空画面拦截");

// 静音一条 → 它名下的**所有** kind 都要静掉。
const mutedVoice = collectTrackFlags([MAIN(), VOICE(), MUSIC(), SFX()].map(
  (t) => (t.kind === "voice" ? { ...t, muted: true } : t)));
ok(JSON.stringify(mutedVoice.muted) === JSON.stringify(["audio_narration", "audio_tts"]),
  "静音「旁白」轨 → audio_tts 与 audio_narration 都进 muted（1:N 不能只静一半）");
ok(mutedVoice.hidden.length === 0, "静音不牵动 hidden");
ok(mutedVoice.notes.length === 1 && mutedVoice.notes[0].includes("「旁白」")
  && mutedVoice.notes[0].includes("不进成片"),
  `静音给出一句人话（实测：${mutedVoice.notes[0]}）`);

// 独奏 → 其余音频轨视作静音，且**只影响音频轨**。
const soloMusic = collectTrackFlags([MAIN(), OVER(), VOICE(), MUSIC(), SFX()].map(
  (t) => (t.kind === "music" ? { ...t, solo: true } : t)));
ok(JSON.stringify(soloMusic.muted)
  === JSON.stringify(["audio_narration", "audio_shot", "audio_tts"]),
  "独奏「配乐」→ 旁白与音效的全部 kind 视作静音，audio_music 不在其中");
ok(soloMusic.hidden.length === 0,
  "独奏不隐藏任何视频轨（它只是音频的监听/取舍，不该动画面）");
ok(soloMusic.notes.length === 1 && soloMusic.notes[0].includes("独奏"),
  `独奏归并成一句，不逐轨复读「未独奏」（实测：${soloMusic.notes[0]}）`);

// 两条同时独奏 = 保留这两条。
const soloTwo = collectTrackFlags([VOICE(), MUSIC(), SFX()].map(
  (t) => (t.kind === "music" || t.kind === "voice" ? { ...t, solo: true } : t)));
ok(JSON.stringify(soloTwo.muted) === JSON.stringify(["audio_shot"]),
  "两条独奏 → 只有剩下那条被静音（独奏不是单选）");

// 静音 + 独奏叠加：自己独奏但也自己静音了 → 仍然静音（显式静音优先）。
const soloAndMuted = collectTrackFlags([VOICE(), MUSIC(), SFX()].map(
  (t) => (t.kind === "music" ? { ...t, solo: true, muted: true } : t)));
ok(soloAndMuted.muted.includes("audio_music"),
  "同一条轨既独奏又静音 → 仍然静音（显式静音优先于独奏保留）");

// 隐藏只对视频/叠加轨进导出。
const hidMain = collectTrackFlags([
  { ...MAIN(), hidden: true }, OVER(), VOICE(), MUSIC(), SFX()]);
ok(JSON.stringify(hidMain.hidden) === JSON.stringify(["v1"]),
  "隐藏主视频轨 → hidden 里是 v1");
ok(hidMain.noVideo === false,
  "还有叠加轨有内容时不拦截（隐藏主轨只留叠加层是合法用法）");

const hidAudio = collectTrackFlags([
  MAIN(), { ...VOICE(), hidden: true }, MUSIC(), SFX()]);
ok(hidAudio.hidden.length === 0 && hidAudio.muted.length === 0,
  "隐藏音频轨对导出零影响（音频要不出声是静音的活，两个开关不做同一件事）");
ok(hidAudio.notes.length === 0,
  "隐藏音频轨也不弹提示 —— 它确实什么都没改变");

const hidSub = collectTrackFlags([MAIN(), tk("track-subtitle", "subtitle", "字幕", { hidden: true })]);
ok(hidSub.hidden.length === 0,
  "隐藏字幕轨对导出零影响（字幕走 plan.subtitles，不经过轨道模型）");

// 空画面拦截。
const allHidden = collectTrackFlags([
  { ...MAIN(), hidden: true }, { ...OVER(), hidden: true }, MUSIC()]);
ok(allHidden.noVideo === true,
  "本来有画面、全被隐藏光了 → noVideo（导出必然是空文件，要拦不是要提示）");
const emptyOverlay = collectTrackFlags([
  { ...MAIN(), hidden: true }, { ...OVER(), clipCount: 0 }]);
ok(emptyOverlay.noVideo === true,
  "剩下的叠加轨是空的也算没画面（判据是「还剩不剩片段」，不是「还剩不剩轨」）");
const noPicture = collectTrackFlags([{ ...MAIN(), clipCount: 0, hidden: true }]);
ok(noPicture.noVideo === false,
  "本来就没有画面时不报 noVideo —— 那是「没镜头可导」，另有提示，别抢它的话");

// 标志是排过序的：喂给 normalize 的东西必须确定，否则基线会随轨道顺序抖。
const shuffled = collectTrackFlags([SFX(), MUSIC(), VOICE()].map((t) => ({ ...t, muted: true })));
ok(JSON.stringify(shuffled.muted)
  === JSON.stringify(["audio_music", "audio_narration", "audio_shot", "audio_tts"]),
  "输出已排序去重（轨道顺序变了不该让导出参数跟着抖）");

// ───────────────────────────────────────────────────────────── ③
console.log("\n③ 贯通：标志真的走到 RenderPlan，再走到分段与混音筛选");

const OUT: RenderOutput = {
  width: 1080, height: 1920, fps: 30, vcodec: "libx264", crf: 23, withAudio: true,
};
const shot = (i: number, over: Partial<ShotInfo> = {}): ShotInfo => ({
  id: `s${i}`, order: i, prompt: "", video_url: `/fw/media/p/s${i}/output.mp4`,
  ...over,
} as ShotInfo);
const audio = (id: string, kind: AudioClipInfo["kind"]): AudioClipInfo => ({
  id, kind, text: null, url: `/fw/media/p/a/${id}.mp3`, duration: 4,
  start_shot_order: 1, start_offset_sec: 0, voice_ref_url: null,
  status: "done", error: null,
} as AudioClipInfo);

const shots = [shot(1), shot(2), shot(3, { track_index: 1, overlay_start_sec: 1 })];
const audioClips = [audio("a1", "tts"), audio("a2", "music"), audio("a3", "narration")];

const basePlan = normalize({ projectId: "p", shots, audioClips, output: OUT });
const idsOf = (p: typeof basePlan) => p.tracks.map((t) => t.id);
ok(idsOf(basePlan).includes("v1") && idsOf(basePlan).includes("v2")
  && idsOf(basePlan).includes("audio_tts") && idsOf(basePlan).includes("audio_music")
  && idsOf(basePlan).includes("audio_narration"),
  `夹具真的产出了主轨/叠加轨/三条音频轨（${idsOf(basePlan).join(", ")}）`);
ok(basePlan.tracks.every((t) => !t.muted && !t.hidden),
  "不传 trackFlags 时全部未静音未隐藏（既有调用方与 verify 脚本零改动）");

// 静音「旁白」→ tts 与 narration 两条 RenderTrack 都要 muted，music 不受影响。
const mutedPlan = normalize({
  projectId: "p", shots, audioClips, output: OUT,
  trackFlags: collectTrackFlags([MAIN(), OVER(), { ...VOICE(), muted: true }, MUSIC()]),
});
const byId = (p: typeof basePlan, id: string) => p.tracks.find((t) => t.id === id)!;
ok(byId(mutedPlan, "audio_tts").muted && byId(mutedPlan, "audio_narration").muted,
  "静音「旁白」→ audio_tts 与 audio_narration 两条 RenderTrack 都 muted");
ok(!byId(mutedPlan, "audio_music").muted,
  "同时 audio_music 不受影响（静一条轨不该顺手静掉别人）");
ok(!byId(mutedPlan, "v1").hidden && !byId(mutedPlan, "v2").hidden,
  "静音不牵动视频轨的 hidden");

// 这就是 renderer.ts:307 那一句筛出来的东西 —— 直接照抄它的判据。
const mixable = (p: typeof basePlan) => p.tracks
  .filter((t) => t.kind === "audio" && !t.muted).flatMap((t) => t.clips).length;
ok(mixable(basePlan) === 3 && mixable(mutedPlan) === 1,
  `renderer 的 !t.muted 筛选真的少了两条 clip（${mixable(basePlan)} → ${mixable(mutedPlan)}）`);

// 全部音频静音 → 没有可混的了，走的正是「无音频」那条降级（成片=merged.mp4）。
const allMutedPlan = normalize({
  projectId: "p", shots, audioClips, output: OUT,
  trackFlags: collectTrackFlags([
    { ...VOICE(), muted: true }, { ...MUSIC(), muted: true }, { ...SFX(), muted: true }]),
});
ok(mixable(allMutedPlan) === 0,
  "三条音频轨全静音 → 一条可混 clip 都不剩（复用既有的「无音频」降级出口）");

// 隐藏主轨 → buildSegments 只剩叠加轨的 clip。
const hiddenPlan = normalize({
  projectId: "p", shots, audioClips, output: OUT,
  trackFlags: collectTrackFlags([{ ...MAIN(), hidden: true }, OVER(), VOICE()]),
});
ok(byId(hiddenPlan, "v1").hidden && !byId(hiddenPlan, "v2").hidden,
  "隐藏主视频轨 → v1.hidden 为真、v2 不受影响");
// 夹具里叠加镜跨了整条主轨，所以基线是**一段 composite 含 3 个 clip**；
// 隐藏主轨后重叠消失，降级成**一段 passthrough 含 1 个 clip**。
// 判据用 clip 数与段类型，不用段数 —— 段数在这个夹具上两边都是 1，钉它等于没钉。
const clipsIn = (segs: ReturnType<typeof buildSegments>) =>
  segs.flatMap((s) => s.clips).map((c) => c.id);
const segBase = buildSegments(basePlan);
const segHidden = buildSegments(hiddenPlan);
ok(clipsIn(segBase).length === 3 && clipsIn(segHidden).length === 1,
  `buildSegments 真的少了主轨那两个 clip（${clipsIn(segBase).length} → ${clipsIn(segHidden).length}）`);
ok(clipsIn(segHidden).join() === "c_s3",
  `剩下的就是叠加轨那个 clip，不是把主轨的又放回来了（实测 ${clipsIn(segHidden).join() || "空"}）`);
ok(segBase[0]?.kind === "composite" && segHidden[0]?.kind === "passthrough",
  `主轨一隐藏，重叠随之消失、段从 composite 降级成 passthrough`
  + `（实测 ${segBase[0]?.kind} → ${segHidden[0]?.kind}）`);

// 隐藏叠加轨 → 主轨照常。
const hidOverlayPlan = normalize({
  projectId: "p", shots, audioClips, output: OUT,
  trackFlags: collectTrackFlags([MAIN(), { ...OVER(), hidden: true }]),
});
ok(clipsIn(buildSegments(hidOverlayPlan)).join() === "c_s1,c_s2",
  `反过来隐藏叠加轨 → 只剩主轨那两个 clip（映射没把 v1/v2 搞反，`
  + `实测 ${clipsIn(buildSegments(hidOverlayPlan)).join() || "空"}）`);

// 三处构造必须都接上，缺一处就是半截实现。
ok([...NORM.matchAll(/\.\.\.flagsFor\(/g)].length === 3,
  "normalize 的三处 RenderTrack 构造都用 flagsFor（主视频轨 / 叠加轨 / 音频轨）");
ok(/const id = renderAudioTrackId\(/.test(NORM),
  "音频轨 id 由 trackFlags.ts 提供，不是在 normalize 里另拼一遍 audio_${kind}");

// ───────────────────────────────────────────────────────────── ④
console.log("\n④ App：开关真的被采集、传下去，且不会静默吃掉内容");

ok(/collectTrackFlags\(\s*\n?\s*useTimelineStore\.getState\(\)\.timeline\.tracks/.test(APP),
  "导出时从 store 的时间轴轨道采集开关（不是从别处猜一份）");
ok(/clipCount: t\.clips\.length/.test(APP),
  "把片段数一起带上 —— noVideo 的判据是「还剩不剩片段」");
ok(/trackFlags: flagPlan,/.test(APP),
  "采集到的开关真的传进了 normalize（漏了这一句上面全白做）");
ok(/if \(flagPlan\.noVideo\) \{[\s\S]{0,300}?return;/.test(APP),
  "全隐藏时直接拦截并返回，不去跑一趟渲染交付空文件");
ok(/if \(flagPlan\.notes\.length\) \{[\s\S]{0,400}?await tauriConfirm\(/.test(APP),
  "有任何开关生效时导出前确认 —— 少放进成片的东西在成片里看不出来");
ok(/flagPlan\.notes\.map\(/.test(APP),
  "确认框念的是 collectTrackFlags 给的那几句，不是另写一份说法");
ok(/if \(!ok\) \{ say\("已取消导出"\); return; \}/.test(
  APP.slice(APP.indexOf("flagPlan.notes.length"))),
  "用户点取消就真的不导（确认框不能是个只能点确定的摆设）");

// ───────────────────────────────────────────────────────────── ⑤
console.log("\n⑤ 文案：三个按钮说的必须是它现在真做的事");

ok(!/仅为标记/.test(TH),
  "TrackHeader 里不再有「仅为标记」——4.6 起它们都真的管用了");
ok(/MUTE_TITLE = "静音本轨（导出时本轨音频不进成片）"/.test(TH),
  "静音文案说明它影响成片");
ok(/SOLO_TITLE = "独奏（导出时只保留本轨音频，其余音频轨视作静音）"/.test(TH),
  "独奏文案写明「其余视作静音」——剪映的 solo 不进成片，语义不同必须说清");
ok(/HIDE_TITLE_EXPORT/.test(TH) && /HIDE_TITLE_EDITOR/.test(TH)
  && /hidesFromExport\(t\.kind\)/.test(TH),
  "眼睛的文案按轨型分开（只有视频/叠加轨的隐藏影响导出）");
ok(/const hidesFromExport = \(k: Track\["kind"\]\) => k === "video" \|\| k === "overlay"/.test(TH),
  "TrackHeader 的「哪种轨会影响导出」判据与 trackFlags.ts 同一套口径");
ok(/k === "video" \|\| k === "overlay"/.test(FLAGS),
  "trackFlags 侧同样只认 video / overlay");

// 折算模块必须保持可在 node 下加载 —— 否则上面 ①②③ 全都只能退化成源码断言。
const FLAGS_CODE = FLAGS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
ok(!/\bimport\b[^\n]*(@tauri-apps|types\/timeline)/.test(FLAGS_CODE)
  && !/^import \{[^}]*\} from "\.\.\/api"/m.test(FLAGS_CODE),
  "trackFlags 只做 type-only 的 api 引用、不碰 tauri/types，脚本才能真跑它");

// ─────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} 轨道静音/独奏/隐藏进导出：${pass} ✅ / ${fail} ❌`);
if (fail > 0) process.exit(1);
