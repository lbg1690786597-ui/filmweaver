/**
 * verify-local-first.ts — 3.13「一切操作留在本地」的**静态守卫**
 *
 * ## 为什么需要这个脚本
 *
 * 用户报的三个现象（点一下缩到最短 / 每次调整闪一下才落位 / 拖得越长越偏）
 * 有同一个根：资产轨上的调整**每一次都同步服务器**，画面要等服务端回来
 * 才知道自己该长什么样。3.13 把这条链改成本地台账先行，代价是"这条链上
 * 任何一个人手滑写回 `await api.xxx()`，症状会**原样复发**，而且看起来
 * 只是"有点卡"，不会报错 —— 正是那种在 code review 里最容易被放过的回归。
 *
 * 所以这里用源码扫描把**不变量**钉死：
 *
 *   ① 资产轨 / 注入 / 拖放的交互层**不许直接调 `api.`**。
 *      调整 = 往本地台账记一条，落库只走 `assetOverrideStore`。
 *   ② 台账的写入路径（`record`）**不许排任何定时器**。
 *      3.12 的 600ms 尾防抖就是"闪一下"的来源（请求回来 → 底座变了 → 重画）。
 *   ③ `pagehide` / `visibilitychange` 的兜底必须**先判有没有未落库改动**。
 *      无条件 flush 等于每次关窗口都打一次后端，与"留在本地"直接矛盾。
 *   ④ 需要服务端能力的入口（生成 / 导出）**必须**先 flush。
 *      这一条是③的反面，也是最容易漏的一条：漏了，用户就会看到
 *      "我明明把角色 A 拖到了这一镜，生成出来的画面里却没有 A"。
 *
 * ⚠️ 与 `verify-refresh-sites.ts` 同一个立场：**守卫现状**，不是证明现状最优。
 * 真要在这条链上加一个服务端调用，**先改这里并写下理由**，别只改一头。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) { pass++; console.log(`   ✅ ${label}`); }
  else { fail++; console.log(`   ❌ ${label}${detail ? `  — ${detail}` : ""}`); }
}

/** 读源码并剥掉注释行 —— 注释里提到 `api.refOverrides` 是在解释，不是在调用。 */
function codeLines(p: string): { n: number; t: string }[] {
  return readFileSync(p, "utf8").split("\n").map((t, i) => ({ n: i + 1, t }))
    .filter(({ t }) => {
      const s = t.trim();
      return s && !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
    });
}

/* ---------------------------------------------------------------- ① 前端交互层 */

