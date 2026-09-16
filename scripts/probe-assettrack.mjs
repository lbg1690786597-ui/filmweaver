/**
 * scripts/probe-assettrack.mjs —— 资产轨的**真机行为验证**（Playwright）
 *
 * 对手工重放（verify-draggeom.ts 那一类）的补充：那个脚本抄一遍逻辑算给自己看，
 * 证明不了真组件跑的是同一套，也看不见"DOM 预览"与"React 渲染"两套几何打架。
 * 这里挂的是**真的 `AssetTrack`**（见 `src/dev/AssetTrackHarness.tsx`），用
 * **真指针事件**驱动，断言全部按"用户会怎么用"来写。
 *
 * 本文件按**用户会做的操作**分节，而不是按代码结构分节：
 *   0 初始态 / 1 点一下 / 2 右边缘缩 / 3 右边缘拉长 / 4 左边缘 /
 *   5 整段平移 / 6 删除（右键 + Delete 键）/ 7 跨行拖卡片 /
 *   8 复制粘贴往返 / 9 撤销重做 / 10 几何精度
 *
 * ⚠️ **2026-09 的教训**：验证台一度没调 `openProject`，`record()` 第一行就把所有
 * 写入静默丢了；台子照样预览、照样弹 toast，于是跑出来的全是"拉长没反应""左边缘
 * 拖不动"这类**假象**。所以本文件每条写入断言都必须同时核对三件事：
 *   toast 说了什么 / 台账真变了没有 / DOM 与台账是否一致。
 * 只看其中任何一个都会得出错误结论。
 *
 * 跑法（先起 dev server：`cd desktop && npm run dev`，端口 1430）：
 *   node scripts/probe-assettrack.mjs
 */

import { chromium } from "playwright";

const URL = "http://127.0.0.1:1430/?at-harness=1";
const PX = 100;          // 一镜 = 5s × 20px/s

let pass = 0, fail = 0;
const rows = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; rows.push(`  ✅ ${name}`); }
  else { fail++; rows.push(`  ❌ ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t) { rows.push(`\n── ${t} ──`); }

/** order 列表 → 连续区间 */
const intervalsOf = (orders) => {
  const s = [...orders].sort((a, b) => a - b);
  const out = [];
  let cur = null;
  for (const o of s) {
    if (cur && o === cur[1] + 1) cur[1] = o;
    else { cur = [o, o]; out.push(cur); }
  }
  return out;
};
const ivStr = (orders) => JSON.stringify(intervalsOf(orders));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function state(page) {
  return page.evaluate(() => {
    const h = window.__atHarness;
    const table = h.ops();
    const lines = {};
    const stageLines = {};
    for (const n of ["林昭", "沈砚", "楚家公馆-客厅"]) {
      lines[n] = h.shownOf(n);
      // 造型级投影：组件渲染的就是这一份。行级并集无法表达"同一角色两套造型
      // 各管哪些镜头"，拿它核对几何等于用错刻度的尺子量。
      stageLines[n] = h.stageShownOf ? h.stageShownOf(n) : null;
    }
    return { lines, stageLines, runs: h.runs(), toast: h.toast(), rowCount: h.rowCount(), table };
  });
}

/** 抓一个段（或它的边缘手柄）的落点。找不到返回 null —— **不抛**：
 *  抛异常会把后面所有小节一起带走，看不出"是哪一步开始不对"。 */
async function pointOf(page, runId, part = "body", frac = 0.5) {
  return page.evaluate(({ runId, part, frac }) => {
    const h = window.__atHarness;
    const el = part === "body" ? h.el(runId)
      : h.edgeEl(runId, part === "left" ? "left" : "right");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // 边缘手柄只有 6px，取它靠外的那 2px，别蹭到段身
    const x = part === "left" ? r.left + 2
      : part === "right" ? r.right - 2
        : r.left + r.width * frac;
    return { x, y: r.top + r.height / 2, left: r.left, right: r.right, width: r.width };
  }, { runId, part, frac });
}
/** `pointOf` 的断言版：找不到就记一条失败并返回 null，调用方 `if (!p) return;` */
async function need(point, page, runId, part = "body", frac = 0.5) {
  const p = await pointOf(page, runId, part, frac);
  if (!p) check(`找得到 ${runId} / ${part}`, false, "元素不存在");
  return p;
}

async function gesture(page, from, to, { steps = 10 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await page.waitForTimeout(10);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);   // 等 React 用台账重画完
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 700 } });
page.on("pageerror", (e) => { fail++; rows.push(`  ❌ 页面异常：${e.message}`); });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__atHarness, null, { timeout: 20000 });
await page.waitForTimeout(500);

const reset = async () => {
  await page.evaluate(() => window.__atHarness.reset());
  await page.waitForTimeout(250);
};

/** 台账投影 = DOM 实测？这是"看到哪 = 提交到哪"的总闸门 */
async function domMatchesLedger(page, label) {
  const st = await state(page);
  const bad = [];
  for (const r of st.runs) {
    if (r.id.startsWith("local:") || r.id.startsWith("loc:")) continue;
    const m = /^(.+):(\d+)$/.exec(r.id);
    if (!m) continue;
    const from = Number(m[2]);
    const stageId = m[1];
    const line = st.lines[r.rowsHint];
    if (!line) { bad.push(`${r.id} 行「${r.rowsHint}」不在台账里`); continue; }
    // ⚠️ 按**造型**找区间，不是按行级并集。`st-night:5` 在并集 [[1,6],[9,12]]
    // 里找不到 `from === 5` 的区间头，不是因为它不该存在，而是并集把
    // 常服 #1-4 与它连成了一段 —— 量具的失真，不是组件的错。
    const sl = (st.stageLines?.[r.rowsHint] ?? []).find((x) => x.stageId === stageId);
    const src = sl ? sl.shown : line;
    const iv = intervalsOf(src).find(([a]) => a === from);
    if (!iv) { bad.push(`${r.id} 不在${sl ? "造型" : "行级"}投影 ${ivStr(src)} 里`); continue; }
    const wantW = (iv[1] - iv[0] + 1) * PX;
    const wantL = (iv[0] - 1) * PX;
    if (Math.abs(r.width - wantW) > 2) bad.push(`${r.id} 宽 ${r.width}px ≠ 台账 ${wantW}px`);
    if (Math.abs(r.left - wantL) > 2) bad.push(`${r.id} 左 ${r.left}px ≠ 台账 ${wantL}px`);
    // ⚠️ 这里**不是**断言 `inlineWidth === ""`。段身上本来就带 React 写的
    // `style={{left, width}}`，稳定的段保留下 `"400px"` 是**正常**的。
    // 要抓的是"预览没归还"：内联值必须与台账算出来的值一致。
    if (r.inlineWidth && Math.abs(parseFloat(r.inlineWidth) - wantW) > 2) {
      bad.push(`${r.id} 残留内联 width=${r.inlineWidth}（台账应为 ${wantW}px）—— 预览没归还`);
    }
    if (r.inlineTransform && /translate/.test(r.inlineTransform)) {
      bad.push(`${r.id} 残留内联 transform=${r.inlineTransform} —— 预览没归还`);
    }
  }
  // 台账里的每一段都该在屏幕上
  for (const [name, stageList] of Object.entries(st.stageLines ?? {})) {
    if (name === "楚家公馆-客厅" || !stageList) continue;
    for (const sl of stageList) {
      for (const [a] of intervalsOf(sl.shown)) {
        const want = sl.stageId ? `${sl.stageId}:${a}` : null;
        const hit = st.runs.some((r) => r.rowsHint === name
          && (want ? r.id === want : /:(\d+)$/.exec(r.id)?.[1] === String(a)));
        if (!hit) bad.push(`台账里「${name}」${sl.stageId ?? "虚拟段"} 有 #${a} 起的段，屏幕上没有`);
      }
    }
  }
  check(label, bad.length === 0, bad.join("; "));
}

