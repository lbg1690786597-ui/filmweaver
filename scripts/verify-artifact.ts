/**
 * verify-artifact.ts — artifact schema（D1）与兼容校验（D2）
 *
 * ## 这个脚本要防的两件事，方向相反
 *
 * ① **归一悄悄漏掉一种键名**。模型选择在历史 blob 里有四种写法
 *    （`model_id` / `image_model` / `video_model` / `llm_model`）。落掉任何一种，
 *    表现都是"换模型重试时沿用了默认模型"，**不报错、不提示**，
 *    用户只会觉得"点了换模型但出来的还是老样子"。故四种逐个钉。
 *
 * ② **校验把旧数据判死**。D2 的原文是"不破坏旧数据，只新增约束"。这条最容易被
 *    后来的好心人改坏 —— "结果不合 schema 就返回 null 嘛，多干净"。
 *    于是本脚本专门喂**畸形的、缺字段的、compose 的、根本不是 JSON 的**输入，
 *    断言它们全都**不 throw**、且除"连 JSON 都不是"这一种外**都拿得到值**。
 *
 * ## 只测这一层，不测后端
 *
 * 后端写侧一个字段都没动（约束 ①：改名会让 372 行历史 blob 与在跑的任务读不到参数）。
 * 所以这个脚本不该出现任何"后端应该改成 X"式的断言 —— 那会把架构决定
 * 写成一个随时会红的哨兵。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_SCHEMA_VERSION, KIND_ARTIFACT, BARE_ARRAY_KINDS,
  MODEL_KEYS, pickModel, pickModelChoice, readArtifact, hardIssues,
} from "../src/lib/artifact";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 去掉注释与字符串字面量再 grep。
 *  ⚠️ 不脱注释的全文 grep 会**抓到自己那句解释性注释** —— 这个坑在
 *  `verify-undo-history.ts` 里已经踩过一次：源码里写着"这里绝不要 throw"，
 *  于是 `/\bthrow\b/` 命中的正是那句叮嘱本身。 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

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

/* ================================================================== *
 * ① 模型键名归一 —— 四种写法都必须认
 * ================================================================== */
console.log("\n① 模型键名归一（PLAN §11.2 的四种写法）");
check("四种键名在表里", MODEL_KEYS.length, 4);
for (const k of MODEL_KEYS) {
  check(`认得 ${k}`, pickModel({ [k]: "m-x" }), "m-x");
}
check("四个键都空 → null（不是空串，否则下游会跳过默认值兜底）",
  pickModel({ model_id: "", image_model: null }), null);
check("空对象 → null", pickModel({}), null);
check("null / undefined 不炸", [pickModel(null), pickModel(undefined)], [null, null]);

check("⚠️ 同时出现时取**更具体**的那个（image > video > llm > model_id）",
  pickModel({ model_id: "generic", image_model: "specific" }), "specific");
check("video 比 llm 具体", pickModel({ llm_model: "l", video_model: "v" }), "v");
check("只有泛化键时用它", pickModel({ model_id: "generic" }), "generic");

// 回写 payload 需要知道**该写哪个键**，光有值不够
check("pickModelChoice 带出键名（生图/生视频回写不能挑错键）",
  pickModelChoice({ video_model: "veo-3-1" }), { value: "veo-3-1", key: "video_model" });
check("pickModelChoice 空时 null", pickModelChoice({}), null);

/* ================================================================== *
 * ② schema 表本身
 * ================================================================== */
console.log("\n② schema 表");
check("版本号从 1 起", ARTIFACT_SCHEMA_VERSION, 1);
check("⛔ compose 不建模（2026-08-30 已下线，只存 5 行历史数据）",
  KIND_ARTIFACT.compose, undefined);
ok("12 种 kind 里建模了 11 种（除 compose）",
  Object.keys(KIND_ARTIFACT).length === 11, `实际 ${Object.keys(KIND_ARTIFACT).length}`);
check("asset_batch 是唯一的裸数组 kind", [...BARE_ARRAY_KINDS], ["asset_batch"]);

/* ================================================================== *
 * ③ readArtifact —— 正常路径
 * ================================================================== */
