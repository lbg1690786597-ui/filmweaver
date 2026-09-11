/** FilmWeaver 后端 API 客户端（对接 backend /v2）。 */
import pkg from "../package.json";
import type { MosaicParams } from "./render/model";
import { fetchTracked } from "./lib/trackedFetch";
import { noteRequestOk, noteRequestFailed } from "./lib/backendReach";
import { isUnreachable } from "./lib/appGate";
// 2.3：写请求的错误要带上状态码，调用方才能把 409（并发冲突）与别的失败区分开
import { SaveHttpError } from "./stores/saveStateStore";

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

/**
 * 6.8 补发一笔离线队列里的写。返回 HTTP 状态码；`null` 表示**又断了**。
 *
 * 放在 api.ts 是因为 `authHeaders()` 只在这里 —— 队列里**刻意不存 token**
 * （磁盘上的明文 JSON 不该有它，何况陈旧 token 补发也只会 401），
 * 所以补发时必须现取。
 *
 * ⚠️ **刻意不走 `fetchTracked`**，这是承重的：
 *   · 它的 catch 会把失败的这一笔**重新塞回队列**，而我们正在遍历这个队列 ——
 *     一边发一边往里加，`replayQueue` 算出来的 remaining 就不是真的了；
 *   · 它会把补发计进「保存中 / 保存失败」，于是用户离线期间攒的 5 笔改动
 *     会在恢复的瞬间让顶栏连闪 5 次红 —— 而补发结果本来就要用一句话统一交代。
 * 可达性照样上报（`noteRequestOk` / `noteRequestFailed`）：那是"后端在不在"，
 * 与"这笔存没存上"无关，断在补发中途必须能立刻被察觉。
 */
export async function sendQueuedWrite(
  w: { method: string; url: string; body: string | null },
): Promise<number | null> {
  try {
    const resp = await fetch(w.url, {
      method: w.method,
      headers: w.body === null
        ? authHeaders()
        : { "Content-Type": "application/json", ...authHeaders() },
      body: w.body,
    });
    noteRequestOk();
    return resp.status;
  } catch (e) {
    noteRequestFailed(e);
    // 连不上 → null（`replayQueue` 据此立刻停下，把剩下的原样留着）。
    // 不是连不上却 reject（极少见，例如 URL 本身非法）→ 给一个非 2xx 的
    // 数字让它按"其余 4xx"处理：丢弃并如实计入 rejected。**不能**也返回 null，
    // 那会让这一笔永远卡在队头，每次恢复连接都重试同一个必失败的请求。
    return isUnreachable(e) ? null : 0;
  }
}