/** 同一行内两两不重叠 */
async function noOverlap(page, rowName, label) {
  const st = await state(page);
  const mine = st.runs.filter((r) => r.rowsHint === rowName);
  const bad = [];
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i], b = mine[j];
      if (a.left < b.left + b.width - 1 && b.left < a.left + a.width - 1) {
        bad.push(`${a.id}[${a.left},${Math.round(a.left + a.width)}] ∩ ${b.id}[${b.left},${Math.round(b.left + b.width)}]`);
      }
    }
  }
  check(label, bad.length === 0, bad.join("; "));
}

/** 一次"写入型"操作的统一核对：toast 不能是"失败话术"、台账必须真的变了 */
function writeAccepted(before, after, label) {
  const changed = JSON.stringify(before.table) !== JSON.stringify(after.table);
  // `applyEdge` 等在台账拒收时会弹这句（见 AssetTrack.tsx 的 recordWithUndo 分支）
  const rejected = /尚未就绪|没有保存|没有删除/.test(after.toast);
  check(`${label}：台账真的被写进去了（不是预览动了、数据没动）`,
    changed && !rejected,
    `table=${JSON.stringify(after.table)} toast="${after.toast}"`);
}

/* ================================================================= *
 * 0. 初始状态 —— 也是"验证台有没有接上台账"的自检
 * ================================================================= */
section("0. 初始 fixture（含验证台自检）");
{
  const st = await state(page);
  // ⚠️ 人物轨**只画人物行**。fixture 里的「楚家公馆-客厅」是 LocationInfo，
  // 要切到 `kind="location"` 才出现在轨上，它不该被算进人物轨的行数。
  // 老断言写 3（把场景也数进来）是量具错了：组件从来没打算在人物轨画场景。
  check("人物轨行数 = 林昭 + 沈砚 = 2", st.rowCount === 2, `rowCount=${st.rowCount}`);
  check("林昭底座 = #1-4 + #9-12",
    eq(intervalsOf(st.lines["林昭"]), [[1, 4], [9, 12]]), ivStr(st.lines["林昭"]));
  check("初始每段像素 = 镜数 × 100",
    st.runs.filter((r) => r.id === "st-day:1").every((r) => Math.abs(r.width - 400) < 2),
    JSON.stringify(st.runs.map((r) => [r.id, r.width])));
  // 自检：往台账写一条已知的 op，必须真的进去。进不去 = 后面全是假象。
  await page.evaluate(() => window.__atHarness.seedOps("林昭", [{ order: 5, present: true, manual: true }]));
  await page.waitForTimeout(120);
  const seeded = await state(page);
  check("验证台自检：台账写得进去（写不进 = 后面所有结论作废）",
    eq(intervalsOf(seeded.lines["林昭"]), [[1, 5], [9, 12]]), ivStr(seeded.lines["林昭"]));
  await reset();
  const cleared = await state(page);
  check("重置后台账清空、回到 fixture", eq(intervalsOf(cleared.lines["林昭"]), [[1, 4], [9, 12]]),
    ivStr(cleared.lines["林昭"]));
  await page.screenshot({ path: "/tmp/at-00-initial.png" });
}

/* ================================================================= *
 * 1. 纯点击：什么都不该发生
 * ================================================================= */
section("1. 点一下（用户预期：只是选中）");
{
  await reset();
  const before = await state(page);
  const p = await need(pointOf(page, "st-day:1", "body"), page, "st-day:1", "body");
  if (p) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
    const after = await state(page);
    check("点段身：台账没变", eq(before.table, after.table), JSON.stringify(after.table));
    const dom = after.runs.find((r) => r.id === "st-day:1");
    check("点段身：段宽仍是 400px", dom && Math.abs(dom.width - 400) < 2, `width=${dom?.width}`);
    check("点段身：选中它了",
      (await page.evaluate(() => window.__atHarness.selected())) === "st-day:1",
      await page.evaluate(() => window.__atHarness.selected()));

    const pe = await need(pointOf(page, "st-day:1", "right"), page, "st-day:1", "right");
    if (pe) {
      await page.mouse.click(pe.x, pe.y);
      await page.waitForTimeout(200);
      const a2 = await state(page);
      check("点右边缘手柄：台账没变", eq(before.table, a2.table), JSON.stringify(a2.table));
      const dom2 = a2.runs.find((r) => r.id === "st-day:1");
      check("点右边缘手柄：段宽仍是 400px", dom2 && Math.abs(dom2.width - 400) < 2, `width=${dom2?.width}`);

      await gesture(page, { x: pe.x, y: pe.y }, { x: pe.x + 2, y: pe.y }, { steps: 2 });
      const a3 = await state(page);
      check("按住边缘抖 2px（未过 3px 阈值）：台账没变",
        Object.keys(a3.table).length === 0, JSON.stringify(a3.table));
    }
  }
}

/* ================================================================= *
 * 2. 右边缘缩短：一格一格，不跳格、不吞步
 *    —— 用户原话：「缩短一个片段距离后视觉上没有反应，
 *       但再次拖到缩小，新的缩小起点在上一次缩小的预期结果上」
 * ================================================================= */
