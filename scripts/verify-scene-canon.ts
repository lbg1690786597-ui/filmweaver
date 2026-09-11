/**
 * scripts/verify-scene-canon.ts — U3 场景名归一面板的判断逻辑
 *
 * 后端那侧由 `backend/scripts/verify_scene_canon.py` 钉住（预览只读、报出的
 * 保留/删除与执行一致、确认只动那一组）。这一侧钉的是**界面说的话**：
 *
 *   [1] 后果分级：一组既删资产又推翻手改时，报的必须是更重的那个
 *   [2] 排序与分栏：会删资产的排最前，"已经是这样"的不混进待确认列表
 *   [3] 文案：说"会删掉 X"时点名的必须正好是会被删的那几行，且写清有没有图
 *   [4] 二次确认的触发条件（只对不可逆 / 覆盖手改，不对纯改映射）
 *   [5] 接线（源码断言）：面板打开时不自动跑 AI、确认走逐组入口、
 *       api.ts 没有把"一键全归一"那条路暴露出来
 *
 * ## 为什么这几条值得单独钉
 *
 * 归一里混着两种后果完全不同的操作：改映射（可逆）与合并场景资产（**不可逆**，
 * 被删那行可能已经出过图、花过钱）。这两种在数据结构上只差 `asset_merges`
 * 一个字段，一旦分级写错，界面会用同一个口吻把它们排在一起 —— 用户一路点下去，
 * 而其中一类点完就没了。这类错误 tsc 抓不到、跑起来也不报错。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenePreviewGroup, SceneGroup } from "../src/api";
import {
  confirmText, consequenceText, droppedAssets, groupRisk, groupSummary,
  hasAssetMerge, isIrreversible, mergedGroups, splitCanonical, splitPreview,
} from "../src/features/scenes/sceneGroups";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 造一组预览数据。默认是"只改映射"的可逆组。 */
const mem = (raw: string, over: Partial<ScenePreviewGroup["members"][0]> = {}) => ({
  raw_name: raw, shots: 3, current_canonical: raw, source: "ai",
  will_change: true, time_of_day: null, int_ext: null, ...over,
});
const grp = (over: Partial<ScenePreviewGroup> = {}): ScenePreviewGroup => ({
  canonical: "客厅", shots: 6, changed: true, locked: [],
  members: [mem("日 内 客厅"), mem("客厅", { will_change: false, current_canonical: "客厅" })],
  asset_merges: {}, ...over,
});
const withDrop = (over: Partial<ScenePreviewGroup> = {}) => grp({
  asset_merges: {
    keep: { name: "客厅", has_image: false },
    drop: [{ name: "日 内 客厅", has_image: true, deleted: false }],
  }, ...over,
});

console.log("\n[1] 后果分级");
ok(groupRisk(grp({ changed: false })) === "none", "无变化的组 → none");
ok(groupRisk(grp()) === "alias", "只改映射 → alias");
ok(groupRisk(grp({ locked: ["客厅"] })) === "override", "会推翻手改 → override");
ok(groupRisk(withDrop()) === "asset", "会删资产行 → asset");
ok(groupRisk(withDrop({ locked: ["客厅"] })) === "asset",
  "★ 既删资产又推翻手改 → 报更重的 asset（反过来会把「会删掉已出图的资产」这句吞掉）");
ok(groupRisk(grp({
  changed: false,
  asset_merges: { keep: { name: "客厅", has_image: true }, drop: [] },
})) === "none", "★ changed=false 一律 none（确认它真的什么都不会变）");
ok(!hasAssetMerge(grp()), "空的 asset_merges（后端给 {} 而不是 null）判为无合并");
ok(hasAssetMerge(withDrop()) && droppedAssets(withDrop()).length === 1,
  "有 drop 时判为有合并且能取出被删行");
ok(!hasAssetMerge(grp({
  asset_merges: { keep: { name: "客厅", has_image: false }, drop: [] },
})), "★ 有 keep 但 drop 为空 = 没有行会被删 → 不报不可逆");
ok(isIrreversible(withDrop()) && !isIrreversible(grp({ locked: ["客厅"] })),
  "不可逆只认「删资产」：推翻手改可以再改回来，删掉的图不能");