console.log("① 交互层不许直接调 api.（调整必须只写本地台账）");
{
  // 这些文件是"用户手指碰到的地方"：拖动、点选、拖放、注入。
  // 里面出现 `api.` = 又把一次交互变成一次网络往返。
  const FILES = [
    "src/features/assets/AssetTrack.tsx",
    "src/features/assets/injectAsset.ts",
    "src/features/assets/useAssetDrop.ts",
  ];
  // 允许的例外：与"注入段"无关的资产侧动作（换图、锁造型、改 kind）。
  // 它们本来就是**显式的一次服务端操作**，用户点的是菜单项而不是拖拽，
  // 不存在"每帧一次"的问题。逐条登记，别用通配。
  const ALLOW: Record<string, string[]> = {
    "src/features/assets/AssetTrack.tsx": [
      "api.patchStage(",   // 锁定/解锁造型：一次点击一次写，语义就是改服务端
      "api.mediaUrl(",     // 纯字符串拼 URL，不是请求
    ],
    "src/features/assets/injectAsset.ts": [
      "api.patchAsset(",       // 换素材的 kind
      "api.upsertAssetImage(", // 换这张资产图
      "api.patchStage(",       // 换造型图
    ],
    "src/features/assets/useAssetDrop.ts": [],
  };
  for (const rel of FILES) {
    const p = resolve(DESKTOP, rel);
    if (!existsSync(p)) { ok(false, `${rel} 存在`); continue; }
    const allow = ALLOW[rel] ?? [];
    const hits = codeLines(p).filter(({ t }) => /(^|[^.\w])api\.[A-Za-z]/.test(t))
      .filter(({ t }) => !allow.some((a) => t.includes(a)));
    ok(hits.length === 0, `${rel} 里没有未经登记的服务端调用`,
      hits.map((h) => `第 ${h.n} 行: ${h.t.trim()}`).join(" | "));
  }

  // 台账写入（records）是唯一允许发请求的地方，且它必须走 store 的 syncRow
  const store = readFileSync(resolve(DESKTOP, "src/stores/assetOverrideStore.ts"), "utf8");
  ok(/api\.refOverrides\(/.test(store), "落库只走 assetOverrideStore.syncRow");
}

/* ---------------------------------------------------------------- ② 写入不进网络 */

console.log("② record() 里不许排定时器 / 发请求（'闪一下'的根治点）");
{
  const p = resolve(DESKTOP, "src/stores/assetOverrideStore.ts");
  const src = readFileSync(p, "utf8");
  // 截取 record 的函数体（到下一个顶层 `},` 为止的近似：取到 `\n  },\n`）
  const start = src.indexOf("  record: (rowName, ops) => {");
  ok(start >= 0, "找得到 record()");
  if (start >= 0) {
    const end = src.indexOf("\n  },\n", start);
    const body = src.slice(start, end > 0 ? end : start + 1200);
    ok(!/scheduleFlush|setTimeout|api\./.test(body),
      "record() 不排定时器、不调 api（调整只活在本地台账里）",
      body.match(/scheduleFlush|setTimeout|api\.[A-Za-z]+/g)?.join(", ") ?? "");
  }
}

/* ---------------------------------------------------------------- ③ 兜底要有条件 */

console.log("③ 关窗口/切后台的兜底：先判有没有未落库改动");
{
  const src = readFileSync(resolve(DESKTOP, "src/stores/assetOverrideStore.ts"), "utf8");
  ok(/pagehide/.test(src), "有 pagehide 兜底（否则关窗口会丢调整）");
  // 兜底handler里必须先 hasPendingOverrides() 再 flush；直接 flush 是无条件发请求
  const i = src.indexOf('addEventListener("pagehide"');
  const ctxSrc = i >= 0 ? src.slice(Math.max(0, i - 700), i + 200) : "";
  ok(/hasPendingOverrides\(\)/.test(ctxSrc),
    "兜底先判 hasPendingOverrides()（没改动就一个请求都不发）");
}

/* ---------------------------------------------------------------- ④ 入口必须先 flush */

console.log("④ 需要服务端能力的入口必须先 flush 本地台账");
{
  const app = readFileSync(resolve(DESKTOP, "src/App.tsx"), "utf8");
  const lines = app.split("\n");
  // 每个"会读服务端 ref_overrides 的入口"：函数定义处向下 40 行内必须出现 flushAssets()
  const GATES: [string, string][] = [
    ["const doGenerate = async", "单镜/批量生成视频：后端按 shot_id 算注入"],
    ["const doFirstFrames = async", "批量首帧：构图靠资产注入"],
    ["const doPipeline = async", "一键成片：资产→首帧→片段全程要注入"],
    ["const doGenerateVariant = async", "生成变体：同样是按 shot_id 注入"],
    ["onExport=", "导出：编译时读注入结果"],
  ];
  for (const [needle, why] of GATES) {
    const idx = lines.findIndex((t) => t.includes(needle));
    ok(idx >= 0, `找得到入口 ${needle}`);
    if (idx < 0) continue;
    const window = lines.slice(idx, idx + 40).join("\n");
    ok(window.includes("flushAssets()"), `${needle} 先 flush（${why}）`);
  }
  // flushAssets 自己必须接住失败并说话 —— 静默失败 = 用了半份参考图去生成
  const fi = lines.findIndex((t) => t.includes("const flushAssets = useCallback"));
  ok(fi >= 0, "有 flushAssets 包装");
  if (fi >= 0) {
    const w = lines.slice(fi, fi + 20).join("\n");
    ok(/if \(!ok\)/.test(w), "flushAssets 在失败时提醒用户（不静默吞掉）");
  }
}

/* ---------------------------------------------------------------- ⑤ 跨轨身份 */

console.log("⑤ 资产卡跨轨落下：两条拖放通道都要做身份检查");
{
  const files = [
    ["src/features/assets/AssetTrack.tsx", "指针通道 onLaneDrop"],
    ["src/features/assets/useAssetDrop.ts", "统一落点 commitAssetDrop"],
  ];
  for (const [rel, name] of files) {
    const src = readFileSync(resolve(DESKTOP, rel), "utf8");
    // 判据：都要出现"卡片名 vs 落点行名"的显式比较（两个方向的写法都认）
    ok(/d\.name\s*!==\s*row\.name|row\.name\s*!==\s*d\.name|target\.rowName\s*!==\s*d\.name|d\.name\s*!==\s*target\.rowName/.test(src),
      `${name} 做了身份比较（角色 A 不许落到角色 B 的轨）`);
    ok(/不能注入到/.test(src), `${name} 拒绝时给了人话解释`);
  }
  // 特殊镜不许被拖入。两条通道实现的层次不同：指针通道自己在 onLaneDrop 里判，
  // 统一落点通道把这一步委托给 injectAssetIntoShot（判定只写一处）。
  // 所以这里断言的是"各自真的走到了那道闸"，而不是"两个文件里都有 is_special 字样"。
  ok(/is_special/.test(readFileSync(resolve(DESKTOP, "src/features/assets/AssetTrack.tsx"), "utf8")),
    "指针通道 onLaneDrop 拦了特殊镜");
  ok(/injectAssetIntoShot\(/.test(readFileSync(resolve(DESKTOP, "src/features/assets/useAssetDrop.ts"), "utf8")),
    "统一落点 commitAssetDrop 经由 injectAssetIntoShot 走特殊镜闸门");
  ok(/a\.shot\.is_special/.test(readFileSync(resolve(DESKTOP, "src/features/assets/injectAsset.ts"), "utf8")),
    "闸门本体 injectAssetIntoShot 确实拦了特殊镜");
}

/* ---------------------------------------------------------------- ⑥ 几何单一真源 */

console.log("⑥ 段几何只有一个来源（runGeometry），不许读回 DOM");
{
  const src = readFileSync(resolve(DESKTOP, "src/features/assets/AssetTrack.tsx"), "utf8");
  const hits = codeLines("src/features/assets/AssetTrack.tsx")
    .filter(({ t }) => /parseFloat\(.*style\.(left|width)/.test(t));
  ok(hits.length === 0, "AssetTrack 不再 parseFloat 读回 style.left/width（越拖越偏的来源）",
    hits.map((h) => `第 ${h.n} 行`).join(", "));
  ok(/runGeometry\(/.test(src), "渲染与手势共用 runGeometry");
  ok(/clampEdge\(/.test(src), "边缘拖动受 clampEdge 约束（两端不许交叉）");
  // 手势阈值：0 阈值 = 点一下也走提交，正是"点一下就缩到最短"的一半成因
  ok(!/thresholdPx:\s*0\b/.test(src), "没有把 thresholdPx 设成 0 的手势");
}

console.log(`\n${fail ? "❌" : "✅"} ${pass} 项通过，${fail} 项未通过`);
process.exit(fail ? 1 : 0);
