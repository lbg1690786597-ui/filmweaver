/**
 * dryRun.ts — 命令的**试运行**（批次 E3，PLAN §2.5.3 配套二）
 *
 * ## 它解决的是哪两个具体问题
 *
 * **① 把 `affected` 从"装饰"变成"护栏"。**
 *    C2 迁移时逐条判过：**7 条命令的 `affected` 只能留空或只填一半**（§12.9.4）——
 *    其中最容易误导用户的就是**重排**：命令写的是"把这一镜移到 #5"，
 *    而服务端会把中间那几十个镜头一起让位。命令自己的 `affected` 只填了移的那一镜，
 *    于是历史面板会显示"只动了 1 个镜头"——**那是一句假话**。
 *
 *    本模块用**当前时间轴**把它算出来：重排 `#12 → #5` 实际影响
 *    `[5..12]` 这 8 个镜头。E2 的快照给了这次试运行需要的全部输入。
 *
 * **② Agent 在动手之前要能问一句"会发生什么"。**
 *    用户说「把这段砍掉两秒」，模型调 `dry_run` 拿到"影响 1 个镜头、无连带"，
 *    念给用户听，用户点头，才真的执行。没有这一步，模型只能靠猜，
 *    而它猜错的代价是用户的工程被改乱 —— 虽然能撤销，但用户得先发现改错了。
 *
 * ## ⚠️ 试运行**不落库**，也不校验到最后一层
 *
 * 它是**客户端能算的部分**：镜头存不存在、参数形状对不对、范围合不合法、
 * 连带影响几个镜头。**服务端的业务校验（切点边距、时长下限、版本约束）
 * 这里算不出来** —— 那需要拉后端的常量与项目设置。所以结果里有一条
 * `clientOnly: true` 的提示，别把它当成"服务端一定会接受"的保证。
 * 真想确认能不能成，最终还得看真实调用的返回。
 */

import type { CommandScope } from "../command";
import type { JsonSchema } from "./schema";
import { validateArgs } from "./schema";
import { findCapability } from "./capability";
import type { TimelineShotView } from "./describeTimeline";

export interface DryRunShot extends TimelineShotView {
  /** 镜头名（外部素材才有）。用于"要删的是『片头』这一段"这类人话 */
  special_name?: string | null;
}

export interface DryRunResult {
  /** 试运行能不能进行下去（参数/前置条件是否成立）。**不是**"服务端会不会接受" */
  ok: boolean;
  /** 拦下来的原因。`ok=false` 时至少一条 —— 空数组 + ok=false 是自相矛盾的 */
  blockers: string[];
  /** 这条命令会改动哪些镜头（uid）。**这就是面板与确认框要显示的东西** */
  affected: CommandScope;
  /** 人话总结，直接能念给用户听，如「移动镜头，另有 7 个镜头会被顺移」 */
  summary: string;
  /** 需要注意但不阻塞的点（如"这是不可撤销的操作"、"会花钱"） */
  warnings: string[];
  /** 只算到了客户端这一层。**不要**据此向用户承诺"一定能成功" */
  clientOnly: true;
}

/** 把 args 里的 id 拿出来。取不到就给一条明确的话，不静默继续。 */
function requireShot(
  shots: readonly DryRunShot[],
  id: unknown,
  role: string,
  blockers: string[],
): DryRunShot | undefined {
  if (typeof id !== "string" || !id) {
    blockers.push(`缺少 ${role} 的镜头 id`);
    return undefined;
  }
  const hit = shots.find((s) => s.id === id);
  if (!hit) {
    // ⚠️ 这句文案要给出**补救动作**，不能只说"找不到"：
    // 模型看到"id 不在当前时间轴里"就知道该重新 describe_timeline 拿新 id。
    blockers.push(
      `${role} 的镜头 id 不在当前时间轴上（可能已被删除或顺序已变）。` +
      `请重新调 describe_timeline 取最新的 id`,
    );
  }
  return hit;
}

/** 找 `order` 落在 `[from, to]` 闭区间里的镜头（全用 uid 返回）。 */
function ordersBetween(
  shots: readonly DryRunShot[],
  from: number,
  to: number,
): string[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return shots.filter((s) => s.order >= lo && s.order <= hi).map((s) => s.id);
}

export interface DryRunInput {
  /** 能力 id（与 `CAPABILITIES[].id` 一致）。**不是命令 id** */
  capabilityId: string;
  args: Record<string, unknown>;
  /** 当前时间轴（E2 的快照源，或任意同形状的镜头数组） */
  shots: readonly DryRunShot[];
}

