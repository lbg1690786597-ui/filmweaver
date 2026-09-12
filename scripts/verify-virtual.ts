/**
 * verify-virtual.ts — 时间轴横向虚拟化（批次 3 / 3.10）
 *
 * ## 虚拟化的失败方式全都是"少画了一点，但不报错"
 *
 * 这就是它必须被断言死钉的原因：区间算错一个像素，用户看到的是
 * **视口边缘缺一格**、或者**滚动时片段追着补上来**，控制台一片安静。
 * 更坏的是这类错误与滚动位置有关，复现全靠运气。
 *
 * 逐条钉的四件事：
 *
 * **① 量化后的视口必须完全覆盖真实视口。** 量化是为了不每帧 setState，
 * 但量化区间只要有一侧比真实视口窄，滚到桶边界就会缺一条。
 * ② 段中钉了「对任意随机滚动位置，量化区间都包住真实区间」。
 *
 * **② 判可见要用画出来的宽度。** `ClipView` 写的是 `Math.max(18, dur*pxPerSec)`，
 * 0.2 秒的片段在 4px/s 下逻辑宽 0.8px、实际画 18px。按逻辑宽度剔除，
 * 它会在视口左边缘"该露出一截却没有"。
 *
 * **③ 正在拖的那个不能被剔掉。** 拖动监听挂在 window 上，所以拖拽本身不会断——
 * 表现是片段凭空消失、松手又回来，不报任何错。
 *
 * **④ lane 必须保持满宽。** 3.3 的播放头跟随滚动读的是 `el.scrollWidth`；
 * 宽度一塌，滚动条和跟随落点跟着塌。这条只能静态钉（⑥ 段）。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_CLIP_PX, SEAM_HALF_PX, OVERSCAN_PX, BUCKET_PX, FALLBACK_VIEW_PX,
  bucketViewport, sameViewport, visibleSpan, clipSpanPx, pointSpanPx,
  inSpan, visibleClips, tickIndexRange,
} from "../src/features/timeline/virtual";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const okEq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okEq) failed++;
  console.log(`  ${okEq ? "✅" : "❌"} ${name}`);
  if (!okEq) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/* ================================================================== */
console.log("\n① bucketViewport：量化到桶，且**只能往外扩，不能往里缩**");

check("桶内滚动不产生新视口（这就是量化的全部意义）",
  [bucketViewport(0, 1000), bucketViewport(BUCKET_PX - 1, 1000)],
  [bucketViewport(0, 1000), bucketViewport(0, 1000)]);
ok("跨过桶边界才变",
  !sameViewport(bucketViewport(BUCKET_PX - 1, 1000),
                bucketViewport(BUCKET_PX, 1000)));
check("左边缘向下取整到整桶", bucketViewport(701, 1000).scrollLeft, 600);
check("宽度向上取整并**多留一个桶**（补掉左边缘向下取整丢的那一截）",
  bucketViewport(701, 1000).widthPx, 1500);
// ⚠️ 这条是整个虚拟化的地基：量化区间只要有一侧比真实视口窄，
// 滚到桶边界就会缺一条，且只在特定滚动位置复现。
let covered = true;
for (let sl = 0; sl < 4000; sl += 7) {
  for (const w of [320, 900, 1377, 2560]) {
    const b = bucketViewport(sl, w);
    if (b.scrollLeft > sl || b.scrollLeft + b.widthPx < sl + w) covered = false;
  }
}
ok("对任意滚动位置/视口宽度，量化区间都**完全包住**真实视口", covered,
  "包不住 = 滚到桶边界时视口里缺一条片段，且只在特定位置复现");
check("宽度为 0（首帧还没量出来）→ 用兜底宽度而不是空区间",
  bucketViewport(0, 0).widthPx >= FALLBACK_VIEW_PX, true);
check("负 scrollLeft（overscroll 弹性）→ 当作 0", bucketViewport(-50, 900).scrollLeft, 0);
ok("sameViewport 逐字段比（不是引用比）",
  sameViewport({ scrollLeft: 300, widthPx: 1500 },
               { scrollLeft: 300, widthPx: 1500 })
  && !sameViewport({ scrollLeft: 300, widthPx: 1500 },
                   { scrollLeft: 600, widthPx: 1500 })
  // 只比 scrollLeft 的话，原地拉宽窗口/最大化时间轴就不会补渲染右边那一截
  && !sameViewport({ scrollLeft: 300, widthPx: 1500 },
                   { scrollLeft: 300, widthPx: 2100 }));

