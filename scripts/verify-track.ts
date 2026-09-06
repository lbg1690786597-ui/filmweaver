/**
 * verify-track —— 运动跟踪（6.5）验证
 * 跑法：npx tsx scripts/verify-track.ts
 *
 * ## 这条为什么值得单独一个脚本
 *
 * 跟踪是本批次里**唯一一条"结果错了也不会报错"**的功能：框跟偏了、跟丢了却不说、
 * 抽稀抄了近路——三种都不抛异常，只是导出成片上遮挡从人脸上滑走。
 * 所以断言必须钉在**取值**上，不能钉在"跑通了没有"上。
 *
 * 骨架：
 *
 *   [0] NCC 的**绝对**取值：灰度公式、模板 sd、完美平移必须找回**精确整数位移**
 *       —— 并单独钉「线性亮度变化下仍然满分」，那是选 NCC 而不是 SAD 的全部理由
 *   [1] `sampleTimes`：端点精确、上限、非法输入
 *   [2] `thinTrack`：**表现误差有严格上界 tol**（用 `regionBoxAt` 这个真源反查，
 *       不是用抽稀函数自己的公式自证），外加「暂停必须被保住」这个
 *       经典垂距 DP 会答错的反例
 *   [3] `runTrack` 的每条失败分支：跟丢停在最后可信帧、样本不足 2 个不写关键帧、
 *       取消抛 Aborted、matcher 一定被 close
 *   [4] `replaceKfs` / `clearKfs` 的不变式与 `track` 徽标
 *   [5] **端到端**：人造视频里一块有纹理的图案按已知轨迹移动，跑真的 NCC，
 *       要求逐帧找回**精确到像素**的位置，抽稀后经 `regionBoxAt` 复原仍在容差内
 *   [6] 接线：`.tsx` / `<video>` / Worker 这三层 node 加载不了，只能钉源码 ——
 *       但每一条都钉**承重的那个分支**，不钉"调用了某个函数"
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  grayFromRGBA, makeTemplate, matchTemplate, toPx, toRel,
  MAX_SAMPLES, MIN_TEMPLATE_SD,
  type BoxPx, type BoxRel, type GrayFrame,
} from "../src/lib/track/ncc";
import {
  runTrack, sampleTimes, thinTrack, trackMessage, openLocalMatcher,
  DEFAULT_SAMPLE_FPS, DEFAULT_TOL_RATIO,
  type FrameSource, type Matcher, type OpenMatcher, type TrackSample,
} from "../src/lib/track/track";
import { clearKfs, replaceKfs, kfsOf } from "../src/lib/keyframeEdit";
import { regionBoxAt } from "../src/render/maskGroups";
import type { MosaicParams, RegionKeyframe } from "../src/render/model";
import { Aborted } from "../src/lib/aborted";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`); }
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const check = (name: string, got: unknown, want: unknown) =>
  ok(got === want, name, `got=${String(got)} want=${String(want)}`);

/** 可复现的伪随机（`Math.random` 会让失败无法重跑）。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const gray = (w: number, h: number, fillFn: (x: number, y: number) => number): GrayFrame => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    data[y * w + x] = Math.max(0, Math.min(255, Math.round(fillFn(x, y))));
  }
  return { w, h, data };
};

// ═══════════════════════════════════════════════════════════
console.log("\n[0] NCC：绝对取值 + 亮度不变性");
// ═══════════════════════════════════════════════════════════
{
  // BT.601：0.299 R + 0.587 G + 0.114 B，且**向下取整**（`| 0`，不是四舍五入）。
  // 取整方式一起钉住：改成 Math.round 会让绿的 149.685 变成 150 —— 差 1 个灰阶
  // 不影响 NCC（它对线性变换免疫），但它是"有人动过这行"的最便宜的哨兵。
  const rgba = new Uint8Array([
    255, 0, 0, 255,      // 纯红 → 76.245 → 76
    0, 255, 0, 255,      // 纯绿 → 149.685 → 149
    0, 0, 255, 255,      // 纯蓝 → 29.07 → 29
    255, 255, 255, 255,  // 白 → 255
  ]);
  const g = grayFromRGBA(rgba, 2, 2);
  ok(g.data[0] === 76 && g.data[1] === 149 && g.data[2] === 29 && g.data[3] === 255,
    "grayFromRGBA 用的是 BT.601 亮度权重且向下取整", [...g.data].join(","));

  let threw = false;
  try { grayFromRGBA(new Uint8Array(4), 2, 2); } catch { threw = true; }
  ok(threw, "字节不够时 grayFromRGBA 抛错（而不是悄悄读出一堆 0）");

  // 纯色区域的 sd 必须是 0 → 拒绝跟踪的判据
  const flat = gray(64, 64, () => 128);
  const tplFlat = makeTemplate(flat, { x: 8, y: 8, w: 20, h: 20 });
  ok(near(tplFlat.sd, 0, 1e-9), "纯色区域的模板 sd = 0", tplFlat.sd.toFixed(6));
  ok(tplFlat.sd < MIN_TEMPLATE_SD, "纯色区域会被 MIN_TEMPLATE_SD 挡下");

  // 有纹理的区域 sd 必须远超阈值
  const rnd = lcg(7);
  const noisy = gray(64, 64, () => rnd() * 255);
  const tplNoisy = makeTemplate(noisy, { x: 8, y: 8, w: 20, h: 20 });
  ok(tplNoisy.sd > MIN_TEMPLATE_SD * 3, "随机纹理的模板 sd 远超阈值", tplNoisy.sd.toFixed(2));

  // 采样点数不超过 MAX_SAMPLES —— 这是"每帧十几毫秒"这个预算的来源
  const big = gray(400, 400, () => rnd() * 255);
  const tplBig = makeTemplate(big, { x: 0, y: 0, w: 300, h: 300 });
  ok(tplBig.n <= MAX_SAMPLES && tplBig.n > MAX_SAMPLES / 4,
    "大框按 stride 抽样，点数被压在 MAX_SAMPLES 以内", `${tplBig.n} ≤ ${MAX_SAMPLES}`);
}

{
  // 完美平移：把同一张图整体挪 (dx,dy)，必须找回**精确**的整数位移
  const rnd = lcg(11);
  const W = 160, H = 120;
  const tex: number[] = [];
  for (let i = 0; i < W * H; i++) tex.push(rnd() * 255);
  const at = (x: number, y: number) => tex[((y + H) % H) * W + ((x + W) % W)];

  const f0 = gray(W, H, (x, y) => at(x, y));
  const box0: BoxPx = { x: 50, y: 40, w: 24, h: 20 };
  const tpl = makeTemplate(f0, box0);

  for (const [dx, dy] of [[5, 3], [-4, 6], [0, 0], [9, -7]] as [number, number][]) {
    const f1 = gray(W, H, (x, y) => at(x - dx, y - dy));
    const m = matchTemplate(f1, tpl, box0);
    ok(m.x === box0.x + dx && m.y === box0.y + dy && m.score > 0.999,
      `完美平移 (${dx},${dy}) 被精确找回`, `→ (${m.x},${m.y}) score=${m.score.toFixed(4)}`);
  }

  // **选 NCC 而不是 SAD 的全部理由**：整体变暗 + 压缩对比度，得分几乎不掉。
  // 换成绝对差之和，这一条必然失败（差值直接变成 0.4*I+30 的量级）。
  const dark = gray(W, H, (x, y) => at(x - 5, y - 3) * 0.4 + 30);
  const md = matchTemplate(dark, tpl, box0);
  ok(md.x === 55 && md.y === 43 && md.score > 0.999,
    "线性亮度变化（×0.4 +30）下仍精确命中且满分", `score=${md.score.toFixed(4)}`);

  // 遮挡：把搜索窗里的内容换成纯色，得分必须掉到判跟丢的阈值以下
  const occluded = gray(W, H, (x, y) =>
    (x > 30 && x < 100 && y > 20 && y < 80) ? 128 : at(x, y));
  const mo = matchTemplate(occluded, tpl, box0);
  ok(mo.score < 0.55, "目标被纯色遮住时得分掉到阈值以下", `score=${mo.score.toFixed(4)}`);

  // 搜索窗必须把候选框整个夹在画面内：贴边的框不能给出负坐标或越界坐标
  const edge: BoxPx = { x: 0, y: 0, w: 24, h: 20 };
  const tplEdge = makeTemplate(f0, edge);
  const me = matchTemplate(f0, tplEdge, edge, { expand: 2 });
  ok(me.x >= 0 && me.y >= 0 && me.x + 24 <= W && me.y + 20 <= H,
    "贴边搜索时候选框仍整个落在画面内", `(${me.x},${me.y})`);

  // 帧宽与模板不一致必须**抛**，不能拿错行的像素去比
  let threw = false;
  try { matchTemplate(gray(200, 120, () => 0), tpl, box0); } catch { threw = true; }
  ok(threw, "帧宽与模板不一致时 matchTemplate 抛错");
}

{
  // toPx / toRel 的往返与夹持
  const f: GrayFrame = { w: 320, h: 180, data: new Uint8Array(320 * 180) };
  const p = toPx({ x: 0.25, y: 0.5, w: 0.1, h: 0.2 }, f);
  ok(p.x === 80 && p.y === 90 && p.w === 32 && p.h === 36, "toPx 取整正确",
    `${p.x},${p.y} ${p.w}×${p.h}`);
  const r = toRel(p, f);
  ok(near(r.x, 80 / 320) && near(r.w, 32 / 320), "toRel 是 toPx 的逆（按整数像素）");
  const clamped = toPx({ x: 0.95, y: 0.95, w: 0.5, h: 0.5 }, f);
  ok(clamped.x + clamped.w <= f.w && clamped.y + clamped.h <= f.h && clamped.w >= 1,
    "越界的比例框被夹进画面且至少 1×1", `${clamped.x},${clamped.y} ${clamped.w}×${clamped.h}`);
}

// ═══════════════════════════════════════════════════════════
console.log("\n[1] sampleTimes");
// ═══════════════════════════════════════════════════════════
{
  const t = sampleTimes(0, 2, 8, 300);
  ok(t.length === 17, "2 秒 @8fps → 17 个采样点（含首尾）", String(t.length));
  ok(t[0] === 0 && t[t.length - 1] === 2,
    "**末点精确等于 endSec**（累加 1/fps 会在这里差出几毫秒）", `${t[0]} … ${t[t.length - 1]}`);
  let asc = true;
  for (let i = 1; i < t.length; i++) if (!(t[i] > t[i - 1])) asc = false;
  ok(asc, "严格升序");

  const capped = sampleTimes(0, 100, 30, 50);
  ok(capped.length === 50 && capped[49] === 100,
    "超上限时按 maxFrames 截断，末点仍是 endSec", String(capped.length));

  ok(sampleTimes(1, 1, 8, 300).length === 0, "零长度区间 → 空");
  ok(sampleTimes(2, 1, 8, 300).length === 0, "反向区间 → 空");
  ok(sampleTimes(0, 2, 0, 300).length === 0, "fps=0 → 空");
  ok(sampleTimes(0, 2, 8, 1).length === 0, "maxFrames<2 → 空");
  ok(sampleTimes(0, 0.01, 8, 300).length === 2, "极短区间仍给出首尾两点");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[2] thinTrack：表现误差有严格上界（用 regionBoxAt 这个真源反查）");
// ═══════════════════════════════════════════════════════════

const mp = (kfs: RegionKeyframe[]): MosaicParams =>
  ({ x: kfs[0].x, y: kfs[0].y, w: kfs[0].w, h: kfs[0].h, style: "pixel", intensity: 50, keyframes: kfs });

/** 抽稀后的关键帧在**每个原始采样时刻**上的最大复原误差，经 `regionBoxAt` 算。 */
function worstError(samples: TrackSample[], kfs: RegionKeyframe[]): number {
  if (!kfs.length) return Infinity;   // 没关键帧就没有"复原"可言，让断言干净地红，别崩脚本
  const m = mp(kfs);
  let worst = 0;
  for (const s of samples) {
    const b = regionBoxAt(m, s.tSec);
    worst = Math.max(worst,
      Math.abs(b.x - s.box.x), Math.abs(b.y - s.box.y),
      Math.abs(b.w - s.box.w), Math.abs(b.h - s.box.h));
  }
  return worst;
}

