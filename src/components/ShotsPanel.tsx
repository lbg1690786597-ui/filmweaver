import { memo, useCallback, useEffect, useState } from "react";
import { api, ApiError, JobPhase, Readiness, ShotInfo } from "../api";
import PreflightDialog from "./PreflightDialog";

interface Props {
  projectId: string;
  shots: ShotInfo[];
  episodes: { order: number; title: string }[];
  selectedShotId: string | null;
  /** 定位线所在镜头 order：对应卡片高亮 + 自动滚入视区 */
  cursorOrder?: number | null;
  onSelect: (shot: ShotInfo) => void;
  onGenerate: (shotIds: string[]) => void;
  onSwitchVersion: (shot: ShotInfo, verNo: number) => void;  // 切版本=采用+同步时间轴
  onAdvanced: (shot: ShotInfo) => void;
  generating: boolean;
  /** 在跑的生产 job 的当前阶段。i2va 出片是「整批先出首帧、再逐镜出视频」两段，
   *  不把它显示出来，前几分钟只有"已出片 0/170"，用户会以为点了没反应而重复提交 */
  jobPhase?: JobPhase | null;
  // 拆解镜头并生成提示词（job；episodes 指定集=重拆）
  onBreakdown: (episodes?: number[]) => void;
  breakdownProgress: number | null;   // null=未进行
  hasScript: boolean;
  /** 批量首帧（job）。shotIds 缺省=补齐所有缺首帧的镜头 */
  onFirstFrames: (shotIds?: string[]) => void;
  /** 按当前资产重写提示词（job，纯文本不出图不出片）。shotIds 缺省=全部镜头 */
  onReprompt: (shotIds?: string[]) => void;
  /** 一条龙（job）：资产 → 全部首帧 → 全部片段。
   *  stopAfter="assets" 只补资产（人物一致性的前置条件），"frames" 补到首帧为止 */
  onPipeline: (opts: { genAssets: boolean;
                       stopAfter?: "assets" | "frames" }) => void;
  /** 跳到「🎨 资产」页签（步骤②的手动出口） */
  onGotoAssets: () => void;
  /** 全剧服装识别（job）：纯文本调用 LLM 逐集扫服装，**不出图、不花生图的钱**。
   *  必须跑在补图之前——没跑过时"缺失资产 N"只是"没有定妆图的角色数"。 */
  onCostumeScan: () => void;
  onToast: (m: string) => void;
}

const STATUS_META: Record<ShotInfo["status"], { label: string; cls: string }> = {
  pending:    { label: "待生成", cls: "st-pending" },
  prompting:  { label: "提示词", cls: "st-prompting" },
  generating: { label: "生成中", cls: "st-generating" },
  review:     { label: "待审核", cls: "st-review" },
  adopted:    { label: "已采用", cls: "st-adopted" },
  failed:     { label: "失败", cls: "st-failed" },
};

/** 提示词这一稿是怎么来的（后端 Shot.prompt_state）。卡片上必须标出来——
 *  拆解时写的初稿是"资产还没生成时凭剧本猜的"，与最终下发稿常常不是一回事，
 *  以前用户看到的一直是初稿，却以为那就是喂给视频模型的词。 */
const PROMPT_STATE: Record<string, { label: string; cls: string; tip: string }> = {
  draft:   { label: "初稿", cls: "st-pending", tip: "拆解时生成：那会儿资产还没出图，服装与人称都是照剧本猜的" },
  aligned: { label: "已对齐资产", cls: "st-review", tip: "已按当前定妆图/造型描述重写过" },
  sent:    { label: "已下发", cls: "st-adopted", tip: "出片时实际发给视频模型的最终稿" },
  manual:  { label: "手填", cls: "st-prompting", tip: "你在「⚙ 高级设置」里手填的词，自动改写一律让位于它" },
};

/** 被内容审核拒绝后的「换个厂商再试」候选。
 *  各家审核模型独立、尺度不同——实测同一段提示词 gpt-image-2 双渠道全拒、
 *  nano-banana-pro（Gemini）正常出图，所以换模型是真能解决问题的一步，
 *  而不是安慰性重试。按跨厂商优先排序，展示时会剔除当前项目已在用的那个。 */
const ALT_IMAGE_MODELS = [
  { key: "nano-banana-pro", label: "Nano Banana Pro", icon: "🍌", hint: "Gemini 系，审核口径与 OpenAI 系不同" },
  { key: "gpt-image-2",     label: "GPT Image",       icon: "🖼", hint: "OpenAI 系，通用稳" },
  { key: "z-image",         label: "Z-Image",         icon: "👤", hint: "人像专用" },
];

