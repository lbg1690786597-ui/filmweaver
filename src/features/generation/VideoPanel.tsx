/**
 * VideoPanel — AI 视频生产（PLAN §6 + §15，Phase 4）
 *
 * 把散落在旧 UI 各处的生产动作收进一处，并按 PLAN §15 建立**质量语义**：
 *   ⚡ 快速验证  H3 / Seedance mini —— 低成本试构图
 *   ◆ 精品      Seedance 2.0 / Veo 质量 —— 最终产出
 * 普通用户只选这两档，具体 model id 收进「高级」。
 *
 * 生产动作按「花不花钱」分组，这是短剧生产里最要紧的一条信息：
 *   纯文本（不花生图/生片钱）：服装识别、提示词重对齐
 *   出图（几毛/张）：资产补图、批量首帧
 *   出片（几块/条）：镜头生成、一键成片
 */

import { useMemo, useState } from "react";
import {
  Zap, Gem, Loader2, Image as ImageIcon, Film, Wand2, Shirt,
  ChevronDown, ChevronRight, Play, AlertTriangle, CircleDollarSign,
} from "lucide-react";
import type { ShotInfo, JobPhase } from "../../api";
import { TIERS } from "../../lib/qualityTiers";
import "./VideoPanel.css";

import type { QualityTier as Tier } from "../../lib/qualityTiers";
import { productionModeLabel } from "../../lib/modelLabels";

interface Props {
  shots: ShotInfo[];
  generating: boolean;
  progress: number;
  jobPhase?: JobPhase | null;
  productionMode: string | null;
  videoModel?: string;

  onGenerate: (shotIds: string[]) => void;
  /** 当前质量档由 App 持有——它决定实际下发哪个模型，
   *  组件内部 state 会让"选了精品却还在用快速模型"这种错悄悄发生 */
  tier: Tier;
  onTierChange: (t: Tier) => void;
  onFirstFrames: (shotIds?: string[]) => void;
  onReprompt: (shotIds?: string[]) => void;
  onCostumeScan: () => void;
  /** AI 识别造型阶段（纯文本，逐集扫剧本 → 造型阶段落库）。
   *  原来只能从旧时间轴的资产轨头进入，收尾时迁到这里。 */
  onStagesDraft: () => void;
  stagesDrafting: boolean;
  onFillAssets: () => void;
  onOneClick: () => void;
  onSelectShot: (s: ShotInfo) => void;
  onToast: (m: string) => void;
}

