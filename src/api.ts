/** FilmWeaver 后端 API 客户端（对接 backend /v2）。 */
import pkg from "../package.json";

// T-R0-10: BASE 仅走环境变量，默认值在 .env.development / .env.production
export const BASE = import.meta.env.VITE_FW_API_BASE || "http://127.0.0.1:8002";
export const APP_VERSION = pkg.version;

// 可选 API Token（后端 FW_API_TOKEN 启用时需一致；本地存储便于用户在设置中配置）
// 登录会话 token（后端 FW_AUTH_UPSTREAM 启用时由登录页获取）
const authHeaders = (): Record<string, string> => {
  const h: Record<string, string> = {};
  const t = localStorage.getItem("fw_api_token");
  if (t) h["X-FW-Token"] = t;
  const s = localStorage.getItem("fw_session");
  if (s) h["Authorization"] = `Bearer ${s}`;
  return h;
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`${resp.status}: ${detail.slice(0, 300)}`);
  }
  return resp.json();
}

async function get<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, { headers: authHeaders() });
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

// ---- R0: 项目化类型（契约 C2）----
export interface ProjectInfo {
  id: string;
  title: string;
  base_aspect: string;
  production_mode: string | null;
  episodes_count?: number;
}

export interface EpisodeInfo {
  order: number;
  title: string;
  word_count: number;
  preview?: string;
}

export interface ShotInfo {
  id: string;
  order: number;
  episode: number;
  script_ref: string;
  link_to_prev: string;
  characters: string[];
  location: string | null;
  video_url: string | null;
  status: "pending" | "prompting" | "generating" | "review" | "adopted" | "failed";
  adopted_version: number | null;
  is_special: boolean;
  /** 镜头级策略覆盖（三层策略最高优先级）；null=继承项目 */
  profile_override: Record<string, unknown> | null;
}

export interface ProjectDetail {
  id: string;
  title: string;
  base_aspect: string;
  production_mode: string | null;
  episodes: EpisodeInfo[];
  raw_script: string | null;
  optimized_script: string | null;
  shots: ShotInfo[];
  assets: { kind: string; name: string; image_url: string | null }[];
}

/** R1: 人物资产阶段（集×镜头双层轴） */
export interface StageInfo {
  id: string;
  character_name: string;
  stage_name: string;
  ep_from: number;
  ep_to: number;
  shot_from: number | null;
  shot_to: number | null;
  image_url: string | null;
  description: string | null;
  status: "draft" | "confirmed";
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
  /** 各生成模式可用性：{t2va|i2va|fl2va|l2va|full_reference: {available, reason?}}
   *  不可用时 UI 置灰并展示 reason（如"工作流未配置"） */
  modes: Record<string, { available: boolean; reason?: string | null; reference_video?: boolean }>;
}

/** 单镜生成的可选参数（模式与素材决定提示词框架分支与工作流路由） */
export interface ShotGenerateOpts {
  /** 生成模式 t2va/i2va/fl2va/l2va/full_reference；缺省按素材自动推断 */
  generationMode?: string;
  firstFrameUrl?: string;      // i2va / fl2va
  lastFrameUrl?: string;       // fl2va / l2va
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
  health: () => get<{ status: string; auth?: string; login?: boolean }>("/health"),

  // ---- 登录（复用主平台用户；后端 FW_AUTH_UPSTREAM 启用时生效）----
  login: (username: string, password: string) =>
    post<{ token: string; expires_at: string; user: { id: number; username: string; display_name: string | null; role: string } }>(
      "/v2/auth/login", { username, password }),

  logout: (token: string) => post<{ ok: boolean }>("/v2/auth/logout", { token }),

  authMe: (token: string) =>
    get<{ user: { id: number; username: string; display_name: string | null; role: string } }>(
      `/v2/auth/me?token=${encodeURIComponent(token)}`),

  appLatest: () => get<AppLatest>("/v2/app/latest"),

  // ---- R0: 项目化（契约 C2/C3）----
  productionModes: () => get<{ modes: Record<string, { video_model?: string; label: string }> }>("/v2/production-modes"),

  listProjects: () => get<{ projects: ProjectInfo[] }>("/v2/projects"),

