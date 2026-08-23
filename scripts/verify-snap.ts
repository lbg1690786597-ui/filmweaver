/**
 * verify-snap.ts — 时间轴吸附逻辑验证
 *
 * 吸附是纯计算，不依赖 ffmpeg / DOM，最适合脚本化验证。
 * 重点验三件容易写错的事：
 *   ① 阈值是像素而非秒 —— 缩放后手感必须一致
 *   ② 拖动中的 clip 不能吸附到自己 —— 否则原地卡死
 *   ③ 吸尾时要把结果换算回起点 —— 直接返回尾部位置会让 clip 跳走
 */

import { collectSnapPoints, snapTo, snapRange } from "../src/features/timeline/snap";
import type { Timeline } from "../src/types/timeline";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}

const tl = {
  tracks: [
    {
      id: "v1", kind: "video", layer: 1, locked: false, hidden: false,
      clips: [
        { id: "a", startSec: 0, durationSec: 4 },
        { id: "b", startSec: 4, durationSec: 3 },
      ],
    },
    {
      // 锁定轨：不该参与吸附
      id: "v2", kind: "video", layer: 2, locked: true, hidden: false,
      clips: [{ id: "z", startSec: 99, durationSec: 1 }],
    },
  ],
} as unknown as Timeline;

console.log("① 吸附点收集");
const pts = collectSnapPoints(tl, 5.5, null);
const secs = [...new Set(pts.map((p) => p.sec))].sort((x, y) => x - y);
check("含 0 / clip 首尾 / 播放头", secs, [0, 4, 5.5, 7]);
check("锁定轨的 99s 未被收进来", secs.includes(99), false);

// 排除 clip "b"(4~7)：它的 4 和 7 都该消失。
// 注意不能用 "a" 来测——a 的尾(4) 恰好也是 b 的头，排掉 a 后 4 仍在，
// 看起来像没生效。挑一个首尾都不与他人重合的来验才有意义。
const ptsEx = collectSnapPoints(tl, 5.5, null, "b");
check("排除拖动中的 clip 自身首尾",
      [...new Set(ptsEx.map((p) => p.sec))].sort((x, y) => x - y),
      [0, 4, 5.5]);   // 4 来自 clip a 的尾，7 已随 b 一起消失

console.log("\n② 阈值按像素（缩放后手感一致）");
// 100px/s 下 8px = 0.08s：偏差 0.05s 应吸上，0.2s 不应
check("100px/s 偏差 0.05s → 吸上", snapTo(4.05, pts, 100).sec, 4);
check("100px/s 偏差 0.20s → 不吸", snapTo(4.2, pts, 100).sec, 4.2);
// 10px/s 下 8px = 0.8s：同样 0.2s 的偏差这次应该吸上
check("10px/s  偏差 0.20s → 吸上", snapTo(4.2, pts, 10).sec, 4);
check("阈值确实随缩放变化（否则手感会飘）",
      snapTo(4.2, pts, 100).hit === null && snapTo(4.2, pts, 10).hit !== null, true);

console.log("\n③ 区间吸附（拖整个 clip）");
// clip 长 2s，起点 3.95 → 头贴 4（偏差 0.05）
check("头更近 → 吸头", snapRange(3.95, 2, pts, 100).sec, 4);
// clip 长 3s，起点 4.02 → 尾在 7.02，贴 7（偏差 0.02）比头(0.02 vs 4) 更近
const r = snapRange(4.02, 3, pts, 100);
check("尾更近 → 换算回起点而非跳到尾部", r.sec, 4);
check("吸尾后 clip 尾部正好落在吸附点", r.sec + 3, 7);

console.log("\n④ 边界");
check("无吸附点时原样返回", snapTo(3.3, [], 100).sec, 3.3);
check("pxPerSec=0 不崩且不吸", snapTo(3.3, pts, 0).sec, 3.3);
check("吸尾不会把起点算成负数", snapRange(0.1, 100, pts, 100).sec >= 0, true);

if (failed) {
  console.log(`\n❌ ${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n✅ 吸附逻辑全部通过");
