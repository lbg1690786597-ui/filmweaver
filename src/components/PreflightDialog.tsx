import { useEffect, useRef, useState } from "react";
import { api, CostumeReport, Readiness } from "../api";
import { videoModelLabel, imageModelLabel, genModeLabel, productionModeLabel } from "../lib/modelLabels";
import { ASPECTS, resListOf } from "../lib/resolutions";

/** 出片前二次确认弹窗（「▷ 一键成片」「▶ 全部生成视频」「🎬 批量首帧」共用）。
 *
 * 存在的理由：「🎬 首帧精控」链路里有**用户在 UI 上看不见**的静默失效点——
 * ① 角色没有任何定妆图时首帧退化成纯文生图（场景锚点只保场景不保人）；
 * ② 视频模型不支持首帧输入时会静默回退全参考，只在 shot_versions.meta 留一行
 * 记录。本弹窗把两者摊到台前，并给一键修复。
 *
 * 文案口径必须如实：后端**不会**因为缺首帧而报错（run_shot_videos 会在出片前
 * 自动补首帧），所以「仍然继续」写的是"缺首帧的镜头将在生成时自动补"。
 * 唯一真会带空首帧下发的路径（高级设置里手动锁 i2va）走 readiness.warnings。
 *
 * mode="film"：原「🚀 一条龙」已与「▷ 一键成片」合并——同一件事没有理由摆两个
 * 按钮（拆解→资产→首帧→片段→拼接是一条链，差别只在从哪一环切入，而后端本来
 * 就会跳过已完成的环）。
 */
interface Props {
  projectId: string;
  /** film=一键成片全链路（拆解→资产→首帧→片段→拼接）；videos=只出片；frames=只出首帧 */
  mode: "film" | "videos" | "frames";
  /** 项目是否已有剧本（film 模式下没剧本无法开跑） */
  hasScript?: boolean;
  /** 剧型（drama/narration）。解说剧要在这里显示并可直接设解说音色—— */
  productionMode?: string | null;
  /** 解说音色 URL；解说剧缺它会在配音阶段中止，所以开跑前就要能看到并补上 */
  narrationVoiceUrl?: string | null;
  /** 解说音色变更后通知外层刷新项目详情 */
  onNarrationVoiceChanged?: () => void;
  onClose: () => void;
  /** 直接出片（缺首帧交给后端自动补）。shotIds 为本轮待生成镜头 */
  onProceed: () => void;
  /** 先补齐首帧：shotIds 为缺首帧的镜头 */
  onGenFrames: (shotIds: string[]) => void;
  /** 一键成片全链路（仅 mode="film" 需要）。
   *  videoModel/width/height 为本次覆写，null/undefined = 沿用项目设置。 */
  onFilm?: (opts: {
    genAssets: boolean;
    videoModel?: string | null;
    width?: number;
    height?: number;
  }) => void;
  /** 只补资产图（人物一致性的前置条件），补完停下让用户决定下一步 */
  onFillAssets: () => void;
  /** 全剧服装识别（纯文本 job，不出图不花钱）：服装表为空时的前置步骤 */
  onCostumeScan: () => void;
  onToast: (m: string) => void;

  // ---- 运行态（mode="film" 用；弹窗在跑的时候原地变进度面板，不关闭）----
  /** 一键成片是否正在跑 */
  running?: boolean;
  /** 0-100，来自 job */
  progress?: number;
  /** 当前阶段标签（后端 set_job_phase），key 与 STAGES 对应 */
  phase?: { key: string; label: string; done: number; total: number } | null;
  /** 停止生产。语义是"不再为后续镜头发起新请求"，不是立即中止 */
  onStop?: () => void;
}

/** 一键成片的五段流程，与 backend/app/jobs.py::run_one_click_film 的
 *  set_job_phase key 一一对应——改名要两边一起改，否则进度点不亮。
 *  pct 是该段结束时的 job progress，用于"已越过即视为完成"的推导。 */
