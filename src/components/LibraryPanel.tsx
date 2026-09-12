import { useEffect, useRef, useState } from "react";
import { api, AssetInfo, DeletedStageInfo, EpisodeInfo, JobOut, JobPhase, ShotInfo, StageInfo } from "../api";
import type { AssetDragData } from "../api";
import { LibClip, fmtTime } from "../types";
import { useMediaPipeline, type MediaPipeline } from "../hooks/useMediaPipeline";
import ShotsPanel from "./ShotsPanel";
import AssetDialog, { AssetDialogTarget } from "./AssetDialog";
import SceneCanonDialog from "../features/scenes/SceneCanonDialog";
import AutoTextarea from "./AutoTextarea";
import { startDrag } from "../features/timeline/pointerDrag";
import {
  assetDropTargetAt, assetHotElement, commitAssetDrop,
} from "../features/assets/useAssetDrop";
import type { AssetDropCtx } from "../features/assets/useAssetDrop";

/** 卡片拖出去的载荷。就是 `AssetDragData`，这里起个别名只因它在两个通道里
 *  都当"数据"用，读代码时名字更贴切。 */
type AssetDragPayload = AssetDragData;

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
  /** 被删除的造型阶段（墓碑）：只用于「🗑 已删除的造型」组的恢复入口 */
  deletedStages?: DeletedStageInfo[];
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
  /** 上传管道。App 顶层已经建了一个（系统拖入要用），传进来就复用它，
   *  避免同一时刻存在两个归属面板实例（见 useMediaPipeline 头注释）。 */
  mediaPipeline?: MediaPipeline;
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
  /**
   * 资产卡拖到轨道上的落点上下文（3.11）。
   *
   * 由 App 组装 —— 它才知道 `pxPerSec`（缩放）、`offsetMap`（镜头起始秒）
   * 和 `pushUndo`。面板自己算的话，缩放一变侧栏的落点就与时间轴对不上了，
   * 而那是**静默**的：拖上去能放、只是放错镜头。
   *
   * 不传 = 只保留旧的 HTML5 通道（网页版沿用，回归安全）。
   */
  assetDropCtx?: AssetDropCtx;
}

export type Tab = "script" | "assets" | "shots";