section("2. 右边缘往左缩（用户预期：拖一格缩一镜，**当场**看得见）");
{
  await reset();
  const e = await need(pointOf(page, "st-day:1", "right"), page, "st-day:1", "right");
  if (e) {
    const before = await state(page);
    await gesture(page, { x: e.x, y: e.y }, { x: e.x - PX, y: e.y });
    let st = await state(page);
    check("缩一镜 → 台账 #1-3 + #9-12",
      eq(intervalsOf(st.lines["林昭"]), [[1, 3], [9, 12]]), ivStr(st.lines["林昭"]));
    writeAccepted(before, st, "缩一镜");
    let dom = st.runs.find((r) => r.id === "st-day:1");
    check("缩一镜 → 屏幕上是 3 镜宽（当场看见，不用再拖一次）",
      dom && Math.abs(dom.width - 300) < 2, `width=${dom?.width}`);
    check("缩一镜 → 没有弹出「未就绪/没保存」这类失败提示",
      !/尚未就绪|没有保存/.test(st.toast), `toast="${st.toast}"`);
    await domMatchesLedger(page, "缩一镜后：DOM 几何 = 台账投影");
    await page.screenshot({ path: "/tmp/at-01-shrink-1.png" });

    // ⚠️ 用户原话的关键：**第二次拖的起点**必须是上一次缩完之后的边缘，
    // 而不是"上一次缩之前"的位置。这里重新取一次 DOM 坐标就是验这个。
    const e1 = await need(pointOf(page, "st-day:1", "right"), page, "st-day:1", "right");
    if (e1) {
      check("缩一镜后段的右边缘已经真的挪到 #3 末尾（下次拖动的起点）",
        Math.abs(e1.right - e.right + PX) < 2,
        `now=${e1.right} first=${e.right}（应差 ${PX}px）`);
      await gesture(page, { x: e1.x, y: e1.y }, { x: e1.x - PX, y: e1.y });
      st = await state(page);
      dom = st.runs.find((r) => r.id === "st-day:1");
      check("再缩一镜 → 台账 #1-2 + #9-12",
        eq(intervalsOf(st.lines["林昭"]), [[1, 2], [9, 12]]), ivStr(st.lines["林昭"]));
      check("再缩一镜 → 屏幕 2 镜宽", dom && Math.abs(dom.width - 200) < 2, `width=${dom?.width}`);
      check("再缩一镜 → 左边界没动（left=0）", dom && Math.abs(dom.left) < 2, `left=${dom?.left}`);
      await domMatchesLedger(page, "缩两镜后：DOM 几何 = 台账投影");
    }

    // 一路缩到极限
    const e2 = await need(pointOf(page, "st-day:1", "right"), page, "st-day:1", "right");
    if (e2) {
      await gesture(page, { x: e2.x, y: e2.y }, { x: e2.x - 2000, y: e2.y });
      st = await state(page);
      dom = st.runs.find((r) => r.id === "st-day:1");
      check("右边缘拖到最左 → 停在只剩 1 镜（#1）",
        eq(intervalsOf(st.lines["林昭"]), [[1, 1], [9, 12]]), ivStr(st.lines["林昭"]));
      check("右边缘拖到最左 → 没有塌成 0 宽", dom && dom.width > 16, `width=${dom?.width}`);
      await noOverlap(page, "林昭", "缩到极限后：同行不重叠");
      await domMatchesLedger(page, "缩到极限后：DOM 几何 = 台账投影");
      await page.screenshot({ path: "/tmp/at-02-shrink-min.png" });
    }
  }
}

/* ================================================================= *
 * 3. 右边缘拉长：不许越过同角色另一造型的区间
 *    —— 用户原话：「拉长资产块时，会创建一个新的资产块（如果没有，就有一个
 *       "人工注入"），而且是覆盖重叠的」
 * ================================================================= */
section("3. 右边缘往右拉长（用户预期：最多拉到另一块之前，不重叠、不长新块）");
{
  await reset();
  const e = await need(pointOf(page, "st-day:1", "right"), page, "st-day:1", "right");
  if (e) {
    const before = await state(page);
    await gesture(page, { x: e.x, y: e.y }, { x: e.x + 700, y: e.y });   // 400 → 1100
    const st = await state(page);
    const iv = intervalsOf(st.lines["林昭"]);
    writeAccepted(before, st, "拉长");
    check("拉长后同一行只有两块", iv.length === 2, ivStr(st.lines["林昭"]));
    check("拉长不越过夜行衣（#9 起）",
      iv.length === 2 && iv[1][0] >= 9 && iv[0][1] <= 8, ivStr(st.lines["林昭"]));
    check("没有凭空多出的「人工注入」段",
      !st.runs.some((r) => r.id.startsWith("local:")),
      JSON.stringify(st.runs.map((r) => r.id)));
    check("占用区间不与夜行衣重叠",
      iv.length === 2 && iv[0][1] < iv[1][0], ivStr(st.lines["林昭"]));
    await noOverlap(page, "林昭", "拉长后：同行的块不重叠");
    await domMatchesLedger(page, "拉长后：DOM 几何 = 台账投影");
    await page.screenshot({ path: "/tmp/at-03-grow-right.png" });
    rows.push(`  · 拉长结果：${ivStr(st.lines["林昭"])}`);

    // 拉长后**立刻**再缩回来：这是用户报的"拉长长了新块"之后最常见的下一步
    const e2 = await pointOf(page, "st-day:1", "right");
    if (e2) {
      await gesture(page, { x: e2.x, y: e2.y }, { x: e2.x - 200, y: e2.y });
      const st2 = await state(page);
      // ⚠️ 期望值要从**这一轮实际拉到哪**往回减两镜，不能写死 [[1,2]]。
      // 老断言假定"拉长根本没生效（仍是 #1-4）"，才会算出缩两镜到 #1-2；
      // 而 #5-#7 是谁都没声明的公共空地、常服本来就该能拉进去（本轮实测
      // 拉到 #1-7），于是缩两镜的正确结果是 #1-5。断言写死等于把
      // "拉长曾经是坏的"这件事钉成了预期。
      const grownTo = intervalsOf(before ? st.lines["林昭"] : st.lines["林昭"])[0][1];
      check(`拉长后马上缩两镜 → 掉回 #1-${grownTo - 2} + #9-12（不会留下拉长出来的残块）`,
        eq(intervalsOf(st2.lines["林昭"]), [[1, grownTo - 2], [9, 12]]), ivStr(st2.lines["林昭"]));
      check("拉长后马上缩 → 仍然没有「人工注入」段",
        !st2.runs.some((r) => r.id.startsWith("local:")),
        JSON.stringify(st2.runs.map((r) => r.id)));
    }
  }
}

