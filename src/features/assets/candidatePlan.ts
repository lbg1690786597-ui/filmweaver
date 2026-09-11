/**
 * features/assets/candidatePlan.ts — 候选定妆图「这次要出几张、花多少钱」的口径
 *
 * ## 为什么这几行值得单独成模块
 *
 * 候选图是**按张计费**的：点一次「生成」出 N 张，N 是默认值说了算。
 * 而"合理的 N"在两种处境下不一样，这不是审美问题，是花钱问题：
 *
 *   · **还没有图**（新阶段/新资产）：用户要的是"先有一张"。默认出 4 张
 *     = 第一次点就花四倍钱，而其中三张注定被丢掉。
 *   · **已经有图、想换一张**：用户要的是"挑"。此时只出 1 张就失去了意义 ——
 *     不满意还得再点，来回的次数比 4 张一起出更多。
 *
 * 所以默认张数**随处境变**，并且按钮上必须写清这次会出几张。
 * 抽成纯函数是为了让 `scripts/verify-candidate-stills.ts` 能直接断言这套口径，
 * 而不是在 900 行的弹窗里靠肉眼看。
 *
 * ⚠️ 与「候选不落库」这件事配套理解：出来的 N 张只是候选，**挑中那张才写进资产**
 * （`AssetStage.image_url` / `Asset.image_url`）。所以"生成"从不覆盖当前图 ——
 * 文案里不要写"重新生成会覆盖"，那是 job 化之前的旧行为。
 */

/** 张数选择器提供的档位。后端上限是 9，这里只开到 4：再多一屏放不下、也更贵。 */
export const CANDIDATE_COUNTS = [1, 2, 3, 4] as const;

/**
 * 默认出几张。
 *
 * `hasImage=false` → 1：第一次只求有；不满意再点一次也只是一张的钱。
 * `hasImage=true`  → 4：这是"换一张"，没有对比就没有挑选的意义。
 */
export function defaultCandidateCount(hasImage: boolean): number {
  return hasImage ? 4 : 1;
}

/** 张数落到合法档位内（防御脏值：URL 参数、旧 localStorage、手改 select）。 */
export function clampCandidateCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  const i = Math.round(n);
  if (i < 1) return 1;
  if (i > 4) return 4;
  return i;
}

export interface CandidateButtonState {
  /** 当前资产/阶段是否已经有图 */
  hasImage: boolean;
  /** 选定的张数 */
  n: number;
  /** 提交请求在途 */
  submitting: boolean;
  /** 候选 job 在后台跑 */
  running: boolean;
}

/**
 * 生成按钮上的字。
 *
 * 三条硬要求：
 *   1. **永远带着张数** —— 用户点下去之前就该知道这次出几张（= 花几张的钱）；
 *   2. 有图时说「换一张」而不是「生成」—— 说"生成"会让人以为当前那张要被顶掉；
 *   3. job 在跑时明说"可以关掉弹窗" —— 它确实关了也在跑，不说用户会一直等着。
 */
export function candidateButtonLabel(s: CandidateButtonState): string {
  if (s.running) return "生成中…（可关掉弹窗，回来接着挑）";
  if (s.submitting) return "提交中…";
  const n = clampCandidateCount(s.n);
  return s.hasImage
    ? `✨ 换一张（出 ${n} 张候选来挑）`
    : `✨ 生成定妆图（${n} 张候选）`;
}

/**
 * 按钮下方那行花费提示。
 *
 * 报数而不是拦人：本项目的花费闸门惯例是"先把数字摆出来，用户点了才出图"。
 * 只有 1 张时不必强调"挑"，多张时要说清"不选就不花在资产上"这层语义 ——
 * 钱已经花在出图上了，但资产图不会被动过。
 */
export function candidateCostHint(n: number, hasImage: boolean): string {
  const c = clampCandidateCount(n);
  const head = `本次将出图 ${c} 张，按 ${c} 张计费。`;
  const tail = hasImage
    ? "候选只是候选：不点选就什么都不会改，当前这张定妆图保持原样。"
    : "候选只是候选：点选哪张，哪张才成为这个资产的定妆图。";
  return head + tail;
}
