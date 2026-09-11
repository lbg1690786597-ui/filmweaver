/**
 * sceneGroups.ts — 场景归一面板的纯逻辑（U3）
 *
 * ## 这个模块存在的理由
 *
 * 场景归一是**有损**的：确认一组合并，后端会把同一归一名下的多行
 * `Asset(kind="location")` 合并成一行，多余那行直接删掉 —— 而它可能已经出过图、
 * 花过钱。所以界面上的每一句话都必须与"实际会发生什么"严格对应：
 *
 *   · 说"无需操作"的组，确认了必须真的什么都不变（否则用户会跳过该看的东西）；
 *   · 说"会删掉 X"的组，删的必须正好是 X（后端 `_keep_rank` 是预览与执行共用的，
 *     这一侧只是把它翻译成人话，不能自己另算一遍）；
 *   · 带不可逆后果的组必须与"纯改映射"的组**在视觉上分开**，不能混在一个列表里
 *     让用户一路点下去。
 *
 * 把这些判断放在纯函数里，`scripts/verify-scene-canon.ts` 才能逐条钉住，
 * 而不是靠人肉点界面。
 */
import type { ScenePreviewGroup, SceneGroup } from "../../api";

/** 一组归一建议的后果等级。排序与配色都按它来。 */
export type GroupRisk =
  /** 确认了也什么都不会变（当前就已经是这样） */
  | "none"
  /** 只改映射：改错了把成员的归一名改回去即可恢复 */
  | "alias"
  /** 会推翻用户自己手改过的映射 */
  | "override"
  /** 会删掉场景资产行（**不可逆**，且被删那行有图） */
  | "asset";

/** 有没有资产要被合并掉（后端空组是 `{}`，不是 null） */
export function hasAssetMerge(g: ScenePreviewGroup): boolean {
  const am = g.asset_merges as { drop?: unknown[] };
  return Array.isArray(am?.drop) && am.drop.length > 0;
}

/** 会被删掉的资产行（保序）。没有则空数组。 */
export function droppedAssets(g: ScenePreviewGroup):
{ name: string; has_image: boolean; deleted: boolean }[] {
  const am = g.asset_merges as { drop?: { name: string; has_image: boolean; deleted: boolean }[] };
  return Array.isArray(am?.drop) ? am.drop : [];
}

export function groupRisk(g: ScenePreviewGroup): GroupRisk {
  if (!g.changed) return "none";
  // 顺序是承重的：一组可能既删资产又推翻人工映射，此时必须报更重的那个。
  // 反过来（先看 override）会让"会删掉已出图的资产"这句话被吞掉。
  if (hasAssetMerge(g)) return "asset";
  if (g.locked.length > 0) return "override";
  return "alias";
}

/** 这一组确认后是否不可逆（→ 必须二次确认，且文案要写清删什么） */
export function isIrreversible(g: ScenePreviewGroup): boolean {
  return groupRisk(g) === "asset";
}

/** 把建议分成"要看的"和"已经是这样的"。
 *
 *  不合成一个列表：`propose_scene_groups` 会把**每一个**场景都单独成组回来
 *  （独一无二的场景也要成组，见后端提示词），一个 40 场景的项目里通常只有
 *  两三组真的有变化。全塞一个列表 = 用户在几十条"无变化"里找那两条。 */
export function splitPreview(groups: ScenePreviewGroup[]): {
  actionable: ScenePreviewGroup[]; unchanged: ScenePreviewGroup[];
} {
  const actionable = groups.filter((g) => g.changed);
  const unchanged = groups.filter((g) => !g.changed);
  // 重的排前面（会删资产 > 会推翻手改 > 只改映射），同级按影响镜头多的在前
  const rank: Record<GroupRisk, number> = { asset: 0, override: 1, alias: 2, none: 3 };
  actionable.sort((a, b) => rank[groupRisk(a)] - rank[groupRisk(b)]
    || b.shots - a.shots || a.canonical.localeCompare(b.canonical, "zh"));
  return { actionable, unchanged };
}

/** 一组的一句话摘要（给人看的，不含任何后果判断——后果另起一行专门写） */
export function groupSummary(g: ScenePreviewGroup): string {
  const will = g.members.filter((m) => m.will_change).length;
  const parts = [`${g.members.length} 种写法`, `${g.shots} 镜`];
  if (will) parts.push(`改 ${will} 个写法`);
  return parts.join(" · ");
}

/** 后果那一行。空串 = 没有后果要警告（只改映射的组）。
 *
 *  措辞刻意具体到名字与"有没有图"：用户要判断的是"这张图我还要不要"，
 *  一句"将合并资产"给不出这个判断。 */
export function consequenceText(g: ScenePreviewGroup): string {
  const out: string[] = [];
  const drop = droppedAssets(g).filter((d) => !d.deleted);
  if (drop.length) {
    const withImg = drop.filter((d) => d.has_image);
    const names = drop.map((d) => `「${d.name}」`).join("、");
    out.push(withImg.length
      ? `⚠️ 会删掉场景资产 ${names} —— 其中 ${withImg.length} 行**已经出过图**，图会并到保留的那行，多余的行删掉后不可恢复`
      : `会删掉 ${drop.length} 行重复的场景资产 ${names}（都没出过图）`);
  }
  if (g.locked.length) {
    out.push(`⚠️ 会推翻你手改过的映射：${g.locked.map((x) => `「${x}」`).join("、")}`);
  }
  return out.join("\n");
}

/** 二次确认框的文案（只给不可逆的组用）。返回 null = 不需要二次确认。 */
export function confirmText(g: ScenePreviewGroup): string | null {
  if (!isIrreversible(g) && g.locked.length === 0) return null;
  const lines = [`把这 ${g.members.length} 种写法合并为「${g.canonical}」？`, ""];
  const c = consequenceText(g);
  if (c) lines.push(c.replace(/\*\*/g, ""), "");
  lines.push("镜头里的场景原名不会被改写，映射随时可以改回来；",
    "但被删掉的场景资产行无法恢复。");
  return lines.join("\n");
}

/** 当前归一现状里"真的发生了合并"的组（成员 >1）。
 *  现状列表默认只展示这些：一个写法自己一组的没有信息量，几十条会把面板撑爆。 */
export function mergedGroups(groups: SceneGroup[]): SceneGroup[] {
  return groups.filter((g) => g.members.length > 1);
}

/** 把一个写法从它当前的组里拆出去时，它的新归一名。
 *
 *  用**原名本身**，而不是在前端复刻一遍后端 `normalize_location` 的清洗规则：
 *  那套规则（剥日/夜/内/外前缀、集场号、分隔符归一）复刻一份必然漂移，
 *  而漂移的后果是前端说"拆成 A"、后端存成 B。后端 docstring 写的修法就是
 *  "把 canonical 改回它自己的名字"，这里照做。 */
export function splitCanonical(rawName: string): string {
  return rawName.trim();
}