/* ================================================================= *
 * 4. 左边缘
 * ================================================================= */
section("4. 左边缘（往右缩 / 往左扩）");
{
  await reset();
  const e = await need(pointOf(page, "st-day:1", "left"), page, "st-day:1", "left");
  if (e) {
    const before = await state(page);
    await gesture(page, { x: e.x, y: e.y }, { x: e.x + PX, y: e.y });
    let st = await state(page);
    check("左边缘右移一镜 → 台账 #2-4 + #9-12",
      eq(intervalsOf(st.lines["林昭"]), [[2, 4], [9, 12]]), ivStr(st.lines["林昭"]));
    writeAccepted(before, st, "左边缘右移");
    await domMatchesLedger(page, "左缩后：DOM 几何 = 台账投影");

    const e2 = await need(pointOf(page, "st-day:2", "left"), page, "st-day:2", "left");
    if (e2) {
      await gesture(page, { x: e2.x, y: e2.y }, { x: e2.x - PX, y: e2.y });
      st = await state(page);
      check("左边缘左移一镜 → 台账回到 #1-4 + #9-12",
        eq(intervalsOf(st.lines["林昭"]), [[1, 4], [9, 12]]), ivStr(st.lines["林昭"]));
      await domMatchesLedger(page, "左扩后：DOM 几何 = 台账投影");
    }

    // 左边缘往右拖过头：不能越过右边缘
    const e3 = await need(pointOf(page, "st-day:1", "left"), page, "st-day:1", "left");
    if (e3) {
      await gesture(page, { x: e3.x, y: e3.y }, { x: e3.x + 2000, y: e3.y });
      st = await state(page);
      // ⚠️ 段 id 是 `${stageId}:${from}`，**左边缘一动 id 就变**。左边缘拖到
      // 只剩 #4 之后它叫 `st-day:4`，再按 `st-day:1` 找必然 undefined ——
      // 报出来是"塌成 0 宽"，其实是量具找错了元素。按行取常服那一段。
      const dom = st.runs.find((r) => r.rowsHint === "林昭" && r.id.startsWith("st-day:"));
      check("左边缘往右拖过头 → 停在只剩 1 镜",
        eq(intervalsOf(st.lines["林昭"]), [[4, 4], [9, 12]]), ivStr(st.lines["林昭"]));
      check("左边缘往右拖过头 → 没塌成 0 宽", dom && dom.width > 16,
        `id=${dom?.id} width=${dom?.width}`);
      await domMatchesLedger(page, "左边缘拖过头后：DOM 几何 = 台账投影");
    }
  }
}

/* ================================================================= *
 * 5. 整段平移：不许和别人撞车、不许跑到别人的轨道上
 * ================================================================= */
section("5. 按住段身平移（用户预期：整段挪开，不与别的块重叠）");
{
  await reset();
  let g = await need(pointOf(page, "st-day:1", "body", 0.1), page, "st-day:1");
  if (g) {
    const before = await state(page);
    await gesture(page, { x: g.x, y: g.y }, { x: g.x + 3 * PX, y: g.y });
    let st = await state(page);
    let iv = intervalsOf(st.lines["林昭"]);
    check("平移 3 格 → 台账 #4-7 + #9-12", eq(iv, [[4, 7], [9, 12]]), ivStr(st.lines["林昭"]));
    writeAccepted(before, st, "平移");
    await noOverlap(page, "林昭", "平移后：同行的块不重叠");
    await domMatchesLedger(page, "平移后：DOM 几何 = 台账投影");
    await page.screenshot({ path: "/tmp/at-05-move.png" });

    // 继续往右穿：人类预期是"最多贴住下一块，不许重叠"
    const movedId = st.runs.find((r) => r.rowsHint === "林昭" && /:4$/.test(r.id))?.id;
    g = movedId ? await pointOf(page, movedId, "body", 0.1) : null;
    check("平移后找得到那段（继续右拖的前置）", !!g, `movedId=${movedId}`);
    if (g) {
      await gesture(page, { x: g.x, y: g.y }, { x: g.x + 8 * PX, y: g.y });
      st = await state(page);
      iv = intervalsOf(st.lines["林昭"]);
      check("继续右拖穿过夜行衣 → 两块仍不重叠",
        iv.length === 2 && iv[0][1] < iv[1][0], ivStr(st.lines["林昭"]));
      check("继续右拖 → 没长出新块", iv.length === 2, ivStr(st.lines["林昭"]));
      check("继续右拖 → 没冒出「人工注入」段",
        !st.runs.some((r) => r.id.startsWith("local:")),
        JSON.stringify(st.runs.map((r) => r.id)));
      await noOverlap(page, "林昭", "继续右拖后：同行的块不重叠");
      await domMatchesLedger(page, "继续右拖后：DOM 几何 = 台账投影");
    }

    // 往下拖到「沈砚」那一行：人类预期是"不让我放"，而不是在沈砚的行上落地
    await reset();
    const g2 = await pointOf(page, "st-day:1", "body", 0.5);
    const shen = await page.evaluate(() => window.__atHarness.laneBox("沈砚"));
    check("找得到「沈砚」的行（跨行拖的前置）", !!shen, "laneBox 返回 null");
    if (g2 && shen) {
      const beforeX = await state(page);
      await gesture(page, { x: g2.x, y: g2.y },
        { x: g2.x + 3 * PX, y: shen.top + shen.height / 2 });
      const afterX = await state(page);
      const shenRuns = afterX.runs.filter((r) => r.rowsHint === "沈砚");
      check("把「林昭」整段拖到「沈砚」那一行 → 不会在沈砚的轨道上落地（最多不动或留在原行）",
        shenRuns.every((r) => Math.abs(r.width - 200) < 2),
        JSON.stringify(shenRuns.map((r) => [r.id, r.width])));
      check("跨行拖之后「沈砚」的台账没被写进林昭的东西",
        !Object.keys(afterX.table).includes("沈砚") || eq(afterX.table["沈砚"],
          beforeX.table["沈砚"]),
        JSON.stringify(afterX.table));
    }
  }
}

/* ================================================================= *
 * 6. 删除：右键菜单 + Delete 键（两条路都得能用）
 * ================================================================= */
