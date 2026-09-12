/**
 * verify-attribute.ts — 上传素材归属推断的规则验证（3.11 A1）
 *
 * 逐条钉死 `features/assets/attribute.ts` 的规则表。为什么这批规则值得单独测：
 *
 * - **归错了不会报错**。一张挂到别人名下的定妆图会安安静静地参与生成，
 *   用户多半要等成片出来才发现"这个人怎么长这样"。没有异常可依赖，
 *   只能靠断言把规则钉住。
 * - **最长匹配优先**最容易在重构里被写反成"先命中先用"，
 *   而 `陆沉` / `陆沉父亲` 这种前缀关系在中文名字里非常常见
 *   （后端 `char_alias.py` 专门写了注释说「陆明父亲 ⊃ 陆明 但是两个人」）。
 * - **并列必须交给用户**是产品裁定，不是实现细节：`review` 一旦回归 false，
 *   自动归属就会开始替用户在两个人之间瞎选。
 */

import {
  attributeFiles, attributeOne, buildPool, episodeOf, stripExt, stripVerbatim,
  tokenize, type AttributeContext,
} from "../src/features/assets/attribute";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}

// 一个像真项目的上下文：两个角色、一个场景、一张已有的自定义图
const CTX: AttributeContext = {
  assets: [
    { id: "a1", kind: "character", name: "陆沉" },
    { id: "a2", kind: "character", name: "陆沉父亲" },
    { id: "a3", kind: "location", name: "咖啡馆" },
    { id: "a4", kind: "custom", name: "随手拍" },
  ],
  characterGroups: [
    { canonical: "陆沉", members: [{ raw_name: "小陆" }, { raw_name: "少年陆沉" }] },
  ],
  sceneGroups: [
    { canonical: "咖啡馆", members: [{ raw_name: "剧情咖啡馆" }, { raw_name: "咖啡馆日景" }] },
  ],
};

const one = (name: string, path?: string) =>
  attributeFiles([{ name, path }], CTX)[0];

console.log("① stripExt / stripVerbatim：两个纯字符串预处理");
{
  check("剥扩展名", stripExt("陆沉_定妆.jpg"), "陆沉_定妆");
  check("多点文件名只剥最后一段", stripExt("a.b.c.png"), "a.b.c");
  check("没有扩展名不动", stripExt("陆沉"), "陆沉");
  // 隐藏文件要小心：`.gitignore` 的"扩展名"其实是整个名字。
  // 剥掉会得到空串，空串 needle 又会被跳过——不至于误归属，但没必要制造空 token。
  check("隐藏文件不误剥", stripExt(".gitignore"), ".gitignore");
  check("剥 verbatim 盘符前缀", stripVerbatim(String.raw`\\?\C:\a\b.png`), String.raw`C:\a\b.png`);
  check("剥 verbatim UNC 时还回双反斜杠",
        stripVerbatim(String.raw`\\?\UNC\srv\share\a.png`), String.raw`\\srv\share\a.png`);
  check("普通路径不动", stripVerbatim(String.raw`C:\a\b.png`), String.raw`C:\a\b.png`);
}

console.log("② tokenize：中文名被分隔符切开的补救");
{
  check("无分隔符整串保留", tokenize("陆沉定妆"), ["陆沉定妆"]);
  check("被切成 陆-沉 时能拼回 陆沉",
        tokenize("陆-沉-定妆").includes("陆沉"), true);
  // 去分隔符的整串必须留着：`陆沉_定妆` 的用户可能想整体匹配 `陆沉定妆`，
  // 而下一行是它的另一面——逐段也得留着，否则 `陆沉_定妆` 认不出 `陆沉`
  check("整串（去分隔符）保留", tokenize("陆沉_定妆").includes("陆沉定妆"), true);
  check("逐段也保留", tokenize("陆沉_定妆").includes("陆沉"), true);
  check("三段拼接", tokenize("陆-沉-定妆").includes("陆沉定妆"), true);
  check("括号/间隔号也当分隔符", tokenize("陆沉【定妆】").includes("陆沉"), true);
}

