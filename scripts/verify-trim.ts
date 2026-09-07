/**
 * verify-trim.ts — 修剪（trim）的数学与端到端口径（批次 3 / 3.2）
 *
 * ## 这个脚本要防的是"悄悄退回整数秒"
 *
 * 3.2 改的是一件很容易被"顺手改回去"的事：修剪的步进。
 * 整数秒不是精度问题，是**这个软件不能用来剪片** —— 一句台词说完在 2.4s，
 * 用户只能选 2s（切掉半个字）或 3s（留 0.6s 空镜）。
 *
 * 而它的**两端各有一个足以单独毁掉小数的地方**，且都不会报错：
 *
 *   ① 前端 `Timeline.tsx` 的 `Math.round(startSec + delta)`
 *   ② 后端 `patch_shot_timeline` 的 `round(float(body.duration_sec))`
 *
 * 只改一端的表现是**用户拖得动、松手弹回去**：拖到 2.4 显示 2.4，
 * 松手后刷新变成 2。这种"看起来像 bug 又像自己拖歪了"的现象，
 * 用户报不上来，我们也不会有任何测试变红。所以两端都在这里静态钉住。
 *
 * ③ 还有第三个入口：Inspector 的时长输入框。它 step=1 + Math.round 的话，
 *    时间轴拖到 2.4、一打开面板再失焦就被"整理"回 2 —— 两个入口互相打架。
 *
 * ## 3.1 追加：取片窗口（入点 / 出点）
 *
 * 3.1 让左边缘也能拖，于是「时长」不再只有一个来源：`duration_sec` 是轨上显示
 * 的长度（也是未出片时的生成目标），`clip_in_sec/clip_dur_sec` 才是导出与字幕
 * 真正消费的取片窗口。两者一旦分叉，用户看到的是**轨上 2.4s、成片里 5s**，
 * 而且全程没有任何报错。所以第 ④~⑦ 段钉的是三件事：
 *
 *   · 读的口径统一（谁算"有窗口"、没窗口时退回什么）
 *   · 不变式 `duration_sec == clip_dur_sec` 的三个维持者都还在
 *   · **换素材必须清窗口** —— 旧窗口的坐标是相对旧 video_url 的，
 *     不清就是 `-ss 2.4 -t 3` 取到空白，导出黑帧且零报错
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRIM_STEP_SEC, quantizeSec, round2, trimOut,
  MIN_WINDOW_SEC, hasClipWindow, inPointOf, windowDurOf, outPointOf,
  minTrimSec, trimIn, outPatch, inPatch, canTrimIn, clearWindowPatch,
} from "../src/features/timeline/trim";

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
console.log("\n① 量化：0.1s 步进，且不许漏出浮点尾巴");

check("步进就是 0.1s", TRIM_STEP_SEC, 0.1);
check("2.44 → 2.4", quantizeSec(2.44), 2.4);
check("2.45 → 2.5（半格向上）", quantizeSec(2.45), 2.5);
check("2.96 → 3（整秒也是合法落点）", quantizeSec(2.96), 3);
// 这是 `Math.round(x/0.1)*0.1` 的经典产物：2.9000000000000004。
// 它会原样出现在 tooltip、请求体、以及后端的 REAL 列里。
ok("2.9 附近不产生 2.9000000000000004",
   String(quantizeSec(2.87)) === "2.9",
   `实际 ${quantizeSec(2.87)}`);
ok("0.1 的整数倍全部干净（0.1~30 逐格扫）",
   Array.from({ length: 300 }, (_, i) => quantizeSec((i + 1) / 10))
     .every((v) => String(v).length <= 4),
   "出现了浮点尾巴");

console.log("\n  round2：固定边减移动边的减法结果");
// 分割留下的是 2 位小数（split_shot 存 round(x, 2)），减完会带尾巴
check("4.37 - 1.2 收敛到 3.17", round2(4.37 - 1.2), 3.17);
check("已是 2 位小数的值不变", round2(3.17), 3.17);

/* ================================================================== */
console.log("\n② trimOut（拖右边缘）：钳制与小数并存");