/* ------------------------------------------------------------------ *
 * 写请求的唯一出口 —— 顶栏「已保存」的真实数据源（2.1）
 *
 * 本文件里**所有**写请求（POST/PATCH/PUT/DELETE）都必须走 `fetchTracked`，
 * 直接 `fetch` 的写请求会让顶栏在它失败时依然显示「已保存」。
 * 实现与豁免名单在 lib/trackedFetch.ts；`scripts/verify-save-state.ts`
 * 会静态扫本文件，逮住任何漏网的写请求。
 * ------------------------------------------------------------------ */

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetchTracked(`${BASE}${path}`, {
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
export type ClipReference = {
  /** 引用种类（后端 UrlColumn.kind），如 shot / asset_stage / scene_view */
  type: string;
  /** 引用方的行 id */
  id: string;
  /** 引用所在库表，如 asset_stages。排障用，界面不展示 */
  table: string;
  /** 给人看的一句话，如「角色「林晚」造型「沉郁迷茫」的定妆图」 */
  label: string;
};

export class ApiError extends Error {
  status: number;
  reason?: string;
  categories?: string[];
  /** B23：删除素材被引用挡下时，后端回的引用清单（用于给用户看清删了会坏什么）。
   *  `table` 是引用所在的库表名（后端 `media_refs.URL_COLUMNS` 的单一事实来源），
   *  界面只展示 `label`；`table` 供排障与验证脚本点名用。 */
  references?: ClipReference[];
  constructor(status: number, message: string, reason?: string, categories?: string[],
              references?: ClipReference[]) {
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

async function get<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
  // 6.7：读请求也走 `fetchTracked`。它对 GET **不计入保存状态**（`isTrackedWrite`
  // 只认写方法），走这一趟只为了让读也成为「后端还连不连得上」的证据 ——
  // 全软件绝大多数请求是读，只盯写的话，一个只在浏览的用户断了网也察觉不到。
  //
  // `extraHeaders` 目前只有一个用途：飞书轮询取号的 `X-FW-Claim`。
  // 那个取号密钥**刻意不放 query** —— query 会进 nginx access log，
  // 而 ticket 已经在 query 里，两个都落日志就等于把会话写进日志。
  const resp = await fetchTracked(`${BASE}${path}`,
    { headers: extraHeaders ? { ...authHeaders(), ...extraHeaders } : authHeaders() });
  // 2.4：以前这里是 `throw new Error(String(resp.status))` —— 整条消息就是三个
  // 数字，读路径的 catch 只能一律当"失败"处理，说不出"是接口不存在还是后端挂了"。
  // 而这两件事用户能做的动作完全不同（前者是功能不可用，后者是稍后重试）。
  // 改抛 ApiError 后状态码可编程读取，`describeLoadError` 才有分类的依据。
  if (!resp.ok) throw toApiError(resp.status, await resp.text().catch(() => ""));
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
/** 画风预设（后端 `style_preset.py` 是唯一事实来源，前端不硬编码任何词）。
 *  `enabled=false` = 词表写好了但还没放开：前端**列出但禁用**并打「待完善」徽章，
 *  后端 `style_preset.resolve()` 同时会把它兜底成都市档——双保险。 */
export interface StyleOption {
  key: string;
  label: string;
  desc: string;
  enabled: boolean;
}

/** 生产模式（决定台词怎么配音）+ 它下面可选的画风。 */
export interface ProductionModeInfo {
  label: string;
  video_model?: string;
  /** 该模式下有没有任何已启用的画风；false = 整个模式还不能选 */
  enabled: boolean;
  /** 标称默认画风 key（可能本身就是未启用档，如动漫剧的 anime_3d） */
  default_style: string | null;
  styles: StyleOption[];
}

export interface ProjectInfo {
  id: string;
  title: string;
  base_aspect: string;
  production_mode: string | null;
  /** 用户选的画风 key；null = 老项目/没选 */
  art_style?: string | null;
  /** **实际生效**的画风 key。与 `art_style` 不同 = 那档还没放开，已回退都市 */
  effective_style?: string | null;
  episodes_count?: number;
  /** TB-11：列表接口直接带统计，前端不再逐项目补拉 detail */
  shots_total?: number;
  shots_done?: number;
  total_sec?: number;
  thumb_url?: string | null;
  /** 建项目时刻（ISO8601）。**可能为 null**：迁移只能从 jobs 回填，
   *  从没跑过任何任务的老空项目推断不出来。排序时 null 一律排最后。 */
  created_at?: string | null;
  /** 回收站墓碑时刻；null/缺省 = 在用 */
  deleted_at?: string | null;
  /** 最近活动 = 该项目最后一个任务的时刻（由 jobs 派生，不是 updated_at 列） */
  last_active_at?: string | null;
}

/** 彻底删除的预演结果（只算不删），用于把确认框写具体。 */
export interface PurgePreview {
  /** 将被 unlink 的独占文件数 */
  files: number;
  /** 将释放的字节数 */
  bytes: number;
  /** 因被别的项目共用而**保留**的文件数 */
  shared_skipped: number;
  /** 各表将删除的行数，如 `{ shots: 120, assets: 8 }` */
  rows: Record<string, number>;
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
  /** 场景**归一名**（后端 `scenes.canonical_of` 下发）。
   *  `location` 是拆解写下的原名，同一个房间各集写法常常不同
   *  （「夜 内 楚家公馆-客厅」/「楚家公馆-客厅」）；而场景资产名、场景轨、
   *  造型的 scene 绑定一律是归一名。**凡是要和场景资产/场景轨比对的地方
   *  都用这个字段**，用 `location` 会静默比不中。展示镜头自身的场景标签
   *  仍用 `location`（那才是本镜剧本里的写法）。
   *  老后端没有这个字段 → undefined，调用方回落到 `location`。 */
  location_canonical?: string | null;
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
  /** 本镜已过期，需要重做；**要做什么由 stale_reason 决定**，别自己推测 */
  stale: boolean;
  /** 过期的原因，按「补救动作」命名（后端 app/stale.py 是唯一真源）：
   *  rebreak  本集正文改了 → 镜头切分已失效，需**重新拆解本集**
   *  reprompt 本镜 script_ref/场景/衔接改了 → 需**重新生成提示词**再出片
   *           （出片时后端会自动弃用旧 gen_prompt、从 script_ref 重优化）
   *  regen    只是旁白时长变了 → 画面依据没变，**重出片即可**，出完自动清标记
   *  null     本字段上线前的老数据，原因未知，按最保守的 rebreak 提示 */
  stale_reason?: "rebreak" | "reprompt" | "regen" | null;
  /** 后端按 stale_reason 出的那句人话（文案在后端，避免前后端各拼一份漂移）。
   *  老后端/老数据拿不到 → 回落 staleHint() 的兜底文案 */
  stale_hint?: string | null;
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
  /** 2.3 乐观锁：`transform_meta` 的版本号（服务端按内容算）。
   *  写回时原样带上，服务端发现已被别处改过就回 409 而不是静默覆盖。
   *  读取方一律通过 `lib/shotRev.ts`，不要在别处直接用它比较。 */
  transform_rev?: string | null;
}

/**
 * 写 transform_meta 时的落库时机（2.2）。
 *
 * `staged: true` —— 拖动/滑动**过程中**的中间值：本地立即生效（画面跟手），
 * 真正的 PATCH 按尾防抖延后，见 `lib/stagedWrite.ts`。
 * 缺省（或 `staged: false`）—— 离散操作（点按钮、选下拉、双击还原）与
 * 松手时的收尾提交：立即落库。
 *
 * ⚠️ 默认是**立即落库**，所以忘了传 `staged` 只会退化成"和以前一样每帧一次
 * PATCH"，不会丢数据；反过来把离散操作标成 staged 才是错的（用户点完就
 * 可能立刻关窗口，得不到 250ms 的宽限）。
 */
export interface TransformPatchOpts { staged?: boolean }

/** TB-03/TB-10：与后端 Shot.transform_meta 同构；缺键 = 该项不处理 */
export interface TransformMeta {
  scale?: number; rotate?: number;
  /**
   * 画面中心相对画布中心的偏移，单位是**画布宽/高的百分比**（不是像素）。
   *
   * ⚠️ 这里必须是分辨率无关的量，原因是硬的：**编辑期根本不知道画布分辨率**——
   * 导出宽高是在 ExportDialog 里当场选的（`App.tsx:588`），同一个项目可以
   * 一会儿导 720p 一会儿导 1080p。若存像素，同一次拖拽在两种分辨率下会把画面
   * 挪到不同的相对位置。
   *
   * 早先这里存的是**预览窗口的屏幕像素**（`CropZoomOverlay` 直接把鼠标位移
   * `dx` 写进来），于是同一个拖动在大窗口和小窗口下存出不同的数——而导出侧
   * 又按画布像素解释它。两头单位都不对，且互不相同。
   */
  x?: number; y?: number;
  /**
   * V2.3：非等比缩放（百分比，缺省跟随 scale）。
   * 拖边中点做单轴拉伸时才会写入；角点等比缩放只写 scale。
   * 渲染/预览取值一律用 `scaleX ?? scale`，老数据没有这两个字段也能正常工作。
   */
  scaleX?: number; scaleY?: number;
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
  /**
   * V2.3 区域马赛克（数组，允许多个区域）。
   * 类型直接复用 render 层的 MosaicParams —— normalize.ts 就是原样铺进去的，
   * 两边同构是硬约束，各写一份只会静默漂移（见 model.ts 的说明）。
   * model.ts 零依赖、纯类型，这里是 type-only import，不产生运行时耦合。
   */
  mosaics?: MosaicParams[];
  /** V2.3 取景框裁切（相对原始画面的比例 0..1）；未设 = 不裁 */
  crop?: { left: number; top: number; right: number; bottom: number };
  /** V2.2 混合模式（仅叠加层生效） */
  blendMode?: "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten";
  /**
   * P2-7 留黑：画面变黑，**时长与声音照旧**。
   * 与 `ShotTimelineIn.disabled`（停用：不占时间、不出画面、字幕合拢）是
   * 两件不同的事，语义对照表见 `render/model.ts` 的 `RenderClip.blackout`。
   *
   * 放在 `transform_meta` 里而不是新加一列：后端 `routes_v2.py` 的
   * `transform_meta: Optional[dict]` 原样透传，**零迁移**；代价是它会参与
   * `transform_rev` 的内容哈希 —— 这恰恰是想要的，留黑本来就该受乐观锁保护。
   */
  blackout?: boolean;
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
  art_style?: string | null;
  effective_style?: string | null;
  /** 单镜时长上限（秒），由服务端按项目的视频模型算：
   *  seedance-2.0/veo → 15，seedance-2.5 → 30，H3 随分辨率变。
   *  时间轴拖拽与时长输入框都用它做上限；缺省（老后端）按 15。 */
  shot_duration_max?: number;
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
  /** 项目分辨率档位（480p/720p/1080p/2k）= 新建向导里选的那一档。
   *  **可能为 null**：老项目的 default_profile 里没这一项，那就是"模型默认"。
   *  「本次参数」面板拿它当"沿用项目设置（…）"的显示值——没有它就只能
   *  默认显示档位表第一项，用户选的 720p 会被显示成 1080p。 */
  resolution?: string | null;
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

/** 归一建议的**预览**（POST /v2/projects/{id}/scenes/preview，只算不写）。
 *  比 `SceneGroup` 多的全是"执行后会变什么"：哪个写法会被改、
 *  会推翻哪条人工映射、会删掉哪一行场景资产（不可逆的那一段）。 */
export interface ScenePreviewGroup {
  canonical: string;
  shots: number;
  /** false = 这一组现在就已经是这样了，确认它什么都不会发生 */
  changed: boolean;
  /** 已被用户手改成别的归一名的成员：确认这一组就是推翻自己的手改 */
  locked: string[];
  members: {
    raw_name: string;
    shots: number;
    current_canonical: string;
    source: string;
    will_change: boolean;
    time_of_day: string | null;
    int_ext: string | null;
  }[];
  /** 空对象 = 没有资产要合并。非空则 drop 里的行会被**删除** */
  asset_merges: {
    keep: { name: string; has_image: boolean };
    drop: { name: string; has_image: boolean; deleted: boolean }[];
  } | Record<string, never>;
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

/** 被删除的造型阶段（墓碑，`listStages().deleted_stages`）。
 *
 *  不复用 `StageInfo`：墓碑不参与轨道计算，后端**故意**不给它算
 *  `present_orders` / `manual_*`（那是"实际注入"的口径，删掉的阶段一个镜头都不注入）。
 *  这里带 image_url 只为让用户看图认出"删掉的是哪一套造型"——阶段名常常只是
 *  「造型2」，光看名字认不出来。 */
export interface DeletedStageInfo {
  id: string;
  character_name: string;
  stage_name: string;
  ep_from: number;
  ep_to: number;
  shot_from: number | null;
  shot_to: number | null;
  image_url: string | null;
  description: string | null;
  location: string | null;
  /** 打墓碑的时刻（ISO8601） */
  deleted_at: string | null;
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
  /** 墓碑：用户手动删除这条资产的时刻（ISO）。非空 = 已删除。
   *  后端**故意不过滤**，由前端默认隐藏并提供「已删除」恢复入口——
   *  否则删错了就再也找不回来。 */
  deleted_at?: string | null;
}

/** 角色形象档案：这个角色**全剧统一**的长相（骨相/肤色/五官/气质）。
 *
 * 与「造型描述」(`AssetInfo.prompt` / `StageInfo.description`) 分工明确：
 * 档案是脸，造型是衣服。衣服每套一份，脸只有一份。
 * 后端事实来源 `backend/app/character_profile.py`。 */
export interface CharacterProfile {
  v: number;
  /** modern | period | generic —— 决定气质两轴的候选值域 */
  genre: string;
  /** {轴 key: 取值}。缺的轴 = 没判出来，不写进提示词 */
  axes: Record<string, string>;
  /** 词表覆盖不到的独有特征（疤痕/义眼/胎记） */
  extra: string;
  /** draft = AI 判的；confirmed = 用户手改过，自动流程不再覆盖 */
  status: string;
}

/** 一条档案轴的定义（下拉候选由后端给） */
export interface ProfileAxis {
  key: string;
  label: string;
  values: string[];
  /** true = 可留空（妆容/记忆点对男性与儿童不适用，留空即不进提示词） */
  optional: boolean;
}

export interface CharacterProfileOut {
  name: string;
  /** null = 这个角色还没生成过档案 */
  profile: CharacterProfile | null;
  genre: string;
  axes: ProfileAxis[];
  extra_max: number;
}

/** 一条视觉体检结论（`backend/app/asset_qc.py`）。
 *  `null` = 体检没跑成（视觉通道不可用），**不等于**通过。 */
export interface AssetQcResult {
  ok: boolean;
  /** 问题 key（has_person / has_scene / not_three_view / …），文案由 summary 给 */
  issues: string[];
  note: string;
}

/** 场景的一张多视角参考图 */
export interface SceneViewRow {
  id: string;
  key: string;
  /** angle = 方位视角；framing = 景别 */
  kind: string;
  label: string;
  sort: number;
  /** true = 主视角，它同时是 `Asset.image_url`（注入镜头的兜底图就是它） */
  primary: boolean;
  image_url: string | null;
  prompt: string | null;
  qc: AssetQcResult | null;
}

/** 视图定义（标签/顺序由后端 `scene_view.VIEWS` 下发，前端不硬编码） */
export interface SceneViewDef {
  key: string;
  label: string;
  kind: string;
  sort: number;
  primary: boolean;
}

export interface SceneViewsOut {
  asset_id: string;
  name: string;
  project_id: string;
  /** 场景空间描述（= `AssetInfo.prompt`），拼进每张视角图的提示词 */
  description: string | null;
  /** 美术设定板（服务端 PIL 拼的派生图，**只给人看**，从不注入模型） */
  board_url: string | null;
  progress: { done: number; total: number };
  defs: SceneViewDef[];
  views: SceneViewRow[];
  /** 后端刚认领/同步过主视角 → 前端顺带刷资产缩略图 */
  primary_synced: boolean;
}

/** 全片影调档案：一套调色配方，拼进所有资产图/首帧图/视频提示词。
 *  事实来源 `backend/app/look_profile.py`。 */
export interface ProjectLook {
  v: number;
  axes: Record<string, string>;
  extra: string;
  /** draft = AI 判的；confirmed = 用户手改过，自动流程不再覆盖 */
  status: string;
}

export interface LookAxis {
  key: string;
  label: string;
  values: string[];
}

export interface ProjectLookOut {
  /** null = 这个项目还没生成过影调档案 */
  look: ProjectLook | null;
  /** 实际拼进提示词的那句话——让"提示词里到底写了什么"可见可查 */
  phrase: string;
  axes: LookAxis[];
  extra_max: number;
  axis_max: number;
}

export interface AssetQcOut {
  name: string;
  kind: string;
  checked: number;
  failed: number;
  items: {
    view_key: string | null;
    row_id: string | null;
    label: string;
    image_url: string;
    result: AssetQcResult | null;
    /** 后端 `asset_qc.describe` 给的人读结论，前端直接显示不自己拼句子 */
    summary: string;
  }[];
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
/**
 * 音色库里的一条音色（全局素材，与项目无关）。
 *
 * ⚠️ 这个库**当前是空的**，后端 `/v2/voice-library` 常态返回 `voices: []`。
 * 它不是坏了——音色素材要后期才补。前端必须把空库当**主要形态**做好：
 * 明说"建设中"并引导去上传自己的音色，而不是甩一句"暂无数据"。
 */
export interface VoiceLibItem {
  id: string;
  name: string;
  gender: string | null;
  age: string | null;
  style: string | null;
  tags: string[];
  /** 试听/赋值用的音频地址（/fw/media/voice-library/xxx.wav） */
  url: string;
}

export interface AudioClipInfo {
  id: string;
  /** shot = 从镜头视频里剥出来的原声；narration = 解说剧按剧本切出的旁白 */
  kind: "tts" | "music" | "shot" | "narration";
  text: string | null;
  url: string | null;
  duration: number;
  start_shot_order: number;
  start_offset_sec: number;
  /** 6.9 修剪窗口：在 url 这个音源里取 [clip_in_sec, +clip_dur_sec)。
   *  null = 整段播放。**播放时长 = clip_dur_sec ?? duration**，
   *  `duration` 始终是音源实测总长，修剪不会改它（见 db.py AudioClip）。 */
  clip_in_sec?: number | null;
  clip_dur_sec?: number | null;
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
  //
  // `claim_secret`（2026-09-11 起，后端 S2）：只有 desktop 模式会返回，
  // 是取号的第二把钥匙。它**只存在于本次响应的内存里** —— 不写 localStorage、
  // 不进 URL，因为整个劫持路径的前提就是"ticket 必然经过扫码那个人的浏览器"，
  // 而这把钥匙全程不出现在授权链接里。web 模式压根不走 poll（回调直接 302
  // 带回令牌），所以后端也不发。
  feishuStart: (mode: "desktop" | "web" = "desktop") =>
    post<{ ticket: string; authorize_url: string; claim_secret?: string }>(
      `/v2/auth/feishu/start?mode=${mode}`, {}),
  feishuPoll: (ticket: string, claimSecret: string) =>
    get<{ status: "pending" | "ok" | "expired"; token?: string; expires_at?: string; user?: { id: number; username: string; display_name: string | null; role: string } }>(
      `/v2/auth/feishu/poll?ticket=${encodeURIComponent(ticket)}`,
      { "X-FW-Claim": claimSecret }),

  // 登出只吊销**自己**的会话：主体由 Authorization 头决定（authHeaders() 带上），
  // 请求体不再传 token —— 后端 2026-09-11 起会拒绝"用我的 token 吊销别人的"。
  logout: () => post<{ ok: boolean }>("/v2/auth/logout", {}),

  authMe: () =>
    get<{ user: { id: number; username: string; display_name: string | null; role: string } }>(
      // 不再把 token 放进 query：它会进 nginx access log 和浏览器历史。
      // authHeaders() 读的是同一个 fw_session key，Authorization header
      // 会自动带上，后端已优先读 header。
      "/v2/auth/me"),

  appLatest: () => get<AppLatest>("/v2/app/latest"),

  // ---- R0: 项目化（契约 C2/C3）----
  productionModes: () => get<{
    modes: Record<string, ProductionModeInfo>;
    aspects?: string[];
    resolutions?: string[];
  }>("/v2/production-modes"),

  /** 项目列表。`trash=true` **只**返回回收站里的项目（与在用列表互斥）。 */
  listProjects: (trash = false) =>
    get<{ projects: ProjectInfo[] }>(`/v2/projects${trash ? "?trash=true" : ""}`),

  /** 重命名项目。
   *
   *  ⚠️ title 会作为片名进入生成提示词，所以改名影响**此后**新生成内容的语境，
   *  已生成的图与视频不变——这句必须在 UI 上告诉用户。 */
  renameProject: (id: string, title: string) =>
    fetchTracked(`${BASE}/v2/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ title }),
    }).then(async (r) => {
      if (!r.ok) throw toApiError(r.status, await r.text());
      return r.json() as Promise<{ ok: boolean; id: string; title: string }>;
    }),

  /** 移入回收站（打墓碑）。数据与磁盘文件一个不动，可 `restoreProject` 恢复。 */
  trashProject: (id: string) =>
    fetchTracked(`${BASE}/v2/projects/${id}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw toApiError(r.status, await r.text());
        return r.json() as Promise<{ ok: boolean; mode: string; deleted_at?: string }>;
      }),

  /** 从回收站恢复。 */
  restoreProject: (id: string) =>
    post<{ ok: boolean; id: string }>(`/v2/projects/${id}/restore`, {}),

  /** 彻底删除前的预演：会删几个文件、释放多少、有几个因共用而保留。 */
  purgePreview: (id: string) => get<PurgePreview>(`/v2/projects/${id}/purge-preview`),

  /** 彻底删除（**不可恢复**）：删库行 + unlink 该项目独占的文件。
   *  后端要求项目已在回收站，否则 409。 */
  purgeProject: (id: string) =>
    fetchTracked(`${BASE}/v2/projects/${id}?purge=true`,
          { method: "DELETE", headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw toApiError(r.status, await r.text());
        return r.json() as Promise<{
          ok: boolean; mode: string; rows: Record<string, number>;
          files_deleted: number; bytes_freed: number; shared_skipped: number;
        }>;
      }),

  createProject: (title: string, baseAspect: string, productionMode: string,
                  customSettings?: Record<string, string>,
                  artStyle?: string | null) =>
    post<ProjectInfo>("/v2/projects", {
      title, base_aspect: baseAspect, production_mode: productionMode,
      custom_settings: customSettings ?? null,
      art_style: artStyle ?? null,
    }),

  /** 读项目画风（含该模式下的可选值域与是否已回退）。 */
  projectArtStyle: (id: string) => get<{
    production_mode: string | null;
    art_style: string | null;
    effective_style: string;
    effective_label: string;
    /** true = 用户选的那档还没放开，实际用的是 `effective_style` */
    pending: boolean;
    styles: StyleOption[];
    default_style: string | null;
  }>(`/v2/projects/${id}/art-style`),

  /** 改项目画风。只影响**此后**新生成的图与视频，已生成的不会重画。 */
  saveProjectArtStyle: (id: string, artStyle: string | null) =>
    fetchTracked(`${BASE}/v2/projects/${id}/art-style`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ art_style: artStyle }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{
        art_style: string | null; effective_style: string;
        effective_label: string; pending: boolean;
      }>;
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
    const resp = await fetchTracked(`${BASE}/v2/script/import-file`, {
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
    fetchTracked(`${BASE}/v2/projects/${projectId}/episodes/${order}/content`, {
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

  /** 采用某个版本。
   *
   *  3.1：切版本 = 换素材，后端会顺手清掉取片窗口（否则旧的入点/出点落在
   *  新素材上就是一段错的内容，导出黑帧）。`clip_window_cleared` 为真时
   *  调用方应当提示用户"入点已重置"，别让这件事静默发生。 */
  adoptShot: (shotId: string, versionNo: number) =>
    post<{ ok: boolean; video_url: string; clip_window_cleared?: boolean }>(
      `/v2/shots/${shotId}/adopt`, { version_no: versionNo }),

  /** TB-01 在镜内第 atSec 秒把镜头分割为前后两段（时间轴 Ctrl+B） */
  // ---- TB-02 字幕轨 ----
  listSubtitleClips: (projectId: string) =>
    get<{ clips: SubtitleClipInfo[] }>(`/v2/projects/${projectId}/subtitle-clips`),

  /** 每镜"会被念出来"的台词原文（真人剧本地对齐字幕的文本来源）。
   *
   *  判定哪一行是台词的权威实现在后端 `drama_timing.split_units`——拆镜算
   *  时长用的就是它。前端不要自己解析剧本：字幕文本必须**等于**当初让视频
   *  模型念的文本，两份解析器一漂移，对齐就失去意义了。
   *
   *  纯文本变换，不调模型、不产生费用。只回没被念出来的行**已剔除**的结果，
   *  所以 `shots` 里不含纯画面描述的镜头。按 `order` 与 ShotInfo 关联。 */
  listSpokenLines: (projectId: string) =>
    get<{ shots: { shot_id: string; order: number; episode: number;
                   lines: string[]; text: string }[] }>(
      `/v2/projects/${projectId}/spoken-lines`),

  createSubtitleClip: (body: {
    project_id: string; text: string; kind?: string;
    start_shot_order?: number; start_offset_sec?: number;
    duration?: number; style?: Record<string, unknown>;
  }) => post<SubtitleClipInfo & { ok: boolean }>("/v2/subtitle-clips", body),

  patchSubtitleClip: (clipId: string, patch: {
    text?: string; kind?: string; start_shot_order?: number;
    start_offset_sec?: number; duration?: number; style?: Record<string, unknown>;
  }) =>
    fetchTracked(`${BASE}/v2/subtitle-clips/${clipId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<SubtitleClipInfo>;
    }),

  deleteSubtitleClip: (clipId: string) =>
    fetchTracked(`${BASE}/v2/subtitle-clips/${clipId}`, { method: "DELETE", headers: authHeaders() })
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
    fetchTracked(`${BASE}/v2/projects/${projectId}/subtitle-style`, {
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
    fetchTracked(`${BASE}/v2/transitions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<TransitionInfo>;
    }),

  deleteTransition: (id: string) =>
    fetchTracked(`${BASE}/v2/transitions/${id}`, { method: "DELETE", headers: authHeaders() })
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
    fetchTracked(`${BASE}/v2/clips/${clipId}/audio-tag`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ tag }),
    }).then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); }),

  // ---- 音色库（全局素材，当前为空）----
  voiceLibrary: () =>
    get<{ voices: VoiceLibItem[]; count: number; error?: string }>("/v2/voice-library"),

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

  /** 撤销分割：把后半段合回前半段（Ctrl+B 的逆操作，供撤销栈用）。
   *  后半段被单独重生成/改过时长时后端会 409，此时撤销失败而不是静默丢数据。 */
  unsplitShot: (headShotId: string, tailShotId: string) =>
    post<{ ok: boolean; shot_id: string; order: number; duration: number }>(
      `/v2/shots/${headShotId}/unsplit`, { tail_shot_id: tailShotId }),

  /** 版本历史（R2 精编器回退面板，契约 C10） */
  shotVersions: (shotId: string) =>
    get<{ versions: { version_no: number; video_url: string | null; model_id: string | null; prompt: string | null; meta: Record<string, unknown> | null; created_at: string | null }[] }>(`/v2/shots/${shotId}/versions`),

  // ---- R1: 人物资产阶段（契约 C5）----
  /** 造型阶段 + 场景轨 + **已删除的阶段**（墓碑，资产页「已删除」组的数据源）。
   *  `stages` 只含在用的：它的契约是「轨道显示 = 实际注入」，墓碑不注入。 */
  listStages: (projectId: string) =>
    get<{ stages: StageInfo[]; deleted_stages?: DeletedStageInfo[];
          locations: LocationInfo[] }>(`/v2/projects/${projectId}/stages`),

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
    fetchTracked(`${BASE}/v2/scenes/alias`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ project_id: projectId, raw_name: rawName, canonical }),
    }).then(async (r) => { if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`); return r.json() as Promise<{ ok: boolean; changed: boolean }>; }),

  /** 归一建议 + 逐条影响（只算不写，一次文本模型调用，不出图）。
   *  由用户点按钮触发 —— 别在打开面板时自动跑，那是白花一次模型调用。 */
  previewSceneCanon: (projectId: string) =>
    post<{ ok: boolean; llm: boolean; groups: ScenePreviewGroup[] }>(
      `/v2/projects/${projectId}/scenes/preview`, {}),

  /** 把**用户逐组确认过**的分组写进库（source=manual，AI 重跑不推翻）。
   *
   *  ⚠️ 后端还有一条 `POST /scenes/canonicalize`（算完直接全量写库），
   *  这里**刻意不封装它**：归一是有损的（同一归一名下多行场景资产会被合并成
   *  一行、删掉的那行可能已出过图），"一键全归一"等于让用户在没看过的合并上
   *  也点了同意。那条路径只保留给 `stages_draft` 内部使用。见文档 U3。 */
  applySceneGroups: (projectId: string,
                     groups: { canonical: string; members: string[] }[]) =>
    post<{ ok: boolean; applied_groups: number; updated: number;
           assets: { renamed: number; merged: number; deleted: string[] } }>(
      `/v2/projects/${projectId}/scenes/apply-groups`, { groups }),

  /** 服装解析报告（只读，花费闸门数据源：先报数，用户点了才出图） */
  costumeReport: (projectId: string) =>
    get<CostumeReport>(`/v2/projects/${projectId}/costume-report`),

  patchStage: (stageId: string, patch: Partial<Pick<StageInfo,
    "stage_name" | "ep_from" | "ep_to" | "shot_from" | "shot_to" | "description" | "image_url" | "status" | "location" | "scene_bound">>
    & {
      /** 换成**用户自己上传的图**时传 true：连同换图把旧造型描述清空。
       *  见后端 `routes_v2._CLEAR_DESC_WHY`——旧描述是拆剧本时按文字写的，
       *  与这张新图无关，留着它反而会在出片时压过参考图导致外观漂移。
       *  ⚠️ 采用 AI 候选图**不要**传：那张图本来就是照着这段描述生的。 */
      clear_description?: boolean;
    }) =>
    fetchTracked(`${BASE}/v2/stages/${stageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    }).then(async (r) => { if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`); return r.json() as Promise<StageInfo>; }),

  /** 删除造型阶段 = **打墓碑**（软删，2026-09-09 起）。
   *
   *  以前是真删，误删一个已出定妆图的阶段就把那张图彻底丢了——"重跑服装识别"
   *  找不回来：那是按剧本重新规划，出来的是新 id、没有图的阶段，还要重新花钱。
   *  现在行与图都留着，`restoreStage` 可原样恢复。
   *
   *  `followers` = 把它当图源的指针行数（那几段会跟着失去图）；
   *  `kept_image` = 定妆图仍在磁盘上（GC 连墓碑一起扫）。 */
  deleteStage: (stageId: string) =>
    fetchTracked(`${BASE}/v2/stages/${stageId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<{
          ok: boolean; already_deleted?: boolean;
          character_name?: string; stage_name?: string;
          deleted_at?: string; kept_image?: boolean; followers?: number;
        }>;
      }),

  /** 撤销删除造型阶段（清墓碑）。阶段与定妆图原样回来。
   *
   *  唯一会失败的情形是 **409 区间已被占**：墓碑刻意不占集区间，所以删掉之后
   *  用户可能在同一段集里建了新造型。此时错误文本里点名了和谁撞，直接给用户看。 */
  restoreStage: (stageId: string) =>
    post<{ ok: boolean; already_alive?: boolean; stage?: StageInfo }>(
      `/v2/stages/${stageId}/restore`, {}),

  //: 这里曾有 `stageCandidates`（同步版 `POST /v2/stages/{id}/candidates`：一次请求里
  //: 等图出完再返回）。**刻意不再封装**：候选定妆图统一走 job 化的
  //: `submitAssetCandidates` / `latestAssetCandidates`（可关窗、可接回、TasksDrawer 可见）。
  //: 两条路并存的后果已经发生过一次——2026-09-11 的复审因为只看到这个包装，
  //: 误判"前端从来没有候选图入口"。后端那条同步路由仅为已安装的旧客户端保留，
  //: 新代码不要再接它，详见 `docs/AUDIT-2026-09-11-全面复审.md` 的 U6。

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
    fetchTracked(`${BASE}/v2/shots/${shotId}/breakdown`, {
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
    fetchTracked(`${BASE}/v2/shots/${shotId}/prompt`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ gen_prompt: genPrompt }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ ok: boolean; prompt_state: string }>;
    }),

  /** 撤销手改，把提示词交还给 AI（清 override，下次生成重新优化） */
  resetShotPrompt: (shotId: string) =>
    fetchTracked(`${BASE}/v2/shots/${shotId}/prompt`, {
      method: "DELETE", headers: { ...authHeaders() },
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ ok: boolean; prompt_state: string }>;
    }),

  patchShotTimeline: (shotId: string, patch: {
    durationSec?: number; toOrder?: number; disabled?: boolean;
    /** TB-03/TB-10：传 {} 清除全部调整 */
    transformMeta?: TransformMeta | Record<string, never>;
    /** 2.3 乐观锁：本次改动所基于的 transform_meta 版本号（见 lib/shotRev.ts）。
     *  省略 = 不做并发校验；只改时长/顺序的调用不需要它。 */
    baseTransformRev?: string;
    /** Render V2 多轨：移到第几条视频轨（0=主轨） */
    trackIndex?: number;
    overlayStartSec?: number;
    /** 3.1 取片窗口：入点（秒，相对素材开头）。
     *  与 clipDurSec 一起构成 `[in, in+dur)`，导出与字幕定时读的是它。 */
    clipInSec?: number;
    /** 3.1 取片窗口长度（秒）。后端会同步把 duration_sec 写成同值，
     *  维持 `duration_sec == clip_dur_sec` 的不变式（见 db.py 的说明）。 */
    clipDurSec?: number;
    /** 3.1 取消入点：把窗口清回"整段使用"。
     *  为什么要一个单独的布尔而不是传 null —— 本接口的每个字段 null 都表示
     *  "本次不改这一项"，没有别的办法表达"改成空"。 */
    clearClipWindow?: boolean;
  }) =>
    fetchTracked(`${BASE}/v2/shots/${shotId}/timeline`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        duration_sec: patch.durationSec ?? null,
        to_order: patch.toOrder ?? null,
        disabled: patch.disabled ?? null,
        transform_meta: patch.transformMeta ?? null,
        base_transform_rev: patch.baseTransformRev ?? null,
        track_index: patch.trackIndex ?? null,
        overlay_start_sec: patch.overlayStartSec ?? null,
        clip_in_sec: patch.clipInSec ?? null,
        clip_dur_sec: patch.clipDurSec ?? null,
        clear_clip_window: patch.clearClipWindow ?? null,
      }),
    }).then(async (r) => {
      // 2.3：这里必须抛 SaveHttpError（而不是裸 Error）——调用方要靠 status
      // 认出 409 才能给出"被别人改过"这句人话，String(err) 里的 "409:" 前缀
      // 是文本，靠正则去认它迟早被改坏。
      if (!r.ok) throw new SaveHttpError(r.status, `${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{
        ok: boolean; order: number; duration_sec: number | null; disabled: boolean;
        /** 落库后的新版本号（老后端没有 → undefined） */
        transform_rev?: string | null;
        /** 3.1：落库后的取片窗口。连续拖左边缘时要用它做下一次的基准，
         *  否则第二次拖动会从**过期的入点**开始算（老后端没有 → undefined）。 */
        clip_in_sec?: number | null;
        clip_dur_sec?: number | null;
      }>;
    }),

  /** 删除镜头（仅外部素材镜头；AI 镜头请用停用） */
  deleteShot: (shotId: string) =>
    fetchTracked(`${BASE}/v2/shots/${shotId}`, { method: "DELETE", headers: authHeaders() })
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
    const resp = await fetchTracked(`${BASE}/v2/media/upload`, { method: "POST", headers: authHeaders(), body: fd });
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
    fetchTracked(`${BASE}/v2/clips/${clipId}${force ? "?force=true" : ""}`,
          { method: "DELETE", headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw toApiError(r.status, await r.text());
        return r.json() as Promise<{ ok: boolean; broken_references?: number }>;
      }),

  /** R2 重命名素材池里的素材（改 name，不影响 url / 镜头关联）。 */
  renameClip: (clipId: string, name: string) =>
    fetchTracked(`${BASE}/v2/clips/${clipId}`, {
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
    opts?: { genAssets?: boolean; script?: string; videoModel?: string; llmModel?: string; promptPrefix?: string; resolution?: string | null; aspect?: string | null },
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
        // ⚠️ 这里原来是 `width: opts?.width ?? 1080, height: opts?.height ?? 1920,
        // fps: 30`。三个键**后端从来没读过**（服务端不再合成，成片由桌面端
        // ffmpeg 出），而那两个 ?? 兜底还把"沿用项目设置"变成了每次都硬发
        // 1080×1920——「本次参数」里改分辨率既不生效也不报错。
        // 真正管用的是档位名 + 画幅，后端据此算 megapixels 下发给 Provider。
        // null = 沿用项目设置：**不要**在这里用项目值兜底。
        resolution: opts?.resolution ?? null,
        aspect_ratio: opts?.aspect ?? null,
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
    fetchTracked(`${BASE}/v2/projects/${projectId}/narration-voice`, {
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
    clipInSec?: number; clipDurSec?: number; clearClip?: boolean;
  }) =>
    fetchTracked(`${BASE}/v2/audio-clips/${clipId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      // ⚠️ 只发**真的要改**的键。原来这里是无条件 `patch.x ?? null` 三件套，
      // 当时无害（后端一律 `is not None` 跳过），但 6.9 之后 null 在这条路上
      // 有了第二种读法："把修剪窗口清空"。继续无条件发 null，就会变成
      // "改一下偏移顺手把用户的修剪抹了"，而且抹得悄无声息。
      // 清空窗口有专门的 clearClip，不靠 null 表达（PATCH 里 null 只能是"不改"）。
      body: JSON.stringify({
        ...(patch.startShotOrder !== undefined
          ? { start_shot_order: patch.startShotOrder } : {}),
        ...(patch.startOffsetSec !== undefined
          ? { start_offset_sec: patch.startOffsetSec } : {}),
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.clipInSec !== undefined ? { clip_in_sec: patch.clipInSec } : {}),
        ...(patch.clipDurSec !== undefined ? { clip_dur_sec: patch.clipDurSec } : {}),
        ...(patch.clearClip ? { clear_clip: true } : {}),
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<AudioClipInfo>;
    }),

  deleteAudioClip: (clipId: string) =>
    fetchTracked(`${BASE}/v2/audio-clips/${clipId}`, { method: "DELETE", headers: authHeaders() })
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
  patchAsset: (assetId: string, patch: { kind?: string; name?: string; imageUrl?: string;
                                         /** null = **清除**该角色音色（后端约定见下） */
                                         voiceUrl?: string | null; prompt?: string;
                                         /** 换成用户自己上传的图时传 true：清空旧造型描述，
                                          *  理由同 `patchStage` 的 `clear_description`。 */
                                         clearPrompt?: boolean }) =>
    fetchTracked(`${BASE}/v2/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        kind: patch.kind ?? null, name: patch.name ?? null,
        image_url: patch.imageUrl ?? null,
        // ⚠️ 后端是 `if body.voice_url is not None: a.voice_url = body.voice_url or None`
        //    （routes_v2 patch_asset）——即 **null = 不改，空串 = 清除**。
        //    所以"清除音色"必须发 ""；照抄上面几行的 `?? null` 会变成静默不改：
        //    界面按成功刷新、值却还在，用户会以为清除按钮坏了。
        voice_url: patch.voiceUrl === null ? "" : (patch.voiceUrl ?? null),
        prompt: patch.prompt ?? null,
        clear_prompt: patch.clearPrompt ?? null,
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<AssetInfo>;
    }),

  /** 删除资产 = **打墓碑**（软删）。
   *
   *  语义边界（用户 2026-09-09 决策「只断资产链，不动剧本」）：
   *  - 断掉：不再注入参考图、不计入缺图缺口、不被自动流程重建、资产页不显示
   *  - 不动：镜头里该角色/场景照旧存在，剧本一个字不改
   *  - 保留：已生成的图与磁盘文件全在，可 `restoreAsset` 恢复
   *
   *  `affected_shots` = 剧本里还提到它的镜头数，用于删除确认文案。 */
  deleteAsset: (assetId: string) =>
    fetchTracked(`${BASE}/v2/assets/${assetId}`, { method: "DELETE", headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<{
          ok: boolean; name?: string; kind?: string;
          deleted_at?: string; affected_shots?: number;
        }>;
      }),

  /** 恢复被删除的资产（清墓碑）。图还在，恢复后立刻重新参与生成。 */
  restoreAsset: (assetId: string) =>
    post<{ ok: boolean; name?: string; kind?: string }>(`/v2/assets/${assetId}/restore`, {}),

  /** 角色形象档案（结构化五官/骨相/气质）+ 词表。
   *  词表由后端给（`character_profile.AXES` 是唯一事实来源），前端不硬编码，
   *  否则加一条轴要改两处、必然漂移。 */
  assetProfile: (assetId: string) =>
    get<CharacterProfileOut>(`/v2/assets/${assetId}/profile`),

  /** 手改形象档案（= 改这个角色的脸）。存下的档案标 confirmed，自动流程不再覆盖。 */
  saveAssetProfile: (assetId: string, axes: Record<string, string>,
                     extra: string, genre?: string) =>
    fetchTracked(`${BASE}/v2/assets/${assetId}/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ axes, extra, genre: genre ?? null }),
    }).then(async (r) => {
      if (!r.ok) throw toApiError(r.status, await r.text().catch(() => ""));
      return r.json() as Promise<{ ok: boolean; profile: CharacterProfile | null }>;
    }),

  /** 按剧本重新识别形象档案。重判几乎必然给出不同的五官，所以只由用户显式触发。 */
  regenerateAssetProfile: (assetId: string) =>
    post<{ ok: boolean; profile: CharacterProfile }>(
      `/v2/assets/${assetId}/profile/regenerate`, {}),

  // ---------- 场景多视角参考图 / 设定板 / 影调档案 / 视觉体检 ----------

  /** 一个场景的 8 张多视角参考图现状（4 方位 + 4 景别）。
   *  视图标签与顺序由后端 `scene_view.VIEWS` 下发（`defs`），前端不硬编码，
   *  否则加一档景别要改两处、必然漂移（与形象档案词表同理）。 */
  sceneViews: (assetId: string) =>
    get<SceneViewsOut>(`/v2/assets/${assetId}/scene-views`),

  /** 生成/补齐场景多视角参考图。
   *  `viewKeys` 空 = 只补缺图的（省钱的默认，会与在跑的批量任务去重）；
   *  给了 key = 无论有没有图都重画这几张（定向"重画"，不去重）。 */
  generateSceneViews: (assetId: string, viewKeys?: string[],
                       opts?: { modelId?: string; size?: string }) =>
    post<JobOut>(`/v2/assets/${assetId}/scene-views/generate`, {
      view_keys: viewKeys ?? [],
      model_id: opts?.modelId ?? null,
      size: opts?.size ?? "1024x1024",
    }),

  /** 清掉某个视角的图（磁盘文件保留——它可能已注入进已出的片子）。 */
  clearSceneView: (assetId: string, viewKey: string) =>
    fetchTracked(`${BASE}/v2/assets/${assetId}/scene-views/${encodeURIComponent(viewKey)}`,
                 { method: "DELETE", headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw toApiError(r.status, await r.text().catch(() => ""));
        return r.json() as Promise<{ ok: boolean }>;
      }),

  /** 把已有视角图拼成美术设定板（服务端 PIL 拼图，不花生图钱）。
   *  ⚠️ 设定板**只给人看**：它带格子线与中文标注，当参考图会被模型抄进画面，
   *  所以它只存 `board_url`，注入链路从不读它。 */
  buildSceneBoard: (assetId: string) =>
    post<{ ok: boolean; board_url: string }>(`/v2/assets/${assetId}/board`, {}),

  /** 全片影调档案 + 词表（词表由后端 `look_profile.AXES` 给）。 */
  projectLook: (projectId: string) =>
    get<ProjectLookOut>(`/v2/projects/${projectId}/look`),

  /** 手改影调档案（整体覆盖，标 confirmed，此后自动流程不再覆盖）。
   *  ⚠️ 改影调不会重画任何已生成的图，只影响此后新生成的。 */
  saveProjectLook: (projectId: string, axes: Record<string, string>, extra: string) =>
    fetchTracked(`${BASE}/v2/projects/${projectId}/look`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ axes, extra }),
    }).then(async (r) => {
      if (!r.ok) throw toApiError(r.status, await r.text().catch(() => ""));
      return r.json() as Promise<{ ok: boolean; look: ProjectLook; phrase: string }>;
    }),

  /** 按剧本重判一套影调。与形象档案同理：审美判断，只由用户显式触发。 */
  regenerateProjectLook: (projectId: string) =>
    post<{ ok: boolean; look: ProjectLook; phrase: string }>(
      `/v2/projects/${projectId}/look/regenerate`, {}),

  /** 视觉体检：核验"人物图里没有场景 / 场景图里没有人 / 标注是否到位"。
   *  判不合格**只标记不删图**——判定本身会出错，自动删图等于让一个不可靠的
   *  判断销毁用户资产。重画哪张由用户决定。 */
  qcAsset: (assetId: string, opts?: { viewKeys?: string[];
                                      expectThreeView?: boolean;
                                      expectNameLabel?: boolean }) =>
    post<AssetQcOut>(`/v2/assets/${assetId}/qc`, {
      view_keys: opts?.viewKeys ?? [],
      expect_three_view: opts?.expectThreeView ?? true,
      expect_name_label: opts?.expectNameLabel ?? true,
    }),

  /** 按 (kind,name) 换图/换音色/改造型描述（拖资产卡到场景轨段=替换参考图；无行则建） */
  upsertAssetImage: (projectId: string, kind: string, name: string,
                     imageUrl?: string, voiceUrl?: string, prompt?: string,
                     /** `clearPrompt` = 换成用户自己上传的图，连带清空旧造型描述，
                      *  理由同 `patchStage` 的 `clear_description`。 */
                     opts?: { clearPrompt?: boolean }) =>
    post<AssetInfo>("/v2/assets/upsert-image", {
      project_id: projectId, kind, name,
      image_url: imageUrl ?? null, voice_url: voiceUrl ?? null,
      prompt: prompt ?? null,
      clear_prompt: opts?.clearPrompt ?? null,
    }),

  /** 看图写一段造型/场景描述（资产弹窗的「AI 看图补写」按钮）。
   *
   *  ⚠️ **不落库**：结果回给输入框，由用户过目/改完失焦才存。
   *  这是视觉反推的唯一入口——它以前是挂在换图链路上自动跑的，一次 ~8s 且
   *  期间弹窗不许关闭，把"上传一张图"拖成几十秒的整页锁死（2026-09-10 摘除）。
   *
   *  失败会抛（后端回 502）：手动点的按钮静默返回空 = 按钮坏了。 */
  describeImage: (imageUrl: string, kind: "character" | "location" = "character") =>
    post<{ description: string }>("/v2/assets/describe-image",
      { image_url: imageUrl, kind }),

  /** 把 /fw/media/... 相对地址补全为可下载完整地址（host 取自 BASE，不硬编码）
   *
   * ⚠️ 必须用完整 BASE 而不是 BASE.origin：正式版客户端的 BASE 是
   * `…:9080/fwp`，只取 origin 会拼出 `…:9080/fw/media/…` —— 那条 nginx
   * 路由指向 dev 后端(8002)，而正式版的文件在 prod 数据目录，必 404。
   * 库里的前缀恒为 `/fw`（后端 media.py 写死，与环境无关），故先剥掉再拼。
   */
  mediaUrl: (u: string) =>
    u.startsWith("http") ? u
      : `${BASE.replace(/\/$/, "")}${u.replace(/^\/fw(?=\/)/, "")}`,

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