/** FilmWeaver 后端 API 客户端（对接 backend /v2）。 */

const BASE = import.meta.env.VITE_FW_API_BASE || "http://118.196.33.51/fw";

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

// ---- 端点 ----
export const api = {
  health: () => get<{ status: string }>("/health"),

  optimizeScript: (raw: string, modelId = "grok-3") =>
    post<{ optimized: string }>("/v2/script/optimize", { raw, model_id: modelId }),

  breakdownScript: (script: string, modelId = "grok-3") =>
    post<BreakdownOut>("/v2/script/breakdown", { script, model_id: modelId }),

  generateAsset: (prompt: string, modelId = "qwen-image-max") =>
    post<{ urls: string[] }>("/v2/assets/generate", { prompt, model_id: modelId }),

  submitAssetBatch: (items: { name: string; prompt: string }[], modelId = "qwen-image-max") =>
    post<JobOut>("/v2/jobs", { kind: "asset_batch", payload: { items, model_id: modelId } }),

  jobStatus: (id: string) => get<JobOut>(`/v2/jobs/${id}`),
};