/**
 * 算一遍，不落库。
 *
 * ⚠️ 对**没实现专门推断**的能力（大部分生成/只读能力），这里退化成
 * "参数校验 + 参数里出现的 shot_id 就是影响面"。这是**保守但正确**的：
 * 它**不会少报**已声明的 id；有可能少报连带影响（比如服务端的某些重排），
 * 所以那种情况下 summary 会明说"连带影响需服务端确认"。**宁可说不知道，
 * 不要编一个看起来精确的假数。**
 */
export function dryRun(input: DryRunInput): DryRunResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const cap = findCapability(input.capabilityId);
  if (!cap) {
    return {
      ok: false,
      blockers: [
        `没有名为 ${input.capabilityId} 的能力。` +
        `请只用能力表里列出的 id（可先用 describe_timeline 了解现状）`,
      ],
      affected: {},
      summary: "能力不存在，未做任何计算",
      warnings: [],
      clientOnly: true,
    };
  }

  // ── ① 参数形状（schema 层）─────────────────────────────────────────────
  const errs = validateArgs(cap.params as JsonSchema, input.args);
  for (const e of errs) blockers.push(`参数 ${e.path || "(根)"}：${e.msg}`);

  if (cap.kind === "generate") {
    warnings.push(
      "这一步会消耗生成额度（花钱）。必须先把「改哪几个、大概几个」讲清楚并拿到用户明确同意",
    );
  }
  if (cap.destructive) {
    warnings.push(`不可撤销：${cap.confirmText ?? "删除后无法恢复"}`);
  }

  const shots = input.shots;
  const affected: CommandScope = {};

  // ── ② 按能力各自推断影响面 ──────────────────────────────────────────────
  switch (input.capabilityId) {
    case "patch_shot_timeline": {
      const target = requireShot(shots, input.args.shot_id, "目标", blockers);
      if (target) {
        const toOrder = input.args.to_order;
        if (typeof toOrder === "number" && toOrder !== target.order) {
          // ⭐ 这就是 §12.9.4 那条"已知不精确"的正解：用**当前**时间轴算
          // 出中间那些一起让位的镜头，而不是只填自己。
          affected.shots = ordersBetween(shots, target.order, toOrder);
        } else {
          affected.shots = [target.id];
        }
      }
      break;
    }

    case "split_shot": {
      const target = requireShot(shots, input.args.shot_id, "目标", blockers);
      const at = input.args.at_sec;
      if (target) {
        affected.shots = [target.id];
        if (typeof at === "number") {
          const dur = target.duration_sec;
          if (typeof dur === "number" && dur > 0) {
            // 两端各留 1 秒是后端的经验下限（这里只做**提示**，真正的拒绝在后端）
            if (at < 1 || at > dur - 1) {
              warnings.push(
                `切点 ${at}s 太靠近镜头两端（本镜 ${dur}s），后端很可能拒绝。` +
                `安全范围大约是 1–${Math.max(1, Math.round(dur - 1))}s`,
              );
            }
          } else {
            warnings.push("本镜时长未知，无法预判切点是否太靠近两端");
          }
        }
        // 切开后新增一段，且**它之后所有镜头的 order 都要 +1**。
        // 后半段的 uid 服务端才会铸（客户端造不出来），所以这里只能说明、
        // 不能写进 affected —— 写一个假 id 进去比留空更坏。
        warnings.push(
          "会新增一个后半段镜头（新 id 由服务端生成），且其后所有镜头的顺序各 +1",
        );
      }
      break;
    }

    case "recut_shot": {
      const target = requireShot(shots, input.args.shot_id, "目标", blockers);
      if (target) {
        affected.shots = [target.id];
        const a = input.args.cut_a;
        const b = input.args.cut_b;
        if (typeof a === "number" && typeof b === "number") {
          if (a >= b) blockers.push(`cut_a(${a}s) 必须小于 cut_b(${b}s)`);
          const dur = target.duration_sec;
          if (typeof dur === "number" && dur > 0 && (a < 0 || b > dur)) {
            blockers.push(`切点超出本镜长度（${dur}s）：cut_a=${a}s cut_b=${b}s`);
          }
        }
        warnings.push(
          "会把这一镜拆成三行（A|B|C），只有中间 B 段需要重新生成；" +
          "其后所有镜头的顺序各 +2。调用后必须重新 describe_timeline",
        );
      }
      break;
    }

    case "unsplit_shot":
    case "undo_recut_shot": {
      const head = requireShot(shots, input.args.head_shot_id, "前半段", blockers);
      const tailId = input.args.tail_shot_id ?? input.args.mid_shot_id;
      const tail = requireShot(shots, tailId, "后半段/中间段", blockers);
      if (head && tail) affected.shots = [head.id, tail.id];
      warnings.push(
        "合并后其后所有镜头的顺序会前移。若后半段被单独重新生成过或手改过时长，" +
        "服务端会返回 409 —— 那时**不要重试**，把文案交给用户",
      );
      break;
    }

    case "delete_shot": {
      const target = requireShot(shots, input.args.shot_id, "目标", blockers);
      if (target) {
        if (!target.is_special) {
          // 这是硬约束，不是建议：AI 镜头删不掉，只能停用
          blockers.push(
            `镜头 #${target.order} 不是外部素材镜头，删不掉。` +
            `AI 生成的镜头请改用 patch_shot_timeline 的 disabled=true（停用可随时恢复）`,
          );
        }
        // ⚠️ 被删的镜头**不写进 affected**：它马上就不存在了，
        // 面板拿着这个 id 去高亮只会指着一个空位置（§12.9.4 第 2 条）。
        const name = target.special_name ? `「${target.special_name}」` : "";
        warnings.push(`删除后无法从本软件恢复，需要重新导入素材${name}`);
      }
      break;
    }

    case "add_special_shot": {
      const after = input.args.after_order;
      if (typeof after === "number" && after > 0) {
        // 插进去之后 order 全重排，实际动的是"插入点之后的所有镜头"
        affected.shots = [...ordersBetween(shots, after + 1, Number.MAX_SAFE_INTEGER)];
        warnings.push(`插入点之后的 ${affected.shots.length} 个镜头顺序各 +1`);
      } else {
        warnings.push("追加到末尾，已有镜头的顺序不受影响");
      }
      break;
    }

    case "patch_shot_prompt":
    case "reset_shot_prompt":
    case "adopt_shot":
    case "shot_versions": {
      const target = requireShot(shots, input.args.shot_id, "目标", blockers);
      if (target) affected.shots = [target.id];
      if (input.capabilityId === "adopt_shot") {
        warnings.push("采纳历史版本会清掉这一镜已有的取片窗口（新画面长度可能不同）");
      }
      break;
    }

    case "generate_shots": {
      const ids = input.args.shot_ids;
      if (Array.isArray(ids) && ids.length) {
        affected.shots = ids.filter((x): x is string => typeof x === "string");
        const missing = affected.shots!.filter((id) => !shots.some((s) => s.id === id));
        if (missing.length) {
          blockers.push(`有 ${missing.length} 个镜头 id 不在当前时间轴上，请重新取快照`);
        }
        warnings.push(`将为 ${affected.shots!.length} 个镜头触发生成`);
      } else {
        // 不传 shot_ids = 全项目待生成 —— 这个范围**必须**当面讲清楚
        affected.shots = shots
          .filter((s) => s.disabled !== true && (s.status === "pending" || s.stale === true))
          .map((s) => s.id);
        warnings.push(
          `未指定镜头 = 对全部待生成/待重做的镜头触发，共 ${affected.shots.length} 个。` +
          `务必先向用户确认范围与数量`,
        );
      }
      break;
    }

    case "describe_timeline": {
      // 只读，什么都不改
      warnings.push("只读操作，不修改任何内容");
      break;
    }

    default: {
      // 兜底：把参数里明确出现的 shot_id 收进来。**不猜**，也不假装算全了
      const ids = Object.entries(input.args)
        .filter(([k]) => k.endsWith("shot_id"))
        .map(([, v]) => v)
        .filter((v): v is string => typeof v === "string");
      if (ids.length) affected.shots = [...new Set(ids)];
      warnings.push("该能力的连带影响客户端算不出来，需服务端确认");
      break;
    }
  }

  const n = affected.shots?.length ?? 0;
  const summary = blockers.length
    ? `不能执行：${blockers[0]}`
    : n === 0
      ? `${cap.id}：不影响任何镜头（或影响面未知）`
      : `${cap.id}：会影响 ${n} 个镜头`;

  return {
    ok: blockers.length === 0,
    blockers,
    affected,
    summary,
    warnings,
    clientOnly: true,
  };
}