/** 单镜卡（memo：展开/选中只重渲染受影响的卡）。版本切换=采用（无独立采用按钮）。 */
const ShotCard = memo(function ShotCard(props: {
  s: ShotInfo; selected: boolean; multiSelected: boolean; expanded: boolean;
  generating: boolean; atCursor: boolean;
  /** 项目当前生效的生图模型：换模型重试时用来剔除"换成自己"这种无效选项 */
  imageModel?: string | null;
  onSelect: (s: ShotInfo) => void; onToggleSel: (id: string) => void;
  onToggleExpand: (id: string) => void; onAdvanced: (s: ShotInfo) => void;
  onSwitchVersion: (s: ShotInfo, verNo: number) => void;
  onGenerate: (ids: string[]) => void;
  onReprompt: (ids: string[]) => void;
}) {
  const { s } = props;
  const meta = STATUS_META[s.status];
  const [versions, setVersions] = useState<{ version_no: number; video_url: string | null; created_at: string | null }[] | null>(null);
  // 首帧图：本地态覆盖 props（重生后立即反映，不等整树刷新）
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [ffBusy, setFfBusy] = useState(false);
  const [ffErr, setFfErr] = useState("");
  // 失败原因分类：moderation=内容审核拒绝（重试无效，要改词/换模型）；其余=渠道故障（可重试）
  const [ffErrReason, setFfErrReason] = useState<string | undefined>();
  const ff = firstFrame ?? s.first_frame_url;

  const loadVersions = async () => {
    try {
      const r = await api.shotVersions(s.id);
      setVersions(r.versions);
    } catch { setVersions([]); }
  };

  /** 生成/重生首帧。regenAnchor=true 连带重建场景基准帧（影响同场景其他镜头）。
   *  imageModel 显式指定时覆盖项目预设——用于「被审核拒绝后换个模型再试」：
   *  各厂商审核尺度不同，实测 gpt-image-2 双渠道全拒的提示词 Gemini 系可正常出图。 */
  const genFirstFrame = async (regenAnchor: boolean, imageModel?: string) => {
    setFfBusy(true); setFfErr(""); setFfErrReason(undefined);
    try {
      const r = await api.regenFirstFrame(s.id, { regenAnchor, imageModel });
      setFirstFrame(r.first_frame_url);
    } catch (e) {
      const err = e as ApiError;
      setFfErr(err?.message ?? String(e));
      setFfErrReason(err?.reason);
    }
    setFfBusy(false);
  };

  return (
    <div className={`sp-shot ${meta.cls} ${props.selected ? "sel" : ""} ${props.multiSelected ? "msel" : ""} ${props.atCursor ? "at-cursor" : ""} ${s.stale ? "stale" : ""}`}
      data-shot-order={s.order}>
      <div className="sp-shot-row"
        onClick={(e) => (e.ctrlKey || e.metaKey) ? props.onToggleSel(s.id) : props.onSelect(s)}>
        <div className={`sp-thumb sp-thumb-empty ${s.video_url ? "has-video" : ""}`}>
          {s.video_url ? "▶" : (ff
            ? <img src={api.mediaUrl(ff)} alt={`镜头 #${s.order} 首帧`}
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 4 }} />
            : `#${s.order}`)}
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
          <div className="sp-detail-label">
            ✨ 提示词
            {s.gen_prompt && (() => {
              const ps = PROMPT_STATE[s.prompt_state ?? "draft"] ?? PROMPT_STATE.draft;
              return <span className={`sp-status ${ps.cls}`} title={ps.tip}
                style={{ marginLeft: 6 }}>{ps.label}</span>;
            })()}
            {s.gen_prompt && s.prompt_state !== "manual" && (
              <button className="btn tiny" style={{ marginLeft: 6 }}
                disabled={props.generating}
                title="按当前定妆图与造型描述重写本镜提示词（只调文本模型，不出图不出片）"
                onClick={() => props.onReprompt([s.id])}>✨ 按资产重写</button>
            )}
          </div>
          {s.gen_prompt
            ? <div className="sp-detail-text sp-prompt">{s.gen_prompt}</div>
            : <div className="muted" style={{ fontSize: 11 }}>尚未生成（点上方「拆解镜头并生成提示词」）</div>}

          {/* 首帧图（i2va 路线）：先审首帧再出视频——首帧几毛、视频几块，
              场景偏移在首帧就能看出来，不必等视频跑完 */}
          <div className="sp-detail-label">🎬 首帧图</div>
          {ff ? (
            <img src={api.mediaUrl(ff)} alt={`镜头 #${s.order} 首帧`}
              style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 6, display: "block" }} />
          ) : (
            <div className="muted" style={{ fontSize: 11 }}>
              尚无首帧（「首帧精控」项目生成时自动产出，或点下方按钮先出一张）
            </div>
          )}
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button className="btn tiny" disabled={ffBusy}
              title="用角色/场景资产 + 场景基准帧生成本镜首帧（不出视频）"
              onClick={() => genFirstFrame(false)}>
              {ffBusy ? "生成中…" : (ff ? "↻ 重生首帧" : "🎬 生成首帧")}
            </button>
            {s.location && (
              <button className="btn tiny" disabled={ffBusy}
                title={`重建场景「${s.location}」的基准帧——该基准决定本场景所有镜头的陈设与光线基调，重建会影响同场景后续镜头`}
                onClick={() => genFirstFrame(true)}>
                🖼 重建场景基准
              </button>
            )}
          </div>
          {/* 失败原因分流：内容审核 ≠ 渠道故障。审核拒绝时重试同一提示词必然同样被拒，
              所以不给「再试一次」，只给「换模型」和「改提示词」两条真能解决问题的路。 */}
          {ffErr && (ffErrReason === "moderation" ? (
            <div className="err" style={{ fontSize: 11, marginTop: 6 }}>
              <div>🚫 {ffErr}</div>
              <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                {ALT_IMAGE_MODELS.filter((m) => m.key !== props.imageModel).slice(0, 2).map((m) => (
                  <button key={m.key} className="btn tiny" disabled={ffBusy}
                    title={`改用 ${m.label} 重试本镜首帧——${m.hint}`}
                    onClick={() => genFirstFrame(false, m.key)}>
                    {m.icon} 换 {m.label} 重试
                  </button>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                若换模型仍被拒，请到「⚙ 高级设置」弱化本镜提示词中的敏感描写后再生成。
              </div>
            </div>
          ) : (
            <div className="err" style={{ fontSize: 11, marginTop: 6 }}>{ffErr}</div>
          ))}
        </div>
      )}
    </div>
  );
});


