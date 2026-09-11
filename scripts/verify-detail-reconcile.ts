/**
 * scripts/verify-detail-reconcile.ts — U2 第 3 点：detail 刷新时复用未变动对象的引用
 *
 * 分四节：
 *   [1] `deepEqual` 的边界（漏一条就等于"复用了内容其实不同的对象"）
 *   [2] `reconcileDetail` 的复用与**不复用**规则
 *   [3] 接线（源码断言）：useProject 真的调了它；ShotsPanel 传给 ShotCard 的回调恒定
 *   [4] 1424 镜规模下的成本（复用本身不能比它省下的还贵）
 *
 * ## 这条为什么必须钉住
 *
 * 引用复用的失败形态分两种，**都不会报错**：
 *
 *   · 复用过头（比较写松了）→ 界面显示的是旧数据。用户看到"生成完了但缩略图没换"，
 *     刷新一下又好了 —— 这种 bug 会被当成网络问题查很久。
 *   · 复用不到（比较写严了，或某处又把对象克隆了一遍）→ 优化静默失效，
 *     回到 1424 张卡片全量重渲染，而代码看起来完全正确。
 *
 * 所以 [2] 节既断言"该复用的复用了"，也断言"**不该复用的没复用**"（顺序变、
 * 内容变、换项目）；[3] 节把接线钉在源码里，防止哪天有人在 refreshDetail 里
 * 顺手把 reconcile 去掉（那会让第 [1][2] 节全绿而收益为零）。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectDetail, ShotInfo, AssetInfo, EpisodeInfo } from "../src/api";
import { deepEqual, emptyStats, reconcileDetail } from "../src/lib/reconcileDetail";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const shot = (i: number, over: Partial<ShotInfo> = {}): ShotInfo => ({
  id: `s${i}`, order: i, episode: 1 + Math.floor(i / 10), script_ref: `第${i}镜`,
  link_to_prev: "cut", characters: ["林夏"], location: "客厅",
  video_url: null, thumb_url: null, status: "pending", adopted_version: null,
  is_special: false, gen_prompt: null, stale: false, prompt_state: "draft",
  duration_sec: 5, disabled: false, special_name: null, ref_overrides: null,
  refs_stale: false, first_frame_url: null, profile_override: null, ...over,
});
const asset = (i: number, over: Partial<AssetInfo> = {}): AssetInfo => ({
  id: `a${i}`, kind: "character", name: `角色${i}`, image_url: null, ...over,
} as AssetInfo);
const epi = (o: number, over: Partial<EpisodeInfo> = {}): EpisodeInfo => ({
  order: o, title: `第${o}集`, word_count: 1200, ...over,
});
const detail = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1", title: "测试项目", base_aspect: "9:16", production_mode: "live_action",
  episodes: [epi(1), epi(2)], raw_script: "正文", optimized_script: null,
  shots: [shot(1), shot(2), shot(3)], assets: [asset(1), asset(2)], ...over,
});
/** 深拷贝：模拟"服务端又回了一份一模一样的 JSON"（每个对象都是新的） */
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ───────────────────────────────────────────────────────────────────────
console.log("\n[1] deepEqual 边界");
{
  ok(deepEqual(1, 1) && deepEqual("a", "a") && deepEqual(null, null), "标量相等");
  ok(!deepEqual(1, "1"), "★ 不做类型宽松比较（1 与 \"1\" 不等）");
  ok(!deepEqual(null, undefined), "null 与 undefined 不等");
  ok(!deepEqual(0, null) && !deepEqual("", null), "假值之间不混同");
  ok(deepEqual({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } }), "嵌套对象相等");
  ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), "★ 键序不影响结果（这是不用 JSON.stringify 的理由）");
  ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }),
    "★ 多一个值为 undefined 的键 → 不等（键数不同；否则「字段被清空」会被判成没变）");
  ok(!deepEqual([1, 2], [2, 1]), "数组按序比较");
  ok(!deepEqual([1, 2], [1, 2, 3]), "数组长度不同 → 不等");
  ok(!deepEqual({ a: [1] }, { a: [1, 2] }), "嵌套数组长度差异能发现");
  ok(!deepEqual([1, 2], { 0: 1, 1: 2 }), "数组与对象不等");
  const big = shot(1, { gen_prompt: "x".repeat(5000) });
  ok(deepEqual(big, clone(big)), "长文本字段（提示词）也能判等");
  ok(!deepEqual(shot(1), shot(1, { video_url: "/a.mp4" })), "单个字段变动能发现");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[2] reconcileDetail 的复用规则");
{
  const prev = detail();

  // 首次加载：没有可复用的东西，原样返回
  const first = reconcileDetail(null, prev);
  ok(first === prev, "prev=null → 原样返回（首次加载 / 切项目后）");

  // 服务端回了一份内容相同的新 JSON → 连顶层对象都该复用
  const same = reconcileDetail(prev, clone(prev));
  ok(same === prev, "★ 内容完全相同 → 连 detail 顶层引用都复用（一次白跑的兜底刷新 = 零渲染）");

  // 只有一个镜头变了
  const nx = clone(prev);
  nx.shots[1] = { ...nx.shots[1], video_url: "/fw/media/generated/new.mp4", status: "adopted" };
  const st = emptyStats();
  const one = reconcileDetail(prev, nx, st);
  ok(one !== prev, "有变动 → 顶层换新引用（否则 React 根本不会重渲染）");
  ok(one.shots[0] === prev.shots[0] && one.shots[2] === prev.shots[2],
    "★ 未变动的镜头保持原引用（这一条就是 1424→1 张卡片重渲染的全部来源）");
  ok(one.shots[1] !== prev.shots[1] && one.shots[1].video_url === "/fw/media/generated/new.mp4",
    "变动的镜头换成新对象且内容正确");
  ok(one.shots !== prev.shots, "数组本身换新引用（有一项变了，依赖 shots 的 useMemo 必须重算）");
  ok(one.assets === prev.assets && one.episodes === prev.episodes,
    "★ 没被碰过的列表整个复用（资产页/分集不该因为出了一个片就重渲染）");
  ok(st.reused.shots === 2 && st.total.shots === 3, "复用统计正确", JSON.stringify(st.reused));

  // 顺序变了（用户拖动镜头）
  const sw = clone(prev);
  [sw.shots[0], sw.shots[1]] = [sw.shots[1], sw.shots[0]];
  const swapped = reconcileDetail(prev, sw);
  ok(swapped.shots !== prev.shots,
    "★ 只是顺序变了也必须换数组引用（否则分集分组/时间轴排布拿着旧顺序不重算）");
  ok(swapped.shots[0] === prev.shots[1] && swapped.shots[1] === prev.shots[0],
    "顺序变动时两项内容未变 → 仍复用各自的对象（只是位置换了）");

  // 增删
  const added = reconcileDetail(prev, { ...clone(prev), shots: [...clone(prev).shots, shot(4)] });
  ok(added.shots.length === 4 && added.shots[0] === prev.shots[0],
    "新增镜头（补拆一集）→ 旧镜头仍复用");
  const removed = reconcileDetail(prev, { ...clone(prev), shots: clone(prev).shots.slice(1) });
  ok(removed.shots.length === 2 && removed.shots[0] === prev.shots[1],
    "★ 删掉第一个镜头后，其余按 id 配对复用（按下标配对会在这里复用出一整片错位数据）");

  // 换项目
  const other = reconcileDetail(prev, { ...clone(prev), id: "p2" });
  ok(other.id === "p2" && other.shots[0] !== prev.shots[0],
    "★ 换项目 → 整份换掉（按 id 配对本来也配不上，白比一遍）");

  // 顶层标量
  const renamed = reconcileDetail(prev, { ...clone(prev), title: "改了名" });
  ok(renamed !== prev && renamed.title === "改了名" && renamed.shots === prev.shots,
    "只改了项目名 → 顶层换引用、镜头数组整个复用");

  // 分集按 order 配对（EpisodeInfo 没有 id）
  const epChanged = clone(prev);
  epChanged.episodes = [epi(1), epi(2, { title: "第二集·改" })];
  const ep2 = reconcileDetail(prev, epChanged);
  ok(ep2.episodes[0] === prev.episodes[0] && ep2.episodes[1] !== prev.episodes[1],
    "分集按 order 配对复用（它没有 id）");

  // 不许改动入参
  const pSnap = JSON.stringify(prev), nSnap = JSON.stringify(nx);
  reconcileDetail(prev, nx);
  ok(JSON.stringify(prev) === pSnap && JSON.stringify(nx) === nSnap,
    "★ 纯函数：prev 与 next 都不被改写");

  // 老后端少字段 / 多字段
  const lean = clone(prev) as unknown as Record<string, unknown>;
  delete lean.optimized_script;
  const leanOut = reconcileDetail(prev, lean as unknown as ProjectDetail);
  ok(leanOut !== prev, "★ 服务端少回一个字段 → 不判为相同（键数变了就是变了）");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[3] 接线");
{
  const UP = read("src/hooks/useProject.ts");
  ok(/import \{ reconcileDetail \} from "\.\.\/lib\/reconcileDetail"/.test(UP),
    "useProject 引入了 reconcileDetail");
  ok(/const d = reconcileDetail\(detailRef\.current, raw\);/.test(UP),
    "★ 用**上一轮的 detail**（detailRef）做基准（用 state 里的 detail 会拿到闭包旧值）");
  const idxRec = UP.indexOf("reconcileDetail(detailRef.current");
  const idxSeq = UP.indexOf("if (my !== seq.current) return;");
  ok(idxSeq > 0 && idxRec > idxSeq,
    "★ 复用发生在序号校验**之后**（过期响应不该参与复用，更不该覆盖新数据）");
  ok(/setDetail\(d\);\s*\n\s*detailRef\.current = d;/.test(UP),
    "state 与 detailRef 存的是**同一个**复用后的对象（不同步会让下一轮全不复用）");

  const SP = read("src/components/ShotsPanel.tsx");
  ok(/const latest = useRef\(p\);\s*\n\s*latest\.current = p;/.test(SP),
    "ShotsPanel 用「最新值 ref」兜住 App 每次渲染新建的 handler");
  for (const cb of ["onSelect", "onAdvanced", "onSwitchVersion", "onGenerate", "onReprompt"]) {
    ok(new RegExp(`const ${cb} = useCallback\\(`).test(SP)
      && new RegExp(`latest\\.current\\.${cb}\\(`).test(SP),
      `${cb} 有恒定引用的包装，且转发给最新的一份`);
    ok(new RegExp(`${cb}=\\{${cb}\\}`).test(SP) && !new RegExp(`${cb}=\\{p\\.${cb}\\}`).test(SP),
      `★ 传给 ShotCard 的是包装而不是 p.${cb}（直传等于 memo 全年失效）`);
  }
  ok(/const toggleExpand = useCallback\(/.test(SP) && /const toggleSel = useCallback\(/.test(SP),
    "展开/多选切换也是恒定引用（它们本来每次渲染都新建）");
  ok(/useCallback\(\s*\(id: string\) => setExpanded\(\(prev\) =>/.test(SP)
    || /setExpanded\(\(prev\) =>/.test(SP),
    "★ 这两个回调用的是 setState 更新函数形式 —— 所以依赖数组可以是空的（不会读到旧值）");
  ok(/const byEpisode = useMemo\(/.test(SP) && /\}, \[p\.shots\]\);/.test(SP),
    "分集分组走 useMemo（1424 镜时每次渲染重建 Map 是白花的）");
  ok(/const episodeGroups = useMemo\(/.test(SP)
    && !/\[\.\.\.byEpisode\.entries\(\)\]\.sort\([^)]*\)\.map/.test(SP),
    "分组排序也 memo 掉了（原来写在 JSX 里，每次渲染排一遍）");
}

// ───────────────────────────────────────────────────────────────────────
console.log("\n[4] 1424 镜规模下的成本");
{
  const N = 1424;
  const shots = Array.from({ length: N }, (_, i) => shot(i, {
    gen_prompt: "中景，林夏站在客厅落地窗前，暖调侧逆光，浅景深。".repeat(2),
    script_ref: `第${i}镜：${"人物对话与动作描写".repeat(3)}`,
  }));
  const prev = detail({ shots });
  const next = clone(prev);
  next.shots[700] = { ...next.shots[700], video_url: "/x.mp4", status: "adopted" };

  const t0 = performance.now();
  const st = emptyStats();
  const out = reconcileDetail(prev, next, st);
  const ms = performance.now() - t0;
  ok(st.reused.shots === N - 1, `${N} 镜里复用 ${st.reused.shots} 个（只有 1 个真变了）`);
  ok(out.shots[700] !== prev.shots[700], "变动那一镜换了新对象");
  // 参考值：同机实测 ~10 ms 量级。这里只设一个宽松上界防"某天写成 O(n²)"，
  // 不把具体毫秒数当门禁（不同机器会飘，卡门禁只会制造假红）。
  ok(ms < 300, `一次全量比较 ${ms.toFixed(1)} ms（上界 300 ms）`);
  console.log(`   ℹ️  ${N} 镜深比较耗时 ${ms.toFixed(1)} ms；`
    + `同一次刷新里它换掉的是"1424 张卡片重渲染"（实测 18.9 ms → 4.5 ms，见 scripts/bench-shots.ts）`);

  // 全不变的那一次（兜底轮询最常见的情况）：必须整份复用
  const t1 = performance.now();
  const same = reconcileDetail(prev, clone(prev));
  const ms2 = performance.now() - t1;
  ok(same === prev, "★ 什么都没变的一次刷新 → 整份复用，React 完全不工作");
  console.log(`   ℹ️  "什么都没变"这一次耗时 ${ms2.toFixed(1)} ms`);
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0
  ? "✅ detail 刷新只把真变了的镜头换成新对象；顺序变、换项目、字段增删都不会被误复用。"
  : "❌ 引用复用规则有断言不过 —— 别发布，先看上面第一条 ❌。");
process.exit(fail === 0 ? 0 : 1);
