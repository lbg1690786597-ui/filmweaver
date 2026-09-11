/**
 * verify-preflight-params.ts — 「本次参数」的分辨率/画幅必须**显示得对、改了真生效**
 *
 * ## 这个脚本存在的直接原因
 *
 * 用户原话：「在一键成片的本次参数中，分辨率控制中没有 480p 的选项」。
 * 查下来 480p 其实一直都在档位表里（`lib/resolutions.ts` 六种画幅各四档，
 * 2026-08-24 就补齐了）。用户看到的是另一回事——**面板显示的档位不是他选的那个**：
 * 下拉没有「沿用项目设置」这一项，初值写死成档位表的第 0 项（1080p）。
 * 项目里选的是 720p，面板上却是 1080p，于是「我选的档去哪了」。
 *
 * 用户随后拍板：「创建项目时是哪个，这里就该显示哪个，除非用户手动改了，
 * 而改了就该"真的改了"」。这两句是本文件全部断言的来源，它们卡的是三处**独立**
 * 的断裂，任何一处回潮，UI 看起来都完全正常：
 *
 * ① **显示对不对** —— 前端得知道项目档位是什么（readiness 要回 `resolution`），
 *    下拉要有「沿用项目设置（720p）」这一项，且默认停在它上面。
 * ② **改了传不传** —— 旧代码存的是档位表**下标**且初值 0，判"改没改"用
 *    `idx !== 0`：用户显式选 1080p 与没选完全不可区分，那次选择被静默丢弃。
 * ③ **传了收不收** —— 旧代码下发的是 `width/height`，而后端**从来没读过**这两个键
 *    （服务端早已不做合成）。真正管用的旋钮是 `VideoRequest.megapixels`，
 *    由档位名经 RESOLUTION_TIERS 换算。所以哪怕前端修对了，不改后端也仍是 no-op。
 *
 * 外加一条更早的、影响所有新项目的：`run_shot_videos` 读项目分辨率时写的是
 * `if production_mode == "custom"`，而 2026-08 改版后 production_mode 已变成
 * **配音策略**（drama/narration/anime），没有一个新项目是 custom ——
 * 新建向导里选的分辨率对**所有**新项目一律无效。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASPECTS, RES_TIERS, RESOLUTIONS, isResTier, resListOf, resOfTier, tierLabel,
} from "../src/lib/resolutions";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * 去掉整行注释后再断言「某段旧代码不存在」。
 *
 * 本文件里好几条断言的形式是"源码里不该再出现 X"，而修复时我们恰恰要在注释里
 * **写清楚旧写法 X 错在哪**（否则下一个人只会看到一段没头没尾的新代码，
 * 过半年又改回去）。不剥注释的话，这些解释性注释会把自己的断言打成失败。
 */
const noComments = (src: string, marker: "//" | "#") =>
  src.split("\n").filter((l) => !l.trimStart().startsWith(marker)).join("\n");

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

/* ================================================================== */
console.log("\n① 档位常量与档位表口径一致");
// 覆盖度（六画幅 × 四档齐全、偶数边、比例相符）已由 verify-resolutions.ts 钉住，
// 这里只查它没查的：档位**顺序**语义，以及 RES_TIERS 与表里实际出现的档是否同一套。

check("档位就是后端 RESOLUTION_TIERS 那四档", RES_TIERS, ["480p", "720p", "1080p", "2k"]);
check("RES_TIERS 与档位表里实际出现的档一致（不多不少）",
  [...new Set(ASPECTS.flatMap((a) => RESOLUTIONS[a]!.map((r) => r.tier)))].sort(),
  [...RES_TIERS].sort());
ok("每种画幅都有 480p（用户报的就是这一档）",
  ASPECTS.every((a) => resListOf(a).some((r) => r.tier === "480p")),
  "480p 是最便宜的档位，试片正需要它");

{
  // 档位得真的是"越高越大"，否则选 480p 反而更贵，用户无从察觉。
  // RES_TIERS 的顺序还被用来当"由省到贵"讲给用户听，排错了就是在误导。
  for (const a of ASPECTS) {
    const px = RES_TIERS.map((t) => {
      const r = resOfTier(a, t)!;
      return r.w * r.h;
    });
    ok(`${a} 像素数随 RES_TIERS 顺序单调递增`,
      px.every((v, i) => i === 0 || v > px[i - 1]!),
      `实际 ${JSON.stringify(px)}`);
  }
}

