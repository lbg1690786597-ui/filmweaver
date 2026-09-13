/**
 * describeTimeline.ts — 给 Agent 的**时间轴语义快照**（批次 E2，PLAN §2.5.3 配套一）
 *
 * ## 为什么不能直接把 `detail` 丢给模型
 *
 * `ProjectDetail` 是**给界面**准备的结构：一个 800 镜的项目 `JSON.stringify`
 * 出来是几 MB 的裸 JSON，里面 90% 的字段（每个镜头的 `video_url`、`thumb_url`、
 * `ref_overrides`、`profile_override`、`transform_meta`…）对"决定下一步改什么"
 * 毫无用处，却会把上下文吃光、把真正要看的东西挤到看不见的地方。
 *
 * 这里做的是**反向操作**：只保留"要下指令就必须知道"的那几列，
 * 且带上**稳定身份**（`shot.id`）—— 模型后面所有命令都靠这个 id 定位。
 *
 * ## 三条设计约束
 *
 * **① 分页是必须的，不是优化。** 实测 dev 库单项目最多 2000+ 镜。
 *    全量返回一次就超上下文，模型看到的是被截断的 JSON（那比不给更危险：
 *    它会基于截断的数据"推理"出不存在的镜头）。所以默认一页 50，
 *    并在页脚给出**下一跳怎么取**。
 *
 * **② 只读，不取数。** 本模块是**纯视图**：吃一个 `TimelineSource`，
 *    吐一个 `TimelinePage`。它自己不 fetch —— 那样才能被 `verify-agent.ts`
 *    在 node 下用手造的数据跑一遍（`api.ts` import 了 `import.meta.env`，
 *    node 下取不到，任何间接 import 它的模块都跑不了）。
 *
 * **③ `order` 只做展示，不做定位。** 页面上写 `#12` 是给人和模型读的，
 *    但**每一条命令要传的都是 `id`**（理由见 `lib/command.ts` 文件头：
 *    order 是全项目最热的可变值，拿它当身份在重排后必然指错）。
 *    页脚那句提醒是刻意写的 —— 模型抄 id 比抄 order 容易抄错，
 *    与其指望它自觉，不如在每个可能被抄的地方标清楚。
 */

/** 本模块只读这几个字段（结构化子集）。**不要**改成 `ShotInfo` ——
 *  那会把 `api.ts` 的依赖链拖进来，node 下就跑不动了。 */
export interface TimelineShotView {
  id: string;
  order: number;
  episode?: number;
  duration_sec?: number | null;
  disabled?: boolean;
  status?: string;
  script_ref?: string;
  characters?: string[];
  location?: string | null;
  gen_prompt?: string | null;
  stale?: boolean;
  version_count?: number;
  is_special?: boolean;
  special_name?: string | null;
}

export interface TimelineSource {
  id?: string;
  title?: string;
  base_aspect?: string;
  shots: readonly TimelineShotView[];
}

export interface DescribeOptions {
  /** 只看某一集（`episode` 字段）。省略 = 全项目按 offset 分页 */
  episode?: number;
  offset?: number;
  limit?: number;
  /** 是否带上完整提示词。默认关 —— 提示词很长，整页带上会把要改的东西挤没 */
  includePrompt?: boolean;
  /** 提示词截断长度（`includePrompt` 为 false 时的摘要长度） */
  promptPreview?: number;
}

export interface TimelineRow {
  id: string;
  order: number;
  episode?: number;
  /** 生成用的时长文本，如 `3.0s`；未知时是 `?` */
  duration: string;
  /** 启停：停用的镜头在导出/生成时会被跳过，模型**必须**能看到这一位 */
  disabled: boolean;
  status: string;
  /** 场景（优先归一名，退回原名） */
  scene: string | null;
  characters: string[];
  /** 剧本对应句（已截断），模型据此判断"要改的是哪一段" */
  scriptRef: string;
  prompt: string;
  /** 有多个历史版本时可回退 —— 模型看到它才会想到"回到上一版"这条路 */
  hasVersions: boolean;
  stale: boolean;
  isSpecial: boolean;
  specialName: string | null;
}

export interface TimelinePage {
  projectId: string | null;
  title: string | null;
  baseAspect: string | null;
  /** **过筛之后**的总数（传了 episode 就是这一集的镜头数） */
  total: number;
  offset: number;
  limit: number;
  rows: TimelineRow[];
  /** 还有下一页时是下一页的 offset，否则 null */
  nextOffset: number | null;
  /** 这一页里被停用的镜头数 —— 模型最容易忽略"用户已经关掉了它"这件事 */
  disabledCount: number;
  /** 这一页里待重做（stale）的镜头数 */
  staleCount: number;
}

const DEFAULT_LIMIT = 50;
/** 单页上限。**不是性能考虑，是上下文考虑** —— 一页 200 条已经很长了，
 *  再多模型就开始丢前面的内容。 */
export const MAX_LIMIT = 200;
const DEFAULT_PROMPT_PREVIEW = 60;
const SCRIPT_REF_PREVIEW = 80;

/** 折行/空白压成单空格。提示词与剧本句里常有换行，直接拼进一行会把
 *  "一行一镜"的结构冲散，模型就对不上号了。 */
