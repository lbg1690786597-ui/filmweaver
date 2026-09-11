/**
 * verify-project-list.ts — 项目首页的排序与检索（2026-09-10）
 *
 * ## 这个脚本存在的直接原因：上一版排序是坏的，而且看不出来
 *
 * 改动前 `ProjectCards.tsx` 里写着：
 *
 * ```ts
 * // 最新项目排最前（id 是 hex 时间戳前缀，字典序即时序）
 * filtered.sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
 * ```
 *
 * 那句注释是错的 —— 后端建项目用的是 `uuid.uuid4().hex[:12]`，**纯随机**，
 * 不含任何时间信息。所以"最新排最前"实际排出来是随机顺序。它能活这么久，
 * 正是因为随机顺序看上去也"有个顺序"，用户无从判断它对不对。
 *
 * 这类错误的共同点是**不会报错、不会崩、只是悄悄给错答案**，靠肉眼验收抓不住。
 * 所以排序规则被抽进 `projectSort.ts`（纯函数），由本脚本逐条钉死。
 *
 * ## 四条容易退化的规则
 *
 * ① **缺失值一律沉底，与升降序无关。**
 *    最容易被"优化"掉的一条：把 null 折算成 0 或空串让它参与比较，代码更短，
 *    结果是切到「创建时间↑」时第一屏全是回填不到时间的老项目 —— 用户会以为
 *    列表坏了。null 是"没有这个值"，不是"值很小"。
 *
 * ② **中文名必须 localeCompare("zh")。**
 *    按码点排等于没排（码点序是编码顺序，与拼音无关）。本脚本刻意选了一组
 *    **拼音序与码点序相反**的名字，否则这条断言恒真、等于没测。
 *
 * ③ **搜索要能命中生产模式中文名。**
 *    用户找项目时想的常是"那个真人剧的"。只匹配 title 的话搜「真人剧」
 *    一个都搜不到，看起来像搜索功能坏了。
 *
 * ④ **等值必须稳定。**
 *    十个同为 0% 的项目每次刷新互换位置，是最典型的"页面在抖"。
 *
 * 另外钉住 UI 层两件事（它们同样属于"错了不报错"）：卡片外层不能是 `<button>`
 * （里面要放改名/删除按钮，button 套 button 非法且必然冒泡打开项目），
 * 以及行内按钮**不许**藏进 hover。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectInfo } from "../src/api";
import {
  SORT_KEYS, filterProjects, fmtBytes, sortProjects,
} from "../src/features/projects/projectSort";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const okEq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okEq) failed++;
  console.log(`${okEq ? "  ok" : "FAIL"}  ${name}`);
  if (!okEq) console.log(`        实际 ${JSON.stringify(actual)}\n        期望 ${JSON.stringify(expected)}`);
}
function ok(name: string, cond: boolean, why = "") {
  if (!cond) failed++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}`);
  if (!cond && why) console.log(`        ${why}`);
}

const P = (o: Partial<ProjectInfo> & { id: string }): ProjectInfo => ({
  title: o.id, base_aspect: "9:16", production_mode: "drama", ...o,
} as ProjectInfo);

const ids = (list: ProjectInfo[]) => list.map((p) => p.id);

/* ================================================================== */
console.log("\n① 缺失值沉底 —— 升序降序都一样");

for (const [key, field] of [
  ["created", "created_at"], ["active", "last_active_at"],
  ["duration", "total_sec"], ["episodes", "episodes_count"],
] as const) {
  const big = field === "total_sec" || field === "episodes_count" ? 9 : "2026-09-09T00:00:00";
  const small = field === "total_sec" || field === "episodes_count" ? 1 : "2026-01-01T00:00:00";
  const list = [
    P({ id: "none" }),                        // 该维度上没有值
    P({ id: "small", [field]: small } as never),
    P({ id: "big", [field]: big } as never),
  ];
  check(`${key} 降序：大→小，缺失最后`, ids(sortProjects(list, key, "desc")),
    ["big", "small", "none"]);
  check(`${key} 升序：小→大，缺失**仍**最后`, ids(sortProjects(list, key, "asc")),
    ["small", "big", "none"]);
}