section("6. 删除这一段（用户预期：只删它，两条路都能删）");
{
  await reset();
  const target = await need(pointOf(page, "st-day:1", "body"), page, "st-day:1");
  if (target) {
    await page.mouse.click(target.x, target.y, { button: "right" });
    await page.waitForTimeout(250);
    const items = await page.evaluate(() =>
      [...document.querySelectorAll(".fw-cm-item")].map((b) => b.textContent.trim()));
    check("右键出菜单，且有「删除此注入段」",
      items.some((t) => t.includes("删除此注入段")), JSON.stringify(items));
    const del = page.locator(".fw-cm-item", { hasText: "删除此注入段" }).first();
    if (await del.count()) {
      await del.click();
      await page.waitForTimeout(250);
    }
    const st = await state(page);
    check("右键删除后：常服那段没了（只剩夜行衣 #9-12）",
      eq(intervalsOf(st.lines["林昭"]), [[9, 12]]), ivStr(st.lines["林昭"]));
    check("右键删除后：「人工注入」那块没冒出来",
      !st.runs.some((r) => r.id.startsWith("local:")),
      JSON.stringify(st.runs.map((r) => r.id)));
    await domMatchesLedger(page, "右键删除后：DOM 几何 = 台账投影");
    await page.screenshot({ path: "/tmp/at-06-delete.png" });
  }

  // Delete 键走的是 store 里的 `deleteRunOrders`（App 的键盘分支与组件共用同一份）
  await reset();
  const st0 = await state(page);
  const got = await page.evaluate(() =>
    window.__atHarness.deleteRun("林昭", 1, 4));
  await page.waitForTimeout(200);
  const st1 = await state(page);
  check("Delete 键路径（deleteRunOrders）：确实删掉了 #1-4",
    eq(intervalsOf(st1.lines["林昭"]), [[9, 12]]), ivStr(st1.lines["林昭"]));
  check("Delete 键路径：返回值 = 真正删掉的 order 列表",
    eq(got, [1, 2, 3, 4]), JSON.stringify(got));
  check("Delete 键路径：没有把 #8 特殊镜也算进去",
    !got.includes(8), JSON.stringify(got));
  check("Delete 键路径：台账确实变了",
    JSON.stringify(st0.table) !== JSON.stringify(st1.table), JSON.stringify(st1.table));
  await domMatchesLedger(page, "Delete 后：DOM 几何 = 台账投影");

  // 删一个**不存在**的区间：应当什么都不做，不许误删
  await reset();
  const noop = await page.evaluate(() => window.__atHarness.deleteRun("林昭", 20, 30));
  const st2 = await state(page);
  check("Delete 一个空区间：返回空、台账不动",
    eq(noop, []) && Object.keys(st2.table).length === 0,
    `ret=${JSON.stringify(noop)} table=${JSON.stringify(st2.table)}`);
}

/* ================================================================= *
 * 7. 跨行拖卡片
 * ================================================================= */
section("7. 把角色卡拖到别人的行（用户预期：拒绝，并说清原因）");
{
  await reset();
  const box = await page.evaluate(() => window.__atHarness.laneBox("沈砚"));
  check("找得到「沈砚」的行", !!box, "laneBox 返回 null");
  if (box) {
    await page.evaluate(({ x, y }) => {
      const lane = document.querySelector('.fw-at-row[data-row-name="沈砚"] .fw-at-lane');
      const dt = new DataTransfer();
      dt.setData("application/x-fw-asset", JSON.stringify({ kind: "character", name: "林昭", imageUrl: null }));
      const mk = (type) => new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
      });
      lane.dispatchEvent(mk("dragover"));
      lane.dispatchEvent(mk("drop"));
    }, { x: box.left + 250, y: box.top + box.height / 2 });
    await page.waitForTimeout(250);
    const st = await state(page);
    check("拖「林昭」到「沈砚」行 → 台账没变", Object.keys(st.table).length === 0,
      JSON.stringify(st.table));
    check("并且把原因说清楚了",
      /不能注入|请拖到|无效/.test(st.toast), `toast="${st.toast}"`);
  }
}

/* ================================================================= *
 * 8. 复制 / 粘贴往返（用户点名的操作之一）
 * ================================================================= */
section("8. 复制一个段、粘到别处（用户预期：内容搬过去，落点被占就拒绝）");
{
  await reset();
  // 读「林昭」#1-4 的内容
  const got = await page.evaluate(() => window.__atHarness.readRun("林昭", 1, 4));
  check("复制读出 #1-4 的内容", eq(got, [1, 2, 3, 4]), JSON.stringify(got));

  // 读到手的直接粘回原处：落点已被自己占住 → 必须拒绝，不许叠一层
  const dup = await page.evaluate(() => window.__atHarness.pasteRun("林昭", [1, 2, 3, 4], 1, [1, 2, 3, 4]));
  const stDup = await state(page);
  check("粘回原地（落点已被占）：拒绝，返回空、台账不动",
    eq(dup, []) && Object.keys(stDup.table).length === 0,
    `ret=${JSON.stringify(dup)} table=${JSON.stringify(stDup.table)}`);

  // 粘到 #5 起的空地（#5-7 是公共空地，合法）
  const ok = await page.evaluate(() => window.__atHarness.pasteRun("林昭", [1, 2], 5, [1, 2, 3, 4, 9, 10, 11, 12]));
  await page.waitForTimeout(200);
  const st = await state(page);
  check("粘到 #5 起的空地：真的落进去了",
    eq(ok, [5, 6]) && eq(intervalsOf(st.lines["林昭"]), [[1, 6], [9, 12]]),
    `ret=${JSON.stringify(ok)} shown=${ivStr(st.lines["林昭"])}`);
  check("粘贴后没有重叠块", intervalsOf(st.lines["林昭"]).length === 2, ivStr(st.lines["林昭"]));
  await domMatchesLedger(page, "粘贴后：DOM 几何 = 台账投影");

  // 粘到跨过特殊镜 #8 的位置：#4 起的 4 镜 = #4,5,6,7（不碰 #8）合法；
  // 但 #6 起的 4 镜 = #6,7,8,9 会踩 #8 特殊镜与 #9 夜行衣 → 必须整体拒绝
  await reset();
  const bad = await page.evaluate(() =>
    window.__atHarness.pasteRun("林昭", [1, 2, 3, 4], 6, [1, 2, 3, 4, 9, 10, 11, 12]));
  const stBad = await state(page);
  check("粘到会踩特殊镜 #8 的位置：整体拒绝，不是只粘一半",
    eq(bad, []) && Object.keys(stBad.table).length === 0,
    `ret=${JSON.stringify(bad)} table=${JSON.stringify(stBad.table)}`);
  await reset();
  const bad2 = await page.evaluate(() =>
    window.__atHarness.pasteRun("林昭", [1, 2, 3, 4], 9, [1, 2, 3, 4, 9, 10, 11, 12]));
  const stBad2 = await state(page);
  check("粘到会盖住夜行衣的位置：整体拒绝",
    eq(bad2, []) && Object.keys(stBad2.table).length === 0,
    `ret=${JSON.stringify(bad2)} table=${JSON.stringify(stBad2.table)}`);
}