/* ================================================================== */
console.log("\n② resOfTier：按档位名取，不按下标取");

check("按名字取得到对应档", resOfTier("9:16", "480p")?.label, "480×854 · 480p (最省)");
check("大小写不敏感（后端统一小写，但老数据可能是 2K）",
  resOfTier("9:16", "2K")?.tier, "2k");
check("认不出的档位返回 null（调用方按「沿用」处理）", resOfTier("9:16", "4k"), null);
check("null/undefined 也返回 null", [resOfTier("9:16", null), resOfTier("9:16", undefined)],
  [null, null]);
check("未知画幅退回 9:16 的表", resOfTier("7:5", "720p")?.w, 720);

{
  // 承重点：换画幅时**不能**按下标续用。旧代码 setOvResIdx(0) 就是因为
  // 下标换表后可能越界/指到别的档；改存档位名之后这个问题从根上消失。
  const before = resOfTier("9:16", "480p")!;
  const after = resOfTier("16:9", "480p")!;
  ok("同一档位换画幅后仍是同一档（不会跳档）",
    before.tier === after.tier && before.w !== after.w,
    `9:16 ${before.w}×${before.h} → 16:9 ${after.w}×${after.h}`);
}

check("isResTier 只认这四档",
  ["480p", "720p", "1080p", "2k", "1440p", "", null].map(isResTier),
  [true, true, true, true, false, false, false]);
check("tierLabel：认得就原样显示，认不得说「模型默认」",
  [tierLabel("720p"), tierLabel(null), tierLabel("4k")],
  ["720p", "模型默认", "模型默认"]);

/* ================================================================== */
console.log("\n③ 前端面板：显示项目档位，只把真改过的传出去");
{
  const tsx = read("src/components/PreflightDialog.tsx");

  ok("分辨率下拉有「沿用项目设置」这一项",
    /沿用项目设置（\{tierLabel\(rd\.resolution\)\}/.test(tsx),
    "没有它，下拉就只能默认停在档位表第一项（1080p）——"
    + "项目里选的 720p 从来没显示出来过，这正是用户看到的现象");

  ok("状态存的是档位名不是下标",
    /const \[ovRes, setOvRes\] = useState<string \| null>\(null\)/.test(tsx)
    && !/ovResIdx/.test(tsx),
    "存下标的话：① 初值 0 = 显示表中第一项，与项目档位无关；"
    + "② 判「改没改」只能写 idx !== 0，于是**用户显式选 1080p** 和没选"
    + "完全不可区分，那次选择会被静默丢掉");

  ok("默认值是 null（= 沿用），不是任何具体档位",
    /useState<string \| null>\(null\)[\s\S]{0,80}setOvRes|setOvRes\] = useState<string \| null>\(null\)/.test(tsx),
    "默认填一个具体值 = 把「沿用项目设置」这个语义整个删掉");

  ok("提交时原样传 ovRes / ovAspect，不做任何回填",
    /resolution: ovRes,/.test(tsx) && /aspect: ovAspect,/.test(tsx),
    "用前端读到的项目值兜底的话，「沿用」会变成「锁死成读到这一刻的值」——"
    + "用户之后在项目设置里改了分辨率，这条任务还按老档位跑");

  ok("不再计算/下发 width/height",
    !/width: changed/.test(tsx) && !/resListOf\(aspect\)\[/.test(tsx),
    "后端从来不读这两个键，算了也是白算");

  ok("「已改」圆点把分辨率算进去",
    /\(ovModel \|\| ovAspect \|\| ovRes\)/.test(tsx),
    "只改了分辨率却不显示「已改」，用户会以为没点上，再点一次");

  ok("折叠标题的摘要带分辨率",
    /tierLabel\(ovRes \?\? rd\.resolution\)/.test(tsx),
    "分辨率是最花钱的一档参数；折起来看不见的话，用户不会想到展开确认");

  ok("换画幅不再重置分辨率",
    !/setOvResIdx\(0\)/.test(tsx) && !/换画幅后旧档位索引可能越界/.test(tsx),
    "存档位名之后换表照样对得上；重置会让用户选的 480p 因为顺手改了画幅"
    + "就跳回 1080p");
}