console.log("\n[2] 分栏与排序");
const groups: ScenePreviewGroup[] = [
  grp({ canonical: "A-只改映射", shots: 2 }),
  grp({ canonical: "B-已是这样", changed: false }),
  withDrop({ canonical: "C-删资产", shots: 1 }),
  grp({ canonical: "D-覆盖手改", locked: ["x"], shots: 9 }),
  grp({ canonical: "E-只改映射多镜", shots: 50 }),
];
const sp = splitPreview(groups);
ok(sp.unchanged.length === 1 && sp.unchanged[0].canonical === "B-已是这样",
  "★ 「已经是这样」的组不进待确认列表（否则用户要在几十条无变化里找那两条）");
ok(sp.actionable.map((g) => g.canonical).join(",")
  === "C-删资产,D-覆盖手改,E-只改映射多镜,A-只改映射",
  "★ 重的排前面（删资产 > 覆盖手改 > 只改映射），同级按影响镜头多的在前",
  sp.actionable.map((g) => g.canonical).join(","));
ok(sp.actionable.length + sp.unchanged.length === groups.length,
  "分栏不丢组（每组要么可操作要么无变化）");
ok(splitPreview([]).actionable.length === 0, "空建议不炸");
// 中文归一名排序：只有等值时才轮到名字，用 localeCompare 而非码点序
const tie = splitPreview([grp({ canonical: "张三巷", shots: 5 }),
  grp({ canonical: "阿城路", shots: 5 })]);
ok(tie.actionable[0].canonical === "阿城路",
  "★ 同级同镜数时按中文拼音序（localeCompare），不是 Unicode 码点序",
  tie.actionable.map((g) => g.canonical).join(","));

console.log("\n[3] 文案点名到具体后果");
const cons = consequenceText(withDrop());
ok(cons.includes("「日 内 客厅」"), "点名了会被删的那一行", cons);
ok(!cons.includes("「客厅」,") && cons.includes("已经出过图"),
  "★ 写明「被删那行已经出过图」（用户据此决定要不要先换图）", cons);
const consNoImg = consequenceText(grp({
  asset_merges: {
    keep: { name: "客厅", has_image: true },
    drop: [{ name: "日 内 客厅", has_image: false, deleted: false }],
  },
}));
ok(consNoImg.includes("都没出过图") && !consNoImg.includes("已经出过图"),
  "★ 被删行没图时不说「已出过图」（虚报后果会让用户学会无视警告）", consNoImg);
ok(consequenceText(grp()) === "", "只改映射的组没有后果要警告 → 空串");
ok(consequenceText(grp({ locked: ["老城区街道"] })).includes("老城区街道"),
  "推翻手改时点名是哪条映射");
// 已经是墓碑的资产行不该被算成"会删掉"
ok(consequenceText(grp({
  asset_merges: {
    keep: { name: "客厅", has_image: false },
    drop: [{ name: "日 内 客厅", has_image: false, deleted: true }],
  },
})) === "", "★ 被删行本来就已在回收站 → 不报（那不是新的损失）");
ok(groupSummary(grp()) === "2 种写法 · 6 镜 · 改 1 个写法",
  "摘要只说事实、不含后果判断", groupSummary(grp()));

console.log("\n[4] 二次确认的触发条件");
ok(confirmText(grp()) === null,
  "★ 纯改映射不弹二次确认（每个操作都弹 = 用户学会闭眼点确认）");
const ct = confirmText(withDrop()) ?? "";
ok(ct.includes("日 内 客厅") && ct.includes("无法恢复"),
  "不可逆组的确认文案写清删什么 + 不可恢复", ct);
ok(!ct.includes("**"), "确认框是纯文本（window.confirm 不渲染 markdown）");
ok((confirmText(grp({ locked: ["x"] })) ?? "").includes("推翻"),
  "覆盖手改也要二次确认");
ok((confirmText(withDrop()) ?? "").includes("原名不会被改写"),
  "★ 同时说明「镜头原名不变、映射可改回」——别让用户以为剧本被改了");