  createProject: (title: string, baseAspect: string, productionMode: string) =>
    post<ProjectInfo>("/v2/projects", {
      title, base_aspect: baseAspect, production_mode: productionMode,
    }),

  projectDetail: (id: string) => get<ProjectDetail>(`/v2/projects/${id}/detail`),

  /** 剧本导入分集解析；confirm=true 落库 */
  importScript: (text: string, projectId?: string, confirm = false) =>
    post<{ episodes: EpisodeInfo[]; saved: boolean }>("/v2/script/import", {
      text, project_id: projectId ?? null, confirm,
    }),

  /** 按集拆解（落库带 episode） */
  breakdownEpisode: (projectId: string, episode: number, script: string, modelId?: string) =>
    post<BreakdownOut>("/v2/script/breakdown", {
      script, model_id: modelId ?? null, project_id: projectId, episode,
    }),

  /** 采用某个版本 */
  adoptShot: (shotId: string, versionNo: number) =>
    post<{ ok: boolean; video_url: string }>(`/v2/shots/${shotId}/adopt`, { version_no: versionNo }),

  /** 版本历史（R2 精编器回退面板，契约 C10） */
  shotVersions: (shotId: string) =>
    get<{ versions: { version_no: number; video_url: string | null; model_id: string | null; prompt: string | null; meta: Record<string, unknown> | null; created_at: string | null }[] }>(`/v2/shots/${shotId}/versions`),

  // ---- R1: 人物资产阶段（契约 C5）----
  listStages: (projectId: string) => get<{ stages: StageInfo[] }>(`/v2/projects/${projectId}/stages`),

  /** AI 识别换装点生成阶段草稿；priors: {角色名: none|growth|multi} */
  stagesDraft: (projectId: string, priors?: Record<string, string>) =>
    post<{ created: number; skipped_confirmed: string[] }>("/v2/stages/draft", {
      project_id: projectId, priors: priors ?? null,
    }),

  patchStage: (stageId: string, patch: Partial<Pick<StageInfo,
    "stage_name" | "ep_from" | "ep_to" | "shot_from" | "shot_to" | "description" | "image_url" | "status">>) =>
    fetch(`${BASE}/v2/stages/${stageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    }).then(async (r) => { if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`); return r.json() as Promise<StageInfo>; }),

  deleteStage: (stageId: string) =>
    fetch(`${BASE}/v2/stages/${stageId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); }),

  /** 生成候选定妆图（不落库，选定后 patchStage image_url） */
  stageCandidates: (stageId: string, n = 4) =>
    post<{ urls: string[]; prompt: string }>(`/v2/stages/${stageId}/candidates`, { n }),

  /** 保存镜头级覆盖（三层策略：profile_override JSON） */
  patchShotOverride: (shotId: string, override: Record<string, unknown> | null, isSpecial?: boolean) =>
    post<{ ok: boolean }>(`/v2/shots/${shotId}/override`, {
      profile_override: override, is_special: isSpecial ?? null,
    }),

  /** 按镜头 id 批量生成（R0 状态机链：prompting→generating→review） */
  submitShotsByIds: (projectId: string, shotIds?: string[], modelId?: string) =>
    post<JobOut>("/v2/jobs", {
      kind: "shot_videos",
      payload: { project_id: projectId, shot_ids: shotIds ?? null, model_id: modelId ?? null },
    }),

  /** 已注册视频模型及能力档位 */
  videoProviders: () => get<{ providers: VideoProviderInfo[] }>("/v2/providers/video"),

  optimizeScript: (raw: string, modelId?: string, projectId?: string) =>
    post<{ optimized: string }>("/v2/script/optimize", {
      raw, model_id: modelId ?? null, project_id: projectId ?? null,
    }),

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
        generation_mode: opts?.generationMode ?? null,
        first_frame_url: opts?.firstFrameUrl ?? null,
        last_frame_url: opts?.lastFrameUrl ?? null,
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
    const resp = await fetch(`${BASE}/v2/media/upload`, { method: "POST", headers: authHeaders(), body: fd });
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

  /** 把 /fw/media/... 相对地址补全为可下载完整地址（host 取自 BASE，不硬编码） */
  mediaUrl: (u: string) => (u.startsWith("http") ? u : `${new URL(BASE).origin}${u}`),
};