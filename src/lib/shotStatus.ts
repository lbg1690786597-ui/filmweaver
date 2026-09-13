/**
 * shotStatus — `shot.status` 与 `job.status` 的语义边界（**唯一定义处**）
 *
 * ## 为什么要有这个文件（这不是文档，是防漂移的锚）
 *
 * 这两套状态机是各写各的、各自演化出来的：
 *
 *   · `shot.status` —— `db.py` 的 `Shot.status`，值是
 *     `pending / prompting / generating / review / adopted / failed`
 *   · `job.status`  —— `db.py` 的 `Job.status`，值是
 *     `pending / running / done / failed / cancelled`
 *
 * 它们**长相相似，说的却是两件事**。最典型的坑是两边都有 `pending`，
 * 但 `shot.pending` 是「这条镜头还没内容」（一个可能持续几周的静止状态），
 * 而 `job.pending` 是「这个任务排队中」（几秒钟的过渡态）。用户在界面上
 * 同时看到这两个词，就会问出「它到底在生成还是没在生成」这种没人能回答的问题。
 *
 * 更早的一次真实误判：查库发现 6,796 条 `shot.status='pending'`，
 * 第一反应是「生成中断没回写、全是僵尸」。**实测不是**——6796 条里 4,584 条
 * `prompt_state` 为 NULL（这条镜头从建项目起就没轮到过）、2,210 条有提示词
 * 但没出片、只有 2 条是「有片子却还挂着 pending」的**真·不一致**。
 * 也就是说 `pending` 是**正常的静止态**，不是异常。这个结论一旦丢了，
 * 后人会照着「僵尸」的假设去写一批"清理 pending"的代码，把正常数据删掉。
 *
 * ## 边界（一句话版）
 *
 *   **`shot.status` 说"这条镜头的内容处于什么状态"；`job.status` 说"这次生成动作跑到哪了"。**
 *
 * 由此推出一条必须遵守的规则（批次 A1 的核心结论）：
 *
 *   > **`shot.status` 不得用来表示"正在生成"。**
 *   > "正在生成"永远是 `job.status` 的事。
 *
 * ## 这条规则为什么值钱
 *
 * 因为一条镜头可以**同时在**两套状态里，而且两套状态可以看起来矛盾却都正确：
 *
 * ```
 * shot.status = "adopted"   ← 旧成片还在、还能用、还能导出
 * job.status  = "running"   ← 正在重生成一版新的
 * ```
 *
 * 旧代码把这两件事混在一根轴上，后果就是用户提的第二个需求：
 * 「重新生成一个片段时，旧的片段会被覆盖（等同于丢失）」——
 * 因为「重新生成」这个动作把 `shot.status` 从 `adopted` 推回了「生成中」，
 * **在状态层面先把旧内容宣布作废了**。
 *
 * 只要守住这条边界，旧内容在 `shot.status` 层面从未被标记为"没了"，
 * 新的生成任务只是挂在它旁边 —— 「重生成不丢旧内容」就是白送的，
 * 不需要额外机制。这也是 §2.4 要给产物建 artifact 模型的前提。
 *
 * ## 与 `prompt_state` 的关系（第三根轴，别混进来）
 *
 * `shot.prompt_state`（`draft / aligned / sent / manual`）说的是
 * **提示词这一稿是怎么来的**，与内容状态无关，与任务状态也无关。
 * 一根轴上不要塞两件事：一条 `adopted` 的镜头，它的 `prompt_state`
 * 可以是 `manual`（用户手填过词），这**不是**矛盾。
 *
 * ## 与 Jellyfish 的对照
 *
 * `Jellyfish`（Apache-2.0，同赛道 AI 短剧产线）明确把 `shot.status`
 * （pending/ready，只表示"信息提取确认完成"，**不表示在生成**）与
 * `GenerationTask`（pending/running/succeeded/failed）拆成两套，
 * 并在文档里写清语义。我们**已经是同一个形状**，只是从没把那条边界写下来。
 * 本文件就是把那句话补上。
 *
 * 参考：`docs/PLAN-编辑核心架构收敛.md` §2.3
 */

// ────────────────────────────────────────────────────────────────────────────
// 类型：两套状态机各自的值域
// ────────────────────────────────────────────────────────────────────────────

/**
 * 镜头**内容**的状态。持久化在 `shots.status`。
 *
 * ⚠️ 这里**故意不含** `"generating"` 这类"正在生成"的值作为**语义**——
 * 尽管后端的 `_set_shot_status(sid, "generating")` 确实会写这个字符串。
 * 我们的处理方式是「**承认它是遗留写法，但不把它当成内容状态来读**」：
 * 见下面 `IN_FLIGHT_SHOT_STATUSES` 与 `cameraReady`。改写后端写入路径
 * 属于批次 B/C 的工作（有行为变更风险），A 批只负责把判据立在这里，
 * 让新代码从第一天起就按正确语义写。
 */
