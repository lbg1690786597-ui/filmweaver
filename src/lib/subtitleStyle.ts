/**
 * subtitleStyle — 字幕样式预设 → ffmpeg force_style 字符串
 *
 * 为什么需要这一层：TextPanel 有 6 个样式预设（字号/颜色/描边/底框/位置），
 * 随字幕一起以 JSON 存在 style 字段里。但两条烧字幕的路径
 * （render/ffmpegCompiler.ts 与 lib/localRender.ts）都写死了
 * `force_style='FontSize=18'` —— 预设**从未被消费过**，
 * 而且 18px 在 1080×1920 上小到几乎看不见。
 *
 * force_style 走的是 ASS 样式语法，两个坑：
 *   · 颜色是 &HAABBGGRR，字节序与 CSS 的 #RRGGBB **相反**，且 AA 是
 *     "透明度"而非"不透明度"（00 = 完全不透明）。
 *   · 半透底框要 BorderStyle=3，此时 Outline 会被当作框的边距而非描边宽度。
 */

/** TextPanel 的预设结构（与后端落库结构同构） */
export interface SubtitleStyleLike {
  fontSize?: number;
  color?: string;
  stroke?: string;
  strokeWidth?: number;
  bg?: string;
  bold?: boolean;
  position?: "bottom" | "top" | "center";
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
 * @param videoH  成片高度。字号按 1920 基准等比缩放 —— 预设里的 48px 是
 *                针对竖屏 1080×1920 定的，直接用到 720p 上会偏大。
 */
export function srtForceStyle(style: SubtitleStyleLike | null | undefined,
                              videoH = 1920): string {
  const st = style ?? {};
  const scale = videoH > 0 ? videoH / 1920 : 1;
  const size = Math.max(8, Math.round((st.fontSize ?? 48) * scale));
  const boxed = !!st.bg && st.bg !== "transparent";

  const parts: string[] = [
    `FontSize=${size}`,
    `PrimaryColour=${toAssColour(st.color, "&H00FFFFFF")}`,
    `Bold=${st.bold ? 1 : 0}`,
    `Alignment=${alignOf(st.position)}`,
  ];

  if (boxed) {
    // BorderStyle=3 = 不透明底框；此时 Outline 表示框与文字的间距
    parts.push("BorderStyle=3",
               `BackColour=${toAssColour(st.bg, "&H80000000")}`,
               "Outline=4", "Shadow=0");
  } else {
    parts.push("BorderStyle=1",
               `OutlineColour=${toAssColour(st.stroke, "&H00000000")}`,
               `Outline=${Math.max(0, Math.round((st.strokeWidth ?? 3) * scale))}`,
               "Shadow=0");
  }

  // 底部/顶部留边，避免贴边被裁（竖屏尤其明显）
  parts.push(`MarginV=${Math.round(60 * scale)}`);

  // force_style 用逗号分隔；值里不能出现单引号（会截断 -vf 参数）
  return parts.join(",").replace(/'/g, "");
}