console.log("\n③ 正常结果");
{
  const { value, check: c } = readArtifact(
    JSON.stringify({ shots: [{ order: 1, video_url: "/fw/media/a.mp4" }], note: "好" }),
    "shot_videos");
  check("ShotVideoArtifact 解析出值", (value as { shots: unknown[] }).shots.length, 1);
  check("正常结果零诊断", c.issues, []);
  check("诊断里带 artifact 名", c.artifact, "ShotVideoArtifact");
  check("诊断里带版本号", c.version, 1);
}
{
  const { check: c } = readArtifact(JSON.stringify([{ name: "甲", urls: ["/a.png"] }]), "asset_batch");
  check("asset_batch 的裸数组不报错", c.issues, []);
}
{
  const { check: c } = readArtifact(JSON.stringify({ film: { url: "/f.mp4", size: 1 }, shots: [] }),
    "one_click_film");
  check("FilmArtifact 正常", c.issues, []);
}

/* ================================================================== *
 * ④ readArtifact —— **畸形/历史数据必须放行**（D2 的核心要求）
 * ================================================================== */
console.log("\n④ 旧数据 / 畸形数据不许被拒收");
const bad: [string, string, string][] = [
  ["", "shot_videos", "空 result（任务在跑或老任务没落）"],
  ["null", "shot_videos", "字面 null"],
  ["{不是 JSON", "shot_videos", "根本不是 JSON"],
  [JSON.stringify({}), "shot_videos", "空对象（缺 shots）"],
  [JSON.stringify({ shots: "不是数组" }), "shot_videos", " shots 类型错"],
  [JSON.stringify({ url: "/x", size: 1 }), "compose", "compose（已下线，未建模）"],
  [JSON.stringify({ created: 3 }), "costume_scan", "CostumeScanArtifact 正常"],
  [JSON.stringify({ total: 4 }), "auto_subtitles", "AutoSubtitleArtifact 少 created"],
  [JSON.stringify({ stage: "assets" }), "first_frame_pipeline", "编排型只跑到一半"],
  [JSON.stringify({ shots: [] }), "未知的 kind", "未知 kind"],
];
for (const [raw, kind, label] of bad) {
  let threw = false, got: { value: unknown; check: ReturnType<typeof readArtifact>["check"] } | null = null;
  try { got = readArtifact(raw, kind); } catch { threw = true; }
  ok(`不 throw：${label}`, !threw);
  if (threw || !got) continue;
  // 唯一允许回到 null 的情形：连 JSON 都解析不了
  const expectNull = raw === "" || raw === "null" || raw === "{不是 JSON";
  if (expectNull) {
    ok(`  → value 为 null（只有解析不了才这样）：${label}`, got.value === null);
  } else {
    ok(`  ⚠️ → 仍给出值，不被拒收：${label}`, got.value !== null,
      "旧数据被拒收 = 任务中心里历史任务全变「结果异常」");
  }
}
{
  const { check: c } = readArtifact("{不是 JSON", "shot_videos");
  ok("解析失败会被标出来（unparsable）", c.unparsable);
  ok("解析失败进 hardIssues（这才是真该有角标的）", hardIssues(c).length === 1);
}
{
  const { check: c } = readArtifact("", "shot_videos");
  ok("空 result 不算坏（unparsable=false）", !c.unparsable);
  check("空 result 只记 info，不进 hardIssues", hardIssues(c).length, 0);
}
{
  const { check: c } = readArtifact(JSON.stringify({ shots: [{ order: 1 }], stub: true }),
    "shot_videos");
  ok("stub 占位结果会被看见（当成真结果 = 用户看到「生成成功但没视频」）",
    c.issues.some((i) => i.path === "stub"));
  check("但 stub 不是 warn（它是正常标记，不是写侧出错）", hardIssues(c).length, 0);
}
{
  const { check: c } = readArtifact(JSON.stringify({ shots: "x" }), "shot_videos");
  ok("形态级错误进 hardIssues", hardIssues(c).length === 1);
  check("诊断里带字段路径", hardIssues(c)[0].path, "shots");
}

/* ================================================================== *
 * ⑤ 静态：消费点不再自己 JSON.parse result
 * ================================================================== */
console.log("\n⑤ 消费点走适配层");
const audio = read("src/hooks/useAudioTrack.ts");
const prod = read("src/hooks/useProdJobs.ts");
const art = read("src/lib/artifact.ts");
ok("useAudioTrack 走 readArtifact", /readArtifact\(result, "tts_batch"\)/.test(audio));
ok("useAudioTrack 不再就地 JSON.parse result", !/JSON\.parse\(result/.test(audio));
ok("useProdJobs 走 readArtifact", /readArtifact\(result, "first_frames"\)/.test(prod));
ok("useProdJobs 不再就地 JSON.parse result", !/JSON\.parse\(result/.test(prod));
ok("⚠️ 适配层自己不 throw（不出现 throw 关键字）",
  !/\bthrow\b/.test(stripComments(art)),
  "readArtifact 抛了 = 违反「不破坏旧数据」");

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