/* ================================================================== */
console.log("\n② visibleSpan：视口 → lane 内区间（减 gutter、加 overscan）");

const vp = { scrollLeft: 600, widthPx: 1500 };
check("减掉轨道头宽度（lane 的 left=0 落在内容坐标 gutter 处）",
  visibleSpan(vp, 68, 0), { fromPx: 532, toPx: 2032 });
check("加 overscan（滚轮一次惯性滑动基本落在已渲染区里）",
  visibleSpan(vp, 68), { fromPx: 532 - OVERSCAN_PX, toPx: 2032 + OVERSCAN_PX });
ok("最左端 overscan 会溢出成负数，且**不夹到 0**",
  visibleSpan({ scrollLeft: 0, widthPx: 1500 }, 68).fromPx < 0,
  "夹到 0 没有坏处但也没有好处；留负数让 inSpan 的判据保持单一");
ok("overscan 至少能盖住一个桶（否则滚一格就看见片段追着补上来）",
  OVERSCAN_PX >= BUCKET_PX);

/* ================================================================== */
console.log("\n③ clipSpanPx：判可见用的是**画出来的**宽度");

check("常规片段", clipSpanPx(10, 5, 12), [120, 180]);
// ⚠️ 这条对应 ClipView 的 `Math.max(18, dur*pxPerSec)`。
// 按逻辑宽度剔除的话，0.2 秒的片段在 4px/s 下宽 0.8px，
// 而它实际画 18px —— 会在视口左边缘"该露出一截却没有"。
check("极短片段：右端按 MIN_CLIP_PX 算，不是按逻辑宽度",
  clipSpanPx(100, 0.2, 4), [400, 400 + MIN_CLIP_PX]);
ok("MIN_CLIP_PX 与 ClipView 里写死的那个数同值",
  /Math\.max\(18, dur \* p\.pxPerSec\)/.test(read("src/features/timeline/ClipView.tsx"))
  && MIN_CLIP_PX === 18,
  "两处各写一份必然漂移，漂移的表现是边缘缺一格");
check("零时长（脏数据）→ 仍是一个非空区间", clipSpanPx(10, 0, 12), [120, 138]);
check("pointSpanPx：以中心 ±half 算（接缝菱形 translateX(-50%)）",
  pointSpanPx(10, 12, SEAM_HALF_PX), [120 - 9, 120 + 9]);
