/**
 * Inspector — 右侧属性检查器（PLAN §7）
 *
 * Phase 1：建立分区骨架 + 选中态响应。真正的属性编辑器（位置/缩放/速度/
 * 淡入淡出等）在 Phase 3 填充，AI 版本管理在 Phase 3/4。
 *
 * 现在能显示的都是**后端已有数据**（镜头状态/提示词状态/参考资产/首帧/版本号），
 * 不是假数据——先让"选中就能看到这个镜头的全部信息"这件事成立。
 */

import { useState } from "react";
import {
  Layers, Clock, Volume2, Sparkles, Info, ImageIcon, RefreshCw, Gem, History,
} from "lucide-react";
import type { ShotInfo, TransformMeta } from "../../api";
import { api } from "../../api";
import { shotDuration } from "../../adapters/shotToClip";
import ClipProperties from "./ClipProperties";
import VersionList from "./VersionList";
import "./Inspector.css";

type Tab = "basic" | "time" | "audio" | "ai";

const TABS: { id: Tab; label: string; Icon: typeof Layers }[] = [
  { id: "basic", label: "基础", Icon: Layers },
  { id: "time", label: "时间", Icon: Clock },
  { id: "audio", label: "音频", Icon: Volume2 },
  { id: "ai", label: "AI", Icon: Sparkles },
];

const PROMPT_STATE_LABEL: Record<string, { text: string; cls: string }> = {
  draft: { text: "拆解初稿", cls: "warn" },
  aligned: { text: "已按资产对齐", cls: "ok" },
  sent: { text: "已下发生成", cls: "ok" },
  manual: { text: "手动填写", cls: "info" },
};

export interface InspectorProps {
  shot: ShotInfo | null;
  projectTitle: string;
  baseAspect?: string;
  shotCount: number;
  doneCount: number;
  totalSec: number;
  onRegenerate: (shotIds: string[]) => void;
  onOpenAdvanced: (s: ShotInfo) => void;
  /** TB-05：换一个 seed 再生成一版 */
  onGenerateVariant: (s: ShotInfo) => void;
  /** 精品升级：用 Seedance 2.0 重生成（落成新版本，不覆盖） */
  onUpgrade: (s: ShotInfo) => void;
  /** Phase 3：时长编辑（后端 patch_shot_timeline，1-15s 钳制） */
  onPatchDuration: (shotId: string, sec: number) => void;
  /** TB-03/TB-10：保存画面与音频调整（传 {} 清空） */
  onPatchTransform: (shotId: string, tm: TransformMeta | Record<string, never>) => void;
  /** Phase 3：版本切换（后端 adopt） */
  onSwitchVersion: (shot: ShotInfo, verNo: number) => void;
  onToast: (m: string) => void;
}

