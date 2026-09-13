/**
 * artifact.ts — 生成产物的**具名 schema + 版本号**（D1）与兼容校验（D2）。
 *
 * ## 为什么要有这个文件
 *
 * `jobs.payload` / `jobs.result` 一直是自由 JSON：372 行历史任务、709 份 blob，
 * 里面有什么全凭写它的那段代码记得。后果不是"不好看"，而是三件具体的事：
 *
 * 1. **同一个概念有四种键名**。模型选择在实测里出现过
 *    `model_id` / `image_model` / `video_model` / `llm_model` 四种写法
 *    （见 PLAN §11.2）。命令层只有一套 `params`，它得先把这四种归一 ——
 *    否则 Agent 想"换模型重试"就得知道"这次是生图还是生视频"才敢挑键名。
 * 2. **"一次产出什么"没有名字**，于是每加一个能力就多一处 `if (r.foo)`
 *    散落在消费点里（`useAudioTrack.doneMsg` / `useProdJobs.warnFrameIssues`
 *    现在各自手写 `JSON.parse` + 手写字段假设）。
 * 3. **Agent 不知道"能产出什么"**（E5 的能力表要拿它当输入）。
 *
 * ## 三条不可动摇的约束
 *
 * ① **不改后端字段名。** 那四种模型键名已经写进 372 行历史 blob，
 *    改名等于让所有在跑的任务读不到参数。归一在**适配层**做（本文件），
 *    历史 blob 保持原样。
 * ② **旧 blob 不满足 schema 也不许报错**（D2 明确要求"不破坏旧数据，只新增约束"）。
 *    所以本文件的校验只**产出诊断**（`ArtifactCheck`），永不 throw、永不拒收。
 *    调用方拿到的永远是**尽力归一后的对象**——`null` 只表示"连 JSON 都不是"。
 * ③ **`compose` 不建模。** 该 kind 已于 2026-08-30 下线，仅存 5 行历史数据。
 *    放进表里等于给后来者一个"这个还在用"的错觉。遇到它按未知 kind 处理。
 */

/** 产物 schema 的版本号。**加字段不升版、改语义才升版。**
 *
 *  为什么版本号是"行为"而不是"元数据"：旧 blob 没有这个字段，
 *  归一后的对象必须能回答"我按哪一版理解它"。统一给 `1`（首版），
 *  历史 blob 与今天新写的 blob 在这一版上语义一致 —— 因为本版是从
 *  **实测的 372 行**归纳出来的，不是照代码猜的。 */
export const ARTIFACT_SCHEMA_VERSION = 1;

/** 12 种 job kind → artifact 名。
 *
 *  ⛔ `compose` 刻意不在表里（已下线）。 */
export const KIND_ARTIFACT: Record<string, string> = {
  shot_videos: "ShotVideoArtifact",
  one_click_film: "FilmArtifact",
  breakdown_all: "EpisodeBreakdownArtifact",
  asset_batch: "AssetBatchArtifact",
  asset_candidates: "AssetCandidateArtifact",
  first_frames: "FirstFrameArtifact",
  first_frame_pipeline: "FirstFramePipelineArtifact",
  tts_batch: "TtsArtifact",
  reprompt: "RepromptArtifact",
  costume_scan: "CostumeScanArtifact",
  auto_subtitles: "AutoSubtitleArtifact",
};

/** 入参侧（`jobs.payload`）的模型键名归一。**四种写法指同一个概念。**
 *
 *  ⚠️ 归一的方向是"读的时候认四种"，**不是"写的时候统一成一种"** ——
 *  写侧统一会让历史 blob 与在跑的任务读不到参数（约束 ①）。
 *  新写的 payload 沿用各 kind 现有的键名即可，本表只保证**读侧**一致。 */
export const MODEL_KEYS = ["model_id", "image_model", "video_model", "llm_model"] as const;
export type ModelKey = typeof MODEL_KEYS[number];

/** 从任意 payload 里取出"选了哪个模型"，四种键名都认。
 *
 *  优先级按**具体程度**排：`image_model` / `video_model` 比 `model_id` 说得更细，
 *  同时出现时取更细的那个（实践中不会同时出现，但真出现时"更具体"是唯一合理的解释）。
 *  全空返回 `null`（= 沿用项目/服务端默认），**不是空串** —— 空串在下游会被
 *  当成"显式选了空模型"而跳过默认值兜底。 */
