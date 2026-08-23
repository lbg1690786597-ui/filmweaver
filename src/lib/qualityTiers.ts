/**
 * 质量档 → 具体模型的映射（PLAN §15）。
 *
 * 存在理由：普通生产用户不该记 model id。UI 只出现「⚡ 快速验证 / ◆ 精品」，
 * 真正下发哪个模型在这里定死，改模型只改这一处。
 *
 * 后端 shot_videos job 早就支持 payload.model_id（jobs.py:732），
 * 所以这不需要任何新接口——之前只是前端没传。
 */

export type QualityTier = "preview" | "final";

export interface TierSpec {
  id: QualityTier;
  label: string;
  icon: string;
  modelId: string;
  desc: string;
}

export const TIERS: Record<QualityTier, TierSpec> = {
  preview: {
    id: "preview", label: "快速验证", icon: "⚡",
    // 海螺 H3：支持 9 图参考，一致性好且比 Seedance 便宜，适合试构图
    modelId: "minimax-h3-ref2v",
    desc: "低成本试构图，约 10 分钟出片",
  },
  final: {
    id: "final", label: "精品", icon: "◆",
    modelId: "seedance-2.0",
    desc: "音画一体，首尾帧/参考图全能",
  },
};

export const tierModel = (t: QualityTier): string => TIERS[t].modelId;

/** model id → 友好名（版本列表/检查器展示用） */
export function modelLabel(modelId: string | null | undefined): string {
  const m = (modelId ?? "").toLowerCase();
  if (m.includes("seedance-2.0-mini")) return "Seedance mini";
  if (m.includes("seedance-2.0")) return "Seedance 2.0";
  if (m.includes("minimax-h3")) return "海螺 H3";
  if (m.includes("veo-3-1-fast")) return "Veo 快速";
  if (m.includes("veo-3-1")) return "Veo 质量";
  return modelId || "未知模型";
}

/** 该 model 属于哪一档（版本列表打 ⚡/◆ 标） */
export function tierOf(modelId: string | null | undefined): QualityTier {
  const m = (modelId ?? "").toLowerCase();
  if (m.includes("seedance-2.0") && !m.includes("mini")) return "final";
  if (m.includes("veo-3-1") && !m.includes("fast")) return "final";
  return "preview";
}
