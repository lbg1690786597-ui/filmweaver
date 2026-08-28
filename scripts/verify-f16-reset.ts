/**
 * verify-f16-reset.ts — F16 切换项目时的工作区清场验证
 *
 * 验证 resetForProjectSwitch() 将所有跨项目「传染」的状态归零：
 *   - playheadSec / cursorSec / selection / clipboard / tool / undoStack / redoStack
 *   - timeline 立即清空（不等 rebuild effect）
 *
 * 与 verify-snap 同构：纯计算，不依赖 DOM，tsx 直接运行。
 */

import { useTimelineStore } from "../src/stores/timelineStore";
import type { Timeline } from "../src/types/timeline";

// ---------- localStorage stub（store 用 readPref/writePref，Node 里没有） ----------
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => { mem.clear(); },
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
} satisfies Storage;

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}

// 一条假 timeline，模拟项目 A 已加载
const fakeTimeline: Timeline = {
  tracks: [{
    id: "v1", kind: "video", label: "主视频", locked: false, hidden: false,
    muted: false, solo: false, collapsed: false, height: 80,
    clips: [{
      id: "c1", trackId: "v1", startSec: 0, durationSec: 5,
      shotId: "s1", shotOrder: 1, label: "#1",
      disabled: false, isSpecial: false, status: "done",
      refsStale: false, characters: [],
    }],
    assetSegments: [],
  }],
  totalDurationSec: 5,
};

const store = useTimelineStore.getState();

// ---- 模拟用户在项目 A 里做了一堆操作 ----
store.setTimeline(fakeTimeline);
store.setPlayheadSec(320.5);
store.setCursorSec(18.0);
store.selectClip("c1");
store.copySelection();
store.setTool("split");
store.pushUndo({ label: "操作A", undo: async () => {}, redo: async () => {} });
store.pushUndo({ label: "操作B", undo: async () => {}, redo: async () => {} });

// 确认状态已被写入
const before = useTimelineStore.getState();
console.log("\n项目 A 状态（切换前）：");
console.log(`  playheadSec=${before.playheadSec}, cursorSec=${before.cursorSec}`);
console.log(`  selection.clipIds=${JSON.stringify(before.selection.clipIds)}`);
console.log(`  clipboard.length=${before.clipboard.length}`);
console.log(`  tool=${before.tool}`);
console.log(`  undoStack.length=${before.undoStack.length}`);
console.log(`  timeline.tracks.length=${before.timeline.tracks.length}`);

// ---- 调用切换项目时的清场 ----
useTimelineStore.getState().resetForProjectSwitch();
const after = useTimelineStore.getState();

console.log("\n切换后（resetForProjectSwitch）：");
check("playheadSec 归零", after.playheadSec, 0);
check("cursorSec 归 null", after.cursorSec, null);
check("selection 清空", after.selection, { clipIds: [], assetSegmentIds: [] });
check("clipboard 清空", after.clipboard.length, 0);
check("tool 回 select", after.tool, "select");
check("undoStack 清空", after.undoStack.length, 0);
check("redoStack 清空", after.redoStack.length, 0);
check("timeline 立即清空（不等 rebuild effect）",
      after.timeline.tracks.length, 0);

// ---- 切换不应影响 pxPerSec / snapping（用户操作习惯，跨项目保留）----
const px0 = 40;        // 必须落在 [ZOOM_MIN=4, ZOOM_MAX=60] 内，否则被钳制
useTimelineStore.getState().setPxPerSec(px0);
useTimelineStore.getState().resetForProjectSwitch();
check("pxPerSec 保留（不重置）",
      useTimelineStore.getState().pxPerSec, px0);

console.log();
if (failed) {
  console.log(`❌ ${failed} 个用例失败`);
  process.exit(1);
}
console.log("✅ F16 工作区清场全部通过");