console.log("③ episodeOf：集数线索");
{
  check("第3集", episodeOf("陆沉-第3集-战损"), 3);
  check("EP03", episodeOf("si_EP03_a"), 3);
  check("S02E05", episodeOf("S02E05_陆沉"), 5);
  check("03集（无'第'）", episodeOf("陆沉03集定妆"), 3);
  check("没有集数", episodeOf("陆沉定妆"), null);
  check("年份不会被当成集数（否则 2026 会变第 2026 集）",
        episodeOf("2026版陆沉造型"), null);
}

console.log("④ 规则 1：文件名命中资产名 —— 且最长匹配优先");
{
  const r = one("陆沉_定妆.jpg");
  check("归到陆沉", r.guess?.name, "陆沉");
  check("规则记为 name", r.rule, "name");
  check("把握满格", r.confidence, 1);
  check("无需人工复核", r.review, false);

  // ⚠️ 这里是最长匹配的判据：`陆沉父亲` 必须赢过 `陆沉`。
  //    写反了会把父亲的图挂到儿子脸上，而且**不会报任何错**。
  const f = one("陆沉父亲_定妆.png");
  check("陆沉父亲 赢过 陆沉（最长匹配）", f.guess?.name, "陆沉父亲");
  check("另一个是落选候选", f.candidates.map((c) => c.target.name), ["陆沉"]);}

console.log("⑤ 规则 1'：别名命中（小陆 → 陆沉）");
{
  const r = one("小陆.png");
  check("归到 canonical 陆沉", r.guess?.name, "陆沉");
  check("规则记为 alias（面板要显示'按别名匹配'）", r.rule, "alias");
  check("带上资产 id", r.guess?.assetId, "a1");
}

console.log("⑥ 场景侧同样走别名（剧情咖啡馆 → 咖啡馆）");
{
  const r = one("剧情咖啡馆-日景.png");
  check("归到咖啡馆", r.guess?.name, "咖啡馆");
  check("kind 是 location", r.guess?.kind, "location");
}

console.log("⑦ 并列不可辨 —— 必须交给人，不许自动决定");
{
  // 「陆沉与陆明」里两个名字等长，任何"取第一个"的决定都是瞎猜
  const ctx: AttributeContext = {
    assets: [
      { id: "a1", kind: "character", name: "陆沉" },
      { id: "a2", kind: "character", name: "陆明" },
    ],
  };
  const r = attributeFiles([{ name: "陆沉与陆明-合影.png" }], ctx)[0];
  check("标了需要人工复核", r.review, true);
  check("并列的那个进了候选", r.candidates.map((c) => c.target.name), ["陆明"]);
  // 同长但**同一对象**（别名指向自己那种）不该被当成并列
  const r2 = attributeFiles([{ name: "陆沉定妆与陆沉造型.png" }], ctx)[0];
  check("同一对象的重复命中不算并列", r2.review, false);
}

console.log("⑧ 规则 2：只判出类别（不知道是谁）");
{
  const r = one("定妆-02.jpg");
  check("认出是角色向", r.guess?.kind, "character");
  check("但没有名字", r.guess?.name, "");
  check("没 assetId", r.guess?.assetId, null);
  check("规则记为 keyword", r.rule, "keyword");
  check("把握低", r.confidence, 0.3);
  check("必须人工选人", r.review, true);

  const l = one("空镜-03.png");
  check("空镜判成场景", l.guess?.kind, "location");
}

console.log("⑨ 规则 3：文件名没线索，目录名给的");
{
  const r = one("IMG_0001.png", "/Users/u/项目/角色/陆沉/IMG_0001.png");
  check("归到陆沉", r.guess?.name, "陆沉");
  check("规则记为 path", r.rule, "path");
  check("把握降半（目录名比文件名弱）", r.confidence, 0.5);

  // verbatim 前缀必须不干扰目录匹配：不剥的话第一段是 `\\?\C:`，
  // 虽然不会误命中，但真机拖进来的路径会因此整条判不出
  const w = one("IMG_0002.png", String.raw`\\?\C:\p\角色\陆沉\IMG_0002.png`);
  check("带 verbatim 前缀也能按目录认出", w.guess?.name, "陆沉");
}