console.log("\n[5] 现状列表与拆分");
const cg = (canonical: string, n: number): SceneGroup => ({
  canonical, shots: n * 2,
  members: Array.from({ length: n }, (_, i) => ({
    raw_name: `${canonical}-写法${i}`, shots: 2, source: "ai",
    time_of_day: null, int_ext: null,
  })),
});
ok(mergedGroups([cg("客厅", 3), cg("街道", 1), cg("餐厅", 2)])
  .map((g) => g.canonical).join(",") === "客厅,餐厅",
  "★ 现状只列真的发生了合并的组（单写法自成一组没有信息量，几十条会撑爆面板）");
ok(mergedGroups([]).length === 0, "空场景表不炸");
ok(splitCanonical("  日 内 客厅  ") === "日 内 客厅",
  "拆出去时用原名本身（不在前端复刻后端 normalize_location，复刻必然漂移）");

console.log("\n[6] 接线（源码断言）");
const dlg = read("src/features/scenes/SceneCanonDialog.tsx");
const apiSrc = read("src/api.ts");
const lib = read("src/components/LibraryPanel.tsx");
ok(/useEffect\([\s\S]{0,400}listScenes/.test(dlg),
  "打开面板只拉现状（listScenes，只读）");
// 逐个截出 useEffect 的**函数体**再看（不能用"useEffect 后 600 字符内"这种粗匹配：
// 它会越过 effect 边界匹配到后面按钮回调里的调用，结论就反了）
const effectBodies = dlg.split("useEffect(").slice(1)
  .map((s) => s.slice(0, s.indexOf("\n  }, [")));
ok(effectBodies.length > 0 && effectBodies.every((b) => !b.includes("previewSceneCanon")),
  "★ 打开面板**不**自动跑 AI 归一（那是白花一次模型调用，也等于替用户做了决定）",
  `${effectBodies.length} 个 effect`);
ok(/onClick=\{\(\) => \{ void doPropose\(\); \}\}/.test(dlg),
  "AI 建议由按钮触发");
ok(/applySceneGroups\(p\.projectId, \[\{/.test(dlg),
  "★ 确认是**逐组**提交（一次一组，不是把整份建议一起写）");
ok(/const warn = confirmText\(g\);[\s\S]{0,120}window\.confirm\(warn\)/.test(dlg),
  "★ 提交前过 confirmText 的二次确认（不可逆那类必须拦一下）");
ok(/scenes\/apply-groups/.test(apiSrc) && /scenes\/preview/.test(apiSrc),
  "api.ts 里有预览与逐组确认两条入口");
ok(!/canonicalizeScenes/.test(apiSrc),
  "★★ api.ts **不**暴露 /scenes/canonicalize（算完直接全量写库）"
  + " —— 一键全归一等于让用户在没看过的不可逆合并上也点了同意");
ok(/setSceneCanon\(true\)/.test(lib) && /<SceneCanonDialog /.test(lib),
  "LibraryPanel 里有入口且挂了面板");
ok(/lib-sec-act[\s\S]{0,300}stopPropagation/.test(lib),
  "★ 入口按钮 stopPropagation（外层 lib-sec 是折叠开关，不拦会点一下就折叠分组）");
ok(/onChanged=\{\(\) => \{ p\.onRefresh\(\); p\.onRefreshStages\(\); \}\}[\s\S]{0,80}\)\}/
  .test(lib.slice(lib.indexOf("<SceneCanonDialog"))),
  "★ 归一改完重拉资产**与**造型阶段（服装继承以归一名为判据，只拉资产会显示旧继承）");
ok(/opacity: 0\.6/.test(read("src/styles.css").slice(
  read("src/styles.css").indexOf(".lib-sec-act"))),
  "★ 入口常显半透明，不是 hover 才出现（藏进 hover 的按钮等于没这功能）");

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0
  ? "✅ 不可逆的组与可逆的组在界面上是分开的，文案点名到具体后果，且不会自动跑 AI/自动全归一。"
  : "❌ 有断言不过 —— 归一是有损操作，先修上面第一条 ❌ 再上界面。");
process.exit(fail === 0 ? 0 : 1);
