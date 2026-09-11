/**
 * scripts/verify-crlf-safe.ts — 构建门禁不许对行尾敏感
 *
 * ## 为什么专门为「行尾」写一个验证
 *
 * 开发全在 Linux（LF），客户端构建全在 Windows runner（`core.autocrlf` 默认 true，
 * 检出即 CRLF）。这条缝隙上的 bug 有个恶劣性质：**本地怎么跑都是绿的**，只有
 * 推了 tag、等 CI 跑完十几分钟之后才炸，而且报错文案还指向别的东西。
 *
 * 2026-09-11 就真的发生了：v0.8.9 的 beta 与正式两条构建同时挂在 `npm run build`
 * 的第一步，报「回退块与 oklch 原值不一致」——听起来像有人改了颜色忘了重新生成，
 * 实际上颜色一个字节都没动，只是 CRLF 让逐字节比较不等。一次发版就这么废掉。
 *
 * 所以这里在**本地**把 CI 的行尾条件复现出来：
 *   [1] 拿真实的 tokens.css 造一份 CRLF 副本，跑真正的 gen-color-fallback.mjs，
 *       要求它照样通过 —— 这是上面那次失败的直接回归点。
 *   [2] LF 原样也必须通过（否则 [1] 可能是「脚本压根没在检查」的假绿）。
 *   [3] `.gitattributes` 必须存在、锁 eol=lf、且**已被 git 跟踪**——release.py 用
 *       `git ls-files` 挑文件，没 add 的文件根本不会同步到公开仓，CI 也就看不到它。
 *   [4] 仓库里不许出现 .bat/.cmd/.ps1 —— 那类文件在 Windows 上需要 CRLF，
 *       它们一旦出现，[3] 里那条一刀切的 `* eol=lf` 就从保护变成了伤害。
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};

/** 在临时目录里按脚本期望的相对布局摆好文件，用指定行尾写 tokens.css，跑一次真脚本。 */
function runGate(eol: "lf" | "crlf"): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), `fw-eol-${eol}-`));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "src", "styles"), { recursive: true });
    for (const f of ["gen-color-fallback.mjs", "oklch.mjs"]) {
      cpSync(join(ROOT, "scripts", f), join(dir, "scripts", f));
    }
    const lf = readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8").replace(/\r\n/g, "\n");
    writeFileSync(join(dir, "src/styles/tokens.css"), eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf, "utf8");
    try {
      const out = execFileSync("node", ["scripts/gen-color-fallback.mjs"], { cwd: dir, encoding: "utf8" });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n[1] 回退块校验必须扛得住 CRLF（CI 检出就是 CRLF）");
const crlf = runGate("crlf");
ok(crlf.code === 0,
  "★★ CRLF 副本照样通过 gen-color-fallback.mjs",
  `退出码 ${crlf.code}：${crlf.out.trim().split("\n")[0] ?? ""} —— v0.8.9 两条 CI 构建就死在这里`);

console.log("\n[2] LF 原样当然也要过（防止上一条是假绿）");
const lf = runGate("lf");
ok(lf.code === 0, "LF 副本通过", `退出码 ${lf.code}：${lf.out.trim()}`);
ok(/一致/.test(lf.out), "而且是真的比对过（输出里报了结论，不是空跑）", lf.out.trim());

console.log("\n[3] .gitattributes 必须存在、锁 LF、且已被 git 跟踪");
let attrs = "";
try { attrs = readFileSync(join(ROOT, ".gitattributes"), "utf8"); } catch { /* 下面报错 */ }
ok(attrs.length > 0, "desktop/.gitattributes 存在", "没有它，Windows 检出还是 CRLF");
ok(/^\s*\*\s+text=auto\s+eol=lf\s*$/m.test(attrs),
  "★ 声明了 `* text=auto eol=lf`（text=auto 仍会自动放过图标字体等二进制）");
const tracked = execFileSync("git", ["ls-files", ".gitattributes"], { cwd: ROOT, encoding: "utf8" }).trim();
ok(tracked === ".gitattributes",
  "★ 已 git add —— release.py 用 git ls-files 选文件，没跟踪的文件同步不到公开仓",
  `git ls-files 返回「${tracked}」`);

console.log("\n[4] 没有需要 CRLF 的文件（否则那条一刀切规则会反过来伤人）");
const batch = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => /\.(bat|cmd|ps1)$/i.test(f));
ok(batch.length === 0,
  "仓库里没有 .bat/.cmd/.ps1",
  `发现 ${batch.join(", ")} —— 这类文件在 Windows 上要 CRLF，请给它们单独加一行 eol=crlf`);

console.log(`\n${pass} ✅ / ${fail} ❌`);
console.log(fail === 0
  ? "✅ 行尾这条缝已经两头堵上：校验脚本自己不认行尾，仓库也把 Windows 检出锁成 LF。"
    + "本地这一关过了，CI 上就不会再出现「颜色没改却说颜色不一致」那种假故障。"
  : "❌ 有断言不过 —— 这直接决定 CI 能不能出包，先修上面第一条 ❌ 再推 tag。");
process.exit(fail === 0 ? 0 : 1);