const sample = (tSec: number, x: number, y: number): TrackSample =>
  ({ tSec, box: { x, y, w: 0.1, h: 0.1 }, score: 1 });

{
  // 匀速直线 → 只该留首尾两条
  const line: TrackSample[] = [];
  for (let i = 0; i <= 16; i++) line.push(sample(i / 8, 0.1 + i * 0.02, 0.2 + i * 0.01));
  const thinLine = thinTrack(line, DEFAULT_TOL_RATIO);
  ok(thinLine.length === 2, "匀速直线抽到只剩首尾两条", `${line.length} → ${thinLine.length}`);
  ok(worstError(line, thinLine) < 1e-9, "且复原误差为 0");

  // **暂停必须被保住** —— 经典垂距 DP 在这里会答错（几何上是一条直线）
  const pause: TrackSample[] = [];
  for (let i = 0; i <= 8; i++) pause.push(sample(i / 8, 0.1 + i * 0.02, 0.2));   // 走 1 秒
  for (let i = 1; i <= 16; i++) pause.push(sample(1 + i / 8, 0.26, 0.2));        // 停 2 秒
  for (let i = 1; i <= 8; i++) pause.push(sample(3 + i / 8, 0.26 + i * 0.02, 0.2)); // 再走 1 秒
  const thinPause = thinTrack(pause, DEFAULT_TOL_RATIO);
  ok(thinPause.length > 2, "走-停-走：中间的停顿没有被抹平（垂距 DP 会答错这一条）",
    `${pause.length} → ${thinPause.length}`);
  ok(worstError(pause, thinPause) <= DEFAULT_TOL_RATIO + 1e-9,
    "走-停-走的复原误差仍在容差内", worstError(pause, thinPause).toExponential(2));

  // 随机游走 × 200 组：**误差上界**这条性质必须每组都成立
  let worstAll = 0, kept = 0, total = 0, bad = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = lcg(seed * 977);
    const walk: TrackSample[] = [];
    let x = 0.3, y = 0.3;
    for (let i = 0; i <= 40; i++) {
      x = Math.max(0, Math.min(0.9, x + (rnd() - 0.5) * 0.05));
      y = Math.max(0, Math.min(0.9, y + (rnd() - 0.5) * 0.05));
      walk.push(sample(i / 8, x, y));
    }
    const thin = thinTrack(walk, DEFAULT_TOL_RATIO);
    const e = worstError(walk, thin);
    worstAll = Math.max(worstAll, e);
    if (e > DEFAULT_TOL_RATIO + 1e-9) bad++;
    kept += thin.length; total += walk.length;
  }
  ok(bad === 0, "200 组随机游走：复原误差**全部**不超过 tol",
    `最大 ${worstAll.toExponential(2)} ≤ ${DEFAULT_TOL_RATIO}`);
  ok(kept < total, "抽稀确实在减少关键帧（不是原样返回）", `${total} → ${kept}`);

  // tol 收紧 → 保留更多（拿一条**非直线**的轨迹来问，直线在任何容差下都只剩两条，
  // 那样的断言恒真、什么也没验）；tol 非法 → 原样返回
  const wiggly: TrackSample[] = [];
  {
    const rnd = lcg(4242);
    let x = 0.3, y = 0.3;
    for (let i = 0; i <= 40; i++) {
      x = Math.max(0, Math.min(0.9, x + (rnd() - 0.5) * 0.05));
      y = Math.max(0, Math.min(0.9, y + (rnd() - 0.5) * 0.05));
      wiggly.push(sample(i / 8, x, y));
    }
  }
  const loose = thinTrack(wiggly, DEFAULT_TOL_RATIO);
  const tight = thinTrack(wiggly, DEFAULT_TOL_RATIO / 8);
  ok(tight.length > loose.length, "容差收紧 8 倍后保留的关键帧确实更多",
    `${loose.length} → ${tight.length}`);
  ok(worstError(wiggly, tight) <= DEFAULT_TOL_RATIO / 8 + 1e-9,
    "收紧后的上界也照守（不是只多留几条了事）");
  ok(thinTrack(line, 0).length === line.length, "tol=0 视为不抽稀，原样返回");
  ok(thinTrack([sample(0, 0.1, 0.1)], DEFAULT_TOL_RATIO).length === 1, "单点原样返回");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[3] runTrack 的每条分支");
