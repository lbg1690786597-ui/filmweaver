/**
 * Inspector — 右侧属性检查器（PLAN §7）
 *
 * Phase 1：建立分区骨架 + 选中态响应。真正的属性编辑器（位置/缩放/速度/
 * 淡入淡出等）在 Phase 3 填充，AI 版本管理在 Phase 3/4。
 *
 * 现在能显示的都是**后端已有数据**（镜头状态/提示词状态/参考资产/首帧/版本号），
 * 不是假数据——先让"选中就能看到这个镜头的全部信息"这件事成立。
 */

import { useState, useEffect } from "react";
import {
  Layers, Clock, Volume2, Sparkles, Info, ImageIcon, RefreshCw, Gem, History,
  Scissors, Undo2,
} from "lucide-react";
import type { ShotInfo, TransformMeta, AssetInfo } from "../../api";
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
  /** 项目已有的角色/场景资产——拆解编辑时从这里选，不让用户手打
   *  （手打的名字对不上资产库就注入不到参考图，等于白填） */
  assets: AssetInfo[];
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
  /** 修正镜头拆解结果（script_ref / 角色 / 场景 / 连接方式） */
  onPatchBreakdown: (shotId: string, patch: {
    scriptRef?: string; characters?: string[];
    location?: string; linkToPrev?: "continuous" | "transition";
  }) => Promise<void>;
  /** 保存手改的提示词（后端同时写 profile_override.prompt 保证真的下发） */
  onPatchPrompt: (shotId: string, prompt: string) => Promise<void>;
  /** 撤销手改，交还给 AI 重新优化 */
  onResetPrompt: (shotId: string) => Promise<void>;
  /** 按当前拆解与资产重算本镜提示词（异步 job） */
  onRepromptOne: (shotId: string) => void;
  onToast: (m: string) => void;
}

