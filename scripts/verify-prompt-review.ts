/**
 * scripts/verify-prompt-review.ts — 出片前「提示词终审」与资产图垫图
 *
 * ## 为什么这两条值得钉
 *
 * **误解纠正**：用户报的第一个问题是"拆解完似乎会直接触发出片"。实测**不会**——
 * `run_breakdown_all` → `breakdown_by_episode` → `_pregen_prompts` 写完
 * `gen_prompt` 就返回，全程没有 submit/create_job；`useBreakdown` 收到 done
 * 只弹一句「✅ 分镜与提示词生成完成」。唯一的自动链是用户自己按的「▷ 一键成片」。
 * 所以 [1] 钉的是"这条链不许被加上"：将来谁把拆解接到出片上，用户的钱会在
 * 他还没看见文本时就花掉，而 tsc 与任何单测都不会响。
 *
 * **真正的缺口是"看不见"**：草稿是**资产存在之前**写的（服装/人称/场景锚点全靠
 * AI 从剧本猜），而真正的资产对齐重写发生在 `run_shot_videos` **内部**——用户
 * 第一次看见即将下发的文本，是在花了钱、出了片之后。所以 [2] 钉三件事：
 *   ① 弹窗确实把文本摊出来并能就地改；
 *   ② 只写**改过**的镜头（没改的一字节都不写——避免无意义的"锁稿"）；
 *   ③ 空提示词在**提交前**拦住（后端才失败的话，用户看到的是任务失败，
 *      而不是"这里少填了一段"）。
 * ③ 尤其容易在后续重构里被"优化掉"：它看起来只是一句 toast，实际是省钱的。
 *
 * [3] 钉的是**唯一的落库通道**：手改必须双写 `profile_override.prompt`。
 * 只写 `gen_prompt` 是**看起来对、实际无效**的——有参考图时（绝大多数镜头）
 * `run_shot_videos` 会按资产重新优化提示词，把手改稿顶掉（jobs.py:983 的优先级
 * 里 override.prompt 才是第一位）。这个 bug 不会报错，只会让用户"改了没用"。
 *
 * [4] 钉单镜直通：Inspector 里本来就有提示词编辑框（就在"重新生成"正上方），
 * 一条也弹窗属于纯骚扰。多镜批量才有"逐条看不见"的问题。
 *
 * [5] 是垫图：用户要"照这张图的构图/风格来一张"。后端本来就支持多参考图
 * （`_load_ref_bytes` 取 `urls[:4]`），缺的只是前端入口。这里钉三件事：
 * 显式 ref_urls 一路串到 provider、**优先于**定妆图自动挑选、以及
 * `exclude_url` 只过滤自动挑选而**不会**把用户自己挑的垫图踢掉。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

//: 读 backend/ 一律走这里 —— 公开仓（CI）没有 backend/，直接读会 ENOENT 崩掉整条发版链路
import { readBackend, skipBackend } from "./backendSrc";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};

const dialog = read("src/components/PromptReviewDialog.tsx");
const videoPanel = read("src/features/generation/VideoPanel.tsx");
const shotsPanel = read("src/components/ShotsPanel.tsx");
const assetDialog = read("src/components/AssetDialog.tsx");
const apiSrc = read("src/api.ts");

console.log("\n[1] 拆解不许自动出片（误解纠正，也是红线）");
{
  const jobs = readBackend("app/jobs.py");
  if (!jobs) {
    skipBackend("拆解链无 submit");
  } else {
    // run_breakdown_all 的函数体：从头到下一个顶层 def
    const start = jobs.indexOf("def run_breakdown_all");
    ok(start > 0, "★ 后端仍有 run_breakdown_all（找不到说明函数被改名，本断言需同步）");
    if (start > 0) {
      const rest = jobs.slice(start + 1);
      const nextDef = rest.indexOf("\ndef ");
      const body = nextDef > 0 ? rest.slice(0, nextDef) : rest;
      const bad = /create_job|submit_shots|_submit\(|run_shot_videos|run_one_click_film/.exec(body);
      ok(!bad,
        "★ 拆解函数体内不出现任何出片/建任务调用（拆解只写提示词，出片由用户显式触发）",
        bad ? `发现 ${bad[0]}` : "");
    }
  }
}
{
  const useBreakdown = read("src/hooks/useBreakdown.ts");
  ok(!/doGenerate|submitShots|submitShotsByIds/.test(useBreakdown),
    "★ useBreakdown 完成时不调出片（只有一句「分镜与提示词生成完成」的 toast）",
    useBreakdown.match(/doGenerate|submitShotsByIds?/)?.[0] ?? "");
}

console.log("\n[2] 终审弹窗：摊文本、只写改过的、空稿拦在提交前");
ok(/出片前确认提示词/.test(dialog), "标题写明这是出片前确认（用户得知道关掉它=不出片）");
ok(/const textOf = \(s: ShotInfo\) => edits\[s\.id\] \?\? \(s\.gen_prompt \?\? ""\)/.test(dialog),
  "展示的就是即将下发的原文（gen_prompt），不是摘要");
ok(/<AutoTextarea className="prv-ta"/.test(dialog), "每行可**就地编辑**（不是只读预览）");
{
  const save = dialog.slice(dialog.indexOf("const saveEdits"), dialog.indexOf("const confirm"));
  ok(/const dirty = p\.shots\.filter\(edited\)/.test(save)
     && /if \(!dirty\.length\) return true/.test(save),
    "★ 只保存**改过**的镜头：没动过的一个 PATCH 都不发（不制造无意义的锁稿）",
    "saveEdits 里没有 filter(edited) 早退");
  ok(/await api\.patchShotPrompt\(s\.id, textOf\(s\)\)/.test(save),
    "改动用 PATCH /shots/{id}/prompt 落库（不是本地态）");
}
{
  const confirm = dialog.slice(dialog.indexOf("const confirm = async"));
  ok(/if \(blankShots\.length\)[\s\S]{0,220}return;/.test(confirm),
    "★ 空提示词在**提交前**拦截（后端才失败的话，用户看到的是「任务失败」而不是「这里少填」）");
  ok(/if \(!\(await saveEdits\(\)\)\) return;/.test(confirm),
    "★ 先落库再出片：保存失败绝不出片（否则出的是没改动的那一稿）");
}
ok(!/api\.submitShotsByIds|api\.submitShots\b/.test(dialog),
  "弹窗自己不提交出片任务——提交留在面板里，弹窗只负责「文本已确认」这个信号");

console.log("\n[3] 手改必须双写 profile_override（只写 gen_prompt 会被 AI 顶掉）");
{
  const routes = readBackend("app/routes_v2.py");
  if (!routes) {
    skipBackend("PATCH /shots/{id}/prompt 双写 override");
  } else {
    const i = routes.indexOf("def patch_shot_prompt");
    ok(i > 0, "后端仍有 patch_shot_prompt");
    if (i > 0) {
      const body = routes.slice(i, i + 4000);
      ok(/shot\.gen_prompt = text/.test(body), "写入 shot.gen_prompt（供 UI 展示）");
      ok(/ov\["prompt"\] = text/.test(body) && /shot\.profile_override/.test(body),
        "★ 同时写 profile_override[\"prompt\"] —— 这是唯一「AI 不许再改」的通道");
      ok(/prompt_state = "manual"/.test(body), "状态标记为 manual（生成时原样下发）");
    }
  }
}

console.log("\n[4] 批量走终审、单镜直通");
ok(/const askGenerate = \(ids: string\[\]\) => \{[\s\S]{0,160}ids\.length <= 1[\s\S]{0,120}\}/.test(videoPanel),
  "VideoPanel：单镜直接出片（Inspector 就在旁边，改词入口本来就有）");
ok(/const askGenerate = \(ids: string\[\]\) => \{[\s\S]{0,160}ids\.length <= 1[\s\S]{0,120}\}/.test(shotsPanel),
  "ShotsPanel：同上");
{
  // 三个出片入口：待出片批量 + 参考资产变了重生成 + 渠道故障重试
  // （定义那行是 `const askGenerate = (ids…`，`askGenerate(` 匹配不到它）
  const calls = videoPanel.match(/askGenerate\(/g) || [];
  ok(calls.length === 3
     && videoPanel.includes("onClick={() => askGenerate(pendingIds)}")
     && videoPanel.includes("() => askGenerate(\n")
     && videoPanel.includes("askGenerate(retryableShots.map((s) => s.id))"),
    "★ VideoPanel 的三个出片入口全走终审（风险一样，只是选的镜头不同）",
    `askGenerate( 出现 ${calls.length} 次，应为 3`);
  ok(/onProceed=\{\(\) => \{ setPreflight\(null\); askGenerate\(pendingIds\); \}\}/.test(shotsPanel),
    "★ ShotsPanel：生产检查通过后先终审再出片（先排除「根本跑不了」，再看文本）");
  ok(/onClick=\{\(\) => \{ askGenerate\(\[\.\.\.multiSel\]\); setMultiSel\(new Set\(\)\); \}\}/.test(shotsPanel),
    "多选出片也走终审");
}
{
  // 先关窗再提交：提交是异步的，留着弹窗会让人以为还在等
  const both = [videoPanel, shotsPanel].every((s) =>
    /onConfirm=\{\(\) => \{\n\s*const ids = reviewIds;\n\s*setReviewIds\(null\);/.test(s));
  ok(both, "确认后**先关窗再提交**（提交是异步的，留着弹窗会让人以为还在等）");
}
ok(/口径必须如实/.test(dialog) && /拆解不会自动出片/.test(dialog),
  "文案纠正误解：写明拆解不会自动出片（免得用户以为关掉弹窗也照跑）");

console.log("\n[5] 资产图垫图：显式参考图优先于定妆图自动挑选");
{
  ok(/refUrls\?: string\[\]/.test(apiSrc),
    "api.submitAssetCandidates 接受 refUrls");
  ok(/ref_urls: body\.refUrls\?\.length \? body\.refUrls : null/.test(apiSrc),
    "★ 空数组传 null 而不是 [] —— 传 [] 会被后端当成「显式空列表」而跳过自动挑选");
  ok(/refUrls: refs/.test(assetDialog), "AssetDialog 把垫图带进出片请求");
  ok(/MAX_REFS = 3/.test(assetDialog), "上限 3 张（后端 image.py 取 urls[:4]，界面留一张余量）");
  ok(/api\.uploadMedia/.test(assetDialog) && /compressImage/.test(assetDialog),
    "本地上传先压缩再传（垫图动辄几 MB，不压缩会拖慢出图）");
  ok(/addCurAsRef/.test(assetDialog),
    "可把「当前图」一键当作垫图（照这张的构图/风格再来一张）");
}
{
  const routes = readBackend("app/routes_v2.py");
  const jobs = readBackend("app/jobs.py");
  const image = readBackend("app/providers/image.py");
  if (!routes || !jobs || !image) {
    skipBackend("ref_urls 后端串联");
  } else {
    ok(/ref_urls:\s*Optional\[list\[str\]\]/.test(routes),
      "AssetGenerateIn 有 ref_urls 字段");
    const gen = routes.slice(routes.indexOf("def assets_generate"), routes.indexOf("def assets_generate") + 3000);
    ok(/refs = list\(body\.ref_urls or \[\]\)/.test(gen),
      "★ routes_v2：显式 ref_urls 先落 refs，仅在为空时才自动挑定妆图");
    const cand = jobs.slice(jobs.indexOf("def run_asset_candidates"), jobs.indexOf("def run_asset_candidates") + 4000);
    ok(/refs = list\(p\.get\("ref_urls"\) or \[\]\)/.test(cand),
      "★ jobs.run_asset_candidates：同一条优先级（job 路径与同步路径不许分叉）");
    ok(/ref_urls=refs or None/.test(cand),
      "ref_urls 最终传到 provider.generate（空则 None，让 provider 自己决定）");
    ok(/_load_ref_bytes/.test(image), "ImageProvider 有参考图加载实现");
    const load = image.slice(image.indexOf("def _load_ref_bytes"), image.indexOf("def _load_ref_bytes") + 2000);
    ok(/\[:4\]/.test(load), "最多取 4 张参考图（与 MAX_REFS=3 一致，留一张余量）");
    ok(/_resolve_local/.test(load),
      "本地 /fw/media/ 文件走 _resolve_local 直读（不绕一圈 http 下载）");
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 提示词终审 + 垫图：${pass} 项通过${fail ? `，${fail} 项失败` : ""}\n`);
process.exit(fail === 0 ? 0 : 1);