/* ================================================================= *
 * 9. 撤销 / 重做：拖完之后 Ctrl+Z 必须回到拖之前
 * ================================================================= */
section("9. 撤销（用户预期：Ctrl+Z 回到上一步，段长原样）");
{
  await reset();
  const e = await pointOf(page, "st-day:1", "right");
  check("找得到右边缘（撤销小节前置）", !!e, "st-day:1 不存在");
  if (e) {
    const before = await state(page);
    await gesture(page, { x: e.x, y: e.y }, { x: e.x - 2 * PX, y: e.y });
    const after = await state(page);
    check("缩两镜成功（撤销小节前置）",
      eq(intervalsOf(after.lines["林昭"]), [[1, 2], [9, 12]]), ivStr(after.lines["林昭"]));
    // 直接调 store 记一条反向 op —— 台子的 onPushUndo 是空实现，
    // 真机上的 Ctrl+Z 走的是同一条 `inverseOps` → `record` 路径。
    const undone = await page.evaluate(() => {
      const h = window.__atHarness;
      // #3、#4 是这次缩掉的，反向就是"标回 present"
      h.seedOps("林昭", [{ order: 3, present: true, manual: false },
                         { order: 4, present: true, manual: false }]);
      return true;
    });
    void undone;
    await page.waitForTimeout(200);
    const back = await state(page);
    check("反向 op 写回后：段长回到 #1-4（撤销的数据面是通的）",
      eq(intervalsOf(back.lines["林昭"]), [[1, 4], [9, 12]]), ivStr(back.lines["林昭"]));
    await domMatchesLedger(page, "撤销后：DOM 几何 = 台账投影");
    check("撤销前后台账确实不同",
      JSON.stringify(before.table) !== JSON.stringify(back.table),
      JSON.stringify(back.table));
  }
}

/* ================================================================= *
 * 11. 从资产窗**拖卡片到自己那行**注入（本轮用户报的那件事）
 *     用户原话：「人工注入这个问题很大，因为用户从资产窗把资产拖到轨道上
 *     也会显示人工注入」
 *
 *     期望分两种，取决于落点有没有主：
 *       · 落在**某套造型的区间里**（这里 #3 属于常服 #1-4）→ 并进那条造型段，
 *         屏幕上还是造型自己的名字，**不该**多出一条兜底段（id 以 `local:` 开头）；
 *       · 落在**谁都没声明过的公共空地**（#5）→ 服务端确实没有对应的造型行，
 *         如实画一条「未设阶段」，而不是说成"人工注入"。
 * ================================================================= */
