/**
 * 分段器验证脚本（一次性，非产品代码）。
 * 用真实项目数据跑 normalize → buildSegments，核对：
 *   - 段数与类型分布
 *   - 峰值输入数 → 内存估算
 *   - 时间轴连续性（无空洞/重叠错误）
 * 跑法：npx tsx scripts/verify-segments.ts
 */
import { readFileSync } from "node:fs";
import { normalize } from "../src/render/normalize";
import { buildSegments, segmentStats, MAX_INPUTS_PER_SEGMENT } from "../src/render/segment";
import type { ShotInfo } from "../src/api";

const shots = JSON.parse(readFileSync("/tmp/shots170.json", "utf-8")) as ShotInfo[];

const plan = normalize({
  projectId: "e3e5d6e517c6",
  shots,
  output: { width: 1080, height: 1920, fps: 30, vcodec: "libx264", crf: 20, withAudio: true },
  scope: "generated",
});

console.log("=== RenderPlan ===");
console.log(`  媒体去重后 : ${plan.media.length} 个`);
console.log(`  视频 clip  : ${plan.tracks.find((t) => t.kind === "video")!.clips.length} 个`);
console.log(`  总时长     : ${plan.totalSec.toFixed(1)}s`);
console.log(`  资产轨泄漏 : ${plan.tracks.some((t) => (t.kind as string).startsWith("asset")) ? "❌ 有" : "✅ 无"}`);

const segs = buildSegments(plan);
const st = segmentStats(segs);

console.log("\n=== 分段结果 ===");
console.log(`  总段数     : ${st.total}`);
console.log(`  透传段     : ${st.passthrough}  (直接 copy，零解码)`);
console.log(`  合成段     : ${st.composite}`);
console.log(`  单段最大输入: ${st.maxInputs}  (上限 ${MAX_INPUTS_PER_SEGMENT})`);
console.log(`  超限段数   : ${st.oversized}`);
console.log(`  估算峰值内存: ${st.estPeakMB} MB = ${(st.estPeakMB / 1024).toFixed(2)} GB`);

// 对照：不分段的单图方案
const single = 552 + plan.tracks.find((t) => t.kind === "video")!.clips.length * 134;
console.log(`\n  对照·单图  : ${single} MB = ${(single / 1024).toFixed(1)} GB`);
console.log(`  内存降幅   : ${(single / st.estPeakMB).toFixed(1)}×`);

// 连续性核对
let bad = 0, cursor = 0;
for (const s of segs) {
  if (Math.abs(s.startSec - cursor) > 0.01) bad++;
  cursor = s.endSec;
}
console.log(`\n  时间轴连续 : ${bad === 0 ? "✅ 无空洞" : `❌ ${bad} 处断裂`}`);
console.log(`  末段终点   : ${cursor.toFixed(1)}s  (plan 总时长 ${plan.totalSec.toFixed(1)}s)`);

const ok = st.oversized === 0 && bad === 0 && st.estPeakMB < 2048;
console.log(`\n${ok ? "✅ 验收通过" : "❌ 验收未过"}：8GB 机器安全线 <2048MB，实际 ${st.estPeakMB}MB`);
