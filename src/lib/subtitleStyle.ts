/**
 * subtitleStyle — 字幕样式预设 → ffmpeg force_style 字符串
 *
 * 为什么需要这一层：TextPanel 有 6 个样式预设（字号/颜色/描边/底框/位置），
 * 随字幕一起以 JSON 存在 style 字段里。但两条烧字幕的路径
 * （render/ffmpegCompiler.ts 与 lib/localRender.ts）都写死了
 * `force_style='FontSize=18'` —— 预设**从未被消费过**，
 * 而且 18px 在 1080×1920 上小到几乎看不见。
 *
 * force_style 走的是 ASS 样式语法，三个坑：
 *   · 颜色是 &HAABBGGRR，字节序与 CSS 的 #RRGGBB **相反**，且 AA 是
 *     "透明度"而非"不透明度"（00 = 完全不透明）。
 *   · 半透底框要 BorderStyle=3，此时 Outline 会被当作框的边距而非描边宽度。
 *   · **FontSize 不是像素**。SRT 没有 PlayRes，libass 用默认 PlayResY=288，
 *     实际渲染尺寸 = FontSize × videoH / 288。见 `ASS_PLAY_RES_Y`。
 */

/** libass 对无 PlayResY 的字幕（SRT 就是）采用的默认画布高度。
 *
 *  实测（ffmpeg 6.x）：`FontSize=52` 烧进 1080×1920，单个汉字字形高 210px
 *  —— 210/0.605(字形/em) ≈ 347px ≈ 52×1920/288。960 高时 105px、480 高时
 *  52px，严格线性于 videoH，与宽度和宽高比无关。
 *
 *  这个常量存在的意义：让 `fontSize` 字段的语义是**用户能理解的那个**
 *  ——"竖屏 1080×1920 成片上的像素字号"——而不是一个要靠试的魔法数。 */
const ASS_PLAY_RES_Y = 288;
/** 样式里所有像素值的基准画面高度（竖屏短剧成片） */
const STYLE_BASE_H = 1920;

/** TextPanel 的预设结构（与后端落库结构同构） */
export interface SubtitleStyleLike {
  fontSize?: number;
  color?: string;
  stroke?: string;
  strokeWidth?: number;
  bg?: string;
  bold?: boolean;
  position?: "bottom" | "top" | "center";
  /** 字体名。ffmpeg 走 fontconfig 按名字找，浏览器预览走 font-family。 */
  fontFamily?: string;
  /** 字体来源。bundled = 随安装包分发（烧录时传 fontsdir，字形 100% 确定）；
   *  system = 用户本机已装的字体，换台机器可能变形，UI 需明确标注。 */
  fontSource?: "bundled" | "system";
  /** 距画面上/下边的留白（按 1920 基准的像素）。原来写死 60。 */
  marginV?: number;
}

/** CSS 颜色 → ASS &HAABBGGRR。认不出的颜色回落白色不透明。 */
export function toAssColour(css: string | undefined, fallback = "&H00FFFFFF"): string {
  if (!css) return fallback;
  const s = css.trim().toLowerCase();
  if (s === "transparent") return "&HFF000000";      // AA=FF 即全透明

  // rgba(r,g,b,a) / rgb(r,g,b)
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    // ASS 的 AA 是透明度：alpha=1(不透明) → 00
    const aa = Math.round((1 - Math.min(1, Math.max(0, alpha))) * 255);
    return `&H${hx(aa)}${hx(b)}${hx(g)}${hx(r)}`;
  }

  // #rgb / #rrggbb / #rrggbbaa
  let hex = s.startsWith("#") ? s.slice(1) : s;
  if (!/^[0-9a-f]{3,8}$/.test(hex)) return fallback;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (hex.length === 6) hex += "ff";
  if (hex.length !== 8) return fallback;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = parseInt(hex.slice(6, 8), 16);
  return `&H${hx(255 - a)}${hx(b)}${hx(g)}${hx(r)}`;
}

function hx(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n))).toString(16).toUpperCase().padStart(2, "0");
}

/** ASS Alignment：数字小键盘布局（2=底部居中, 8=顶部居中, 5=正中） */
function alignOf(pos: SubtitleStyleLike["position"]): number {
  return pos === "top" ? 8 : pos === "center" ? 5 : 2;
}

/**
 * 生成 force_style 的值（不含外层引号）。
 *
 * @param style   字幕样式；缺省字段按短剧常用值兜底
 * @param videoH  成片高度。**注意这里不做 videoH/1920 缩放** —— libass 已经
 *                按 videoH/288 缩过一遍了（见 ASS_PLAY_RES_Y），再乘一次就是
 *                双重缩放：52 会烧成 347px 满屏大字（实测）。
 *                我们要做的是**反向**换算：把"1920 基准的像素"折算成
 *                libass 的 288 坐标系单位，剩下的缩放交给它。
 *                videoH 因此只用于**校验**，值本身不进公式。
 */
