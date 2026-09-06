/**
 * verify-playhead.ts — 播放头导航 / J-K-L / 跟随滚动（批次 3 / 3.3）
 *
 * ## 这个脚本要防的是"播放头又变回 `<video>` 的属性"
 *
 * 3.3 之前，播放头不是一个时间轴概念，而是 `video.currentTime` 的投影：
 *
 *     nudgeLeft: (big) => { const v = videoRef.current;
 *                           if (v) v.currentTime = Math.max(0, v.currentTime - step); }
 *
 * 这一行有四个**都不报错**的失效，逐条核实过（路线图只写了其中第 ① 个，
 * 且措辞是"暂停时无反应"——按规范 seek 会触发 timeupdate，
 * 所以只要有预览源，暂停时其实是有反应的。真正的失效是这四条）：
 *
 *   ① 没有预览源时是**死键**：`<video>` 只在 previewUrl 非空时渲染，
 *      刚打开项目、或正在看素材/成片时 `videoRef.current` 是 null，
 *      按方向键静默无事发生。
 *   ② **跨不过镜头边界**：一镜播到头 currentTime 顶住不动，
 *      200 个镜头的片子，方向键只能在当前这一个里爬。
 *   ③ **会走进 3.1 剪掉的素材里**：入点修剪过的镜头，currentTime 减到 inSec
 *      以下就是用户已剪掉的画面，而 toShotTime 把它钳成 0 ——
 *      表现为**画面在动、播放头不动**。
 *   ④ **步长 1/30 是猜的帧率**，与 3.2 的 0.1s 修剪格不对齐，
 *      用户永远没法把播放头正好放在能下刀的位置上。
 *
 * 修法是把因果倒过来：播放头首先是时间轴上的绝对秒，其次才驱动 `<video>`。
 * 这个方向**极易被"顺手改回去"**（下次谁想让方向键更跟手，第一反应就是
 * 直接写 currentTime），所以下面第 ⑥ 段静态钉住"App 里不许再出现
 * `v.currentTime -= / +=` 式的播放头位移"。
 *
 * ## 另外三件不钉住就会悄悄坏的事
 *
 *   · **绝对秒不许再有第四套累加算法。** `adapters/shotToClip.ts` 的长注释
 *     记着：这条时间轴上曾同时存在三套，"线画在一处、跳到的是另一处"。
 *     `buildEdgeSecs` 必须由 `buildOrderOffsetMap` 派生。
 *   · **`playbackRate` 只许有一个写入点。** 快进倍速要与本镜变速在
 *     `Player.tsx` 那一个 effect 里相乘；App 里再写一次的话，表现是
 *     "改了变速之后快进失效"（谁最后 render 谁说了算），无法从现象反推。
 *   · **快退不能走 playbackRate。** 浏览器不支持负速率，赋负值要么被忽略
 *     要么卡住——必须是定时回退。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NUDGE_STEP_SEC, NUDGE_BIG_SEC, SHUTTLE_MAX, REVERSE_TICK_MS,
  FOLLOW_SUSPEND_MS, nudgeSec, clampSec, edgeSec, nextShuttle, followScroll,
} from "../src/features/timeline/playhead";
import { TRIM_STEP_SEC } from "../src/features/timeline/trim";
import { buildEdgeSecs } from "../src/adapters/shotToClip";
import type { ShotInfo } from "../src/api";

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
console.log("\n① 步进与修剪同格（④ 号失效：1/30 秒的猜测帧率）");

check("播放头步长 = 修剪步长（两者必须同格，否则「看到哪儿就切到哪儿」不成立）",
  NUDGE_STEP_SEC, TRIM_STEP_SEC);
ok("步长不是 1/30 这类猜出来的帧率",
  Math.abs(NUDGE_STEP_SEC - 1 / 30) > 1e-9,
  "<video> 不暴露帧率，写 1/30 是假精度");
check("Shift 大步长 = 1s", NUDGE_BIG_SEC, 1);

// 「吸到格上再走一格」：从格间出发，第一下就要落到格上
check("2.37 → 右 → 2.4（吸到格上，不是 2.47）",
  nudgeSec(2.37, 1, NUDGE_STEP_SEC, 100), 2.4);
check("2.37 → 左 → 2.3", nudgeSec(2.37, -1, NUDGE_STEP_SEC, 100), 2.3);
// 已经在格上时必须真的走一格（浮点尾巴不能让它原地不动）
check("2.4 → 右 → 2.5（已在格上，仍走满一格）",
  nudgeSec(2.4, 1, NUDGE_STEP_SEC, 100), 2.5);
check("2.4 → 左 → 2.3", nudgeSec(2.4, -1, NUDGE_STEP_SEC, 100), 2.3);
// 0.1×3 = 0.30000000000000004 这类：多走几步不许攒出浮点尾巴
check("连走 3 格不攒浮点误差",
  nudgeSec(nudgeSec(nudgeSec(0, 1, 0.1, 100), 1, 0.1, 100), 1, 0.1, 100), 0.3);
check("大步长同样吸格：2.37 → Shift+右 → 3",
  nudgeSec(2.37, 1, NUDGE_BIG_SEC, 100), 3);
check("到片头夹住（不会变负）", nudgeSec(0.05, -1, NUDGE_STEP_SEC, 100), 0);
check("到片尾夹住（不会越过 maxSec）", nudgeSec(9.98, 1, NUDGE_STEP_SEC, 10), 10);

check("空项目（maxSec=0）一律回 0", clampSec(5, 0), 0);
check("maxSec 为负（脏数据）也回 0，不抛", clampSec(5, -3), 0);
check("clampSec 顺带两位量化", clampSec(2.4000000000000004, 10), 2.4);

/* ================================================================== */
console.log("\n② 边界跳转（↑ / ↓ / Home / End）");