export default function VideoPanel(p: Props) {
  const tier = p.tier;
  const setTier = p.onTierChange;
  const [advOpen, setAdvOpen] = useState(false);

  const stat = useMemo(() => {
    const active = p.shots.filter((s) => !s.disabled);
    return {
      total: active.length,
      done: active.filter((s) => s.video_url).length,
      failed: active.filter((s) => s.status === "failed").length,
      pending: active.filter((s) => !s.video_url && s.status !== "failed").length,
      noFrame: active.filter((s) => !s.first_frame_url).length,
      stale: active.filter((s) => s.refs_stale && s.video_url).length,
      draftPrompt: active.filter((s) => !s.prompt_state || s.prompt_state === "draft").length,
    };
  }, [p.shots]);

  const pct = stat.total ? Math.round((stat.done / stat.total) * 100) : 0;
  const pendingIds = p.shots.filter((s) => !s.disabled && !s.video_url).map((s) => s.id);
  const failedShots = p.shots.filter((s) => s.status === "failed" && !s.disabled);
  // 审核拒绝 vs 可重试：两类失败的处置完全相反，混在一起给"全部重试"会误导用户
  const moderationShots = failedShots.filter((s) => s.fail_kind === "moderation");
  const retryableShots = failedShots.filter((s) => s.fail_kind !== "moderation");

  return (
    <div className="fw-vp">
      {/* ---- 生产进度总览 ---- */}
      <div className="fw-vp-overview">
        <div className="fw-vp-pct">
          <span className="fw-vp-pct-num">{pct}<em>%</em></span>
          <span className="fw-vp-pct-label">{stat.done} / {stat.total} 镜已出片</span>
        </div>
        <div className="fw-vp-bar">
          <div className="fw-vp-fill" style={{ width: `${pct}%` }} />
        </div>
        {p.generating && (
          <div className="fw-vp-running">
            <Loader2 size={11} className="fw-spin" />
            {p.jobPhase?.label ?? "生产中"} {p.progress}%
          </div>
        )}
      </div>

      {/* ---- 质量档（PLAN §15：不让用户记 model id）---- */}
      <div className="fw-vp-sec">生产质量</div>
      <div className="fw-vp-tiers">
        <button className={`fw-vp-tier ${tier === "preview" ? "on" : ""}`}
          onClick={() => setTier("preview")}>
          <Zap size={15} />
          <span className="fw-vp-tier-name">快速验证</span>
          <span className="fw-vp-tier-desc">{TIERS.preview.desc}</span>
        </button>
        <button className={`fw-vp-tier final ${tier === "final" ? "on" : ""}`}
          onClick={() => setTier("final")}>
          <Gem size={15} />
          <span className="fw-vp-tier-name">精品制作</span>
          <span className="fw-vp-tier-desc">{TIERS.final.desc}</span>
        </button>
      </div>

      {/* ---- 主入口 ---- */}
      <button className="fw-vp-primary" disabled={p.generating} onClick={p.onOneClick}>
        {p.generating
          ? <><Loader2 size={14} className="fw-spin" /> 生产中 {p.progress}%</>
          : <><Play size={14} /> 一键成片</>}
      </button>
      <div className="fw-vp-hint">
        拆解 → 资产 → 首帧 → 片段 → 拼接；已完成的环节会自动跳过
      </div>

      {/* ---- 分步动作：按花钱与否分组 ---- */}
      <div className="fw-vp-sec">
        分步生产
        <span className="fw-vp-sec-tip" title="按成本从低到高排列">
          <CircleDollarSign size={10} /> 成本递增
        </span>
      </div>

      <ActionRow icon={<Shirt size={13} />} cost="free"
        title="识别全剧服装"
        desc="纯文本扫剧本，不出图不花钱。补图前必须先跑，否则只会给每个角色补一张默认定妆"
        disabled={p.generating}
        onClick={p.onCostumeScan} />

      <ActionRow icon={<Shirt size={13} />} cost="free"
        title="AI 识别造型阶段"
        desc="逐集扫剧本，识别每个角色在哪些镜头换了什么装扮；已出图的造型不会被改动"
        disabled={p.generating || p.stagesDrafting}
        onClick={p.onStagesDraft} />

      <ActionRow icon={<Wand2 size={13} />} cost="free"
        title="按资产重写提示词"
        desc={stat.draftPrompt > 0
          ? `${stat.draftPrompt} 个镜头仍是拆解初稿（服装/人称靠猜），建议重写`
          : "全部镜头提示词已与资产对齐"}
        badge={stat.draftPrompt > 0 ? String(stat.draftPrompt) : undefined}
        disabled={p.generating}
        onClick={() => p.onReprompt()} />

      <ActionRow icon={<ImageIcon size={13} />} cost="image"
        title="补齐资产图"
        desc="为缺定妆图的角色/场景生图。人物一致性靠它，缺图直接出片会漂"
        disabled={p.generating}
        onClick={p.onFillAssets} />

      <ActionRow icon={<ImageIcon size={13} />} cost="image"
        title="批量生成首帧"
        desc={stat.noFrame > 0
          ? `${stat.noFrame} 个镜头缺首帧。先审图再出片，构图不对可及时止损`
          : "所有镜头已有首帧"}
        badge={stat.noFrame > 0 ? String(stat.noFrame) : undefined}
        disabled={p.generating || stat.noFrame === 0}
        onClick={() => p.onFirstFrames()} />

      <ActionRow icon={<Film size={13} />} cost="video"
        title={tier === "final" ? "精品生成待出片镜头" : "生成待出片镜头"}
        desc={stat.pending > 0
          ? `${stat.pending} 个镜头待生成`
          : "所有镜头已出片"}
        badge={stat.pending > 0 ? String(stat.pending) : undefined}
        disabled={p.generating || !pendingIds.length}
        onClick={() => p.onGenerate(pendingIds)} />

      {/* ---- 需要关注的镜头 ---- */}
      {(stat.failed > 0 || stat.stale > 0) && (
        <>
          <div className="fw-vp-sec">需要关注</div>
          {stat.stale > 0 && (
            <div className="fw-vp-alert">
              <AlertTriangle size={12} />
              <span>{stat.stale} 个已出片镜头的参考资产被改过，建议重新生成</span>
              <button disabled={p.generating}
                onClick={() => p.onGenerate(
                  p.shots.filter((s) => s.refs_stale && s.video_url).map((s) => s.id))}>
                重生成
              </button>
            </div>
          )}
          {failedShots.length > 0 && (
            <div className="fw-vp-failed">
              {/* 按失败原因分流：内容审核拒绝的镜头，用同一提示词重试**必然再被拒**，
                  给「全部重试」按钮是错误引导（实测一个项目 40 个失败里 39 个是审核）。
                  只有渠道/网络故障才值得重试。 */}
              {moderationShots.length > 0 && (
                <div className="fw-vp-alert warn">
                  <AlertTriangle size={12} />
                  <span>
                    {moderationShots.length} 个镜头被内容审核拒绝
                    <em>——重试无效，需改提示词或换模型</em>
                  </span>
                </div>
              )}
              {retryableShots.length > 0 && (
                <div className="fw-vp-alert danger">
                  <AlertTriangle size={12} />
                  <span>{retryableShots.length} 个镜头因渠道故障失败</span>
                  <button disabled={p.generating}
                    onClick={() => p.onGenerate(retryableShots.map((s) => s.id))}>
                    重试这些
                  </button>
                </div>
              )}
              <div className="fw-vp-failed-list">
                {failedShots.slice(0, 8).map((s) => (
                  <button key={s.id}
                    className={`fw-vp-failed-chip ${s.fail_kind === "moderation" ? "mod" : ""}`}
                    onClick={() => p.onSelectShot(s)}
                    title={s.fail_reason
                      ? `${s.fail_kind === "moderation" ? "内容审核拒绝" : "生成失败"}：${s.fail_reason}`
                      : "点击定位到该镜头"}>
                    #{s.order}
                  </button>
                ))}
                {failedShots.length > 8 && (
                  <span className="fw-vp-failed-more">+{failedShots.length - 8}</span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ---- 高级：模型细节收在这里（PLAN §15）---- */}
      <button className="fw-vp-adv-head" onClick={() => setAdvOpen((v) => !v)}>
        {advOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 高级设置
      </button>
      {advOpen && (
        <div className="fw-vp-adv">
          <Row k="生成模式" v={productionModeLabel(p.productionMode)} />
          <Row k="视频模型" v={p.videoModel ?? "跟随项目默认"} />
          <Row k="当前质量档" v={tier === "final" ? "◆ 精品" : "⚡ 快速验证"} />
          <div className="fw-vp-adv-note">
            模型、分辨率、生成模式的逐镜覆盖在 Inspector 的「高级设置」中修改；
            项目级默认在新建项目时选择。
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- 动作行 ---- */
function ActionRow({ icon, title, desc, cost, badge, disabled, onClick }: {
  icon: React.ReactNode; title: string; desc: string;
  cost: "free" | "image" | "video";
  badge?: string; disabled?: boolean; onClick: () => void;
}) {
  const costLabel = { free: "不花钱", image: "出图", video: "出片" }[cost];
  return (
    <button className={`fw-vp-action cost-${cost}`} disabled={disabled} onClick={onClick}>
      <span className="fw-vp-action-ico">{icon}</span>
      <span className="fw-vp-action-main">
        <span className="fw-vp-action-title">
          {title}
          {badge && <span className="fw-vp-action-badge">{badge}</span>}
        </span>
        <span className="fw-vp-action-desc">{desc}</span>
      </span>
      <span className={`fw-vp-cost ${cost}`}>{costLabel}</span>
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="fw-vp-row"><span>{k}</span><span>{v}</span></div>;
}