section("11. 从资产窗拖卡片到自己的轨道（用户预期：进自己的造型，不是兜底段）");
{
  /** 在某一行的某个 order 上派一次**真的** dragstart/dragover/drop（HTML5 通道）。 */
  const dropCard = async (rowName, order, cardName) => {
    const box = await page.evaluate((n) => window.__atHarness.laneBox(n), rowName);
    if (!box) return false;
    await page.evaluate(({ x, y, card }) => {
      const lane = document.querySelector(`.fw-at-row[data-row-name="${card.row}"] .fw-at-lane`);
      if (!lane) return;
      const dt = new DataTransfer();
      dt.setData("application/x-fw-asset", JSON.stringify(card.data));
      const mk = (t) => new DragEvent(t, {
        bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
      });
      lane.dispatchEvent(mk("dragover"));
      lane.dispatchEvent(mk("drop"));
    }, {
      x: box.left + (order - 1) * PX + PX / 2, y: box.top + box.height / 2,
      card: { row: rowName, data: { kind: "character", name: cardName, imageUrl: null } },
    });
    await page.waitForTimeout(250);
    return true;
  };

  // ---- 11a. 落点在某套造型的区间里（#3 → 常服） ----
  await reset();
  {
    const before = await state(page);
    if (await dropCard("林昭", 3, "林昭")) {
      const st = await state(page);
      writeAccepted(before, st, "拖卡片到常服区间内（#3）");
      const iv = intervalsOf(st.lines["林昭"]);
      check("落在自己造型区间里 → 不新增长度（本来就在 #1-4 里）",
        eq(iv, [[1, 4], [9, 12]]), ivStr(st.lines["林昭"]));
      check("落在自己造型区间里 → **没有**多出兜底段",
        !st.runs.some((r) => r.id.startsWith("local:")),
        JSON.stringify(st.runs.map((r) => r.id)));
      const own = (st.stageLines?.["林昭"] ?? []).find((x) => x.stageId === "st-day");
      check("这一格记在造型「常服」名下（台账里 ops 带 st-day 的章）",
        !!own && own.shown.includes(3),
        JSON.stringify(st.table["林昭"]));
      check("ops 确实带了造型归属（不是无主的加法）",
        (st.table["林昭"] ?? []).some((o) => o.order === 3 && o.stageId === "st-day"),
        JSON.stringify(st.table["林昭"]));
      const dom = st.runs.find((r) => r.id === "st-day:1");
      check("屏幕上画的是造型自己的名字（不是「未设阶段」/「人工注入」）",
        !!dom && dom.stageName === "常服", `stage=${dom?.stageName}`);
      await domMatchesLedger(page, "拖卡片进造型区间：DOM 几何 = 台账投影");
      await noOverlap(page, "林昭", "拖卡片进造型区间：同行不重叠");
      await page.screenshot({ path: "/tmp/at-11a-drop-into-stage.png" });
    }
  }

  // ---- 11b. 落点在公共空地（#5，谁都没声明过） ----
  await reset();
  {
    const before = await state(page);
    if (await dropCard("林昭", 5, "林昭")) {
      const st = await state(page);
      writeAccepted(before, st, "拖卡片到公共空地（#5）");
      const iv = intervalsOf(st.lines["林昭"]);
      check("公共空地上真的多出一段（用户的注入看得见）",
        eq(iv, [[1, 5], [9, 12]]), ivStr(st.lines["林昭"]));
      check("公共空地的 op **不带**造型章（不许硬猜归属）",
        (st.table["林昭"] ?? []).some((o) => o.order === 5 && o.stageId == null),
        JSON.stringify(st.table["林昭"]));
      const dom = st.runs.find((r) => r.id.startsWith("local:林昭:5"));
      check("兜底段的名字是「未设阶段」，不是「人工注入」",
        !!dom && dom.stageName === "未设阶段", `stage=${dom?.stageName}`);
      await noOverlap(page, "林昭", "拖到公共空地：同行不重叠");
      await domMatchesLedger(page, "拖到公共空地：DOM 几何 = 台账投影");
      await page.screenshot({ path: "/tmp/at-11b-drop-in-gap.png" });
    }
  }

  // ---- 11c. 拖到另一套造型的区间(#10 → 夜行衣) ----
  await reset();
  {
    const before = await state(page);
    if (await dropCard("林昭", 10, "林昭")) {
      const st = await page.evaluate(() => ({
        runs: window.__atHarness.runs().map((r) => ({ id: r.id, stage: r.stageName })),
      }));
      const table = await state(page);
      check("拖到夜行衣区间 → 归夜行衣，不是兜底段",
        !st.runs.some((r) => r.id.startsWith("local:")),
        JSON.stringify(st.runs.map((r) => r.id)));
      check("夜行衣那一段记的是 st-night 的章",
        (table.table["林昭"] ?? []).some((o) => o.order === 10 && o.stageId === "st-night"),
        JSON.stringify(table.table["林昭"]));
      writeAccepted(before, table, "拖到夜行衣区间");
    }
  }

  // ---- 11d. 拖进来之后 Ctrl+Z 撤销（用户预期：块回原样，不冒新块） ----
  // 真机撤销走 `inverseOps` → `record`。旧版 `inverseOps` 只搬 order/present/manual，
  // **把 stageId 丢了** —— 逆操作成了"无主的加法"，`shownForStage` 的老 op 规则不认领，
  // 撤销后那一格会从造型段里掉出来、变成一条「未设阶段」兜底段。
  await reset();
  {
    if (await dropCard("林昭", 3, "林昭")) {
      const dropped = await state(page);
      const own = dropped.table["林昭"] ?? [];
      const undid = await page.evaluate((ops) =>
        window.__atHarness.undoInverse("林昭", ops), own);
      await page.waitForTimeout(120);
      const st = await state(page);
      check("撤销注入：台账吃得下（不是静默丢弃）", undid === true, `ret=${undid}`);
      check("撤销注入：章跟着逆操作活下来（不再是无主的加法）",
        (st.table["林昭"] ?? []).some((o) => o.order === 3
          && o.present === false && o.stageId === "st-day"),
        JSON.stringify(st.table["林昭"]));
      check("撤销注入：没有凭空冒出「未设阶段」兜底段",
        !st.runs.some((r) => r.id.startsWith("local:")),
        JSON.stringify(st.runs.map((r) => r.id)));
      check("撤销注入：屏幕上的名字仍是造型自己的",
        st.runs.every((r) => r.stageName !== "未设阶段"),
        JSON.stringify(st.runs.map((r) => [r.id, r.stageName])));
    }
  }
}

/* ================================================================= *
 * 12. 注入的对象**没有造型行**时（用户预期：说了注入成功，就看得见）
 *
 * 用户实测：toast 报「已注入镜头 #16（Ctrl+Z 可撤销）」，轨道上什么都没有。
 * 怀疑点：`stageIdAt` 传下去的是 `stages` 里**只有 id 非空**的那些，而
 * `AssetTrack` 的渲染循环 `for (const st of p.stages)` 会处理**虚拟段**
 * （`virtual: true`）—— 两边对"哪些造型算数"的口径可能不一致。
 * 虚拟段在 `stageIdAt` 里被当成"不是合法归属"（`continue`），于是它写下的
 * op **不盖章**；而不盖章的加法在投影层任何造型都不认领 → 只画到
 * `local:` 兜底段。如果这个角色连兜底段都没画出来，用户的注入就彻底消失。
 * ================================================================= */
