/**
 * render/bundledFonts.ts — 「内置字体」到底有没有随包发出去
 *
 * ## 为什么需要这个文件
 *
 * 「内置」这个选项在 2026-09-06 之前是**死的**，而且是静默死的：
 *
 * · 字体二进制 46MB，被 `src-tauri/resources/fonts/.gitignore` 排除在 git 之外
 *   （合理，不该进仓库）；
 * · 取回它们的 `scripts/fetch-fonts.sh` **在 CI 与 package.json 里零引用** ——
 *   也就是说 GitHub Actions 上那次 clone 里根本没有 .ttc，打出的安装包里
 *   `resources/fonts/` 只有 README 和 LICENSE；
 * · 而 `resolveResource("resources/fonts")` **只拼路径、不校验存在** ——
 *   目录还在（README 在里面），所以它照样返回一个路径，`fontsdir` 照样传给
 *   libass，libass 找不到 Noto 就悄悄换成系统默认字形。
 *
 * 结果：用户选了「思源黑体（内置）」，导出成功，字幕却是别的字体，
 * 全程没有任何一条提示。**没装思源黑体的机器上，这个功能等于不存在。**
 *
 * 两道修法缺一不可：
 *   1. 出包侧：CI 必须先跑 `scripts/fetch-fonts.sh` 且**硬断言**文件到位
 *      （见 .github/workflows/build-windows.yml 与该脚本末尾的体积校验）；
 *   2. 运行侧：就是本文件 —— 真去看那两个 .ttc 在不在，不在就**说出来**，
 *      而不是传一个空目录假装内置字体生效了。
 *
 * 抽成独立模块（而不是写在 renderer.ts 里）是为了能在 node 下单测：
 * `exists` 由调用方注入，纯逻辑不碰 Tauri。
 */

/** 内置字体的 fontconfig 家族名 → 随包文件名。**唯一真源**：
 *  `features/subtitles/fonts.ts` 的 BUNDLED_FONTS、`scripts/fetch-fonts.sh`
 *  取的文件、本文件的存在性校验，三者由 verify-bundled-fonts.ts 交叉钉死。 */
export const BUNDLED_FONT_FILES: Record<string, string> = {
  "Noto Sans CJK SC": "NotoSansCJK-Regular.ttc",
  "Noto Serif CJK SC": "NotoSerifCJK-Regular.ttc",
};

/** 一个 .ttc 至少该有这么大。用来识别"下了半截"或占位空文件 ——
 *  真实体积是 19MB / 26MB，取 1MB 做下限足够宽松又能挡住残包。 */
export const MIN_FONT_BYTES = 1_000_000;

export interface BundledFontsCheck {
  /** 可以传给 ffmpeg `fontsdir` 的目录；null = 内置字体不可用，别传 */
  fontsDir: string | null;
  /** 缺失（或体积明显不对）的文件名，用于给用户一句实话 */
  missing: string[];
}

/**
 * 校验随包字体是否真的在。
 *
 * @param dir         resolveResource("resources/fonts") 的结果；null = 连目录都没解析出来
 * @param fileUsable  注入的判定：这个路径上是不是一个**能用**的字体文件
 *                    （存在 **且** 体积 ≥ MIN_FONT_BYTES —— 只判存在会放过
 *                    安装中断留下的 0 字节占位文件，症状与完全没有一模一样）。
 *                    抛错一律当"不可用"处理 —— 拿不准时宁可回落系统字体并提示，
 *                    也不要传一个可能是空的 fontsdir 让用户以为内置生效了。
 */
export async function checkBundledFonts(
  dir: string | null,
  fileUsable: (path: string) => Promise<boolean>,
): Promise<BundledFontsCheck> {
  if (!dir) return { fontsDir: null, missing: Object.values(BUNDLED_FONT_FILES) };
  // 分隔符从路径本身推断，不引 path 模块：Windows 上 resolveResource 给的是
  // C:\...\resources\fonts。这样本函数在 node 下也能原样跑 —— 单测要的正是这一点。
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const missing: string[] = [];
  for (const file of Object.values(BUNDLED_FONT_FILES)) {
    const ok = await fileUsable(`${dir}${dir.endsWith(sep) ? "" : sep}${file}`)
      .catch(() => false);
    if (!ok) missing.push(file);
  }
  // 只要有一个在就仍然传目录：用户选的那款可能正好是在的那个，
  // 传了至少它能生效；全缺才等于"内置字体这件事没发生"。
  return { fontsDir: missing.length === Object.keys(BUNDLED_FONT_FILES).length ? null : dir,
           missing };
}

/** 给用户看的一句话（null = 一切正常，不必打扰）。 */
export function bundledFontsWarning(check: BundledFontsCheck): string | null {
  if (!check.missing.length) return null;
  if (!check.fontsDir) {
    return "内置字体未随包安装，已回落到系统字体（字幕字形可能与预览不同）";
  }
  return `内置字体缺少 ${check.missing.join("、")}，这几款会回落到系统字体`;
}
