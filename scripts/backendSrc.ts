/**
 * 读 `backend/` 源码的统一入口 —— **在公开仓里读不到时明确跳过，而不是崩**。
 *
 * 背景（2026-09-16 发版事故）：CI 跑在公开仓 `lbg1690786597-ui/filmweaver`，
 * 而 `release.py` 只推 `desktop/`（那是刻意的：2026-09-11 误把 92 个 backend
 * 文件推上公开仓，之后加了"删除远端残留"这一步收拾干净）。
 * 于是 8 个 verify 脚本里那些 `read("../backend/app/routes_v2.py")` 在 CI 上
 * 直接 `ENOENT` 抛栈 —— v0.9.5-beta 的构建就死在 `verify-trim.ts:109`。
 *
 * 为什么 0.9.4 反而是绿的：那时公开仓里**还残留着**误推的 backend/，脚本正好
 * 读到了。这道依赖从来没人声明过，是残留文件替它兜着；残留一清，它就断了。
 * 换句话说这不是"新引入的 bug"，是一个一直存在、被垃圾数据掩盖的隐性跨仓依赖。
 *
 * 处理原则：**跨仓断言在读不到对面时只能跳过，不能假装通过、更不能崩。**
 *   - 崩 → 发版链路整条断掉（就是这次）
 *   - 假装通过 → 前后端契约漂移时没人会知道，比不检查更坏
 *   - 明确跳过 + 打一行显眼日志 → CI 绿，本地（全仓）仍然真检查
 *
 * 所以这些断言的真实闸门是**本地/服务器上的全仓运行**，CI 只保证前端自洽。
 * 加新的跨仓断言时请一律走 `readBackend()`，别再直接 readFileSync。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
//: scripts/ → desktop/ → 仓库根 → backend/
const BACKEND = join(SCRIPTS, "..", "..", "backend");

/** 本仓是否带着 backend/（全仓 = true，公开仓 = false）。 */
export const hasBackend = (): boolean => existsSync(join(BACKEND, "app"));

/**
 * 读一个后端源文件；读不到返回 `null`（调用方负责跳过对应断言）。
 *
 * 接受历史上各种写法：`"../backend/app/x.py"` / `"backend/app/x.py"` /
 * `"app/x.py"` —— 统一归一到 backend/ 之下，免得改调用点时手滑。
 */
export function readBackend(rel: string): string | null {
  const clean = rel.replace(/^(\.\.\/)+/, "").replace(/^backend\//, "");
  const p = join(BACKEND, clean);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** 打一行显眼的跳过日志。写成函数是为了让"跳过"在日志里长得都一样、好 grep。 */
export function skipBackend(label: string): void {
  console.log(`   ⏭  跳过「${label}」—— 本仓无 backend/（公开仓只含 desktop/，见 backendSrc.ts）`);
}