// ═══════════════════════════════════════════════════════════

/** 一块会动的纹理：背景弱噪声，目标是强纹理方块，位置由 tSec 决定。 */
function makeMovingSource(
  opts: {
    W?: number; H?: number; boxW?: number; boxH?: number;
    pos: (tSec: number) => { x: number; y: number } | null;
    /** 返回 true 表示这一刻目标被纯色盖住 */
    occluded?: (tSec: number) => boolean;
  },
): { src: FrameSource; truth: (tSec: number) => { x: number; y: number } | null; W: number; H: number; bw: number; bh: number } {
  const W = opts.W ?? 320, H = opts.H ?? 180;
  const bw = opts.boxW ?? 40, bh = opts.boxH ?? 40;
  const rb = lcg(101), rt = lcg(202);
  const bg: number[] = [];
  for (let i = 0; i < W * H; i++) bg.push(120 + (rb() - 0.5) * 16);
  const patch: number[] = [];
  for (let i = 0; i < bw * bh; i++) patch.push(rt() * 255);

  const truth = (tSec: number) => {
    const p = opts.pos(tSec);
    if (!p) return null;
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };

  return {
    W, H, bw, bh, truth,
    src: {
      async grab(tSec) {
        const p = truth(tSec);
        if (!p) return null;
        const occ = opts.occluded?.(tSec) ?? false;
        return gray(W, H, (x, y) => {
          const dx = x - p.x, dy = y - p.y;
          if (dx >= 0 && dx < bw && dy >= 0 && dy < bh) return occ ? 128 : patch[dy * bw + dx];
          return bg[y * W + x];
        });
      },
    },
  };
}

