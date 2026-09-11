/**
 * verify-image-compress.ts — 上传前压缩 + 上传链路不再锁窗/不再自动看图（2026-09-10）
 *
 * ## 这个脚本存在的直接原因
 *
 * 用户原话：「当用户自己上传资产图片时，上传速度非常非常慢，而且现在会把页面
 * 锁定导致无法进行任何其他操作」。拆开是三件独立的事，各自都会**悄悄回潮**：
 *
 * ① **传的字节太多** —— 定妆图是手机/单反原图（5~20MB、四五千像素），
 *    而它在织影里只用来当参考图和缩略图，多传的字节纯粹是等待时间。
 * ② **请求里同步等了一次多模态调用** —— 换图链路上挂着 `vision_desc` 视觉反推，
 *    一次 ~8s 且要把图整份 base64 上行。它是"顺手加的锦上添花"，
 *    最容易在某次重构里被顺手加回来。
 * ③ **上传期间不许关窗** —— 全屏遮罩 + `guardedClose` 把 `uploading` 也挡了。
 *    可上传阶段 File 早已交给 `fetch`，关窗根本不影响它跑完；挡住毫无收益，
 *    代价是用户几十秒里什么都干不了。
 *
 * 外加一条**看不见但更贵**的：`AssetDialog` 的造型描述输入框原来预填
 * `角色立绘, {名字}, 全身, 高质量, 短剧风格`。用户碰一下输入框它就被存成
 * 这个角色的"造型描述"，出片时又被拼进**视频提示词**（jobs.py 的 ref_notes 段），
 * 长成「参考图1（林晨）：角色立绘, 林晨, 全身, 高质量, 短剧风格」——纯噪声。
 *
 * 压缩的纯逻辑抽在 `src/lib/imageCompress.ts`（canvas 部分留在运行时），
 * 链路上的约定用源码断言钉住——它们全是"错了不报错、只是又变慢/又锁死"。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_EDGE, SIZE_LIMIT, isCompressibleType, jpegName, needsCompress, targetSize,
} from "../src/lib/imageCompress";

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

const MB = 1024 * 1024;

/* ================================================================== */
console.log("\n① 阈值：超了才压，没超不碰");

ok("2MB 以内 + 尺寸不超 → 不压",
  !needsCompress(1.5 * MB, 1200, 1600),
  "本来就规矩的图再走一遍 canvas 重编码，只掉画质不省时间，是净亏");
ok("体积超阈值 → 压", needsCompress(6 * MB, 1000, 1000));
ok("长边超 2048 → 压（哪怕体积很小）",
  needsCompress(300 * 1024, 6000, 800),
  "体积小但像素极大的图（纯色线稿 PNG）上传是快，"
  + "但之后每次读取与缩放都要按 6000px 走一遍");
check("阈值就是用户拍板的那两个数", [SIZE_LIMIT, MAX_EDGE], [2 * MB, 2048]);
ok("恰好等于阈值不算超（用 > 不是 >=）",
  !needsCompress(SIZE_LIMIT, MAX_EDGE, MAX_EDGE),
  "边界上反复横跳会让同一张图有时压有时不压，排查时极难复现");

/* ================================================================== */
console.log("\n② 缩放：等比、只缩不放、不出现 0");

check("横图缩到长边 2048", targetSize(4096, 2048), { width: 2048, height: 1024 });
check("竖图缩到长边 2048", targetSize(3000, 6000), { width: 1024, height: 2048 });
check("小图原样返回（不放大）", targetSize(800, 600), { width: 800, height: 600 });
check("正好 2048 不动", targetSize(2048, 1000), { width: 2048, height: 1000 });

{
  // 20000×3 的极端细长图：按比例 3 * (2048/20000) = 0.307 → round 得 0。
  // canvas 宽或高为 0 会直接抛错，整条上传就废了。
  const r = targetSize(20000, 3);
  ok("极端细长图不会算出 0（canvas 尺寸为 0 会抛错）",
    r.width >= 1 && r.height >= 1,
    `算出了 ${r.width}×${r.height}`);
}

{
  const r = targetSize(4000, 3000);
  const ratio = r.width / r.height;
  ok("等比：缩放前后宽高比一致（差值 < 1%）",
    Math.abs(ratio - 4000 / 3000) / (4000 / 3000) < 0.01,
    `缩后 ${r.width}×${r.height}，比例 ${ratio.toFixed(4)}`);
}

/* ================================================================== */
console.log("\n③ 输出类型与文件名");

check("可压类型", ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml", ""]
  .map(isCompressibleType), [true, true, true, false, false, false]);
ok("gif 不压", !isCompressibleType("image/gif"),
  "canvas 重编码只会留下第一帧，动图直接变静图");
ok("大小写不敏感", isCompressibleType("IMAGE/JPEG"));

