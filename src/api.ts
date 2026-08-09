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
  /** P1-1 缩略图：轨道用首帧 JPG 渲染（不再每槽挂 <video>，837 镜也不卡） */
  thumb_url: string | null;
  status: "pending" | "prompting" | "generating" | "review" | "adopted" | "failed";
  adopted_version: number | null;
  is_special: boolean;
  /** 拆解阶段预生成的提示词（"拆解镜头并生成提示词"第二阶段产物） */
  gen_prompt: string | null;
  /** 所属集剧本已修改 → 本镜拆解/提示词已过期 */
  stale: boolean;
  /** AI 拆镜判定的镜头时长（秒，1-15 钳制；高级面板/时间轴拖拽可覆盖） */
  duration_sec: number | null;
  /** 时间轴归一（P0-3）：停用=保留镜头但不参与导出/生成 */
  disabled: boolean;
  /** 外部素材镜头（is_special）的展示名：片头/片尾/转场/实拍等 */
  special_name: string | null;
  /** P1-2 注入覆写（L3）：资产轨拖出来的增删；null=完全跟随 AI 判定 */
  ref_overrides: { add?: string[]; remove?: string[]; add_loc?: string[]; remove_loc?: string[] } | null;
  /** P1-2：已出片但注入集合被人工改动 → 轨道显示 ↻「参考图已变，可重新生成」 */
  refs_stale: boolean;
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
  assets: AssetInfo[];
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
  /** 本阶段区间内该角色**最终注入**的镜头 order（P1-2 起 = (拆解真值 ∪ 人工add) − 人工remove，
   *  与后端参考图注入依据完全同源）。资产轨按此渲染，避免"未出场却显示覆盖"。 */
  present_orders: number[];
  /** P1-2 人工覆写标记：被人工「加入」注入的 order（present_orders 子集，轨道画斜纹） */
  manual_add_orders: number[];
  /** P1-2 人工覆写标记：被人工「排除」的 order（真值有但手动去掉，形成的空洞是手调的） */
  manual_remove_orders: number[];
  /** 虚拟段（无 AssetStage 行）：拖拽注入的无阶段角色/阶段区间外的注入，服务端合成保证
   *  「轨道显示 = 实际注入」。不可 patch/merge/生成定妆（前端按纯资产上下文降级处理） */
  virtual?: boolean;
}

/** P1-3 场景轨条目：每场景一行（L1=Shot.location，图源=Asset(kind=location)，L3=add_loc/remove_loc） */
export interface LocationInfo {
  name: string;
  image_url: string | null;
  /** 最终注入该场景参考图的镜头 order（与后端生成注入同源） */
  present_orders: number[];
  manual_add_orders: number[];
  manual_remove_orders: number[];
}

/** 资产条目（detail.assets；id 供 patch/delete/拖拽重分类） */
export interface AssetInfo {
  id: string;
  kind: string;    // character | location | custom
  name: string;
  image_url: string | null;
}

/** 资产拖拽 payload（资产页卡片 → 时间轴轨道，经 dataTransfer 传递） */
export interface AssetDragData {
  assetId: string | null;   // Asset 行 id（阶段图拖拽时为 null）
  kind: string;             // character | location | custom
  name: string;
  imageUrl: string | null;
  stageId?: string;         // 拖的是某个造型阶段时带上（换图目标）
}

/** P2-4 音频轨段：TTS 旁白 / 配乐，锚定镜头 order + 镜内偏移 */
export interface AudioClipInfo {
  id: string;
  kind: "tts" | "music";
  text: string | null;
  url: string | null;
  duration: number;
  start_shot_order: number;
  start_offset_sec: number;
  voice_ref_url: string | null;
  status: "pending" | "generating" | "done" | "failed";
  error: string | null;
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

  createProject: (title: string, baseAspect: string, productionMode: string,
                  customSettings?: Record<string, string>) =>
    post<ProjectInfo>("/v2/projects", {
      title, base_aspect: baseAspect, production_mode: productionMode,
      custom_settings: customSettings ?? null,
    }),

  projectDetail: (id: string) => get<ProjectDetail>(`/v2/projects/${id}/detail`),

  /** 剧本导入分集解析；confirm=true 落库 */
  importScript: (text: string, projectId?: string, confirm = false) =>
    post<{ episodes: EpisodeInfo[]; saved: boolean }>("/v2/script/import", {
      text, project_id: projectId ?? null, confirm,
    }),