const edges = [0, 3, 5.5, 12];
check("片中向右 → 下一个边界", edgeSec(edges, 4, 1), 5.5);
check("片中向左 → 上一个边界", edgeSec(edges, 4, -1), 3);
check("正好站在边界上，向右走到**下一个**（不是原地）", edgeSec(edges, 3, 1), 5.5);
check("正好站在边界上，向左退到**上一个**（不是原地）", edgeSec(edges, 3, -1), 0);
check("片头再往左 → 停在 0", edgeSec(edges, 0, -1), 0);
check("片尾再往右 → 停在末尾", edgeSec(edges, 12, 1), 12);
check("从 0.3 向左 → 回到 0（而不是「已经是第一段了」原地不动）",
  edgeSec(edges, 0.3, -1), 0);
check("空边界表不抛，回 0", edgeSec([], 5, 1), 0);
// 浮点：3.0000000000000004 站在 3 上，不该被当成「在 3 右边」而跳回 3
check("边界上的浮点尾巴不会导致往左跳回同一个边界",
  edgeSec(edges, 3.0000000000000004, -1), 0);

/* ================================================================== */
console.log("\n③ buildEdgeSecs 与画线同源（不许出现第四套累加算法）");

const S = (o: number, x: Partial<ShotInfo> = {}): ShotInfo => ({
  id: `s${o}`, order: o, episode: 1, characters: [], script_ref: "",
  status: "done", refs_stale: false, disabled: false, is_special: false,
  duration_sec: 5, video_url: `v${o}.mp4`, ...x,
} as ShotInfo);

check("三镜各 5s → 边界 0/5/10/15",
  buildEdgeSecs([S(1), S(2), S(3)]), [0, 5, 10, 15]);
// 停用镜头在 map 里占位但不推进时间轴。**把它放在最后一位**才测得准：
// 放中间的话，后一个镜头会把 end 算回同一个值，漏掉的边界又被去重吃掉，
// 于是删掉 disabled 判断这个脚本也照样绿（试过，确实不变红）。
check("停用镜头不占时间、不产生边界",
  buildEdgeSecs([S(1), S(2), S(3, { disabled: true })]), [0, 5, 10]);
check("停用镜头在中间时，后面的镜头不被它推开",
  buildEdgeSecs([S(1), S(2, { disabled: true }), S(3)]), [0, 5, 10]);
