/**
 * baseline-export.ts — 导出链路的**黄金基线**（OPTIMIZATION 文档 §6 批次 0.1）
 *
 * 存在理由（§0.5 功能守恒原则）：
 *   「没有破坏现有功能」不能靠声称，必须靠比对。而比对成片 md5 是行不通的
 *   —— x264 多线程编码不是逐位确定的，同一份输入两次导出的字节流就不同。
 *
 * 所以基线取的是**编译器产出的 ffmpeg 命令行本身**（argv 全量快照）。
 * 它比成片哈希更严格也更有用：
 *   · 确定性 100%（纯函数，不跑 ffmpeg，不依赖机器）
 *   · 一改参数立刻显形，且 diff 直接告诉你改了哪一个 flag
 *   · 跑得快（毫秒级），每个批次结束都能跑，不是"有空再说"
 *
 * 覆盖的场景就是文档批次 0.1 要求的三份基线 + 三个降级分支：
 *   ① 纯 AI 镜头带字幕      ② 含停用镜头 + 转场      ③ 含矩形/画笔/椭圆马赛克
 *   ④ 完全无音频（成片=merged）  ⑤ 有字幕但无 subtitles 滤镜（成片=mixed）
 *   ⑥ 同素材被多镜引用（验证缓存文件不能提前删）
 *
 * 用法：
 *   npx tsx scripts/baseline-export.ts            # 比对，有差异 exit 1
 *   npx tsx scripts/baseline-export.ts --update   # 重新采集（**改动被认可后才做**）
 *
 * ⚠️ `--update` 是唯一能让基线变化的入口。任何一次 update 都必须在
 *    OPTIMIZATION 文档 §0.6 里记一行「为什么这个差异是预期的」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileSegment, compileConcat, compileAudioMix, compileBurnSubtitles,
  compileMosaicFilters, escFilterPath,
} from "../src/render/ffmpegCompiler";
import { buildSegments } from "../src/render/segment";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type {
  RenderPlan, RenderClip, RenderTransition, RenderTrack, MosaicParams,
} from "../src/render/model";
import type { Capabilities } from "../src/render/capabilities";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "__baseline__", "export-argv.json");
const UPDATE = process.argv.includes("--update");

/* ------------------------------------------------------------------ *
 * 固定夹具：路径全部写死，不用 tmpdir —— 基线必须与机器无关
 * ------------------------------------------------------------------ */
const W = 1080, H = 1920, FPS = 30;
const WORK = "/BASE/work";
const src = (i: number) => `/BASE/cache/m${i}.mp4`;

