import { useEffect, useRef, useState } from "react";
import { api, AssetInfo, EpisodeInfo, JobPhase, ShotInfo, StageInfo } from "../api";
import { LibClip, clipKind, fmtTime, probeDuration } from "../types";
import ShotsPanel from "./ShotsPanel";
import AssetDialog, { AssetDialogTarget } from "./AssetDialog";
import AutoTextarea from "./AutoTextarea";

interface Props {
  projectId: string;
  clips: LibClip[];
  onAddClips: (clips: LibClip[]) => void;
  /** 插入镜头轨（P0-3 归一）：视频素材作为 is_special 镜头追加到镜头轨末尾 */
  onAddToTimeline: (clip: LibClip) => void;
  /** 插入中（禁用按钮避免重复插入） */
  inserting: boolean;
  onPreview: (clip: LibClip) => void;
  /** P1-3 素材池落库：从素材池删除（连文件） */
  onDeleteClip: (clipId: string) => void;
  /** 全部资产条目（含未生成图的），页内直接生成与展示 */
  assetsMeta: AssetInfo[];
  /** 资产页角色分层（修 E3）：角色卡展开显示其全部造型阶段，可勾选合并 */
  stages: StageInfo[];
  onRefreshStages: () => void;
  onRefresh: () => void;
  onToast: (m: string) => void;
  // 镜头页签
  shots: ShotInfo[];
  episodes: EpisodeInfo[];
  selectedShotId: string | null;
  /** 定位线所在镜头 order（镜头卡/资产卡高亮联动） */
  cursorOrder?: number | null;
  /** 定位线所在镜头的 effective 注入集合（资产页高亮"会用到的资产"） */
  cursorChars?: string[];
  cursorLoc?: string | null;
  onSelectShot: (shot: ShotInfo) => void;
  onGenerate: (shotIds: string[]) => void;
  onSwitchVersion: (shot: ShotInfo, verNo: number) => void;
  onAdvanced: (shot: ShotInfo) => void;
  generating: boolean;
  /** 在跑的生产 job 的当前阶段（透传给镜头页步骤④，见 ShotsPanel） */
  jobPhase?: JobPhase | null;
  onBreakdown: (episodes?: number[]) => void;
  breakdownProgress: number | null;
  /** 批量首帧（job）。shotIds 缺省=补齐所有缺首帧的镜头 */
  onFirstFrames: (shotIds?: string[]) => void;
  /** 按当前资产重写镜头提示词（job，纯文本）。shotIds 缺省=全部镜头 */
  onReprompt: (shotIds?: string[]) => void;
  /** 首帧精控 pipeline（job，已弃用）：资产 → 全部首帧 → 全部片段。
   * 已被顶栏「▷ 一键成片」替代（后者合并了此功能），但接口保留以免回归。 */
  onPipeline: (opts: { genAssets: boolean; stopAfter?: "assets" | "frames" }) => void;
  /** 全剧服装识别（job，纯文本不出图）：必须跑在补图之前，否则资产报数不作数 */
  onCostumeScan: () => void;
  /** Phase 1 重构：内部页签改为可由外部（Rail 导航）驱动。
   *  不传 = 保持组件自管（旧行为，回归安全）；传了则由父组件控制。 */
  tab?: Tab;
  onTabChange?: (t: Tab) => void;
  /** Phase 1：页签条由外层 LeftPanel 标题栏承担时隐藏自身页签 */
  hideTabs?: boolean;
}

export type Tab = "script" | "assets" | "shots";

