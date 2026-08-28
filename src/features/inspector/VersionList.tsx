/**
 * VersionList — 镜头版本管理（PLAN §16，Phase 3）
 *
 * 后端已有完整支持：GET /v2/shots/{id}/versions + POST /v2/shots/{id}/adopt。
 * 切版本只换视频源，不改时间轴位置——这是 PLAN §16 的硬要求
 * （否则回退一个版本，后面所有镜头的时间码全变，字幕/旁白全错位）。
 *
 * 模型 ID 不直接展示：用户不该记 "minimax-h3-ref2v"，只需要知道
 * 这是「⚡ 快速验证」还是「◆ 精品」。映射见 lib/modelLabels。
 */

import { useEffect, useState } from "react";
import { Check, Play, Loader2, Gem, Zap } from "lucide-react";
import { api } from "../../api";
import type { ShotInfo } from "../../api";
import "./VersionList.css";

interface Version {
  version_no: number;
  video_url: string | null;
  model_id: string | null;
  prompt: string | null;
  meta: Record<string, unknown> | null;
  created_at: string | null;
}

/** 模型 → 质量档（用户只看到「快速验证 / 精品」，不看 model id） */
function quality(modelId: string | null): { tier: "preview" | "final"; label: string } {
  const m = (modelId ?? "").toLowerCase();
  if (m.includes("seedance-2.0") && !m.includes("mini")) return { tier: "final", label: "精品" };
  if (m.includes("veo-3-1") && !m.includes("fast")) return { tier: "final", label: "精品" };
  return { tier: "preview", label: "快速验证" };
}

/** 模型 id → 友好名（对不上时退回原 id，至少不显示空白） */
function modelName(modelId: string | null): string {
  const m = (modelId ?? "").toLowerCase();
  if (m.includes("seedance-2.0-mini")) return "Seedance mini";
  if (m.includes("seedance-2.0")) return "Seedance 2.0";
  if (m.includes("minimax-h3")) return "海螺 H3";
  if (m.includes("veo-3-1-fast")) return "Veo 快速";
  if (m.includes("veo-3-1")) return "Veo 质量";
  return modelId || "未知模型";
}

interface Props {
  shot: ShotInfo;
  onSwitchVersion: (shot: ShotInfo, verNo: number) => void;
  onToast: (m: string) => void;
}

export default function VersionList({ shot, onSwitchVersion, onToast }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setVersions(null);
    api.shotVersions(shot.id)
      .then((r) => { if (alive) setVersions(r.versions); })
      .catch(() => { if (alive) setVersions([]); });
    return () => { alive = false; };
    // 依赖里必须带上会随生成变化的字段：只依赖 shot.id 的话，
    // 「生成变体」「精品升级」完成后版本列表不刷新，得切走再切回来才看得到。
    // （shot 现在是从最新 shots 派生的对象，这些字段会真实变化）
  }, [shot.id, shot.video_url, shot.status]);

  if (versions === null) {
    return <div className="fw-vl-loading"><Loader2 size={13} className="fw-spin" /> 加载版本…</div>;
  }
  if (versions.length === 0) {
    return <div className="fw-vl-empty">本镜尚无生成版本</div>;
  }

  const doAdopt = async (v: Version) => {
    if (v.version_no === shot.adopted_version) return;
    setBusy(v.version_no);
    try {
      onSwitchVersion(shot, v.version_no);
    } catch (e) { onToast(String(e)); }
    finally { setBusy(null); }
  };

  return (
    <div className="fw-vl">
      {[...versions].sort((a, b) => b.version_no - a.version_no).map((v) => {
        const q = quality(v.model_id);
        const current = v.version_no === shot.adopted_version;
        return (
          <div key={v.version_no} className={`fw-vl-row ${current ? "current" : ""}`}>
            <span className={`fw-vl-tier ${q.tier}`} title={q.label}>
              {q.tier === "final" ? <Gem size={10} /> : <Zap size={10} />}
            </span>
            <span className="fw-vl-no">V{v.version_no}</span>
            <span className="fw-vl-model" title={v.model_id ?? ""}>{modelName(v.model_id)}</span>
            {current && <span className="fw-vl-badge">当前</span>}
            <span className="fw-vl-acts">
              <button title="预览此版本" disabled={!v.video_url}
                onClick={() => v.video_url && onSwitchVersion(shot, v.version_no)}>
                <Play size={11} />
              </button>
              <button title={current ? "已是当前版本" : "设为当前版本"}
                disabled={current || busy === v.version_no || !v.video_url}
                onClick={() => doAdopt(v)}>
                {busy === v.version_no
                  ? <Loader2 size={11} className="fw-spin" />
                  : <Check size={11} />}
              </button>
            </span>
          </div>
        );
      })}
      <div className="fw-vl-note">切换版本只更换视频源，时间轴位置不变</div>
    </div>
  );
}