export default function Inspector(p: InspectorProps) {
  const [tab, setTab] = useState<Tab>("ai");

  // 拆解编辑本地状态
  const [bdScript, setBdScript] = useState("");
  const [bdChars, setBdChars] = useState<string[]>([]);
  const [bdLoc, setBdLoc] = useState("");
  const [bdLink, setBdLink] = useState<"continuous" | "transition">("continuous");
  const [bdDirty, setBdDirty] = useState(false);
  const [bdSaving, setBdSaving] = useState(false);

  // 提示词编辑本地状态
  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);

  // 选中镜头变化时同步到编辑状态
  const sid = p.shot?.id ?? null;
  useEffect(() => {
    if (!p.shot) return;
    setBdScript(p.shot.script_ref ?? "");
    setBdChars([...p.shot.characters]);
    setBdLoc(p.shot.location ?? "");
    setBdLink((p.shot.link_to_prev as "continuous" | "transition") ?? "continuous");
    setBdDirty(false);
    setPrompt(p.shot.gen_prompt ?? "");
    setPromptDirty(false);
  }, [sid]);  // 只在镜头切换时重置，不跟随 prop 更新（避免在用户输入时被刷掉）

  const saveBd = async () => {
    if (!p.shot || !bdDirty) return;
    setBdSaving(true);
    try {
      await p.onPatchBreakdown(p.shot.id, {
        scriptRef: bdScript, characters: bdChars,
        location: bdLoc, linkToPrev: bdLink,
      });
      setBdDirty(false);
      p.onToast("拆解已保存");
    } catch (e) { p.onToast(String(e)); }
    finally { setBdSaving(false); }
  };

  const savePrompt = async () => {
    if (!p.shot || !promptDirty) return;
    setPromptSaving(true);
    try {
      await p.onPatchPrompt(p.shot.id, prompt);
      setPromptDirty(false);
      p.onToast("提示词已保存（已锁定，不会被 AI 重写）");
    } catch (e) { p.onToast(String(e)); }
    finally { setPromptSaving(false); }
  };

  const resetPrompt = async () => {
    if (!p.shot) return;
    try {
      await p.onResetPrompt(p.shot.id);
      setPromptDirty(false);
      p.onToast("已解锁，下次生成时 AI 重新优化提示词");
    } catch (e) { p.onToast(String(e)); }
  };

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

  // 拆解编辑的可选项：只给资产库里真实存在的名字。
  // 手打的名字对不上资产库就注入不到参考图，等于白填——所以不给自由输入。
  const charOptions = p.assets.filter((a) => a.kind === "character").map((a) => a.name);
  const locOptions = p.assets.filter((a) => a.kind === "location").map((a) => a.name);

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
              {/* 失败原因：此前只有一个红色"失败"角标，用户不知道为什么失败，
                  也分不清重试有没有用。原因存在 job 的 error JSON 里，只有查库才看得到。 */}
              {s.status === "failed" && s.fail_reason && (
                <div className={`fw-insp-alert ${s.fail_kind === "moderation" ? "" : "danger"}`}>
                  <div className="fw-insp-fail-head">
                    {s.fail_kind === "moderation" ? "⚠ 内容审核拒绝" : "✕ 生成失败"}
                  </div>
                  <div className="fw-insp-fail-body">{s.fail_reason}</div>
                  {s.fail_kind === "moderation" && (
                    <div className="fw-insp-fail-hint">
                      用同一提示词重试必然再次被拒。可改写提示词、更换生图/视频模型，
                      或减少参考图数量后重试。
                    </div>
                  )}
                </div>
              )}
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

            <Section title="镜头拆解" Icon={Scissors}>
              {/* AI 拆镜难免有偏差（并错镜、认错角色、场景名写岔）。
                  此前只能重跑整集拆解，会把已调好的其他镜头一起冲掉——现在可单镜改。 */}
              <div className="fw-insp-field">
                <span className="fw-insp-field-label">剧本片段（提示词的原始依据）</span>
                <textarea className="fw-insp-ta" value={bdScript}
                  onChange={(e) => { setBdScript(e.target.value); setBdDirty(true); }}
                  placeholder="这一镜对应的剧本内容" />
              </div>

              <div className="fw-insp-field">
                <span className="fw-insp-field-label">出场角色（决定注入哪些定妆图）</span>
                <div className="fw-insp-taglist">
                  {bdChars.map((c) => (
                    <span key={c} className="fw-insp-tag">
                      {c}
                      <button title="移除" onClick={() => {
                        setBdChars(bdChars.filter((x) => x !== c)); setBdDirty(true);
                      }}>×</button>
                    </span>
                  ))}
                  <select className="fw-insp-tag-add"
                    value=""
                    onChange={(e) => {
                      const n = e.target.value;
                      if (n && !bdChars.includes(n)) {
                        setBdChars([...bdChars, n]); setBdDirty(true);
                      }
                    }}>
                    <option value="">+ 添加</option>
                    {charOptions.filter((c) => !bdChars.includes(c)).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="fw-insp-field">
                <span className="fw-insp-field-label">场景</span>
                <select className="fw-insp-input" value={bdLoc}
                  onChange={(e) => { setBdLoc(e.target.value); setBdDirty(true); }}>
                  <option value="">(无)</option>
                  {locOptions.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                  {bdLoc && !locOptions.includes(bdLoc) && (
                    <option value={bdLoc}>{bdLoc}（当前值）</option>
                  )}
                </select>
              </div>

              <div className="fw-insp-field">
                <span className="fw-insp-field-label">
                  与上一镜的关系（连续=同一场戏顺下来；转场=换场景或时间跳跃）
                </span>
                <div className="fw-insp-seg">
                  {(["continuous", "transition"] as const).map((v) => (
                    <button key={v} className={bdLink === v ? "on" : ""}
                      onClick={() => { setBdLink(v); setBdDirty(true); }}>
                      {v === "continuous" ? "连续" : "转场"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="fw-insp-sec-acts">
                <button className="primary" disabled={!bdDirty || bdSaving}
                  onClick={saveBd}>
                  {bdSaving ? "保存中…" : "保存拆解"}
                </button>
                <button disabled={bdDirty}
                  title={bdDirty ? "请先保存拆解，否则重算用的还是旧内容"
                    : "按当前拆解与已有资产重新生成提示词（调文本模型，不出图不出片）"}
                  onClick={() => p.onRepromptOne(s.id)}>
                  <RefreshCw size={12} /> 重新生成提示词
                </button>
              </div>
              {bdDirty && (
                <div className="fw-insp-dirty">
                  有未保存的改动。保存后再点「重新生成提示词」才会用新内容。
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

            <Section title="提示词" Icon={Info}>
              {/* 可直接编辑。保存后走 profile_override.prompt——只写 gen_prompt
                  的话，有参考图时会被 AI 重新优化覆盖（jobs.py:983 那条分支）。 */}
              <textarea className="fw-insp-ta prompt" value={prompt}
                onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void savePrompt();
                }}
                placeholder={s.gen_prompt ? "" : "尚未生成提示词。可先点上方「重新生成提示词」，或直接在这里手写。"} />
              <div className="fw-insp-sec-acts">
                <button className="primary" disabled={!promptDirty || promptSaving}
                  onClick={savePrompt}
                  title="保存后本镜提示词被锁定，生成时原样下发，不会被 AI 重写（Ctrl+Enter）">
                  {promptSaving ? "保存中…" : "保存提示词"}
                </button>
                {s.prompt_state === "manual" && (
                  <button onClick={resetPrompt}
                    title="解除锁定，下次生成时由 AI 按当前资产重新优化">
                    <Undo2 size={12} /> 交还 AI
                  </button>
                )}
              </div>
              {s.prompt_state === "manual" && (
                <div className="fw-insp-dirty">
                  已锁定为手动稿：生成时原样下发，AI 不会改写。
                </div>
              )}
            </Section>

            <Section title="版本" Icon={History}>
              <VersionList shot={s} onSwitchVersion={p.onSwitchVersion} onToast={p.onToast} />
            </Section>

            {/* 说明写在界面上而不只挂 tooltip——这两个按钮都花钱。
                只留"做什么"，细节交给按钮自己的 title。 */}
            <div className="fw-insp-note">
              <b>变体</b>：同词换个种子，画面不同。
              <b>精品</b>：换 Seedance 2.0 重出，更好更贵。
              都不覆盖原版本。
            </div>

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
