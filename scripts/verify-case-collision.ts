/**
 * verify-case-collision.ts — 「只差大小写」的文件名在 Windows 上会炸
 *
 * ## 为什么需要这一节
 *
 * 打包在 **windows-latest** 上跑（`.github/workflows/build-windows.yml`），
 * 而 Windows 的文件系统**大小写不敏感**。开发机是 Linux，`tsc` 全绿；
 * 到了 CI 上同一份代码直接停在类型检查。
 *
 * v0.8.5 首次发版就栽在这里，两条 tag（beta 与正式）的 CI 都是同一处失败：
 *
 *     src/App.tsx: error TS2305: Module './features/timeline/Waveform'
 *       has no exported member 'clearWaveformCache'.
 *     src/features/timeline/ClipView.tsx: error TS1192:
 *       Module '…/src/features/timeline/Waveform' has no default export.
 *     error TS1261: Already included file name '…/Waveform.ts' differs from
 *       file name '…/waveform.ts' only in casing.
 *
 * 起因是 3.9 把波形纯逻辑抽成 `features/timeline/waveform.ts`，而同目录
 * 早就有组件 `Waveform.tsx`。Linux 下这是两个文件，`import "./waveform"`
 * 精确命中纯模块；Windows 下 `./waveform` 与 `./Waveform` 是**同一个路径**，
 * 于是组件 import 到自己、纯模块的导出全部找不到。
 *
 * ## 为什么本机测不出来，必须单独钉
 *
 * `npm run typecheck` 在 Linux 上跑，它看到的是一个**没有冲突的**文件树 ——
 * 这个 bug 的全部症状都发生在别的文件系统语义下。也就是说：
 * **本地全绿是这个错误的正常表现**，不是它不存在的证据。
 * 唯一能在本机拦住它的办法就是显式扫文件名，故有本文件。
 *
 * 它同时挡两类：
 *   ① 同目录下 basename 只差大小写的**模块**（`.ts`/`.tsx`/`.js`/`.jsx`）——
 *      即上面那次事故的形态，症状是 import 解析到错的那个文件；
 *   ② 任意两个 git 跟踪路径**逐字符只差大小写**（含非代码文件）——
 *      更严重，`git clone` 到 Windows 上时后者会直接覆盖前者，
 *      CI 拿到的工作区从一开始就少一个文件。
 *
 * 判据取自 `git ls-files`：与 `release.py` 上传公开仓的判据同源
 * （它也是 `git ls-files`），所以"CI 会拿到什么"和"这里扫了什么"逐字对应。
 */