/** 左侧面板：剧本(按集直接编辑) / 资产(含上传) / 镜头(拆解+提示词+生成)。 */
export default function LibraryPanel(p: Props) {
  const [innerTab, setInnerTab] = useState<Tab>("script");
  const tab = p.tab ?? innerTab;
  const setTab = (t: Tab) => { p.onTabChange ? p.onTabChange(t) : setInnerTab(t); };
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const scriptFileRef = useRef<HTMLInputElement>(null);

  /** 「上传自己的图」的归属确认。与媒体池上传共用同一套规则与面板
   *  （见 `useMediaPipeline` 头注释）：两边各写一份的话，"资产页传"和
   *  "媒体池传"迟早会给出不同的归属结果。 */
  const ownPipeline = useMediaPipeline({
    projectId: p.projectId,
    onToast: p.onToast,
    onAddClips: p.onAddClips,
    assets: p.assetsMeta,
    // 资产页的落库会新增/覆盖资产行，两处都要重拉：refresh 是资产列表，
    // refreshStages 是角色分层（新挂上去的图要在分层里立刻可见）。
    onAssetsChanged: () => { p.onRefresh(); p.onRefreshStages(); },
  });
  const { uploadFiles, uploading, attributionDialog } = p.mediaPipeline ?? ownPipeline;

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

  // 素材池的「＋ 上传」也走同一条管道：它跟媒体面板的上传是同一件事，
  // 只是入口在资产页。以前这里自己传一遍，于是同一个文件从资产页传不会
  // 触发图片归属、从媒体面板传会 —— 同一个动作两种结果。
  const importFiles = (files: FileList) => {
    setErr("");
    void uploadFiles(Array.from(files));
  };

  // ---- 资产页角色分层（修 E3）：展开的角色 + 合并勾选 ----
  const [openChar, setOpenChar] = useState<string | null>(null);
  const [mergeSel, setMergeSel] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  // ---- 大分组整体折叠：人物 / 场景 / 自定义 / 素材池 ----
  const [secOpen, setSecOpen] = useState<Record<string, boolean>>({
    chars: true, others: false, locs: true, custom: true, pool: true,
    gone: false,     // 已删除资产：默认收起，只在删错了要找回时展开
    goneStages: false,   // 已删除的造型阶段：同上
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
  // ---- 场景名归一面板（U3）：预览 + 逐组确认，不提供"一键全归一" ----
  const [sceneCanon, setSceneCanon] = useState(false);
  // ---- 删除 / 恢复资产（软删，后端打墓碑）----
  //
  // 用户的原话是「有些人物或场景资产并不重要，但自动生成时出错了」，
  // 要的是**别再管它**：不再注入参考图、不再计入缺图缺口、不再被自动流程
  // 重画。所以这不是"从库里抹掉"，剧本与镜头一个字都不动——确认文案必须
  // 把这条边界说清楚，否则用户会以为删了角色戏也没了。
  const [delBusy, setDelBusy] = useState<string | null>(null);
  const doDeleteAsset = async (a: AssetInfo) => {
    const what = a.kind === "location" ? "场景" : a.kind === "character" ? "角色" : "资产";
    if (!window.confirm(
      `不再生成${what}「${a.name}」的参考图？\n\n`
      + `· 剧本与镜头不变：这个${what}在镜头里照旧存在，台词一个字不改\n`
      + `· 后续生成不再带它：不注入参考图、不算缺图、一键成片不会再把它画回来\n`
      + `· 已生成的图保留：随时可在「🗑 已删除」里恢复`)) return;
    setDelBusy(a.id);
    try {
      const r = await api.deleteAsset(a.id);
      p.onRefresh();
      p.onToast(r.affected_shots
        ? `已停用「${a.name}」（剧本里仍有 ${r.affected_shots} 个镜头提到它，镜头未改动）`
        : `已停用「${a.name}」`);
    } catch (e) { p.onToast(`删除失败：${String(e).slice(0, 160)}`); }
    finally { setDelBusy(null); }
  };
  const doRestoreAsset = async (a: AssetInfo) => {
    setDelBusy(a.id);
    try {
      await api.restoreAsset(a.id);
      p.onRefresh();
      p.onToast(`已恢复「${a.name}」，后续生成会重新带上它`);
    } catch (e) { p.onToast(`恢复失败：${String(e).slice(0, 160)}`); }
    finally { setDelBusy(null); }
  };

  // ---- 删除 / 恢复**单个造型阶段**（同为软删；用户原话「阶段删除后似乎没有
  //      撤销删除的能力」）----
  //
  // 与删角色的区别要在文案里说清：删阶段只是"这一套衣服不要了"，角色还在，
  // 该角色其它阶段照旧生成；区间落空的镜头会退回用基础/通用定妆图。
  const [stDelBusy, setStDelBusy] = useState<string | null>(null);
  const doDeleteStage = async (s: StageInfo, charName: string) => {
    if (!window.confirm(
      `删除「${charName}·${s.stage_name}」这一套造型？\n\n`
      + `· 剧本与镜头不变：第${s.ep_from}-${s.ep_to}集照旧，只是不再按这套造型出图\n`
      + `· 该角色其它造型不受影响；这段集会退回用基础/通用定妆图\n`
      + `· 可恢复：定妆图保留，在「🗑 已删除的造型」里点 ↩ 撤销`)) return;
    setStDelBusy(s.id);
    try {
      const r = await api.deleteStage(s.id);
      p.onRefreshStages();
      // followers = 把它当图源的指针行。不报出来的话，用户事后才发现"另外几段也没图了"。
      p.onToast(r.followers
        ? `已删除「${s.stage_name}」（另有 ${r.followers} 段共用它的图，已一并失去图源）`
        : `已删除「${s.stage_name}」，可在「🗑 已删除的造型」里恢复`);
    } catch (e) { p.onToast(`删除失败：${String(e).slice(0, 160)}`); }
    finally { setStDelBusy(null); }
  };
  const doRestoreStage = async (s: DeletedStageInfo) => {
    setStDelBusy(s.id);
    try {
      await api.restoreStage(s.id);
      p.onRefreshStages();
      p.onToast(`已恢复「${s.character_name}·${s.stage_name}」`);
    } catch (e) {
      // 409 = 区间已被后建的阶段占了（墓碑刻意不占集区间）。后端的 detail 已经
      // 点名了和谁撞、区间是多少，直接透给用户，比"恢复失败"有用。
      p.onToast(`恢复失败：${String(e).replace(/^ApiError:\s*/, "").slice(0, 200)}`);
    }
    finally { setStDelBusy(null); }
  };

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
      // ⚠️ 这条轮询**刻意不做 SSE 降频**（U1 第 1 点其余四处都降了）：
      // 后端没有"资产"事件 —— events.publish 只有 job / shot / audio / resync，
      // 而 useProdJobs 收到资产 job 事件时刷的是 detail，不是资产列表。
      // 也就是说这里是资产图"逐张点亮"的**唯一**来源，降到 15s 就变成十几秒
      // 才跳出一张图。资产列表本身是几十行 JSON（图走各自的缓存 GET），
      // 3s 一次的代价远小于把用户晾在那儿。
      assetTimer.current = window.setInterval(async () => {
        // 回调必须自己吞异常：抛出去是 unhandled rejection，而且 interval
        // 不会因此停下 —— 一次网络抖动就会在控制台刷屏到任务结束。
        let s: JobOut;
        try {
          s = await api.jobStatus(j.id);
        } catch (e) {
          console.warn("[LibraryPanel] 资产生成状态轮询失败，稍后重试:", e);
          return;
        }
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
  //
  // 「上传自己的图」不再直接建成 `kind: "custom"` —— 那正是用户抱怨的那个 bug：
  // 每个文件都被送进唯一一类**永远不会被注入到镜头**的资产里。现在交给归属面板
  // 按文件名/目录判它到底是谁，custom 只是"实在认不出来"时的一个选项。
  const doCustomUpload = (f: File) => { void uploadFiles([f]); };
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
  const dragStartAsset = (e: React.DragEvent, data: AssetDragPayload) => {
    e.dataTransfer.setData("application/x-fw-asset", JSON.stringify(data));
    e.dataTransfer.effectAllowed = "copy";
  };

  /**
   * 资产卡拖拽起手（**3.11 主管道**）。
   *
   * 桌面端里上面那个 HTML5 `draggable` **根本不会触发** —— 宿主装了 OS 级
   * `IDropTarget`，指针一路是禁止光标，页面拿不到 `dragstart`。所以这里再挂一条
   * 指针通道：`pointerdown` 起手、越过阈值才成型（因此不影响点击打开详情）、
   * 松手用 `elementFromPoint` 定落点。机理见 `pointerDrag.ts` 头注释。
   *
   * 两条通道**同时留着**：网页版（浏览器里跑 `/fw/app/`）没有那个宿主，
   * 走的仍是 `dataTransfer`，删掉就回归了。判据不是"哪个更新"，
   * 而是指针通道在宿主下能跑、HTML5 不能。
   */
  const dragStartAssetPointer = (
    e: React.PointerEvent, data: AssetDragPayload,
  ) => {
    if (e.button !== 0) return;
    // 卡片身兼多职（点开详情、勾选合并阶段、按删除键）。在这些**控件**上按下
    // 时不能接管：`preventDefault()` 会顺手把复选框的切换也挡掉。
    // 判据是"按在了交互控件上"，不是"按在了卡片上"。
    const t = e.target as HTMLElement;
    if (t.closest("button, input, textarea, select, a, [contenteditable]")) return;
    // 卡片里有 <img>，浏览器会自起一次原生图片拖拽并把指针流打断
    e.preventDefault();
    const scroller = e.currentTarget.closest<HTMLElement>(".fw-tl-scroll")
      ?? document.querySelector<HTMLElement>(".fw-tl-scroll");
    startDrag({
      intent: "asset",
      el: null,                     // 卡片留在原地，不跟手（它本来就不该离开侧栏）
      label: data.name,
      x0: e.clientX, y0: e.clientY,
      scroll0: { left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 },
      scroller,
      pxPerSec: 1,                  // 资产落点按镜头吸附，不用像素→秒换算
      data,
    }, {
      hotTarget: (r) => assetHotElement(assetDropTargetAt(r.hit)),
      onCommit: (_s, r) => {
        const target = assetDropTargetAt(r.hit);
        const ctx = p.assetDropCtx;
        if (!ctx) return;
        void commitAssetDrop(target, data, r.clientX, ctx).then((ok) => {
          if (!ok) p.onToast(`把小图拖到轨道或资产段的「${data.name}」上才能放进去`);
        });
      },
      onCancel: () => { /* 没构成拖动 = 点击，交给 onClick 打开详情 */ },
    });
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
              title={p.assetsMeta.some((a) => a.kind === "character") ? "挑选要生成的资产图：默认全选主角，配角和场景可自己勾" : "先在「🎬 镜头」页完成拆解"}>
              {assetJob ? `生成中 ${assetJob.progress}%` : "✨ AI 生成资产图"}
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
            // 墓碑资产（用户删掉的）不进正常分组：后端**故意**照旧下发它们，
            // 由前端隐藏 + 提供恢复入口，删错了才找得回来。
            const live = p.assetsMeta.filter((a) => !a.deleted_at);
            const gone = p.assetsMeta.filter((a) => a.deleted_at);
            // 被删的造型阶段（后端单独下发，不混进 stages —— 那份的契约是
            // 「轨道显示 = 实际注入」）。只在被删角色仍在用时才列：整个角色都
            // 删掉了的话，恢复单个造型没有意义，该走上面的资产恢复。
            const goneNames = new Set(gone.map((a) => a.name));
            const goneStages = (p.deletedStages ?? [])
              .filter((s) => !goneNames.has(s.character_name));
            const chars = live.filter((a) => a.kind === "character");
            const locs = live.filter((a) => a.kind === "location");
            const customs = live.filter((a) => a.kind === "custom");
            // 镜头里写到的场景写法数：场景资产还没建时，归一入口靠它决定要不要显示
            const shotLocCount = new Set(
              p.shots.map((s) => (s.location ?? "").trim()).filter(Boolean)).size;
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
                    onPointerDown={(e) => dragStartAssetPointer(e, {
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
                    <button className="lib-x" title="不再生成这个角色的参考图（剧本不变，可恢复）"
                      disabled={delBusy === a.id}
                      onClick={(e) => { e.stopPropagation(); void doDeleteAsset(a); }}>🗑</button>
                  </div>
                  {open && (
                    <div className="lib-stage-list">
                      {sts.map((s) => (
                        <div key={s.id} className="lib-stage-row" draggable
                          title="点击查看详情；拖到时间轴上该角色的片段，可替换这一阶段的定妆图"
                          onClick={() => setAssetDlg({
                            kind: "character", name: s.character_name, assetId: a.id,
                            stage: s, imageUrl: s.image_url, voiceUrl: a.voice_url,
                            assetPrompt: a.prompt })}
                          onDragStart={(e) => dragStartAsset(e, {
                            assetId: null, kind: "character", name: s.character_name,
                            imageUrl: s.image_url, stageId: s.id })}
                          onPointerDown={(e) => dragStartAssetPointer(e, {
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
                          {/* 阶段级快删：以前只有资产弹窗里有，用户得点进去两层才能删掉
                              一套识别错的造型（原话「希望在卡片上面就能直接点击快速删除」）。 */}
                          <button className="lib-x" disabled={stDelBusy === s.id}
                            title="删除这一套造型（剧本不变，可恢复）"
                            onClick={(e) => { e.stopPropagation(); void doDeleteStage(s, a.name); }}>🗑</button>
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
                                        imageUrl: img, stageId: st?.id })}
                                      onPointerDown={(e) => dragStartAssetPointer(e, {
                                        assetId: a.id, kind: "character", name: a.name,
                                        imageUrl: img, stageId: st?.id })}>
                                      {img
                                        ? <img className="lib-stage-thumb" src={api.mediaUrl(img)} alt="" />
                                        : <span className="lib-stage-thumb ph">{assetJob ? "⏳" : "👤"}</span>}
                                      <span className="lib-stage-info">
                                        <b>{a.name}</b>
                                        <em>{st ? `第${st.ep_from}-${st.ep_to}集` : "无阶段"}{!img && " · ⚠缺图"}</em>
                                      </span>
                                      <button className="lib-x" disabled={delBusy === a.id}
                                        title="不再生成这个角色的参考图（剧本不变，可恢复）"
                                        onClick={(e) => { e.stopPropagation(); void doDeleteAsset(a); }}>🗑</button>
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
                {/* ===== 🏞 场景大分组（可整体折叠） =====
                    显示条件是「有场景资产 **或** 镜头里写了场景名」：归一入口在还没出
                    任何场景图时就该能点（归一决定服装继承/基准帧共享，早改代价最小），
                    而资产是在「资产」阶段才建的。只按 locs.length 判会把入口整段藏掉。 */}
                {(locs.length > 0 || shotLocCount > 0) && (
                  <>
                    <div className="lib-sec clickable" onClick={() => toggleSec("locs")}>
                      <span className={`dock-caret ${secOpen.locs ? "open" : ""}`}>▶</span>
                      🏞 场景（{locs.length}）
                      <span className="muted" style={{ fontWeight: 400 }}> · 拖上场景轨=注入/换参考图</span>
                      {/* 常显（半透明），不藏进 hover：藏起来的按钮等于没这功能。
                          外层 div 是折叠开关，必须 stopPropagation 否则点它会折叠分组 */}
                      <button className="btn ghost lib-sec-act"
                        title="同一个空间的多种写法归为一组（决定服装继承与场景基准帧共享）"
                        onClick={(e) => { e.stopPropagation(); setSceneCanon(true); }}>
                        🔗 场景名归一
                      </button>
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
                              assetId: a.id, kind: "location", name: a.name, imageUrl: a.image_url })}
                            onPointerDown={(e) => dragStartAssetPointer(e, {
                              assetId: a.id, kind: "location", name: a.name, imageUrl: a.image_url })}>
                            {a.image_url
                              ? <img src={api.mediaUrl(a.image_url)} alt={a.name} />
                              : <div className="lib-asset-pending">{assetJob ? "⏳" : "🏞"}</div>}
                            <button className="lib-del" disabled={delBusy === a.id}
                              title="不再生成这个场景的参考图（剧本不变，可恢复）"
                              onClick={(e) => { e.stopPropagation(); void doDeleteAsset(a); }}>🗑</button>
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
                      <button className="btn" style={{ flex: 1 }}
                        title="上传后会先猜它属于哪个角色/场景，确认后才入库"
                        onClick={() => customFileRef.current?.click()}>
                        {uploading ? "上传中…" : "＋ 上传图片"}
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
                            assetId: a.id, kind: "custom", name: a.name, imageUrl: a.image_url })}
                          onPointerDown={(e) => dragStartAssetPointer(e, {
                            assetId: a.id, kind: "custom", name: a.name, imageUrl: a.image_url })}>
                          {a.image_url
                            ? <img src={api.mediaUrl(a.image_url)} alt={a.name} />
                            : <div className="lib-asset-pending">🖼</div>}
                          <button className="lib-del" title="删除此自定义资产（可恢复）"
                            disabled={delBusy === a.id}
                            onClick={(e) => { e.stopPropagation(); void doDeleteAsset(a); }}>🗑</button>
                          <div className="lib-name">{a.name}</div>
                        </div>
                      ))}
                      {!customs.length && (
                        <div className="muted pad">上传图片或 AI 生图创建自定义资产（道具/风格参考等）</div>
                      )}
                    </div>
                  </>
                )}

                {/* ===== 🗑 已删除大分组：墓碑资产的唯一可见处 =====
                    存在的理由只有一个——删错了要能找回来。后端并不真删行、
                    也不删磁盘上的图（`media` 的 GC 引用扫描故意连墓碑一起扫），
                    所以恢复是无损的。 */}
                {gone.length > 0 && (
                  <>
                    <div className="lib-sec clickable" onClick={() => toggleSec("gone")}>
                      <span className={`dock-caret ${secOpen.gone ? "open" : ""}`}>▶</span>
                      🗑 已删除（{gone.length}）
                      <span className="muted" style={{ fontWeight: 400 }}> · 不参与生成，可恢复</span>
                    </div>
                    {secOpen.gone && (
                      <div className="lib-cols">
                        {gone.map((a) => (
                          <div key={`g-${a.id}`} className="lib-card lib-card-gone"
                            title={`${a.name} · 已停用，不再参与生成`}>
                            {a.image_url
                              ? <img src={api.mediaUrl(a.image_url)} alt={a.name} />
                              : <div className="lib-asset-pending">
                                  {a.kind === "location" ? "🏞" : a.kind === "character" ? "👤" : "🖼"}
                                </div>}
                            <button className="lib-del lib-del-restore" disabled={delBusy === a.id}
                              title="恢复：后续生成重新带上它"
                              onClick={(e) => { e.stopPropagation(); void doRestoreAsset(a); }}>↩</button>
                            <div className="lib-name">{a.name}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* ===== 🗑 已删除的造型：单个造型阶段的墓碑 =====
                    与上面的「已删除」资产分成两组，因为它们不是一回事：
                    删资产 = 这个角色/场景整个不要了；删阶段 = 只是这一套衣服不要了，
                    角色还在。混在一组里用户无法判断点 ↩ 会恢复出什么。 */}
                {goneStages.length > 0 && (
                  <>
                    <div className="lib-sec clickable" onClick={() => toggleSec("goneStages")}>
                      <span className={`dock-caret ${secOpen.goneStages ? "open" : ""}`}>▶</span>
                      🗑 已删除的造型（{goneStages.length}）
                      <span className="muted" style={{ fontWeight: 400 }}> · 不参与生成，可恢复</span>
                    </div>
                    {secOpen.goneStages && (
                      <div className="lib-cols">
                        {goneStages.map((s) => (
                          <div key={`gs-${s.id}`} className="lib-card lib-card-gone"
                            title={`${s.character_name}·${s.stage_name}（第${s.ep_from}-${s.ep_to}集）已删除，不再参与生成`}>
                            {s.image_url
                              ? <img src={api.mediaUrl(s.image_url)} alt={s.stage_name} />
                              : <div className="lib-asset-pending">👤</div>}
                            <button className="lib-del lib-del-restore" disabled={stDelBusy === s.id}
                              title="恢复这一套造型（若这段集已被新造型占用会提示冲突）"
                              onClick={(e) => { e.stopPropagation(); void doRestoreStage(s); }}>↩</button>
                            <div className="lib-name">
                              {s.character_name}·{s.stage_name}
                              <span className="muted"> 第{s.ep_from}-{s.ep_to}集</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
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

      {/* 场景名归一：改了映射后服装继承与场景资产都可能变 → 两份都要重拉 */}
      {sceneCanon && (
        <SceneCanonDialog projectId={p.projectId}
          onClose={() => setSceneCanon(false)} onToast={p.onToast}
          onChanged={() => { p.onRefresh(); p.onRefreshStages(); }} />
      )}

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

      {/* 上传图片后的归属确认（见 useAttribution）。渲染在这里而不是 App 顶层：
          它归属的是"这一批刚上传的图"，状态跟面板走。 */}
      {attributionDialog}
    </aside>
  );
}