/* ================================================================== */
console.log("\n④ api 层：传档位名，且「沿用」就是不传值");
{
  const api = read("src/api.ts");
  const seg = noComments(api.slice(api.indexOf("submitOneClickFilm"),
                                   api.indexOf("jobStatus:")), "//");

  ok("payload 传 resolution / aspect_ratio",
    /resolution: opts\?\.resolution \?\? null/.test(seg)
    && /aspect_ratio: opts\?\.aspect \?\? null/.test(seg));

  ok("不再下发 width/height/fps",
    !/width:/.test(seg) && !/height:/.test(seg) && !/fps:/.test(seg),
    "旧写法 `width: opts?.width ?? 1080` 有双重问题：这三个键后端根本没读，"
    + "而那个 ?? 兜底还把「沿用项目设置」变成了每次都硬发 1080×1920");

  ok("沿用时传 null 而不是项目值",
    !/resolution: opts\?\.resolution \?\? rd/.test(seg)
    && !/opts\?\.resolution \?\? "/.test(seg),
    "在这一层兜底就等于把「沿用」冻结成提交那一刻的值");

  ok("Readiness 类型有 resolution 字段",
    /resolution\?: string \| null;/.test(api),
    "前端拿不到项目档位就没法显示「沿用项目设置（720p）」");
}

/* ================================================================== */
console.log("\n⑤ 后端：项目档位对所有模式生效，本次覆写真能落到 Provider");
{
  const jobs = read("../backend/app/jobs.py");
  const jobsCode = noComments(jobs, "#");
  const ready = read("../backend/app/readiness.py");

  ok("有独立的 _resolve_project_resolution（与视频模型同一套口径）",
    /def _resolve_project_resolution\(proj\)/.test(jobs),
    "内联在 run_shot_videos 里就是它长期与 _resolve_project_video_model 走偏的原因");

  ok("不再只对 production_mode == custom 读 default_profile",
    !/production_mode == "custom" and proj\.default_profile/.test(jobsCode),
    "2026-08 改版后 production_mode 变成了**配音策略**（drama/narration/anime），"
    + "没有一个新项目是 custom ——这个条件让新建向导里选的分辨率"
    + "对所有新项目一律无效（proj_mp=None），而同一份 default_profile 里的"
    + "video_model 却是全模式读的");

  ok("run_shot_videos 读 payload 的本次覆写",
    /batch_resolution = p\.get\("resolution"\)/.test(jobs)
    && /eff_aspect = p\.get\("aspect_ratio"\) or proj_aspect_raw/.test(jobs));

  ok("未知档位只警告并沿用项目设置，不抛错",
    /batch_resolution not in RESOLUTION_TIERS/.test(jobs)
    && /batch_resolution = None/.test(jobs),
    "前端多发一个没见过的档位串，不该让整批出片任务直接失败");

  ok("镜头级 override.megapixels 仍然最优先",
    /megapixels=override\.get\("megapixels"\) if override\.get\("megapixels"\) is not None else proj_mp/.test(jobs),
    "单镜「⚙ 高级设置」里手动定的分辨率是最具体的意图，不能被批次参数盖掉");

  ok("run_one_click_film 把覆写透传给 shot_videos 子 job",
    /"resolution": p\.get\("resolution"\),\n\s+"aspect_ratio": p\.get\("aspect_ratio"\),/.test(jobs),
    "真正下发给 Provider 的是子 job；一键成片这一层只是转发，漏传就静默失效");

  ok("first_frame_pipeline 也透传",
    /"resolution": p\.get\("resolution"\),\n\s+"aspect_ratio": p\.get\("aspect_ratio"\)\}/.test(jobs),
    "它是另一条会建 shot_videos 子 job 的路径，只修一条等于只修了一半");

  ok("readiness 回 resolution",
    /"resolution": resolution,/.test(ready)
    && /_resolve_project_resolution\(proj\)/.test(ready),
    "前端要靠它显示「沿用项目设置（720p）」");
}

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 本次参数全部通过：六画幅各四档（含 480p）、面板显示的就是项目里选的那档、"
    + "只把真改过的下发、后端按档位名换算 megapixels 且对所有生产模式生效"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
