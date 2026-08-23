import { useEffect, useMemo, useRef, useState } from "react";
import { api, SceneGroup, ShotInfo, StageInfo } from "../api";
import AutoTextarea from "./AutoTextarea";

/** 统一资产详情弹窗的目标描述：
 *  - stage 有值 = 阶段上下文（主角阶段/配角唯一阶段）：可改阶段名/区间/确认/删除，生成写回 AssetStage
 *  - stage 为 null = 纯资产上下文（场景/自定义/无阶段角色）：生成写回 Asset（assetId 或 upsert） */
export interface AssetDialogTarget {
  kind: "character" | "location" | "custom";
  name: string;
  assetId: string | null;
  stage: StageInfo | null;
  imageUrl: string | null;
  /** 角色参考音色（Asset.voice_url） */
  voiceUrl?: string | null;
  /** 该资产已存的造型/场景描述（Asset.prompt）。阶段上下文用 stage.description，
   *  这里只服务"纯资产"上下文：不传则弹窗里显示模板占位，用户改了才落库。 */
  assetPrompt?: string | null;
}

interface Props {
  projectId: string;
  target: AssetDialogTarget;
  /** 用途计算（精确到集数区间）：客户端按 effective 集合汇总出场集 */
  shots: ShotInfo[];
  /** 该角色**这张之外**已有的定妆图（与后端 asset_ref.character_base_ref 同口径）。
   *  生图时喂给模型当参考 → 同一个人换造型不换脸。非角色资产传 null。 */
  baseRef?: string | null;
  onClose: () => void;
  onToast: (m: string) => void;
  /** 生成/改动落库后刷新（stages + detail） */
  onChanged: () => void;
}

const ASPECTS = ["1:1", "9:16", "16:9"] as const;
/** 兜底模型清单（后端 /providers/image 未响应时用；渠道链后端内部维护） */
const FALLBACK_MODELS = [{ id: "gpt-image-2", label: "GPT Image 2" }];

/** 比例 × 分辨率档 → 网关 size 串（以网关实际支持为准，失败会报错提示换档） */
const sizeFor = (aspect: string, hd: boolean): string => {
  if (aspect === "9:16") return hd ? "1536x2688" : "1024x1792";
  if (aspect === "16:9") return hd ? "2688x1536" : "1792x1024";
  return hd ? "1536x1536" : "1024x1024";
};

/** 连续集数合并为区间文案：[1,2,3,5] → "第1-3集、第5集" */
const epRanges = (eps: number[]): string => {
  if (!eps.length) return "尚未在任何镜头中使用";
  const sorted = [...new Set(eps)].sort((a, b) => a - b);
  const runs: [number, number][] = [[sorted[0], sorted[0]]];
  for (const e of sorted.slice(1)) {
    const last = runs[runs.length - 1];
    if (e === last[1] + 1) last[1] = e; else runs.push([e, e]);
  }
  return runs.map(([a, b]) => (a === b ? `第${a}集` : `第${a}-${b}集`)).join("、");
};

/** 后端 vision_desc.AUTO_PREFIX：带此前缀 = AI 看图写的造型，用户改过就不再被换图覆盖。
 *  弹窗里剥掉前缀显示（用户不该看见内部标记），只在旁边给一行说明。 */
const AUTO_PREFIX = "〔自动识图〕";
const stripAuto = (s?: string | null): string =>
  (s ?? "").startsWith(AUTO_PREFIX) ? (s ?? "").slice(AUTO_PREFIX.length) : (s ?? "");

/** 统一资产详情弹窗：用途（集数区间）+ 阶段信息 + 生成参数（比例/分辨率/模型）+ 候选生成。
 *  资产页卡片单击、时间轴条目双击均打开此弹窗（轨道侧防误触）。 */
