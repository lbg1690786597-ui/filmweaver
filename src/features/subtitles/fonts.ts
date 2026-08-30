/**
 * features/subtitles/fonts.ts — 字幕可选字体
 *
 * 两个来源，用户都要（明确决策）：
 *
 * · **内置**：随安装包分发（`src-tauri/resources/fonts/`）。烧录时传
 *   `fontsdir`，把随包字体加进 fontconfig 的搜索路径 —— 用户机器上没装
 *   思源黑体也照样能用，换台电脑导出的成片长得一模一样。
 * · **系统**：用户本机已装的字体。想用什么就用什么，但**换机器可能变形**
 *   （对方没装这款字体，ffmpeg 会静默回落成默认字形、不报错）。
 *   所以 UI 必须把这句警告写出来，不能让它静默发生。
 */

/** 一个可选字体 */
export interface FontOption {
  /** 传给 ffmpeg 的 `FontName` / CSS 的 font-family，两边用同一个名字 */
  name: string;
  label: string;
  source: "bundled" | "system";
}

/** 随包分发的字体。名字必须是 **fontconfig 认得的家族名**，不是文件名。
 *  文件与许可见 `src-tauri/resources/fonts/README.md`。 */
export const BUNDLED_FONTS: FontOption[] = [
  { name: "Noto Sans CJK SC", label: "思源黑体（内置）", source: "bundled" },
  { name: "Noto Serif CJK SC", label: "思源宋体（内置）", source: "bundled" },
];

/** 拿不到系统字体清单时的兜底名单。
 *
 *  这些是各平台上**极大概率存在**的中文字体。它只是给用户一个能点的入口，
 *  真到烧录时这台机器有没有这款字体，只有 fontconfig 说了算——所以选系统
 *  字体一律附带"换机器可能变形"的提示，无论名字是枚举来的还是这里来的。 */
const FALLBACK_SYSTEM_FONTS = [
  "微软雅黑", "Microsoft YaHei", "黑体", "SimHei", "宋体", "SimSun",
  "苹方-简", "PingFang SC", "Heiti SC", "思源黑体", "Source Han Sans SC",
  "Noto Sans CJK SC", "Arial", "Impact",
];

/** Chromium 的 Local Font Access API。Tauri 在 Windows 上跑 WebView2
 *  （Chromium）能拿到；Linux/macOS 的 WebKitGTK/WKWebView 没有这个 API。 */
interface FontData { family: string }
type QueryLocalFonts = () => Promise<FontData[]>;

/**
 * 枚举本机字体。
 *
 * 拿不到（非 Chromium / 用户拒绝授权）就回落到 `FALLBACK_SYSTEM_FONTS`——
 * **不抛错**：字体选择器空着比给一份可能不全的名单更糟。
 */
export async function listSystemFonts(): Promise<FontOption[]> {
  const q = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  let families: string[] = [];
  if (typeof q === "function") {
    try {
      const fonts = await q();
      // 同一家族有 Regular/Bold/Italic 多条，去重后按名字排
      families = [...new Set(fonts.map((f) => f.family))].sort((a, b) =>
        a.localeCompare(b, "zh-Hans-CN"));
    } catch {
      // 用户拒绝授权 / 非安全上下文：回落，不打扰
    }
  }
  if (!families.length) families = FALLBACK_SYSTEM_FONTS;
  return families.map((name) => ({ name, label: name, source: "system" as const }));
}
