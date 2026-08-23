/**
 * AssetInspector — 资产段属性（PLAN §11，Phase 5）
 *
 * 核心要求：**不暴露数据库词汇**。用户不该看到 AssetStage / source_stage_id /
 * scene_bound，只看到「这套造型在第 3 到第 7 个镜头生效，共影响 5 个镜头」。
 *
 * 「影响哪些镜头」是这个面板存在的理由：资产轨改一下，可能几十个镜头的
 * 参考图就变了、需要重新生成（每条几块钱）。改之前得让人知道波及范围。
 */

import { User, MapPin, Image as ImageIcon, RefreshCw, Film, AlertTriangle } from "lucide-react";
import { api } from "../../api";
import type { ShotInfo } from "../../api";
import type { AssetRun, AssetTrackKind } from "../assets/AssetTrack";
import "./AssetInspector.css";

const KIND_LABEL: Record<AssetTrackKind, string> = {
  character: "人物造型", location: "场景", reference: "参考资产",
};

interface Props {
  run: AssetRun & { rowName: string; kind: AssetTrackKind };
  shots: ShotInfo[];
  onRegenerate: (shotIds: string[]) => void;
  onSelectShot: (s: ShotInfo) => void;
  onClose: () => void;
}

export default function AssetInspector(p: Props) {
  const { run } = p;
  const affected = p.shots
    .filter((s) => s.order >= run.from && s.order <= run.to && !s.is_special)
    .sort((a, b) => a.order - b.order);
  const generated = affected.filter((s) => s.video_url);
  const staleOnes = affected.filter((s) => s.refs_stale);

  const Icon = run.kind === "character" ? User
    : run.kind === "location" ? MapPin : ImageIcon;

  return (
    <>
      <div className="fw-insp-head">
        <span className="fw-insp-title">
          {run.stageName ? `${run.rowName} · ${run.stageName}` : run.rowName}
        </span>
        <button className="fw-ai-close" onClick={p.onClose} title="取消选中">×</button>
      </div>

      <div className="fw-insp-body">
        {/* 资产预览 */}
        {run.imageUrl && (
          <div className="fw-ai-hero">
            <img src={api.mediaUrl(run.imageUrl)} alt="" loading="lazy" />
          </div>
        )}

        <section className="fw-insp-sec">
          <div className="fw-insp-sec-head"><Icon size={12} /> 资产</div>
          <div className="fw-insp-sec-body">
            <KV k="名称" v={run.rowName} />
            <KV k="类型" v={KIND_LABEL[run.kind]} />
            {run.stageName && <KV k="造型" v={run.stageName} />}
            <KV k="状态" v={run.locked
              ? <span className="fw-insp-chip ok">已确认（重识别不覆盖）</span>
              : <span className="fw-insp-chip">草稿（可被 AI 重识别覆盖）</span>} />
          </div>
        </section>

        {/* 生效范围：自然语言，不出现 stage_id / ep_from */}
        <section className="fw-insp-sec">
          <div className="fw-insp-sec-head"><Film size={12} /> 生效范围</div>
          <div className="fw-insp-sec-body">
            <div className="fw-ai-range">
              第 <b>{run.from}</b> – <b>{run.to}</b> 个镜头
              <span className="fw-ai-count">共 {affected.length} 个</span>
            </div>
            <div className="fw-ai-hint">
              这些镜头生成时会把上面这张图作为参考送给模型。
              拖动轨道上色块的左右边缘可以改变范围。
            </div>
            {run.manualAdd.length > 0 && (
              <div className="fw-ai-manual">
                其中 {run.manualAdd.length} 个是手动加入的
                （#{run.manualAdd.slice(0, 6).join(" #")}{run.manualAdd.length > 6 ? " …" : ""}）
              </div>
            )}
          </div>
        </section>

        {/* 受影响镜头列表 */}
        <section className="fw-insp-sec">
          <div className="fw-insp-sec-head">
            受影响的镜头
            <span className="fw-ai-sub">{generated.length} 个已出片</span>
          </div>
          <div className="fw-insp-sec-body">
            {affected.length === 0 ? (
              <div className="fw-insp-empty">此范围内没有可注入的镜头</div>
            ) : (
              <div className="fw-ai-shots">
                {affected.map((s) => (
                  <button key={s.id}
                    className={`fw-ai-shot ${s.video_url ? "done" : ""} ${s.refs_stale ? "stale" : ""}`}
                    onClick={() => p.onSelectShot(s)}
                    title={`镜头 #${s.order}${s.refs_stale ? "（参考图已变，建议重生成）" : ""}\n点击定位`}>
                    #{s.order}
                  </button>
                ))}
              </div>
            )}

            {staleOnes.length > 0 && (
              <div className="fw-insp-alert">
                <AlertTriangle size={11} />
                {staleOnes.length} 个已出片镜头的参考资产被改过，画面还是旧的
              </div>
            )}
          </div>
        </section>

        <div className="fw-insp-actions">
          <button className="fw-insp-act" disabled={!affected.length}
            onClick={() => p.onRegenerate(affected.map((s) => s.id))}
            title="按当前资产重新生成这些镜头（会消耗生成额度）">
            <RefreshCw size={13} /> 重生成全部 {affected.length} 镜
          </button>
          <button className="fw-insp-act" disabled={!staleOnes.length}
            onClick={() => p.onRegenerate(staleOnes.map((s) => s.id))}
            title="只重生成参考图变过的那些">
            <AlertTriangle size={13} /> 只补 {staleOnes.length} 个过期
          </button>
        </div>
      </div>
    </>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="fw-insp-row">
      <span className="fw-insp-k">{k}</span>
      <span className="fw-insp-v">{v}</span>
    </div>
  );
}