export default function AssetDialog(p: Props) {
  const t = p.target;
  // 已落库的造型描述：阶段上下文取 AssetStage.description，纯资产取 Asset.prompt。
  // 两者都是出片时喂给提示词优化器的"参考图文字锚点"，所以必须都能改、都能存。
  const savedDesc = t.stage ? t.stage.description : (t.assetPrompt ?? null);
  const descIsAuto = (savedDesc ?? "").startsWith(AUTO_PREFIX);
  const [prompt, setPrompt] = useState(() =>
    stripAuto(savedDesc)
    || (t.kind === "location" ? `场景概念图, ${t.name}, 电影感, 高质量`
      : t.kind === "custom" ? ""
        : `角色立绘, ${t.name}, 全身, 高质量, 短剧风格`));
  // 只有用户真的动过输入框才落库：轨道侧打开时 assetPrompt 可能没传进来，
  // 此时框里是模板占位，若照常 onBlur 保存会把库里真实描述冲掉。
  const [promptDirty, setPromptDirty] = useState(false);
  const [aspect, setAspect] = useState<string>(t.kind === "location" ? "16:9" : "9:16");
  const [hd, setHd] = useState(false);
  const [models, setModels] = useState<{ id: string; label: string }[]>(FALLBACK_MODELS);
  const [model, setModel] = useState(FALLBACK_MODELS[0].id);
  useEffect(() => {
    api.imageProviders().then((r) => {
      if (r.models.length) { setModels(r.models); setModel((m) => r.models.some((x) => x.id === m) ? m : r.models[0].id); }
    }).catch(() => { /* 旧后端无此接口：保持兜底清单 */ });
  }, []);
  const [cands, setCands] = useState<string[]>([]);
  //: 候选生成 job 在跑（关窗后仍在后台跑，重开会接回）
  const [candBusy, setCandBusy] = useState(false);
  //: 点大图放大确认（候选是竖版全身像，网格缩略图看不清脸）
  const [zoom, setZoom] = useState<string | null>(null);
  // 「绑定场景」下拉的候选：本项目归一后的场景名。只在阶段上下文里需要，
  // 且失败不影响弹窗其它功能（输入框仍可自由填）。
  const [scenes, setScenes] = useState<SceneGroup[]>([]);
  useEffect(() => {
    if (!t.stage || t.stage.virtual) return;
    api.listScenes(p.projectId).then((r) => setScenes(r.scenes))
      .catch(() => { /* 旧后端无此接口：下拉为空，手填照样能存 */ });
  }, [p.projectId, t.stage?.id]);
  const [genBusy, setGenBusy] = useState(false);
  const [genN, setGenN] = useState(4);   // 生成张数 1-4（用户可选）
  // 拿该角色已有的定妆图当参考（图生图）→ 换造型不换脸。默认开：
  // 裸文生图的结果是同一个角色每张脸都不一样，后续视频全废。
  const [keepFace, setKeepFace] = useState(true);
  const [curImg, setCurImg] = useState(t.imageUrl);
  // 上传替换：图片（所有资产）+ 参考音色（角色资产）
  const imgFileRef = useRef<HTMLInputElement | null>(null);
  const voiceFileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [curVoice, setCurVoice] = useState(t.voiceUrl ?? null);

  /** 上传图片 → 直接作为资产图（替换 AI 生成的）。
   *  预览立即更新（不等落库回包）；落库失败会 toast 并还原。 */
  const doUploadImage = async (f: File) => {
    setUploading(true);
    const prev = curImg;
    try {
      const r = await api.uploadMedia(f, p.projectId);
      setCurImg(r.url);   // 立即出预览
      if (t.stage && !t.stage.virtual) await api.patchStage(t.stage.id, { image_url: r.url });
      else if (t.assetId) await api.patchAsset(t.assetId, { imageUrl: r.url });
      else await api.upsertAssetImage(p.projectId, t.kind, t.name, r.url);
      setCands([]);
      p.onChanged();
      p.onToast("✅ 已用上传图片替换资产图");
    } catch (e) {
      setCurImg(prev);    // 落库失败还原预览
      p.onToast(`上传失败：${String(e).slice(0, 160)}`);
    }
    finally { setUploading(false); }
  };

  /** 上传参考音色（音频/视频）→ Asset.voice_url；TTS 旁白按角色取音色 */
  const doUploadVoice = async (f: File) => {
    setUploading(true);
    try {
      const r = await api.uploadMedia(f, p.projectId);
      if (t.assetId) await api.patchAsset(t.assetId, { voiceUrl: r.url });
      else await api.upsertAssetImage(p.projectId, t.kind, t.name, undefined, r.url);
      setCurVoice(r.url);
      p.onChanged();
      p.onToast(`🎙 「${t.name}」参考音色已设置（旁白合成将用此音色）`);
    } catch (e) { p.onToast(String(e)); }
    finally { setUploading(false); }
  };

  // ---- 用途：按 effective 集合（(L1 ∪ add) − remove）汇总实际出场的集数 ----
  const usage = useMemo(() => {
    const eps: number[] = [];
    for (const sh of p.shots) {
      if (sh.is_special) continue;
      const ov = sh.ref_overrides ?? {};
      let present: boolean;
      if (t.kind === "location") {
        const rm = ov.remove_loc ?? [];
        present = [...(sh.location ? [sh.location] : []), ...(ov.add_loc ?? [])]
          .filter((c) => !rm.includes(c)).includes(t.name);
      } else {
        const rm = ov.remove ?? [];
        present = [...sh.characters, ...(ov.add ?? [])]
          .filter((c) => !rm.includes(c)).includes(t.name);
      }
      if (present) {
        // 阶段上下文：只统计本阶段区间内的出场
        if (t.stage && (sh.episode < t.stage.ep_from || sh.episode > t.stage.ep_to)) continue;
        eps.push(sh.episode);
      }
    }
    return epRanges(eps);
  }, [p.shots, t.kind, t.name, t.stage]);

  const saveStage = async (patch: Parameters<typeof api.patchStage>[1]) => {
    if (!t.stage) return;
    try {
      await api.patchStage(t.stage.id, patch);
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  /** 造型描述落库：真实阶段写 AssetStage.description，其余写 Asset.prompt
   *  （有 id 走 PATCH，没有则按 kind+name upsert 建行）。
   *  这段文字出片时会作为参考图的文字锚点喂给提示词优化器，所以必须持久化——
   *  以前非阶段资产改完提示词只留在组件 state 里，一关弹窗就没了。 */
  const savedRef = useRef(stripAuto(savedDesc));
  const savePrompt = async () => {
    if (!promptDirty) return;
    const v = prompt.trim();
    if (v === savedRef.current.trim()) return;
    try {
      if (t.stage && !t.stage.virtual) await api.patchStage(t.stage.id, { description: v });
      else if (t.assetId) await api.patchAsset(t.assetId, { prompt: v });
      else await api.upsertAssetImage(p.projectId, t.kind, t.name, undefined, undefined, v);
      savedRef.current = v;
      setPromptDirty(false);
      p.onChanged();
    } catch (e) { p.onToast(`描述保存失败：${String(e).slice(0, 160)}`); }
  };

  // ---- 候选图接回：打开弹窗就问一次"这张资产最近一次候选生成怎么样了" ----
  // 候选走 job，关掉弹窗它照样在后台跑；结果存在 job 里，重开这里接回来接着挑。
  // 在跑就 3s 轮询一次（只在弹窗开着时轮询，关了自然停）。
  const pollRef = useRef<(() => void) | null>(null);
  const failedRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await api.latestAssetCandidates(p.projectId, t.kind, t.name,
                                                  t.stage?.id ?? null);
        if (!alive) return;
        if (r.urls?.length) setCands(r.urls);
        const running = r.status === "pending" || r.status === "running";
        setCandBusy(running);
        if (r.status === "failed" && r.job_id && failedRef.current !== r.job_id) {
          failedRef.current = r.job_id;
          p.onToast(`候选生成失败：${(r.error ?? "").slice(0, 160)}`);
        }
        if (running) timer = window.setTimeout(tick, 3000);
      } catch { /* 旧后端无此接口：静默降级，本次会话内照常能用 */ }
    };
    pollRef.current = () => { if (timer) window.clearTimeout(timer); void tick(); };
    void tick();
    return () => { alive = false; pollRef.current = null; if (timer) window.clearTimeout(timer); };
  }, [p.projectId, t.kind, t.name, t.stage?.id]);

  const doGen = async () => {
    if (!prompt.trim()) { p.onToast("先填写生图提示词"); return; }
    setGenBusy(true);
    try {
      const useRef = !!p.baseRef && keepFace;
      await api.submitAssetCandidates({
        projectId: p.projectId, kind: t.kind, name: t.name,
        stageId: t.stage?.id ?? null,
        prompt: prompt.trim(), modelId: model, size: sizeFor(aspect, hd), n: genN,
        // 角色资产：喂该角色已有的定妆图做参考，换造型不换脸。
        // 排除正在重生成的这一张（拿它自己当参考等于原地复制一版）
        useCharRef: useRef, excludeUrl: curImg,
      });
      setCands([]);            // 旧候选让位给这一批
      setCandBusy(true);
      p.onToast(`✨ 正在生成 ${genN} 张候选，可以关掉弹窗，回来接着挑`);
      pollRef.current?.();
    } catch (e) { p.onToast(`提交失败：${String(e).slice(0, 160)}`); }
    finally { setGenBusy(false); }
  };

  /** 采用某张候选：真实阶段写 AssetStage.image_url；虚拟段/无阶段写 Asset（id 或 upsert）。
   *  候选网格**不清空**——挑错了还能改选另一张（当前采用的那张有高亮边框）。 */
  const pick = async (u: string) => {
    try {
      if (t.stage && !t.stage.virtual) await api.patchStage(t.stage.id, { image_url: u });
      else if (t.assetId) await api.patchAsset(t.assetId, { imageUrl: u });
      else await api.upsertAssetImage(p.projectId, t.kind, t.name, u);
      setCurImg(u);
      setZoom(null);
      p.onChanged();
      p.onToast("✅ 已设为资产图");
    } catch (e) { p.onToast(String(e)); }
  };

  const kindLabel = t.kind === "location" ? "场景" : t.kind === "custom" ? "自定义资产" : "角色";
  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="wizard wizard-lg" onClick={(e) => e.stopPropagation()}>
        <h2>{t.kind === "location" ? "🏞" : t.kind === "custom" ? "✨" : "👤"} {t.name}
          {t.stage && <span className="muted" style={{ fontWeight: 400 }}> · {t.stage.stage_name}</span>}
        </h2>

        {/* 当前图 + 用途 */}
        <div className="adlg-top">
          {curImg
            ? <img className="adlg-img" src={api.mediaUrl(curImg)} alt={t.name} />
            : <div className="adlg-img ph">尚无图</div>}
          <div className="adlg-meta">
            <div><b>类型</b>{kindLabel}{t.stage ? (curImg ? " · ✅当前使用中" : " · 待生成") : ""}</div>
            {t.stage && <div><b>阶段区间</b>第{t.stage.ep_from}-{t.stage.ep_to}集</div>}
            <div><b>实际用在</b>{t.kind === "custom" ? "拖到轨道/镜头槽后生效" : usage}</div>
            {t.kind === "character" && (
              <div><b>参考音色</b>
                {curVoice
                  ? <span>已设置 🎙 <button className="btn ghost adlg-mini"
                      onClick={() => { const a = new Audio(api.mediaUrl(curVoice)); void a.play(); }}>▶试听</button></span>
                  : <span className="muted">未设置（旁白合成时可用角色音色）</span>}
              </div>
            )}
            {/* 上传替换：图片直接替换 AI 资产图；角色可传参考音色 */}
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button className="btn adlg-mini" disabled={uploading}
                title="上传本地图片作为此资产图（替换 AI 生成）"
                onClick={() => imgFileRef.current?.click()}>
                {uploading ? "⏳" : "📤 上传图片"}
              </button>
              {t.kind === "character" && (
                <button className="btn adlg-mini" disabled={uploading}
                  title="上传音频/视频作为此角色参考音色（旁白合成用其人声，取前 15s）"
                  onClick={() => voiceFileRef.current?.click()}>
                  {uploading ? "⏳" : "🎙 上传音色"}
                </button>
              )}
            </div>
            <input ref={imgFileRef} type="file" accept=".png,.jpg,.jpeg,.webp" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUploadImage(f); e.target.value = ""; }} />
            <input ref={voiceFileRef} type="file" accept=".mp3,.wav,.aac,.m4a,.mp4,.mov" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUploadVoice(f); e.target.value = ""; }} />
          </div>
        </div>

        {/* 阶段字段（仅阶段上下文）：改名/调区间 */}
        {t.stage && (
          <div className="row">
            <label style={{ flex: 2 }}>阶段名
              <input defaultValue={t.stage.stage_name}
                onBlur={(e) => e.target.value !== t.stage!.stage_name && saveStage({ stage_name: e.target.value })} />
            </label>
            <label style={{ flex: 1 }}>起始集
              <input type="number" min={1} defaultValue={t.stage.ep_from}
                onBlur={(e) => saveStage({ ep_from: Number(e.target.value) })} />
            </label>
            <label style={{ flex: 1 }}>结束集
              <input type="number" min={1} defaultValue={t.stage.ep_to}
                onBlur={(e) => saveStage({ ep_to: Number(e.target.value) })} />
            </label>
          </div>
        )}

        {/* 服装继承（仅真实阶段）：绑定场景 + 是否跨集沿用。
            AI 会给出初判，但"睡衣算不算场景决定型"这种判断难免有争议，
            所以两个字段都开放给用户改——最终解释权归用户。 */}
        {t.stage && !t.stage.virtual && (
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: 2 }}>绑定场景
              <input list="adlg-scenes" defaultValue={t.stage.location ?? ""}
                placeholder="留空 = 不绑场景（按集区间生效）"
                title="填归一后的场景名（可从下拉里选本项目已有场景）"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === (t.stage!.location ?? "").trim()) return;
                  // 解绑场景时必须同时关掉 scene_bound：后端对
                  // 「scene_bound 为真却没有 location」直接 400（无场景可沿用）
                  void saveStage(v ? { location: v } : { location: "", scene_bound: false });
                }} />
              <datalist id="adlg-scenes">
                {scenes.map((s) => <option key={s.canonical} value={s.canonical} />)}
              </datalist>
            </label>
            <label className="genpick-row" style={{ flex: 3 }}>
              <input type="checkbox" defaultChecked={!!t.stage.scene_bound}
                onChange={(e) => {
                  if (e.target.checked && !(t.stage!.location ?? "").trim()) {
                    e.target.checked = false;
                    p.onToast("先填「绑定场景」再勾选沿用（没有场景就无从沿用）");
                    return;
                  }
                  void saveStage({ scene_bound: e.target.checked });
                }} />
              <span style={{ fontSize: 12 }}>
                同场景沿用同一张图（跨集有效）
                <span className="muted">
                  ：人物再次进入这个场景、剧本又没另写衣着时，直接复用本造型这张图，
                  不再重新生成。适合睡衣@卧室、浴袍@浴室这类<b>场景决定</b>的服装；
                  婚纱@教堂这类<b>事件</b>服装不要勾
                </span>
              </span>
            </label>
          </div>
        )}
        {t.stage?.source_stage_id && (
          <div className="muted" style={{ fontSize: 11, marginTop: -4 }}>
            ↩ 本段与同角色另一造型是<b>同一件衣服</b>，共用那张图（自己不出图、不花钱）。
            如需让它单独出一张，上传图片或生成一张即可自动解除共用
          </div>
        )}

        {/* 生成参数：提示词 + 比例/分辨率/模型/张数 */}
        <label>{t.kind === "location" ? "场景描述" : "造型描述"}（也是生图提示词）
          {descIsAuto && <span className="muted" style={{ fontWeight: 400 }}>
            {" "}· AI 看图写的，改过就不再被换图覆盖</span>}
          <AutoTextarea className="drawer-ta" minHeight={64} value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
            onBlur={() => void savePrompt()} />
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>比例
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {ASPECTS.map((a) => <option key={a} value={a}>{a}{a === "9:16" ? "（竖版）" : a === "16:9" ? "（横版）" : "（方形）"}</option>)}
            </select>
          </label>
          <label style={{ flex: 1 }}>分辨率
            <select value={hd ? "hd" : "std"} onChange={(e) => setHd(e.target.value === "hd")}>
              <option value="std">标准（{sizeFor(aspect, false)}）</option>
              <option value="hd">高清（{sizeFor(aspect, true)}，以网关支持为准）</option>
            </select>
          </label>
          <label style={{ flex: 1 }}>模型
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label style={{ width: 76 }}>张数
            <select value={genN} onChange={(e) => setGenN(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n2) => <option key={n2} value={n2}>{n2} 张</option>)}
            </select>
          </label>
        </div>

        {p.baseRef && (
          <label className="genpick-row" style={{ marginTop: -4 }}>
            <input type="checkbox" checked={keepFace}
              onChange={(e) => setKeepFace(e.target.checked)} />
            <img src={api.mediaUrl(p.baseRef)} alt="参考"
              style={{ width: 26, height: 34, objectFit: "cover", borderRadius: 3 }} />
            <span style={{ fontSize: 12 }}>参考这张已有定妆图（换造型不换脸）</span>
          </label>
        )}

        <button className="btn primary" disabled={genBusy || candBusy} onClick={doGen}>
          {candBusy ? "生成中…（可关掉弹窗，回来接着挑）"
            : genBusy ? "提交中…"
              : `✨ 生成（${genN} 张候选）`}
        </button>
        {cands.length > 0 && (
          <div className="cand-grid">
            {cands.map((u) => (
              <img key={u} src={api.mediaUrl(u)} alt="候选" title="点击看大图并采用"
                // 按所选比例显示、整图不裁：竖版全身像被裁成方形就看不见脸和鞋
                style={{
                  aspectRatio: aspect.replace(":", " / "), objectFit: "contain",
                  background: "#000",
                  borderColor: curImg === u ? "var(--accent)" : undefined,
                }}
                onClick={() => setZoom(u)} />
            ))}
          </div>
        )}

        <div className="row" style={{ justifyContent: "space-between" }}>
          {t.stage ? (
            <button className="btn ghost" onClick={async () => {
              if (!window.confirm(`删除「${t.name}·${t.stage!.stage_name}」阶段？`)) return;
              await api.deleteStage(t.stage!.id);
              p.onChanged(); p.onClose();
            }}>🗑 删除阶段</button>
          ) : <span />}
          <span>
            <button className="btn ghost" onClick={p.onClose}>关闭</button>
          </span>
        </div>
      </div>

      {/* 候选大图：缩略图看不清脸，放大确认再采用（点错就得重生成，花钱） */}
      {zoom && (
        <div className="drawer-mask" style={{ zIndex: 60 }}
          onClick={(e) => { e.stopPropagation(); setZoom(null); }}>
          <div className="wizard" onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 560 }}>
            <img src={api.mediaUrl(zoom)} alt="候选大图"
              style={{ width: "100%", maxHeight: "68vh", objectFit: "contain",
                background: "#000", borderRadius: 8 }} />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setZoom(null)}>返回挑选</button>
              <button className="btn primary" onClick={() => void pick(zoom)}>
                {curImg === zoom ? "✅ 当前就是这张" : "✅ 采用这张"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
