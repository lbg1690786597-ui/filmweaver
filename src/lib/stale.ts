/**
 * 镜头「已过期」的呈现规则（前端唯一真源）。
 *
 * 后端 `app/stale.py` 定义语义与状态机，这里只负责**怎么说给用户听**、
 * **该给哪个按钮**。之所以单独一个模块而不是就地写在 ShotsPanel/Inspector 里：
 * 这两处以前各写了一句话，且都写死成「所属集剧本已修改」——旁白时长变了也这么说，
 * 还引导用户去点「重新拆解本集」（会把整集已出的片全作废）。
 *
 * ⚠️ `null` = 后端本字段上线前留下的老数据。一律按最严重的 rebreak 呈现，
 * 与后端的保守分支一致：宁可提示得重些，不能让用户以为"重出片就行"而白花钱。
 */
import type { ShotInfo } from "../api";

export type StaleReason = NonNullable<ShotInfo["stale_reason"]>;

/** 徽标上那几个字。区分开才能让用户在镜头列表里一眼分辨轻重。 */
const BADGE: Record<StaleReason, string> = {
  rebreak: "需重拆",
  reprompt: "需重出提示词",
  regen: "待重生成",
};

/** 兜底文案（老后端没有 stale_hint 时用）。措辞与后端 _LABEL 保持一致。 */
const HINT: Record<StaleReason, string> = {
  rebreak: "本集正文已修改，镜头切分已过期（需重新拆解本集）",
  reprompt: "本镜拆解已修改，提示词基于旧拆解（需重新生成提示词后再出片）",
  regen: "旁白时长已变，现有视频与新时长对不上（重新生成即可）",
};

const FALLBACK_BADGE = "已过期";
const FALLBACK_HINT = "本镜已过期，建议重新拆解本集后再出片";

export function staleBadge(s: Pick<ShotInfo, "stale_reason">): string {
  return (s.stale_reason && BADGE[s.stale_reason]) || FALLBACK_BADGE;
}

export function staleHint(s: Pick<ShotInfo, "stale_reason" | "stale_hint">): string {
  // 后端出的那句优先：文案改动只需改一处，且它看得见 DB 里的真值
  return s.stale_hint || (s.stale_reason && HINT[s.stale_reason]) || FALLBACK_HINT;
}

/**
 * 这镜（这集）需要**重新拆解**吗？
 *
 * 只有 rebreak 与老数据(null) 需要。reprompt/regen 重拆是过度施救：
 * 会把本集其它已调好的镜头连同已出的片一起冲掉。
 */
export function needsRebreak(s: Pick<ShotInfo, "stale" | "stale_reason">): boolean {
  return !!s.stale && s.stale_reason !== "reprompt" && s.stale_reason !== "regen";
}
