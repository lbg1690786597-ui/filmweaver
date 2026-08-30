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
    throw toApiError(resp.status, detail);
  }
  return resp.json();
}

/** 后端结构化错误（FastAPI detail 为对象时）：带 reason 便于前端分类处置。
 *  典型来源：首帧生成被内容审核拒绝（reason="moderation"）——这类**重试无效**，
 *  必须引导用户改写提示词或换生图模型，不能只显示一句"生成失败"。 */
export class ApiError extends Error {
  status: number;
  reason?: string;
  categories?: string[];
  /** B23：删除素材被引用挡下时，后端回的引用清单（用于给用户看清删了会坏什么） */
  references?: { type: string; id: string; label: string }[];
  constructor(status: number, message: string, reason?: string, categories?: string[],
              references?: { type: string; id: string; label: string }[]) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.categories = categories;
    this.references = references;
  }
}

function toApiError(status: number, raw: string): ApiError {
  try {
    const d = JSON.parse(raw)?.detail;
    if (d && typeof d === "object") {
      return new ApiError(status, d.message ?? raw.slice(0, 300), d.reason, d.categories,
                          d.references);
    }
    if (typeof d === "string") return new ApiError(status, d.slice(0, 300));
  } catch { /* 非 JSON：按原样透出 */ }
  return new ApiError(status, `${status}: ${raw.slice(0, 300)}`);
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

/** job 的当前阶段。i2va 批量出片是「整批先出首帧、再逐镜出视频」两段，
 *  没有它前几分钟只有"已出片 0/170"、进度条几乎不动，用户会以为点了没反应。 */
/** 任务列表行（比 JobOut 轻，但含时间戳与失败摘要） */
export interface JobBrief {
  id: string;
  kind: string;
  status: string;
  progress: number;
  error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  shot_ids: string[];
  phase?: JobPhase | null;
}

export interface JobPhase {
  key: string;               // anchors | frames | videos | assets
  label: string;             // 「正在出首帧」
  done: number;
  total: number;
  frames_done?: number;
  frames_total?: number;
  videos_done?: number;
  videos_total?: number;
}

export interface JobOut {
  id: string;
  kind: string;
  status: string;
  progress: number;
  result: string | null;
  error: string | null;
  phase?: JobPhase | null;
  /** true = 后端去重命中，返回的是已在跑的那个 job（不是新提交的） */
  deduped?: boolean;
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
  /** TB-11：列表接口直接带统计，前端不再逐项目补拉 detail */
  shots_total?: number;
  shots_done?: number;
  total_sec?: number;
  thumb_url?: string | null;
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
  /** 失败原因摘要（≤300 字符）；成功后由后端清空 */
  fail_reason?: string | null;
  /** 失败分类：moderation=内容审核拒绝（重试无效，需改词/换模型）
   *  channel=渠道或网络故障（值得重试）| other */
  fail_kind?: "moderation" | "channel" | "other" | null;
  adopted_version: number | null;
  is_special: boolean;
  /** 拆解阶段预生成的提示词（"拆解镜头并生成提示词"第二阶段产物） */
  gen_prompt: string | null;
  /** 所属集剧本已修改 → 本镜拆解/提示词已过期 */
  stale: boolean;
  /** gen_prompt 这一稿是怎么来的（镜头卡据此打标，避免误以为卡片上的就是最终下发稿）：
   *  draft   拆解初稿——那会儿资产还没生成，服装与人称都是凭剧本猜的
   *  aligned 已按当前资产（参考图造型 + 人物档案）重新对齐
   *  sent    出片时实际下发给视频模型的最终稿
   *  manual  用户在高级设置里手填 */
  prompt_state: "draft" | "aligned" | "sent" | "manual" | null;
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
  /** 首帧流水线（i2va）：本镜首帧图；视频由该帧生长而来。
   *  先审首帧再出视频可省废片成本，也是排查场景偏移的抓手。null=未走首帧路线 */
  first_frame_url: string | null;
  /** 镜头级策略覆盖（三层策略最高优先级）；null=继承项目 */
  profile_override: Record<string, unknown> | null;
  /** TB-01 分割后的取片窗口（秒）。分割不重新转码，前后两段共用同一
   *  video_url，各自记住自己的 [in, in+dur) 窗口。null=整段使用。 */
  clip_in_sec?: number | null;
  clip_dur_sec?: number | null;
  /** Render V2 多视频轨：0=主轨，1+=Overlay 层（数字越大越靠上） */
  track_index?: number;
  /** Overlay 层在成片上的起点（秒）；主轨忽略 */
  overlay_start_sec?: number | null;
  /** TB-03/TB-10 画面与音频调整（缩放/旋转/位移/不透明度/镜像/变速/音量/淡化） */
  transform_meta?: TransformMeta | null;
}

/** TB-03/TB-10：与后端 Shot.transform_meta 同构；缺键 = 该项不处理 */
export interface TransformMeta {
  scale?: number; rotate?: number; x?: number; y?: number;
  opacity?: number; mirrorH?: boolean; mirrorV?: boolean;
  speed?: number;
  volume?: number; muted?: boolean; fadeIn?: number; fadeOut?: number;
  /** 调色（滤镜面板手动调节，范围 -100..100） */
  exposure?: number; contrast?: number; saturation?: number;
  temperature?: number; tint?: number; highlights?: number; shadows?: number;
  sharpen?: number;
  /** TB-09：.cube LUT 文件的素材 URL */
  lut?: string;
  /** V2.2 逐帧特效（0..100 强度）；未列出的项 = 不启用 */
  blur?: number; vignette?: number; grain?: number; glitch?: number;
  shake?: number; zoomPulse?: number; flash?: number; glow?: number;
  /** V2.2 混合模式（仅叠加层生效） */
  blendMode?: "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten";
}

/** Render V2 转场：挂在两个相邻镜头的接缝上 */
export interface TransitionInfo {
  id: string;
  type: string;
  duration: number;
  from_shot_id: string;
  to_shot_id: string;
  params: Record<string, unknown> | null;
}

/** TB-02 字幕段 */
export interface SubtitleClipInfo {
  id: string;
  text: string;
  kind: "normal" | "subtitle" | "title";
  start_shot_order: number;
  start_offset_sec: number;
  duration: number;
  style: Record<string, unknown> | null;
  created_at: string | null;
}

export interface ProjectDetail {
  id: string;
  title: string;
  base_aspect: string;
  production_mode: string | null;
  /** 解说音色（解说剧整片共用的参考音频） */
  narration_voice_url?: string | null;
  episodes: EpisodeInfo[];
  raw_script: string | null;
  optimized_script: string | null;
  shots: ShotInfo[];
  assets: AssetInfo[];
}

/** R1: 人物资产阶段（集×镜头双层轴） */
/** 生产就绪度体检（GET /v2/projects/{id}/readiness）。
 *  出片前二次确认弹窗据此渲染；数字口径与后端实际生成逻辑同源。 */
export interface Readiness {
  project_id: string;
  /** 项目最终生效的生成模式：t2va | full_reference | i2va | ... */
  generation_mode: string | null;
  video_model: string;
  image_model: string | null;
  /** 项目画幅（9:16 等）。生产检查弹窗据此算分辨率可选档位 */
  base_aspect?: string | null;
  /** 当前视频模型是否支持首帧输入；false 时后端会静默回退全参考 */
  i2va_supported: boolean;
  i2va_reason: string | null;
  shots: { total: number; active: number; with_video: number; need_video: number };
  first_frames: {
    /** 本项目/本批是否走首帧路线（false 时弹窗隐藏首帧那一行） */
    mode_active: boolean;
    required: number;
    ready: number;
    missing: { id: string; order: number; episode: number; location: string | null }[];
  };
  assets: {
    /** 阶段无专属图；fallback=true 时该角色有通用图可回退，不会裸生（仅丢造型区分）。
     *  已排除"指针行"（与别的阶段是同一件衣服、共用它那张图）：那类不该被当成缺口去出图。 */
    stages_no_image: { id: string; character_name: string; stage_name: string; ep_from: number; ep_to: number; image_url: string | null; location?: string | null; scene_bound?: boolean; fallback: boolean }[];
    /** 角色既无阶段图也无通用图 → 首帧会裸生（纯文生图，人物一致性无保障） */
    chars_no_asset: { name: string; episodes: number[] }[];
    locations_no_image: string[];
    /** 无图角色里还需要额外补建「默认造型」阶段的（其余角色的缺口已在 stages_no_image 里） */
    chars_need_stage?: string[];
    /** 「🖼 补齐缺失资产」真会生成的图片张数（阶段/角色/场景去重后的口径）。
     *  不要用 stages_no_image.length + chars_no_asset.length 自行相加——那会把
     *  同一批图数两遍（一个角色的每套衣服都是一个缺图阶段，它自己也在无图角色里）。 */
    to_generate?: number;
  };
  /** 服装资产报数（花费闸门）：要花钱出图几张、免费复用几张 */
  costumes?: {
    stages_total: number;
    /** 服装识别是否跑过。false 时上面所有"要出几张图"的报数都不作数——
     *  那时它只等于"没有定妆图的角色数"，与剧情真正需要的服装套数无关。 */
    scanned?: boolean;
    /** 场景决定型服装数（睡衣@卧室这类，跨集沿用同一张图） */
    scene_bound: number;
    /** 指针行数：与别的阶段是同一件衣服，共用图、不出图不花钱 */
    followers: number;
    /** 真要花钱生成的张数 */
    to_generate: number;
  };
  /** 分级提示。level 决定 UI 用色：
   *  info=流程还没走到（正常，不该标红）| warn=会自动降级但能跑 | error=真会失败。
   *  action 非空时前端可给一键修复入口（如 costume_scan）。 */
  warnings: { level: "info" | "warn" | "error"; text: string;
              action?: string | null }[];
}

/** 场景归一字典（GET /v2/projects/{id}/scenes）：
 *  同一个物理空间在各集里的不同写法归为一组。服装继承与场景基准帧共享都以归一名为准。 */
export interface SceneGroup {
  canonical: string;
  shots: number;
  members: {
    raw_name: string;
    shots: number;
    /** manual = 用户改过（AI 重跑归一不会推翻）；ai/auto = 自动归一 */
    source: string;
    time_of_day: string | null;
    int_ext: string | null;
  }[];
}

/** 服装解析报告（GET /v2/projects/{id}/costume-report）：
 *  逐镜×角色说明"这一镜穿哪套、图从哪来"，并报出要花钱生成几张。 */
export interface CostumeReport {
  stages: {
    id: string; character_name: string; stage_name: string;
    ep_from: number; ep_to: number; shot_from: number | null; shot_to: number | null;
    location: string | null; scene_bound: boolean; has_image: boolean;
    /** 非空 = 本行与该阶段是同一件衣服，共用它那张图（不额外出图） */
    reuse_of: string | null;
  }[];
  shots: {
    order: number; episode: number; scene: string; character: string;
    stage_id: string | null; stage_name: string | null;
    /** explicit_variant | scene_inherited | scene_event | base_stage | generic_asset | none */
    reason: string;
    reason_label: string;
    has_image: boolean;
  }[];
  summary: {
    stages_total: number; to_generate: number; free_reuse: number;
    scene_bound: number; shot_char_pairs: number;
    shot_char_covered: number; shot_char_uncovered: number;
  };
}

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
  /** 服装继承：本造型绑定的**归一场景名**（空 = 不绑场景）。 */
  location?: string | null;
  /** 场景决定型服装（睡衣@卧室 / 浴袍@浴室）：人物再次进入这个场景、剧本没另写
   *  衣着时沿用**同一张图**，跨集有效。事件型服装（婚纱@教堂）应为 false。 */
  scene_bound?: boolean;
  /** 指针行：与该 id 的阶段是同一件衣服、共用它那张图（自己不出图、不花钱） */
  source_stage_id?: string | null;
  /** 指针行解析后的实际可用图（自己有图时即 image_url） */
  effective_image_url?: string | null;
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
  /** 角色参考音色（上传音频/视频；TTS 旁白合成时作该角色音色候选） */
  voice_url?: string | null;
  /** 造型/场景文字描述：AI 生图时的原始提示词，或上传图后视觉反推出来的造型。
   *  出片时作为参考图的文字锚点喂给提示词优化器（没有它，提示词只能凭空编服装）。
   *  以「〔自动识图〕」开头 = 机器看图写的，用户改过就不再自动覆盖。 */
  prompt?: string | null;
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
  /** shot = 从镜头视频里剥出来的原声；narration = 解说剧按剧本切出的旁白 */
  kind: "tts" | "music" | "shot" | "narration";
  text: string | null;
  url: string | null;
  duration: number;
  start_shot_order: number;
  start_offset_sec: number;
  voice_ref_url: string | null;
  /** kind="shot" 时指向来源镜头。导出时据此静音该镜头的原音轨，
   *  避免同一段声音响两遍（视频自带一遍 + 音频轨一遍）。 */
  source_shot_id?: string | null;
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
   *  不可用时 UI 置灰并展示 reason（如"工作流未配置"）。
   *  max_reference_images/reference_audio 是**该模式的**上限——H3 各模式走不同
   *  工作流，槽位数不同（全参考 9 图+音频 / 首帧 1 图无音频），
   *  不可用外层 Provider 级 max_reference_images 代替。 */
  modes: Record<string, {
    available: boolean; reason?: string | null; reference_video?: boolean;
    max_reference_images?: number; reference_audio?: boolean;
    requires_first_frame?: boolean; requires_last_frame?: boolean;
  }>;
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

  // ---- 登录（飞书扫码，2026-08 起账号密码已移除）----
  // mode 决定回调怎么收尾：desktop 显示落地页等轮询，web 直接 302 回应用
  feishuStart: (mode: "desktop" | "web" = "desktop") =>
    post<{ ticket: string; authorize_url: string }>(
      `/v2/auth/feishu/start?mode=${mode}`, {}),
  feishuPoll: (ticket: string) =>
    get<{ status: "pending" | "ok" | "expired"; token?: string; expires_at?: string; user?: { id: number; username: string; display_name: string | null; role: string } }>(
      `/v2/auth/feishu/poll?ticket=${encodeURIComponent(ticket)}`),

  logout: (token: string) => post<{ ok: boolean }>("/v2/auth/logout", { token }),

  authMe: () =>
    get<{ user: { id: number; username: string; display_name: string | null; role: string } }>(
      // 不再把 token 放进 query：它会进 nginx access log 和浏览器历史。
      // authHeaders() 读的是同一个 fw_session key，Authorization header
      // 会自动带上，后端已优先读 header。
      "/v2/auth/me"),

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

  /** TB-01 在镜内第 atSec 秒把镜头分割为前后两段（时间轴 Ctrl+B） */
  // ---- TB-02 字幕轨 ----
  listSubtitleClips: (projectId: string) =>
    get<{ clips: SubtitleClipInfo[] }>(`/v2/projects/${projectId}/subtitle-clips`),

  createSubtitleClip: (body: {
    project_id: string; text: string; kind?: string;
    start_shot_order?: number; start_offset_sec?: number;
    duration?: number; style?: Record<string, unknown>;
  }) => post<SubtitleClipInfo & { ok: boolean }>("/v2/subtitle-clips", body),

  patchSubtitleClip: (clipId: string, patch: {
    text?: string; kind?: string; start_shot_order?: number;
    start_offset_sec?: number; duration?: number; style?: Record<string, unknown>;
  }) =>
    fetch(`${BASE}/v2/subtitle-clips/${clipId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<SubtitleClipInfo>;
    }),

  deleteSubtitleClip: (clipId: string) =>
    fetch(`${BASE}/v2/subtitle-clips/${clipId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); }),

  /** 批量写入字幕段（本地对齐产物的落库入口）。
   *
   *  逐条 POST 是不可行的：一段 205 字旁白按 15 字拆条 ≈ 14 条 cue，
   *  21 段旁白 ≈ 300 条 —— 300 次往返用户要等半分钟，中途失败还会留下半套字幕。
   *
   *  replaceKind 传 "subtitle" 表示先清掉自动生成的那一类再写，
   *  用户手工加的 normal / title 不动。 */
  bulkSubtitleClips: (body: {
    project_id: string;
    replace_kind?: string | null;
    clips: {
      project_id: string; text: string; kind?: string;
      start_shot_order?: number; start_offset_sec?: number;
      duration?: number; style?: Record<string, unknown>;
    }[];
  }) => post<{ ok: boolean; created: number; deleted: number; skipped_empty: number }>(
    "/v2/subtitle-clips/bulk", body),

  /** 项目级默认字幕样式（存在 Project.default_profile.subtitle_style）。
   *
   *  烧录是把**一个** SRT 用**一套** force_style 烧进画面，
   *  所以导出时必须有一个确定的"这个项目的字幕长什么样"。 */
  getSubtitleStyle: (projectId: string) =>
    get<{ style: Record<string, unknown> | null }>(
      `/v2/projects/${projectId}/subtitle-style`),

  setSubtitleStyle: (projectId: string, style: Record<string, unknown> | null) =>
    fetch(`${BASE}/v2/projects/${projectId}/subtitle-style`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ style }),
    }).then(async (r) => {
      if (!r.ok) throw toApiError(r.status, await r.text());
      return r.json() as Promise<{ ok: boolean; style: Record<string, unknown> | null }>;
    }),

  /** 导出用 SRT（时间码已按镜头顺序换算为绝对时间） */
  subtitlesSrt: (projectId: string) =>
    get<{ srt: string; count: number; total_sec: number }>(
      `/v2/projects/${projectId}/subtitles.srt`),

  // ---- Render V2 转场 ----
  listTransitions: (projectId: string) =>
    get<{ transitions: TransitionInfo[] }>(`/v2/projects/${projectId}/transitions`),

  createTransition: (body: {
    project_id: string; from_shot_id: string; to_shot_id: string;
    type?: string; duration?: number; params?: Record<string, unknown>;
  }) => post<TransitionInfo & { ok: boolean; replaced: boolean }>("/v2/transitions", body),

  patchTransition: (id: string, patch: {
    type?: string; duration?: number; params?: Record<string, unknown>;
  }) =>
    fetch(`${BASE}/v2/transitions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<TransitionInfo>;
    }),

  deleteTransition: (id: string) =>
    fetch(`${BASE}/v2/transitions/${id}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); }),

  /** 各外部通道的配置健康度（只回布尔，不回任何 key） */
  providersHealth: () =>
    get<{ channels: { key: string; label: string; base_url: string; configured: boolean }[];
          features: { tts: boolean; asr: boolean }; note: string }>(
      "/v2/system/providers-health"),

  // ---- TB-06 缓存 ----
  cacheStats: () =>
    get<{ items: { key: string; label: string; files: number; bytes: number;
                   clearable: boolean }[]; total_bytes: number }>("/v2/system/cache-stats"),
  cacheClear: (scope = "outputs", olderThanDays = 0) =>
    post<{ ok: boolean; removed: number; freed_bytes: number }>(
      "/v2/system/cache-clear", { scope, older_than_days: olderThanDays }),

  // ---- TB-07 音频素材库（项目自有音频，按 BGM/音效 分类）----
  audioLibrary: (projectId: string, kind?: string) =>
    get<{ items: { id: string; name: string; url: string; duration: number;
                   size: number; tag: string }[];
          counts: { bgm: number; sfx: number; unsorted: number; total: number } }>(
      `/v2/projects/${projectId}/audio-library${kind ? `?kind=${kind}` : ""}`),
  setAudioTag: (clipId: string, tag: "bgm" | "sfx" | "unsorted") =>
    fetch(`${BASE}/v2/clips/${clipId}/audio-tag`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ tag }),
    }).then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); }),

  // ---- TB-08 自动字幕 ----
  asrStatus: () => get<{ available: boolean }>("/v2/asr/status"),
  submitAutoSubtitles: (projectId: string, replace = false) =>
    post<JobOut>("/v2/jobs", {
      kind: "auto_subtitles",
      payload: { project_id: projectId, replace },
    }),

  splitShot: (shotId: string, atSec: number) =>
    post<{ ok: boolean; head_shot_id: string; tail_shot_id: string;
           head_order: number; tail_order: number;
           head_duration: number; tail_duration: number }>(
      `/v2/shots/${shotId}/split`, { at_sec: atSec }),

  /** 版本历史（R2 精编器回退面板，契约 C10） */
  shotVersions: (shotId: string) =>
    get<{ versions: { version_no: number; video_url: string | null; model_id: string | null; prompt: string | null; meta: Record<string, unknown> | null; created_at: string | null }[] }>(`/v2/shots/${shotId}/versions`),

  // ---- R1: 人物资产阶段（契约 C5）----
  listStages: (projectId: string) =>
    get<{ stages: StageInfo[]; locations: LocationInfo[] }>(`/v2/projects/${projectId}/stages`),

  /** AI 识别全剧服装 → 造型阶段草稿；priors: {角色名: none|growth|multi}。
   *  逐集并发扫描 + 完整性复查（不再截断剧本），并按"同一场景同一人物服装相同"绑场景。
   *  variants=镜头级服装变体数；scene_bound=场景决定型服装数（跨集沿用同一张图）；
   *  followers=指针行数（与别的阶段同一件衣服，共用图、不额外出图）；
   *  reused_images=继承兜底占位图的阶段数；episodes_scanned=实际扫描的集数；
   *  scenes=归一后的场景数；skipped_with_image=有已出图阶段被保留、本次只做增量的角色。 */
  stagesDraft: (projectId: string, priors?: Record<string, string>) =>
    post<{ created: number; variants?: number; scene_bound?: number;
           followers?: number; reused_images?: number;
           episodes_scanned?: number; scenes?: number;
           skipped_with_image: string[] }>("/v2/stages/draft", {
      project_id: projectId, priors: priors ?? null,
    }),

  /** 场景归一字典（只读）：同一物理空间的各集写法归组，服装继承/场景基准帧的判据 */
  listScenes: (projectId: string) =>
    get<{ scenes: SceneGroup[] }>(`/v2/projects/${projectId}/scenes`),

  /** 人工改一条场景归一映射（source=manual，AI 重跑不覆盖）。
   *  误合并的修法：把其中一个写法的 canonical 改回它自己的名字。 */
  patchSceneAlias: (projectId: string, rawName: string, canonical: string) =>
    fetch(`${BASE}/v2/scenes/alias`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ project_id: projectId, raw_name: rawName, canonical }),
    }).then(async (r) => { if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`); return r.json() as Promise<{ ok: boolean; changed: boolean }>; }),

  /** 跑一次场景别名合并（一次文本模型调用，不生成任何图、不花生图钱） */
  canonicalizeScenes: (projectId: string) =>
    post<{ ok: boolean; updated: number; llm: boolean; scenes: { canonical: string; members: string[] }[] }>(
      `/v2/projects/${projectId}/scenes/canonicalize`, { project_id: projectId }),

  /** 服装解析报告（只读，花费闸门数据源：先报数，用户点了才出图） */
  costumeReport: (projectId: string) =>
    get<CostumeReport>(`/v2/projects/${projectId}/costume-report`),

  patchStage: (stageId: string, patch: Partial<Pick<StageInfo,
    "stage_name" | "ep_from" | "ep_to" | "shot_from" | "shot_to" | "description" | "image_url" | "status" | "location" | "scene_bound">>) =>
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

  /** 首帧图（i2va）：为单镜生成/重生首帧，不出视频。
   *  regenAnchor=true 时一并重建该镜所属 (集,场景) 的场景基准帧——
   *  基准帧决定同场景所有镜头的陈设/光线基调，重建会影响后续镜头的首帧。 */
  regenFirstFrame: (shotId: string, opts?: { regenAnchor?: boolean; imageModel?: string }) =>
    post<{ ok: boolean; first_frame_url: string }>(`/v2/shots/${shotId}/first-frame`, {
      regen_anchor: opts?.regenAnchor ?? false,
      image_model: opts?.imageModel ?? null,
    }),

  /** 生产就绪度体检（出片前二次确认弹窗数据源；只读，不产生费用） */
  projectReadiness: (projectId: string) =>
    get<Readiness>(`/v2/projects/${projectId}/readiness`),

  /** 批量生成镜头首帧（异步 job）。shotIds 缺省=补齐所有缺首帧的镜头；
   *  force=true 连已有首帧的也重画（选中集合内全量重生）。 */
  submitFirstFrames: (projectId: string, opts?: {
    shotIds?: string[]; imageModel?: string; force?: boolean;
  }) =>
    post<JobOut>("/v2/jobs", {
      kind: "first_frames",
      payload: {
        project_id: projectId,
        shot_ids: opts?.shotIds ?? null,
        image_model: opts?.imageModel ?? null,
        force: opts?.force ?? false,
      },
    }),

  /** 按**当前资产**重新生成镜头提示词（异步 job，只调文本模型，不出图不出片）。
   *
   *  镜头卡上的提示词是拆解时写的初稿——那会儿资产还没生成，服装与人称都是
   *  凭剧本猜的；真正与资产对齐的改写原本只发生在点了「生成视频」之后。
   *  这个入口把对齐提前，让用户先校对再花视频的钱。 */
  submitReprompt: (projectId: string, opts?: {
    shotIds?: string[]; episode?: number;
  }) =>
    post<JobOut>("/v2/jobs", {
      kind: "reprompt",
      payload: {
        project_id: projectId,
        shot_ids: opts?.shotIds ?? null,
        episode: opts?.episode ?? null,
      },
    }),

  /** 首帧精控一条龙（异步 job）：资产 → 全部首帧 → 全部片段，进度 0-100。
   *  stopAfter="assets" 只补资产（人物一致性靠定妆图，没资产先别急着出首帧）；
   *  stopAfter="frames" 补到首帧为止，不出片。 */
  submitFirstFramePipeline: (projectId: string, opts?: {
    genAssets?: boolean; forceFrames?: boolean;
    modelId?: string; stopAfter?: "assets" | "frames";
  }) =>
    post<JobOut>("/v2/jobs", {
      kind: "first_frame_pipeline",
      payload: {
        project_id: projectId,
        gen_assets: opts?.genAssets ?? false,
        force_frames: opts?.forceFrames ?? false,
        model_id: opts?.modelId ?? null,
        stop_after: opts?.stopAfter ?? null,
      },
    }),

  /** 全剧服装识别（异步 job，**纯文本、不出图、不花生图的钱**）。
   *  必须跑在出图之前：没跑过时「补齐缺失资产（N）」的 N 只是"没有定妆图的角色数"，
   *  不等于剧情真正需要的服装套数。 */
  submitCostumeScan: (projectId: string, opts?: {
    modelId?: string; priors?: Record<string, string>;
  }) =>
    post<JobOut>("/v2/jobs", {
      kind: "costume_scan",
      payload: {
        project_id: projectId,
        model_id: opts?.modelId ?? null,
        priors: opts?.priors ?? null,
      },
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
  /** 修正单镜拆解结果。不自动重算提示词——那要调文本模型花钱，
   *  由用户显式点「重新生成提示词」。改完后端会置 stale 提醒重生。 */
  patchShotBreakdown: (shotId: string, patch: {
    scriptRef?: string; characters?: string[];
    location?: string; linkToPrev?: "continuous" | "transition";
  }) =>
    fetch(`${BASE}/v2/shots/${shotId}/breakdown`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        script_ref: patch.scriptRef ?? null,
        characters: patch.characters ?? null,
        location: patch.location ?? null,
        link_to_prev: patch.linkToPrev ?? null,
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ ok: boolean; changed: string[]; stale: boolean }>;
    }),

  /** 保存手改的提示词。后端会同时写 profile_override.prompt——
   *  只写 gen_prompt 的话，有参考图时会被 AI 重新优化覆盖掉。 */
  patchShotPrompt: (shotId: string, genPrompt: string) =>
    fetch(`${BASE}/v2/shots/${shotId}/prompt`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ gen_prompt: genPrompt }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ ok: boolean; prompt_state: string }>;
    }),

  /** 撤销手改，把提示词交还给 AI（清 override，下次生成重新优化） */
  resetShotPrompt: (shotId: string) =>
    fetch(`${BASE}/v2/shots/${shotId}/prompt`, {
      method: "DELETE", headers: { ...authHeaders() },
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ ok: boolean; prompt_state: string }>;
    }),

  patchShotTimeline: (shotId: string, patch: {
    durationSec?: number; toOrder?: number; disabled?: boolean;
    /** TB-03/TB-10：传 {} 清除全部调整 */
    transformMeta?: TransformMeta | Record<string, never>;
    /** Render V2 多轨：移到第几条视频轨（0=主轨） */
    trackIndex?: number;
    overlayStartSec?: number;
  }) =>
    fetch(`${BASE}/v2/shots/${shotId}/timeline`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        duration_sec: patch.durationSec ?? null,
        to_order: patch.toOrder ?? null,
        disabled: patch.disabled ?? null,
        transform_meta: patch.transformMeta ?? null,
        track_index: patch.trackIndex ?? null,
        overlay_start_sec: patch.overlayStartSec ?? null,
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
  submitShotsByIds: (projectId: string, shotIds?: string[], modelId?: string,
                     seed?: number) =>
    post<JobOut>("/v2/jobs", {
      kind: "shot_videos",
      payload: {
        project_id: projectId, shot_ids: shotIds ?? null, model_id: modelId ?? null,
        // TB-05：显式 seed = 生成变体（同 prompt 出另一版，且可复现）
        seed: seed ?? null,
      },
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

  /** P1-3 从素材池删除（连文件本体一起删）。
   *  force=false 时若素材仍被镜头/旁白/资产引用，后端回 409 + 引用清单（B23）。 */
  deleteClip: (clipId: string, force = false) =>
    fetch(`${BASE}/v2/clips/${clipId}${force ? "?force=true" : ""}`,
          { method: "DELETE", headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw toApiError(r.status, await r.text());
        return r.json() as Promise<{ ok: boolean; broken_references?: number }>;
      }),

  /** R2 重命名素材池里的素材（改 name，不影响 url / 镜头关联）。 */
  renameClip: (clipId: string, name: string) =>
    fetch(`${BASE}/v2/clips/${clipId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name }),
    }).then(async (r) => {
      if (!r.ok) throw toApiError(r.status, await r.text());
      return r.json() as Promise<{ ok: boolean; id: string; name: string }>;
    }),

  // ⚠️ 这里原有 submitCompose（kind:"compose"）。云端合成已于 2026-08-30 下线：
  // 后端 RUNNERS 里已无 "compose"，再提交只会得到一个立刻失败的 job。
  // 合成统一走桌面端本机 ffmpeg（render/renderer.ts）。

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
    opts?: { genAssets?: boolean; script?: string; videoModel?: string; llmModel?: string; promptPrefix?: string; width?: number; height?: number; fps?: number },
  ) =>
    post<JobOut>("/v2/jobs", {
      kind: "one_click_film",
      payload: {
        project_id: projectId,
        gen_assets: opts?.genAssets ?? false,
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

  /** 按项目列 job。active=true（默认）只回进行中——打开项目从服务端接回任务，
   *  换设备/清缓存不失联；active=false 回全部历史，供任务中心回溯与重试。 */
  listProjectJobs: (projectId: string, active = true, limit = 60) =>
    get<{ jobs: JobBrief[] }>(
      `/v2/projects/${projectId}/jobs?active=${active}&limit=${limit}`),

  /** 为已有视频但无缩略图的镜头补抽首帧（缩略图功能上线前的存量数据用）。
   *  串行抽帧，不与生成任务抢 CPU；无缺失时立刻返回 0。 */
  backfillThumbs: (projectId: string) =>
    post<{ ok: boolean; scanned: number; filled: number; failed: number }>(
      `/v2/projects/${projectId}/backfill-thumbs`, {}),

  /** 取消任务。语义是"标记取消"：已发出的上游请求仍会扣费，
   *  但 runner 不会再为后续镜头发起新请求。 */
  cancelJob: (id: string) =>
    post<{ ok: boolean; status: string; changed: boolean }>(
      `/v2/jobs/${id}/cancel`, {}),

  // ---- P2-4 音频轨（TTS 旁白 / 配乐）----
  listAudioClips: (projectId: string) =>
    get<{ clips: AudioClipInfo[]; tts_available: boolean }>(`/v2/projects/${projectId}/audio-clips`),

  /** 设置/清除解说音色（整片共用一个解说声，挂项目而非角色）。 */
  setNarrationVoice: (projectId: string, voiceUrl: string | null) =>
    fetch(`${BASE}/v2/projects/${projectId}/narration-voice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ voice_url: voiceUrl }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ ok: boolean; voice_url: string | null }>;
    }),

  /** 解说剧：把剧本正文按句子边界切分到各镜头，建成待合成的旁白段。
   *  只建段不合成——合成仍走 synthTts（用户可先校对文案再花钱合成）。 */
  generateNarration: (projectId: string, opts?: {
    episodes?: number[]; replace?: boolean; voiceRefUrl?: string;
  }) =>
    post<{
      created: number; skipped_existing: number;
      shots_without_text: number; episodes: number[];
    }>(`/v2/projects/${projectId}/narration/generate`, {
      project_id: projectId,
      episodes: opts?.episodes ?? null,
      replace: opts?.replace ?? false,
      voice_ref_url: opts?.voiceRefUrl ?? null,
    }),

  /** 把镜头视频里的原声剥成独立音频段（落在「音效」轨上，可单独编辑）。
   *  幂等：已剥过的镜头会被跳过，不会生成重复音频段。
   *  剥离后该镜头视频的原音轨在导出时自动静音，声音不会响两遍。 */
  detachShotAudio: (projectId: string, shotIds?: string[]) =>
    post<{
      created: AudioClipInfo[]; created_count: number;
      skipped_existing: number; no_audio: number;
    }>("/v2/shots/detach-audio", {
      project_id: projectId,
      shot_ids: shotIds && shotIds.length ? shotIds : null,
    }),

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
  /** 同步生图（资产详情弹窗/自定义资产用；n 张，约 10-60s）。
   *  角色资产传 projectId+characterName 时，后端会自动拿该角色**别的**已有
   *  定妆图当参考（同一张脸），返回 ref_used 说明实际用了哪张。 */
  assetsGenerate: (prompt: string, opts?: {
    modelId?: string; size?: string; n?: number;
    projectId?: string; characterName?: string;
    excludeStageId?: string | null; excludeUrl?: string | null;
    useCharRef?: boolean;
  }) =>
    post<{ urls: string[]; model_id: string; ref_used?: string | null }>("/v2/assets/generate", {
      prompt, model_id: opts?.modelId ?? null,
      size: opts?.size ?? "1024x1024", n: opts?.n ?? 1,
      project_id: opts?.projectId ?? null,
      character_name: opts?.characterName ?? null,
      exclude_stage_id: opts?.excludeStageId ?? null,
      exclude_url: opts?.excludeUrl ?? null,
      use_char_ref: opts?.useCharRef ?? true,
    }),

  /** 候选图生成（job）。走 job 而非同步接口：生成要几十秒，弹窗一关同步结果就丢了，
   *  而图已落盘、钱已花掉。job 化后关窗再开还能接着挑。 */
  submitAssetCandidates: (body: {
    projectId: string; kind: string; name: string; stageId?: string | null;
    prompt: string; modelId?: string; size?: string; n?: number;
    useCharRef?: boolean; excludeUrl?: string | null;
  }) =>
    post<JobOut>("/v2/jobs", {
      kind: "asset_candidates",
      payload: {
        project_id: body.projectId, kind: body.kind, name: body.name,
        stage_id: body.stageId ?? null, prompt: body.prompt,
        model_id: body.modelId ?? null, size: body.size ?? "1024x1024",
        n: body.n ?? 1, use_char_ref: body.useCharRef ?? true,
        exclude_url: body.excludeUrl ?? null,
      },
    }),

  /** 该资产最近一次候选生成的快照（弹窗打开时接回；在跑就轮询） */
  latestAssetCandidates: (projectId: string, kind: string, name: string, stageId?: string | null) =>
    get<{ job_id: string | null; status: string | null; progress?: number;
          urls: string[]; ref_used?: string | null; prompt?: string | null;
          error?: string | null }>(
      `/v2/assets/candidates?project_id=${encodeURIComponent(projectId)}`
      + `&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`
      + (stageId ? `&stage_id=${encodeURIComponent(stageId)}` : "")),

  /** 新建资产（自定义分组：上传图或 AI 生图后落库） */
  createAsset: (body: { projectId: string; kind?: string; name: string; imageUrl?: string; prompt?: string }) =>
    post<AssetInfo>("/v2/assets", {
      project_id: body.projectId, kind: body.kind ?? "custom",
      name: body.name, image_url: body.imageUrl ?? null, prompt: body.prompt ?? null,
    }),

  /** 改资产（kind=拖拽重分类 custom→character/location；imageUrl=换图；voiceUrl=换音色；
   *  prompt=造型/场景文字描述，出片时作为参考图的文字锚点喂给提示词优化器） */
  patchAsset: (assetId: string, patch: { kind?: string; name?: string; imageUrl?: string; voiceUrl?: string; prompt?: string }) =>
    fetch(`${BASE}/v2/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        kind: patch.kind ?? null, name: patch.name ?? null,
        image_url: patch.imageUrl ?? null,
        voice_url: patch.voiceUrl ?? null,
        prompt: patch.prompt ?? null,
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<AssetInfo>;
    }),

  deleteAsset: (assetId: string) =>
    fetch(`${BASE}/v2/assets/${assetId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<{ ok: boolean }>; }),

  /** 按 (kind,name) 换图/换音色/改造型描述（拖资产卡到场景轨段=替换参考图；无行则建） */
  upsertAssetImage: (projectId: string, kind: string, name: string,
                     imageUrl?: string, voiceUrl?: string, prompt?: string) =>
    post<AssetInfo>("/v2/assets/upsert-image", {
      project_id: projectId, kind, name,
      image_url: imageUrl ?? null, voice_url: voiceUrl ?? null,
      prompt: prompt ?? null,
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