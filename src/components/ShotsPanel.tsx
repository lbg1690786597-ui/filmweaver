import { memo, useState } from "react";
import { api, ShotInfo } from "../api";

interface Props {
  shots: ShotInfo[];
  episodes: { order: number; title: string }[];
  selectedShotId: string | null;
  onSelect: (shot: ShotInfo) => void;
  onGenerate: (shotIds: string[]) => void;
  onSwitchVersion: (shot: ShotInfo, verNo: number) => void;  // 切版本=采用+同步时间轴
  onAdvanced: (shot: ShotInfo) => void;
  generating: boolean;
  // 拆解镜头并生成提示词（job；episodes 指定集=重拆）
  onBreakdown: (episodes?: number[]) => void;
  breakdownProgress: number | null;   // null=未进行
  hasScript: boolean;
}

const STATUS_META: Record<ShotInfo["status"], { label: string; cls: string }> = {
  pending:    { label: "待生成", cls: "st-pending" },
  prompting:  { label: "提示词", cls: "st-prompting" },
  generating: { label: "生成中", cls: "st-generating" },
  review:     { label: "待审核", cls: "st-review" },
  adopted:    { label: "已采用", cls: "st-adopted" },
  failed:     { label: "失败", cls: "st-failed" },
};

/** 单镜卡（memo：展开/选中只重渲染受影响的卡）。版本切换=采用（无独立采用按钮）。 */
const ShotCard = memo(function ShotCard(props: {
  s: ShotInfo; selected: boolean; multiSelected: boolean; expanded: boolean;
  generating: boolean;
  onSelect: (s: ShotInfo) => void; onToggleSel: (id: string) => void;
  onToggleExpand: (id: string) => void; onAdvanced: (s: ShotInfo) => void;
  onSwitchVersion: (s: ShotInfo, verNo: number) => void;
  onGenerate: (ids: string[]) => void;
}) {
  const { s } = props;
  const meta = STATUS_META[s.status];
  const [versions, setVersions] = useState<{ version_no: number; video_url: string | null; created_at: string | null }[] | null>(null);

  const loadVersions = async () => {
    try {
      const r = await api.shotVersions(s.id);
      setVersions(r.versions);
    } catch { setVersions([]); }
  };

  return (
    <div className={`sp-shot ${meta.cls} ${props.selected ? "sel" : ""} ${props.multiSelected ? "msel" : ""} ${s.stale ? "stale" : ""}`}>
      <div className="sp-shot-row"
        onClick={(e) => (e.ctrlKey || e.metaKey) ? props.onToggleSel(s.id) : props.onSelect(s)}>
        <div className={`sp-thumb sp-thumb-empty ${s.video_url ? "has-video" : ""}`}>
          {s.video_url ? "▶" : `#${s.order}`}
        </div>
        <div className="sp-shot-mid">
          <div className="sp-shot-title">#{s.order}
            <span className="sp-status">{meta.label}</span>
            {s.duration_sec != null && <span className="muted" style={{ fontSize: 10 }}>{s.duration_sec}s</span>}
            {s.stale && <span className="sp-stale-badge">已过期</span>}
            {s.profile_override && <span title="本镜有策略覆盖">⚙</span>}
            {/* 版本徽标：有历史版本时显示当前版本号，点击展开版本条 */}
            {(s.adopted_version ?? 0) > 1 && (
              <span className="sp-ver-badge" title="有多个历史版本">V{s.adopted_version}</span>
            )}
          </div>
          <div className="sp-ref">{s.script_ref}</div>
          {/* 版本切换条（展开详情时加载）：点 V1/V2 即切换采用并同步时间轴/预览 */}
          {props.expanded && versions && versions.length > 1 && (
            <div className="sp-versions" onClick={(e) => e.stopPropagation()}>
              🕘 {versions.map((v) => (
                <button key={v.version_no}
                  className={`sp-ver-btn ${s.adopted_version === v.version_no ? "on" : ""}`}
                  title={v.created_at ?? ""}
                  onClick={() => props.onSwitchVersion(s, v.version_no)}>
                  V{v.version_no}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="sp-ops" onClick={(e) => e.stopPropagation()}>
          <button title={props.expanded ? "收起" : "查看拆解/提示词/版本"}
            onClick={() => { props.onToggleExpand(s.id); if (!props.expanded) loadVersions(); }}>
            {props.expanded ? "▴" : "▾"}</button>
          <button title="高级设置" onClick={() => props.onAdvanced(s)}>⚙</button>
          {s.status !== "prompting" && s.status !== "generating" && (
            <button title={s.video_url ? "重新生成（旧版本自动保留可切换）" : "生成本镜"}
              onClick={() => props.onGenerate([s.id])}>{s.video_url ? "↻" : "▶"}</button>
          )}
        </div>
      </div>
      {props.expanded && (
        <div className="sp-detail">
          <div className="sp-detail-label">📄 拆解结果</div>
          <div className="sp-detail-text">{s.script_ref}</div>
          {(s.characters.length > 0 || s.location) && (
            <div className="muted" style={{ fontSize: 11 }}>
              {s.characters.length > 0 && <>角色：{s.characters.join("、")}　</>}
              {s.location && <>场景：{s.location}　</>}
              衔接：{s.link_to_prev === "continuous" ? "承接" : "转场"}
            </div>
          )}
          <div className="sp-detail-label">✨ 提示词</div>
          {s.gen_prompt
            ? <div className="sp-detail-text sp-prompt">{s.gen_prompt}</div>
            : <div className="muted" style={{ fontSize: 11 }}>尚未生成（点上方「拆解镜头并生成提示词」）</div>}
        </div>
      )}
    </div>
  );
});


/** 左侧「镜头」页签：拆解+提示词一键生成、按集分组、集级过期标记与重拆。 */
export default function ShotsPanel(p: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());

  const pendingIds = p.shots.filter((s) => !s.video_url).map((s) => s.id);

  const toggleExpand = (id: string) => setExpanded((prev) => (prev === id ? null : id));
  const toggleSel = (id: string) =>
    setMultiSel((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const byEpisode = new Map<number, ShotInfo[]>();
  for (const s of p.shots) {
    const arr = byEpisode.get(s.episode) ?? [];
    arr.push(s);
    byEpisode.set(s.episode, arr);
  }
  const breakingDown = p.breakdownProgress !== null;

  return (
    <div className="sp">
      <div className="sp-head" style={{ flexWrap: "wrap" }}>
        {/* 阶段一：拆解镜头并生成提示词（按项目模型设定，job 实时刷新） */}
        <button className="btn primary" style={{ flex: "1 1 100%" }}
          disabled={!p.hasScript || breakingDown || p.generating}
          onClick={() => p.onBreakdown()}>
          {breakingDown ? `⏳ 正在生成分镜和提示词 ${p.breakdownProgress}%`
            : p.shots.length ? "🎞 补拆未处理的集" : "🎞 拆解镜头并生成提示词"}
        </button>
        {/* 阶段二：生成视频（后端全局并发池排队，可连续多次提交互不阻塞） */}
        <button className="btn" style={{ flex: 1 }}
          disabled={breakingDown || !pendingIds.length}
          onClick={() => p.onGenerate(pendingIds)}>
          ▶ 全部生成视频 ({pendingIds.length})
        </button>
        {multiSel.size > 0 && (
          <button className="btn tiny"
            onClick={() => { p.onGenerate([...multiSel]); setMultiSel(new Set()); }}>
            ↻ 选中{multiSel.size}镜
          </button>
        )}
      </div>
      {!p.shots.length && !breakingDown && (
        <div className="muted pad">
          {p.hasScript ? "点上方按钮开始拆解" : "先在「📝 剧本」页导入剧本"}
        </div>
      )}
      <div className="sp-list">
        {[...byEpisode.entries()].sort((a, b) => a[0] - b[0]).map(([ep, shots]) => {
          const staleCount = shots.filter((s) => s.stale).length;
          return (
            <div key={ep} className={staleCount ? "sp-epi stale" : "sp-epi"}>
              <div className="sp-ep">
                <span>{p.episodes.find((e) => e.order === ep)?.title ?? `第${ep}集`}</span>
                {staleCount > 0 && (
                  <>
                    <span className="sp-stale-badge">已过期（剧本有改动）</span>
                    <button className="btn tiny" disabled={breakingDown || p.generating}
                      onClick={() => p.onBreakdown([ep])}>↻ 重新拆解本集</button>
                  </>
                )}
              </div>
              {shots.map((s) => (
                <ShotCard key={s.id} s={s}
                  selected={p.selectedShotId === s.id}
                  multiSelected={multiSel.has(s.id)}
                  expanded={expanded === s.id}
                  generating={p.generating}
                  onSelect={p.onSelect} onToggleSel={toggleSel}
                  onToggleExpand={toggleExpand} onAdvanced={p.onAdvanced}
                  onSwitchVersion={p.onSwitchVersion} onGenerate={p.onGenerate} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