const STAGES: { key: string; label: string; pct: number; hint?: string }[] = [
  { key: "breakdown", label: "拆解镜头", pct: 10 },
  { key: "costume", label: "识别服装造型", pct: 12, hint: "纯文本 · 不花钱" },
  { key: "assets", label: "补齐资产图", pct: 30, hint: "会产生费用" },
  { key: "frames", label: "生成首帧", pct: 60 },
  // 解说剧专属：旁白必须在出视频**之前**合成——旁白时长决定镜头时长，
  // 顺序反了这批视频就作废了。真人剧不经过这两步（后端按模式跳过）。
  { key: "narration", label: "切分解说旁白", pct: 63, hint: "仅解说剧 · 不花钱" },
  { key: "narration_tts", label: "合成解说配音", pct: 70, hint: "仅解说剧" },
  { key: "videos", label: "生成片段", pct: 85, hint: "最耗时" },
  { key: "compose", label: "拼接成片", pct: 100 },
];

/** 粗略耗时预估已删除：并发池排队 + 渠道队列长度不可预测，给出的数字必然离真实值
 * 很远，用户按它安排时间只会被误导。进度条与阶段标签是真实反馈，不需要假承诺。 */

export default function PreflightDialog(p: Props) {
  const [rd, setRd] = useState<Readiness | null>(null);
  const [err, setErr] = useState("");
  const [genAssets, setGenAssets] = useState(true);
  // 服装清单（花费闸门）：默认只报数，用户点「查看服装清单」才拉明细。
  // 明细是逐镜×角色的，几百行，不该在每次开弹窗时都拉一遍。
  const [rep, setRep] = useState<CostumeReport | null>(null);
  const [repOpen, setRepOpen] = useState(false);

  // ---- 本次生产的参数覆写（只影响这一次，不改项目默认）----
  // 项目创建时选的模型/画幅未必适合这一次跑：换个模型重出、或先用 720p 试片
  // 都是常见需求，此前只能回项目设置改、改完还影响后续所有生产。
  // null = 沿用项目设置（rd 里回的那套）。
  const [ovModel, setOvModel] = useState<string | null>(null);
  const [ovAspect, setOvAspect] = useState<string | null>(null);
  const [ovResIdx, setOvResIdx] = useState(0);
  const [paramOpen, setParamOpen] = useState(false);
  const [videoModels, setVideoModels] = useState<{ key: string; label: string }[]>([]);

  // ---- 解说音色（仅解说剧）----
  // 放在开跑前的体检弹窗里：缺音色会让配音阶段中止，等跑到一半才发现太晚。
  const voiceRef = useRef<HTMLInputElement | null>(null);
  const [upVoice, setUpVoice] = useState(false);
  const [voicePreview, setVoicePreview] = useState<string | null>(null);
  const doUploadVoice = async (f: File) => {
    setUpVoice(true);
    try {
      const up = await api.uploadMedia(f, p.projectId);
      await api.setNarrationVoice(p.projectId, up.url);
      p.onNarrationVoiceChanged?.();
    } catch (e) { setErr(`音色上传失败: ${String(e).slice(0, 140)}`); }
    finally { setUpVoice(false); }
  };

  const load = async () => {
    setErr("");
    try { setRd(await api.projectReadiness(p.projectId)); }
    catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, [p.projectId]);

  // 模型清单以后端注册表为准：硬编码必然漂移（配了 endpoint 才会注册，
  // 实测同一份代码在不同环境下是 2 个 vs 5 个模型）
  useEffect(() => {
    if (p.mode !== "film") return;
    api.videoProviders()
      .then((r) => setVideoModels((r.providers ?? []).map((pv) => ({
        key: pv.model_id, label: videoModelLabel(pv.model_id),
      }))))
      .catch(() => { /* 拉不到就只显示"沿用项目设置" */ });
  }, [p.mode]);

  const openRep = async () => {
    setRepOpen(!repOpen);
    if (rep || repOpen) return;
    try { setRep(await api.costumeReport(p.projectId)); }
    catch (e) { p.onToast(String(e)); }
  };

  const missing = rd?.first_frames.missing ?? [];
  // 阶段无专属图：能回退角色通用定妆图的只丢造型区分（提示级），
  // 连通用图都没有的才是真红牌（首帧裸生）
  const noImg = rd?.assets.stages_no_image ?? [];
  const noImgHard = noImg.filter((s) => !s.fallback);
  const noAsset = rd?.assets.chars_no_asset ?? [];
  const ffActive = !!rd?.first_frames.mode_active;
  const nothingToDo = !!rd && (p.mode === "frames"
    ? missing.length === 0
    // 一键成片：没镜头也能开跑（后端会先拆解），所以只有"有镜头且全出片了"才算无事可做
    : p.mode === "film"
      ? (rd.shots.total > 0 && rd.shots.need_video === 0) || p.hasScript === false
      : rd.shots.need_video === 0);

  // 人物一致性缺口：角色一张定妆图都没有 → 该镜首帧退化成纯文生图
  //（场景锚点只保场景不保人）。能回退通用图的阶段不算缺口，不必吓唬用户。
  const refGap = noAsset.length + noImgHard.length;
  // 「🖼 先补齐资产图」的口径比 refGap 宽：只要有图没出就该能补。
  // 能回退基础定妆图的造型阶段（多半正是剧本明写的服装变体，如「丝绸睡裙」）
  // 虽然不是红牌，却恰恰是用户抱怨"每个角色只有一张资产图"的那一批——
  // 用 refGap 当门槛会把它们全挡在门外，按钮根本不出现。
  // 口径由后端给（assets.to_generate）：阶段缺图 + 需补建默认造型的角色 + 无图场景，
  // 已去重。前端自行相加会把同一批图数两遍——识别跑完后一个角色的每套衣服都是一个
  // 缺图阶段，而这个角色自己也还在"无图角色"名单里（实测报 32、实际只出 25 张）。
  const fillGap = rd?.assets.to_generate
    ?? (noImg.length + noAsset.length
      + (rd?.assets.locations_no_image.length ?? 0));

  // ---- 五段流程的每步状态（mode="film"）----
  // 由 progress + phase.key 共同推导：phase 命中即 running，progress 越过即 done。
  // 只用 progress 不够——同一个区间里跑的可能是 assets 也可能是 costume；
  // 只用 phase 也不够——phase 只反映"当前在哪段"，说不出前面几段是否已完成。
  const stageState = (i: number): "done" | "running" | "pending" => {
    if (!p.running) return "pending";
    const st = STAGES[i];
    if (p.phase?.key === st.key) return "running";
    const prev = i === 0 ? 0 : STAGES[i - 1].pct;
    if ((p.progress ?? 0) >= st.pct) return "done";
    // 已越过上一段但当前 phase 不在本段：本段被跳过（如 full_reference 项目无首帧）
    if ((p.progress ?? 0) > prev && !p.phase) return "done";
    return "pending";
  };

  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="wizard wizard-lg" onClick={(e) => e.stopPropagation()}>
        <h2>{p.mode === "film"
          ? (p.running ? "▷ 一键成片 · 生产中" : "▷ 一键成片")
          : p.mode === "frames" ? "🎬 批量首帧 · 生产检查" : "生产检查"}</h2>

        {/* ---- 五段流程面板（film 模式）：开跑前是流程预览，开跑后原地变进度 ---- */}
        {p.mode === "film" && (
          <div className="pf-flow">
            {STAGES.map((st, i) => {
              // 全能参考模式不出首帧（readiness.mode_active=false，后端整段跳过），
              // 标成"跳过"而不是留一个永远不会亮的步骤让用户干等
              const skipped = st.key === "frames" && rd != null && !ffActive;
              const state = skipped ? "skipped" : stageState(i);
              const isCur = state === "running";
              return (
                <div key={st.key} className={`pf-step ${state}`}>
                  <span className="pf-step-no">
                    {skipped ? "–"
                      : state === "done" ? "✓"
                        : state === "running" ? "▸" : i + 1}
                  </span>
                  <span className="pf-step-label">{st.label}</span>
                  <span className="pf-step-meta">
                    {skipped ? "本模式跳过"
                      : isCur && p.phase
                        ? (p.phase.total > 0
                          ? `${p.phase.done}/${p.phase.total}`
                          : "进行中")
                        : state === "done" ? "完成"
                          : state === "running" ? "进行中"
                            : (st.hint ?? "待开始")}
                  </span>
                </div>
              );
            })}
            {p.running && (
              <div className="pf-flow-foot">
                <span className="muted">{p.progress ?? 0}%</span>
                <span className="muted pf-flow-note">
                  关闭本窗口不会中断生产
                </span>
                {p.onStop && (
                  <button className="btn tiny danger" onClick={p.onStop}>
                    停止生产
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {!rd && !err && <div className="muted">体检中…</div>}
        {err && <div className="err">{err}</div>}

        {rd && !p.running && (
          <>
            <table className="preflight-table"><tbody>
              {/* 剧型（配音策略）与下面的"生成模式"（技术路线）是两回事，
                  必须分两行——改版后它们不再是同一个字段，混在一行会让用户
                  以为选了解说剧就换了生成路线。 */}
              <tr>
                <td>剧型</td>
                <td>
                  {productionModeLabel(p.productionMode)}
                  <span className="muted">
                    　{p.productionMode === "narration"
                      ? "剧本全文作旁白，画面原声静音"
                      : "人物按剧本台词配音"}
                  </span>
                  {p.productionMode === "narration" && (
                    <div style={{ marginTop: 4, display: "flex",
                                  alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className={p.narrationVoiceUrl ? "" : "err"}
                        style={{ fontSize: 11 }}>
                        {p.narrationVoiceUrl
                          ? "✓ 解说音色已设置"
                          : "⚠️ 未设解说音色 — 配音阶段会中止"}
                      </span>
                      <button className="link-btn" disabled={upVoice}
                        style={{ fontSize: 11 }}
                        onClick={() => voiceRef.current?.click()}>
                        {upVoice ? "上传中…"
                          : p.narrationVoiceUrl ? "更换音色" : "上传音色"}
                      </button>
                      {p.narrationVoiceUrl && (
                        <button className="link-btn" style={{ fontSize: 11 }}
                          onClick={() => setVoicePreview(
                            api.mediaUrl(p.narrationVoiceUrl!))}>
                          试听
                        </button>
                      )}
                      <input ref={voiceRef} type="file" accept="audio/*,video/*" hidden
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void doUploadVoice(f);
                        }} />
                    </div>
                  )}
                  {voicePreview && (
                    <audio src={voicePreview} controls autoPlay
                      style={{ width: "100%", height: 28, marginTop: 4 }}
                      onEnded={() => setVoicePreview(null)} />
                  )}
                </td>
              </tr>
              <tr>
                <td>生成模式</td>
                <td>
                  {genModeLabel(rd.generation_mode)}
                  <span className="muted">
                    　{videoModelLabel(rd.video_model)}
                    {rd.image_model ? ` / ${imageModelLabel(rd.image_model)}` : ""}
                  </span>
                  {rd.generation_mode === "i2va" && !rd.i2va_supported && (
                    <div className="err" style={{ fontSize: 11 }}>
                      ⚠️ 该视频模型不支持首帧输入
                      {rd.i2va_reason ? `（${rd.i2va_reason}）` : ""}
                      ，本次将<b>回退全参考路线</b>，首帧图不会真正生效
                    </div>
                  )}
                </td>
              </tr>

              <tr>
                <td>镜头</td>
                <td>
                  {rd.shots.total === 0 ? (
                    <span className="muted">未拆解（一键成片会先自动拆解）</span>
                  ) : (
                    <>
                      待生成 <b>{rd.shots.need_video}</b> 个
                      <span className="muted">
                        　（共 {rd.shots.total}，已出片 {rd.shots.with_video}
                        {rd.shots.total - rd.shots.active > 0
                          ? `，外部素材/停用 ${rd.shots.total - rd.shots.active}` : ""}）
                      </span>
                    </>
                  )}
                </td>
              </tr>

              <tr>
                <td>资产</td>
                <td>
                  {noImg.length > noImgHard.length && (
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                      ℹ️ {noImg.length - noImgHard.length} 个造型阶段还没出图（将回退角色基础定妆图）：
                      {noImg.filter((s) => s.fallback).slice(0, 6)
                        .map((s) => `${s.character_name}·${s.stage_name}`).join(" / ")}
                      {noImg.length - noImgHard.length > 6 ? " …" : ""}
                    </div>
                  )}
                  {noImgHard.length > 0 && (
                    <div className="err" style={{ marginBottom: 4 }}>
                      ⚠️ {noImgHard.length} 个造型阶段既无专属图、该角色也无通用定妆图：
                      <span className="muted" style={{ fontSize: 11 }}>
                        {noImgHard.slice(0, 6).map((s) => `${s.character_name}·${s.stage_name}`).join(" / ")}
                        {noImgHard.length > 6 ? " …" : ""}
                      </span>
                    </div>
                  )}
                  {noAsset.length > 0 && (
                    <div className="err" style={{ marginBottom: 4 }}>
                      ⚠️ {noAsset.length} 个出场角色没有任何可注入的定妆图：
                      <span className="muted" style={{ fontSize: 11 }}>
                        {noAsset.slice(0, 6).map((c) => c.name).join("、")}
                        {noAsset.length > 6 ? " …" : ""}
                      </span>
                      <div className="muted" style={{ fontSize: 11 }}>
                        无参考图可注入，长相由模型自由发挥，同一角色跨镜会变脸
                      </div>
                    </div>
                  )}
                  {rd.assets.locations_no_image.length > 0 && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {rd.assets.locations_no_image.length} 个场景没有参考图：
                      {rd.assets.locations_no_image.slice(0, 6).join("、")}
                      {rd.assets.locations_no_image.length > 6 ? " …" : ""}
                    </div>
                  )}
                  {!noImg.length && !noAsset.length && (
                    <span className="ok-text">✅ 出场角色均有可注入的定妆图</span>
                  )}
                </td>
              </tr>

              {/* 服装（花费闸门）：先把"要出几张图、免费复用几张"报清楚，
                  用户点了「🖼 先补齐资产图」才真去生成。不设硬上限，只如实报数。
                  识别没跑过时**不能**报数——那时下面所有数字都只反映"有几个角色没图"，
                  与剧情真正需要的服装套数无关，报出去就是误导。

                  ⚠️ 这里**不再**重复渲染"尚未识别服装"的红字：同一条信息
                  readiness.warnings 里已有一份（level=info），两处各标一次红，
                  正是"刚导入剧本就满屏标红"的一半来源。 */}
              {rd.costumes && !rd.costumes.stages_total && (
                <tr>
                  <td>服装</td>
                  <td>
                    <div className="muted" style={{ fontSize: 12 }}>
                      尚未识别（流程第 ② 步会自动跑，也可现在单独跑）
                    </div>
                    <button className="btn" style={{ fontSize: 11, marginTop: 4 }}
                      onClick={() => { p.onCostumeScan(); p.onClose(); }}>
                      🔍 识别全剧服装（不出图）
                    </button>
                  </td>
                </tr>
              )}
              {!!rd.costumes?.stages_total && (
                <tr>
                  <td>服装</td>
                  <td>
                    <div>
                      共 <b>{rd.costumes.stages_total}</b> 件造型
                      {rd.costumes.scene_bound > 0 && (
                        <span className="muted">
                          　其中 {rd.costumes.scene_bound} 件绑定场景（再次进入同一场景时沿用同一张图）
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                      {rd.costumes.to_generate > 0
                        ? <>本次需出图 <b>{rd.costumes.to_generate}</b> 张（会产生费用）</>
                        : <span className="ok-text">✅ 所有造型都已有图，无需出图</span>}
                      {rd.costumes.followers > 0 && (
                        <span className="muted">　免费复用 {rd.costumes.followers} 段（同一件衣服共用图）</span>
                      )}
                    </div>
                    <button className="btn ghost" style={{ fontSize: 11, marginTop: 4 }}
                      onClick={openRep}>
                      {repOpen ? "收起服装清单" : "查看服装清单"}
                    </button>
                    {repOpen && !rep && <div className="muted">加载中…</div>}
                    {repOpen && rep && (
                      <div style={{ maxHeight: 220, overflow: "auto", marginTop: 4 }}>
                        {rep.summary.shot_char_uncovered > 0 && (
                          <div className="err" style={{ fontSize: 11 }}>
                            ⚠️ {rep.summary.shot_char_uncovered}/{rep.summary.shot_char_pairs} 处
                            「镜头×角色」还取不到任何参考图（出图后即会补齐）
                          </div>
                        )}
                        <table className="preflight-table"><tbody>
                          {rep.stages.map((s) => (
                            <tr key={s.id}>
                              <td style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                                {s.character_name}·{s.stage_name}
                              </td>
                              <td style={{ fontSize: 11 }}>
                                <span className="muted">
                                  第 {s.ep_from}
                                  {s.ep_to !== s.ep_from ? `-${s.ep_to}` : ""} 集
                                  {s.shot_from ? `　#${s.shot_from}-${s.shot_to}` : ""}
                                  {s.location ? `　场景「${s.location}」` : ""}
                                </span>
                                {s.scene_bound && (
                                  <span className="ok-text">　⟳ 同场景沿用</span>
                                )}
                                {s.reuse_of
                                  ? <span className="muted">　↩ 复用同衣的图（免费）</span>
                                  : s.has_image
                                    ? <span className="ok-text">　✅ 已有图</span>
                                    : <span className="err">　待出图</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody></table>
                      </div>
                    )}
                  </td>
                </tr>
              )}

              {ffActive && (
                <tr>
                  <td>首帧图</td>
                  <td>
                    {missing.length ? (
                      <div className="err">
                        ⚠️ {missing.length} 个镜头还没有首帧图
                        <span className="muted" style={{ fontSize: 11 }}>
                          （{missing.slice(0, 12).map((m) => `#${m.order}`).join(" ")}
                          {missing.length > 12 ? " …" : ""}）
                        </span>
                        <div className="muted" style={{ fontSize: 11 }}>
                          不会报错：生成视频时后端会自动补。但先补齐更划算——
                          首帧几毛钱一张，能先看构图再决定要不要出片
                        </div>
                      </div>
                    ) : (
                      <span className="ok-text">
                        ✅ {rd.first_frames.ready}/{rd.first_frames.required} 张首帧已就绪
                      </span>
                    )}
                  </td>
                </tr>
              )}

              {rd.warnings.length > 0 && (
                <tr>
                  <td>提醒</td>
                  <td>
                    {/* 按 level 分色：info 用灰（流程还没走到，不是故障）、
                        warn 用黄（会自动降级但能跑完）、error 用红（真会失败）。
                        此前全用 .err，于是"还没识别服装"这种正常状态也是刺眼的红字。 */}
                    {rd.warnings.map((w, i) => (
                      <div key={i}
                        className={w.level === "error" ? "err"
                          : w.level === "warn" ? "warn-text" : "muted"}
                        style={{ fontSize: 12, marginBottom: 3 }}>
                        {w.level === "error" ? "⛔ " : w.level === "warn" ? "⚠️ " : "ℹ️ "}
                        {w.text}
                      </div>
                    ))}
                  </td>
                </tr>
              )}
            </tbody></table>

            {p.mode === "film" && (
              <label className="genpick-row" style={{ marginTop: 4 }}>
                <input type="checkbox" checked={genAssets}
                  onChange={(e) => setGenAssets(e.target.checked)} />
                <span>
                  先补齐缺失的资产图（缺图的定妆阶段 / 无定妆图的角色 / 无图场景），
                  {/* 文案必须跟着真实链路走：全能参考模式下 readiness.first_frames
                      .mode_active=false，后端**整段跳过首帧**（实测 required=0），
                      写死"再出首帧和片段"是纯误导。 */}
                  {ffActive ? "再出首帧和片段" : "再直接出片段"}
                </span>
              </label>
            )}

            {/* ---- 本次参数覆写（只影响这一次生产，不改项目默认）----
                此前想换模型/降分辨率试片，只能回项目设置改，改完还影响后续所有生产。 */}
            {p.mode === "film" && (
              <div className="pf-params">
                <button className="pf-params-head" onClick={() => setParamOpen(!paramOpen)}>
                  {paramOpen ? "▾" : "▸"} 本次参数
                  {(ovModel || ovAspect) && <span className="pf-params-dot">已改</span>}
                  <span className="muted">
                    {videoModelLabel(ovModel ?? rd.video_model)}
                    {" · "}{ovAspect ?? rd.base_aspect ?? "9:16"}
                  </span>
                </button>

                {paramOpen && (
                  <div className="pf-params-body">
                    <label className="pf-param">
                      <span>视频模型</span>
                      <select value={ovModel ?? ""}
                        onChange={(e) => setOvModel(e.target.value || null)}>
                        <option value="">沿用项目设置（{videoModelLabel(rd.video_model)}）</option>
                        {videoModels.map((m) => (
                          <option key={m.key} value={m.key}>{m.label}</option>
                        ))}
                      </select>
                    </label>

                    <label className="pf-param">
                      <span>画面比例</span>
                      <select value={ovAspect ?? ""}
                        onChange={(e) => {
                          setOvAspect(e.target.value || null);
                          setOvResIdx(0);   // 换画幅后旧档位索引可能越界
                        }}>
                        <option value="">沿用项目设置（{rd.base_aspect ?? "9:16"}）</option>
                        {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </label>

                    {/* 分辨率依附于画幅：没改画幅时用项目画幅的档位表 */}
                    <label className="pf-param">
                      <span>分辨率</span>
                      <select value={ovResIdx}
                        onChange={(e) => setOvResIdx(Number(e.target.value))}>
                        {resListOf(ovAspect ?? rd.base_aspect ?? "9:16").map((r, i) => (
                          <option key={r.label} value={i}>{r.label}</option>
                        ))}
                      </select>
                    </label>

                    <div className="muted" style={{ fontSize: 10, lineHeight: 1.6 }}>
                      仅本次生效，不修改项目默认设置。
                      分辨率越高越贵也越慢，试片建议先用较低档。
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button className="btn ghost" onClick={p.onClose}>取消</button>

              {/* 人物一致性的前置修复：只补资产图，补完就停，让用户看过再决定下一步。
                  没定妆图就出片 = 人物长相由模型自由发挥，一整批烧完才发现不一致最亏。
                  不再要求 ffActive：全参考路线下参考图就是一致性的**全部**依赖，
                  比首帧路线更需要补齐；而且"全部镜头已出片"的项目也该能补资产库
                  （识别出的服装变体缺图，只有这个入口能补）。 */}
              {fillGap > 0 && (
                <button className="btn"
                  title="只生成缺失的定妆图/场景图，不出首帧也不出片；补完回到这里再继续"
                  onClick={() => p.onFillAssets()}>
                  🖼 先补齐资产图（{fillGap} 张）
                </button>
              )}

              {p.mode === "film" ? (
                <button className="btn primary" disabled={nothingToDo}
                  title="拆解 → 资产 → 首帧 → 片段 → 拼接成片，已完成的环节自动跳过"
                  onClick={() => {
                    // 只在用户真改过画幅/分辨率时才下发 width/height；
                    // 没改就传 undefined，让后端沿用项目默认（别用前端算出来的值
                    // 去覆盖，那会把"沿用"悄悄变成"锁定成当前档位"）
                    const aspect = ovAspect ?? rd.base_aspect ?? "9:16";
                    const res = resListOf(aspect)[ovResIdx];
                    const changed = ovAspect !== null || ovResIdx !== 0;
                    p.onFilm?.({
                      genAssets,
                      videoModel: ovModel,
                      width: changed ? res?.w : undefined,
                      height: changed ? res?.h : undefined,
                    });
                  }}>
                  {p.hasScript === false ? "请先导入剧本"
                    : nothingToDo ? "全部镜头已出片" : "▷ 开始生产"}
                </button>
              ) : p.mode === "frames" ? (
                <button className="btn primary" disabled={nothingToDo}
                  title={refGap > 0
                    ? "注意：无定妆图的角色本轮仍是纯文生图，人物一致性无保障"
                    : "用已确认的定妆图 + 场景基准帧批量生成缺失的首帧（不出视频）"}
                  onClick={() => p.onGenFrames(missing.map((m) => m.id))}>
                  {nothingToDo ? "首帧已全部就绪" : `🎬 生成 ${missing.length} 张首帧`}
                </button>
              ) : missing.length ? (
                <>
                  <button className="btn" disabled={nothingToDo} onClick={p.onProceed}
                    title="直接出片；缺首帧的镜头由后端在生成时自动补一张">
                    仍然继续（缺首帧的镜头将在生成时自动补）
                  </button>
                  <button className="btn primary"
                    onClick={() => p.onGenFrames(missing.map((m) => m.id))}>
                    🎬 先补齐 {missing.length} 个首帧
                  </button>
                </>
              ) : (
                <button className="btn primary" disabled={nothingToDo} onClick={p.onProceed}>
                  {nothingToDo ? "没有待生成的镜头" : `▶ 开始生成 ${rd.shots.need_video} 个镜头`}
                </button>
              )}
            </div>
          </>
        )}

        {/* 运行中：体检表已隐藏，这里给一个关闭入口。
            关闭 ≠ 取消——任务继续在后端跑，顶栏进度条和任务中心都还能看到。 */}
        {p.running && (
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={p.onClose}>关闭窗口（继续生产）</button>
          </div>
        )}
      </div>
    </div>
  );
}
