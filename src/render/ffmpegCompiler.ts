/**
 * render/ffmpegCompiler.ts — RenderSegment → ffmpeg 参数
 *
 * 唯一产出 ffmpeg 命令行的地方（PLAN §11）。UI 不碰、Renderer 不碰。
 * 换渲染实现（比如将来上 GPU 合成）只改这个文件。
 *
 * 两条路径，对应分段器的两种段：
 *   passthrough → 只做归一化（scale/pad/fps），无 filter_complex，内存最低
 *   composite   → filter_complex 图：逐输入变换 → 叠加/转场 → 音频 mix
 *
 * 参数链沿用现有 media.py 已验证过的那套（yuv420p / +faststart /
 * anullsrc 补静音轨），不另起炉灶——那套是踩过坑调出来的。
 */

import type { RenderClip, RenderEffect } from "./model";
import { srtForceStyle } from "../lib/subtitleStyle";
import type { SubtitleStyleLike } from "../lib/subtitleStyle";
import type { RenderPlan } from "./model";
import type { RenderSegment } from "./segment";
import type { Capabilities } from "./capabilities";
import { hasFilter, hasTransition } from "./capabilities";

export interface CompileCtx {
  plan: RenderPlan;
  caps: Capabilities;
  /** mediaId → 本地绝对路径（由调用方缓存/下载后提供） */
  localPath: (mediaId: string) => string;
  encoder: string;
  crf: number;
}

/** 调色参数 → ffmpeg 滤镜片段。范围与前端滑块一致（-100..100）。 */
function effectFilters(effects: RenderEffect[], caps: Capabilities): string[] {
  if (!effects.length) return [];
  const out: string[] = [];
  const get = (t: RenderEffect["type"]) =>
    effects.find((e) => e.type === t)?.value ?? 0;

  // ---- 调色（V2.1）----
  const bright = get("brightness") / 200;      // -0.5..0.5
  const contrast = 1 + get("contrast") / 100;
  const satur = 1 + get("saturation") / 100;
  const gamma = 1 + get("highlights") / 300;
  if (bright || contrast !== 1 || satur !== 1 || gamma !== 1) {
    if (hasFilter(caps, "eq")) {
      out.push(`eq=brightness=${bright.toFixed(4)}:contrast=${contrast.toFixed(4)}`
        + `:saturation=${satur.toFixed(4)}:gamma=${gamma.toFixed(4)}`);
    }
  }
  const temp = get("temperature") / 200;
  const tint = get("tint") / 200;
  if ((temp || tint) && hasFilter(caps, "colorbalance")) {
    out.push(`colorbalance=rm=${temp.toFixed(4)}:bm=${(-temp).toFixed(4)}`
      + `:gm=${tint.toFixed(4)}`);
  }
  const shadows = get("shadows");
  if (shadows && hasFilter(caps, "eq")) {
    out.push(`eq=gamma=${(1 + shadows / 200).toFixed(4)}:gamma_weight=0.35`);
  }
  const sharpen = get("sharpen");
  if (sharpen > 0 && hasFilter(caps, "unsharp")) {
    out.push(`unsharp=5:5:${(sharpen / 100 * 1.5).toFixed(3)}`);
  }

  // ---- 逐帧特效（V2.2）----
  // 每个实现都在真实 ffmpeg 上验证过，不是照文档写的。
  const blur = get("blur");
  if (blur > 0) {
    // gblur 质量优于 boxblur；老版本没有时回退
    if (hasFilter(caps, "gblur")) out.push(`gblur=sigma=${(blur / 100 * 12).toFixed(2)}`);
    else if (hasFilter(caps, "boxblur")) out.push(`boxblur=${Math.max(1, Math.round(blur / 10))}:1`);
  }
  const vig = get("vignette");
  if (vig > 0 && hasFilter(caps, "vignette")) {
    // angle 越大暗角越强；PI/5 ~ PI/2.2 是肉眼舒适区间
    out.push(`vignette=angle=PI/${(5 - (vig / 100) * 2.8).toFixed(2)}`);
  }
  const grain = get("grain");
  if (grain > 0 && hasFilter(caps, "noise")) {
    // allf=t+u：时域+均匀分布，看起来才像胶片颗粒而非固定噪点
    out.push(`noise=alls=${Math.round(grain / 100 * 30)}:allf=t+u`);
  }
  const glitch = get("glitch");
  if (glitch > 0 && hasFilter(caps, "rgbashift")) {
    const px = Math.max(1, Math.round(glitch / 100 * 12));
    out.push(`rgbashift=rh=${px}:bh=${-px}`);
  }
  const shake = get("shake");
  if (shake > 0 && hasFilter(caps, "crop")) {
    // 按时间摆动裁切窗口再放大回原尺寸。两个不同频率的正弦让抖动不呆板。
    // 注意 crop 的 x/y 表达式里 t 是秒——这是 ffmpeg 的逐帧求值变量。
    const amp = Math.max(2, Math.round(shake / 100 * 14));
    const m = amp * 2;
    out.push(`crop=iw-${m}:ih-${m}:${amp}+${amp}*sin(2*PI*t*7):${amp}+${amp}*cos(2*PI*t*9)`);
  }
  const zp = get("zoomPulse");
  if (zp > 0 && hasFilter(caps, "crop")) {
    // 不用 zoompan：实测串在滤镜链里会报 "Error while processing the decoded data"。
    // 也不能用 h=-1：eval=frame 下每帧尺寸变化会触发滤镜重初始化并炸掉
    // （"Error reinitializing filters! Failed to inject frame"）。
    // 两个维度都给显式表达式，再 crop 回画布尺寸。
    const a = (zp / 100 * 0.06).toFixed(4);
    const z = `(1.06+${a}*sin(2*PI*t*1.2))`;
    out.push(`scale=w='iw*${z}':h='ih*${z}':eval=frame`);
    // 放大后裁回画布：后续的 pad 会把它对齐到目标尺寸
    out.push(`crop='min(iw,${"iw/1.06"})':'min(ih,ih/1.06)'`);
  }
  const flash = get("flash");
  if (flash > 0 && hasFilter(caps, "curves")) {
    // 抬黑场 = 整体提亮泛白
    out.push(`curves=all='0/${(flash / 100 * 0.35).toFixed(3)} 1/1'`);
  }

  // LUT 放最后：它是最终色彩查找，应作用于全部调色之后
  const lut = effects.find((e) => e.type === "lut");
  if (lut?.assetUrl && hasFilter(caps, "lut3d")) {
    const esc = lut.assetUrl.replace(/\\/g, "/").replace(/:/g, "\\:");
    out.push(`lut3d=file='${esc}'`);
  }
  return out;
}

