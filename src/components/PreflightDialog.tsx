import { useEffect, useState } from "react";
import { api, CostumeReport, Readiness } from "../api";
import { videoModelLabel, imageModelLabel, genModeLabel } from "../lib/modelLabels";

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
  onClose: () => void;
  /** 直接出片（缺首帧交给后端自动补）。shotIds 为本轮待生成镜头 */
  onProceed: () => void;
  /** 先补齐首帧：shotIds 为缺首帧的镜头 */
  onGenFrames: (shotIds: string[]) => void;
  /** 一键成片全链路（仅 mode="film" 需要） */
  onFilm?: (opts: { genAssets: boolean }) => void;
  /** 只补资产图（人物一致性的前置条件），补完停下让用户决定下一步 */
  onFillAssets: () => void;
  /** 全剧服装识别（纯文本 job，不出图不花钱）：服装表为空时的前置步骤 */
  onCostumeScan: () => void;
  onToast: (m: string) => void;
}

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

  const load = async () => {
    setErr("");
    try { setRd(await api.projectReadiness(p.projectId)); }
    catch (e) { setErr(String(e)); }
  };
  useEffect(() => { load(); }, [p.projectId]);

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

  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="wizard wizard-lg" onClick={(e) => e.stopPropagation()}>
        <h2>{p.mode === "film" ? "▷ 一键成片 · 生产检查"
          : p.mode === "frames" ? "🎬 批量首帧 · 生产检查" : "生产检查"}</h2>

        {!rd && !err && <div className="muted">体检中…</div>}
        {err && <div className="err">{err}</div>}

        {rd && (
          <>
            <table className="preflight-table"><tbody>
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
                  与剧情真正需要的服装套数无关，报出去就是误导。 */}
              {rd.costumes && !rd.costumes.stages_total && (
                <tr>
                  <td>服装</td>
                  <td>
                    <div className="err">⚠️ 尚未识别全剧服装造型，下方资产报数不作准</div>
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
                    {rd.warnings.map((w, i) => (
                      <div key={i} className="err" style={{ fontSize: 12 }}>⚠️ {w}</div>
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
                  再出首帧和片段
                </span>
              </label>
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
                  onClick={() => p.onFilm?.({ genAssets })}>
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
      </div>
    </div>
  );
}