/** 全能力 caps（本机 ffmpeg 4.4.2 的真实集合，见 verify-compiler.ts） */
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
    /** 4.6：音频轨被轨道级静音（`normalize` 从 trackFlags 折算出来的结果） */
    mutedAudio?: boolean;
    /** 4.6：主视频轨被轨道级隐藏 */
    hiddenVideo?: boolean;
    /** 4.6：额外一条叠加轨，用来验证"主轨隐藏后叠加轨照样出片" */
    overlayTrack?: RenderClip[];
  } = {},
): RenderPlan {
  const ids = extra.mediaIds ?? [...new Set(clips.map((c) => c.mediaId))];
  const tracks: RenderTrack[] = [
    { id: "v1", kind: "video", layer: 1, muted: false, hidden: !!extra.hiddenVideo, clips },
  ];
  if (extra.overlayTrack) {
    tracks.push({
      id: "v2", kind: "video", layer: 2, muted: false, hidden: false,
      clips: extra.overlayTrack,
    });
  }
  if (extra.audioTrack) {
    tracks.push({
      id: "a1", kind: "audio", layer: 0, muted: !!extra.mutedAudio, hidden: false,
      clips: extra.audioTrack,
    });
  }
  return {
    projectId: "baseline",
    media: ids.map((id, i) => ({
      id, url: src(i), kind: "video" as const, durationSec: 8,
    })),
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

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */
interface Scene {
  name: string;
  why: string;
  build: () => Record<string, unknown>;
}

/** 把一个 plan 走完整条导出链，产出 argv 快照（与 renderer.ts 的顺序一致） */
function fullChain(
  plan: RenderPlan,
  o: {
    caps?: Capabilities; burnSrt?: string; encoder?: string;
    hasAudio?: (id: string) => boolean;
    /** 6.4：效果资源（LUT）的本地路径解析器。不传 = 与 6.4 之前逐字节相同。 */
    assetPath?: (id: string) => string | null;
  } = {},
): Record<string, unknown> {
  const c = o.caps ?? caps();
  const ctx = {
    plan, caps: c, encoder: o.encoder ?? "libx264", crf: plan.output.crf,
    localPath: (id: string) => {
      const idx = plan.media.findIndex((m) => m.id === id);
      return plan.media[idx]?.url ?? `/BASE/cache/${id}.mp4`;
    },
    ...(o.hasAudio ? { hasAudio: o.hasAudio } : {}),
    ...(o.assetPath ? { assetPath: o.assetPath } : {}),
  };

  const segs = buildSegments(plan);
  const segments = segs.map((s, i) => {
    const { args, inputCount } = compileSegment(s, ctx, join(WORK, `seg_${i}.mp4`));
    return {
      kind: s.kind, startSec: s.startSec, endSec: s.endSec,
      boundaryOverlapSec: s.boundaryOverlapSec, inputCount, args,
    };
  });

  // 混音（renderer.ts）—— 只有存在可用音频 clip 时才发生
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

  // 4.2：`+faststart` 只给最后一道产物，而哪一道是最后一道取决于后面两步跑不跑。
  // **判据顺序必须与 renderer.ts 一致**（先定 willBurn，再算 mix，最后才是 concat），
  // 否则基线钉住的是一套这条流水线上并不存在的 faststart 分布。
  const willBurn = !!(o.burnSrt && c.filters.has("subtitles"));
  let final = join(WORK, "merged.mp4");
  const mix = plan.output.withAudio && audioClips.length
    ? compileAudioMix(final, audioClips, join(WORK, "mixed.mp4"),
                      { faststart: !willBurn })
    : null;

  // concat（renderer.ts）
  const concat = compileConcat(join(WORK, "list.txt"), final, {
    withAudio: plan.output.withAudio,
    faststart: !mix && !willBurn,
  });
  if (mix) final = join(WORK, "mixed.mp4");

  // 烧字幕（renderer.ts）—— caps 无 subtitles 时跳过，成片停在上一步
  const burn = willBurn
    ? compileBurnSubtitles(final, join(WORK, "subs.srt"), join(WORK, "final.mp4"),
                           ctx.encoder, plan.output.crf,
                           { videoH: plan.output.height, faststart: true })
    : null;
  if (burn) final = join(WORK, "final.mp4");

  return {
    segCount: segs.length,
    segments,
    concat,
    mix,
    burn,
    /** 成片实际是哪个文件 —— §0.5(h) 的核心事实，删中间文件前必须看它 */
    finalFile: final,
  };
}

const scenes: Scene[] = [];

/* ① 纯 AI 镜头带字幕（最常见的短剧导出） */
scenes.push({
  name: "01-纯AI镜头带字幕",
  why: "最常见路径：全 passthrough + concat + 混音 + 烧字幕，成片=final.mp4",
  build: () => fullChain(
    mkPlan(
      [0, 1, 2, 3].map((i) => clip(i, i * 4, 4)),
      { audioTrack: [clip(90, 0, 16, { mediaId: "bgm", audio: { ...DEFAULT_AUDIO, volume: 0.4 } })],
        mediaIds: ["m0", "m1", "m2", "m3", "bgm"] },
    ),
    { burnSrt: "1\n00:00:00,000 --> 00:00:02,000\n你好\n" },
  ),
});

/* ② 含停用镜头（时间轴合拢的结果）+ 转场 */
scenes.push({
  name: "02-合拢后带转场",
  why: "停用镜头在 RenderPlan 里已被剔除、下游左移；转场走 composite + xfade",
  build: () => {
    // 原本 5 镜每镜 3s，第 3 镜停用 → 合拢成 4 镜、总长 12s
    const cs = [0, 1, 2, 3].map((i) => clip(i, i * 3, 3));
    const trs: RenderTransition[] = [1, 2, 3].map((i) => ({
      id: `t${i}`, type: "fade", durationSec: 0.5,
      fromClipId: `c${i - 1}`, toClipId: `c${i}`,
    }));
    return fullChain(mkPlan(cs, { transitions: trs }));
  },
});

/* ③ 三种形状的马赛克 —— 批次 5 的零回归证据 */
scenes.push({
  name: "03-马赛克三形状",
  why: "矩形(blackbox/pixel) 走 drawbox 与 split-crop-overlay；椭圆/画笔走 geq。"
     + "批次 5 换蒙版实现后，前两条必须逐字节不变",
  build: () => fullChain(mkPlan([
    clip(0, 0, 3, { effects: [mosaic({ style: "blackbox" })] }),
    clip(1, 3, 3, { effects: [mosaic({ style: "pixel", intensity: 60 })] }),
    clip(2, 6, 3, { effects: [mosaic({ style: "gaussblur", shape: "ellipse" })] }),
    clip(3, 9, 3, { effects: [mosaic({
      style: "pixel", shape: "brush", brushSize: 0.08,
      stroke: Array.from({ length: 12 }, (_, i) => ({ x: 0.2 + i * 0.05, y: 0.4 + (i % 3) * 0.03 })),
    })] }),
    clip(4, 12, 3, { effects: [mosaic({ x: 0.1, y: 0.1, w: 0.2, h: 0.15 }), mosaic({ x: 0.6, y: 0.7, w: 0.2, h: 0.15, style: "gaussblur" })] }),
  ])),
});

/* ④ 完全无音频 —— 成片就是 merged.mp4（§0.5(h)） */
scenes.push({
  name: "04-降级-无音频",
  why: "§0.5(h)：没有音频 clip 时不跑混音，成片=merged.mp4。无条件删 merged 会导不出片",
  build: () => fullChain(mkPlan([0, 1].map((i) => clip(i, i * 4, 4)), { withAudio: false })),
});

/* ⑤ 有字幕但 ffmpeg 无 subtitles 滤镜 —— 成片就是 mixed.mp4（§0.5(h)） */
scenes.push({
  name: "05-降级-无字幕滤镜",
  why: "§0.5(h)：老机器无 libass 时跳过烧录、照常出片，成片=mixed.mp4",
  build: () => fullChain(
    mkPlan([0, 1].map((i) => clip(i, i * 4, 4)),
           { audioTrack: [clip(90, 0, 8, { mediaId: "bgm" })], mediaIds: ["m0", "m1", "bgm"] }),
    { caps: caps({ drop: ["subtitles"] }), burnSrt: "1\n00:00:00,000 --> 00:00:02,000\n你好\n" },
  ),
});

/* ⑥ 同一素材被多个镜头引用 —— 缓存文件被读多次，不能提前删 */
scenes.push({
  name: "06-同素材多镜引用",
  why: "同一 mediaId 出现在多个段里；批次 4 删中间文件时不能把缓存也删了",
  build: () => fullChain(mkPlan([
    clip(0, 0, 3, { mediaId: "m0" }),
    clip(1, 3, 3, { mediaId: "m0" }),
    clip(2, 6, 3, { mediaId: "m0", transform: { ...DEFAULT_TRANSFORM, scale: 0.8 } }),
  ], { mediaIds: ["m0"] })),
});

/* ⑦ 无音轨素材走 composite —— 批次 0.4 要修的硬失败，先把现状钉住 */
scenes.push({
  name: "07-composite无音轨素材",
  why: "批次 0.4：hasAudio=false 时 composite 段现在写 [i:a] 会 matches no streams。"
     + "修复后此快照会变，且变化必须是「音频映射变安全」而非其他",
  build: () => fullChain(
    mkPlan([
      clip(0, 0, 3, { transform: { ...DEFAULT_TRANSFORM, scale: 0.9 } }),
      clip(1, 3, 3, { transform: { ...DEFAULT_TRANSFORM, scale: 0.9 } }),
    ]),
    { hasAudio: () => false },
  ),
});

/* ⑧ 变换 / 调色 / 特效全开 —— 滤镜链的广谱快照 */
scenes.push({
  name: "08-变换调色特效全开",
  why: "effectFilters / clipVideoChain 的广谱回归网",
  build: () => fullChain(mkPlan([
    clip(0, 0, 4, {
      speed: 2, sourceDurationSec: 8,
      transform: { scale: 0.85, scaleX: 0.9, scaleY: 0.8, rotate: 7, x: 30, y: -20,
                   opacity: 0.9, mirrorH: true, mirrorV: false,
                   crop: { left: 0.05, top: 0.05, right: 0.05, bottom: 0.1 } },
      effects: [
        { type: "brightness", value: 12 }, { type: "contrast", value: 25 },
        { type: "saturation", value: 15 }, { type: "temperature", value: -20 },
        { type: "tint", value: 10 }, { type: "highlights", value: 30 },
        { type: "shadows", value: -15 }, { type: "sharpen", value: 40 },
        { type: "blur", value: 20 }, { type: "vignette", value: 35 },
        { type: "grain", value: 15 }, { type: "glitch", value: 25 },
        { type: "shake", value: 30 }, { type: "zoomPulse", value: 20 },
        { type: "flash", value: 40 }, { type: "glow", value: 50 },
      ],
      audio: { volume: 0.7, muted: false, fadeInSec: 0.5, fadeOutSec: 1 },
    }),
    clip(1, 4, 4, { blendMode: "screen" }),
  ])),
});

/* ⑨ compileMosaicFilters 直接快照 —— 批次 5 零回归的最细粒度证据 */
scenes.push({
  name: "09-马赛克滤镜片段",
  why: "绕开 compileSegment 直接钉住 compileMosaicFilters 的输出。"
     + "批次 5 加蒙版后，rect+blackbox 必须一字不变（§5.3.1 的零回归快路径）。"
     + "原话还包含 rect+pixel，但 0.5 已按设计改了它（crop 换整数字面量 + 末尾补 scale），"
     + "故不变式只剩 rect+blackbox 一条",
  build: () => {
    const one = (p: Partial<MosaicParams>) =>
      compileMosaicFilters("[in]", "[out]",
        [{ x: 0.2, y: 0.3, w: 0.25, h: 0.2, style: "pixel", intensity: 50, ...p }], 0, 0, W, H);
    return {
      "rect+blackbox": one({ style: "blackbox" }),
      "rect+pixel": one({ style: "pixel", intensity: 60 }),
      "rect+gaussblur": one({ style: "gaussblur", intensity: 70 }),
      "ellipse+pixel": one({ shape: "ellipse" }),
      "ellipse+blackbox": one({ shape: "ellipse", style: "blackbox" }),
      "brush+pixel": one({
        shape: "brush", brushSize: 0.08,
        stroke: Array.from({ length: 12 }, (_, i) => ({ x: 0.2 + i * 0.05, y: 0.4 })),
      }),
      "brush+抽稀触发": one({
        shape: "brush", brushSize: 0.05,
        stroke: Array.from({ length: 200 }, (_, i) => ({ x: i / 200, y: 0.5 })),
      }),
      // 0.5 新增：比例落在奇数像素上，钉住 floor-to-even。
      // 1080*0.0935 = 100.98 → 100（偶）；1920*0.0527 = 101.18 → 101 → **100**。
      // 若哪天有人把 `& ~1` 去掉，这一条会立刻变成 101，而 crop 实际仍裁 100，
      // 末尾的 scale 就会把区域拉成 101 —— 批次 5 的 alphamerge 当场硬失败。
      "rect+pixel+奇数框": one({ w: 0.0935, h: 0.0527 }),
      // 极小区域：floor 后为 0，靠 Math.max(2,…) 兜住（crop 宽高为 0 直接报错）
      "rect+pixel+极小框": one({ w: 0.001, h: 0.001 }),
      "多区域": compileMosaicFilters("[in]", "[out]", [
        { x: 0.1, y: 0.1, w: 0.2, h: 0.15, style: "pixel", intensity: 50 },
        { x: 0.6, y: 0.7, w: 0.2, h: 0.15, style: "gaussblur", intensity: 60 },
        { x: 0.4, y: 0.4, w: 0.1, h: 0.1, style: "blackbox", intensity: 0 },
      ], 1, 2, W, H),
    };
  },
});

/* ⑩ 轨道静音真的进导出（4.6）—— 与 ④ 同一个降级出口，但成因不同 */
scenes.push({
  name: "10-轨道静音进导出",
  why: "4.6：音频轨 muted=true 时 renderer 不再把它算进混音，成片退回 merged.mp4。"
     + "④ 是「压根没有音频轨」，这条是「有但被用户静音了」——两条路径必须都走得通，"
     + "否则点了静音就是导不出片",
  build: () => fullChain(
    mkPlan([0, 1].map((i) => clip(i, i * 4, 4)), {
      audioTrack: [clip(90, 0, 8, { mediaId: "bgm" })],
      mediaIds: ["m0", "m1", "bgm"],
      mutedAudio: true,
    }),
  ),
});

/* ⑪ 轨道隐藏真的进导出（4.6）—— 主轨隐藏后只剩叠加轨的画面 */
scenes.push({
  name: "11-轨道隐藏进导出",
  why: "4.6：视频轨 hidden=true 时 buildSegments 不再取它的 clip。"
     + "钉住「隐藏主轨后叠加轨照样出片」，而不是整条链崩掉或悄悄把主轨又放回来",
  build: () => fullChain(
    mkPlan([0, 1].map((i) => clip(i, i * 4, 4)), {
      hiddenVideo: true,
      overlayTrack: [clip(80, 1, 3, { mediaId: "ov" })],
      mediaIds: ["m0", "m1", "ov"],
      withAudio: false,
    }),
  ),
});

/* ⑫ LUT 走本地文件（6.4）—— 此前**零覆盖**，也正因如此它坏了很久没人发现 */
scenes.push({
  name: "12-LUT本地路径",
  why: "6.4：`lut3d=file=` 只认本机文件，而 6.4 之前编译器直接把 `/fw/media/...` "
     + "服务器 URL 拼进滤镜——实测整段导出失败（退出码 1）。它能长期存活，"
     + "唯一原因就是前 11 个场景里一个 lut 都没有（golden 里 `lut3d` 出现 0 次）。"
     + "这条同时钉住三件事：① 有 assetMediaId 且解析得到 → 用本地路径；"
     + "② 有 assetMediaId 但解析不到（下载失败）→ **整条滤镜消失**，绝不回退 URL；"
     + "③ 没有 assetMediaId（手工构造的老 plan）→ 照旧用 assetUrl。"
     + "另加两条路径转义：含空格、含单引号（Windows 的 AppData 路径带用户名，"
     + "`C:\\Users\\O'Brien\\...` 是完全正常的）",
  build: () => {
    const LOCAL = "/BASE/cache/9c1f2a30_look.cube";
    const plan = mkPlan([
      clip(0, 0, 3, { effects: [
        { type: "lut", assetUrl: "/fw/media/uploads/abc123.cube", assetMediaId: "lut0" },
      ] }),
      clip(1, 3, 3, { effects: [
        // 下载失败的那一份：assetMediaId 在，但 assetPath 返回 null
        { type: "lut", assetUrl: "/fw/media/uploads/dead99.cube", assetMediaId: "lutX" },
      ] }),
      clip(2, 6, 3, { effects: [
        // 老 plan：没有 assetMediaId，assetUrl 本身就是本机路径
        { type: "lut", assetUrl: "/BASE/cache/legacy.cube" },
      ] }),
    ], { mediaIds: ["m0", "m1", "m2"] });
    return {
      chain: fullChain(plan, {
        assetPath: (id) => (id === "lut0" ? LOCAL : null),
      }),
      // 转义规则单独钉一份：它是纯字符串规则，混在 argv 里看不清
      转义: {
        空格: lutFilePathSnapshot("/BASE/My Films/look.cube"),
        单引号: lutFilePathSnapshot("/BASE/O'Brien/look.cube"),
        盘符冒号: lutFilePathSnapshot("C:\\Users\\me\\look.cube"),
        单引号加冒号: lutFilePathSnapshot("C:\\Users\\O'Brien\\look.cube"),
      },
    };
  },
});

/** 把一条 LUT 效果编译成滤镜片段（只为看转义结果，故直接走 effectFilters 的产物）。 */
function lutFilePathSnapshot(localPath: string): string {
  return `lut3d=file='${escFilterPath(localPath)}'`;
}

/* ------------------------------------------------------------------ *
 * 采集 / 比对
 * ------------------------------------------------------------------ */
const snapshot: Record<string, unknown> = {
  __meta__: {
    note: "导出链路黄金基线。只能通过 `npx tsx scripts/baseline-export.ts --update` 更新，"
        + "且每次更新都要在 OPTIMIZATION 文档 §0.6 记录原因。",
    scenes: scenes.map((s) => ({ name: s.name, why: s.why })),
  },
};
for (const s of scenes) {
  try {
    snapshot[s.name] = s.build();
  } catch (e) {
    snapshot[s.name] = { __error__: String(e).split("\n")[0] };
  }
}

const text = JSON.stringify(snapshot, null, 2) + "\n";

if (UPDATE || !existsSync(GOLDEN)) {
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, text);
  console.log(`${existsSync(GOLDEN) && !UPDATE ? "🆕 首次生成" : "♻️  已更新"}基线：${GOLDEN}`);
  console.log(`   ${scenes.length} 个场景`);
  for (const s of scenes) {
    const v = snapshot[s.name] as { __error__?: string; segCount?: number };
    console.log(`   · ${s.name.padEnd(24)} ${v.__error__ ? `❌ ${v.__error__}` : `${v.segCount ?? "—"} 段`}`);
  }
  process.exit(0);
}

const old = readFileSync(GOLDEN, "utf-8");
if (old === text) {
  console.log(`✅ 导出链路与基线一致（${scenes.length} 个场景，${text.length} 字节）`);
  process.exit(0);
}

// 差异定位到场景 + 具体行
const oldJson = JSON.parse(old) as Record<string, unknown>;
console.log("❌ 导出链路与基线不一致\n");
let changed = 0;
for (const s of scenes) {
  const a = JSON.stringify(oldJson[s.name], null, 2) ?? "";
  const b = JSON.stringify(snapshot[s.name], null, 2) ?? "";
  if (a === b) continue;
  changed++;
  console.log(`── ${s.name} ─────────────────────────────`);
  const la = a.split("\n"), lb = b.split("\n");
  let shown = 0;
  for (let i = 0; i < Math.max(la.length, lb.length) && shown < 12; i++) {
    if (la[i] === lb[i]) continue;
    if (la[i] !== undefined) console.log(`  - ${la[i].trim()}`);
    if (lb[i] !== undefined) console.log(`  + ${lb[i].trim()}`);
    shown++;
  }
  if (shown >= 12) console.log("  … （差异过多，已截断）");
  console.log();
}

// __meta__ 只存场景清单与说明文字，改它**不代表导出行为变了**。
// 但它进了同一份 JSON，所以纯文档改动也会让上面的比对失败、
// 却打印出"共 0 个场景发生变化"——看着像鬼故事。这里说清楚是哪种情况。
const metaChanged =
  JSON.stringify(oldJson.__meta__) !== JSON.stringify(snapshot.__meta__);
if (metaChanged) {
  console.log("── __meta__（场景说明文字）─────────────────────────────");
  console.log("  说明文字/场景清单有变，**不影响导出行为**。");
  if (changed === 0) {
    console.log("  且没有任何场景的命令发生变化 —— 这是一次纯文档改动，"
      + "直接 --update 即可（仍按纪律在 §0.6 记一笔）。");
  }
  console.log();
}

console.log(`共 ${changed} 个场景发生变化${metaChanged ? "（另有 __meta__ 文字变动）" : ""}。`);
console.log("若这是**预期**的改动：`npx tsx scripts/baseline-export.ts --update`");
console.log("并在 OPTIMIZATION 文档 §0.6 记录原因。否则说明改坏了。");
process.exit(1);