/** 统计 matcher 的开关次数，用来钉「一定被 close」。 */
function countingMatcher(inner: OpenMatcher): { open: OpenMatcher; opened: () => number; closed: () => number } {
  let opened = 0, closed = 0;
  return {
    opened: () => opened, closed: () => closed,
    open: async (tpl, o) => {
      opened++;
      const m = await inner(tpl, o);
      const wrapped: Matcher = {
        match: (f, prev) => m.match(f, prev),
        close: () => { closed++; m.close(); },
      };
      return wrapped;
    },
  };
}

{
  // ---- 一路跟到底 ----
  const mv = makeMovingSource({ pos: (t) => ({ x: 60 + 30 * t, y: 70 + 15 * t }) });
  const start: BoxRel = { x: 60 / mv.W, y: 70 / mv.H, w: mv.bw / mv.W, h: mv.bh / mv.H };
  const cm = countingMatcher(openLocalMatcher);
  const prog: number[] = [];
  const run = await runTrack(mv.src, cm.open, start, 0, 2, {
    onProgress: (d) => prog.push(d),
  });

  ok(run.fail === null, "顺利跟到底时 fail 为 null");
  ok(run.ok === run.total && run.total === 17, "17 个采样点全部跟到", `${run.ok}/${run.total}`);
  ok(run.message === `已跟踪 · ${run.keyframes.length} 个关键帧`, "成功文案", run.message);
  ok(run.sampleFps === DEFAULT_SAMPLE_FPS, "sampleFps 如实回报");
  ok(cm.opened() === 1 && cm.closed() === 1, "matcher 开一次、关一次");
  ok(prog.length === run.ok && prog[0] === 1 && prog[prog.length - 1] === run.ok,
    "进度从 1 报到 ok，且次数等于样本数", `${prog.length} 次`);

  // **逐帧精确**：每个样本的框位置必须等于真值（完美平移，NCC 应当零误差）
  let maxPxErr = 0;
  for (const s of run.samples) {
    const t = mv.truth(s.tSec)!;
    maxPxErr = Math.max(maxPxErr,
      Math.abs(s.box.x * mv.W - t.x), Math.abs(s.box.y * mv.H - t.y));
  }
  ok(maxPxErr < 1e-9, "真 NCC 逐帧找回**精确到像素**的位置（不是「大致跟上」）",
    `最大误差 ${maxPxErr.toExponential(2)} px`);

  // 抽稀后经 regionBoxAt 复原，误差仍在容差内
  ok(worstError(run.samples, run.keyframes) <= DEFAULT_TOL_RATIO + 1e-9,
    "抽稀后的关键帧经 regionBoxAt 复原仍在容差内");
  ok(run.keyframes.length >= 2 && run.keyframes.length < run.samples.length,
    "确实抽稀了（既没退化成 1 条，也没原样保留）",
    `${run.samples.length} → ${run.keyframes.length}`);
  ok(run.keyframes[0].tSec === 0 && near(run.keyframes[run.keyframes.length - 1].tSec, 2),
    "首尾关键帧就是首尾采样时刻");
}

{
  // ---- 中途跟丢：停在最后一个可信帧，不外推 ----
  const mv = makeMovingSource({
    pos: (t) => ({ x: 60 + 30 * t, y: 70 }),
    occluded: (t) => t >= 1.0,
  });
  const start: BoxRel = { x: 60 / mv.W, y: 70 / mv.H, w: mv.bw / mv.W, h: mv.bh / mv.H };
  const cm = countingMatcher(openLocalMatcher);
  const run = await runTrack(mv.src, cm.open, start, 0, 2, {});

  ok(run.fail?.kind === "lost", "被遮挡判为 lost", String(run.fail?.kind));
  ok(near(run.fail!.tSec, 1.0, 1e-9), "跟丢的时刻就是第一个被遮挡的采样点",
    run.fail!.tSec.toFixed(3));
  ok(run.ok === 8 && run.total === 17, "只保留跟丢之前的样本", `${run.ok}/${run.total}`);
  const last = run.keyframes[run.keyframes.length - 1];
  ok(last.tSec < 1.0 && near(last.tSec, 0.875, 1e-9),
    "**最后一条关键帧停在最后一个可信帧，不外推**", last.tSec.toFixed(3));
  ok(run.message === `第 1.0s 处跟丢（目标被遮挡或移出画面），已保留前段结果（${run.keyframes.length} 个关键帧）`,
    "跟丢文案说清了在哪儿、为什么、保住了什么", run.message);
  ok(cm.closed() === 1, "跟丢路径上 matcher 仍被 close");
}