/** 左侧「镜头」页签：拆解+提示词一键生成、按集分组、集级过期标记与重拆。 */
export default function ShotsPanel(p: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  // 步骤条数据（就绪度）：进入镜头页拉一次，之后跟着首帧/出片进度实时重拉
  const [rd, setRd] = useState<Readiness | null>(null);
  // 二次确认弹窗：videos=只出片，frames=只出首帧
  //（全链路「film」只在顶栏「▷ 一键成片」入口，本页不再重复提供）
  const [preflight, setPreflight] = useState<null | "videos" | "frames">(null);

  // 首帧/出片进度签名：_set_shot_first_frame 会推 SSE("shot")，App 据此刷新 detail，
  // 于是这两个计数会随每张首帧点亮而变 → 步骤条数字实时跟进，不必手动刷新页面。
  // （只依赖 shots.length 是不够的：批量生成首帧期间镜头数根本不变）
  const ffDone = p.shots.reduce((n, s) => n + (s.first_frame_url ? 1 : 0), 0);
  const videoDone = p.shots.reduce((n, s) => n + (s.video_url ? 1 : 0), 0);

  const loadRd = useCallback(() => {
    if (!p.projectId || !p.shots.length) { setRd(null); return; }
    api.projectReadiness(p.projectId).then(setRd).catch(() => { /* 抖动忽略，下次再拉 */ });
  }, [p.projectId, p.shots.length]);

  useEffect(() => { loadRd(); }, [loadRd, ffDone, videoDone, p.generating]);

  // 兜底：SSE 断线时签名不会变，job 运行期间每 5s 主动重拉一次（只读查询，很轻）
  useEffect(() => {
    if (!p.generating || !p.projectId) return;
    const t = window.setInterval(loadRd, 5000);
    return () => clearInterval(t);
  }, [p.generating, p.projectId, loadRd]);

  // 定位线联动：所在镜头卡自动滚入视区（居中，平滑）
  useEffect(() => {
    if (p.cursorOrder == null) return;
    const el = document.querySelector(`.sp-shot[data-shot-order="${p.cursorOrder}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.cursorOrder]);

  const pendingIds = p.shots.filter((s) => !s.video_url).map((s) => s.id);
  // 是否走首帧精控（据 readiness；未拉到时退回"无第③步"）
  const i2vaFlow = !!rd?.first_frames.mode_active;
  const missingFrames = rd?.first_frames.missing.length ?? 0;
  // 阶段无专属图：fallback=true 时该角色有通用定妆图兜底，只丢造型区分，不算硬缺口
  const noImgHard = (rd?.assets.stages_no_image ?? []).filter((s) => !s.fallback).length;
  const noImgSoft = (rd?.assets.stages_no_image.length ?? 0) - noImgHard;
  const noAssetChars = rd?.assets.chars_no_asset.length ?? 0;
  // 缺口告警数（步骤是否标红）：真注入不到图的阶段 + 一张图都没有的角色
  const assetWarn = noImgHard + noAssetChars;
  // 按钮上的数字必须是「点下去真会生成几张图」，与告警数是两回事：
  // 后端按 阶段缺图 + 需补建默认造型的角色 + 无图场景 去重后统计
  //（老口径 noImgHard+noAssetChars 会把同一批图数两遍：识别跑完后，一个角色的
  // 每套衣服都是一个缺图阶段，而这个角色自己也还在"无图角色"名单里）
  const fillCount = rd?.assets.to_generate
    ?? (rd ? rd.assets.stages_no_image.length + noAssetChars
      + rd.assets.locations_no_image.length : 0);
  // 服装识别是否跑过。没跑过时 assetWarn 只等于"没有定妆图的角色数"，
  // 与剧情真正需要的服装套数无关（一个角色可能要睡衣/西装/婚纱好几套），
  // 所以此时不能让用户直接点"补齐缺失资产"——那批图注定不全。
  const scanned = rd?.costumes?.scanned !== false;

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
      {/* 四步引导条：把「首帧精控」的隐式链路（拆解→资产→首帧→片段）显式化。
          非首帧路线（t2va/全参考）自动隐藏第③步，退化为三步。 */}
      <div className="sp-steps">
        {/* ① 拆解镜头并生成提示词 */}
        <div className={`sp-step ${p.shots.length ? "done" : ""}`}>
          <span className="sp-step-no">{p.shots.length ? "✓" : "1"}</span>
          <div className="sp-step-body">
            <div className="sp-step-title">🎞 拆解镜头 + 提示词</div>
            <div className="sp-step-sub">
              {breakingDown ? `正在生成 ${p.breakdownProgress}%`
                : p.shots.length ? `${p.shots.length} 个镜头`
                  : (p.hasScript ? "尚未拆解" : "先到「📝 剧本」页导入剧本")}
            </div>
          </div>
          <div className="sp-step-ops">
            <button className="btn tiny" disabled={!p.hasScript || breakingDown}
              onClick={() => p.onBreakdown()}>
              {breakingDown ? "⏳ 拆解中"
                : p.shots.length ? "🎞 补拆未处理的集" : "🎞 开始拆解"}
            </button>
          </div>
        </div>

        {/* ② 资产就绪：没有可注入定妆图的角色，首帧就是纯文生图。
            前置是"服装识别"——它决定了这一集到底需要几套衣服；不先识别，
            这里的报数只是"没有定妆图的角色数"，补图必然补不全。 */}
        <div className={`sp-step ${!scanned || assetWarn ? "warn" : rd ? "done" : ""}`}>
          <span className="sp-step-no">{scanned && !assetWarn && rd ? "✓" : "2"}</span>
          <div className="sp-step-body">
            <div className="sp-step-title">🖼 资产就绪</div>
            <div className={`sp-step-sub ${!scanned || assetWarn ? "warn" : ""}`}>
              {!rd ? "—"
                : !scanned
                  ? "尚未识别全剧服装造型"
                : assetWarn ? [
                  noAssetChars ? `${noAssetChars} 个角色无定妆图` : "",
                  noImgHard ? `${noImgHard} 个造型阶段无图可用` : "",
                ].filter(Boolean).join("，")
                  : `出场角色均有可注入的定妆图（${rd.costumes?.stages_total ?? 0} 个造型阶段）`}
              {/* 有通用图兜底的阶段只丢造型区分，不阻断，压成灰字提示 */}
              {scanned && noImgSoft > 0 && (
                <div className="muted" style={{ fontSize: 11 }}>
                  ℹ️ {noImgSoft} 个造型阶段无专属图，将回退角色通用定妆图
                </div>
              )}
            </div>
          </div>
          <div className="sp-step-ops">
            {!scanned ? (
              <button className="btn tiny primary" disabled={p.generating}
                title="逐集扫剧本，识别每个角色在每场戏该穿什么；纯文本调用，不出图不花钱"
                onClick={p.onCostumeScan}>
                🔍 识别全剧服装（不出图）
              </button>
            ) : assetWarn > 0 && (
              <button className="btn tiny" disabled={p.generating}
                title="批量补齐无图的角色/造型阶段/场景——没有定妆图的角色，人物一致性无从谈起"
                onClick={() => p.onPipeline({ genAssets: true, stopAfter: "assets" })}>
                🖼 补齐缺失资产（{fillCount} 张）
              </button>
            )}
            <button className="btn tiny" onClick={p.onGotoAssets}>去资产页</button>
          </div>
        </div>

        {/* ③ 全部镜头首帧（仅首帧精控路线）：先出图再出片，构图不对及时止损 */}
        {i2vaFlow && (
          <div className={`sp-step ${missingFrames ? "warn" : "done"}`}>
            <span className="sp-step-no">{missingFrames ? "3" : "✓"}</span>
            <div className="sp-step-body">
              <div className="sp-step-title">🎬 全部镜头首帧</div>
              <div className={`sp-step-sub ${missingFrames ? "warn" : ""}`}>
                {rd!.first_frames.ready}/{rd!.first_frames.required} 已就绪
                {missingFrames ? `，缺 ${missingFrames} 张` : ""}
                {/* 首帧的人物一致性 100% 来自注入的定妆图：没有定妆图就是纯文生图，
                    场景基准帧只保场景不保人。这里必须先告警再让用户点生成。 */}
                {noAssetChars > 0 && (
                  <div style={{ fontSize: 11, color: "var(--danger)" }}>
                    ⚠️ {noAssetChars} 个角色无定妆图，其首帧为纯文生图，人物一致性无保障
                  </div>
                )}
              </div>
            </div>
            <div className="sp-step-ops">
              <button className="btn tiny" disabled={!missingFrames || p.generating}
                title="生成前先做一次就绪度检查（会提示哪些角色缺定妆图）"
                onClick={() => setPreflight("frames")}>
                🎬 生成缺失的 {missingFrames} 张
              </button>
            </div>
          </div>
        )}

        {/* ④ 全部生成视频：改为先开二次确认弹窗，不再直接提交 */}
        <div className={`sp-step ${pendingIds.length ? "" : "done"}`}>
          <span className="sp-step-no">{pendingIds.length ? (i2vaFlow ? "4" : "3") : "✓"}</span>
          <div className="sp-step-body">
            <div className="sp-step-title">▶ 全部生成视频</div>
            <div className="sp-step-sub">
              {rd ? `${rd.shots.with_video}/${rd.shots.active} 已出片`
                : `待生成 ${pendingIds.length}`}
              {/* i2va 批量出片是「整批先出首帧、再逐镜出视频」，没有阶段可见性，
                  前几分钟只有"已出片 0/170"、进度条几乎不动，用户会误认为点了没反应 */}
              {p.jobPhase && (
                <div style={{ fontSize: 11, color: "var(--primary)", marginTop: 2 }}>
                  {p.jobPhase.label} {p.jobPhase.done}/{p.jobPhase.total}
                </div>
              )}
            </div>
          </div>
          <div className="sp-step-ops">
            <button className="btn tiny" disabled={breakingDown || !pendingIds.length || p.generating}
              title="生成前会先做一次就绪度检查"
              onClick={() => setPreflight("videos")}>
              ▶ 全部生成 ({pendingIds.length})
            </button>
            {/* 原「🚀 一条龙」已删除：它和顶栏「▷ 一键成片」是同一条链
                （拆解→资产→首帧→片段→拼接），差别只在从哪一环切入，而后端
                run_one_click_film 本来就会跳过已完成的环节。摆两个按钮只会让
                用户猜"这两个到底有什么区别"。 */}
          </div>
        </div>

        {multiSel.size > 0 && (
          <button className="btn tiny" style={{ alignSelf: "flex-start" }}
            onClick={() => { p.onGenerate([...multiSel]); setMultiSel(new Set()); }}>
            ↻ 生成选中的 {multiSel.size} 镜
          </button>
        )}
      </div>

      {preflight && (
        <PreflightDialog projectId={p.projectId} mode={preflight}
          onToast={p.onToast}
          onClose={() => setPreflight(null)}
          onProceed={() => { setPreflight(null); p.onGenerate(pendingIds); }}
          onGenFrames={(ids) => { setPreflight(null); p.onFirstFrames(ids); }}
          onFillAssets={() => { setPreflight(null); p.onPipeline({ genAssets: true, stopAfter: "assets" }); }}
          onCostumeScan={p.onCostumeScan} />
      )}
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
                  atCursor={p.cursorOrder === s.order}
                  imageModel={rd?.image_model}
                  onSelect={p.onSelect} onToggleSel={toggleSel}
                  onToggleExpand={toggleExpand} onAdvanced={p.onAdvanced}
                  onSwitchVersion={p.onSwitchVersion} onGenerate={p.onGenerate}
                  onReprompt={p.onReprompt} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

