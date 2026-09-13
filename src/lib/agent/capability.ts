/**
 * capability.ts — 给 AI Agent 的**能力表**（批次 E5，PLAN §2.5.3 配套二 / §14 附录 D）
 *
 * ## 这张表是什么
 *
 * 一份**纯数据**清单：Agent 能做哪些事、每件事要传什么参数、要花多少钱。
 * 它有三个读者，三者的需求互相冲突，这里按优先级排：
 *
 *   1. **模型**（最高优先）：要 `id` + `desc` + `params` schema，且必须能被
 *      `JSON.stringify` 原样塞进提示词。**表里不能有函数** —— 函数会被
 *      `JSON.stringify` 静默丢掉（编成一个 `{}`），而丢掉的东西没人会发现。
 *   2. **执行器**（`dispatch.ts`）：要一个 `id → 实际调用` 的映射。
 *      这个映射**不在这张表里**，它在 `dispatch.ts` —— 表是"说明书"，
 *      执行器是"手"。两者分开，才能让"说明书里有的"和"手能做的"对不上时
 *      被验证脚本抓出来（`verify-agent.ts` 逐条比对）。
 *   3. **用户**：要看得懂的确认文案（`confirmText`）。生成类能力点下去会
 *      花钱，确认框上写的必须是"要花什么"而不是参数名。
 *
 * ## 🔴 两条硬约束（§14 附录 D 末尾，写在这里防止后人在别处放宽）
 *
 * **① `patchShotBreakdown` 不在这张表里，而且是刻意的。**
 *    它**没有逆操作**（后端只置 `stale`，不存旧值），而 AI 恰好会大量改拆解。
 *    在 §2.2 的反向命令补齐之前给了 Agent，等于给了一个"改错了撤不回来"
 *    的能力。「没在里面」不是漏写 —— `verify-agent.ts` 会**断言它不在**，
 *    防止后来"顺手补全"。
 *
 * **② 任何生成能力都必须 `costly: true`。**
 *    生成花的是用户的真金白银。`costly` 不是提示，是 UI 层的**强制确认开关**：
 *    `needsConfirm(cap)` 为真时，调用方必须先弹确认框拿到用户同意。
 *    `verify-agent.ts` 会遍历全表，断言"凡 kind 为生成类的能力都带 costly"。
 *
 * ## 为什么 `desc` 与 `label` 分开写
 *
 * `CommandDraft.label` 是给人看的（「镜头 #3 移到 #5」，越短越好）；
 * 这里的 `desc` 是给模型看的 —— 要说清**什么时候该用、边界在哪、传错会怎样**。
 * 一个字符串同时服务两种读者，最后一定两边都不满意。
 *
 * ## ⚠️ 未知关键字会静默失效
 *
 * 本表用的 schema 方言是 `lib/agent/schema.ts` 里的**自研子集**（不引 ajv/zod，
 * 理由见该文件头）。它的宽容之处是未知关键字**不报错**——于是 `maximum`
 * 写成 `max` 这种笔误不会当场炸，只会安静地不生效，模型于是一直传超范围的值。
 * 所以 `validateArgs` 之外还要有 `unknownKeywords()` 走一遍全表，
 * 由 `verify-agent.ts` 把未知关键字变成红灯。
 */

import type { JsonSchema } from "./schema";

/** 能力分组。给 UI 分组显示，也给"只读能力不弹确认"这类判断用。 */
export type CapabilityKind =
  | "read"      // 只读：查时间轴、查版本。不落库、不花钱
  | "edit"      // 编辑：改时间轴结构。可撤销
  | "generate"; // 生成：调模型出图/出片/配音。**花钱**