check("向右拖 1.35s：4 → 5.4（量化到 0.1）", trimOut(4, 1.35, 1, 15), 5.4);
check("向左拖：4 → 2.4（这是整数秒办不到的那个值）", trimOut(4, -1.6, 1, 15), 2.4);
check("下限 1s 钳住", trimOut(4, -99, 1, 15), 1);
check("上限按项目模型钳（15）", trimOut(4, 99, 1, 15), 15);
// 上限**不是常数 15**：seedance-2.5 是 30s。写死会让 28s 的长镜被随手砍一半。
check("上限 30 的项目能拖到 30", trimOut(4, 99, 1, 30), 30);
check("没动就是没动（0 位移原地不变）", trimOut(4.3, 0, 1, 15), 4.3);
// 存量数据可能是 2 位小数（分割产生），拖动后收敛到 0.1 格是预期的
check("2 位小数的起点拖一格 → 落在 0.1 格上", trimOut(4.37, 0.1, 1, 15), 4.5);

/* ================================================================== */
console.log("\n③ 三个入口都不许把小数抹掉（静态）");

const tl = read("src/features/timeline/Timeline.tsx");
ok("Timeline.tsx 的 trim 走 trimOut（不再自己 Math.round）",
   tl.includes("trimOut(startSec, delta"),
   "改回 Math.round(startSec + delta) 会让拖动只能落在整秒");
const trimFn = tl.match(/const beginTrim = useCallback[\s\S]*?\n  \}, \[/)?.[0] ?? "";
ok("beginTrim 被扫到", trimFn.length > 0);
ok("beginTrim 里没有 Math.round", !trimFn.includes("Math.round"),
   "整数量化必须只发生在 trim.ts 的 quantizeSec 里，否则两处口径会漂移");
ok("拖动读数按 0.1 显示（不然 2.4 会显示成 2.4000000000000004）",
   tl.includes("previewDur.sec.toFixed(1)"));

const py = read("../backend/app/routes_v2.py");
const patchFn = py.match(/def patch_shot_timeline[\s\S]*?\n\nclass /)?.[0] ?? "";
ok("patch_shot_timeline 被扫到", patchFn.length > 0);
ok("后端按 2 位小数落库（不是 round 到整数）",
   patchFn.includes("round(float(body.duration_sec), 2)"),
   "少了那个 `, 2` 就是整数秒：前端拖到 2.4、松手刷新变 2，"
   + "用户看到的是「我拖了它自己弹回去」，且没有任何测试会红");
ok("上限比较用 float(ceil) 而不是 int(ceil)",
   patchFn.includes("min(float(ceil)"),
   "int(ceil) 会把 30.5 这类上限截成 30；更要紧的是它暗示这一行仍是整数世界");

const cp = read("src/features/inspector/ClipProperties.tsx");
ok("Inspector 时长输入框 step 用 TRIM_STEP_SEC（与时间轴同源）",
   cp.includes("step={TRIM_STEP_SEC}"),
   "step=1 时用户在时间轴拖出的 2.4 会被这个面板一失焦就整理回 2");
ok("Inspector 提交前用 quantizeSec 而不是 Math.round",
   cp.includes("quantizeSec(durDraft)") || cp.includes("q1(durDraft)"));
// 文案已改成人话（「每 0.1 秒一档」），断言跟着改判据但守的是同一件事：
// 提示里必须出现 0.1 这个步长，否则用户以为只能填整秒。
ok("提示文案说清了 0.1 秒一档（否则用户以为只能整秒）",
   /0\.1\s*秒一档|0\.1s 步进/.test(cp));

const cv = read("src/features/timeline/ClipView.tsx");
ok("trim 手柄的提示不再写死「1-15s」",
   !cv.includes("1-15s"),
   "seedance-2.5 项目的上限是 30s，写死 15 是在骗用户");
ok("trim 手柄提示带上项目实际上限", cv.includes("p.maxDurSec"));

/* ================================================================== */
console.log("\n④ 取片窗口的读取口径（3.1）：什么叫「有窗口」");

