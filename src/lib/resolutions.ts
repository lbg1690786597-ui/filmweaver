/**
 * lib/resolutions.ts — 画幅 → 可选分辨率
 *
 * 抽出来共用：一键成片的参数覆写与导出对话框需要同一张表，
 * 各存一份必然漂移（ExportDialog 原本只列了 9:16 / 16:9 / 1:1 三种，
 * 而后端 BASE_ASPECTS 支持 6 种，选了 3:4 的项目会直接落到 9:16 的档位上）。
 *
 * ## 档位口径必须与后端一致
 *
 * 后端 RESOLUTION_TIERS 是 480p/720p/1080p/2k 四档（按 megapixels 计），
 * Seedance provider 再把 mp 映射回 p 档下发。前端这张表**每种画幅都要覆盖
 * 到同样四档**——少列一档就等于用户永远选不到它。
 * （480p 曾整个缺失：它是最便宜的档位，试片正需要，却一个画幅都没有。）
 *
 * 数值取常见的整数分辨率，不按比例硬算——硬算会出 1088×1451 这种
 * 编码器不友好的尺寸（H.264 要求宽高为 2 的倍数，部分硬件编码器要 16 的倍数）。
 * 竖屏档以宽为基准、横屏档以高为基准，保证短边落在标准档位上。
 */

export interface ResOption {
  label: string;
  w: number;
  h: number;
  /** 对应后端 RESOLUTION_TIERS 的档位名，便于排查前后端口径 */
  tier: "480p" | "720p" | "1080p" | "2k";
}

export const RESOLUTIONS: Record<string, ResOption[]> = {
  "9:16": [
    { label: "1080×1920 · 1080p (推荐)", w: 1080, h: 1920, tier: "1080p" },
    { label: "720×1280 · 720p", w: 720, h: 1280, tier: "720p" },
    { label: "480×854 · 480p (最省)", w: 480, h: 854, tier: "480p" },
    { label: "1440×2560 · 2K", w: 1440, h: 2560, tier: "2k" },
  ],
  "16:9": [
    { label: "1920×1080 · 1080p (推荐)", w: 1920, h: 1080, tier: "1080p" },
    { label: "1280×720 · 720p", w: 1280, h: 720, tier: "720p" },
    { label: "854×480 · 480p (最省)", w: 854, h: 480, tier: "480p" },
    { label: "2560×1440 · 2K", w: 2560, h: 1440, tier: "2k" },
  ],
  "3:4": [
    { label: "1080×1440 · 1080p (推荐)", w: 1080, h: 1440, tier: "1080p" },
    { label: "768×1024 · 720p", w: 768, h: 1024, tier: "720p" },
    { label: "480×640 · 480p (最省)", w: 480, h: 640, tier: "480p" },
    { label: "1536×2048 · 2K", w: 1536, h: 2048, tier: "2k" },
  ],
  "4:3": [
    { label: "1440×1080 · 1080p (推荐)", w: 1440, h: 1080, tier: "1080p" },
    { label: "1024×768 · 720p", w: 1024, h: 768, tier: "720p" },
    { label: "640×480 · 480p (最省)", w: 640, h: 480, tier: "480p" },
    { label: "2048×1536 · 2K", w: 2048, h: 1536, tier: "2k" },
  ],
  "1:1": [
    { label: "1080×1080 · 1080p (推荐)", w: 1080, h: 1080, tier: "1080p" },
    { label: "720×720 · 720p", w: 720, h: 720, tier: "720p" },
    { label: "480×480 · 480p (最省)", w: 480, h: 480, tier: "480p" },
    { label: "1440×1440 · 2K", w: 1440, h: 1440, tier: "2k" },
  ],
  "21:9": [
    { label: "2560×1080 · 1080p (推荐)", w: 2560, h: 1080, tier: "1080p" },
    { label: "1920×816 · 720p", w: 1920, h: 816, tier: "720p" },
    { label: "1280×544 · 480p (最省)", w: 1280, h: 544, tier: "480p" },
    { label: "3440×1440 · 2K", w: 3440, h: 1440, tier: "2k" },
  ],
};

/** 后端 BASE_ASPECTS 的前端镜像（新建向导与参数覆写共用） */
export const ASPECTS = Object.keys(RESOLUTIONS);

/** 取某画幅的分辨率档；未知画幅退回 9:16（竖屏短剧是本产品的主场景） */
export function resListOf(aspect: string): ResOption[] {
  return RESOLUTIONS[aspect] ?? RESOLUTIONS["9:16"];
}
