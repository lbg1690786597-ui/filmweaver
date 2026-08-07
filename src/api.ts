/** FilmWeaver 后端 API 客户端（对接 backend /v2）。 */

export const BASE = import.meta.env.VITE_FW_API_BASE || "http://118.196.33.51/fw";
export const APP_VERSION = "0.4.0";

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`${resp.status}: ${detail.slice(0, 300)}`);
  }
  return resp.json();
}

async function get<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`);
  if (!resp.ok) throw new Error(`${resp.status}`);
  return resp.json();
}

// ---- 类型 ----
export interface ShotDraft {
  order: number;
  script_ref: string;
  link_to_prev: string;
  characters: string[];
  location: string | null;
}

export interface BreakdownOut {
  shots: ShotDraft[];
  characters: string[];
  locations: string[];
  model_id: string;
}

export interface JobOut {
  id: string;
  kind: string;
  status: string;
  progress: number;
  result: string | null;
  error: string | null;
}

export interface UploadOut {
  file_id: string;
  name: string;
  url: string;
  size: number;
}

export interface AppLatest {
  version: string;
  notes: string;
  download_url: string;
}

export interface VideoProviderInfo {
  model_id: string;
  visual_mode: string;
  audio_mode: string;
  duration_slots: number[];
  supports_last_frame: boolean;
  aspect_ratios: string[];
  /** 最多可吃几张参考图（首帧路线通常为 1，minimax-h3-ref2v 为 9） */
  max_reference_images: number;
  supports_reference_audio: boolean;
  supports_reference_video: boolean;
}

/** 单镜生成的参考路线可选参数（reference 类模型使用；veo 通道忽略） */
export interface ShotGenerateOpts {
  firstFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceAudioUrl?: string;
  referenceVideoUrl?: string;
  durationMs?: number;
  aspectRatio?: string;
  /** 画面精细度（百万像素）；不传则后端按时长自动选安全值 */
  megapixels?: number;
  /** 随机种子；不传则每次随机 */
  seed?: number;
}

// ---- 端点 ----
// 模型缺省值由后端 settings 决定（zx1 网关实测可用渠道）；
// 前端不再写死 grok-3/qwen（原 kegeai 网关已失联，旧默认值全部打不通）。
export const api = {
  health: () => get<{ status: string }>("/health"),

  appLatest: () => get<AppLatest>("/v2/app/latest"),

  /** 已注册视频模型及能力档位 */
  videoProviders: () => get<{ providers: VideoProviderInfo[] }>("/v2/providers/video"),

  optimizeScript: (raw: string, modelId?: string) =>
    post<{ optimized: string }>("/v2/script/optimize", { raw, model_id: modelId ?? null }),

  breakdownScript: (script: string, modelId?: string) =>
    post<BreakdownOut>("/v2/script/breakdown", { script, model_id: modelId ?? null }),

  generateAsset: (prompt: string, modelId?: string) =>
    post<{ urls: string[] }>("/v2/assets/generate", { prompt, model_id: modelId ?? null }),

  submitAssetBatch: (items: { name: string; prompt: string }[], modelId?: string) =>
    post<JobOut>("/v2/jobs", { kind: "asset_batch", payload: { items, model_id: modelId ?? null } }),

  /** 单镜生成视频（同步出片）。
   *  veo 约 1-3 分钟；minimax-h3-ref2v 走 RunningHub 异步工作流，1MP/8s 约 10 分钟。
   *  opts 里的参考图/音/视频与分辨率、seed 仅 reference 类模型生效。
   *  返回的 meta 含实际生效的 seed / 分辨率 / 帧数，便于复现。 */
  generateShotVideo: (prompt: string, modelId?: string, opts?: ShotGenerateOpts) =>
    post<{ video_url: string; model_id: string; meta?: Record<string, unknown> }>(
      "/v2/shots/generate",
      {
        prompt,
        model_id: modelId ?? null,
        first_frame_url: opts?.firstFrameUrl ?? null,
        reference_image_urls: opts?.referenceImageUrls ?? [],
        reference_audio_url: opts?.referenceAudioUrl ?? null,
        reference_video_url: opts?.referenceVideoUrl ?? null,
        duration_ms: opts?.durationMs ?? null,
        aspect_ratio: opts?.aspectRatio ?? null,
        megapixels: opts?.megapixels ?? null,
        seed: opts?.seed ?? null,
      },
    ),

  /** 上传本地素材（视频/音频/图片/字幕），返回可用于时间轴的 url */
  uploadMedia: async (file: File): Promise<UploadOut> => {
    const fd = new FormData();
    fd.append("file", file);
    const resp = await fetch(`${BASE}/v2/media/upload`, { method: "POST", body: fd });
    if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return resp.json();
  },

  /** 提交时间轴自动拼接（服务器 ffmpeg 归一化+concat+可选烧字幕） */
  submitCompose: (clips: string[], opts?: { width?: number; height?: number; fps?: number; burn_srt?: string }) =>
    post<JobOut>("/v2/jobs", {
      kind: "compose",
      payload: { clips, width: opts?.width ?? 1080, height: opts?.height ?? 1920, fps: opts?.fps ?? 30, burn_srt: opts?.burn_srt },
    }),

  /** 批量补齐镜头视频（异步 job；默认只生成尚未出片的镜头） */
  submitShotVideos: (projectId: string, opts?: { orders?: number[]; modelId?: string; promptPrefix?: string }) =>
    post<JobOut>("/v2/jobs", {
      kind: "shot_videos",
      payload: {
        project_id: projectId,
        orders: opts?.orders ?? null,
        model_id: opts?.modelId ?? null,
        prompt_prefix: opts?.promptPrefix ?? null,
      },
    }),

  /** 一键成片（异步 job）：拆解 → 逐镜生成 → 拼接，进度 0-100 */
  submitOneClickFilm: (
    projectId: string,
    opts?: { script?: string; videoModel?: string; llmModel?: string; promptPrefix?: string; width?: number; height?: number; fps?: number },
  ) =>
    post<JobOut>("/v2/jobs", {
      kind: "one_click_film",
      payload: {
        project_id: projectId,
        script: opts?.script ?? null,
        video_model: opts?.videoModel ?? null,
        llm_model: opts?.llmModel ?? null,
        prompt_prefix: opts?.promptPrefix ?? null,
        width: opts?.width ?? 1080,
        height: opts?.height ?? 1920,
        fps: opts?.fps ?? 30,
      },
    }),

  jobStatus: (id: string) => get<JobOut>(`/v2/jobs/${id}`),

  /** 把 /fw/media/... 相对地址补全为可下载完整地址 */
  mediaUrl: (u: string) => (u.startsWith("http") ? u : `http://118.196.33.51${u}`),
};