// 叠加层由 overlay_start_sec 定位，不参与主轨顺序累加。
// 这一条要测出守卫**在不在**，得让叠加层落在最后一位且时长与主轨不同：
// `buildOrderOffsetMap` 本身也跳过叠加层，所以叠加层拿到的 start 是同号主轨镜头的
// —— 只有末尾边界（start + 自己的时长）会暴露差异。时长相同的话删掉守卫也照样绿。
check("叠加层不参与主轨边界（末尾也不许被它撑长）",
  buildEdgeSecs([S(1), S(2), S(2, { id: "ov", track_index: 1, duration_sec: 20, clip_dur_sec: 20 })]),
  [0, 5, 10]);
// 3.1：轨上长度取窗口长度（与导出 `clip_dur_sec ?? duration_sec` 同口径）
check("有取片窗口时按窗口长度算边界",
  buildEdgeSecs([S(1, { clip_in_sec: 1, clip_dur_sec: 2, duration_sec: 2 }), S(2)]),
  [0, 2, 7]);
check("空项目回 [0]（End 不会跳到 undefined）", buildEdgeSecs([]), [0]);
// 边界按 2 位小数去重：亚毫秒级的脏数据行会算出同一个边界，
// 不去重的话 ↑/↓ 要按好几下才「动一格」
check("重合边界去重",
  buildEdgeSecs([
    S(1, { duration_sec: 0.001, clip_dur_sec: 0.001 }),
    S(2, { duration_sec: 0.001, clip_dur_sec: 0.001 }),
  ]), [0]);

const adapter = read("src/adapters/shotToClip.ts");
ok("buildEdgeSecs 由 buildOrderOffsetMap 派生，而不是自己再累加一遍",
  /export function buildEdgeSecs[\s\S]{0,200}buildOrderOffsetMap\(shots\)/.test(adapter),
  "这条时间轴上曾同时存在三套累加算法，线画在一处、跳到的是另一处");

/* ================================================================== */
console.log("\n④ J-K-L 倍速语义");

check("停 → 按 L → 1×", nextShuttle(0, 1), 1);
check("停 → 按 J → -1×", nextShuttle(0, -1), -1);
check("1× → 按 L → 2×（同向连按加倍）", nextShuttle(1, 1), 2);
check("2× → L → 4×", nextShuttle(2, 1), 4);
check("封顶不再涨", nextShuttle(SHUTTLE_MAX, 1), SHUTTLE_MAX);
check("快退同样加倍且封顶", nextShuttle(-2, -1), -4);
check("4× 快进时按 J → **先停**（不是立刻 4× 倒冲）", nextShuttle(4, -1), 0);
check("快退中按 L → 先停", nextShuttle(-4, 1), 0);
ok("上限 4：实际速率是「本镜变速 × 快进倍速」，2× 变速下 L 到顶已是 8×",
  SHUTTLE_MAX === 4);

/* ================================================================== */
console.log("\n⑤ 跟随滚动");

const V = (x: Partial<Parameters<typeof followScroll>[0]>) => followScroll({
  playLeftPx: 500, scrollLeft: 0, viewWidthPx: 1000,
  contentWidthPx: 5000, gutterPx: 68, ...x,
});
ok("舒适区内不滚（否则每次 timeupdate 都把用户拽回来）", V({}) === null);
ok("播放头跑到右边缘外 → 要滚", V({ playLeftPx: 1400 }) !== null);
ok("播放头在左侧（用户往后滚过头）→ 要滚",
  V({ playLeftPx: 100, scrollLeft: 900 }) !== null);
ok("落点偏左（留前瞻），不是居中",
  (V({ playLeftPx: 1400 }) ?? 0) > 1400 - 68 - (1000 - 68) / 2,
  "居中意味着每半屏就要滚一次");
// 精确钉住落点：gutter 在**两处**参与计算（可视宽度扣掉它、落点再减掉它），
// 少减任何一处都会让播放头停在与设计不同的位置，而"大致偏左"的宽松断言
// 两种错法都测不出来。inner = 1000-68 = 932，落点 = 1400-68-932×0.25 = 1099。
check("滚动落点精确到像素（gutter 在可视宽度与落点两处都要扣）",
  V({ playLeftPx: 1400 }), 1400 - 68 - (1000 - 68) * 0.25);
