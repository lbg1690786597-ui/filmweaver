/**
 * verify-appcast-channel.ts — 发布通道映射的一致性
 *
 * ## 这一节钉的是什么
 *
 * 「客户端去哪儿查更新」与「我们把包发到哪儿」是**两处独立写下的**事实：
 *
 * - 查更新：`.github/workflows/build-windows.yml` 按 tag 给
 *   `plugins.updater.endpoints` 写死 `/fw` 或 `/fwp` 的 latest.json
 * - 发包：`sync_appcast.py` / `scripts/publish-update.py` 按通道选目录与基址
 *
 * 两边对不上的表现是**没有表现**：客户端安安静静地查一个永远不更新的端点，
 * 或者更糟——正式版用户被指到 beta 通道，装上一个连着 dev 后端(8002)的包。
 * 没有任何日志会说这件事，只有几天后"怎么没人收到更新"。
 *
 * 此前这两处**从未交叉核对过**，且发包侧的映射还各写了两份
 * （`publish-update.py` 两组常量、`sync_appcast.py` 只有一组，
 * 后者的单组常量在 dev 仓指 beta、在 prod 仓指正式——
 * 「发到哪条通道」取决于你站在哪个仓，而不是取决于 tag）。
 *
 * 现在发包侧收敛到 `scripts/appcast_channel.py` 一处，本脚本负责把它
 * 与 CI 侧对上，并拦住任何"再把常量抄回脚本里"的回退。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
const ok = (cond: boolean, msg: string, hint = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${msg}${!cond && hint ? `\n      ${hint}` : ""}`);
};

// ---- ① python 侧的表驱动自检必须自己先绿 ----
console.log("① appcast_channel.py 自检");
let selfTestOut = "";
let selfTestOk = false;
try {
  selfTestOut = execFileSync("python3", ["scripts/appcast_channel.py", "--self-test"],
    { cwd: ROOT, encoding: "utf8" });
  selfTestOk = true;
} catch (e) {
  selfTestOut = String((e as { stdout?: string }).stdout ?? e);
}
ok(selfTestOk, "python3 scripts/appcast_channel.py --self-test 退出码 0",
   selfTestOut.split("\n").filter((l) => l.includes("❌")).join("\n      "));

// ---- ② 把 python 侧的常量取出来（不重新解析源码，直接问它本人） ----
interface Ch { beta: boolean; dir: string; base_url: string; stem_prefix: string }
let BETA: Ch, RELEASE: Ch;
try {
  const dump = execFileSync("python3", ["-c",
    "import json,sys; sys.path.insert(0,'scripts'); import appcast_channel as a; "
    + "f=lambda c:{'beta':c.beta,'dir':str(c.dir),'base_url':c.base_url,"
    + "'stem_prefix':c.stem_prefix}; print(json.dumps([f(a.BETA),f(a.RELEASE)]))"],
    { cwd: ROOT, encoding: "utf8" });
  [BETA, RELEASE] = JSON.parse(dump) as [Ch, Ch];
} catch (e) {
  console.log(`  ❌ 无法读出通道常量: ${e}`);
  process.exit(1);
}

// ---- ③ 与 CI 的更新端点交叉核对（本脚本存在的**主要理由**） ----
//
// CI 里那两行是客户端**实际会去查**的地址。发包侧的 base_url 必须正好是它去掉
// 末尾 /latest.json —— 差一个字符，客户端就查不到我们发的东西。
console.log("\n② 与 CI(build-windows.yml) 的更新端点交叉核对");
const ci = read(".github/workflows/build-windows.yml");
const ciUrls = [...ci.matchAll(/\$appcast\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
ok(ciUrls.length === 2, "CI 里恰好两条 $appcast 赋值（beta / 正式各一）",
   `实际 ${ciUrls.length} 条: ${ciUrls.join(", ")}`);

const expectBeta = `${BETA.base_url}/latest.json`;
const expectRel = `${RELEASE.base_url}/latest.json`;
ok(ciUrls.includes(expectBeta),
   "★ CI 的 beta 端点 === appcast_channel.BETA.base_url + /latest.json",
   `期望 ${expectBeta}\n      CI 实际 ${ciUrls.join(" | ")}`);
ok(ciUrls.includes(expectRel),
   "★ CI 的正式端点 === appcast_channel.RELEASE.base_url + /latest.json",
   `期望 ${expectRel}\n      CI 实际 ${ciUrls.join(" | ")}`);

// 同一条通道里，「客户端连哪个后端」与「去哪儿取更新」共用同一个前缀：
//   beta  → …:9080/fw   + /media/appcast
//   正式  → …:9080/fwp  + /media/appcast
// 这就是规则里「beta 连 dev 8002、正式连 prod 8003」那一条。CI 把 apiBase 写进
// .env.production（覆盖仓里的值），所以 CI 那两行才是真正生效的那份。
// 交叉错配的表现最恶劣：**正式版客户端连上开发库**，功能看着全对、数据是 dev 的。
const ciApi = [...ci.matchAll(/\$apiBase\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
const stripped = (u: string) => u.replace("/media/appcast", "");
ok(ciApi.length === 2, "CI 里恰好两条 $apiBase 赋值",
   `实际 ${ciApi.length} 条: ${ciApi.join(", ")}`);
ok(ciApi.includes(stripped(BETA.base_url)),
   "★ beta 客户端连的后端与 beta 更新通道同前缀（/fw → dev 8002）",
   `期望 ${stripped(BETA.base_url)}\n      CI 实际 ${ciApi.join(" | ")}`);
ok(ciApi.includes(stripped(RELEASE.base_url)),
   "★ 正式客户端连的后端与正式更新通道同前缀（/fwp → prod 8003）",
   `期望 ${stripped(RELEASE.base_url)}\n      CI 实际 ${ciApi.join(" | ")}`);

// productName 决定安装包文件名，而发包侧按 stem_prefix 找文件。CI 改了
// productName 而这边没跟，表现是"Release 里找不到资产"——发版当场失败（尚可），
// 但反过来（这边改了 CI 没改）会**发布一个指向不存在文件的 manifest**：
// 客户端查到更新、下载 404、静默失败。所以两个方向都钉。
console.log("\n③ productName ↔ 安装包名前缀");
ok(/\$c\.productName\s*=\s*"FilmWeaver Beta"/.test(ci),
   "CI 的 beta productName 仍是 「FilmWeaver Beta」");
ok(BETA.stem_prefix === "FilmWeaver.Beta",
   "★ beta 前缀是 FilmWeaver.Beta（GitHub 把空格换成点）",
   `实际 ${BETA.stem_prefix}`);
ok(/\$c\.productName\s*=\s*"FilmWeaver"/.test(ci),
   "CI 的正式 productName 仍是 「FilmWeaver」");
ok(RELEASE.stem_prefix === "FilmWeaver",
   "★ 正式前缀是 FilmWeaver", `实际 ${RELEASE.stem_prefix}`);

// ---- ④ 不许把常量抄回脚本里（这正是当初漂移的成因） ----
console.log("\n④ 发布脚本里不得再出现硬编码的通道常量");
const HARD = /filmweaver(-prod)?-data\/appcast|\/fwp?\/media\/appcast/;
for (const f of ["sync_appcast.py", "scripts/publish-update.py"]) {
  const lines = read(f).split("\n");
  // 注释/文档字符串里提到路径是**好事**（解释为什么），只禁止**代码**里再出现。
  const hits = lines
    .map((l, i) => ({ l: l.trim(), n: i + 1 }))
    .filter(({ l }) => HARD.test(l) && !l.startsWith("#") && !l.startsWith("*")
      && !l.startsWith('"""') && !l.includes("python3 sync_appcast.py"));
  ok(hits.length === 0, `${f} 未再硬编码通道目录/基址`,
     hits.map((h) => `${h.n}: ${h.l}`).join("\n      ")
     + "\n      通道常量只应在 scripts/appcast_channel.py 里出现一次");
}

// ⚠️ 本脚本**不能**断言的部分，如实记下：
//   · `.env.production` 与 `tauri.conf.json` 的 updater endpoint 都会被 CI 在
//     构建时**覆盖**（build-windows.yml 第 84、87 行），所以仓里的值只影响
//     本地 `npm run build`，钉死它反而会误导；
//   · 「客户端真的从这个端点收到了更新」只能靠真机装一次，前端断言不了。

if (failed) {
  console.log(`\n❌ ${failed} 项不通过`);
  process.exit(1);
}
console.log("\n✅ 发布通道映射一致");
