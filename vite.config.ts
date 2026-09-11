import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import postcss from "postcss";
import type { Declaration, Plugin as PostcssPlugin, Rule } from "postcss";
import { canFallback, colorMixToRgba, toLegacyValue, NOT_COLOR_MIX } from "./scripts/oklch.mjs";

/**
 * 给组件 CSS 里**写死的** oklch() 自动补一条前置回退声明。
 *
 * 背景（2026-09-10 线上事故）：`oklch()` 要 Chromium ≥ 111。用户机器上的
 * Edge WebView2 运行时若更旧，读不懂这个值 —— 界面上表现为"排版还在、底色和边框
 * 全没了"。设计 token 那批已在 tokens.css 用 @supports + hex 兜住，但组件 CSS 里
 * 另有一百多处直接写 `oklch(0% 0 0 / .6)` 之类的字面值（弹窗遮罩、覆盖层、播放器底色…），
 * 那些兜不住。
 *
 * 这类**不含 var()** 的值可以用最老的那招兜底：
 *     background: rgba(0, 0, 0, .6);      <- 老引擎用这条
 *     background: oklch(0% 0 0 / .6);     <- 新引擎解析成功，覆盖上一条
 * 老引擎在**解析期**就把第二条丢掉了（值不合法且不含 var()，没有"待代换"这一说），
 * 于是第一条留下来。含 var() 的值则相反 —— 见 scripts/oklch.mjs 里 canFallback 的注释。
 *
 * 放在构建期而不是改源码：一百多处手工补回退既噪音又必漏，且以后新写的 oklch
 * 还得记得补。放这里则是"写你想写的现代 CSS，回退由构建负责"。
 */
const oklchFallback: PostcssPlugin = {
  postcssPlugin: "fw-oklch-fallback",
  Declaration(decl: Declaration) {
    // 自定义属性不能这么兜：它的值在解析期不校验，后一条永远赢。
    // 那批走 tokens.css 的 @supports（见 scripts/gen-color-fallback.mjs）。
    if (decl.prop.startsWith("--")) return;
    if (!canFallback(decl.value)) return;
    const prev = decl.prev();
    // 已经手写过回退的（同属性、同一条规则里紧邻的非 oklch 声明）就别再插一条
    if (prev?.type === "decl" && prev.prop === decl.prop && !prev.value.includes("oklch(")) return;
    const legacy = toLegacyValue(decl.value);
    if (legacy !== decl.value) decl.cloneBefore({ value: legacy });
  },
};

/**
 * 给用了 color-mix() 的规则补一份"老引擎专用"的副本。
 *
 * 和上面那个插件的区别在于**回退放哪儿**：
 * 字面 oklch 可以就地写两遍（老引擎在解析期就丢掉第二条），但 color-mix 的参数里
 * 必带 var()，两条声明在老引擎眼里都"有效"，后一条照样赢、然后代换失败作废 ——
 * 前面那条回退早在层叠阶段就没了。这种只能靠 @supports 把两份彻底隔开。
 *
 * 副本紧跟原规则插入（而不是堆到文件末尾），这样文档顺序不变，
 * 后面任何规则对同一属性的覆盖关系都和原来一致，不会因为多了这份回退而被顶掉。
 */
const colorMixFallback: PostcssPlugin = {
  postcssPlugin: "fw-color-mix-fallback",
  OnceExit(root) {
    const jobs: Array<[Rule, Array<[string, string]>]> = [];
    root.walkRules((rule) => {
      // 别处理自己刚生成的那些副本
      const p = rule.parent;
      if (p?.type === "atrule" && p.name === "supports" && p.params === NOT_COLOR_MIX) return;
      const decls: Array<[string, string]> = [];
      rule.each((node) => {
        if (node.type !== "decl") return;
        if (node.prop.startsWith("--")) return; // 自定义属性另有 -rgb 一路，见 tokens.css
        const fb = colorMixToRgba(node.value);
        if (fb) decls.push([node.prop, fb]);
      });
      if (decls.length) jobs.push([rule, decls]);
    });
    for (const [rule, decls] of jobs) {
      const clone = postcss.rule({ selector: rule.selector });
      for (const [prop, value] of decls) clone.append({ prop, value });
      rule.after(postcss.atRule({ name: "supports", params: NOT_COLOR_MIX, nodes: [clone] }));
    }
  },
};

// Tauri 要求固定端口；1430 避开 drama downloader 的 1420
export default defineConfig({
  // 相对路径产物：Tauri(tauri://localhost 根路径) 与 Web 子路径挂载(/fw/app/) 都成立。
  // 若用默认的 "/"，产物会写死 /assets/...，在 /fw/app/ 下会被 nginx 转到别的服务导致 404。
  base: "./",
  plugins: [react()],
  css: { postcss: { plugins: [oklchFallback, colorMixFallback] } },
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
});