/** 需要双路合成的特效（主链 + 一条处理链，再 blend 回去） */
export function needsDualPath(effects: RenderEffect[]): boolean {
  return effects.some((e) => e.type === "glow" && (e.value ?? 0) > 0);
}

/**
 * 单个 clip 的视频滤镜链。
 *
 * 顺序有讲究（与后端 build_transform_filters 保持一致）：
 *   变速 → 裁切 → 缩放 → 镜像 → 旋转 → 调色 → 不透明度 → pad 到画布
 * 变速必须最先：放在几何变换之后会被重采样两次，边缘出锯齿。
 * 位移靠 pad 的偏移实现，超出画布的部分自然被裁掉，不需要额外 crop。
 */
function clipVideoChain(c: RenderClip, ctx: CompileCtx): string[] {
  const { width, height, fps } = ctx.plan.output;
  const t = c.transform;
  const chain: string[] = [];

  if (c.speed !== 1) chain.push(`setpts=${(1 / c.speed).toFixed(6)}*PTS`);

  if (t.crop) {
    const w = `iw*${(1 - t.crop.left - t.crop.right).toFixed(4)}`;
    const h = `ih*${(1 - t.crop.top - t.crop.bottom).toFixed(4)}`;
    chain.push(`crop=${w}:${h}:iw*${t.crop.left.toFixed(4)}:ih*${t.crop.top.toFixed(4)}`);
  }

  const iw = Math.max(2, Math.round(width * t.scale));
  const ih = Math.max(2, Math.round(height * t.scale));
  chain.push(`scale=${iw}:${ih}:force_original_aspect_ratio=decrease`);

  if (t.mirrorH) chain.push("hflip");
  if (t.mirrorV) chain.push("vflip");
  if (Math.abs(t.rotate) > 0.01) {
    chain.push(`rotate=${(t.rotate * Math.PI / 180).toFixed(6)}:fillcolor=black`);
  }

  chain.push(...effectFilters(c.effects, ctx.caps));

  if (t.opacity < 0.999) {
    chain.push(`format=yuva420p,colorchannelmixer=aa=${t.opacity.toFixed(3)}`);
  }

  chain.push(`pad=${width}:${height}:(ow-iw)/2+(${t.x}):(oh-ih)/2+(${t.y}):black`);
  chain.push(`setsar=1`, `fps=${fps}`);
  return chain;
}

