/**
 * 项目列表的排序与检索（纯函数，无 React 依赖）。
 *
 * 单独成模块的理由：`scripts/verify-project-list.ts` 要 headless 跑它。
 * 排序规则里有好几条"看不出来但错了会天天硌人"的判断（缺失值排位、中文名
 * 排序、等值稳定性），只有钉成断言才不会在下次改动时悄悄退化。
 *
 * ## 为什么排序不能沿用旧写法
 *
 * 这里替换掉的是 `filtered.sort((a,b) => b.id > a.id …)`，注释写着
 * 「id 是 hex 时间戳前缀，字典序即时序」——**那句是错的**：后端建项目用的是
 * `uuid.uuid4().hex[:12]`，纯随机、不含任何时间信息。所以旧版的"最新排最前"
 * 实际排出来是随机序，而且因为看上去总在变，用户根本察觉不到它是坏的。
 * 真正的时序来自新加的 `created_at` 列与 `last_active_at`（由 jobs 派生）。
 */

import type { ProjectInfo } from "../../api";
import { productionModeLabel } from "../../lib/modelLabels";

export type SortKey =
  | "active"      // 最近活动（最后一个任务的时刻）
  | "created"     // 创建时间
  | "title"       // 名称
  | "progress"    // 出片进度
  | "duration"    // 总时长
  | "episodes";   // 集数

export type SortDir = "desc" | "asc";

/** 下拉里的顺序即此处顺序；label 直接用于 UI。 */
export const SORT_KEYS: { key: SortKey; label: string }[] = [
  { key: "active", label: "最近活动" },
  { key: "created", label: "创建时间" },
  { key: "title", label: "名称" },
  { key: "progress", label: "出片进度" },
  { key: "duration", label: "总时长" },
  { key: "episodes", label: "集数" },
];

/**
 * 取排序值。返回 `null` = **该项目在这个维度上没有值**，与"值为 0"截然不同：
 * 没跑过任务的项目 `last_active_at` 是 null，不是"活动于 1970 年"。
 */
function valueOf(p: ProjectInfo, key: SortKey): string | number | null {
  switch (key) {
    case "active":
      // ISO8601 定长字符串，字典序即时序。
      // ⚠️ 不要混进 shot_versions.created_at 那种 `YYYY-MM-DD HH:MM:SS`
      // （SQLite datetime('now') 默认值），两种格式字典序不可比。
      return p.last_active_at || null;
    case "created":
      return p.created_at || null;
    case "title":
      return p.title || "";
    case "progress": {
      const total = p.shots_total ?? 0;
      // 一个镜头都没有的项目没有"进度"可言，给 0% 会让它和"拆完镜一张没生成"
      // 的项目混在一起——后者是真的 0%，前者只是还没开始。
      return total ? (p.shots_done ?? 0) / total : null;
    }
    case "duration":
      return p.total_sec ?? null;
    case "episodes":
      return p.episodes_count ?? null;
  }
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "string" && typeof b === "string") {
    // 中文项目名必须用 localeCompare("zh")：按 Unicode 码点排等于没排
    // （码点序是部首/编码顺序，"张三"会排到"阿彪"前面）。
    return a.localeCompare(b, "zh");
  }
  return (a as number) - (b as number);
}

/**
 * 排序。两条硬规则：
 *
 * 1. **缺失值一律排最后，与升降序无关。** 若让 null 参与升降，
 *    切到"创建时间↑"时，一屏全是回填不到时间的老项目，用户会以为列表坏了。
 * 2. **等值保持原相对顺序**（稳定排序）。JS 的 `Array.prototype.sort` 自
 *    ES2019 起已保证稳定，这里不再自己带 index —— 但断言仍然要钉，
 *    因为"同为 0% 的十个项目每次刷新互换位置"是最典型的坏体验。
 */
export function sortProjects(
  list: ProjectInfo[], key: SortKey, dir: SortDir = "desc",
): ProjectInfo[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((pa, pb) => {
    const a = valueOf(pa, key);
    const b = valueOf(pb, key);
    if (a === null && b === null) return 0;
    if (a === null) return 1;    // 缺失沉底
    if (b === null) return -1;
    return sign * compareValues(a, b);
  });
}

/**
 * 检索。除项目名外还匹配**生产模式中文名**与**画幅**，因为用户找项目时
 * 想的常常是"那个真人剧的"而不是具体片名；只匹配 title 的话搜"真人剧"会
 * 一个都搜不到，看起来像搜索坏了。
 */
export function filterProjects(list: ProjectInfo[], q: string): ProjectInfo[] {
  const kw = q.trim().toLowerCase();
  if (!kw) return [...list];
  return list.filter((p) => {
    const hay = [
      p.title || "",
      productionModeLabel(p.production_mode),
      p.base_aspect || "",
    ].join(" ").toLowerCase();
    return hay.includes(kw);
  });
}

/** 字节数 → 人类可读（清盘确认框用）。 */
export function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // 保留一位小数，但整数不写成 "1.0 KB"；≥100 直接取整（三位数带小数没信息量）。
  const s = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${s} ${units[i]}`;
}
