/**
 * AttributeConfirm.ts — 归属确认的**执行计划**（3.11 A2，纯函数）
 *
 * 与 `AttributeDialog.tsx` 的分工：这个文件只把「用户最终选了什么」翻译成一张
 * 可以照着执行的**动作清单**，不碰 React、不发请求。分开的理由很实：
 *
 * - **确认面板是唯一会写库的地方**，而写库的两种动作（换主图 / 建新资产）后果
 *   完全不同 —— 换主图会把角色现有的参考图顶掉。这个判断必须能用断言钉住，
 *   而不是靠肉眼看一遍弹窗。
 * - **「覆盖已有图」要单独标出来**：`upsert-image` 是原地覆盖，旧图不会进回收站。
 *   用户上传自己的图时默认预期是"补充"而不是"替换"，所以这一条绝不能静默。
 *
 * 泛型 `F` 是刻意的：面板里是 `File`，验证脚本里是 `{ name }` 这样的哑对象。
 * 这个文件不需要 File 的任何能力（不读、不压缩、不上传），写窄了只是自找麻烦。
 */

import type { AttrResult, FileLike } from "./attribute";

/** 归属对象的最小形状（`AttrTarget` 满足它；面板里还有"归一名存在但无资产行"的一种） */
export interface AttrTargetLike {
  assetId: string | null;
  kind: string;
  name: string;
}

/** 一行文件最终的去向。除 `skip` 外都会产生写操作或上传。 */
export type AttrChoice =
  | { type: "skip" }
  /** 挂到某个已有资产上（更新它的主图） */
  | { type: "asset"; target: AttrTargetLike }
  /** 新建一条 `kind` 资产（名字取自文件名或用户手填） */
  | { type: "create"; kind: string; name: string }
  /** 只进素材池，不进资产页 */
  | { type: "pool" };

/** 一条待执行动作。地址（image_url）在执行阶段上传后才拿到，这里不占位。 */
export type AttrAction<F = File> =
  | { kind: "skip";   file: F }
  | { kind: "pool";   file: F }
  | { kind: "upsert"; file: F; target: AttrTargetLike;
      /** 该资产**已有图**，这一上传会把它顶掉且不进回收站 */
      overwrites: boolean }
  | { kind: "create"; file: F; assetKind: string; name: string };

export interface PlanInput<F> {
  file: F;
  /** 用户在行内选定的去向（已按默认值初始化过） */
  choice: AttrChoice;
  /** 该资产当前是否已有主图 —— 决定 `overwrites` */
  hasImage?: (target: AttrTargetLike) => boolean;
}

/**
 * 把一批「文件 + 用户选择」翻成动作清单。
 *
 * 只做翻译，不做重排：顺序与用户看到的行序一致，出错时能按行号定位到人。
 */
export function buildPlan<F>(rows: PlanInput<F>[]): AttrAction<F>[] {
  return rows.map(({ file, choice, hasImage }): AttrAction<F> => {
    if (choice.type === "skip") return { kind: "skip", file };
    if (choice.type === "pool") return { kind: "pool", file };
    if (choice.type === "asset") {
      return {
        kind: "upsert", file, target: choice.target,
        overwrites: hasImage ? hasImage(choice.target) : false,
      };
    }
    return { kind: "create", file, assetKind: choice.kind, name: choice.name };
  });
}

/** 会被覆盖掉主图的那些动作 —— 确认文案要点名它们，不能只说"共 N 项" */
export function overwritingActions<F>(actions: AttrAction<F>[]): { target: AttrTargetLike; file: F }[] {
  const out: { target: AttrTargetLike; file: F }[] = [];
  for (const a of actions) {
    if (a.kind === "upsert" && a.overwrites) out.push({ target: a.target, file: a.file });
  }
  return out;
}

/** 动作清单的人类可读摘要（确认按钮旁那行小字） */
export function summarize<F>(actions: AttrAction<F>[]): {
  upsert: number; create: number; pool: number; skip: number; overwrite: number;
} {
  const s = { upsert: 0, create: 0, pool: 0, skip: 0, overwrite: 0 };
  for (const a of actions) {
    if (a.kind === "skip") s.skip++;
    else if (a.kind === "pool") s.pool++;
    else if (a.kind === "create") s.create++;
    else { s.upsert++; if (a.overwrites) s.overwrite++; }
  }
  return s;
}

/** 去扩展名的文件名 —— 新建资产时当默认名字 */
export function stemOf(file: FileLike): string {
  return file.name.replace(/\.[^./\\]+$/, "");
}

/**
 * 给一行推断结果算**默认去向**。
 *
 * 默认值就是产品立场，写在函数里而不是散在 JSX 里：
 *
 * · 认准了（rule = name/alias/path，无并列）→ 直接选它。用户上传往往就是为了它。
 * · 有并列候选（review）→ **不预选**（`skip`），强制用户点一下（见 `attribute.ts` 的裁定）。
 * · 归一名有、资产行没有 → 默认"新建这条资产"。
 * · 只判出类别（keyword）→ 默认"新建一条该类别的资产"，名字用去后缀的文件名。
 *   `定妆-02.jpg` 至少能变成一条角色资产，而不是被丢进自定义。
 * · 完全没有线索（none）→ 默认 `fallback`（调用方给，界面上是"进素材池"）。
 *
 * **注意**：默认值一律可改，且面板必须逐行显示 —— 默认只负责帮用户少点几下，
 * 不负责替他决定。
 */
export function defaultChoice(r: AttrResult, fallback: AttrChoice): AttrChoice {
  if (r.guess && !r.review && r.guess.assetId) {
    return { type: "asset", target: r.guess };
  }
  if (r.review) return { type: "skip" };
  if (r.guess && !r.guess.assetId && r.guess.name) {
    return { type: "create", kind: r.guess.kind, name: r.guess.name };
  }
  if (r.rule === "keyword" && r.guess) {
    const name = stemOf(r.file).trim();
    if (name) return { type: "create", kind: r.guess.kind, name };
  }
  return fallback;
}