// progress 的缺失定义比其它维度微妙：一个镜头都没有 ≠ 0%。
// 前者是"还没开始拆镜"，后者是"拆完了一张都没生成"，混在一起用户分不清
// 哪些项目其实已经可以开工了。
{
  const list = [
    P({ id: "noshots", shots_total: 0, shots_done: 0 }),
    P({ id: "zero", shots_total: 10, shots_done: 0 }),
    P({ id: "half", shots_total: 10, shots_done: 5 }),
    P({ id: "full", shots_total: 10, shots_done: 10 }),
  ];
  check("progress 降序：100%→0%，「没有镜头」沉底而非并入 0%",
    ids(sortProjects(list, "progress", "desc")), ["full", "half", "zero", "noshots"]);
  check("progress 升序：0% 在前，「没有镜头」仍沉底",
    ids(sortProjects(list, "progress", "asc")), ["zero", "half", "full", "noshots"]);
}

/* ================================================================== */
console.log("\n② 中文名按拼音排（这组名字的拼音序与码点序相反）");

// 码点：阿(963F) < 张(5F20)? —— 实际 张=5F20 < 阿=963F，
// 所以按码点「张三」会排在「阿彪」前面，按拼音则相反。这组数据能真正区分两者。
{
  const list = [P({ id: "z", title: "张三" }), P({ id: "a", title: "阿彪" })];
  check("名称升序 = 拼音序（阿在张前）", ids(sortProjects(list, "title", "asc")), ["a", "z"]);
  ok("这组数据确实能区分拼音序与码点序",
    "张三" < "阿彪" && "张三".localeCompare("阿彪", "zh") > 0,
    "若两种排法结果相同，上一条断言恒真、等于没测");
  check("名称降序对称", ids(sortProjects(list, "title", "desc")), ["z", "a"]);
}

/* ================================================================== */
console.log("\n③ 检索：项目名 / 生产模式中文名 / 画幅");

{
  const list = [
    P({ id: "d", title: "重逢", production_mode: "drama", base_aspect: "9:16" }),
    P({ id: "n", title: "宇宙简史", production_mode: "narration", base_aspect: "16:9" }),
  ];
  check("空串返回全量", ids(filterProjects(list, "")), ["d", "n"]);
  check("只有空白也返回全量", ids(filterProjects(list, "   ")), ["d", "n"]);
  check("按项目名命中", ids(filterProjects(list, "重逢")), ["d"]);
  check("按生产模式中文名命中", ids(filterProjects(list, "解说")), ["n"]);
  check("按画幅命中", ids(filterProjects(list, "16:9")), ["n"]);
  check("搜不到就是空", ids(filterProjects(list, "不存在的片名")), []);
  ok("filterProjects 不改原数组", (() => {
    const src = [P({ id: "x" })];
    filterProjects(src, "");
    return src.length === 1;
  })(), "返回的必须是新数组，否则 useMemo 的依赖比较会失效");
}

/* ================================================================== */
console.log("\n④ 等值稳定 + 不就地改原数组");

{
  const list = ["a", "b", "c", "d"].map((id) => P({ id, shots_total: 10, shots_done: 5 }));
  check("同进度保持原相对顺序（降序）",
    ids(sortProjects(list, "progress", "desc")), ["a", "b", "c", "d"]);
  check("同进度保持原相对顺序（升序）",
    ids(sortProjects(list, "progress", "asc")), ["a", "b", "c", "d"]);
  const src = [P({ id: "z", total_sec: 1 }), P({ id: "a", total_sec: 9 })];
  sortProjects(src, "duration", "desc");
  check("sortProjects 不就地改原数组", ids(src), ["z", "a"]);
}

