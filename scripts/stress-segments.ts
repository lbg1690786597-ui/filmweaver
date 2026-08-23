/** 分段器压力测试：构造最坏情况，确认内存上限在任何编排下都成立。 */
import { buildSegments, segmentStats, MAX_INPUTS_PER_SEGMENT } from "../src/render/segment";
import { DEFAULT_TRANSFORM, DEFAULT_AUDIO } from "../src/render/model";
import type { RenderPlan, RenderClip, RenderTransition } from "../src/render/model";

const out = { width: 1080, height: 1920, fps: 30, vcodec: "libx264", crf: 20, withAudio: true };

function clip(i: number, start: number, dur: number, withFx = false): RenderClip {
  return {
    id: `c${i}`, mediaId: `m${i}`,
    timelineStartSec: start, durationSec: dur,
    sourceInSec: 0, sourceDurationSec: dur, speed: 1,
    transform: withFx ? { ...DEFAULT_TRANSFORM, scale: 0.8 } : { ...DEFAULT_TRANSFORM },
    effects: withFx ? [{ type: "contrast" as const, value: 20 }] : [],
    audio: { ...DEFAULT_AUDIO },
  };
}

function mkPlan(clips: RenderClip[], transitions: RenderTransition[] = []): RenderPlan {
  return {
    projectId: "stress", media: [],
    tracks: [{ id: "v1", kind: "video", layer: 1, muted: false, hidden: false, clips }],
    transitions, subtitles: [], output: out,
    totalSec: Math.max(...clips.map((c) => c.timelineStartSec + c.durationSec)),
  };
}

const cases: { name: string; plan: RenderPlan }[] = [];

// A. 1424 镜纯顺序（库里最大项目的规模）
{
  const cs: RenderClip[] = [];
  for (let i = 0; i < 1424; i++) cs.push(clip(i, i * 5, 5));
  cases.push({ name: "1424 镜纯顺序", plan: mkPlan(cs) });
}

// B. 170 镜「每个接缝都有转场」——转场必须不跨段，最考验分段逻辑
{
  const cs: RenderClip[] = [];
  const trs: RenderTransition[] = [];
  for (let i = 0; i < 170; i++) cs.push(clip(i, i * 5, 5));
  for (let i = 1; i < 170; i++) {
    trs.push({ id: `t${i}`, type: "fade", durationSec: 0.5,
               fromClipId: `c${i - 1}`, toClipId: `c${i}` });
  }
  cases.push({ name: "170 镜全接缝转场", plan: mkPlan(cs, trs) });
}

// C. 全部带滤镜（无法透传，全走 composite）
{
  const cs: RenderClip[] = [];
  for (let i = 0; i < 300; i++) cs.push(clip(i, i * 5, 5, true));
  cases.push({ name: "300 镜全带滤镜", plan: mkPlan(cs) });
}

// D. 大量叠加：10 个 clip 完全重叠在同一时间
{
  const cs: RenderClip[] = [];
  for (let i = 0; i < 10; i++) cs.push(clip(i, 0, 30, true));
  for (let i = 10; i < 60; i++) cs.push(clip(i, 30 + (i - 10) * 5, 5));
  cases.push({ name: "10 层叠加 + 50 顺序", plan: mkPlan(cs) });
}

console.log("场景".padEnd(22), "段数".padStart(6), "透传".padStart(6),
            "合成".padStart(6), "峰值输入".padStart(9), "估算内存".padStart(11), " 判定");
console.log("-".repeat(78));
let allOk = true;
for (const { name, plan } of cases) {
  const st = segmentStats(buildSegments(plan));
  const single = 552 + plan.tracks[0].clips.length * 134;
  // 判定标准：8GB 机器安全线 2048MB
  const ok = st.estPeakMB < 2048;
  if (!ok) allOk = false;
  console.log(
    name.padEnd(22),
    String(st.total).padStart(6),
    String(st.passthrough).padStart(6),
    String(st.composite).padStart(6),
    String(st.maxInputs).padStart(9),
    `${st.estPeakMB}MB`.padStart(11),
    ` ${ok ? "✅" : "❌"}  (单图需 ${(single / 1024).toFixed(1)}GB)`,
  );
}
console.log("-".repeat(78));
console.log(allOk ? "✅ 全部场景峰值内存 < 2GB" : "❌ 存在超限场景");
console.log(`   单段输入上限 = ${MAX_INPUTS_PER_SEGMENT}`);