// 判据必须是 clip_dur_sec：split 出来的头段存的就是 clip_in_sec=0，
// 拿 clip_in_sec 判会把它误判成"没被分割过"，于是拖右边缘只改 duration_sec，
// 导出仍按旧 clip_dur_sec 取片 —— 轨上变短了、成片纹丝不动。
ok("入点为 0 的头段也算有窗口",
   hasClipWindow({ clip_in_sec: 0, clip_dur_sec: 3, duration_sec: 3 }),
   "判据写成 clip_in_sec 就会漏掉 split 的头段");
ok("从没被分割过的镜头没有窗口",
   !hasClipWindow({ duration_sec: 5 }));
ok("clip_dur_sec=0 不算窗口（脏数据）",
   !hasClipWindow({ clip_in_sec: 1, clip_dur_sec: 0 }));

check("没窗口时窗口长度退回 duration_sec（与导出侧 `?? ` 同口径）",
      windowDurOf({ duration_sec: 5 }), 5);
check("有窗口时以 clip_dur_sec 为准", windowDurOf({ duration_sec: 9, clip_dur_sec: 2.4 }), 2.4);
check("没窗口时入点是 0", inPointOf({ duration_sec: 5 }), 0);
check("出点 = 入点 + 长度（浮点尾巴要收干净）",
      outPointOf({ clip_in_sec: 2.4, clip_dur_sec: 1.7 }), 4.1);

console.log("\n  最短时长：不能把「想剪短的东西」拉长");
check("常规镜头的下限是 MIN_CLIP_SEC(1)", minTrimSec({ duration_sec: 5 }, 1), 1);
// dev 库里真实存在 0.75 / 0.99 的窗口碎片（split 只保证每侧 0.5s）。
// 有窗口 → 下限 0.1，用户还能把它剪得更短；这里**不会**被拉长，
// 因为 0.1 本来就低于 0.75（Math.min 那一层在这条路径上是 no-op）。
check("0.75s 的窗口碎片仍可继续剪短到 0.1",
      minTrimSec({ clip_in_sec: 0, clip_dur_sec: 0.75 }, 1), 0.1);
// Math.min 真正兜的是**没有窗口**却短于 1s 的行：floor(1) > cur(0.75)，
// 直接返回 1 会把一个想剪短的镜头**拉长**到 1s —— 静默损坏。
check("没窗口但短于 1s 的行以自身为底，不被拉长",
      minTrimSec({ duration_sec: 0.75 }, 1), 0.75);
check("有窗口且够长时下限是 MIN_WINDOW_SEC(0.1)",
      minTrimSec({ clip_in_sec: 1, clip_dur_sec: 3 }, 1), MIN_WINDOW_SEC);
check("窗口下限就是 0.1s，不是 1s", MIN_WINDOW_SEC, 0.1);

/* ================================================================== */
console.log("\n⑤ trimIn（拖左边缘）：出点钉死，只有入点跟着鼠标");

// 这是"修剪入点"的定义。若两条边各自量化，固定边会在拖动中来回漂 0.05s，
// 用户看到的是"我拖左边，右边自己动了"。
const IN = (i: number, o: number, d: number, min = 0.1, max = 15) =>
  trimIn(i, o, d, min, max);
check("向右拖 1.2s：入点 0→1.2，时长 5→3.8", IN(0, 5, 1.2), { inSec: 1.2, durSec: 3.8 });
check("向左拖回去：入点 2.4→0.4，时长跟着变长", IN(2.4, 5, -2), { inSec: 0.4, durSec: 4.6 });
check("入点不能为负（素材开头之前没有内容）", IN(0, 5, -99), { inSec: 0, durSec: 5 });
check("不能把窗口掐成 0（留住 minSec）", IN(0, 5, 99, 0.1), { inSec: 4.9, durSec: 0.1 });
check("窗口不能超过单镜上限（入点被 out-max 顶住）",
      IN(20, 25, -99, 0.1, 15), { inSec: 10, durSec: 15 });