/* ================================================================== */
console.log("\n⑤ fmtBytes（清盘确认框要写具体体积，写错了用户就删错东西）");

check("0 字节", fmtBytes(0), "0 B");
check("负数当 0（stat 失败等）", fmtBytes(-1), "0 B");
check("字节不带小数", fmtBytes(999), "999 B");
check("1 KB 整", fmtBytes(1024), "1 KB");
check("1.5 MB", fmtBytes(1024 * 1024 * 1.5), "1.5 MB");
check("大于 100 时取整（3 位数带小数没意义）", fmtBytes(1024 * 1024 * 512), "512 MB");
check("GB 档", fmtBytes(1024 ** 3 * 2.25), "2.3 GB");

/* ================================================================== */
console.log("\n⑥ UI 层：卡片可点、行内按钮不藏 hover");

{
  const tsx = read("src/features/projects/ProjectCards.tsx");
  const css = read("src/features/projects/ProjectCards.css");

  ok("卡片外层不是 <button>",
    !/<button key=\{proj\.id\} className="fw-pc-card"/.test(tsx)
    && /className="fw-pc-card" role="button" tabIndex=\{0\}/.test(tsx),
    "卡片里放了改名/删除按钮，<button> 套 <button> 是非法 HTML，"
    + "React 会警告，且点内层必然冒泡到打开项目");
  ok("换成 div 后补了键盘可达（回车/空格打开）",
    /onKeyDown=/.test(tsx) && /e\.key === "Enter" \|\| e\.key === " "/.test(tsx),
    "role=button 不自带键盘行为，不补就等于把项目列表对键盘用户关掉了");
  ok("行内按钮阻止冒泡",
    (tsx.match(/e\.stopPropagation\(\)/g) ?? []).length >= 3,
    "不阻止的话，点「删除」会先弹确认框、点完还把项目打开了");
  ok("行内按钮**常显**（半透明），不是 hover 才出现",
    /\.fw-pc-acts\s*\{[^}]*opacity:\s*0\.\d+/.test(css)
    && !/\.fw-pc-acts\s*\{[^}]*display:\s*none/.test(css),
    "本项目已有教训：藏在 hover 里的行内按钮，在用户眼里等于这个功能不存在");
  ok("排序键与 UI 下拉同源",
    SORT_KEYS.length === 6 && /SORT_KEYS\.map/.test(tsx),
    "下拉若自己再写一份选项清单，加维度时必然漏改一处");
  ok("改名提示写明了「只影响此后新生成的内容」",
    /改名只影响此后新生成内容的语境，已生成的图与视频不变/.test(tsx),
    "title 会作为片名进生成提示词（jobs.py 的 scene_prompt），"
    + "不说明的话用户会以为改名会重画已生成的内容");
  ok("彻底删除的确认框写了具体文件数与释放体积",
    /将永久删除 \$\{pv\.files\} 个文件，释放约 \$\{fmtBytes\(pv\.bytes\)\}/.test(tsx),
    "只写「不可恢复」是空话，用户判断不出自己是不是选错了项目");
  ok("确认框声明了导出成片不在清理范围",
    /导出成片（outputs）不在清理范围内/.test(tsx),
    "outputs 不落库、无法归属项目；不说清的话用户会奇怪磁盘为什么没降下来");
  ok("彻底删除后清掉本机残留（当前项目 / 快照 / 素材缓存）",
    /localStorage\.removeItem\("fw_project"\)/.test(tsx)
    && /tauriSnapshotIO\.remove/.test(tsx)
    && /removeProjectCache/.test(tsx),
    "不清的话客户端上会永久留一份指向已不存在项目的孤儿缓存，"
    + "而且再没有任何界面能定位到它");
}

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 项目首页全部通过：六个维度排序正确且缺失值恒沉底、中文名按拼音排、"
    + "检索覆盖模式与画幅、等值稳定；卡片改 div 后仍可键盘打开，"
    + "行内改名/删除常显不藏 hover，清盘确认框写的是真数字"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