{
  // ---- 一开始就跟丢：一个关键帧都不许写 ----
  const mv = makeMovingSource({
    pos: (t) => ({ x: 60 + 30 * t, y: 70 }),
    occluded: (t) => t > 0,
  });
  const start: BoxRel = { x: 60 / mv.W, y: 70 / mv.H, w: mv.bw / mv.W, h: mv.bh / mv.H };
  const run = await runTrack(mv.src, openLocalMatcher, start, 0, 2, {});
  ok(run.fail?.kind === "lost" && run.ok === 1, "只攒到 1 个可信样本", `ok=${run.ok}`);
  ok(run.keyframes.length === 0, "**样本不足 2 个 ⇒ 零关键帧**（不把烂数据写进去）");
  ok(run.message === "一开始就跟丢了（目标被遮挡或移出画面），没有写入任何关键帧",
    "开局跟丢的文案不假装保住了什么", run.message);
}

{
  // ---- 抽不到画面 ----
  const mv = makeMovingSource({
    pos: (t) => (t >= 1.0 ? null : { x: 60 + 30 * t, y: 70 }),
  });
  const start: BoxRel = { x: 60 / mv.W, y: 70 / mv.H, w: mv.bw / mv.W, h: mv.bh / mv.H };
  const run = await runTrack(mv.src, openLocalMatcher, start, 0, 2, {});
  ok(run.fail?.kind === "nosource", "抽不到帧判为 nosource", String(run.fail?.kind));
  ok(run.message.startsWith("第 1.0s 处读不到画面"), "nosource 文案带时刻", run.message);

  // 抽帧自己抛异常，同样归入 nosource，不许把异常泄给调用方
  const boom: FrameSource = {
    async grab(t) { if (t > 0) throw new Error("解码炸了"); return mv.src.grab(0); },
  };
  const run2 = await runTrack(boom, openLocalMatcher, start, 0, 2, {});
  ok(run2.fail?.kind === "nosource" && run2.keyframes.length === 0,
    "抽帧抛异常被吃掉并归为 nosource");

  // 匹配器自己抛异常，同样归入 nosource
  const badMatcher: OpenMatcher = async () => ({
    match: async () => { throw new Error("worker 挂了"); },
    close: () => { },
  });
  const run3 = await runTrack(mv.src, badMatcher, start, 0, 0.5, {});
  ok(run3.fail?.kind === "nosource" && run3.keyframes.length === 0,
    "匹配器抛异常被吃掉并归为 nosource");

  // **尺寸突变**：帧宽没变、只有高变了。`matchTemplate` 不会因此抛
  // （`off` 是按宽度展平的），它会在一张更高的画面里照常找到峰值，
  // 然后 `toRel` 用新的高度换算 —— 于是 y 坐标**静默错位**，
  // 一路跟到底、得分很高、结果是错的。所以必须在这里就停。
  const first = (await mv.src.grab(0))!;
  const resized: FrameSource = {
    async grab(t) {
      if (t < 1.0) return mv.src.grab(t);
      const tall = gray(first.w, first.h + 20, (x, y) =>
        first.data[Math.min(first.h - 1, y) * first.w + x]);
      return tall;
    },
  };
  const run4 = await runTrack(resized, openLocalMatcher, start, 0, 2, {});
  ok(run4.fail?.kind === "nosource" && near(run4.fail!.tSec, 1.0, 1e-9),
    "帧高突变在第一时间收场（宽度没变，matchTemplate 不会替你发现）",
    `${run4.fail?.kind} @ ${run4.fail?.tSec.toFixed(3)}`);
  ok(run4.ok === 8, "且只保留突变之前的样本", `ok=${run4.ok}`);
}

{
  // ---- 纯色区域：在建 matcher 之前就拒绝 ----
  const flatSrc: FrameSource = { async grab() { return gray(320, 180, () => 128); } };
  const cm = countingMatcher(openLocalMatcher);
  const run = await runTrack(flatSrc, cm.open, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, 0, 2, {});
  ok(run.fail?.kind === "flat", "纯色区域判为 flat");
  ok(cm.opened() === 0, "**纯色时根本不开 matcher**（不白开一个 worker）");
  ok(run.keyframes.length === 0 && run.message.includes("纯色"), "flat 文案给了可操作建议",
    run.message);
}

{
  // ---- 镜头太短 ----
  const mv = makeMovingSource({ pos: () => ({ x: 60, y: 70 }) });
  const run = await runTrack(mv.src, openLocalMatcher, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, 1, 1, {});
  ok(run.fail?.kind === "tooshort" && run.keyframes.length === 0, "零长度区间判为 tooshort");
  ok(run.message === "这个镜头太短，没有可采样的时刻", "tooshort 文案", run.message);
}