ok("不会滚成负数", (V({ playLeftPx: 80, scrollLeft: 400 }) ?? 0) >= 0);
ok("不会超过 maxScroll",
  (V({ playLeftPx: 4900, scrollLeft: 3000 }) ?? 0) <= 5000 - 1000);
ok("已经滚到底时返回 null（否则每帧写 scrollLeft，打断平滑滚动）",
  V({ playLeftPx: 4990, scrollLeft: 4000, contentWidthPx: 5000 }) === null);
ok("容器还没测量出宽度（clientWidth=0）时不滚，也不抛",
  V({ viewWidthPx: 0 }) === null);
// 轨道头是 sticky 的，永远盖住可视区最左边那 68px；不减掉它的话，
// 播放头「露出来了」其实是藏在轨道头底下。
// 取 playLeft=1060、scrollLeft=920：轨道头为 0 宽时它落在舒适区内（不该滚），
// 而真实的 68px 轨道头把舒适区整体右推，同一个点就变成贴着轨道头（必须滚）。
ok("轨道头宽度参与计算（藏在 gutter 底下不算「看得见」）",
  V({ playLeftPx: 1060, scrollLeft: 920, gutterPx: 68 }) !== null);
ok("同一位置若轨道头为 0 宽则确实在舒适区内（反证上一条量的是 gutter）",
  V({ playLeftPx: 1060, scrollLeft: 920, gutterPx: 0 }) === null);

const tl = read("src/features/timeline/Timeline.tsx");
ok("跟随用的 playLeftPx 与画线是同一个表达式",
  /playLeftPx: GUTTER_W \+ store\.playheadSec \* pxPerSec/.test(tl),
  "两处各算一遍迟早漂成「线在这儿、滚到那儿」");
ok("用户手动滚轮后暂停跟随",
  tl.includes("followSuspendUntil") && tl.includes("FOLLOW_SUSPEND_MS"),
  "没有它则播放时不能往后翻一眼");
ok("Ctrl+滚轮（缩放）不算手动滚动",
  /if \(e\.ctrlKey \|\| e\.metaKey\) return;\s*\n\s*followSuspendUntil/.test(tl),
  "缩放自己会重设 scrollLeft，当成手动滚会让播放头迟迟不回视野");
ok("暂停时长 2.5s（够翻一眼，又不至于像坏了）", FOLLOW_SUSPEND_MS === 2500);

/* ================================================================== */
console.log("\n⑥ 播放头是时间轴概念，不是 <video> 的属性（① ② ③ 号失效）");