ok("SEAM_HALF_PX 与 CSS 里的 .fw-tl-seam 宽度对得上",
  /\.fw-tl-seam \{[\s\S]{0,400}?width: 18px;/.test(read("src/features/timeline/Timeline.css"))
  && SEAM_HALF_PX * 2 === 18);

/* ================================================================== */
console.log("\n④ inSpan：闭区间相交（贴边的那个要留着）");

const r = { fromPx: 100, toPx: 200 };
ok("完全在内", inSpan([120, 180], r));
ok("跨越整个视口（一个很长的片段）", inSpan([0, 999], r));
ok("左边贴边：右端正好等于 fromPx → **算可见**",
  inSpan([50, 100], r), "改成开区间的话视口左缘会缺一格");
ok("右边贴边：左端正好等于 toPx → 算可见", inSpan([200, 300], r));
ok("完全在左边 → 不可见", !inSpan([0, 99], r));
ok("完全在右边 → 不可见", !inSpan([201, 300], r));

/* ================================================================== */
console.log("\n⑤ visibleClips：只挑视口内的，但 keep 的一律留着");

const clips = Array.from({ length: 200 }, (_, i) => ({
  id: `c${i}`, startSec: i * 5, durationSec: 5,
}));
const span1 = { fromPx: 0, toPx: 240 };   // 12px/s → 0~20s → c0..c4
check("200 个里只挑出视口内的 5 个",
  visibleClips(clips, 12, span1).map((c) => c.id),
  ["c0", "c1", "c2", "c3", "c4"]);
ok("挑出来的确实全部与区间相交",
  visibleClips(clips, 12, span1)
    .every((c) => inSpan(clipSpanPx(c.startSec, c.durationSec, 12), span1)));
// ⚠️ 陷阱 ③：拖动监听挂在 window 上，所以拖拽本身不会断——
// 卸载的表现是"片段凭空消失、松手又回来"，不报任何错。
check("正在拖的那个即使远在视口外也留着",
  visibleClips(clips, 12, span1, new Set(["c150"])).map((c) => c.id),
  ["c0", "c1", "c2", "c3", "c4", "c150"]);
check("keep 里的那个本来就在视口内 → 不会出现两次",
  visibleClips(clips, 12, span1, new Set(["c2"])).length, 5);
check("keep 里是个不存在的 id → 不凭空造元素",
  visibleClips(clips, 12, span1, new Set(["nope"])).length, 5);
check("keep 为 null（没在拖）", visibleClips(clips, 12, span1, null).length, 5);
check("空轨 → 空数组", visibleClips([], 12, span1).length, 0);
// 无序输入：字幕/音频轨的 clips 是按后端返回顺序 push 的，没有任何地方保证有序。
// 这正是不用二分的理由——二分在无序数组上不报错，只会随机少渲染。
const shuffled = [...clips].reverse();
check("输入无序（字幕/音频轨就是无序的）→ 结果集合仍然完整",
  visibleClips(shuffled, 12, span1).map((c) => c.id).sort(),
  ["c0", "c1", "c2", "c3", "c4"]);
ok("虚拟化确实在省事：1424 镜下渲染数远小于总数",
  visibleClips(Array.from({ length: 1424 }, (_, i) => ({
    id: `x${i}`, startSec: i * 5, durationSec: 5,
  })), 12, visibleSpan(bucketViewport(0, 1400), 68)).length < 120,
  "省不下来就说明区间算得太宽，虚拟化等于没做");

/* ================================================================== */
console.log("\n⑥ tickIndexRange：刻度尺也要虚拟化");

check("常规：从第 5 根到第 21 根（右端多给一根，标签是往右伸的）",
  tickIndexRange({ fromPx: 500, toPx: 2000 }, 100, 1000), [5, 22]);
check("左端为负（overscan 溢出）→ 从 0 开始，不是负下标",
  tickIndexRange({ fromPx: -700, toPx: 500 }, 100, 1000), [0, 7]);
check("右端超过总根数 → 夹到 count", tickIndexRange({ fromPx: 0, toPx: 1e9 }, 100, 30),
  [0, 30]);
check("整段都在视口左边（滚到很后面，而刻度只有 30 根）→ 空区间",
  tickIndexRange({ fromPx: 90000, toPx: 91000 }, 100, 30), [30, 30]);
check("stepPx 为 0（pxPerSec 还没算出来）→ 空区间，不是死循环/NaN",
  tickIndexRange({ fromPx: 0, toPx: 1000 }, 0, 100), [0, 0]);
check("一根都没有 → 空区间", tickIndexRange({ fromPx: 0, toPx: 1000 }, 100, 0), [0, 0]);
ok("区间永远非负且左 ≤ 右",
  [[-500, 200], [0, 1e9], [1e9, 2e9], [300, 300]]
    .every(([a, b]) => {
      const [i0, i1] = tickIndexRange({ fromPx: a, toPx: b }, 100, 50);
      return i0 >= 0 && i1 >= i0 && i1 <= 50;
    }));
// 7120 秒（1424 镜 × 5s）在最大缩放 60px/s 下 step=1s → 7121 根主刻度
ok("1424 镜项目在最大缩放下，刻度也从七千根降到几十根",
  (() => { const [a, b] = tickIndexRange(
    visibleSpan(bucketViewport(0, 1400), 68), 60, 7121); return b - a < 80; })(),
  "刻度尺不虚拟化的话，它和片段是同一个量级的问题");

/* ================================================================== */
console.log("\n⑦ 静态钉：接线没被绕过、且没把别的东西弄塌");

const tlx = read("src/features/timeline/Timeline.tsx");
const rlr = read("src/features/timeline/TimelineRuler.tsx");
const ast = read("src/features/assets/AssetTrack.tsx");
const vrt = read("src/features/timeline/virtual.ts");

ok("片段走 visibleClips 而不是直接 .map",
  /visibleClips\(track\.clips, pxPerSec, span, keepIds\)\.map\(/.test(tlx)
  && !/\{track\.clips\.map\(/.test(tlx));
// ⚠️ 这一条是"虚拟化把别的东西弄塌"里最要命的：3.3 的跟随滚动读的是
// el.scrollWidth，lane 一旦按可见内容收窄，滚动条和落点一起塌。
ok("lane 仍保持满宽 totalWidth（3.3 的跟随滚动读 scrollWidth）",
  /className=\{`fw-tl-lane\$\{dropHot[\s\S]{0,200}?style=\{\{ width: totalWidth \}\}/.test(tlx)
  && /fw-tl-lane fw-tl-lane-asset" style=\{\{ width: totalWidth \}\}/.test(tlx),
  "按可见内容收窄 lane = 滚动条长度错、播放头跟随落点错，且都不报错");
// keepIds 的两处（Set 内容 + useMemo 依赖）必须同时列全**每一种**拖动状态：
// 少列在 Set 里 → 拖那一种时片段消失；少列在依赖里 → keepIds 是上一次的陈值，
// 拖动开始的那一帧仍然把它剔掉。所以数**出现次数**，不是数是否出现过。
//
// 3.11 起是三种（`move` 移动 / `previewDur` 修剪 / `overlayDrag` 叠加层）。
// 原第四种 `previewOrder` 是顺序拖动的"假位置"，已随顺序拖动改指针 transform 而整个删除
// —— 位置不再进 React state，也就没有需要保活的片段。名字留在 `keepIds` 里会是在
// 保活一个没人读的 state，故这条钉也随之收窄。**新增拖动状态时必须回来加名字。**
ok("正在拖/修剪的片段进 keepIds（三种拖动状态，Set 与依赖两处都要列全）",
  (tlx.match(/\[move\?\.clipId, previewDur\?\.id, overlayDrag\?\.clipId\]/g)
    ?? []).length === 2,
  "漏列在 Set 里 → 拖那种片段时它整段消失；漏列在依赖里 → 拖动首帧仍按陈值把它剔掉");
ok("视口按桶量化后才进 state（不量化 = 每帧 setState，白省）",
  /bucketViewport\(el\?\.scrollLeft \?\? 0, el\?\.clientWidth \?\? 0\)/.test(tlx)
  && /sameViewport\(cur, next\) \? cur : next/.test(tlx));
ok("用 useLayoutEffect 量视口（useEffect 会让首帧按兜底宽度画一遍再改）",
  /useLayoutEffect\(syncVp\)/.test(tlx));
ok("监听 scroll 且 passive（scroll 里不会 preventDefault）",
  /addEventListener\("scroll", syncVp, \{ passive: true \}\)/.test(tlx)
  && /removeEventListener\("scroll", syncVp\)/.test(tlx));
ok("容器尺寸变化也重量（最大化/拖侧边栏不产生 window.resize）",
  /new ResizeObserver\(syncVp\)/.test(tlx) && /ro\?\.disconnect\(\)/.test(tlx));
ok("没有 ResizeObserver 的环境不崩（只是少一条触发源）",
  /typeof ResizeObserver !== "undefined"/.test(tlx));
ok("接缝标记也按可见过滤",
  /inSpan\(\s*pointSpanPx\(m\.atSec!, pxPerSec, SEAM_HALF_PX\), span\)/.test(tlx));
ok("刻度尺主/次刻度都走 tickIndexRange",
  (rlr.match(/tickIndexRange\(/g) ?? []).length === 2
  && !/Array\.from\(\{ length: count \}/.test(rlr));
// 虚拟化后数组下标随滚动而变，用下标当 key 会让每根刻度在滚动时重挂
ok("刻度的 key 用刻度序号而不是数组下标",
  /const i = t0 \+ k;/.test(rlr) && /key=\{i\}/.test(rlr) && !/\(_, i\) => \{\s*const sec = i \* step/.test(rlr));
ok("资产段也虚拟化，且拖边缘的那个例外",
  /edge\?\.runId !== run\.id\s*\n\s*&& !inSpan\(\[left, left \+ width\], p\.span\)\) return null;/.test(ast));

// ---- 命中判据没有被虚拟化影响 ----
// 这一组是"虚拟化最容易悄悄破坏的东西"：框选/Ctrl+A/Shift 范围一旦改成读 DOM，
// 视口外的片段就选不中了，而且用户完全看不出是为什么。
ok("框选命中读的是 store 数据，不是 DOM（否则视口外的选不中）",
  /rectIds\(useTimelineStore\.getState\(\)\.timeline\.tracks,/.test(tlx),
  "3.8 的 rectIds/rangeIds 全部基于数据；改成查 DOM 会让虚拟化静默吃掉选中范围");
ok("框选的纵向命中量的是 lane（lane 没被虚拟化，仍然全在 DOM 里）",
  /querySelectorAll<HTMLElement>\("\.fw-tl-lane\[data-track-id\]"\)/.test(tlx));

ok("virtual.ts 是纯模块：不 import React / store / DOM 类型",
  !/from "react"/.test(vrt) && !/stores\//.test(vrt) && !/document\./.test(vrt),
  "它要能被本脚本在 node 下直接跑");

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 虚拟化全部通过：视口按桶量化且完全覆盖真实视口；判可见用画出来的宽度；"
    + "拖动中的片段不会被卸载；lane 保持满宽、命中判据仍走数据"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