/** 单个 clip 的音频滤镜链 */
function clipAudioChain(c: RenderClip): string[] {
  const a = c.audio;
  const chain: string[] = [];
  if (a.muted) { chain.push("volume=0"); return chain; }
  if (a.volume !== 1) chain.push(`volume=${a.volume.toFixed(3)}`);
  if (c.speed !== 1) {
    // atempo 单次仅接受 0.5~2.0，超出要串联多级（0.25 = 0.5×0.5）
    let remain = c.speed;
    const steps: number[] = [];
    while (remain > 2.000001) { steps.push(2); remain /= 2; }
    while (remain < 0.499999) { steps.push(0.5); remain *= 2; }
    steps.push(remain);
    chain.push(...steps.map((s) => `atempo=${s.toFixed(6)}`));
  }
  if (a.fadeInSec > 0.01) chain.push(`afade=t=in:st=0:d=${a.fadeInSec.toFixed(2)}`);
  if (a.fadeOutSec > 0.01) {
    const dur = c.durationSec;
    if (dur > a.fadeOutSec) {
      chain.push(`afade=t=out:st=${(dur - a.fadeOutSec).toFixed(2)}:d=${a.fadeOutSec.toFixed(2)}`);
    }
  }
  return chain;
}

/** 输入侧 seek：-ss/-t 必须放在 -i 之前，否则要解码整段再丢弃 */
function inputArgs(c: RenderClip, path: string): string[] {
  const a: string[] = [];
  if (c.sourceInSec > 0) a.push("-ss", String(c.sourceInSec));
  if (c.sourceDurationSec > 0) a.push("-t", String(c.sourceDurationSec));
  a.push("-i", path);
  return a;
}

export interface CompiledSegment {
  args: string[];
  /** 该段预计的 filter_complex 输入数（内存估算用） */
  inputCount: number;
}

