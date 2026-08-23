/**
 * 时间轴叠加轨与 RenderPlan 的一致性验证。
 *
 * 关键点：时间轴显示什么位置，导出就必须是什么位置。两边各算一套坐标
 * 必然漂移——这个脚本就是钉住这条不变量。
 *
 * 跑法：npx tsx scripts/verify-overlay-ui.ts
 */
import { buildTimeline } from "../src/adapters/shotToClip";
import { normalize } from "../src/render/normalize";
import type { ShotInfo } from "../src/api";

function shot(i: number, over: Partial<ShotInfo> = {}): ShotInfo {
  return {
    id: `s${i}`, order: i, episode: 1, script_ref: `镜${i}`,
    link_to_prev: "cut", characters: [], location: null,
    video_url: `/fw/media/v${i}.mp4`, thumb_url: null, status: "adopted",
    adopted_version: 1, is_special: false, gen_prompt: null, stale: false,
    prompt_state: null, duration_sec: 4, disabled: false, special_name: null,
    ref_overrides: null, refs_stale: false, first_frame_url: null,
    profile_override: null, ...over,
  } as ShotInfo;
}

// 主轨 3 段（各 4s）+ 2 个叠加层
const shots: ShotInfo[] = [
  shot(1), shot(2), shot(3),
  shot(4, { track_index: 1, overlay_start_sec: 2.5 }),
  shot(5, { track_index: 2, overlay_start_sec: 7.0 }),
];

const tl = buildTimeline({ shots });
const plan = normalize({
  projectId: "p", shots,
  output: { width: 1080, height: 1920, fps: 30, vcodec: "libx264", crf: 20, withAudio: true },
  scope: "generated",
});

const uiVideo = tl.tracks.filter((t) => t.kind === "video" || t.kind === "overlay");
const planVideo = plan.tracks.filter((t) => t.kind === "video");

console.log("=== 时间轴（UI）===");
for (const t of uiVideo) {
  console.log(`  ${t.label.padEnd(8)} [${t.kind}] ${t.clips.length} clip: `
    + t.clips.map((c) => `${c.label}@${c.startSec}s`).join(", "));
}
console.log("\n=== RenderPlan（导出）===");
for (const t of planVideo) {
  console.log(`  ${t.id.padEnd(8)} layer=${t.layer} ${t.clips.length} clip: `
    + t.clips.map((c) => `${c.id}@${c.timelineStartSec}s`).join(", "));
}

// 核对：每个 shot 在两边的起始秒必须一致
const uiPos = new Map<string, number>();
for (const t of uiVideo) for (const c of t.clips) uiPos.set(c.shotId ?? c.id, c.startSec);
const planPos = new Map<string, number>();
for (const t of planVideo) {
  for (const c of t.clips) planPos.set(c.id.replace(/^c_/, ""), c.timelineStartSec);
}

console.log("\n=== 位置一致性 ===");
let ok = true;
for (const s of shots) {
  const u = uiPos.get(s.id), r = planPos.get(s.id);
  const same = u !== undefined && r !== undefined && Math.abs(u - r) < 0.001;
  if (!same) ok = false;
  console.log(`  ${s.id} (轨${s.track_index ?? 0}) UI=${u}s  Plan=${r}s  ${same ? "✅" : "❌"}`);
}

// UI 刻度尺要能显示到"最靠后的内容"，可能是伸出主轨的叠加层；
// Plan 的 totalSec 是主轨长度。两者只在无越界叠加层时相等。
const overlayEnd = Math.max(0, ...shots.filter((s) => (s.track_index ?? 0) > 0)
  .map((s) => (s.overlay_start_sec ?? 0) + (s.duration_sec ?? 5)));
const expectUiTotal = Math.max(plan.totalSec, overlayEnd);
const totalOk = Math.abs(tl.totalDurationSec - expectUiTotal) < 0.001;
console.log(`\n主轨(Plan)=${plan.totalSec}s  叠加层末尾=${overlayEnd}s  `
  + `UI 刻度尺=${tl.totalDurationSec}s (期望 ${expectUiTotal}s) ${totalOk ? "✅" : "❌"}`);
console.log(`叠加层不占顺序时间（3×4=12s，不含叠加层）：`
  + `${plan.totalSec === 12 ? "✅" : `❌ 实际 ${plan.totalSec}s`}`);
console.log(`\n${ok && plan.totalSec === 12 && totalOk
  ? "✅ 时间轴与导出坐标完全一致" : "❌ 存在不一致"}`);