/** 左侧面板：剧本(按集直接编辑) / 资产(含上传) / 镜头(拆解+提示词+生成)。 */
export default function LibraryPanel(p: Props) {
  const [innerTab, setInnerTab] = useState<Tab>("script");
  const tab = p.tab ?? innerTab;
  const setTab = (t: Tab) => { p.onTabChange ? p.onTabChange(t) : setInnerTab(t); };
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const scriptFileRef = useRef<HTMLInputElement>(null);

  // ---- 剧本页：导入 → 弹窗确认分集 → 按集文本框编辑 ----
  const [draft, setDraft] = useState<{ text: string; episodes: EpisodeInfo[] } | null>(null);
  const [epContents, setEpContents] = useState<{ order: number; title: string; content: string }[]>([]);
  const [savingEp, setSavingEp] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const loadEpContents = async () => {
    try {
      const r = await api.episodesContent(p.projectId);
      setEpContents(r.episodes);
    } catch { /* 无剧本时静默 */ }
  };
  useEffect(() => { loadEpContents(); }, [p.projectId, p.episodes.length]);

  const doParse = async (text: string) => {
    setBusy(true); setErr("");
    try {
      const r = await api.importScript(text);
      setDraft({ text, episodes: r.episodes });
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doParseFile = async (f: File) => {
    setBusy(true); setErr("");
    try {
      const r = await api.importScriptFile(f);  // 解析（docx/pdf 后端提取文本）
      setDraft({ text: r.text, episodes: r.episodes });
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const doConfirmImport = async () => {
    if (!draft) return;
    setBusy(true); setErr("");
    try {
      await api.importScript(draft.text, p.projectId, true);
      setDraft(null);
      p.onRefresh();
      await loadEpContents();
      p.onToast(`✅ 已导入 ${draft.episodes.length} 集，可到「🎬 镜头」页拆解`);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const saveEpisode = async (order: number, content: string) => {
    setSavingEp(order);
    try {
      const r = await api.updateEpisodeContent(p.projectId, order, content);
      p.onRefresh();
      if (r.stale_shots > 0) p.onToast(`第 ${order} 集已保存，${r.stale_shots} 个镜头标记为过期`);
      else p.onToast(`第 ${order} 集已保存`);
    } catch (e) { p.onToast(String(e)); }
    finally { setSavingEp(null); }
  };

  const importFiles = async (files: FileList) => {
    setUploading(true); setErr("");
    try {
      const added: LibClip[] = [];
      for (const f of Array.from(files)) {
        // P1-3：先本地探测时长，再随上传落库（media_clips，项目维度持久化）
        const kind = clipKind(f.name);
        const blobUrl = URL.createObjectURL(f);
        const duration = await probeDuration(blobUrl, kind).finally(
          () => URL.revokeObjectURL(blobUrl));
        const r = await api.uploadMedia(f, p.projectId, duration);
        added.push({ id: r.file_id, name: r.name, url: r.url, size: r.size, kind, duration });
      }
      p.onAddClips(added);
    } catch (e) { setErr(String(e)); }
    finally { setUploading(false); }
  };

  // ---- 资产页角色分层（修 E3）：展开的角色 + 合并勾选 ----
  const [openChar, setOpenChar] = useState<string | null>(null);
  const [mergeSel, setMergeSel] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  // ---- 大分组整体折叠：人物 / 场景 / 自定义 / 素材池 ----
  const [secOpen, setSecOpen] = useState<Record<string, boolean>>({
    chars: true, others: false, locs: true, custom: true, pool: true,
  });
  const toggleSec = (k: string) => setSecOpen((s) => ({ ...s, [k]: !s[k] }));
  // ---- 自定义资产新建（上传 / AI 生图）----
  const customFileRef = useRef<HTMLInputElement>(null);
  const [customGen, setCustomGen] = useState<{ name: string; prompt: string } | null>(null);
  const [customBusy, setCustomBusy] = useState(false);
  // ---- AI 生成资产图确认弹窗（勾选清单）----
  const [genPick, setGenPick] = useState<Set<string> | null>(null);  // null=弹窗关闭
  // ---- 统一资产详情弹窗（点击卡片打开：用途/阶段/参数/生成）----
  const [assetDlg, setAssetDlg] = useState<AssetDialogTarget | null>(null);
  const doMergeStages = async (charName: string) => {
    const ids = [...mergeSel];
    if (ids.length < 2) return;
    if (!window.confirm(
      `把「${charName}」勾选的 ${ids.length} 个阶段合并为一个设定？\n`
      + `（集区间取并集；保留有定妆图的那个阶段的图与描述，其余删除）`)) return;
    setMerging(true);
    try {
      const r = await api.mergeStages(ids);
      setMergeSel(new Set());
      p.onRefreshStages();
      p.onToast(`✅ 已合并 ${r.merged_names.length + 1} 个阶段 → 「${r.kept.stage_name}」（第${r.kept.ep_from}-${r.kept.ep_to}集）`);
    } catch (e) { p.onToast(String(e)); }
    finally { setMerging(false); }
  };

  // ---- 资产页内生成（确认弹窗勾选制；job 轮询期间 onRefresh 触发逐张实时显示）----
  const [assetJob, setAssetJob] = useState<{ id: string; progress: number } | null>(null);
  const assetTimer = useRef<number | null>(null);

  /** 勾选清单的条目 key：stage:{id} / char:{name} / loc:{name} */
  const openGenPicker = () => {
    // 默认勾选：主角（多阶段角色）的全部阶段；配角、场景全不勾
    const def = new Set<string>();
    const byName = new Map<string, StageInfo[]>();
    for (const s of p.stages) {
      const arr = byName.get(s.character_name) ?? [];
      arr.push(s); byName.set(s.character_name, arr);
    }
    for (const [, sts] of byName) {
      if (sts.length >= 2) for (const s of sts) def.add(`stage:${s.id}`);
    }
    setGenPick(def);
  };

  const doGenConfirmed = async () => {
    if (!genPick || !genPick.size) { p.onToast("没有勾选任何条目"); return; }
    const items: { name: string; prompt: string; stage_id?: string }[] = [];
    for (const key of genPick) {
      if (key.startsWith("stage:")) {
        const st = p.stages.find((s) => s.id === key.slice(6));
        if (!st) continue;
        items.push({
          name: `阶段-${st.character_name}-${st.stage_name}`,
          prompt: `角色定妆照, ${st.character_name}, ${st.stage_name}, ${st.description ?? ""}, 全身, 正面, 高质量, 短剧风格, 纯色背景`,
          stage_id: st.id,
        });
      } else if (key.startsWith("char:")) {
        const name = key.slice(5);
        items.push({ name: `角色-${name}`, prompt: `角色立绘, ${name}, 全身, 高质量, 短剧风格` });
      } else if (key.startsWith("loc:")) {
        const name = key.slice(4);
        items.push({ name: `场景-${name}`, prompt: `场景概念图, ${name}, 电影感, 高质量` });
      }
    }
    setGenPick(null);
    try {
      const j = await api.submitAssetBatch(items, p.projectId);
      setAssetJob(j);
      assetTimer.current = window.setInterval(async () => {
        const s = await api.jobStatus(j.id);
        setAssetJob(s);
        p.onRefresh();          // Asset 图逐张点亮
        p.onRefreshStages();    // 阶段定妆图逐张点亮
        if (s.status === "done" || s.status === "failed") {
          if (assetTimer.current) clearInterval(assetTimer.current);
          setAssetJob(null);
          p.onRefresh(); p.onRefreshStages();
          p.onToast(s.status === "done" ? "✅ 资产图生成完成" : "⚠️ 部分资产生成失败");
        }
      }, 3000);
    } catch (e) { p.onToast(String(e)); }
  };

  // ---- 自定义资产：上传图 / AI 生图 ----
  const doCustomUpload = async (f: File) => {
    setCustomBusy(true);
    try {
      const r = await api.uploadMedia(f, p.projectId);
      const name = f.name.replace(/\.[^.]+$/, "");
      await api.createAsset({ projectId: p.projectId, kind: "custom", name, imageUrl: r.url });
      p.onRefresh();
      p.onToast(`✅ 自定义资产「${name}」已创建`);
    } catch (e) { p.onToast(String(e)); }
    finally { setCustomBusy(false); }
  };
  const doCustomGen = async () => {
    if (!customGen || !customGen.name.trim() || !customGen.prompt.trim()) return;
    setCustomBusy(true);
    try {
      const r = await api.assetsGenerate(customGen.prompt.trim());
      if (!r.urls.length) throw new Error("生图无产出");
      await api.createAsset({
        projectId: p.projectId, kind: "custom", name: customGen.name.trim(),
        imageUrl: r.urls[0], prompt: customGen.prompt.trim(),
      });
      setCustomGen(null);
      p.onRefresh();
      p.onToast(`✅ 自定义资产「${customGen.name.trim()}」已生成`);
    } catch (e) { p.onToast(String(e)); }
    finally { setCustomBusy(false); }
  };

  /** 资产卡拖拽起手：payload 进 dataTransfer，轨道侧 onDrop 解析 */
  const dragStartAsset = (e: React.DragEvent, data: {
    assetId: string | null; kind: string; name: string; imageUrl: string | null; stageId?: string;
  }) => {
    e.dataTransfer.setData("application/x-fw-asset", JSON.stringify(data));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <aside className="lib">
      {!p.hideTabs && (
        <div className="lib-tabs">
          <button className={tab === "script" ? "on" : ""} onClick={() => setTab("script")}>📝 剧本</button>
          <button className={tab === "assets" ? "on" : ""} onClick={() => setTab("assets")}>🖼 资产</button>
          <button className={tab === "shots" ? "on" : ""} onClick={() => setTab("shots")}>🎬 镜头</button>
        </div>
      )}

      {tab === "script" && (
        <div className="lib-body">
          <div className="row">
            <button className="btn primary" style={{ flex: 1 }} disabled={busy}
              onClick={() => scriptFileRef.current?.click()}
              title="支持 txt / md / docx / pdf（.doc 请先转存为 .docx）">
              {busy ? "解析中…" : epContents.length ? "📄 重新导入剧本" : "📄 导入剧本 (txt/docx/pdf)"}
            </button>
          </div>
          <input ref={scriptFileRef} type="file" accept=".txt,.md,.docx,.pdf,.doc" hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) doParseFile(f);
              e.target.value = "";
            }} />
          {!epContents.length && (
            <>
              <AutoTextarea className="drawer-ta" minHeight={120} id="fw-paste"
                placeholder="或直接粘贴剧本文本（支持“第N集/章”分集标注）…" />
              <button className="btn" disabled={busy} onClick={() => {
                const el = document.getElementById("fw-paste") as HTMLTextAreaElement;
                if (el?.value.trim()) doParse(el.value);
              }}>🔍 解析粘贴内容</button>
            </>
          )}
          {err && <div className="err">{err}</div>}
          {/* 按集文本框直接编辑；改动失焦即保存并把该集镜头标过期 */}
          {epContents.map((ep) => (
            <div key={ep.order} className="ep-editor">
              <div className="ep-editor-head">
                <span>{ep.title}</span>
                <span className="muted">{savingEp === ep.order ? "保存中…" : `${ep.content.length} 字`}</span>
              </div>
              <AutoTextarea className="drawer-ta ep-ta" minHeight={140} maxHeight={420}
                defaultValue={ep.content}
                onBlur={(e) => {
                  if (e.target.value.trim() !== ep.content.trim()) {
                    saveEpisode(ep.order, e.target.value);
                  }
                }} />
            </div>
          ))}
        </div>
      )}

      {/* 导入分集确认弹窗 */}
      {draft && (
        <div className="drawer-mask" onClick={() => setDraft(null)}>
          <div className="wizard" onClick={(e) => e.stopPropagation()}>
            <h2>确认分集（{draft.episodes.length} 集）</h2>
            <div className="shots" style={{ maxHeight: 300, overflowY: "auto" }}>
              {draft.episodes.map((ep) => (
                <div key={ep.order} className="shot">
                  <span className="shot-no">{ep.order}</span>
                  <span style={{ flex: 1 }}>{ep.title}</span>
                  <span className="muted">{ep.word_count} 字</span>
                </div>
              ))}
            </div>
            <div className="muted">确认后剧本按集展示，可直接在文本框中修改</div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setDraft(null)}>取消</button>
              <button className="btn primary" disabled={busy} onClick={doConfirmImport}>
                {busy ? "保存中…" : "✅ 确认导入"}
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "assets" && (
        <div className="lib-body">
          <div className="row">
            <button className="btn primary" style={{ flex: 1 }}
              disabled={assetJob !== null || !p.assetsMeta.some((a) => a.kind === "character")}
              onClick={openGenPicker}
              title={p.assetsMeta.some((a) => a.kind === "character") ? "弹出勾选清单：默认勾选主角全部阶段，配角/场景可主动勾选" : "先在「🎬 镜头」页完成拆解"}>
              {assetJob ? `生成中 ${assetJob.progress}%（逐张实时显示）` : "✨ AI 生成资产图"}
            </button>
            <button className="btn" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "上传中…" : "＋ 上传"}
            </button>
          </div>
          <input ref={fileRef} type="file" multiple hidden
            accept=".mp4,.mov,.mkv,.webm,.mp3,.wav,.aac,.m4a,.png,.jpg,.jpeg,.webp,.srt"
            onChange={(e) => e.target.files && importFiles(e.target.files)} />
          {err && <div className="err">{err}</div>}

          {/* 分组信息架构：👤人物（主角独立条目+其他角色折叠组）/ 🏞场景 / ✨自定义 / 📦素材池
              大分组可整体折叠；条目卡最大宽度固定，面板拖宽自动 1→2→3 列（lib-cols）；
              全部卡片可拖拽上轨（dataTransfer: application/x-fw-asset） */}
          {(() => {
            const chars = p.assetsMeta.filter((a) => a.kind === "character");
            const locs = p.assetsMeta.filter((a) => a.kind === "location");
            const customs = p.assetsMeta.filter((a) => a.kind === "custom");
            const stagesOf = (name: string) =>
              p.stages.filter((s) => s.character_name === name)
                .sort((a, b) => a.ep_from - b.ep_from);
            // 主角 = 有 ≥2 个造型阶段；其余（0-1 个阶段）进「其他角色」折叠组
            const mains = chars.filter((a) => stagesOf(a.name).length >= 2);
            const others = chars.filter((a) => stagesOf(a.name).length < 2);
            // 定位线联动：所在镜头会注入的角色/场景 → 对应卡高亮
            const hlChars = new Set(p.cursorChars ?? []);
            const hlLoc = p.cursorLoc ?? null;
            /** 主角条目（可展开阶段 + 合并；头部可整卡拖拽） */
            const renderMainChar = (a: AssetInfo) => {
              const sts = stagesOf(a.name);
              const open = openChar === a.name;
              const cover = sts.find((s) => s.image_url)?.image_url ?? a.image_url;
              return (
                <div key={`c-${a.name}`} className={`lib-char ${open ? "open" : ""} ${hlChars.has(a.name) ? "at-cursor" : ""}`}>
                  <div className="lib-char-head" title={`${a.name} · 拖到轨道=把该角色加入镜头注入${hlChars.has(a.name) ? " · 🎯定位线镜头将注入此角色" : ""}`}
                    draggable
                    onDragStart={(e) => dragStartAsset(e, {
                      assetId: a.id, kind: "character", name: a.name, imageUrl: cover ?? null })}
                    onClick={() => { setOpenChar(open ? null : a.name); setMergeSel(new Set()); }}>
                    <span className={`dock-caret ${open ? "open" : ""}`}>▶</span>
                    {cover
                      ? <img className="lib-char-avatar" src={api.mediaUrl(cover)} alt={a.name} />
                      : <span className="lib-char-avatar ph">{assetJob ? "⏳" : "👤"}</span>}
                    <span className="lib-char-name">{a.name}</span>
                    <span className="muted">
                      {sts.length} 个阶段{sts.some((s) => !s.image_url) && " · ⚠缺图"}
                    </span>
                  </div>
                  {open && (
                    <div className="lib-stage-list">
                      {sts.map((s) => (
                        <div key={s.id} className="lib-stage-row" draggable
                          title="点击打开详情（用途/参数/生成）· 拖到人物轨该角色的段上=替换该阶段定妆图"
                          onClick={() => setAssetDlg({
                            kind: "character", name: s.character_name, assetId: a.id,
                            stage: s, imageUrl: s.image_url, voiceUrl: a.voice_url,
                            assetPrompt: a.prompt })}
                          onDragStart={(e) => dragStartAsset(e, {
                            assetId: null, kind: "character", name: s.character_name,
                            imageUrl: s.image_url, stageId: s.id })}>
                          <input type="checkbox" title="勾选 2 个以上可合并"
                            checked={mergeSel.has(s.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setMergeSel((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(s.id); else next.delete(s.id);
                              return next;
                            })} />
                          {s.image_url
                            ? <img className="lib-stage-thumb" src={api.mediaUrl(s.image_url)} alt="" />
                            : <span className="lib-stage-thumb ph" title="还没有定妆图">⚠</span>}
                          <span className="lib-stage-info">
                            <b>{s.stage_name}</b>
                            <em>第{s.ep_from}-{s.ep_to}集{s.image_url ? "" : " · 待生成"}</em>
                          </span>
                        </div>
                      ))}
                      {sts.length >= 2 && (
                        <button className="btn" style={{ width: "100%" }}
                          disabled={mergeSel.size < 2 || merging}
                          title={mergeSel.size < 2 ? "勾选 2 个以上区别不大的阶段" : "合并为一个阶段（区间取并集）"}
                          onClick={() => doMergeStages(a.name)}>
                          {merging ? "合并中…" : `⤵ 合并所选（${mergeSel.size}）为一个设定`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            };
            return (
              <>
                {/* ===== 👤 人物大分组（可整体折叠）：主角独立条目 + 其他角色折叠组 ===== */}
                {chars.length > 0 && (
                  <>
                    <div className="lib-sec clickable" onClick={() => toggleSec("chars")}>
                      <span className={`dock-caret ${secOpen.chars ? "open" : ""}`}>▶</span>
                      👤 人物（{chars.length}）
                      <span className="muted" style={{ fontWeight: 400 }}> · 拖卡片上轨道可加入注入</span>
                    </div>
                    {secOpen.chars && (
                      <div className="lib-cols">
                        {mains.map(renderMainChar)}
                        {others.length > 0 && (
                          <div className={`lib-char ${secOpen.others ? "open" : ""}`}>
                            <div className="lib-char-head" onClick={() => toggleSec("others")}>
                              <span className={`dock-caret ${secOpen.others ? "open" : ""}`}>▶</span>
                              <span className="lib-char-avatar ph">👥</span>
                              <span className="lib-char-name">其他角色</span>
                              <span className="muted">{others.length} 个（单一设定）</span>
                            </div>
                            {secOpen.others && (
                              <div className="lib-stage-list">
                                {others.map((a) => {
                                  const st = stagesOf(a.name)[0];
                                  const img = st?.image_url ?? a.image_url;
                                  return (
                                    <div key={a.name} className={`lib-stage-row ${hlChars.has(a.name) ? "at-cursor" : ""}`} draggable
                                      title={`${a.name} · 点击打开详情 · 拖到轨道=把该角色加入镜头注入${hlChars.has(a.name) ? " · 🎯定位线镜头将注入此角色" : ""}`}
                                      onClick={() => setAssetDlg({
                                        kind: "character", name: a.name, assetId: a.id,
                                        stage: st ?? null, imageUrl: img, voiceUrl: a.voice_url,
                                        assetPrompt: a.prompt })}
                                      onDragStart={(e) => dragStartAsset(e, {
                                        assetId: a.id, kind: "character", name: a.name,
                                        imageUrl: img, stageId: st?.id })}>
                                      {img
                                        ? <img className="lib-stage-thumb" src={api.mediaUrl(img)} alt="" />
                                        : <span className="lib-stage-thumb ph">{assetJob ? "⏳" : "👤"}</span>}
                                      <span className="lib-stage-info">
                                        <b>{a.name}</b>
                                        <em>{st ? `第${st.ep_from}-${st.ep_to}集` : "无阶段"}{!img && " · ⚠缺图"}</em>
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                {/* ===== 🏞 场景大分组（可整体折叠） ===== */}
                {locs.length > 0 && (
                  <>
                    <div className="lib-sec clickable" onClick={() => toggleSec("locs")}>
                      <span className={`dock-caret ${secOpen.locs ? "open" : ""}`}>▶</span>
                      🏞 场景（{locs.length}）
                      <span className="muted" style={{ fontWeight: 400 }}> · 拖上场景轨=注入/换参考图</span>
                    </div>
                    {secOpen.locs && (
                      <div className="lib-cols">
                        {locs.map((a) => (
                          <div key={`l-${a.name}`} className={`lib-card ${hlLoc === a.name ? "at-cursor" : ""}`}
                            title={`${a.name} · 点击打开详情 · 可拖到场景轨${hlLoc === a.name ? " · 🎯定位线镜头将注入此场景" : ""}`}
                            draggable
                            onClick={() => setAssetDlg({
                              kind: "location", name: a.name, assetId: a.id,
                              stage: null, imageUrl: a.image_url, assetPrompt: a.prompt })}
                            onDragStart={(e) => dragStartAsset(e, {
                              assetId: a.id, kind: "location", name: a.name, imageUrl: a.image_url })}>
                            {a.image_url
                              ? <img src={api.mediaUrl(a.image_url)} alt={a.name} />
                              : <div className="lib-asset-pending">{assetJob ? "⏳" : "🏞"}</div>}
                            <div className="lib-name">{a.name}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* ===== ✨ 自定义大分组：用户自建资产（上传 / AI 生图） ===== */}
                <div className="lib-sec clickable" onClick={() => toggleSec("custom")}>
                  <span className={`dock-caret ${secOpen.custom ? "open" : ""}`}>▶</span>
                  ✨ 自定义（{customs.length}）
                  <span className="muted" style={{ fontWeight: 400 }}> · 拖上人物/场景轨自动归类</span>
                </div>
                {secOpen.custom && (
                  <>
                    <div className="row">
                      <button className="btn" style={{ flex: 1 }} disabled={customBusy}
                        onClick={() => customFileRef.current?.click()}>
                        {customBusy ? "处理中…" : "＋ 上传图片"}
                      </button>
                      <button className="btn" style={{ flex: 1 }} disabled={customBusy}
                        onClick={() => setCustomGen({ name: "", prompt: "" })}>🎨 AI 生图</button>
                    </div>
                    <input ref={customFileRef} type="file" accept=".png,.jpg,.jpeg,.webp" hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void doCustomUpload(f);
                        e.target.value = "";
                      }} />
                    <div className="lib-cols">
                      {customs.map((a) => (
                        <div key={a.id} className="lib-card" title={`${a.name} · 点击打开详情 · 拖到人物/场景轨自动归类`}
                          draggable
                          onClick={() => setAssetDlg({
                            kind: "custom", name: a.name, assetId: a.id,
                            stage: null, imageUrl: a.image_url, assetPrompt: a.prompt })}
                          onDragStart={(e) => dragStartAsset(e, {
                            assetId: a.id, kind: "custom", name: a.name, imageUrl: a.image_url })}>
                          {a.image_url
                            ? <img src={api.mediaUrl(a.image_url)} alt={a.name} />
                            : <div className="lib-asset-pending">🖼</div>}
                          <button className="lib-del" title="删除此自定义资产"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`删除自定义资产「${a.name}」？`))
                                void api.deleteAsset(a.id).then(() => p.onRefresh()).catch((err) => p.onToast(String(err)));
                            }}>🗑</button>
                          <div className="lib-name">{a.name}</div>
                        </div>
                      ))}
                      {!customs.length && (
                        <div className="muted pad">上传图片或 AI 生图创建自定义资产（道具/风格参考等）</div>
                      )}
                    </div>
                  </>
                )}

                {/* ===== 📦 素材池大分组（可整体折叠） ===== */}
                <div className="lib-sec clickable" onClick={() => toggleSec("pool")}>
                  <span className={`dock-caret ${secOpen.pool ? "open" : ""}`}>▶</span>
                  📦 素材池（{p.clips.length}）
                  <span className="muted" style={{ fontWeight: 400 }}> · 云端保存，视频可＋插入镜头轨</span>
                </div>
                {secOpen.pool && (
                <div className="lib-cols">
                  {p.clips.map((c) => (
                    <div key={c.id} className="lib-card" onClick={() => p.onPreview(c)} title={c.name}>
                      {c.kind === "video" ? (
                        <video src={api.mediaUrl(c.url)} muted preload="metadata" />
                      ) : c.kind === "image" ? (
                        <img src={api.mediaUrl(c.url)} alt={c.name} />
                      ) : (
                        <div className="lib-audio">🎵</div>
                      )}
                      {c.duration > 0 && <span className="lib-dur">{fmtTime(c.duration)}</span>}
                      {c.kind === "video" && (
                        <button className="lib-add" title="插入镜头轨末尾（作为片头/片尾/转场等外部素材）"
                          disabled={p.inserting}
                          onClick={(e) => { e.stopPropagation(); p.onAddToTimeline(c); }}>
                          {p.inserting ? "⏳" : "＋"}
                        </button>
                      )}
                      <button className="lib-del" title="从素材池删除（连文件）"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`删除素材「${c.name}」？（已插入镜头轨的引用会失效）`))
                            p.onDeleteClip(c.id);
                        }}>🗑</button>
                      <div className="lib-name">{c.name}</div>
                    </div>
                  ))}
                  {!p.clips.length && !uploading && (
                    <div className="muted pad">上传片头/片尾/转场/实拍素材，云端保存不丢失</div>
                  )}
                </div>
                )}
                {!chars.length && !locs.length && !p.clips.length && !uploading && (
                  <div className="muted pad">拆解后角色/场景会出现在这里，可一键生成资产图</div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* AI 生成资产图 · 勾选确认弹窗：默认勾主角全部阶段，配角/场景主动勾选 */}
      {genPick !== null && (() => {
        const byName = new Map<string, StageInfo[]>();
        for (const s of p.stages) {
          const arr = byName.get(s.character_name) ?? [];
          arr.push(s); byName.set(s.character_name, arr);
        }
        const mains2 = [...byName.entries()].filter(([, v]) => v.length >= 2);
        const supNames = p.assetsMeta
          .filter((a) => a.kind === "character" && (byName.get(a.name)?.length ?? 0) < 2)
          .map((a) => a.name);
        const locNames = p.assetsMeta.filter((a) => a.kind === "location").map((a) => a.name);
        const toggle = (key: string) => setGenPick((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        });
        const bulk = (keys: string[], on: boolean) => setGenPick((prev) => {
          const next = new Set(prev);
          for (const k of keys) { if (on) next.add(k); else next.delete(k); }
          return next;
        });
        const supKeys = supNames.map((n) => `char:${n}`);
        const locKeys = locNames.map((n) => `loc:${n}`);
        return (
          <div className="drawer-mask" onClick={() => setGenPick(null)}>
            <div className="wizard" onClick={(e) => e.stopPropagation()}>
              <h2>AI 生成资产图（{genPick.size} 项）</h2>
              <div className="genpick-body">
                {mains2.length > 0 && <div className="lib-sec">👤 主角阶段（默认全选）</div>}
                {mains2.map(([name, sts]) => sts.map((s) => (
                  <label key={s.id} className="genpick-row">
                    <input type="checkbox" checked={genPick.has(`stage:${s.id}`)}
                      onChange={() => toggle(`stage:${s.id}`)} />
                    <b>{name}</b> · {s.stage_name}（第{s.ep_from}-{s.ep_to}集）
                    {s.image_url && <em className="muted"> 已有图，将覆盖</em>}
                  </label>
                )))}
                {supNames.length > 0 && (
                  <div className="lib-sec">👥 配角
                    <button className="btn ghost genpick-all"
                      onClick={() => bulk(supKeys, !supKeys.every((k) => genPick.has(k)))}>
                      {supKeys.every((k) => genPick.has(k)) ? "取消全选" : "全选配角"}
                    </button>
                  </div>
                )}
                {supNames.map((n) => (
                  <label key={n} className="genpick-row">
                    <input type="checkbox" checked={genPick.has(`char:${n}`)}
                      onChange={() => toggle(`char:${n}`)} />
                    {n}
                    {p.assetsMeta.find((a) => a.kind === "character" && a.name === n)?.image_url
                      && <em className="muted"> 已有图，将覆盖</em>}
                  </label>
                ))}
                {locNames.length > 0 && (
                  <div className="lib-sec">🏞 场景（默认不勾）
                    <button className="btn ghost genpick-all"
                      onClick={() => bulk(locKeys, !locKeys.every((k) => genPick.has(k)))}>
                      {locKeys.every((k) => genPick.has(k)) ? "取消全选" : "全选场景"}
                    </button>
                  </div>
                )}
                {locNames.map((n) => (
                  <label key={n} className="genpick-row">
                    <input type="checkbox" checked={genPick.has(`loc:${n}`)}
                      onChange={() => toggle(`loc:${n}`)} />
                    {n}
                    {p.assetsMeta.find((a) => a.kind === "location" && a.name === n)?.image_url
                      && <em className="muted"> 已有图，将覆盖</em>}
                  </label>
                ))}
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn ghost" onClick={() => setGenPick(null)}>取消</button>
                <button className="btn primary" disabled={!genPick.size} onClick={doGenConfirmed}>
                  ✨ 生成所选（{genPick.size}）
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 统一资产详情弹窗：用途（集数区间）+ 阶段 + 生成参数（点击资产卡打开） */}
      {assetDlg && (() => {
        // 同角色跨造型保脸：这张之外该角色已有的定妆图（与后端
        // asset_ref.character_base_ref 同口径：别的阶段图（最早的）> 角色通用图）
        const other = assetDlg.kind !== "character" ? null
          : (p.stages
            .filter((s) => s.character_name === assetDlg.name && s.image_url
              && s.id !== assetDlg.stage?.id && s.image_url !== assetDlg.imageUrl)
            .sort((a, b) => a.ep_from - b.ep_from)[0]?.image_url
            ?? p.assetsMeta.find((a) => a.kind === "character" && a.name === assetDlg.name
              && a.image_url && a.image_url !== assetDlg.imageUrl)?.image_url
            ?? null);
        return (
          <AssetDialog projectId={p.projectId} target={assetDlg} shots={p.shots}
            baseRef={other}
            onClose={() => setAssetDlg(null)} onToast={p.onToast}
            onChanged={() => { p.onRefresh(); p.onRefreshStages(); }} />
        );
      })()}

      {/* 自定义资产 · AI 生图弹窗 */}
      {customGen && (
        <div className="drawer-mask" onClick={() => setCustomGen(null)}>
          <div className="wizard" onClick={(e) => e.stopPropagation()}>
            <h2>🎨 AI 生成自定义资产</h2>
            <label>资产名
              <input value={customGen.name} placeholder="如：金色怀表 / 赛博朋克风格版"
                onChange={(e) => setCustomGen({ ...customGen, name: e.target.value })} />
            </label>
            <label>生图提示词
              <AutoTextarea className="drawer-ta" minHeight={80}
                value={customGen.prompt} placeholder="描述要生成的图（主体/风格/构图）…"
                onChange={(e) => setCustomGen({ ...customGen, prompt: e.target.value })} />
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setCustomGen(null)}>取消</button>
              <button className="btn primary"
                disabled={customBusy || !customGen.name.trim() || !customGen.prompt.trim()}
                onClick={doCustomGen}>
                {customBusy ? "生成中…（约 10-30s）" : "✨ 生成并保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "shots" && (
        <ShotsPanel projectId={p.projectId} shots={p.shots} episodes={p.episodes}
          selectedShotId={p.selectedShotId} cursorOrder={p.cursorOrder} onSelect={p.onSelectShot}
          onGenerate={p.onGenerate} onSwitchVersion={p.onSwitchVersion}
          onAdvanced={p.onAdvanced} generating={p.generating} jobPhase={p.jobPhase}
          onBreakdown={p.onBreakdown} breakdownProgress={p.breakdownProgress}
          onFirstFrames={p.onFirstFrames} onReprompt={p.onReprompt}
          onPipeline={p.onPipeline}
          onCostumeScan={p.onCostumeScan}
          onGotoAssets={() => setTab("assets")} onToast={p.onToast}
          hasScript={epContents.length > 0} />
      )}
    </aside>
  );
}