export function srtForceStyle(style: SubtitleStyleLike | null | undefined,
                              videoH = STYLE_BASE_H): string {
  const st = style ?? {};
  // 1920 基准像素 → ASS 单位。两端都会被 libass 同比放大到 videoH，
  // 所以这个比例是常数，与成片分辨率无关。
  const toAss = ASS_PLAY_RES_Y / STYLE_BASE_H;          // = 0.15
  const px = (v: number) => Math.round(v * toAss * 10) / 10;   // 保留 1 位小数
  const size = Math.max(1, px(Math.max(8, st.fontSize ?? 48)));
  const boxed = !!st.bg && st.bg !== "transparent";

  const parts: string[] = [
    `FontSize=${size}`,
    `PrimaryColour=${toAssColour(st.color, "&H00FFFFFF")}`,
    `Bold=${st.bold ? 1 : 0}`,
    `Alignment=${alignOf(st.position)}`,
  ];

  // FontName 里不能有逗号（force_style 的分隔符）和单引号（会截断 -vf 参数）。
  // 认不出的字体 ffmpeg 会静默回落到默认字形，不会报错——所以这里只做清洗，
  // "这台机器有没有这个字体"由 UI 侧提示，不是这里能判断的。
  const font = (st.fontFamily || "").replace(/[,'"]/g, "").trim();
  if (font) parts.push(`FontName=${font}`);

  if (boxed) {
    // BorderStyle=3 = 不透明底框；此时 Outline 表示框与文字的间距
    parts.push("BorderStyle=3",
               `BackColour=${toAssColour(st.bg, "&H80000000")}`,
               `Outline=${px(24)}`, "Shadow=0");
  } else {
    parts.push("BorderStyle=1",
               `OutlineColour=${toAssColour(st.stroke, "&H00000000")}`,
               `Outline=${Math.max(0, px(st.strokeWidth ?? 3))}`,
               "Shadow=0");
  }

  // 底部/顶部留边，避免贴边被裁（竖屏尤其明显）
  parts.push(`MarginV=${px(st.marginV ?? 60)}`);

  // videoH 只做合理性兜底：传了个 0/负数说明调用方没拿到分辨率，
  // 此时样式仍按基准输出（libass 会自己按真实高度缩），不需要特殊处理。
  void videoH;

  // force_style 用逗号分隔；值里不能出现单引号（会截断 -vf 参数）
  return parts.join(",").replace(/'/g, "");
}

/**
 * 同一套样式语义的 **CSS 版本**，供播放器实时预览用。
 *
 * 与 `srtForceStyle` 共用 `alignOf` / 缩放规则，保证"预览看到的"和
 * "烧出来的"是同一件事的两种渲染。做不到像素级一致（字体渲染引擎不同），
 * 但字号/位置/颜色/描边/底框这几项必须对得上——否则预览就是误导。
 *
 * @param previewH 预览容器的实际像素高度（不是成片高度）。样式里的字号是
 *                 按 1920 基准定的，要按容器高度同比缩下来。
 */
export function styleToCss(style: SubtitleStyleLike | null | undefined,
                           previewH: number): Record<string, string> {
  const st = style ?? {};
  const scale = previewH > 0 ? previewH / 1920 : 1;
  const size = Math.max(8, (st.fontSize ?? 48) * scale);
  const boxed = !!st.bg && st.bg !== "transparent";
  const sw = Math.max(0, (st.strokeWidth ?? 3) * scale);
  const margin = Math.round((st.marginV ?? 60) * scale);
  const pos = st.position ?? "bottom";

  const css: Record<string, string> = {
    position: "absolute",
    left: "0", right: "0",
    textAlign: "center",
    fontSize: `${size.toFixed(1)}px`,
    lineHeight: "1.25",
    fontWeight: st.bold ? "700" : "400",
    color: st.color ?? "#ffffff",
    whiteSpace: "pre-wrap",
    pointerEvents: "none",
  };
  if (st.fontFamily) css.fontFamily = `"${st.fontFamily}", sans-serif`;

  if (pos === "top") css.top = `${margin}px`;
  else if (pos === "center") { css.top = "50%"; css.transform = "translateY(-50%)"; }
  else css.bottom = `${margin}px`;

  if (boxed) {
    // BorderStyle=3 的等价物：不透明底框，Outline 当内边距
    css.background = st.bg!;
    css.padding = `${(sw || 4).toFixed(1)}px ${(size * 0.35).toFixed(1)}px`;
    css.width = "fit-content";
    css.margin = "0 auto";
    css.borderRadius = "4px";
  } else if (sw > 0) {
    // paint-order:stroke 让描边画在字的**下面**，字形不会被描边吃掉；
    // -webkit-text-stroke 单独用会把笔画压细，两者必须一起写。
    css.paintOrder = "stroke";
    css.WebkitTextStroke = `${(sw * 2).toFixed(1)}px ${st.stroke ?? "#000000"}`;
  }
  return css;
}