function oneLine(s: string | null | undefined, max: number): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function describeTimeline(
  src: TimelineSource,
  opts: DescribeOptions = {},
): TimelinePage {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const includePrompt = opts.includePrompt === true;
  const preview = Math.max(8, opts.promptPreview ?? DEFAULT_PROMPT_PREVIEW);

  const source = opts.episode === undefined
    ? src.shots
    : src.shots.filter((s) => s.episode === opts.episode);

  // 排序：以 `order` 为准（全项目连续编号）。理论上 shots 已是这个顺序，
  // 但**不假设** —— 分页的正确性建立在这个顺序上，一旦源数据乱序，
  // 翻页就会漏镜头或重复，而且错得很安静。
  const sorted = [...source].sort((a, b) => a.order - b.order);
  const slice = sorted.slice(offset, offset + limit);

  const rows: TimelineRow[] = slice.map((s) => ({
    id: s.id,
    order: s.order,
    episode: s.episode,
    duration:
      typeof s.duration_sec === "number" && s.duration_sec > 0
        ? `${s.duration_sec.toFixed(1)}s`
        : "?",
    disabled: s.disabled === true,
    status: s.status ?? "?",
    // ⚠️ 这里读的是 `location`，不是 `location_canonical`：给模型看的是
    // **这一镜剧本里的写法**。要拿去做资产比对的是归一名，但那是 dispatch
    // 的事，不在快照的职责里。
    scene: s.location ?? null,
    characters: s.characters ?? [],
    scriptRef: oneLine(s.script_ref, SCRIPT_REF_PREVIEW),
    prompt: includePrompt
      ? (s.gen_prompt ?? "")
      : oneLine(s.gen_prompt, preview),
    hasVersions: (s.version_count ?? 0) > 1,
    stale: s.stale === true,
    isSpecial: s.is_special === true,
    specialName: s.special_name ?? null,
  }));

  const nextOffset = offset + limit < sorted.length ? offset + limit : null;

  return {
    projectId: src.id ?? null,
    title: src.title ?? null,
    baseAspect: src.base_aspect ?? null,
    total: sorted.length,
    offset,
    limit,
    rows,
    nextOffset,
    disabledCount: rows.filter((r) => r.disabled).length,
    staleCount: rows.filter((r) => r.stale).length,
  };
}

/**
 * 渲染成**给模型读的文本**。
 *
 * 为什么不是直接给 JSON：后端 LLM 通道是纯文本补全（见 `capability.ts` 的
 * `exportCapabilities` 注释），而且实测同一份数据渲染成行式文本比 JSON
 * 短三成左右 —— 省下的都是能多看几个镜头的上下文。
 *
 * ⚠️ 每行开头就是 `id`（不是 order）：模型抄错 id 会当场报错，
 * 抄错 order 会**改错镜头且不报错**。把容易抄错的放前面、且页脚明说。
 */
export function toPromptText(page: TimelinePage): string {
  const head = [
    `项目：${page.title ?? "(未命名)"}${page.projectId ? `（id=${page.projectId}）` : ""}`,
    `画幅：${page.baseAspect ?? "?"}  这一页范围：第 ${page.offset + 1}–${page.offset + page.rows.length} 个，共 ${page.total} 个`,
  ];
  const flags: string[] = [];
  if (page.disabledCount > 0) flags.push(`其中 ${page.disabledCount} 个已停用（导出时会跳过）`);
  if (page.staleCount > 0) flags.push(`${page.staleCount} 个待重做`);
  if (flags.length) head.push(`⚠️ ${flags.join("；")}`);
  head.push("");
  head.push("id | #order | 时长 | 状态 | 场景 | 角色 | 剧本句 | 提示词");

  const lines = page.rows.map((r) => {
    const marks: string[] = [];
    if (r.disabled) marks.push("停用");
    if (r.stale) marks.push("待重做");
    if (r.hasVersions) marks.push("有历史版本");
    if (r.isSpecial) marks.push(`外部素材${r.specialName ? `:${r.specialName}` : ""}`);
    const status = marks.length ? `${r.status}(${marks.join(",")})` : r.status;
    return [
      r.id,
      `#${r.order}`,
      r.duration,
      status,
      r.scene ?? "-",
      r.characters.length ? r.characters.join(",") : "-",
      r.scriptRef || "-",
      r.prompt || "-",
    ].join(" | ");
  });

  const tail: string[] = [""];
  if (page.nextOffset !== null) {
    tail.push(`▶ 还有下一页：用 offset=${page.nextOffset} 再调一次 describe_timeline。`);
  } else {
    tail.push("▶ 已经是最后一页。");
  }
  tail.push(
    "⚠️ 下命令时**一律用第一列的 id**（那串 uuid），不要用 #order —— " +
    "order 会随着增删/重排变化，用它定位会改错镜头。",
  );
  if (!page.rows.some((r) => r.prompt.length > 60)) {
    tail.push("（提示词为摘要。要看全文请带 include_prompt=true 重新调一次。）");
  }
  return [...head, ...lines, ...tail].join("\n");
}