const app = read("src/App.tsx");
ok("方向键走 movePlayheadTo，不再直接写 currentTime",
  /nudgeLeft: \(big\) => jumpPlayhead\(nudgeSec\(/.test(app)
  && /nudgeRight: \(big\) => jumpPlayhead\(nudgeSec\(/.test(app));
ok("App 里不再有「currentTime ± 步长」式的播放头位移",
  !/currentTime\s*=\s*(Math\.max\(0,\s*)?v\.currentTime\s*[-+]/.test(app),
  "这是 3.3 之前的写法，改回去会一次性复活全部四个失效");
ok("movePlayheadTo 先写 store 再驱动播放器（因果方向）",
  /const at = clampSec\(sec, playRange\(\)\.maxSec\);\s*\n\s*tlStore\(\)\.setPlayheadSec\(at\);/.test(app),
  "反过来的话没有预览源时就是死键（① 号失效）");
ok("落在未生成的镜头上时 setPlayhead(null)",
  /if \(!shot\?\.video_url\) \{[\s\S]{0,400}setPlayhead\(null\);/.test(app),
  "不置空的话，Timeline 那条 p.playhead→setPlayheadSec 的 effect "
  + "会在下次 detail 刷新时拿播放器的旧位置把线拽回去");
ok("同镜 seek 经 toMediaTime（③ 号失效：不许走进剪掉的素材里）",
  /v\.currentTime = toMediaTime\(pos!\.offsetSec\);/.test(app));
ok("跨镜落点由 secToPosition 反解（② 号失效：方向键要能跨镜头）",
  /const pos = secToPosition\(all, at\);/.test(app));

/* ================================================================== */
console.log("\n⑦ 跨镜移动播放头不许自动播放");

const player = read("src/features/editor/Player.tsx");
ok("<video> 仍带 autoPlay（换源自动播是既有行为，本条只是提醒它存在）",
  player.includes("autoPlay"));
const up = read("src/hooks/usePlayer.ts");
ok("seekTo 支持 pause 选项",
  /seekTo = \(s: ShotInfo, offsetSec: number, opts\?: \{ pause\?: boolean \}\)/.test(up));
ok("暂停意图由 loadedmetadata 消费，不是 setTimeout 赌加载耗时",
  app.includes("if (pendingPause.current)") && !/setTimeout\(\(\) => videoRef\.current\?\.pause\(\), \d+\)/.test(app),
  "赌早了 pause 跑在 autoplay 之前无效；赌晚了会打断用户这期间按空格的播放");
ok("挪播放头跨镜时传 pause:true",
  /seekTo\(shot, pos!\.offsetSec, \{ pause: true \}\)/.test(app));
ok("换预览源（看素材/成片/别的版本）会清掉遗留的暂停意图",
  (up.match(/pendingPause\.current = false;/g) ?? []).length >= 3,
  "不清的话，上一次挪播放头的暂停会殃及用户主动点开的下一个预览");

/* ================================================================== */
console.log("\n⑧ playbackRate 只有一个写入点");

ok("快进倍速在 Player 的 playbackRate effect 里与本镜变速相乘",
  /v\.playbackRate = Math\.min\(16, speed \* shuttleRate\)/.test(player));
ok("App 里不写 playbackRate",
  !/playbackRate\s*=/.test(app),
  "两处写同一属性必然打架，表现为「改了变速之后快进失效」，无法从现象反推");
ok("effect 依赖里有 shuttleRate（否则按 L 要等下次重渲才变速）",
  /\}, \[speed, shuttleRate, p\.previewUrl, p\.videoRef\]\)/.test(player));
ok("只取正倍速进 playbackRate（快退是负的，另走定时器）",
  /const shuttleRate = Math\.max\(1, p\.shuttleRate \?\? 1\);/.test(player));
ok("倍速有可见徽标（4× 时画面本身看不出是几倍速）",
  /p\.shuttleRate! < 0 \? "◀◀ " : "▶▶ "/.test(player));

/* ================================================================== */
console.log("\n⑨ 快退不走 playbackRate（浏览器不支持负速率）");

ok("快退用定时器回退播放头",
  /revTimer\.current = window\.setInterval\(/.test(app));
ok("回退经 movePlayheadTo（才能跨镜、才不会退进剪掉的素材）",
  /moveRef\.current\(cur - rate \* \(REVERSE_TICK_MS \/ 1000\)\)/.test(app));
ok("定时器读的是最新的 movePlayheadTo（闭包了 detail，不能钉死在首次渲染）",
  app.includes("moveRef.current = movePlayheadTo"),
  "钉死的话，倒退这几秒里来一次 refreshDetail，之后每跳都按旧时间轴算");
ok("退到片头自动停", /if \(cur <= 0\) \{ clearShuttle\(\); return; \}/.test(app));
ok("卸载时清定时器（否则切项目后它还在往 store 写播放头）",
  app.includes("useEffect(() => stopRevTimer, [])"));
ok("切项目清 shuttle 状态", /clearShuttle\(\);\s*\/\/ 3\.3/.test(app));
ok("空格接管播放时退出 shuttle（否则 4× 快进后按空格仍以 4× 播，无处调回）",
  /const playFromCursor = \(\) => \{[\s\S]{0,300}clearShuttle\(\);/.test(app));
ok("手动跳转（方向键/Home/End/↑↓）先停 shuttle",
  /const jumpPlayhead = \(sec: number\) => \{ stopShuttle\(\); movePlayheadTo\(sec\); \};/.test(app));
ok("回退间隔 50ms（20Hz：再密是给解码器发跟不上的反向 seek 风暴）",
  REVERSE_TICK_MS === 50);
ok("连按加速读 ref 而不是 state",
  /const next = nextShuttle\(shuttleRef\.current, dir\);/.test(app),
  "同一帧内连按两下 J，读 state 会拿到旧值，「连按加速」变成「按几次都是 1×」");

/* ================================================================== */
console.log("\n⑩ I / O 与拖边缘同一条通路");

ok("I 复用 3.1 的 trimIn + inPatch",
  /const r = trimIn\(curIn, outPointOf\(shot\), offsetSec,/.test(app)
  && /patchTimeline\(shot\.id, inPatch\(r\.inSec, r\.durSec\)\)/.test(app),
  "另写一套的话，键盘剪出来的窗口与鼠标剪出来的会不一致");
ok("O 复用 trimOut + outPatch",
  /const next = trimOut\(curDur, offsetSec - curDur, minSec, maxSec\);/.test(app)
  && /patchTimeline\(shot\.id, outPatch\(shot, next\)\)/.test(app));
ok("I 先查 canTrimIn（未出片的镜头没有「素材开头」可言）",
  /if \(!canTrimIn\(shot\)\) \{/.test(app));
ok("上限取服务端 shot_duration_max，兜底才用常量",
  (app.match(/detail\?\.shot_duration_max \?\? MAX_CLIP_SEC_FALLBACK/g) ?? []).length >= 2,
  "写死 15 会把 seedance-2.5 的 28s 长镜砍半");
ok("O 在播放头贴着镜头起点时明确拒绝，而不是静默钳到最短时长",
  /不足最短时长/.test(app),
  "静默钳制 = 按一下 O 把这一镜砍成 1 秒");
ok("落点不在任何镜头上时有提示，不是静默无事发生",
  app.includes("把播放头放到某个镜头上再按 I")
  && app.includes("把播放头放到某个镜头上再按 O"));

const trim = read("src/features/timeline/trim.ts");
ok("MIN_CLIP_SEC / MAX_CLIP_SEC_FALLBACK 收敛到 trim.ts（键盘与拖动共用）",
  /export const MIN_CLIP_SEC = 1;/.test(trim)
  && /export const MAX_CLIP_SEC_FALLBACK = 15;/.test(trim));
ok("Timeline.tsx 不再自己声明这两个常量",
  !/^const MIN_CLIP_SEC/m.test(tl) && !/^const MAX_CLIP_SEC_FALLBACK/m.test(tl),
  "各写一份必然漂成「拖能拖到 1s、按 O 能按到 0.5s」");

/* ================================================================== */
console.log("\n⑪ 快捷键注册齐全且不与已有单键冲突");

const cmds = read("src/commands/index.ts");
for (const [id, key] of [
  ["playhead.prevEdge", "ArrowUp"], ["playhead.nextEdge", "ArrowDown"],
  ["playhead.home", "Home"], ["playhead.end", "End"],
  ["shuttle.reverse", "j"], ["shuttle.stop", "k"], ["shuttle.forward", "l"],
  ["trim.setIn", "i"], ["trim.setOut", "o"],
] as const) {
  ok(`已注册 ${id}（${key}）`, cmds.includes(`id: "${id}"`));
}
// 单键命令必须排除 Ctrl/Cmd，否则会抢走 Ctrl+O 这类系统/浏览器组合键
for (const k of ["j", "k", "l", "i", "o"]) {
  ok(`${k.toUpperCase()} 排除了 Ctrl/Cmd 与 Shift`,
    new RegExp(`e\\.key\\.toLowerCase\\(\\) === "${k}" && !mod\\(e\\) && !e\\.shiftKey`)
      .test(cmds));
}
ok("listCommandKeys 的 dummy 覆盖了新 handler（否则设置页的快捷键表会漏）",
  /playheadToStart: noop[\s\S]{0,200}setOut: noop/.test(cmds));

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 播放头全部通过：它是时间轴上的绝对秒（不是 <video> 属性），"
    + "跨得过镜头、落在 0.1s 格上、不走进剪掉的素材；"
    + "J-K-L 单点写 playbackRate，快退走定时器；跟随滚动不与用户抢方向盘"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