export default function Inspector(p: InspectorProps) {
  const [tab, setTab] = useState<Tab>("ai");

  if (!p.shot) {
    return (
      <>
        <div className="fw-insp-head"><span className="fw-insp-title">项目信息</span></div>
        <div className="fw-insp-body">
          <Section title="概览" Icon={Info}>
            <Row label="项目" value={p.projectTitle} />
            <Row label="比例" value={p.baseAspect ?? "-"} />
            <Row label="镜头总数" value={String(p.shotCount)} />
            <Row label="已生成" value={`${p.doneCount} / ${p.shotCount}`} />
            <Row label="时长" value={`${Math.floor(p.totalSec / 60)}分${Math.round(p.totalSec % 60)}秒`} />
          </Section>
          <div className="fw-insp-tip">
            在时间轴或分镜列表中选中一个镜头，这里显示它的全部属性
          </div>
        </div>
      </>
    );
  }

  const s = p.shot;
  const ps = s.prompt_state ? PROMPT_STATE_LABEL[s.prompt_state] : null;
  const ov = s.ref_overrides ?? {};
  const rm = new Set(ov.remove ?? []);
  const chars = [...s.characters, ...(ov.add ?? [])].filter((c) => !rm.has(c));
  const rmLoc = new Set(ov.remove_loc ?? []);
  const locs = [...(s.location ? [s.location] : []), ...(ov.add_loc ?? [])]
    .filter((c) => !rmLoc.has(c));

  return (
    <>
      <div className="fw-insp-head">
        <span className="fw-insp-title">
          {s.is_special ? (s.special_name || "外部素材") : `镜头 #${s.order}`}
        </span>
        <span className={`fw-insp-status ${s.status}`}>{s.status}</span>
      </div>

      <div className="fw-insp-tabs">
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} className={`fw-insp-tab ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)} title={label}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      <div className="fw-insp-body">
        {tab === "ai" && (
          <>
            <Section title="生成信息" Icon={Sparkles}>
              <Row label="当前版本"
                value={s.adopted_version != null ? `V${s.adopted_version}` : "尚未生成"} />
              <Row label="所属集" value={`第 ${s.episode} 集`} />
              <Row label="提示词状态"
                value={ps ? <span className={`fw-insp-chip ${ps.cls}`}>{ps.text}</span> : "-"} />
              {s.refs_stale && (
                <div className="fw-insp-alert">
                  ↻ 参考图已变更，建议重新生成本镜
                </div>
              )}
              {s.stale && (
                <div className="fw-insp-alert">
                  ⚠ 所属集剧本已修改，本镜拆解已过期
                </div>
              )}
            </Section>

            <Section title="参考资产" Icon={ImageIcon}>
              {chars.length === 0 && locs.length === 0 ? (
                <div className="fw-insp-empty">本镜无参考资产注入</div>
              ) : (
                <div className="fw-insp-chips">
                  {chars.map((c) => (
                    <span key={c} className="fw-insp-chip char">👤 {c}</span>
                  ))}
                  {locs.map((l) => (
                    <span key={l} className="fw-insp-chip loc">📍 {l}</span>
                  ))}
                </div>
              )}
            </Section>

            {s.first_frame_url && (
              <Section title="首帧" Icon={ImageIcon}>
                <img className="fw-insp-thumb" src={api.mediaUrl(s.first_frame_url)}
                  alt="首帧" loading="lazy" />
              </Section>
            )}

            {s.gen_prompt && (
              <Section title="提示词" Icon={Info}>
                <div className="fw-insp-prompt">{s.gen_prompt}</div>
              </Section>
            )}

            <Section title="版本" Icon={History}>
              <VersionList shot={s} onSwitchVersion={p.onSwitchVersion} onToast={p.onToast} />
            </Section>

            <div className="fw-insp-actions">
              <button className="fw-insp-act" onClick={() => p.onRegenerate([s.id])}>
                <RefreshCw size={13} /> 重新生成
              </button>
              <button className="fw-insp-act" onClick={() => p.onOpenAdvanced(s)}>
                <Layers size={13} /> 高级设置
              </button>
              <button className="fw-insp-act"
                title="用一个新的随机种子再生成一版（同提示词、不同画面），可在版本列表对比"
                onClick={() => p.onGenerateVariant(s)}>
                <Sparkles size={13} /> 生成变体
              </button>
              <button className="fw-insp-act"
                title="用 Seedance 2.0 重新生成一版（不覆盖现有版本，可在版本列表对比）"
                onClick={() => p.onUpgrade(s)}>
                <Gem size={13} /> 精品升级
              </button>
            </div>
          </>
        )}

        {tab === "time" && (
          <ClipProperties tab="time" shotId={s.id} durationSec={shotDuration(s)}
            order={s.order} disabled={s.disabled}
            transform={s.transform_meta ?? null}
            isOverlay={(s.track_index ?? 0) > 0}
            onPatchDuration={(sec) => p.onPatchDuration(s.id, sec)}
            onPatchTransform={(tm) => p.onPatchTransform(s.id, tm)}
            onToast={p.onToast} />
        )}

        {tab === "basic" && (
          <ClipProperties tab="basic" shotId={s.id} durationSec={shotDuration(s)}
            order={s.order} disabled={s.disabled}
            transform={s.transform_meta ?? null}
            isOverlay={(s.track_index ?? 0) > 0}
            onPatchDuration={(sec) => p.onPatchDuration(s.id, sec)}
            onPatchTransform={(tm) => p.onPatchTransform(s.id, tm)}
            onToast={p.onToast} />
        )}

        {tab === "audio" && (
          <ClipProperties tab="audio" shotId={s.id} durationSec={shotDuration(s)}
            order={s.order} disabled={s.disabled}
            transform={s.transform_meta ?? null}
            isOverlay={(s.track_index ?? 0) > 0}
            onPatchDuration={(sec) => p.onPatchDuration(s.id, sec)}
            onPatchTransform={(tm) => p.onPatchTransform(s.id, tm)}
            onToast={p.onToast} />
        )}
      </div>
    </>
  );
}

/* ---- 内部小组件 ---- */

function Section({ title, Icon, children }: {
  title: string; Icon: typeof Layers; children: React.ReactNode;
}) {
  return (
    <section className="fw-insp-sec">
      <div className="fw-insp-sec-head"><Icon size={12} /> {title}</div>
      <div className="fw-insp-sec-body">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="fw-insp-row">
      <span className="fw-insp-k">{label}</span>
      <span className="fw-insp-v">{value}</span>
    </div>
  );
}
