/** 模型 id / 生成模式 → 中文可读名（唯一真源）。
 *
 * 存在的理由：`minimax-h3-ref2v` / `full_reference` 这类内部标识只在代码里有意义，
 * 直接甩给用户等于没写。凡是要在 UI 上露出的地方都过一遍这里的翻译函数，
 * 未知 id 原样返回（新接模型忘了登记时不至于显示空白）。
 */

/** 视频模型 id → 展示名 */
export const VIDEO_MODEL_LABELS: Record<string, string> = {
  "veo-3-1-fast": "Veo 快速",
  "veo-3-1": "Veo 质量",
  "minimax-h3-ref2v": "海螺 H3",
  "seedance-2.0": "Seedance 2.0",
  "seedance-2.0-mini": "Seedance mini",
};

/** 生图模型 id → 展示名 */
export const IMAGE_MODEL_LABELS: Record<string, string> = {
  "gpt-image-2": "GPT Image",
  "nano-banana-pro": "Nano Banana Pro",
  "nano-banana-2": "Nano Banana 2",
  "z-image": "Z-Image",
};

/** 生成模式 → 带图标的展示名（与新建向导 GEN_MODES 一致口径） */
export const GEN_MODE_LABELS: Record<string, string> = {
  t2va: "📝 纯文本",
  full_reference: "🎭 全能参考",
  i2va: "🎬 首帧",
  fl2va: "🎞 首尾帧",
  l2va: "🏁 尾帧",
};

/** 生产模式（预设）→ 展示名，与后端 PRODUCTION_MODES.label 对齐 */
export const PRODUCTION_MODE_LABELS: Record<string, string> = {
  fast: "⚡ 快速验证",
  consistent: "🎭 角色一致",
  premium: "💎 精品制作",
  first_frame: "🎬 首帧精控",
  custom: "🛠 自定义",
};

export const videoModelLabel = (id?: string | null): string =>
  (id && (VIDEO_MODEL_LABELS[id] ?? id)) || "默认";

export const imageModelLabel = (id?: string | null): string =>
  (id && (IMAGE_MODEL_LABELS[id] ?? id)) || "默认";

export const genModeLabel = (id?: string | null): string =>
  (id && (GEN_MODE_LABELS[id] ?? id)) || "默认";

export const productionModeLabel = (id?: string | null): string =>
  (id && (PRODUCTION_MODE_LABELS[id] ?? id)) || "未定模式";