// 出点是 split 留下的 2 位小数时，相减必然带浮点尾巴（4.37-1.2=3.1700000000000004）
ok("2 位小数的出点相减不漏浮点尾巴",
   String(IN(0, 4.37, 1.2).durSec) === "3.17",
   `实际 ${IN(0, 4.37, 1.2).durSec}`);
{
  // 全程扫一遍：出点必须**逐点**恒定，不是只有首尾对
  const drifted = Array.from({ length: 40 }, (_, i) => IN(0.7, 4.37, i * 0.13))
    .filter((r) => Math.abs(round2(r.inSec + r.durSec) - 4.37) > 1e-9);
  ok("拖动全程出点恒为 4.37（40 个采样点）", drifted.length === 0,
     `有 ${drifted.length} 个点漂了：${JSON.stringify(drifted.slice(0, 3))}`);
}

/* ================================================================== */
console.log("\n⑥ patch 载荷：什么时候写窗口、什么时候只写时长");

// 没窗口的镜头，duration_sec 同时是**生成目标**（provider 拿它要时长）。
// 给未出片的镜头写 clip_dur_sec = 宣称"在不存在的素材上取片"。
check("没窗口 → 只写 durationSec", outPatch({ duration_sec: 5 }, 3), { durationSec: 3 });
check("有窗口 → 时长与窗口一起写（否则导出不跟着变）",
      outPatch({ clip_in_sec: 1, clip_dur_sec: 4 }, 2.4),
      { durationSec: 2.4, clipDurSec: 2.4 });
check("inPatch 三个字段一起发，维持 duration==clip_dur",
      inPatch(1.2, 3.8), { durationSec: 3.8, clipInSec: 1.2, clipDurSec: 3.8 });
check("clearWindowPatch 只发清除标记（长度交给后端保持）",
      clearWindowPatch(), { clearClipWindow: true });
ok("inPatch 产出的 duration 与 clipDur 恒等",
   [[0, 2.4], [1.25, 0.75], [3.3, 12.05]].every(([i, d]) => {
     const q = inPatch(i, d);
     return q.durationSec === q.clipDurSec;
   }));

console.log("\n  canTrimIn：未出片的镜头不许设入点");
ok("有素材 → 可修剪入点", canTrimIn({ video_url: "/media/a.mp4" }));
ok("未出片 → 不可", !canTrimIn({ video_url: null }));
ok("空白串也算未出片", !canTrimIn({ video_url: "   " }));

/* ================================================================== */
console.log("\n⑦ 不变式与清窗口（静态）：这几处漏一个就是静默损坏");

ok("后端窗口分支回写 duration_sec（不变式的第三个维持者）",
   patchFn.includes("shot.duration_sec = shot.clip_dur_sec"),
   "少了这一行 → 时间轴按 duration_sec 排版、导出按 clip_dur_sec 取片，"
   + "「轨上 2.4s、成片里 5s」，且没有任何提示");
ok("窗口下限是 0.1 而不是 1.0",
   patchFn.includes("max(0.1, min(float(ceil2)"),
   "写成 1.0 会把 0.75s 的碎片**拉长**成 1.0s —— 用户想剪短，结果变长了");
ok("窗口段排在 duration_sec 钳制之后",
   patchFn.indexOf("round(float(body.duration_sec), 2)")
     < patchFn.indexOf("shot.duration_sec = shot.clip_dur_sec"),
   "顺序颠倒的话，回写的不变式会被 duration_sec 分支再盖掉");
ok("半个窗口（只有入点、没有长度）会被补齐",
   patchFn.includes("shot.clip_in_sec is not None and shot.clip_dur_sec is None"),
   "只设 clip_in_sec 会让导出按 -ss 入点 + -t duration_sec 取片（比用户看到的长），"
   + "而前端判「有没有窗口」看 clip_dur_sec，会认为这镜没被修剪过");
ok("PATCH 响应带回 clip_in_sec / clip_dur_sec",
   patchFn.includes("\"clip_in_sec\"") && patchFn.includes("\"clip_dur_sec\""),
   "连续拖左边缘时前端要从服务端的入点续算，不回传就只能拿本地猜的值");

