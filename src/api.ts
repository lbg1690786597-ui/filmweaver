/** FilmWeaver 后端 API 客户端（对接 backend /v2）。 */

export const BASE = import.meta.env.VITE_FW_API_BASE || "http://118.196.33.51/fw";
export const APP_VERSION = "0.3.0";

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

// ---- 端点 ----
export const api = {
  health: () => get<{ status: string }>("/health"),

  appLatest: () => get<AppLatest>("/v2/app/latest"),

  optimizeScript: (raw: string, modelId = "grok-3") =>
    post<{ optimized: string }>("/v2/script/optimize", { raw, model_id: modelId }),

  breakdownScript: (script: string, modelId = "grok-3") =>
    post<BreakdownOut>("/v2/script/breakdown", { script, model_id: modelId }),

  generateAsset: (prompt: string, modelId = "qwen-image-max") =>
    post<{ urls: string[] }>("/v2/assets/generate", { prompt, model_id: modelId }),

  submitAssetBatch: (items: { name: string; prompt: string }[], modelId = "qwen-image-max") =>
    post<JobOut>("/v2/jobs", { kind: "asset_batch", payload: { items, model_id: modelId } }),

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

  jobStatus: (id: string) => get<JobOut>(`/v2/jobs/${id}`),

  /** 把 /fw/media/... 相对地址补全为可下载完整地址 */
  mediaUrl: (u: string) => (u.startsWith("http") ? u : `http://118.196.33.51${u}`),
};