/** 编译一个段为完整的 ffmpeg 参数 */
export function compileSegment(
  seg: RenderSegment, ctx: CompileCtx, outPath: string,
): CompiledSegment {
  const { width, height, fps } = ctx.plan.output;
  const args: string[] = ["-y"];

  // ---- passthrough：单 clip 无需合成，只做归一化 ----
  if (seg.kind === "passthrough") {
    const c = seg.clips[0];
    args.push(...inputArgs(c, ctx.localPath(c.mediaId)));
    args.push(
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-map", "0:v:0", "-map", "1:a:0?",
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
           + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps}`,
    );
    // 跨段转场补偿（同 composite 分支；透传段也可能是段边界）
    if (seg.boundaryOverlapSec > 0) {
      const keep = Math.max(0.04, (seg.endSec - seg.startSec) - seg.boundaryOverlapSec);
      args.push("-t", keep.toFixed(3));
    }
    args.push(
      "-c:v", ctx.encoder, "-crf", String(ctx.crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      "-shortest", "-movflags", "+faststart", outPath,
    );
    return { args, inputCount: 1 };
  }

  // ---- composite：filter_complex ----
  const parts: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];

  seg.clips.forEach((c, i) => {
    args.push(...inputArgs(c, ctx.localPath(c.mediaId)));
    const chain = clipVideoChain(c, ctx).join(",");
    const glow = c.effects.find((e) => e.type === "glow")?.value ?? 0;
    if (glow > 0 && hasFilter(ctx.caps, "gblur") && hasFilter(ctx.caps, "blend")) {
      // 发光 = 自身 与 自身的模糊版 做 screen 混合。
      // 必须 split 成两路——同一个流不能被消费两次（ffmpeg 会报
      // "Filter has an unconnected output"）。
      const sigma = (glow / 100 * 14).toFixed(2);
      parts.push(`[${i}:v]${chain},split=2[g${i}a][g${i}b]`);
      parts.push(`[g${i}b]gblur=sigma=${sigma}[g${i}blur]`);
      parts.push(`[g${i}a][g${i}blur]blend=all_mode=screen:all_opacity=`
        + `${(glow / 100 * 0.8).toFixed(2)}[v${i}]`);
    } else {
      parts.push(`[${i}:v]${chain}[v${i}]`);
    }
    vLabels.push(`v${i}`);
    const ac = clipAudioChain(c);
    // 无音轨的输入用 a? 可选映射，缺失时由 amix 的 dropout 处理
    parts.push(`[${i}:a]${ac.length ? ac.join(",") : "anull"}[a${i}]`);
    aLabels.push(`a${i}`);
  });

  // ---- 视频合成 ----
  // 必须区分两类同段 clip，混为一谈会算错时长：
  //   ① 主轨内相邻（时间首尾相接）→ 转场 xfade 或直接顺序衔接
  //   ② 叠加层（来自 Overlay 轨，时间上盖在主轨之上）→ overlay 滤镜
  //
  // 判据：主轨 clip 的 timelineStart 单调递增且互不重叠；
  // 叠加层在 RenderPlan 里属于 layer>1 的轨，其时间区间与主轨重叠。
  const mainClips: { c: RenderClip; label: string }[] = [];
  const overlayClips: { c: RenderClip; label: string }[] = [];
  {
    // 按 layer 分组：plan.tracks 里 layer=1 是主轨
    const mainIds = new Set(
      ctx.plan.tracks.filter((t) => t.kind === "video" && t.layer <= 1)
        .flatMap((t) => t.clips.map((c) => c.id)));
    seg.clips.forEach((c, i) => {
      (mainIds.has(c.id) ? mainClips : overlayClips).push({ c, label: `v${i}` });
    });
  }

  // ① 主轨：按转场串接；无转场则顺序 concat（在滤镜图里用 concat filter）
  let vOut = (mainClips[0] ?? { label: vLabels[0] }).label;
  let baseDur = mainClips[0]?.c.durationSec ?? 0;
  for (let i = 1; i < mainClips.length; i++) {
    const prev = mainClips[i - 1].c, cur = mainClips[i];
    const tr = seg.transitions.find(
      (t) => (t.fromClipId === prev.id && t.toClipId === cur.c.id)
          || (t.toClipId === prev.id && t.fromClipId === cur.c.id));
    // 本机不支持的转场类型降级为硬切（concat），而不是让 ffmpeg 报错整段失败。
    // 实测 ffmpeg 4.4.2 没有 zoomin，较新版本才有——所以必须按运行时能力判断。
    if (tr && hasFilter(ctx.caps, "xfade") && hasTransition(ctx.caps, tr.type)) {
      const off = Math.max(0, baseDur - tr.durationSec);
      parts.push(`[${vOut}][${cur.label}]xfade=transition=${tr.type}`
        + `:duration=${tr.durationSec.toFixed(3)}:offset=${off.toFixed(3)}[m${i}]`);
      baseDur = baseDur - tr.durationSec + cur.c.durationSec;
    } else {
      // 无转场的相邻主轨 clip：用 concat 拼接（不是 overlay！
      // 用 overlay 会让两段叠在一起播，总时长塌成较长的那一段）
      parts.push(`[${vOut}][${cur.label}]concat=n=2:v=1:a=0[m${i}]`);
      baseDur += cur.c.durationSec;
    }
    vOut = `m${i}`;
  }

  // ② 叠加层：按 layer 顺序盖上去。
  // enable 限定它只在自己的时间窗口出现，否则会从 0 秒一直盖到结尾；
  // shortest=0 保证主轨长度不被叠加层截短（叠加层通常比主轨短）。
  overlayClips.forEach((o, k) => {
    const st = o.c.timelineStartSec - seg.startSec;
    const en = st + o.c.durationSec;
    const enable = `:enable='between(t,${st.toFixed(3)},${en.toFixed(3)})'`;
    // setpts 把叠加层平移到它该出现的时刻
    parts.push(`[${o.label}]setpts=PTS+${st.toFixed(3)}/TB[o${k}]`);

    const mode = o.c.blendMode ?? "normal";
    if (mode !== "normal" && hasFilter(ctx.caps, "blend")
        && hasFilter(ctx.caps, "split")) {
      // blend 要两路同尺寸同时长，且不支持 enable 时间窗，
      // 所以先 overlay 定位、再把结果与底层混合。
      //
      // ⚠️ 底层流要被消费两次（一次进 overlay、一次进 blend），
      // 必须先 split——直接写两次同一个标签，ffmpeg 会报
      // "Stream specifier 'x' in filtergraph description matches no streams"
      // （实测踩过）。
      parts.push(`[${vOut}]split=2[bs${k}a][bs${k}b]`);
      parts.push(`[bs${k}a][o${k}]overlay=shortest=0${enable}[pre${k}]`);
      // trim 钳到底层时长：blend 不认 shortest，叠加层若伸出底层末尾会把
      // 成片拉长（实测底层 2s、叠加层从 0.5s 起 → 产物 2.5s）。
      parts.push(`[bs${k}b][pre${k}]blend=all_mode=${mode},`
        + `trim=duration=${baseDur.toFixed(3)},setpts=PTS-STARTPTS[ov${k}]`);
    } else {
      parts.push(`[${vOut}][o${k}]overlay=shortest=0${enable}[ov${k}]`);
    }
    vOut = `ov${k}`;
  });

  // 音频：多路 mix
  let aOut = aLabels[0];
  if (aLabels.length > 1 && hasFilter(ctx.caps, "amix")) {
    parts.push(`[${aLabels.join("][")}]amix=inputs=${aLabels.length}`
      + `:duration=longest:dropout_transition=0[amixed]`);
    aOut = "amixed";
  }

  args.push(
    "-filter_complex", parts.join(";"),
    "-map", `[${vOut}]`, "-map", `[${aOut}]`,
  );
  // 跨段转场补偿：本段末尾截去一个转场时长，让下一段从正确位置接上。
  // 不截的话每个段边界都会多出该转场的完整时长（实测 2 边界多 1.0s）。
  if (seg.boundaryOverlapSec > 0) {
    const keep = Math.max(0.04, (seg.endSec - seg.startSec) - seg.boundaryOverlapSec);
    args.push("-t", keep.toFixed(3));
  }
  args.push(
    "-c:v", ctx.encoder, "-crf", String(ctx.crf), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
    "-movflags", "+faststart", outPath,
  );
  return { args, inputCount: seg.clips.length };
}

/** 段产物 concat 成最终文件（各段编码参数一致，-c copy 安全）。
 *
 *  withAudio=false 时在这里加 -an 剥掉音轨，而不是在分段阶段跳过音频：
 *  concat 要求各段流结构一致，中途缺音轨会拼接失败。
 *  放在 -c copy 这一步也不需要重编码，几乎零成本。
 *
 *  ⚠️ 这个参数此前**整个 compiler 都没读过** —— model.ts 声明了
 *  withAudio、导出对话框也有开关，但本机渲染这条路完全忽略它，
 *  用户取消勾选「包含音轨」导出后仍然有声音。 */
export function compileConcat(
  listPath: string, outPath: string, withAudio = true,
): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listPath,
          "-fflags", "+genpts", "-c", "copy",
          ...(withAudio ? [] : ["-an"]),
          "-movflags", "+faststart", outPath];
}

/** 烧字幕（最后一道，避免每段各烧一次导致时间码错位） */
export function compileBurnSubtitles(
  inPath: string, srtPath: string, outPath: string, encoder: string, crf: number,
  /** 字幕样式预设。缺省时用短剧默认（48px 白字黑描边底部居中）。
   *  此前这里写死 FontSize=18 —— TextPanel 的 6 个预设从未生效，
   *  而 18px 在 1080×1920 上小到几乎看不见。 */
  style?: SubtitleStyleLike | null,
  videoH = 1920,
): string[] {
  const esc = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  return ["-y", "-i", inPath,
          "-vf", `subtitles='${esc}':force_style='${srtForceStyle(style, videoH)}'`,
          "-c:v", encoder, "-crf", String(crf), "-c:a", "copy",
          "-movflags", "+faststart", outPath];
}