// 窗口坐标是**相对当前 video_url** 的。换了素材还留着旧窗口 →
// `-ss 2.4 -t 3` 取到的是另一段内容甚至空白，导出黑帧且无任何报错。
// 三个安装点：生成落回、切版本、dev 手动出片。漏一个就是一类静默损坏。
{
  const backend = ["../backend/app/jobs.py", "../backend/app/routes_v2.py"]
    .map((f) => read(f)).join("\n");
  const sites = backend.split("\n")
    .map((l, i) => ({ l, i }))
    .filter((x) => /\.video_url = /.test(x.l));
  const lines = backend.split("\n");
  check("shot.video_url 的安装点共 3 处（新增了要一并接上清窗口）", sites.length, 3);
  const missed = sites.filter(
    (x) => !lines.slice(x.i, x.i + 6).some((l) => l.includes("reset_clip_window")));
  ok("每个安装点后面都跟着 reset_clip_window", missed.length === 0,
     missed.map((x) => `第 ${x.i + 1} 行附近：${x.l.trim()}`).join(" / ")
     + " —— 不清窗口 = 导出静默黑帧");
}
const dbpy = read("../backend/app/db.py");
ok("reset_clip_window 只清窗口、不动 duration_sec",
   /def reset_clip_window[\s\S]*?return had/.test(dbpy)
   && !/def reset_clip_window[\s\S]*?shot\.duration_sec/.test(dbpy),
   "顺手清掉 duration_sec 会让镜头在时间轴上塌成 0 宽");
ok("切版本把「窗口已重置」回传前端（不能悄悄丢用户的修剪）",
   py.includes("clip_window_cleared"));

console.log("\n  前端：口径与门禁");
const adp = read("src/adapters/shotToClip.ts");
ok("shotDuration 优先取 clip_dur_sec（与导出/字幕同口径）",
   /clip_dur_sec != null && s\.clip_dur_sec > 0\) return s\.clip_dur_sec/.test(adp),
   "只读 duration_sec 的话，split 过的镜头在轨上的宽度与成片长度对不上");
ok("时间轴左手柄对未出片的镜头不渲染",
   cv.includes("canTrimIn({ video_url: c.mediaUrl"),
   "未出片的镜头没有「素材开头」可言，给它设入点只会让 duration_sec 不再是生成目标");
ok("修剪过的镜头在轨上有可见标记（否则用户不知道自己剪过）",
   cv.includes("fw-clip-badge cut"));
ok("Timeline 拖左边缘走 trimIn + inPatch",
   tl.includes("trimIn(startIn, outSec, delta") && tl.includes("inPatch(latest.inSec"));
ok("拖左边缘时出点变量全程不参与再计算",
   /const outSec = outPointOf\(win\);/.test(tl),
   "出点一旦在 onMove 里重算，就会跟着量化误差漂");

const app = read("src/App.tsx");
ok("窗口改动只入**一条** undo（不是 durationSec + window 两条）",
   app.includes("if (!windowTouched"),
   "两条的话 Ctrl+Z 要按两下，且中间那一下会停在「新入点 + 旧时长」的错状态");
ok("旧行没窗口时，撤销是清窗口而不是写 in=0",
   /clearClipWindow: true,\s*\n\s*\.\.\.\(prevShown/.test(app),
   "写 in=0 会留下一个假窗口，使这一镜从此走「有窗口」分支，语义与撤销前不同");

const pl = read("src/features/editor/Player.tsx");
ok("预览器按窗口停（修剪掉的尾巴不该还能播出来）",
   pl.includes("v.currentTime >= w.inSec + w.durSec"));
ok("到点复用 onEnded（否则修剪过的镜头会成为连播的终点）",
   /endedFired\.current = true;[\s\S]{0,80}p\.onEnded\(\)/.test(pl));
ok("<video> 的 key={previewUrl} 仍在（§0.5(g)：去掉会导致换源不重载）",
   pl.includes("key={p.previewUrl}"));

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 修剪全部通过：小数落得下去、两端都不会把它抹回整秒；"
    + "窗口的不变式与清理点齐全"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
