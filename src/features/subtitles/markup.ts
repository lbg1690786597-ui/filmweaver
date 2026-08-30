/**
 * features/subtitles/markup.ts — 剧本标记剥离（纯函数）
 *
 * 单独成文件、**不 import 任何东西**，是为了让 Node 侧的验证脚本能直接引它。
 * 放在 generate.ts 里会连带把 `api.ts` 拖进来，而 api.ts 在模块顶层读
 * `import.meta.env`，tsx 一跑就炸。纯函数就该跟 I/O 分开。
 */

/** 剧本标记符号。与后端 `script_import._MARKUP_SYMBOLS` 保持同一份清单。 */
const MARKUP_SYMBOLS = "△▲▽▼◆◇○●■□※☆★＊*·・•";
/** 技术标注：括号内只有拉丁字母/点/空格且很短。(OS)/(V.O.)/(CU)/(E) 之类，
 *  整体删掉——只去括号会留下 "角色名OS：" 被念成"欧艾斯"。 */
const TECH_ANNOTATION = /[（(][A-Za-z][A-Za-z.\s]{0,5}[）)]/g;
/** 其余成对括号只去壳留内文：【冷笑】→ 冷笑 */
const BRACKET_CHARS = "【】〖〗〔〕［］";

/**
 * `backend/app/script_import.py:strip_script_markup` 的前端镜像。
 *
 * 为什么前端也要来一遍：后端的剥离是在**旁白落库时**做的，只对新合成的
 * 旁白生效。库里已有的旁白（本机 dev 库 21 条）文本里仍带着 △ 和【】，
 * 重新合成要花 TTS 的钱，不该为了字幕强迫用户重跑。
 *
 * ⚠️ 副作用要说清楚：那些老旁白的音频里，符号是**被念出来了**的
 * （实测依据见 align.ts 头注释）。这里剥掉符号后按字符数分配时间，
 * 会引入极小的比例偏差——符号占全文不到 2%，且分布均匀，
 * 再经静音点吸附消掉累积误差，实测不影响观感。
 * 让字幕上出现"△"才是真正不能接受的。
 *
 * 边界与后端一致：**只删符号，一个汉字都不删**。
 */
export function stripScriptMarkup(text: string): string {
  let s = text || "";
  if (!s) return "";
  s = s.replace(TECH_ANNOTATION, "");
  for (const ch of BRACKET_CHARS) s = s.split(ch).join("");
  for (const ch of MARKUP_SYMBOLS) s = s.split(ch).join("");
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.split("\n").map((l) => l.trim()).join("\n");
  return s.trim();
}