import { execFileSync } from "node:child_process";
import { dirname, basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (cond: boolean, msg: string, hint = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${msg}${!cond && hint ? `\n      ${hint}` : ""}`);
};

/** git 跟踪的全部文件（相对 desktop/）。用 -z 以免文件名里有空格被切断。 */
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

console.log("① 扫描范围");
ok(tracked.length > 100, `git ls-files 拿到 ${tracked.length} 个跟踪文件`,
   "文件数异常少，说明扫的不是这个仓，本节等于没跑");

// ---- ② 同目录、只差大小写的模块名 ----
console.log("\n② 模块名只差大小写（Windows 上 import 会解析到错的那个）");
const MODULE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
// (目录 + 小写 stem) → { 精确大小写 stem → 路径 }。
// 一组里出现两个不同的精确 stem，就是"只差大小写"那类冲突。
// 同 stem 不同扩展（Foo.ts + Foo.tsx）不算：那种 tsc 在本机就会报，
// 与本节要抓的"只在 Windows 上现形"是两回事，混进来只会误伤。
const byStem = new Map<string, Map<string, string>>();
for (const p of tracked) {
  const ext = extname(p);
  if (!MODULE_EXT.has(ext)) continue;
  // .d.ts 与 .ts 同 stem 是合法搭配（类型声明伴随实现）
  const stem = basename(p, ext).replace(/\.d$/, "");
  const key = `${dirname(p)}|${stem.toLowerCase()}`;
  const group = byStem.get(key) ?? new Map<string, string>();
  if (!group.has(stem)) group.set(stem, p);
  byStem.set(key, group);
}
const modClashes = [...byStem.values()]
  .filter((g) => g.size > 1)
  .map((g) => [...g.values()]);
ok(modClashes.length === 0,
   `无同目录大小写冲突模块（扫了 ${byStem.size} 个模块名）`,
   modClashes.map((v) => v.join("  <-> ")).join("\n      ")
   + "\n      改法：把其中一个改成语义化的不同名字（如 waveform.ts → waveformPeaks.ts），"
   + "\n      不要靠 import 时写对大小写——Windows 上写对了也没用。");

// ---- ③ 整条路径只差大小写（clone 到 Windows 会互相覆盖） ----
console.log("\n③ 完整路径只差大小写（clone 到 Windows 会丢文件）");
const byPath = new Map<string, string[]>();
for (const p of tracked) {
  const key = p.toLowerCase();
  byPath.set(key, [...(byPath.get(key) ?? []), p]);
}
const pathClashes = [...byPath.values()].filter((v) => v.length > 1);
ok(pathClashes.length === 0, "无完整路径大小写冲突",
   pathClashes.map((v) => v.join("  <-> ")).join("\n      "));

// ---- ④ 检查本身有效吗（自检） ----
// 上面两条全绿有两种可能：真的没冲突，或者判定写坏了。用一组伪造输入分开这两件事。
console.log("\n④ 判定自检（伪造输入必须判红）");
const clash = (paths: string[]) => {
  const m = new Map<string, Map<string, string>>();
  for (const p of paths) {
    const ext = extname(p);
    const stem = basename(p, ext).replace(/\.d$/, "");
    const key = `${dirname(p)}|${stem.toLowerCase()}`;
    const g = m.get(key) ?? new Map<string, string>();
    if (!g.has(stem)) g.set(stem, p);
    m.set(key, g);
  }
  return [...m.values()].filter((g) => g.size > 1).length;
};
ok(clash(["a/Waveform.tsx", "a/waveform.ts"]) === 1, "同目录 Waveform.tsx / waveform.ts → 判红");
ok(clash(["a/Waveform.tsx", "b/waveform.ts"]) === 0, "不同目录同名 → 放行（Windows 上不冲突）");
ok(clash(["a/foo.ts", "a/foo.d.ts"]) === 0, "foo.ts + foo.d.ts → 放行（合法搭配）");
ok(clash(["a/foo.ts", "a/foo.tsx"]) === 0, "foo.ts + foo.tsx → 放行（本机 tsc 就会报，不归本节）");
ok(clash(["a/Foo.ts", "a/foo.ts", "a/FOO.ts"]) === 1, "三个只差大小写 → 归为一组判红");

// ---- ⑤ 那次事故的两个具体文件：确认已经分开了 ----
// 上面是通用规则，这一条是**回归钉**：直接点名 v0.8.5 栽的那一对。
// 通用规则将来若被人改宽（比如加了白名单），这条仍然会红。
console.log("\n⑤ v0.8.5 事故回归钉");
ok(tracked.includes("src/features/timeline/Waveform.tsx"),
   "组件 Waveform.tsx 仍在（它是这一对里保留原名的那个）");
ok(!tracked.includes("src/features/timeline/waveform.ts"),
   "纯逻辑不再叫 waveform.ts",
   "它与 Waveform.tsx 只差大小写，Windows 上 CI 必红（见该文件头的说明）");
ok(tracked.includes("src/features/timeline/waveformPeaks.ts"),
   "纯逻辑已改名为 waveformPeaks.ts");

console.log(failed ? `\n❌ ${failed} 项失败` : "\n✅ 无大小写冲突");
process.exit(failed ? 1 : 0);