  /** 剧本文件导入（txt/md/docx/pdf）：解析分集；confirm=true 落库；返回含解析出的 text */
  importScriptFile: async (file: File, projectId?: string, confirm = false) => {
    const fd = new FormData();
    fd.append("file", file);
    if (projectId) fd.append("project_id", projectId);
    fd.append("confirm", String(confirm));
    const resp = await fetch(`${BASE}/v2/script/import-file`, {
      method: "POST", headers: authHeaders(), body: fd,
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return resp.json() as Promise<{ episodes: EpisodeInfo[]; saved: boolean; text: string }>;
  },

  /** 按集取剧本正文（剧本页每集一个文本框） */
  episodesContent: (projectId: string) =>
    get<{ episodes: { order: number; title: string; content: string }[] }>(
      `/v2/projects/${projectId}/episodes/content`),

  /** 保存某集正文；该集已有镜头被标记 stale（过期） */
  updateEpisodeContent: (projectId: string, order: number, content: string) =>
    fetch(`${BASE}/v2/projects/${projectId}/episodes/${order}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ content }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ ok: boolean; stale_shots: number }>;
    }),

  /** 拆解 job：episodes=null 一键全部（默认跳过已拆）；指定集数组=只拆那些集（重拆语义）。
   *  长集分块串多次 LLM 可达数分钟，必须走 job 而非同步接口（否则 nginx 504）。 */
  submitBreakdownAll: (projectId: string, force = false, episodes?: number[]) =>
    post<JobOut>("/v2/jobs", {
      kind: "breakdown_all",
      payload: { project_id: projectId, force, episodes: episodes ?? null },
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
  listStages: (projectId: string) =>
    get<{ stages: StageInfo[]; locations: LocationInfo[] }>(`/v2/projects/${projectId}/stages`),

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

  /** P1-2 资产轨拖拽落库：批量增删某角色/场景的注入覆写（一次事务）。
   *  向外拖=add（该镜生成时注入此参考图），向内拖=remove，reset=重置为 AI 判定。
   *  已出片且注入集合实际变化的镜头会被标记 refs_stale（提示可重新生成，不自动重跑）。
   *  P1-3：isLocation=true 时 character 填场景名（覆写走 add_loc/remove_loc）。 */
  refOverrides: (projectId: string, character: string, opts: {
    addShotIds?: string[]; removeShotIds?: string[]; resetShotIds?: string[];
    isLocation?: boolean;
  }) =>
    post<{ ok: boolean; affected: { shot_id: string; order: number; changed: boolean; refs_stale: boolean }[]; stale: number[] }>(
      "/v2/shots/ref-overrides", {
        project_id: projectId, character,
        shot_ids_add: opts.addShotIds ?? [],
        shot_ids_remove: opts.removeShotIds ?? [],
        reset_shot_ids: opts.resetShotIds ?? [],
        is_location: opts.isLocation ?? false,
      }),

  /** 保存镜头级覆盖（三层策略：profile_override JSON） */
  patchShotOverride: (shotId: string, override: Record<string, unknown> | null, isSpecial?: boolean) =>
    post<{ ok: boolean }>(`/v2/shots/${shotId}/override`, {
      profile_override: override, is_special: isSpecial ?? null,
    }),

  /** P0-3 时间轴归一：把外部素材（片头/片尾/转场/实拍）作为特殊镜头插入镜头轨。
   *  afterOrder 缺省=追加到末尾；插入后全项目 order 重排为 1..N。 */
  addSpecialShot: (projectId: string, name: string, videoUrl: string,
                   afterOrder?: number, durationSec?: number) =>
    post<{ ok: boolean; shot_id: string; order: number }>("/v2/shots/special", {
      project_id: projectId, name, video_url: videoUrl,
      after_order: afterOrder ?? null, duration_sec: durationSec ?? null,
    }),

  /** P0-3 轻剪辑：改时长（服务端钳整数秒 1-15）/ 改顺序 / 停用。 */
  patchShotTimeline: (shotId: string, patch: {
    durationSec?: number; toOrder?: number; disabled?: boolean;
  }) =>
    fetch(`${BASE}/v2/shots/${shotId}/timeline`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        duration_sec: patch.durationSec ?? null,
        to_order: patch.toOrder ?? null,
        disabled: patch.disabled ?? null,
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ ok: boolean; order: number; duration_sec: number | null; disabled: boolean }>;
    }),

  /** 删除镜头（仅外部素材镜头；AI 镜头请用停用） */
  deleteShot: (shotId: string) =>
    fetch(`${BASE}/v2/shots/${shotId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
        return r.json() as Promise<{ ok: boolean }>;
      }),

  /** 按镜头 id 批量生成（R0 状态机链：prompting→generating→review） */
  submitShotsByIds: (projectId: string, shotIds?: string[], modelId?: string) =>
    post<JobOut>("/v2/jobs", {
      kind: "shot_videos",
      payload: { project_id: projectId, shot_ids: shotIds ?? null, model_id: modelId ?? null },
    }),

  /** 已注册视频模型及能力档位 */
  videoProviders: () => get<{ providers: VideoProviderInfo[] }>("/v2/providers/video"),

  /** 用户可选图像模型（渠道链后端内部维护：zx1/api4me/RunningHub 自动降级） */
  imageProviders: () => get<{ models: { id: string; label: string }[] }>("/v2/providers/image"),

  optimizeScript: (raw: string, modelId?: string, projectId?: string) =>
    post<{ optimized: string }>("/v2/script/optimize", {
      raw, model_id: modelId ?? null, project_id: projectId ?? null,
    }),

  breakdownScript: (script: string, modelId?: string) =>
    post<BreakdownOut>("/v2/script/breakdown", { script, model_id: modelId ?? null }),

  generateAsset: (prompt: string, modelId?: string) =>
    post<{ urls: string[] }>("/v2/assets/generate", { prompt, model_id: modelId ?? null }),

  /** 批量资产生图（project_id 传入则逐张实时写回 Asset.image_url） */
  submitAssetBatch: (items: { name: string; prompt: string; stage_id?: string }[], projectId?: string, modelId?: string) =>
    post<JobOut>("/v2/jobs", { kind: "asset_batch", payload: { items, model_id: modelId ?? null, project_id: projectId ?? null } }),

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

  /** 上传本地素材（视频/音频/图片/字幕），返回可用于时间轴的 url。
   *  P1-3：带 projectId 则元数据落库（media_clips），刷新/换设备素材池不丢；
   *  duration 前端探测后带上（服务端不再 ffprobe）。 */
  uploadMedia: async (file: File, projectId?: string, duration?: number): Promise<UploadOut> => {
    const fd = new FormData();
    fd.append("file", file);
    if (projectId) fd.append("project_id", projectId);
    if (duration && duration > 0) fd.append("duration", String(duration));
    const resp = await fetch(`${BASE}/v2/media/upload`, { method: "POST", headers: authHeaders(), body: fd });
    if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return resp.json();
  },

  /** P1-3 项目素材池：已上传素材元数据（含 kind/duration） */
  listClips: (projectId: string) =>
    get<{ clips: { id: string; name: string; url: string; size: number; kind: string; duration: number }[] }>(
      `/v2/projects/${projectId}/clips`),

  /** P1-3 从素材池删除（连文件本体一起删） */
  deleteClip: (clipId: string) =>
    fetch(`${BASE}/v2/clips/${clipId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<{ ok: boolean }>; }),

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

  /** P2-3（修 F4）：按项目列进行中 job——打开项目从服务端接回任务，换设备/清缓存不失联 */
  listProjectJobs: (projectId: string) =>
    get<{ jobs: { id: string; kind: string; status: string; progress: number }[] }>(
      `/v2/projects/${projectId}/jobs`),

  // ---- P2-4 音频轨（TTS 旁白 / 配乐）----
  listAudioClips: (projectId: string) =>
    get<{ clips: AudioClipInfo[]; tts_available: boolean }>(`/v2/projects/${projectId}/audio-clips`),

  createAudioClip: (body: {
    projectId: string; kind: "tts" | "music"; text?: string; url?: string;
    duration?: number; startShotOrder?: number; startOffsetSec?: number; voiceRefUrl?: string;
  }) =>
    post<AudioClipInfo>("/v2/audio-clips", {
      project_id: body.projectId, kind: body.kind,
      text: body.text ?? null, url: body.url ?? null, duration: body.duration ?? null,
      start_shot_order: body.startShotOrder ?? 1,
      start_offset_sec: body.startOffsetSec ?? 0,
      voice_ref_url: body.voiceRefUrl ?? null,
    }),

  patchAudioClip: (clipId: string, patch: {
    startShotOrder?: number; startOffsetSec?: number; text?: string;
  }) =>
    fetch(`${BASE}/v2/audio-clips/${clipId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        start_shot_order: patch.startShotOrder ?? null,
        start_offset_sec: patch.startOffsetSec ?? null,
        text: patch.text ?? null,
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<AudioClipInfo>;
    }),

  deleteAudioClip: (clipId: string) =>
    fetch(`${BASE}/v2/audio-clips/${clipId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<{ ok: boolean }>; }),

  /** TTS 批量合成 job（缺省合成全部 pending/failed 段；参考音色同批只上传一次） */
  submitTtsBatch: (projectId: string, clipIds?: string[]) =>
    post<JobOut>("/v2/jobs", {
      kind: "tts_batch",
      payload: { project_id: projectId, clip_ids: clipIds ?? null },
    }),

  /** 合并同角色多个造型阶段（区间并集，保留 keepId 的图/名/描述；差别不大的设定合一） */
  mergeStages: (stageIds: string[], keepId?: string) =>
    post<{ ok: boolean; kept: StageInfo; merged_names: string[] }>(
      "/v2/stages/merge", { stage_ids: stageIds, keep_id: keepId ?? null }),

  // ---- 资产 CRUD（自定义资产 + 拖拽重分类/换图）----
  /** 同步生图（资产详情弹窗/自定义资产用；n 张，约 10-60s） */
  assetsGenerate: (prompt: string, opts?: { modelId?: string; size?: string; n?: number }) =>
    post<{ urls: string[]; model_id: string }>("/v2/assets/generate", {
      prompt, model_id: opts?.modelId ?? null,
      size: opts?.size ?? "1024x1024", n: opts?.n ?? 1,
    }),

  /** 新建资产（自定义分组：上传图或 AI 生图后落库） */
  createAsset: (body: { projectId: string; kind?: string; name: string; imageUrl?: string; prompt?: string }) =>
    post<AssetInfo>("/v2/assets", {
      project_id: body.projectId, kind: body.kind ?? "custom",
      name: body.name, image_url: body.imageUrl ?? null, prompt: body.prompt ?? null,
    }),

  /** 改资产（kind=拖拽重分类 custom→character/location；imageUrl=换图） */
  patchAsset: (assetId: string, patch: { kind?: string; name?: string; imageUrl?: string }) =>
    fetch(`${BASE}/v2/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        kind: patch.kind ?? null, name: patch.name ?? null,
        image_url: patch.imageUrl ?? null,
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<AssetInfo>;
    }),

  deleteAsset: (assetId: string) =>
    fetch(`${BASE}/v2/assets/${assetId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<{ ok: boolean }>; }),

  /** 按 (kind,name) 换图（拖资产卡到场景轨段=替换参考图；无行则建） */
  upsertAssetImage: (projectId: string, kind: string, name: string, imageUrl: string) =>
    post<AssetInfo>("/v2/assets/upsert-image", {
      project_id: projectId, kind, name, image_url: imageUrl,
    }),

  /** 把 /fw/media/... 相对地址补全为可下载完整地址（host 取自 BASE，不硬编码） */
  mediaUrl: (u: string) => (u.startsWith("http") ? u : `${new URL(BASE).origin}${u}`),

  /** P2-5 SSE（修 G3/F2）：订阅项目事件流（job/shot/audio 状态变更实时推送）。
   *
   * 用 fetch 流式读取而非 EventSource——后者带不了 Authorization 头，登录
   * 体系下会 401；fetch 方案桌面 WebView 与浏览器通道都通。断线指数退避重连
   * （3s 起、封顶 30s），onUp/onDown 通知连接状态（前端据此把轮询降为兜底）。
   * 返回关闭函数（切项目/卸载时调用）。 */
  openEvents: (
    projectId: string,
    onEvent: (ev: string, data: Record<string, unknown>) => void,
    opts?: { onUp?: () => void; onDown?: () => void },
  ): (() => void) => {
    const ctrl = new AbortController();
    let stopped = false;
    void (async () => {
      let backoff = 3000;
      while (!stopped) {
        try {
          const resp = await fetch(`${BASE}/v2/projects/${projectId}/events`, {
            headers: authHeaders(), signal: ctrl.signal,
          });
          if (!resp.ok || !resp.body) throw new Error(`${resp.status}`);
          backoff = 3000;
          opts?.onUp?.();
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let ev = "message";
              let data = "";
              for (const line of chunk.split("\n")) {
                if (line.startsWith("event: ")) ev = line.slice(7).trim();
                else if (line.startsWith("data: ")) data += line.slice(6);
              }
              if (data) {
                try { onEvent(ev, JSON.parse(data)); } catch { /* 坏行忽略 */ }
              }
            }
          }
        } catch { /* 断线/旧后端 404 → 退避重连 */ }
        opts?.onDown?.();
        if (stopped) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    })();
    return () => { stopped = true; ctrl.abort(); };
  },
};