export function pickModel(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null;
  for (const k of ["image_model", "video_model", "llm_model", "model_id"] as const) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** 归一后的模型选择：**既给出值也给出键名**。
 *
 *  只给值不够——回写 payload 时得知道该用哪个键（`image_model` 还是 `video_model`），
 *  否则"改个模型重试"会把生图任务的模型写进视频键，静默不生效。
 *  给 `key` 就是把这个信息留在结果里，而不是让调用方再猜一次。 */
export interface ModelChoice { value: string; key: ModelKey }
export function pickModelChoice(
  obj: Record<string, unknown> | null | undefined,
): ModelChoice | null {
  if (!obj) return null;
  for (const k of ["image_model", "video_model", "llm_model", "model_id"] as const) {
    const v = obj[k];
    if (typeof v === "string" && v) return { value: v, key: k };
  }
  return null;
}

// ---------------------------------------------------------------------------
// D2：校验（**只诊断，不拒收**）
// ---------------------------------------------------------------------------

export type ArtifactIssueLevel = "warn" | "info";

export interface ArtifactIssue {
  /** 出问题的字段路径，如 `shots[3].video_url`；顶层问题用 `""` */
  path: string;
  level: ArtifactIssueLevel;
  /** 给开发者看的说明（会进 console / 任务中心，不直接甩给用户） */
  msg: string;
}

export interface ArtifactCheck {
  kind: string;
  /** 认得出的 artifact 名；未知 kind 为 null */
  artifact: string | null;
  version: number;
  /** 顶层期望是数组但实际不是（`asset_batch` 是唯一的裸数组 kind） */
  issues: ArtifactIssue[];
  /** JSON 都解析不了 —— **唯一**算"坏"的情形 */
  unparsable: boolean;
}

/** 每种 kind 里"必须有"的字段（实测出现率 ≈ 100% 的才放进来）。
 *
 *  ⚠️ 这张表刻意**短**。放多了会让校验变成噪音：一个字段出现在 80% 的
 *  历史结果里，说明它本来就是可选的（比如有 0 段旁白时 `clips` 就是空数组
 *  而不是不存在，但"不存在"也完全合理）。校验的价值在于**发现形态级错误**
 *  （本该是数组的变成了对象、本该有的顶层键整个丢了），不在于逐字段完备。 */
const REQUIRED_FIELDS: Record<string, { array?: string[]; any?: string[] }> = {
  ShotVideoArtifact: { array: ["shots"] },
  FilmArtifact: { array: ["shots"], any: ["film"] },
  EpisodeBreakdownArtifact: { array: ["episodes"] },
  AssetBatchArtifact: { array: [] },            // 顶层就是数组，单独判
  AssetCandidateArtifact: { array: ["urls"], any: ["target"] },
  FirstFrameArtifact: { array: ["frames"] },
  FirstFramePipelineArtifact: { array: [], any: ["stage"] },
  TtsArtifact: { array: ["clips"] },
  RepromptArtifact: { array: ["shots"] },
  CostumeScanArtifact: { any: ["created"] },
  AutoSubtitleArtifact: { any: ["created", "total"] },
};

/** 顶层就是裸数组的 kind。目前只有 `asset_batch` 一种（实测确认）。 */
export const BARE_ARRAY_KINDS = new Set(["asset_batch"]);

/**
 * 解析 + 校验 `jobs.result`。**永不 throw。**
 *
 * 返回 `{ value, check }`：
 *   · `value` 是尽力归一后的对象（解析不了时是 `null`）；**调用方永远用这个**，
 *     不要自己再去 `JSON.parse` —— 那等于把"四种模型键名"的知识又抄一份到调用点。
 *   · `check` 是诊断。`check.issues` 非空**不代表**这个结果不能用，
 *     只代表写它的那段代码与 schema 有出入（历史 blob 尤其容易有）。
 *
 * ⚠️ **不要把这个函数改成"不合法就返回 null"。** 旧 blob 不满足新 schema
 * 是必然的（schema 是从它们归纳出来的，归纳丢掉的边角正是这些），
 * 拒收等于让历史任务在任务中心里全部变成"结果异常"。D2 的要求原文是
 * "不破坏旧数据，只新增约束"。
 */
export function readArtifact(
  result: string | null | undefined,
  kind: string,
): { value: unknown; check: ArtifactCheck } {
  const artifact = KIND_ARTIFACT[kind] ?? null;
  const base: ArtifactCheck = {
    kind, artifact, version: ARTIFACT_SCHEMA_VERSION, issues: [], unparsable: false,
  };
  if (result == null || result === "") {
    // 空结果不是"坏"，是"还没写"（任务在跑 / 老任务没落 result）
    base.issues.push({ path: "", level: "info", msg: "result 为空" });
    return { value: null, check: base };
  }
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    base.unparsable = true;
    base.issues.push({ path: "", level: "warn", msg: "result 不是合法 JSON" });
    return { value: null, check: base };
  }
  if (!artifact) {
    base.issues.push({
      path: "", level: "info",
      // compose 走的就是这一支：它在 KIND_ARTIFACT 里没有条目
      msg: `未知 kind「${kind}」，按自由 JSON 处理（未建模）`,
    });
    return { value, check: base };
  }

  if (BARE_ARRAY_KINDS.has(kind)) {
    if (!Array.isArray(value)) {
      base.issues.push({
        path: "", level: "warn",
        msg: `${artifact} 顶层应当是数组（实测如此），实际是 ${typeof value}`,
      });
    }
    return { value, check: base };
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    base.issues.push({
      path: "", level: "warn",
      msg: `${artifact} 顶层应当是对象，实际是 ${Array.isArray(value) ? "数组" : typeof value}`,
    });
    return { value, check: base };
  }

  const obj = value as Record<string, unknown>;
  const spec = REQUIRED_FIELDS[artifact];
  for (const f of spec?.array ?? []) {
    const v = obj[f];
    if (v === undefined) {
      base.issues.push({ path: f, level: "warn", msg: `缺少数组字段 ${f}` });
    } else if (!Array.isArray(v)) {
      base.issues.push({
        path: f, level: "warn", msg: `${f} 应当是数组，实际是 ${typeof v}`,
      });
    }
  }
  for (const f of spec?.any ?? []) {
    if (obj[f] === undefined) {
      base.issues.push({ path: f, level: "info", msg: `缺少字段 ${f}` });
    }
  }
  // `stub`：实测里 shot_videos 的"没真生成"标记。它不是错误，但**必须被看见**——
  // 一份 stub 结果被当成真结果用，用户会看到"生成成功但没视频"。
  if (obj.stub === true) {
    base.issues.push({ path: "stub", level: "info", msg: "这是占位结果（stub），不是真产物" });
  }
  return { value, check: base };
}

/** 一批诊断里挑出"真的说明写侧有问题"的那些（丢掉 info 与空 result）。
 *  任务中心用它决定要不要给一个 ⚠️ 角标 —— 否则每个没落 result 的任务都会带上角标。 */
export function hardIssues(check: ArtifactCheck): ArtifactIssue[] {
  return check.issues.filter((i) => i.level === "warn");
}
