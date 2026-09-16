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
  // 注入之后这一段归**哪套造型**：注入类写入必须盖章（`stageId`），否则投影层
  // 当它是"无主的加法"，任何造型都不认领，用户亲手从资产窗拖进来的卡会显示成
  // 一条系统口气的兜底段。用户原话：「人工注入这个问题很大，因为用户从资产窗把
  // 资产拖到轨道上也会显示人工注入」。
  const injSrc = readFileSync(resolve(DESKTOP, "src/features/assets/injectAsset.ts"), "utf8");
  ok(/stageIdAt\(/.test(injSrc), "注入写入会推断造型归属（stageIdAt）");
  ok(/manual:\s*true,\s*stageId|present:\s*true,\s*manual:\s*true,\s*stageId/.test(injSrc),
    "注入写下的 op 真的带上了 stageId（不是推断完就丢掉）");
  const dropSrc = readFileSync(resolve(DESKTOP, "src/features/assets/useAssetDrop.ts"), "utf8");
  ok(/stages:\s*ctx\.stages/.test(dropSrc),
    "统一落点通道把造型底座交给注入函数（不然推不出归属）");
  // ⚠️ 3.14 起 HTML5 落点**不再自己推归属**，而是把这一行的造型交给
  // `injectAssetIntoShot`（判定只写一处）。所以这里改钉"它确实把造型交出去
  // 了"，而不是"AssetTrack.tsx 里有 stageIdAt"—— 后者守的是实现细节，
  // 前者才是那个不变量：别让落轨这条链退化成"不盖章的加法"。
  ok(/injectAssetIntoShot\(\{/.test(readFileSync(
    resolve(DESKTOP, "src/features/assets/AssetTrack.tsx"), "utf8")),
    "HTML5 落点把注入交给 injectAssetIntoShot（归属由它推）");
  // 撤销面：`inverseOps` 必须把章一起搬过去，否则 Ctrl+Z 撤销一次注入会让逆操作
  // 变成无主的加法，凭空冒出一条兜底段。
  ok(/present:\s*!o\.present,\s*manual:\s*o\.manual,\s*stageId:\s*o\.stageId/.test(
    readFileSync(resolve(DESKTOP, "src/stores/assetOverrideStore.ts"), "utf8")),
    "撤销的逆操作保留 stageId（撤销注入不冒兜底段）");
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
  // ⚠️ 3.14 起手势不再直接调 `clampEdge`：它把"边缘在哪"和"能否写进去"合成
  //    一个像素值，于是**预览跟着指针走、提交才吸附成镜头**，两者必然差半格
  //    （用户报的"缩一镜没反应"。见 `snapEdge` 注释）。现在同一个 `snapEdge`
  //    既产预览 px 又产提交 order，两端不交叉是它内部 `limit` 保证的。
  //    所以这里断言的是"手势走的是 snapEdge"，而不是某个具体函数名。
  ok(/snapEdge\(/.test(src), "边缘拖动经 snapEdge 定落点（预览与提交同一个值）");
  ok(!/clampEdge\(/.test(src), "不再有第二套像素夹取（两套即两种落点）");
  // 手势阈值：0 阈值 = 点一下也走提交，正是"点一下就缩到最短"的一半成因
  ok(!/thresholdPx:\s*0\b/.test(src), "没有把 thresholdPx 设成 0 的手势");
  // ⚠️ 只钉住 `thresholdPx` 不够 —— 它只管 `onFrame`，而 `onUp` 会为最后一个
  // pending 事件补跑一次 `onFrame`、并且**无条件**调 `onCommit`。老写法就在
  // `onCommit` 里直接拿 `lastPx` 提交，于是"点一下"照样改数据、缩到最短。
  // 两个手势的 `onCommit` 都必须先看"到底动过没有"。
  // 从 `onCommit` 处一直取到本次回调结束：闸门可能压在一段解释性注释后面。
  const commits = [...src.matchAll(/onCommit:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{4,8}\},/g)];
  ok(commits.length >= 2, "两个拖拽手势都写了 onCommit", `实际 ${commits.length} 处`);
  ok(
    commits.every(([, body]) => /!moved|!g\.moved/.test(body)),
    "每个 onCommit 都以 moved 为闸（纯点击不提交）",
    commits.map(([, b], i) => (/!moved|!g\.moved/.test(b) ? null : `第 ${i + 1} 处`))
      .filter(Boolean).join(", "),
  );
  ok(
    /if \(!g\.moved\) return;/.test(src),
    "onFrame 也忽略未越阈值的帧（否则补跑那一帧会写出预览）",
  );
}

/* ------------------------------------------------ ⑥.5 段的可及范围按造型算 */

// ⚠️ 账本 `table` 以**角色名**为键，画面却按**每个造型**过滤（后端 `list_stages`
// 用 `in_range` 逐阶段切）。把一个造型的段拉进另一个造型的区间，写下的 op 会被
// 那条段捡走 → 同一角色的轨道上多出一块**重叠**的段；谁都没接住时还会合成一段
// `local:…` 的「未设阶段」段（旧名「人工注入」）。用户报的"拉长会多出一块、还重叠"就是这个。
//
// 判据：每段都带一个可及范围，且 `applyEdge` 落到它里面。
//
// ⚠️ 字段名从 `span` 改成了 `reach`，算法也从裸 `freeSpan` 换成
// `reachSpan(freeSpan(...))` —— `freeSpan` 只从**当前** from..to 往外扫，
// 缩短之后当前范围变小、可及范围跟着收，段就再也拉不回原长（"缩了就回不去"）。
// `reachSpan` 从底座往外扫到别的造型/没有镜头为止，拖动全程冻结不动。
// 这里只钉不变量，不钉某个具体函数名的写法。
console.log("⑥.5 边缘拖动只在'这一段自己的可及范围'内（跨造型重叠块的根治点）");
{
  const src = readFileSync(resolve(DESKTOP, "src/features/assets/AssetTrack.tsx"), "utf8");
  const reaches = [...src.matchAll(/reach:\s*reachSpan\(/g)].length;
  const runs = [...src.matchAll(/\bfrom:\s*\w+\[0\],\s*to:\s*\w+\[/g)].length;
  ok(reaches >= 4, "四处段（角色/场景 × 渲染/合成）都算了 reach", `实际 ${reaches} 处`);
  ok(runs === reaches, "算了 reach 的段数 = 渲染的段数（没有哪类段漏了）", `段 ${runs} 处 / reach ${reaches} 处`);
  ok(
    /Math\.min\(Math\.max\(newOrder,\s*run\.reach\[0\]\),\s*run\.reach\[1\]\)/.test(src),
    "applyEdge 兜底夹到 reach（窗口外的程序化调用也拦住）",
  );
  const win = src.match(/const win:\s*EdgeWindow\s*=\s*\{([\s\S]*?)\n\s{4}\};/);
  ok(!!win, "手势窗口 win 由 reach 派生");
  ok(
    !!win && /lo:\s*run\.reach\[0\]/.test(win[1]) && /hi:\s*run\.reach\[1\]/.test(win[1]),
    "win 的上下界就是 reach",
    win ? win[1].trim() : "",
  );
}

/* ---------------------------------------------------- ⑦ 预览收尾必须恢复快照 */

// ⚠️ 上面⑥的 `moved` 闸门只拦住了**提交**（不给账本写数据），拦不住
// `onSettle → pv.reset()` —— 收尾永远会跑。老写法把 `el.style.width` 清成空串，
// 赌"React 随后会用新值重写一次"。可纯点击根本没有数据变化：React 的 diff 认为
// `width` 这个 prop 没变，**跳过**重写，元素就永远停在空串上 —— 内联宽度一没，
// `.fw-at-run` 退化成按内容自适应，"点一下资产块立刻缩到最短"，且只有刷新页面
// （整棵树重建）才恢复。这正是用户在 3.13 之后仍然报的那个现象。
//
// 修法又改过一次，判据跟着改：**预览根本不该碰 `el.style.width`**。
// 那个属性是 React 亲自写的，而 React 更新内联样式时只跟**自己上一次**的 style
// 对象比（react-dom 的 `diffProperties`），**从不读 DOM**。所以"预览期绕过它写、
// 收尾时还回去"这条路本身就有漏洞：还回去的值与 React 的记录一旦不等，之后每次
// 渲染都判"这个 prop 没变"而永久跳过写入 —— 拖完提交了 DOM 却停在旧宽度。
// 现在预览走一个 React 不认识的名字 `--fw-pv-w`，CSS 侧
// `width: var(--fw-pv-w, <React 写的内联值>)` 读它，`reset()` 摘掉它，
// React 的内联值立刻重新生效。两边各写各的，不存在"谁的记录更新"。
//
// 判据：`stylePreview` 只用 `setProperty/removeProperty` 操作 `--fw-pv-w`，
// 且**全程不给 `el.style.width` 赋值**（写空串与写快照一样危险）。
console.log("⑦ 拖动预览收尾要恢复接管时的内联值，不许清成空串");
{
  const src = readFileSync(resolve(DESKTOP, "src/features/timeline/gesture.ts"), "utf8");
  const m = src.match(/export function stylePreview\([\s\S]*?\n\}/);
  ok(!!m, "找得到 stylePreview 本体");
  const body = m ? m[0] : "";
  ok(
    /setProperty\(\s*["'`]--fw-pv-w["'`]/.test(body),
    "宽度预览走自定义属性 --fw-pv-w（不碰 React 管的 style.width）",
  );
  ok(
    !/el\.style\.width\s*=/.test(body),
    "全程没有给 el.style.width 赋值（写快照或写空串都会与 React 的记录脱钩）",
    body.split("\n").filter((l) => /style\.width/.test(l)).join(" / "),
  );
  const reset = body.match(/reset\(\)\s*\{([\s\S]*?)\n\s{4}\}/);
  ok(!!reset, "找得到 reset() 实现");
  ok(
    !!reset && /removeProperty\(\s*["'`]--fw-pv-w["'`]/.test(reset[1]),
    "reset() 摘掉 --fw-pv-w，让 React 的内联宽度重新生效",
    reset ? reset[1].trim() : "",
  );
  ok(
    !!reset && /el\.style\.transform\s*=\s*restTransform/.test(reset[1]),
    "reset() 把 transform 还原成接管时的快照（它与 React 写的是同一个值，可以直接写）",
    reset ? reset[1].trim() : "",
  );
}

console.log(`\n${fail ? "❌" : "✅"} ${pass} 项通过，${fail} 项未通过`);
process.exit(fail ? 1 : 0);