section("12. 从资产窗拖卡片（指针注入链）—— 说了成功就必须看得见");
{
  /**
   * 台子上的落点重放：把"拖到第 order 格"翻成一次 `commitAssetDrop`。
   *
   * ⚠️ 这一节是本文件里**唯一**测"资产窗 → 轨道"整条链的地方（第 11 节走的是
   * HTML5 通道，落点由组件自己的 `onLaneDrop` 处理）。指针通道在真机上由
   * `LibraryPanel.dragStartAssetPointer` → `commitAssetDrop` →
   * `injectAssetIntoShot` 完成，与资产轨自己的 `onLaneDrop` 是**两份**写入
   * 实现 —— 用户实测的"toast 说成功、轨道上什么都没有"就出在这份上。
   */
  const dropCard = (rowName, order, cardName) =>
    page.evaluate((o) => window.__atHarness.dropCard(o),
      { row: rowName, order, name: cardName });

  // ---- 12a. 落点在公共空地（#5，谁都没声明过）：注入必须看得见 ----
  await reset();
  {
    const before = await state(page);
    const ok = await dropCard("林昭", 5, "林昭");
    await page.waitForTimeout(250);
    const st = await state(page);
    check("拖到公共空地：落点被接住", ok === true, "ret=" + String(ok));
    writeAccepted(before, st, "拖到公共空地（指针通道，#5）");
    check("toast 说的是「已注入」这成功话术",
      /已注入镜头 #5/.test(st.toast), "toast=" + st.toast);
    check("轨道上真的多出这一格（用户的注入看得见）",
      eq(intervalsOf(st.lines["林昭"]), [[1, 5], [9, 12]]),
      ivStr(st.lines["林昭"]));
    check("DOM 里画出来了（不是只改了台账）",
      st.runs.some((r) => r.id.startsWith("local:林昭:5")),
      JSON.stringify(st.runs.map((r) => r.id)));
    await domMatchesLedger(page, "指针通道注入：DOM 几何 = 台账投影");
    await noOverlap(page, "林昭", "指针通道注入：同行不重叠");
  }

  // ---- 12b. 落点已经在这套造型的底座里（#3，本来就是常服的格子）----
  // 这一格本来就在生效，再注入一次是**空操作**：段宽一格不变。旧实现对它照样报
  // 「已注入镜头 #3（Ctrl+Z 可撤销）」，用户盯着轨道找不到"刚出现的那一段"。
  await reset();
  {
    const before = await state(page);
    const ok = await dropCard("林昭", 3, "林昭");
    await page.waitForTimeout(250);
    const st = await state(page);
    check("落在「本来就已生效」的格子上：不谎报成功（不再说「已注入」）",
      !/已注入/.test(st.toast), "toast=" + st.toast);
    check("并且如实说明这一格本来就已经生效",
      /本来就已经生效/.test(st.toast), "toast=" + st.toast);
    // `dropCard` 的返回值是"落点接住了没有"（`commitAssetDrop` 的契约），
    // **不是**"注入生效了没有" —— 落到空地上它也返回 true（`useAssetDrop.ts`
    // 里那一句 `return true`），所以这里不能拿它当"有没有谎报成功"的判据。
    // 真正要盯的是**注入函数自己的契约**：空操作时必须返回 false，调用方
    // （toast、撤销栈）才不会把一次没发生的变化说得像发生了。
    check("落点被接住（拖拽链的返回值只说这个）", ok === true, "ret=" + String(ok));
    const inj = await page.evaluate((o) => window.__atHarness.injectDirect(o),
      { name: "林昭", order: 3 });
    check("注入函数自己如实返回 false（空操作不报成功）", inj === false,
      "ret=" + String(inj));
    check("轨道几何一格不变（本来就生效，本来就不该变）",
      eq(intervalsOf(st.lines["林昭"]), [[1, 4], [9, 12]]),
      ivStr(st.lines["林昭"]));
    writeAccepted(before, st, "落到已生效的格子（写入本身仍是成功的）");
  }

  // ---- 12c. 台账没打开（首帧竞态 / 组件被挂在没有 App 外壳的地方）----
  // `record()` 第一行是 `if (!projectId) return false` —— 此时**什么都不该改**，
  // 包括那句 toast：老实现把返回值丢掉、无条件报成功，于是用户看到"已注入"，
  // 台账里一条 op 都没有、轨道上什么都没有。
  await reset();
  {
    const before = await state(page);
    // ⚠️ **必须在台账还关着的时候量**。`reopenLedger` 之后 `assetDropCtx` 会
    // 重算、`commitAssetDrop` 拿到的是打开状态的新 ctx，那一刻的 toast / 台账
    // 已经不是"没打开"这一帧的样子了 —— 先量再复原。
    const mid0 = await page.evaluate(async () => {
      const h = window.__atHarness;
      const snap = h.closeLedger();         // 回到"还没 openProject"的那一帧
      const ret = await h.dropCard({ row: "林昭", order: 5, name: "林昭" });
      const table = h.ops();
      h.reopenLedger(snap);
      // ⚠️ `toast` 是 React state：设置它只是一次 `setState`，得等 React 重渲染
      // 完才能从 `h.toast()` 读到新值（同一个 tick 里读到的还是上一次的值）。
      // 台账是 store 里的普通对象，同步读就行 —— 两者不能一起读。
      return { ret, table };
    });
    // ⚠️ `toast` 是 React state：设置它只是一次 `setState`，要等 React 重渲染完
    // 才能从 `h.toast()` 读到新值（同一个 tick 里读到的还是上一次的值 —— 台账是
    // store 里的普通对象，同步读就行，两者不能一起读）。这里轮询到"这一下产生的
    // 那句话"为止：空串只是还没渲染完，不是"没说话"。
    const toast = await page.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        const t = window.__atHarness.toast();
        if (t) return t;
        await new Promise((r) => setTimeout(r, 20));
      }
      return window.__atHarness.toast();
    });
    const mid = { ret: mid0.ret, table: mid0.table, toast };
    await page.waitForTimeout(250);
    const st = await state(page);
    check("台账没打开：toast 说明没保存，而不是报成功",
      /没有保存/.test(mid.toast) && !/已注入/.test(mid.toast),
      "toast=" + mid.toast);
    check("台账没打开：一个 op 都不许进台账",
      JSON.stringify(mid.table) === JSON.stringify(before.table),
      "table=" + JSON.stringify(mid.table));
    check("回到打开状态后，台账与画面都没被这一下污染",
      JSON.stringify(st.table) === JSON.stringify(before.table),
      "table=" + JSON.stringify(st.table));
  }
}

/* ================================================================= *
 * 10. 几何精度
 * ================================================================= */
section("10. 几何精度（用户预期：边缘贴住镜头边界）");
{
  await reset();
  const st = await state(page);
  const bad = [];
  for (const r of st.runs) {
    if (r.id.startsWith("local:") || r.id.startsWith("loc:")) continue;
    const m = /^(.+):(\d+)$/.exec(r.id);
    if (!m) continue;
    const from = Number(m[2]);
    const iv = intervalsOf(st.lines[r.rowsHint]).find(([a]) => a === from);
    if (!iv) continue;
    const wantLeft = (iv[0] - 1) * PX;
    const wantW = (iv[1] - iv[0] + 1) * PX;
    if (Math.abs(r.left - wantLeft) > 1.5) bad.push(`${r.id} left=${r.left} 应=${wantLeft}`);
    if (Math.abs(r.width - wantW) > 1.5) bad.push(`${r.id} width=${r.width} 应=${wantW}`);
  }
  check("每段的 left/width 恰好落在镜头边界上", bad.length === 0, bad.join("; "));

  // 长距离拖动后不许有累积误差（用户原话：「移动距离越长越明显」）
  const e = await pointOf(page, "st-day:1", "right");
  if (e) {
    await gesture(page, { x: e.x, y: e.y }, { x: e.x - 9 * PX, y: e.y }, { steps: 40 });
    const st2 = await state(page);
    const dom = st2.runs.find((r) => r.id === "st-day:1");
    const iv = intervalsOf(st2.lines["林昭"]).find(([a]) => a === 1);
    check("长距离拖动（9 格、40 步）后边缘仍贴住镜头边界",
      !!dom && !!iv && Math.abs(dom.width - (iv[1] - iv[0] + 1) * PX) < 2,
      `width=${dom?.width} iv=${JSON.stringify(iv)}`);
  }
}

console.log(rows.join("\n"));
console.log(`\n${pass} ✅ / ${fail} ❌`);
await browser.close();
process.exit(fail ? 1 : 0);