check("后缀换成 .jpg", jpegName("定妆照.PNG"), "定妆照.jpg");
check("多个点只换最后一段", jpegName("a.b.c.webp"), "a.b.c.jpg");
check("没有后缀也给一个", jpegName("照片"), "照片.jpg");
check("空名字有兜底", jpegName(""), "image.jpg");
ok("必须换后缀，不能留 .png",
  !jpegName("x.png").endsWith(".png"),
  "后端按扩展名收文件也按扩展名判 kind（media.ALLOWED_EXT / _IMAGE_EXT）；"
  + "名为 png 内容是 jpeg 的文件，眼下能显示，但任何按后缀分派的处理都会踩到");

/* ================================================================== */
console.log("\n④ 压缩实现里三条毁图的坑（源码断言）");
{
  const src = read("src/lib/imageCompress.ts");
  ok("EXIF 朝向显式带上（imageOrientation: from-image）",
    /imageOrientation:\s*"from-image"/.test(src),
    "手机竖拍的照片像素其实是横的、靠 EXIF 转正；canvas 重编码会丢掉 EXIF。"
    + "不显式转正的话用户传上去的图会躺倒 90°，而且预览里还是正的（读的是原文件），"
    + "要等出片才发现");
  ok("绘制前铺白底",
    /fillStyle\s*=\s*"#ffffff"/.test(src) && /fillRect\(0,\s*0/.test(src),
    "JPEG 没有透明通道，不铺白的话透明区默认填**黑**，抠好背景的立绘会变黑底");
  ok("压完更大就退回原图",
    /blob\.size\s*>=\s*originalBytes/.test(src),
    "已经是高压缩率的 JPEG 再编码一次可能变大，那时候压缩就是纯粹的画质损失");
  ok("任何失败都退回原文件，不抛错",
    /catch\s*\{[\s\S]{0,200}return plain\("failed"\)/.test(src),
    "压缩是优化不是前提：解码失败就原样传，慢一点远好过传不上去");
}

/* ================================================================== */
console.log("\n⑤ 上传链路：压了、清了描述、不锁窗");
{
  const tsx = read("src/components/AssetDialog.tsx");

  ok("资产弹窗上传前先压",
    /const small = await compressImage\(f\)/.test(tsx)
    && /api\.uploadMedia\(small\.file/.test(tsx),
    "漏了这一步就回到「上传非常非常慢」");

  ok("换图时把旧造型描述一并清空（三条落库路径都带标志）",
    /clear_description:\s*true/.test(tsx)
    && /clearPrompt:\s*true/.test(tsx)
    && (tsx.match(/clearPrompt:\s*true/g) ?? []).length >= 2,
    "旧描述是拆剧本时按剧本文字写的，与用户刚传的图无关；出片时它作为参考图的"
    + "文字锚点注入，且提示词明写「原稿中与之矛盾的服装描写一律以此为准改写」"
    + "——文字压过参考图，人物外观必然漂移（这就是用户说的「外观漂移」）。"
    + "三条路径分别是 patchStage / patchAsset / upsertAssetImage，漏一条就漏一类资产");

  ok("清空后输入框与 savedRef 同步清掉",
    /savedRef\.current = ""/.test(tsx) && /setPromptDirty\(false\)/.test(tsx),
    "库里清了、框里还留着旧文字的话，下一次失焦 savePrompt 会把它原样写回去，"
    + "清空等于白做");

  ok("采用 AI 候选图**不**清描述",
    !/pick[\s\S]{0,400}clear_description/.test(tsx),
    "候选图本来就是照着这段描述生出来的，清掉就把唯一正确的锚点删了");

  ok("上传中允许关窗（guardedClose 只挡 picking）",
    /if \(picking\) \{/.test(tsx) && !/if \(busyUpload\) \{[\s\S]{0,120}onToast/.test(tsx),
    "上传阶段 File 已交给 fetch，关窗不影响它跑完；挡住的唯一效果就是"
    + "几十秒里整页锁死——这正是用户说的「页面锁定无法进行任何其他操作」");

  ok("上传中的提示不再写「请勿关闭窗口」",
    !/正在上传[\s\S]{0,40}请勿关闭窗口/.test(tsx),
    "既然能关了，还写着不许关就是在骗用户继续干等");

  ok("选文件阶段仍然挡（真的会丢）",
    /正在选择\$\{upStat\.what\}…（选完或取消前请勿关闭窗口）/.test(tsx)
    || /选完或取消/.test(tsx),
    "picking 时 <input type=file> 还长在弹窗里，弹窗一卸载它就没了，"
    + "选完文件的 change 事件没有任何接收方：文件选了、什么都没发生、也没有报错");
}

/* ================================================================== */
console.log("\n⑥ 视觉反推：从上传链路里摘干净，只留手动按钮");
{
  const routes = read("../backend/app/routes_v2.py");
  const vision = read("../backend/app/vision_desc.py");
  const tsx = read("src/components/AssetDialog.tsx");

  ok("后端换图/建资产的四条路径都不再调 vision_desc",
    !/refresh_if_auto/.test(routes)
    && (routes.match(/vision_desc\.derive/g) ?? []).length <= 1,
    "一次多模态调用实测均 8.2s，还要把刚落盘的图整份读成 base64 上行（体积 ×1.33），"
    + "渠道不健康时还要逐渠道 fallback——这是「上传非常非常慢」里最大的一段");

  ok("已删除 refresh_if_auto（否则下次重构又会被接回上传链路）",
    !/def refresh_if_auto/.test(vision),
    "留着一个「换图时自动重算描述」的现成函数，就是留着一个再犯同样错误的入口");

  ok("手动入口存在且不落库",
    /@router\.post\("\/assets\/describe-image"\)/.test(routes)
    && /\*\*不落库\*\*/.test(routes),
    "结果要先回给输入框让用户过目，直接写库就等于换了个地方自动生成");

  ok("手动入口失败要显式报错（不能沿用 derive 的静默 None）",
    /status_code=502/.test(routes),
    "批量回填吞掉异常是对的，但**用户点了按钮**却静默返回空 = 按钮坏了");

  ok("前端有「AI 看图补写」按钮，且只转自己不锁弹窗",
    /AI 看图补写/.test(tsx) && /descBusy/.test(tsx)
    && !/setUploading\(true\)[\s\S]{0,200}describeImage/.test(tsx),
    "它是可选的锦上添花，没理由让弹窗其它部分跟着不能动");

  ok("按钮填进去的文字会被显式保存",
    /await savePrompt\(r\.description\)/.test(tsx),
    "程序填进输入框不会触发 blur——只 setPrompt 的话用户点完按钮以为存上了，"
    + "关掉弹窗就没了");

  ok("图读不到时当场抛错，不把本地路径原样下发给网关",
    /图片不存在或无法读取/.test(read("../backend/app/providers/llm.py")),
    "旧写法是「解析得到文件就转 base64，否则原样发」。那个相对路径网关取不到，"
    + "实测两种结局：逐渠道超时重试拖到几分钟，或者模型照着系统提示词凭空**编**"
    + "一段造型描述回来——后者会被当成真描述落库，正是本次在修的外观漂移");
}

/* ================================================================== */
console.log("\n⑦ 造型描述不再被模板污染");
{
  const tsx = read("src/components/AssetDialog.tsx");

  ok("输入框初值不再预填生图模板",
    !/useState\(\(\) =>\s*\n?\s*stripAuto\(savedDesc\)\s*\n?\s*\|\|/.test(tsx)
    && /useState\(\(\) => stripAuto\(savedDesc\)\)/.test(tsx),
    "预填的模板只要被用户碰一下就会存成该角色的造型描述，"
    + "再被拼进视频提示词：「参考图1（林晨）：角色立绘, 林晨, 全身, 高质量, 短剧风格」"
    + "——对视频模型是纯噪声，还挤掉了真正该说的服装信息");

  ok("模板只在提交生图那一刻临时套用",
    /const imagePrompt = prompt\.trim\(\) \|\| genTemplate\(/.test(tsx)
    && /prompt: imagePrompt/.test(tsx),
    "描述为空也该能点生成，只是那次用的提示词不写回库");

  ok("空描述有 placeholder 引导而不是 value 预填",
    /placeholder=\{t\.kind === "location"/.test(tsx),
    "placeholder 不会被存；value 会");

  ok("界面上不再自称「生图提示词」",
    !/（也是生图提示词）/.test(tsx),
    "用户原话：「造型描述(也是生图提示词)似乎并不真的是生图提示词」。"
    + "它的主业是出片时给参考图当文字锚点；按「提示词」的写法去填"
    + "（高质量/短剧风格这类词）就会跟着进视频提示词");

  ok("明确告诉用户留空是正当选择",
    /留空也可以/.test(tsx),
    "上传自己的图时我们就是主动清空的。不说清楚的话，用户会以为是 bug 又手动填回去，"
    + "外观漂移就又回来了");
}

/* ================================================================== */
console.log("\n⑧ 自定义资产上传走同一条策略");
{
  const lib = read("src/components/LibraryPanel.tsx");
  ok("LibraryPanel 上传自定义资产也先压",
    /const small = await compressImage\(f\)/.test(lib)
    && /api\.uploadMedia\(small\.file/.test(lib),
    "同一个用户、同样的原图，只是入口不同——只修一处等于没修");
  {
    // 只看 doCustomUpload 这一段：同文件里的 doCustomGen **应该**带 prompt
    // （那条路上 prompt 就是生成这张图用的提示词，两者天然一致）。
    const seg = lib.slice(lib.indexOf("const doCustomUpload"),
                          lib.indexOf("const doCustomGen"));
    ok("上传的图不编造 prompt",
      seg.includes("createAsset(") && !/prompt:/.test(seg),
      "上传的图没有对应文字描述，留空才对：出片走「无描述则禁止书写服装/陈设」的兜底，"
      + "外观完全由这张图钳制");
  }
}

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 上传链路全部通过：超阈值才压且等比不毁图（EXIF/白底/变大退回）、"
    + "换自己的图会清掉与它无关的旧造型描述、上传中可关窗、"
    + "视觉反推只剩手动按钮、造型描述不再被生图模板污染"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