export type ShotContentStatus =
  /** 这条镜头**还没有内容**。这是正常的静止态，不是异常——见文件头 6796 条的实测。 */
  | "pending"
  /** 生成过程中后端仍会写下这些中间值。**它们是"某次动作进行中"的残留**，
   *  语义上属于 `job`，见 `IN_FLIGHT_SHOT_STATUSES`。 */
  | "prompting"
  | "generating"
  /** 有新产出等待用户确认（候选）。 */
  | "review"
  /** 有内容且已采用——**包括"正在被重生成"的镜头**，旧的成片仍然是 adopted。 */
  | "adopted"
  /** 内容产出失败。失败原因在 `fail_reason` / `fail_kind`。 */
  | "failed";

/** 一次**生成动作**跑到哪了。持久化在 `jobs.status`。 */
export type JobRunStatus =
  /** 排队中（几秒钟的过渡态，**不是**"没有内容"）。 */
  | "pending"
  /** 正在跑。 */
  | "running"
  /** 跑完了。 */
  | "done"
  /** 跑失败了。 */
  | "failed"
  /** 被取消（用户主动，或父任务中止）。 */
  | "cancelled";

// ────────────────────────────────────────────────────────────────────────────
// 判据：从状态值推导出的语义问题，只在这里回答一次
// ────────────────────────────────────────────────────────────────────────────

/**
 * 后端在生成过程中会写到 `shots.status` 上的**中间值**。
 *
 * ⚠️ 这是一份**遗留写法清单**，不是"内容状态"。它们的语义是
 * 「有一个 job 正在动这条镜头」，属于 `jobs` 的领域。
 *
 * 新增写入点时**不要再往这里加值**——那正是我们要收敛的方向。
 * `verify-shot-status.ts` 会静态核对这份清单与后端源码一致。
 */
export const IN_FLIGHT_SHOT_STATUSES = ["prompting", "generating"] as const;

/** 这条镜头是不是"正在被生成"。**看 `job`，不看 `shot`。** */
export function isInFlightShotStatus(s: ShotContentStatus | string | null | undefined): boolean {
  return (IN_FLIGHT_SHOT_STATUSES as readonly string[]).includes(s ?? "");
}

/**
 * **这条镜头现在能不能拿去用（播放/导出）？**
 *
 * 这是本文件对外最重要的一个函数。注意它的判据是 `adopted` ——
 * **与"有没有 job 在跑"完全无关**。一条镜头正在被重生成（有一个 `running`
 * 的 job 挂在它旁边），只要它还是 `adopted`，就仍然能播、能导。
 *
 * 这就是「重生成不丢旧内容」在判据层面的落地：
 * **不要写 `status === "adopted" && !busy` 这种条件**，那等于又拿 job 的状态
 * 去否决内容的状态，请回到这里。
 */
export function isUsable(s: ShotContentStatus | string | null | undefined): boolean {
  return s === "adopted";
}

/**
 * 用户看得懂的下一步（给 UI 文案用）。
 *
 * `busy` 由**调用方从 job 状态传入**，不从 `shot.status` 猜——
 * 这正是两套状态机在 UI 层的正确接法：内容状态决定"是什么"，
 * 任务状态决定"要不要显示进度"。
 */
export function describeShot(
  content: ShotContentStatus | string | null | undefined,
  busy: boolean,
): string {
  // busy 优先显示进度：用户在等的时候，"还要多久"比"是什么"更急。
  // 但注意它**不改变**内容状态的判定（isUsable 仍以 content 为准）。
  if (busy) return "生成中…";
  switch (content) {
    case "pending":    return "待生成";
    case "review":     return "待审阅";
    case "adopted":    return "已生成";
    case "failed":     return "生成失败";
    // 走到这里说明后端写了中间值但**没有**对应在跑的 job ——
    // 即"状态回写漏了"（真僵尸）。这跟 pending 完全不同，要说清楚。
    case "prompting":
    case "generating": return "状态异常，可重试";
    default:           return "未知";
  }
}

/**
 * ⚠️ 已知的**真·不一致**（2026-09-11 dev 库实测，批次 A2）。
 *
 * 这几条是 A2 的产出，写在代码里而不是只写进文档，是为了让批次 B/C
 * 动手时**有确定的回归样本**（改对了这几条就说明回写路径修好了）：
 *
 * | 现象 | 条数 | 性质 |
 * |---|---|---|
 * | `video_url` 有值却仍 `pending` | **2** | 回写漏了：片子在了，状态没跟上 |
 * | `video_url` 有值却标 `failed` | **10** | 同一根轴上的矛盾：能用的片子被标失败 |
 * | `adopted` 但 `adopted_version` 为空 | **1** | 指针缺失 |
 * | `status='adopted'` 且 `video_url` 为空 | 0 | ✅ 无 |
 *
 * ⛔ **对照：`shot.status='pending'` 的 6,796 条不是不一致**，构成是
 * 4,584 条从未生成 + 2,210 条有词未出片 + 2 条真不一致。
 * **不要把它们当僵尸清理。**
 */
export const KNOWN_INCONSISTENT_SHOT_COUNTS = {
  pendingWithVideo: 2,
  failedWithVideo: 10,
  adoptedWithoutVersion: 1,
} as const;