console.log("⑩ 规则 4：都不中 → 待归属（**不是** custom）");
{
  const r = one("DSC_1234.jpg");
  check("没有推断结果", r.guess, null);
  check("规则 none", r.rule, "none");
  check("把握 0", r.confidence, 0);
  check("不进复核（用户是主动去拖，不该弹框打扰）", r.review, false);
}

console.log("⑪ 阶段线索：认出角色 + 带集数/造型词 → 走造型阶段");
{
  const r = one("陆沉-第3集-战损.png");
  check("仍归到陆沉", r.guess?.name, "陆沉");
  check("带集数线索", r.stageHint?.episode, 3);
  check("带阶段名", r.stageHint?.stageName, "战损");

  const plain = one("陆沉.png");
  check("光有名字没有阶段线索 → stageHint 为空", plain.stageHint, null);

  // 场景不产生阶段线索（阶段是角色独有的模型）
  const loc = one("咖啡馆-第3集.png");
  check("场景没有阶段", loc.stageHint, null);

  check("定妆也算阶段词", one("陆沉-定妆.png").stageHint?.stageName, "定妆");
}

console.log("⑫ buildPool：别名进池、长 needle 优先、无资产的归一名也进池");
{
  const pool = buildPool(CTX);
  const needles = pool.map((p) => p.needle);
  check("含别名 小陆", needles.includes("小陆"), true);
  check("含归一名 咖啡馆", needles.includes("咖啡馆"), true);
  check("池子按长度降序（最长匹配的第一道保险）",
        needles.every((n, i) => i === 0 || pool[i - 1].needle.length >= n.length), true);

  // 归一名没有对应资产时也要能归：至少告诉用户"看起来是场景 X 的"
  const noAsset = attributeFiles([{ name: "老宅.png" }], {
    assets: [],
    sceneGroups: [{ canonical: "老宅", members: [{ raw_name: "爷爷家" }] }],
  })[0];
  check("没有资产行也能认出归一名", noAsset.guess?.name, "老宅");
  check("assetId 为空（调用方据此提供'新建资产'）", noAsset.guess?.assetId, null);
}

console.log("⑬ 大小写与扩展名不干扰；批量调用逐条独立");
{
  check("大写扩展名照样剥", stripExt("LUCCHEN_定妆.PNG"), "LUCCHEN_定妆");

  const batch = attributeFiles(
    [{ name: "陆沉.png" }, { name: "DSC_1.jpg" }, { name: "小陆.jpg" }], CTX);
  check("批量逐条独立", batch.map((b) => b.guess?.name ?? null),
        ["陆沉", null, "陆沉"]);
  check("批量下待归属那条不被邻居影响", batch[1].rule, "none");
}

console.log("⑭ 单文件入口与批量入口结果一致（面板逐行改判走它）");
{
  // attributeOne 不做校验：面板逐行改判时会拿**用户改过之后的**池子再跑一遍，
  // 两个入口如果规则漂移，用户改完一行会看到结果跟自己刚才选的不一样。
  const pool = buildPool(CTX);
  const a = attributeOne({ name: "陆沉_定妆.jpg" }, pool);
  const b = one("陆沉_定妆.jpg");
  check("单文件入口与批量结果一致", a, b);

  const kw = attributeOne({ name: "空镜-03.png" }, pool);
  check("关键词兜底两入口也一致", kw, one("空镜-03.png"));

  const none = attributeOne({ name: "DSC_9.jpg" }, pool);
  check("待归属两入口也一致", none, one("DSC_9.jpg"));
}

console.log(failed ? `\n❌ ${failed} 项未通过` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
