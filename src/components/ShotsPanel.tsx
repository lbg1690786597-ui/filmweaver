import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, JobPhase, Readiness, ShotInfo } from "../api";
import { effectiveUrl, type Override } from "../lib/formState";
import { isSseUp, shouldSkipTick } from "../lib/sseHealth";
import { staleBadge, staleHint, needsRebreak } from "../lib/stale";
import {
  useLoadState, describeLoadError, LOAD_LABELS,
} from "../stores/loadStateStore";
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

/** 就绪度兜底重拉间隔（SSE 在线时）。比其余轮询的 15s 更慢：它是服务端
 *  **全量重算**（1400 镜项目实测：进程内空载 ~35 ms，出片高负载期经 nginx
 *  端到端 454 ms），而 SSE 在线时首帧/成片签名已经在驱动它了。 */
const READINESS_FALLBACK_MS = 30000;

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
  /** 历史版本没拉到时的说明。空串 = 正常。 */
  const [verErr, setVerErr] = useState("");
  // 首帧图的乐观覆盖：单镜重生后立即显示新图，不等整树 refreshDetail。
  // 覆盖必须能自愈 —— 判定逻辑与踩坑记录见 lib/formState.ts effectiveUrl()（F17）。
  const [ffOverride, setFfOverride] = useState<Override>(null);
  const [ffBusy, setFfBusy] = useState(false);
  const [ffErr, setFfErr] = useState("");
  // 失败原因分类：moderation=内容审核拒绝（重试无效，要改词/换模型）；其余=渠道故障（可重试）
  const [ffErrReason, setFfErrReason] = useState<string | undefined>();
  const ff = effectiveUrl(ffOverride, s.first_frame_url);

  // 服务端首帧一变，上一次的失败提示就过期了 —— 否则一张刚成功生成的图
  // 底下会一直挂着上次的红字报错，用户以为还是失败的。
  useEffect(() => { setFfErr(""); setFfErrReason(undefined); }, [s.first_frame_url]);

  const loadVersions = async () => {
    try {
      const r = await api.shotVersions(s.id);
      setVersions(r.versions);
      setVerErr("");
      useLoadState.getState().noteLoaded("versions");
    } catch (e) {
      // 2.4：以前是 `catch { setVersions([]) }`。空数组 → 版本条整条不渲染
      // （渲染条件是 `versions.length > 1`），于是界面在说"这个镜头只有一个版本"。
      // 这句谎话的代价很具体：用户想退回上一版的画面，看不到 V1 就以为没保存过，
      // 只能一遍遍重新生成去碰那个"原来的感觉"——每次都花钱，而且再也碰不回来。
      setVerErr(describeLoadError(e, LOAD_LABELS.versions).message);
      useLoadState.getState().noteFailed("versions", e);
    }
  };

  // 只在**确实失败**时占用顶栏的重试位：卡片收起/卸载或重试成功即注销并清掉条目。
  // （每个镜头卡都无条件注册的话，最后展开的那张会覆盖掉真正失败的那张。）
  useEffect(() => {
    if (!verErr) return;
    return useLoadState.getState().registerRetry("versions", () => { void loadVersions(); });
  }, [verErr, s.id]);

  /** 生成/重生首帧。regenAnchor=true 连带重建场景基准帧（影响同场景其他镜头）。
   *  imageModel 显式指定时覆盖项目预设——用于「被审核拒绝后换个模型再试」：
   *  各厂商审核尺度不同，实测 gpt-image-2 双渠道全拒的提示词 Gemini 系可正常出图。 */
  const genFirstFrame = async (regenAnchor: boolean, imageModel?: string) => {
    setFfBusy(true); setFfErr(""); setFfErrReason(undefined);
    try {
      const r = await api.regenFirstFrame(s.id, { regenAnchor, imageModel });
      // 记下当时的服务端值：props 追上来（或被别的任务改掉）后自动弃用覆盖
      if (r.first_frame_url) {
        setFfOverride({ base: s.first_frame_url, url: r.first_frame_url });
      }
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
            {s.duration_sec != null && <span className="muted" style={{ fontSize: "calc(10px * var(--fs-scale, 1))" }}>{s.duration_sec}s</span>}
            {s.stale && <span className="sp-stale-badge" title={staleHint(s)}>{staleBadge(s)}</span>}
            {s.profile_override && <span title="本镜有策略覆盖">⚙</span>}
            {/* 版本徽标：有历史版本时显示当前版本号，点击展开版本条 */}
            {(s.adopted_version ?? 0) > 1 && (
              <span className="sp-ver-badge" title="有多个历史版本">V{s.adopted_version}</span>
            )}
          </div>
          <div className="sp-ref">{s.script_ref}</div>
          {/* 版本切换条（展开详情时加载）：点 V1/V2 即切换采用并同步时间轴/预览 */}
          {props.expanded && verErr && (
            /* 2.4：版本条不显示时必须说清是"没有历史版本"还是"没查到" ——
               前者可以放心重生成，后者重生成就是在旧版本还找不着的时候又叠一版。 */
            <div className="sp-ver-fail" onClick={(e) => e.stopPropagation()}>
              ⚠️ {verErr}
              <button className="btn tiny" onClick={() => void loadVersions()}>重试</button>
            </div>
          )}
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
            <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))" }}>
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
            : <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))" }}>尚未生成（点上方「拆解镜头并生成提示词」）</div>}

          {/* 首帧图（i2va 路线）：先审首帧再出视频——首帧几毛、视频几块，
              场景偏移在首帧就能看出来，不必等视频跑完 */}
          <div className="sp-detail-label">🎬 首帧图</div>
          {ff ? (
            <img src={api.mediaUrl(ff)} alt={`镜头 #${s.order} 首帧`}
              style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 6, display: "block" }} />
          ) : (
            <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))" }}>
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
            <div className="err" style={{ fontSize: "calc(11px * var(--fs-scale, 1))", marginTop: 6 }}>
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
              <div className="muted" style={{ fontSize: "calc(10px * var(--fs-scale, 1))", marginTop: 4 }}>
                若换模型仍被拒，请到「⚙ 高级设置」弱化本镜提示词中的敏感描写后再生成。
              </div>
            </div>
          ) : (
            <div className="err" style={{ fontSize: "calc(11px * var(--fs-scale, 1))", marginTop: 6 }}>{ffErr}</div>
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

  // 兜底：SSE 断线时签名不会变，job 运行期间主动重拉。
  //
  // ⚠️ 它在 1400 镜的项目上是一次**服务端全量重算**（出片高负载期端到端实测
  // 454 ms），原注释「只读查询，很轻」在大项目上不成立。SSE 在线时上面那个
  // 签名 effect 已经每张首帧/每条成片都触发一次重拉了，这条定时器纯属兜底，
  // 所以降到 30s —— 比其余轮询的 15s 更慢，因为它是全工程最贵的一次只读调用。
  // SSE 断线时仍保持 5s（那时签名不会变，它是唯一的更新来源）。
  useEffect(() => {
    if (!p.generating || !p.projectId) return;
    let tick = 0;
    const t = window.setInterval(() => {
      tick += 1;
      if (shouldSkipTick(tick, 5000, READINESS_FALLBACK_MS, isSseUp())) return;
      loadRd();
    }, 5000);
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

  const toggleExpand = useCallback(
    (id: string) => setExpanded((prev) => (prev === id ? null : id)), []);
  const toggleSel = useCallback((id: string) =>
    setMultiSel((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    }), []);

  /* U2 第 3 点的另一半：`ShotCard` 的 memo 光有稳定的 `s` 还不够 ——
     `onSelect` / `onGenerate` / `onReprompt` / `onSwitchVersion` / `onAdvanced`
     都是 App.tsx 里每次渲染新建的箭头函数（`onAdvanced={(s) => …}` 就写在 JSX 里），
     props 里夹一个新函数就足以让 1424 张卡片全部重渲染。

     这里用「最新值 ref + 恒定包装」而不是去 App.tsx 给十来个 handler 套 useCallback：
     那些 handler 闭包捕获了大量 App 局部状态，逐个补依赖数组风险远大于收益，
     漏一个依赖就是"点了按钮用的是上一轮的状态"这种极难查的 bug。
     包装永远转发给最新的一份，行为与直传完全等价。 */
  const latest = useRef(p);
  latest.current = p;
  const onSelect = useCallback((s: ShotInfo) => latest.current.onSelect(s), []);
  const onAdvanced = useCallback((s: ShotInfo) => latest.current.onAdvanced(s), []);
  const onSwitchVersion = useCallback(
    (s: ShotInfo, v: number) => latest.current.onSwitchVersion(s, v), []);
  const onGenerate = useCallback((ids: string[]) => latest.current.onGenerate(ids), []);
  const onReprompt = useCallback((ids: string[]) => latest.current.onReprompt(ids), []);

  // 分集分组：1424 镜时这是每次渲染一遍的 Map 重建。shots 引用稳住之后
  // （见 lib/reconcileDetail.ts）useMemo 才拦得住，否则依赖每次都变，写了也白写。
  const byEpisode = useMemo(() => {
    const m = new Map<number, ShotInfo[]>();
    for (const s of p.shots) {
      const arr = m.get(s.episode) ?? [];
      arr.push(s);
      m.set(s.episode, arr);
    }
    return m;
  }, [p.shots]);
  const episodeGroups = useMemo(
    () => [...byEpisode.entries()].sort((a, b) => a[0] - b[0]), [byEpisode]);
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
                <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))" }}>
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
                  <div style={{ fontSize: "calc(11px * var(--fs-scale, 1))", color: "var(--danger)" }}>
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
                <div style={{ fontSize: "calc(11px * var(--fs-scale, 1))", color: "var(--primary)", marginTop: 2 }}>
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
        {episodeGroups.map(([ep, shots]) => {
          const staleCount = shots.filter((s) => s.stale).length;
          // 只有真的「切分失效」才提供重拆入口。以前不分原因一律给这个按钮：
          // 旁白时长变了（重出片即可）也引导用户重拆整集，代价是本集其它
          // 已调好的镜头与已出的片全部作废——救一个镜头，废掉一整集。
          const rebreakCount = shots.filter(needsRebreak).length;
          return (
            <div key={ep} className={staleCount ? "sp-epi stale" : "sp-epi"}>
              <div className="sp-ep">
                <span>{p.episodes.find((e) => e.order === ep)?.title ?? `第${ep}集`}</span>
                {staleCount > 0 && (
                  <>
                    <span className="sp-stale-badge"
                      title={rebreakCount
                        ? `${rebreakCount} 个镜头需重新拆解`
                        : "重新生成这些镜头即可，无需重拆本集"}>
                      {rebreakCount
                        ? `${rebreakCount} 镜需重拆`
                        : `${staleCount} 镜待重生成`}
                    </span>
                    {rebreakCount > 0 && (
                      <button className="btn tiny" disabled={breakingDown || p.generating}
                        onClick={() => p.onBreakdown([ep])}>↻ 重新拆解本集</button>
                    )}
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
                  onSelect={onSelect} onToggleSel={toggleSel}
                  onToggleExpand={toggleExpand} onAdvanced={onAdvanced}
                  onSwitchVersion={onSwitchVersion} onGenerate={onGenerate}
                  onReprompt={onReprompt} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