{
  // ---- 取消：抛 Aborted，且 matcher 一定被 close ----
  const mv = makeMovingSource({ pos: (t) => ({ x: 60 + 30 * t, y: 70 }) });
  const start: BoxRel = { x: 60 / mv.W, y: 70 / mv.H, w: mv.bw / mv.W, h: mv.bh / mv.H };
  const cm = countingMatcher(openLocalMatcher);
  const signal = { aborted: false };
  let caught: unknown = null;
  try {
    await runTrack(mv.src, cm.open, start, 0, 2, {
      signal,
      onProgress: (d) => { if (d >= 3) signal.aborted = true; },
    });
  } catch (e) { caught = e; }
  ok(caught instanceof Aborted && (caught as Error).name === "Aborted",
    "取消抛的是 Aborted（App 靠 name 决定静默收场）");
  ok(cm.opened() === 1 && cm.closed() === 1, "**取消路径上 matcher 也被 close**");

  // 取消也可能是**抽帧那一侧**抛出来的：真实的 `openVideoFrameSource` 在 seek
  // 等待中被取消时，reject 的就是 `Aborted`。`grabSafe` 的 catch 必须把它原样放行 ——
  // 吞成 `null` 的话，用户点了取消，看到的却是「读不到画面」的错误提示，
  // 而且 `runTrack` 会**正常返回**、把半截结果当成功写回去。
  const abortingSrc: FrameSource = {
    async grab(t) { if (t > 0) throw new Aborted("用户已取消跟踪"); return mv.src.grab(t); },
  };
  const cm2 = countingMatcher(openLocalMatcher);
  let caught2: unknown = null;
  try {
    await runTrack(abortingSrc, cm2.open, start, 0, 2, {});
  } catch (e) { caught2 = e; }
  ok(caught2 instanceof Aborted, "抽帧侧抛的 Aborted 原样上抛（不被当成「读不到画面」吞掉）");
  ok(cm2.closed() === 1, "  这条路径上 matcher 同样被 close");

  // 进度回调自己抛异常，不许带走整条跟踪
  const run = await runTrack(mv.src, openLocalMatcher, start, 0, 0.5, {
    onProgress: () => { throw new Error("回调炸了"); },
  });
  ok(run.fail === null && run.keyframes.length >= 2, "进度回调抛异常不影响跟踪结果");
}