export interface AgentCapability {
  /** 模型调用的函数名。**snake_case**，与 `api.*` 的方法名一一对应 ——
   *  对不上的地方要在 `dispatch.ts` 里显式写适配，不许在这里改名糊过去。 */
  id: string;
  /** 给模型看的一句话。说清"干什么、什么时候用"，不是给用户看的标题 */
  desc: string;
  /** 入参 schema。**必须是纯数据**（理由见文件头） */
  params: JsonSchema;
  kind: CapabilityKind;
  /** 是否花钱。`kind === "generate"` 的**必须**为 true（`verify-agent.ts` 断言） */
  costly?: boolean;
  /** 是否可能造成不可逆的损失（删镜头、覆盖已付费画面）。调用前要额外确认 */
  destructive?: boolean;
  /** 确认框上的文案。`costly` 或 `destructive` 为真时**必须**写 ——
   *  "确认执行吗？"这种空话等于没确认，用户点下去不知道要付什么代价 */
  confirmText?: string;
  /** 对应的 `CommandKind`（编辑类才填）。台账/撤销面板按它归组 */
  commandKind?: "shot" | "asset" | "audio" | "subtitle" | "transform" | "track" | "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// 参数 schema 片段：重复出现的形状提出来，免得 12 处各写一遍、改一处漏十一处
// ─────────────────────────────────────────────────────────────────────────────

const SHOT_ID: JsonSchema = {
  type: "string",
  description: "镜头 id（必填）。取值必须来自 describe_timeline 的返回，不要自己拼",
};

/** 镜内秒。**不是绝对时间轴秒** —— 这两个数在项目里同时存在，模型最容易混。 */
const IN_SHOT_SEC: JsonSchema = {
  type: "number",
  minimum: 0,
  description:
    "镜内秒（从这一镜的**开头**算起），不是时间轴绝对秒。" +
    "例：镜头从第 12 秒开始、想在它内部第 3 秒处切，这里传 3",
};

export const CAPABILITIES: readonly AgentCapability[] = [
  // ── 只读 ──────────────────────────────────────────────────────────────────
  {
    id: "describe_timeline",
    kind: "read",
    desc:
      "读项目时间轴的语义快照（紧凑、分页）。**做任何修改前必须先调它** —— " +
      "所有镜头 id、时长、顺序、提示词都以它的返回为准。" +
      "全项目可能有两千多个镜头，一次只返回一页，靠 next_offset 翻页；" +
      "需要看某一集的全部镜头时传 episode。",
    params: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 id" },
        episode: {
          type: "integer",
          minimum: 1,
          description: "只看某一集。省略 = 从头开始按 offset 分页看全项目",
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "从第几个镜头开始（0 基）。翻页时传上一页返回的 next_offset",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "本页最多返回几个镜头。默认 50，不要一次要几百个",
        },
        include_prompt: {
          type: "boolean",
          default: false,
          description:
            "是否带上每个镜头的完整提示词。**默认关**：提示词很长，" +
            "整页带上会挤掉真正要改的内容。只在确实要改提示词时才开",
        },
      },
      required: ["project_id"],
    },
  },
  {
    id: "shot_versions",
    kind: "read",
    desc:
      "查某个镜头的历史版本（每次重新生成都会存一版，旧版画面不会丢）。" +
      "用户说「回到上一版画面」时用这个查到 version_no，再调 adopt_shot。",
    params: {
      type: "object",
      properties: { shot_id: SHOT_ID },
      required: ["shot_id"],
    },
  },

  // ── 编辑（可撤销） ─────────────────────────────────────────────────────────
  {
    id: "split_shot",
    kind: "edit",
    commandKind: "shot",
    desc:
      "把一个镜头在镜内某一秒切成前后两镜。**切点之后的内容不变，只是多了一行**。" +
      "副作用：后面所有镜头的 order 会 +1。想撤销请调 unsplit_shot。" +
      "⚠️ 若只是想「重做中间几秒」，用 recut_shot，不要用这个。",
    params: {
      type: "object",
      properties: {
        shot_id: SHOT_ID,
        at_sec: {
          ...IN_SHOT_SEC,
          description:
            IN_SHOT_SEC.description + "。切点太靠近两端（小于一秒）后端会拒绝",
        },
      },
      required: ["shot_id", "at_sec"],
    },
  },
  {
    id: "unsplit_shot",
    kind: "edit",
    commandKind: "shot",
    desc:
      "撤销一次 split_shot，把后半段合回前半段（受版本数、时长下限限制）。" +
      "⚠️ 后半段被单独重新生成过、或手改过时长时后端会返回 409 —— " +
      "此时**不要重试**，把返回的文案交给用户，让他自己决定。",
    params: {
      type: "object",
      properties: {
        head_shot_id: { ...SHOT_ID, description: "前半段（前一次 split 的产物）的镜头 id" },
        tail_shot_id: { ...SHOT_ID, description: "后半段的镜头 id" },
      },
      required: ["head_shot_id", "tail_shot_id"],
    },
  },
  {
    id: "recut_shot",
    kind: "edit",
    commandKind: "shot",
    desc:
      "把一镜划成 A|B|C 三段，**只有中间 B 段需要重新生成**（局部重生成）。" +
      "这是「中间几秒单独重做」的唯一正确做法 —— 用 split_shot 会变成" +
      "两次切割 + 手动删段，且中间段的边界对不上。" +
      "副作用：这一镜变成三行、后面 order +2。想撤销请调 undo_recut_shot。" +
      "⚠️ 会改变 order，调用后必须重新 describe_timeline 再继续操作。",
    params: {
      type: "object",
      properties: {
        shot_id: SHOT_ID,
        cut_a: { ...IN_SHOT_SEC, description: "第一刀（B 段的起点）在镜内的秒数" },
        cut_b: { ...IN_SHOT_SEC, description: "第二刀（B 段的终点）在镜内的秒数" },
      },
      required: ["shot_id", "cut_a", "cut_b"],
    },
  },
  {
    id: "undo_recut_shot",
    kind: "edit",
    commandKind: "shot",
    desc:
      "撤销一次 recut_shot，把 A|B|C 合回原来那一镜。传的是**中间段**的 id。" +
      "⚠️ 中间段一旦重新生成过就不能撤销（那是已付费的画面），后端返回 409，" +
      "**不要重试**，把文案交给用户。",
    params: {
      type: "object",
      properties: {
        head_shot_id: { ...SHOT_ID, description: "A 段的镜头 id" },
        mid_shot_id: { ...SHOT_ID, description: "B 段（待生成/已生成的那一段）的镜头 id" },
      },
      required: ["head_shot_id", "mid_shot_id"],
    },
  },
  {
    id: "patch_shot_timeline",
    kind: "edit",
    commandKind: "shot",
    desc:
      "改一个镜头的时间轴属性：时长、在项目里的顺序、启用/停用、取片窗口。" +
      "用户口述的「把这个镜头拉长到 5 秒」「把它挪到第 3 位」「这段先别用」都走这里。" +
      "⚠️ 一次调用只改传了的字段，没传的保持原样。" +
      "⚠️ 时长上限是 15 秒（服务端钳制），超过会被静默截断 —— " +
      "如果用户要的超过 15 秒，先说明这个限制，不要默默按 15 传。",
    params: {
      type: "object",
      properties: {
        shot_id: SHOT_ID,
        duration_sec: {
          type: "integer",
          minimum: 1,
          maximum: 15,
          description: "镜头时长（秒）。服务端钳 1–15",
        },
        to_order: {
          type: "integer",
          minimum: 1,
          description:
            "移到项目里的第几位（1 基，全项目连续编号）。" +
            "取值可以用 describe_timeline 返回的 order",
        },
        disabled: {
          type: "boolean",
          description:
            "停用=true（导出时跳过这一镜，但**不删**它，随时能启用回来）。" +
            "用户说「删掉这个 AI 镜头」时应该用停用，不是 delete_shot",
        },
        clip_in_sec: {
          type: "number",
          minimum: 0,
          description: "取片窗口入点（秒，相对素材本身）。只在改外部素材取用时才传",
        },
        clip_dur_sec: {
          type: "number",
          minimum: 0,
          description: "取片窗口长度（秒）。与 clip_in_sec 一起构成 [入点, 入点+长度)",
        },
      },
      required: ["shot_id"],
    },
  },
  {
    id: "patch_shot_prompt",
    kind: "edit",
    commandKind: "transform",
    desc:
      "改写某个镜头的生成提示词。用户说「把提示词改成…」时用。" +
      "⚠️ 改完这一镜会被标记为「需重新生成」，但**不会自动重新生成** —— " +
      "要真的出画面，需要用户另行确认执行 generate_shots。",
    params: {
      type: "object",
      properties: {
        shot_id: SHOT_ID,
        gen_prompt: { type: "string", description: "新的提示词全文（覆盖式，不是追加）" },
      },
      required: ["shot_id", "gen_prompt"],
    },
  },
  {
    id: "reset_shot_prompt",
    kind: "edit",
    commandKind: "transform",
    desc:
      "把手改过的提示词清掉，回到系统按拆解结果生成的那一版。" +
      "用户说「提示词恢复默认」时用。",
    params: {
      type: "object",
      properties: { shot_id: SHOT_ID },
      required: ["shot_id"],
    },
  },
  {
    id: "adopt_shot",
    kind: "edit",
    commandKind: "shot",
    desc:
      "把某个历史版本采纳为当前版本（**旧版画面不丢**，它还在版本表里）。" +
      "用户说「还是上一版好看」时：先 shot_versions 查到 version_no，再调这个。" +
      "⚠️ 采纳会连带把这一镜已有的取片窗口清掉（新画面长度可能和旧的不一样），" +
      "如果这一镜有取片窗口，要在回复里提一句。",
    params: {
      type: "object",
      properties: {
        shot_id: SHOT_ID,
        version_no: {
          type: "integer",
          minimum: 1,
          description: "目标版本号。必须来自 shot_versions 的返回，不要猜",
        },
      },
      required: ["shot_id", "version_no"],
    },
  },
  {
    id: "delete_shot",
    kind: "edit",
    commandKind: "shot",
    destructive: true,
    confirmText: "删除这个外部素材镜头。删掉后无法从本软件恢复，需要重新导入素材。",
    desc:
      "删除一个**外部素材镜头**（自己导入的片头/片尾/实拍）。" +
      "⚠️ **AI 生成的镜头删不掉**，服务端会拒绝 —— 那种情况请改用 " +
      "patch_shot_timeline 的 disabled=true（停用可随时恢复）。" +
      "⚠️ 这是**不可撤销**的：撤销栈里没有它的逆操作。调用前必须让用户确认。",
    params: {
      type: "object",
      properties: { shot_id: SHOT_ID },
      required: ["shot_id"],
    },
  },
  {
    id: "add_special_shot",
    kind: "edit",
    commandKind: "asset",
    desc:
      "把一段外部素材（已上传到素材库的视频）插进镜头轨，做成一个特殊镜头。" +
      "用户说「开头加个 logo」时用。插入后全项目 order 会重排为 1..N。",
    params: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 id" },
        name: { type: "string", description: "这一段的显示名（如「片头」），会出现在时间轴上" },
        video_url: {
          type: "string",
          description: "素材地址。必须来自素材库已有的条目，不要自己构造 URL",
        },
        after_order: {
          type: "integer",
          minimum: 0,
          description: "插到第几镜之后（1 基）。省略或传 0 = 追加到末尾",
        },
        duration_sec: {
          type: "number",
          minimum: 0,
          description: "这一段用素材的第几秒到第几秒由取片窗口决定；这里只给时长。省略 = 用整段",
        },
      },
      required: ["project_id", "name", "video_url"],
    },
  },

  // ── 生成（花钱，必须确认） ─────────────────────────────────────────────────
  {
    id: "generate_shots",
    kind: "generate",
    costly: true,
    confirmText:
      "开始生成画面：按当前提示词为选中的镜头出图/出片，会消耗生成额度。" +
      "生成需要联网并已登录。",
    desc:
      "为指定镜头触发生成（出首帧 / 出视频），产物进入待审区，**不会自动替换现有画面**。" +
      "⚠️ **这一步要花用户的钱**：调用前必须先把「要生成哪几个镜头、大概几个」" +
      "讲清楚并拿到明确同意，不要因为用户说了句「这段不太行」就直接调。" +
      "⚠️ 不传 shot_ids 等于**对全项目未生成/待重做的镜头**触发，代价可能很大 —— " +
      "只有在用户明确说「全部生成」时才省略。",
    params: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 id" },
        shot_ids: {
          type: "array",
          items: { type: "string" },
          description: "要生成的镜头 id 列表。省略 = 全部待生成/待重做的镜头（慎用）",
        },
        model_id: {
          type: "string",
          description:
            "指定生成模型。省略 = 用项目当前设置。" +
            "取值来自项目设置里的可选模型，不要凭印象编模型名",
        },
      },
      required: ["project_id"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────────────────────

/** 按 id 找一条。找不到返回 undefined（**不抛**：模型传错名字时要能回一句人话，
 *  而不是让整个 Agent 循环崩掉）。 */
export function findCapability(id: string): AgentCapability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** 这个能力调用前是否**必须**先拿到用户确认。 */
export function needsConfirm(cap: AgentCapability): boolean {
  return cap.costly === true || cap.destructive === true;
}

/** 只读能力（不落库、不花钱，可以放心让 Agent 连调）。 */
export function readonlySkills(): readonly AgentCapability[] {
  return CAPABILITIES.filter((c) => c.kind === "read");
}

/** 可写能力（会改用户的项目，全部要进撤销栈）。 */
export function writableCapabilities(): readonly AgentCapability[] {
  return CAPABILITIES.filter((c) => c.kind !== "read");
}

/**
 * 导出成**喂给模型的形状**（纯数据、无函数，可直接 `JSON.stringify`）。
 *
 * ⚠️ 后端目前的 LLM 通道（`app/providers/llm.py`）是**纯文本补全**，
 * 没有原生 `tools[]` 支持，所以这里产出的不是 OpenAI/Anthropic 的
 * tool 定义，而是"标题 + 参数 JSON 形状"的自描述文本，由 `prompt.ts`
 * 拼进系统提示词，模型的回复按 JSON 命令协议解析（见 `protocol.ts`）。
 * 哪天后端支持原生 function calling，改的是**这一个函数**，
 * 能力表本身不用动 —— 这正是把"说明书"和"调用格式"分开的收益。
 */
export function exportCapabilities(
  caps: readonly AgentCapability[] = CAPABILITIES,
): { id: string; desc: string; params: JsonSchema; costly: boolean }[] {
  return caps.map((c) => ({
    id: c.id,
    desc: c.desc,
    params: c.params,
    costly: c.costly === true,
  }));
}