{
  // ---- trackMessage 的纯函数取值 ----
  const base = { samples: [], ok: 0, total: 10, sampleFps: 8 };
  const kfs2: RegionKeyframe[] = [
    { tSec: 0, x: 0, y: 0, w: 0.1, h: 0.1 }, { tSec: 1, x: 0.1, y: 0, w: 0.1, h: 0.1 },
  ];
  ok(trackMessage({ ...base, keyframes: kfs2, fail: null }) === "已跟踪 · 2 个关键帧",
    "trackMessage 成功态");
  ok(trackMessage({ ...base, keyframes: [], fail: { tSec: 3.24, kind: "nosource" } })
    === "读不到画面，没有写入任何关键帧", "nosource 且零关键帧时不提时刻（没有前段结果可保）");
  ok(trackMessage({ ...base, keyframes: kfs2, fail: { tSec: 3.24, kind: "nosource" } })
    === "第 3.2s 处读不到画面，已保留前段结果（2 个关键帧）", "nosource 且有前段结果");

  // 边界是 **2**，不是 1：1 条关键帧不构成动画（`replaceKfs` 会把它化成静态框），
  // 说「已保留前段结果（1 个关键帧）」等于告诉用户有一段能用的轨迹，而实际上没有。
  // `runTrack` 自己产不出恰好 1 条（≥2 才抽稀，否则给空数组），所以只能在这里直问。
  const kf1: RegionKeyframe[] = [{ tSec: 0, x: 0, y: 0, w: 0.1, h: 0.1 }];
  ok(trackMessage({ ...base, keyframes: kf1, fail: { tSec: 3.24, kind: "lost" } })
    === "一开始就跟丢了（目标被遮挡或移出画面），没有写入任何关键帧",
    "只有 1 条时不算「保留了前段结果」（lost）");
  ok(trackMessage({ ...base, keyframes: kf1, fail: { tSec: 3.24, kind: "nosource" } })
    === "读不到画面，没有写入任何关键帧",
    "只有 1 条时不算「保留了前段结果」（nosource）");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[4] 结果落盘：replaceKfs / clearKfs 的不变式");
// ═══════════════════════════════════════════════════════════
{
  const m0: MosaicParams = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, style: "pixel", intensity: 50 };
  const meta = { generatedAt: 123, sampleFps: 8, ok: 17, total: 17 };
  const kfs: RegionKeyframe[] = [
    { tSec: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    { tSec: 1, x: 0.5, y: 0.3, w: 0.2, h: 0.2 },
  ];

  const a = replaceKfs(m0, kfs, meta);
  ok(kfsOf(a).length === 2 && a.track?.ok === 17, "≥2 条时关键帧与 track 徽标都写入");
  const bAt1 = regionBoxAt(a, 1);
  ok(near(bAt1.x, 0.5), "写入的关键帧真的被 regionBoxAt 取到", bAt1.x.toFixed(3));

  // 乱序输入必须被归一化（`normalizeKfs` 是唯一真源）
  const shuffled = replaceKfs(m0, [kfs[1], kfs[0]], meta);
  ok(kfsOf(shuffled)[0].tSec === 0, "乱序输入被归一化成升序");

  // 不足 2 条：一条都不写关键帧、不写徽标、静态框同步
  const one = replaceKfs(a, [{ tSec: 5, x: 0.7, y: 0.6, w: 0.2, h: 0.2 }], meta);
  ok(one.track === undefined, "**只剩 1 条时不写 track 徽标**（不让用户以为跟踪成功了）");
  ok(near(one.x, 0.7) && near(one.y, 0.6), "**不变式**：<2 条时静态框与那条关键帧一致",
    `${one.x},${one.y}`);
  ok(near(regionBoxAt(one, 0).x, 0.7) && near(regionBoxAt(one, 99).x, 0.7),
    "于是任何时刻取到的都是那个框（拖了就看得见）");

  const zero = replaceKfs(a, [], meta);
  ok(zero.keyframes === undefined && zero.track === undefined,
    "空数组 ⇒ 既无关键帧也无徽标");

  const cleared = clearKfs(a);
  ok(cleared.keyframes === undefined && cleared.track === undefined,
    "clearKfs 连 track 徽标一起清（否则会显示「已跟踪」而区域是静态的）");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[5] 端到端：曲线运动 + 变速时间基准");
// ═══════════════════════════════════════════════════════════
{
  // 目标走一条正弦曲线（不是直线，抽稀必须留住拐点）。
  // 振幅取 40 而不是更大：搜索窗是上一帧框外扩 50% = 18px（框 36），
  // 而 40px 振幅的正弦在 8fps 下每步最多挪 40·π/8 ≈ 15.7px —— 留在窗内。
  // 这条约束本身是真的（跟得上多快的目标由框大小和采样率共同决定），
  // 用例要测的是抽稀与插值，不是去踩搜索窗的边界。
  const mv = makeMovingSource({
    W: 320, H: 240, boxW: 36, boxH: 36,
    pos: (t) => ({ x: 40 + 60 * t, y: 100 + 40 * Math.sin(t * Math.PI) }),
  });
  const start: BoxRel = { x: 40 / mv.W, y: 100 / mv.H, w: mv.bw / mv.W, h: mv.bh / mv.H };
  const run = await runTrack(mv.src, openLocalMatcher, start, 0, 3, {});

  ok(run.fail === null && run.ok === 25, "曲线运动一路跟到底", `${run.ok}/${run.total}`);
  let maxPxErr = 0;
  for (const s of run.samples) {
    const t = mv.truth(s.tSec)!;
    maxPxErr = Math.max(maxPxErr,
      Math.abs(s.box.x * mv.W - t.x), Math.abs(s.box.y * mv.H - t.y));
  }
  ok(maxPxErr < 1e-9, "曲线运动同样逐帧精确", `最大误差 ${maxPxErr.toExponential(2)} px`);
  ok(run.keyframes.length >= 4, "拐点被保住（不是抽成一条直线）",
    `${run.keyframes.length} 条`);
  ok(worstError(run.samples, run.keyframes) <= DEFAULT_TOL_RATIO + 1e-9,
    "复原误差仍在容差内");

  // 上面留下 23/25 条不是抽稀失灵，是**容差比量化噪声还紧**：
  // 1px / 240 = 0.0042 > tol 0.004，正弦上几乎每个点都真的超差。
  // 把容差放到量化噪声之上再问一次，才看得出 DP 在干活 —— 同时上界照守。
  const coarse = thinTrack(run.samples, 0.02);
  ok(coarse.length >= 4 && coarse.length <= 12,
    "容差放宽到 0.02 后，正弦被抽成少数几个拐点（而不是全留或只剩两条）",
    `25 → ${coarse.length}`);
  ok(worstError(run.samples, coarse) <= 0.02 + 1e-9, "放宽后的上界同样成立");

  // 关键帧全部落在 [0,3] 内且严格升序 —— 直接喂给 regionBoxAt 的前提
  const ks = run.keyframes;
  let sane = ks[0].tSec >= 0 && ks[ks.length - 1].tSec <= 3;
  for (let i = 1; i < ks.length; i++) if (!(ks[i].tSec > ks[i - 1].tSec)) sane = false;
  ok(sane, "关键帧时刻升序且落在跟踪区间内");

  // 从**播放头**开始跟：起点之前不外推，由 regionBoxAt 的首尾夹持覆盖
  const mid = await runTrack(mv.src, openLocalMatcher, toRel(
    { x: mv.truth(1)!.x, y: mv.truth(1)!.y, w: mv.bw, h: mv.bh },
    { w: mv.W, h: mv.H },
  ), 1, 3, {});
  ok(mid.fail === null && mid.keyframes[0].tSec === 1,
    "从播放头 1s 开始跟，第一条关键帧就在 1s", String(mid.keyframes[0].tSec));
  const before = regionBoxAt(mp(mid.keyframes), 0);
  ok(near(before.x, mid.keyframes[0].x) && near(before.y, mid.keyframes[0].y),
    "起点之前取到的是第一条关键帧（夹持，不外推）");
}

// ═══════════════════════════════════════════════════════════
console.log("\n[6] 接线：node 跑不动的那两层壳（.tsx / DOM / Worker）");
// ═══════════════════════════════════════════════════════════
//
// 上面五段把**算法与流程**真跑了一遍，但 `MosaicPanel.tsx`（React）、
// `frameSource.ts`（`<video>` + canvas）、`nccClient.ts`（Worker）在 node 下
// 加载不了。这一段只能做源码断言 —— 因此每一条都钉**整个承重结构**，
// 不钉"调用了某个函数"：把 `if (blobUrl)` 改成 `if (true)` 照样能通过
// 「调了 localBlobFor」那种断言，而行为已经变成拿云端地址去跟踪。
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
/** 剥注释再断言"代码里没有 X" —— 注释里逐字写了被否掉的写法，否则断言恒红。 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

{
  const PANEL = code(read("features/inspector/MosaicPanel.tsx"));

  // 拿不到本地副本就**不跟**，而不是拿云端地址硬上（那会以 SecurityError 收场）
  ok(/const blobUrl = await localBlobFor\(videoUrl\);/.test(PANEL)
    && /if \(!blobUrl\) \{/.test(PANEL),
    "拿不到本地 blob 时整条跟踪停下（钉的是分支，不是那一句调用）");
  ok(/网页版不支持，请用桌面客户端/.test(PANEL),
    "  并且说清了为什么不行、怎么才行");

  // 先看盘、没有才下；下载是用户显式点了跟踪才做的
  const iHit = PANEL.indexOf("localSources.localBlobForCurrent");
  const iEnsure = PANEL.indexOf("await ensureCached(");
  ok(iHit > 0 && iEnsure > iHit, "顺序是「先看盘上有没有 → 没有才下载」");
  ok(/const pid = localSources\.currentProject\(\);\s*\n\s*if \(!pid\) return null;/.test(PANEL),
    "  没有当前项目就直接放弃（不拿 null 当 projectId 去下载）");

  // 写回只有一条路径，且守着「不足 2 条不写」
  check("写回关键帧只有一处（replaceKfs 是唯一入口）",
    (PANEL.match(/replaceKfs\(/g) ?? []).length, 1);
  ok(/if \(run\.keyframes\.length >= 2\) \{/.test(PANEL),
    "  且只在 ≥2 条时才写（跟丢/开局就丢时一个字都不落盘）");
  ok(/onToast\(run\.message\)/.test(PANEL),
    "  成功与失败都只说 runTrack 那一句（不在 UI 里另写一套说法）");

  // 换镜头必须掐掉在跑的跟踪：patchWhole 闭包捕获的是发起时那份 mosaics
  ok(/useEffect\(\(\) => \(\) => \{\s*\n\s*if \(trackAbortRef\.current\) trackAbortRef\.current\.aborted = true;\s*\n\s*\}, \[shotId\]\);/.test(PANEL),
    "换镜头/卸载时把在跑的跟踪掐掉（否则结果写到另一个镜头的区域上）");

  // 起点是播放头，不是 0
  ok(/const t0 = Math\.max\(0, Math\.min\(playheadSec \?\? 0, durationSec\)\);/.test(PANEL),
    "从播放头开始往后跟，且夹进 [0, 镜头长度]");
  ok(/regionBoxAt\(r, t0\)/.test(PANEL),
    "  模板取的是**播放头那一帧**的框（不是静态框 —— 区域已有动画时两者不同）");

  // 进度按采样点算：跟丢会提前结束（`total` 是计划采样数、`done` 是已成功数），
  // 换成按时间算的话，跟丢时百分比会停在半路，看起来像卡死而不是"停下了"。
  // 连 `total > 0` 的守卫一起钉：`total=0` 时按时间算会出 NaN%，
  // 而 NaN 在 React 里是**照常渲染成字符串**的，不报错。
  ok(/const trackPct = busyTrack && tracking\.total > 0\s*\n\s*\? Math\.round\(\(tracking\.done \/ tracking\.total\) \* 100\)/.test(PANEL),
    "进度按**采样点**算（且 total=0 时不产生 NaN%）");

  // 三态与两个动作都在
  for (const s of ["开始跟踪", "重新跟踪", "跟踪中", "取消", "清除"]) {
    ok(PANEL.includes(s), `  UI 有「${s}」`);
  }
}
{
  const FS = code(read("lib/track/frameSource.ts"));
  ok(/willReadFrequently: true/.test(FS),
    "canvas 开 willReadFrequently（逐帧 getImageData，不开会走 GPU 回读的慢路）");
  ok(/const target = dur \? Math\.min\(Math\.max\(0, at\), Math\.max\(0, dur - 1e-3\)\) : Math\.max\(0, at\);/.test(FS),
    "seek 目标夹进 [0, duration)：越界的 seek 既不 fire seeked 也不 fire error，"
    + "会白等满超时（×40 帧 = 看起来卡死）");
  ok(/shotSecOf\(tSec, speed\)/.test(FS),
    "「输出秒 → 素材秒」的换算走 keyframeEdit 那一份（不在这里另算一遍）");
  ok(/catch \{ return null; \}/.test(FS) || /\} catch \{\s*\n\s*return null;/.test(FS),
    "抽帧失败一律返回 null（交给 runTrack 说人话，不往上抛）");
  ok(!/revokeObjectURL/.test(FS),
    "close() **不** revoke blob —— 那是 localSources 的对象，跟踪不许替它回收");
}
{
  const CL = code(read("lib/track/nccClient.ts"));
  const WK = code(read("lib/track/nccWorker.ts"));
  ok(/openLocalMatcher\(tpl, opts\)/.test(CL),
    "worker 造不出来/握手失败时退回主线程匹配器（结果逐位相同）");
  check("兜底有两处：构造失败 与 握手失败",
    (CL.match(/return openLocalMatcher\(tpl, opts\);/g) ?? []).length, 2);
  ok(/const timer = setTimeout\(/.test(CL)
    && /p\.reject\(new Error\("worker 握手超时"\)\)/.test(CL)
    && /\n\s*HANDSHAKE_TIMEOUT_MS,\n/.test(CL),
    "握手有超时：`new Worker` 不抛 ≠ worker 能用（脚本加载失败是异步 error，"
    + "某些容器里根本不来）");
  ok(/addEventListener\("error"/.test(CL) && /killAll/.test(CL),
    "worker 死掉时把在飞的请求全 reject —— 否则 runTrack 卡在一个永不 settle 的"
    + "await 上，取消检查点在下一轮，连取消都救不回来");
  ok(/matchTemplate\(/.test(WK) && !/for \(let oy/.test(WK),
    "worker 里没有第二份匹配实现（只调 matchTemplate）");
  ok(/ok: false/.test(WK),
    "worker 里的异常被接住并回给对应 id（未捕获异常会变成无 id 的 error 事件，"
    + "那次 match 就永远挂着）");
}
{
  const CSS = read("features/inspector/MosaicPanel.css");
  for (const c of ["fw-mp-trkrow", "fw-mp-trk-btn", "fw-mp-trk-prog",
    "fw-mp-trk-cancel", "fw-mp-trk-ok", "fw-mp-trk-clear"]) {
    ok(CSS.includes(`.${c}`), `  CSS 有 .${c}`);
  }
  ok(/tabular-nums/.test(CSS),
    "进度数字用等宽数位（9%→10% 不会让整行左右跳）");
}
{
  const INS = code(read("features/inspector/Inspector.tsx"));
  ok(/videoUrl=\{s\.video_url \?\? null\}/.test(INS)
    && /clipInSec=\{s\.clip_in_sec \?\? 0\}/.test(INS)
    && /speed=\{s\.transform_meta\?\.speed\}/.test(INS),
    "Inspector 把素材地址、入点、变速原样传下去（换算在抽帧那一侧做）");
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败");
process.exit(fail === 0 ? 0 : 1);
