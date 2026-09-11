import { useEffect, useMemo, useRef, useState } from "react";
import { api, CharacterProfile, ProfileAxis, SceneGroup, SceneViewsOut, ShotInfo, StageInfo } from "../api";
import { parseEpisodeInput } from "../lib/formState";
import { compressImage, describeSaving } from "../lib/imageCompress";
import {
  CANDIDATE_COUNTS, candidateButtonLabel, candidateCostHint, defaultCandidateCount,
} from "../features/assets/candidatePlan";
import AutoTextarea from "./AutoTextarea";
import VoicePicker from "../features/audio/VoicePicker";

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

/** 后端 vision_desc.AUTO_PREFIX：库里带此前缀 = 早年 AI 看图自动写的造型。
 *  2026-09-10 起不再产生新的带前缀数据（看图改成手动按钮、结果经用户过目才存），
 *  这里只保留**读**路径：剥掉前缀显示，用户不该看见内部标记。 */
const AUTO_PREFIX = "〔自动识图〕";
const stripAuto = (s?: string | null): string =>
  (s ?? "").startsWith(AUTO_PREFIX) ? (s ?? "").slice(AUTO_PREFIX.length) : (s ?? "");

/**
 * 描述为空时，「✨生成」这一次临时套用的生图模板。
 *
 * ⚠️ **只在提交生图那一刻用，绝不落库**。以前它是输入框的初值，于是只要用户
 * 碰一下输入框，`角色立绘, 林晨, 全身, 高质量, 短剧风格` 就被存成了这个角色的
 * "造型描述"。而造型描述在出片时是要拼进**视频提示词**的（`jobs.py` 的
 * ref_notes 段），最终会长成「参考图1（林晨）：角色立绘, 林晨, 全身, 高质量,
 * 短剧风格」——对视频模型来说是纯噪声，还挤掉了真正该说的服装信息。
 */
const genTemplate = (kind: string, name: string): string =>
  kind === "location" ? `场景概念图, ${name}, 电影感, 高质量`
    : kind === "custom" ? ""
      : `角色立绘, ${name}, 全身, 高质量, 短剧风格`;

/** 统一资产详情弹窗：用途（集数区间）+ 阶段信息 + 生成参数（比例/分辨率/模型）+ 候选生成。
 *  资产页卡片单击、时间轴条目双击均打开此弹窗（轨道侧防误触）。 */
export default function AssetDialog(p: Props) {
  const t = p.target;
  // 已落库的造型描述：阶段上下文取 AssetStage.description，纯资产取 Asset.prompt。
  // 两者都是出片时喂给提示词优化器的"参考图文字锚点"，所以必须都能改、都能存。
  const savedDesc = t.stage ? t.stage.description : (t.assetPrompt ?? null);
  const descIsAuto = (savedDesc ?? "").startsWith(AUTO_PREFIX);
  // 空就是空 —— **不再**用生图模板预填（见 genTemplate 的注释：预填的模板会被
  // 当成真实造型描述存进库，再被拼进视频提示词）。没描述时 placeholder 给引导。
  const [prompt, setPrompt] = useState(() => stripAuto(savedDesc));
  // 只有用户真的动过输入框才落库：轨道侧打开时 assetPrompt 可能没传进来，
  // 此时框里是空的，若照常 onBlur 保存会把库里真实描述冲掉。
  const [promptDirty, setPromptDirty] = useState(false);
  //: 「AI 看图补写」在跑（只转这个按钮，不锁弹窗其它部分）
  const [descBusy, setDescBusy] = useState(false);
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
  /**
   * 生成张数 1–4。默认值**随处境变**（口径与理由见 `features/assets/candidatePlan.ts`）：
   * 还没有图时默认 1 张（第一次只求有，别一上手就花四倍钱），
   * 已有图时默认 4 张（这是"换一张"，没有对比就没得挑）。
   */
  const [genN, setGenN] = useState(() => defaultCandidateCount(!!t.imageUrl));
  // 拿该角色已有的定妆图当参考（图生图）→ 换造型不换脸。默认开：
  // 裸文生图的结果是同一个角色每张脸都不一样，后续视频全废。
  const [keepFace, setKeepFace] = useState(true);
  const [curImg, setCurImg] = useState(t.imageUrl);
  // 上传替换：图片（所有资产）+ 参考音色（角色资产）
  const imgFileRef = useRef<HTMLInputElement | null>(null);
  const voiceFileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [curVoice, setCurVoice] = useState(t.voiceUrl ?? null);
  // 音色库选择器：与「AI 配音/角色音色」面板共用同一个组件与同一条写入口
  // （api.patchAsset({voiceUrl})）。两处各写一套的话，空态文案和赋值行为必然漂移。
  const [voicePicking, setVoicePicking] = useState(false);
  /**
   * 上传的**明确**结果。原先整个上传过程只有按钮上一个「⏳」，成功/失败只发一条
   * 转瞬即逝的 toast，用户的原话是"没有明确反馈是否上传成功"——就是这个。
   * 这里改成弹窗内常驻一行状态，直到下一次上传才被覆盖。
   */
  const [upStat, setUpStat] = useState<
    { phase: "picking" | "uploading" | "ok" | "err"; what: string; msg?: string } | null>(null);
  /**
   * 文件选择框已打开、还没回来。
   *
   * 这是"关掉小窗口上传就失败"的**真正机制**：`<input type="file">` 就长在本弹窗里，
   * 系统选择框弹出时应用窗口在它后面；用户点回应用（点到遮罩上）→ 弹窗卸载 →
   * 那个 input 一起消失 → 选完文件后的 change 事件**没有任何接收方**。
   * 于是：文件选了、什么都没发生、也没有任何报错。
   * 所以选择框未回来之前同样不能关窗，不只是"上传中不能关"。
   */
  const [picking, setPicking] = useState(false);
  const busyUpload = uploading || picking;

  /**
   * 只在**选文件**期间挡住关闭。
   *
   * 2026-09-10 修正：这里原本连 `uploading` 一起挡，用户反馈"上传时整个页面被
   * 锁住什么都干不了"。上传阶段挡是没有道理的——文件已经交给 `fetch`，请求
   * 与组件生命周期无关，关掉弹窗上传照样跑完、照样落库、照样 toast。
   * 真正必须挡的只有 `picking`：那时 `<input type="file">` 还长在弹窗里，
   * 弹窗一卸载 input 就没了，选完文件的 change 事件没有任何接收方（见 picking 注释）。
   */
  const guardedClose = () => {
    if (picking) {
      p.onToast("⏳ 正在选择文件，选完或取消后再关闭窗口");
      return;
    }
    p.onClose();
  };

  /** 打开系统文件选择框。用户取消（没选文件）时 change 不触发，靠窗口重新获得
   *  焦点来解除 picking —— 否则取消一次就再也关不掉弹窗了。 */
  const openPicker = (ref: React.RefObject<HTMLInputElement | null>, what: string) => {
    setPicking(true);
    setUpStat({ phase: "picking", what });
    const done = () => {
      window.removeEventListener("focus", done);
      // 焦点回来时 change 可能还没派发，给一拍再判定
      window.setTimeout(() => {
        setPicking(false);
        setUpStat((s) => (s && s.phase === "picking" ? null : s));
      }, 350);
    };
    window.addEventListener("focus", done);
    ref.current?.click();
  };

  // ── 形象档案（角色专属）：这个角色**全剧统一**的长相。
  // 与上面的「造型描述」分工：档案是脸，造型是衣服。衣服每套一份，脸只有一份。
  // 词表由后端给（后端是唯一事实来源），前端只负责渲染下拉与落库。
  const [profAxes, setProfAxes] = useState<ProfileAxis[]>([]);
  const [prof, setProf] = useState<CharacterProfile | null>(null);
  const [profOpen, setProfOpen] = useState(false);
  const [profBusy, setProfBusy] = useState(false);
  const [profLoaded, setProfLoaded] = useState(false);
  // 展开时才拉：绝大多数打开弹窗的场景是看图/改造型，不该为此多一次请求
  useEffect(() => {
    if (!profOpen || profLoaded || t.kind !== "character" || !t.assetId) return;
    api.assetProfile(t.assetId).then((r) => {
      setProfAxes(r.axes); setProf(r.profile); setProfLoaded(true);
    }).catch(() => {
      setProfLoaded(true);   // 旧后端无此接口：面板显示"暂不可用"，不弹错
    });
  }, [profOpen, profLoaded, t.kind, t.assetId]);

  /** 改一条轴（本地先改，失焦/选完即存——档案字段多，逐条存比"保存"按钮省事） */
  const setAxis = async (key: string, value: string) => {
    if (!t.assetId) return;
    const base = prof ?? { v: 1, genre: "generic", axes: {}, extra: "", status: "draft" };
    const axes = { ...base.axes };
    if (value) axes[key] = value; else delete axes[key];
    const next = { ...base, axes };
    setProf(next);                       // 乐观更新：下拉不该等一趟网络才回弹
    setProfBusy(true);
    try {
      const r = await api.saveAssetProfile(t.assetId, axes, next.extra, next.genre);
      if (r.profile) setProf(r.profile);
      p.onToast("档案已保存（已生成的定妆图不会自动重画）");
    } catch (e) {
      setProf(base);                     // 存失败就回滚，别让界面显示存不下来的值
      p.onToast(`档案保存失败：${String(e)}`);
    } finally { setProfBusy(false); }
  };

  const saveExtra = async (v: string) => {
    if (!t.assetId) return;
    const base = prof ?? { v: 1, genre: "generic", axes: {}, extra: "", status: "draft" };
    if (v === base.extra) return;
    setProfBusy(true);
    try {
      const r = await api.saveAssetProfile(t.assetId, base.axes, v, base.genre);
      if (r.profile) setProf(r.profile);
    } catch (e) {
      p.onToast(`档案保存失败：${String(e)}`);
    } finally { setProfBusy(false); }
  };

  /** 按剧本重新识别。重判几乎必然换一张脸，所以先确认。 */
  const regenProfile = async () => {
    if (!t.assetId) return;
    if (!window.confirm(
      `按剧本重新识别「${t.name}」的形象档案？\n\n` +
      `重新识别出来的五官几乎一定与现在不同（这是审美判断，不是事实提取），` +
      `等于换一张脸。已生成的定妆图不会自动重画，` +
      `要让新档案生效需删掉定妆图再补齐资产。`)) return;
    setProfBusy(true);
    try {
      const r = await api.regenerateAssetProfile(t.assetId);
      setProf(r.profile);
      p.onToast("形象档案已重新识别");
    } catch (e) {
      p.onToast(`重新识别失败：${String(e)}`);
    } finally { setProfBusy(false); }
  };

  // ── 场景多视角参考图（场景专属）：4 方位视角 + 4 景别，共 8 张。
  // 对齐用户 2026-09-09 给的美术设定板参考图。每张都是**独立的干净单幅图**，
  // 因为它们要当参考图注入镜头——拼版图会让模型把格子线和标注抄进画面。
  // 「设定板」是服务端 PIL 拼的派生产物，只给人看（后端 scene_board 模块头有详述）。
  const [svOut, setSvOut] = useState<SceneViewsOut | null>(null);
  const [svOpen, setSvOpen] = useState(true);   // 场景资产的主界面，默认展开
  const [svBusy, setSvBusy] = useState(false);
  const [svJob, setSvJob] = useState<string | null>(null);
  const [svLoaded, setSvLoaded] = useState(false);
  const [qcBusy, setQcBusy] = useState(false);
  const isScene = t.kind === "location" && !!t.assetId;

  const loadViews = async (aid: string) => {
    try {
      const r = await api.sceneViews(aid);
      setSvOut(r);
      setSvLoaded(true);
      // 后端认领了老项目那张图当主视角 → 资产缩略图跟着变，得刷一下外面
      if (r.primary_synced) p.onChanged();
    } catch {
      setSvLoaded(true);   // 旧后端无此接口：面板显示"暂不可用"，不弹错
    }
  };
  useEffect(() => {
    if (!svOpen || svLoaded || !isScene || !t.assetId) return;
    void loadViews(t.assetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svOpen, svLoaded, isScene, t.assetId]);

  // 生图 job 轮询。8 张图串行出基准 + 并发其余，耗时以分钟计，
  // 所以每 3s 拉一次状态，跑完再整体重拉视角列表（拿到新 image_url 与进度）。
  useEffect(() => {
    if (!svJob || !t.assetId) return;
    let alive = true;
    let timer: number | undefined;
    const aid = t.assetId;
    const tick = async () => {
      try {
        const j = await api.jobStatus(svJob);
        if (!alive) return;
        if (j.status === "pending" || j.status === "running") {
          timer = window.setTimeout(tick, 3000);
          return;
        }
        setSvJob(null);
        await loadViews(aid);
        p.onChanged();
        p.onToast(j.status === "done"
          ? "✅ 多视角参考图已生成"
          : `视角生图失败：${String(j.error ?? "").slice(0, 160)}`);
      } catch {
        if (alive) timer = window.setTimeout(tick, 5000);   // 网络抖动不放弃轮询
      }
    };
    void tick();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svJob, t.assetId]);

  /** 生成视角图。`keys` 空 = 只补缺图的；给了 key = 点名重画（不去重）。 */
  const genViews = async (keys?: string[]) => {
    if (!t.assetId) return;
    setSvBusy(true);
    try {
      const j = await api.generateSceneViews(t.assetId, keys, { modelId: model });
      setSvJob(j.id);
      p.onToast(keys?.length
        ? `✨ 正在重画 ${keys.length} 张视角图`
        : "✨ 正在补齐缺失的视角图，可以关掉弹窗");
    } catch (e) {
      // 409 = 项目级批量补资产正在跑，它会一并补齐；把 job 接过来继续轮询，
      // 比让用户看一句报错然后自己猜"到底在不在跑"有用
      const d = (e as { detail?: { reason?: string; job_id?: string; message?: string } }).detail;
      if (d?.reason === "batch_running" && d.job_id) {
        setSvJob(d.job_id);
        p.onToast(d.message ?? "该项目的资产生图任务正在跑，缺失视角会由它一并补齐");
      } else {
        p.onToast(`提交失败：${(d?.message ?? String(e)).slice(0, 160)}`);
      }
    } finally { setSvBusy(false); }
  };

  /** 清掉某张视角图（磁盘文件保留——它可能已注入进已出的片子）。 */
  const clearView = async (key: string, label: string) => {
    if (!t.assetId) return;
    if (!window.confirm(`清掉「${label}」这张参考图？\n\n` +
      `只清引用，图片文件保留（它可能已经用在已生成的镜头里）。` +
      `清掉后点「补齐缺失」会重画这一张。`)) return;
    setSvBusy(true);
    try {
      await api.clearSceneView(t.assetId, key);
      await loadViews(t.assetId);
      p.onChanged();
    } catch (e) { p.onToast(`清除失败：${String(e).slice(0, 160)}`); }
    finally { setSvBusy(false); }
  };

  const makeBoard = async () => {
    if (!t.assetId) return;
    setSvBusy(true);
    try {
      const r = await api.buildSceneBoard(t.assetId);
      setSvOut((o) => (o ? { ...o, board_url: r.board_url } : o));
      p.onToast("✅ 设定板已生成（缺图的格子标「未生成」）");
    } catch (e) { p.onToast(`拼板失败：${String(e).slice(0, 160)}`); }
    finally { setSvBusy(false); }
  };

  /** 视觉体检：核验「场景图里没有人 / 人物图里没有场景」是否真做到了。
   *  判不合格只标记不删图——判定本身会出错，重画哪张由用户决定。 */
  const runQc = async () => {
    if (!t.assetId) return;
    setQcBusy(true);
    try {
      const r = await api.qcAsset(t.assetId, {
        // 2026-09-09 之前的老定妆图是单视图无标注，对它们报这两项是代际差异
        // 而非缺陷；场景图无此问题（8 张全是新口径出的）。
        expectThreeView: t.kind === "character" ? window.confirm(
          "按「三视图 + 左上角姓名标注」的新口径体检？\n\n" +
          "确定 = 新口径（2026-09-09 之后生成的图）\n" +
          "取消 = 老口径（单视图、无标注，不报这两项）") : true,
      });
      if (isScene && t.assetId) await loadViews(t.assetId);
      p.onToast(r.failed === 0
        ? `✅ 体检通过：${r.checked} 张图全部合格`
        : `⚠️ ${r.checked} 张里 ${r.failed} 张有问题：` +
          r.items.filter((i) => i.result && !i.result.ok)
            .map((i) => `${i.label}—${i.summary}`).join("；").slice(0, 300));
    } catch (e) { p.onToast(`体检失败：${String(e).slice(0, 160)}`); }
    finally { setQcBusy(false); }
  };

  // R1 资产改名。后端 rename_asset_everywhere 会在同一事务里把镜头、造型阶段、
  // 别名表里的引用一并改掉，所以改完不会断链（这正是它与只改一行的区别）。
  // 改完把后端报的影响面告诉用户——"动了 208 个镜头"这种信息，用户有权知道。
  const [renaming, setRenaming] = useState(false);
  const doRename = async () => {
    if (!t.assetId) return;
    const next = window.prompt(
      `重命名「${t.name}」\n\n镜头、造型阶段等所有引用会一并更新，不会断链。`,
      t.name);
    if (next == null) return;                 // 用户取消
    const name = next.trim();
    if (!name || name === t.name) return;     // 空名或没改
    setRenaming(true);
    try {
      const r = await api.patchAsset(t.assetId, { name });
      const moved = (r as { renamed?: Record<string, number> }).renamed;
      const total = moved ? Object.values(moved).reduce((a, b) => a + b, 0) : 0;
      p.onChanged();
      p.onToast(total
        ? `✅ 已改名为「${name}」，同步更新 ${total} 处引用`
        : `✅ 已改名为「${name}」`);
    } catch (e) {
      p.onToast(`改名失败：${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    setRenaming(false);
  };

  /** 上传图片 → 直接作为资产图（替换 AI 生成的）。
   *
   *  两处 2026-09-10 的改动，都是用户实测反馈的直接结果：
   *
   *  ① **先压再传**（`compressImage`，超 2MB 或长边超 2048 才压）。定妆图多是
   *     手机/单反原图，5~20MB 走公网就是几十秒，而它在织影里的用途只有"喂给
   *     生图模型当参考"和"卡片缩略图"，都用不到四千像素。
   *  ② **清空旧造型描述**。旧描述是拆剧本阶段（一张图都还没有时）按剧本文字
   *     写的，与用户刚传的这张图毫无关系；但出片时它会作为参考图的文字锚点
   *     注入，且提示词里明写「原稿中与之矛盾的服装描写一律以此为准改写」——
   *     于是**文字压过参考图**，人物外观必然漂移。清空后走 `jobs.py` 的 blind
   *     兜底：不写服装发型配饰，外观完全交给这张图钳制。
   *     ⚠️ 这个清空**只在上传自己的图时做**；`pick()` 采用 AI 候选图不清，
   *     那张图本来就是照着这段描述生出来的。
   *
   *  预览立即更新（不等落库回包）；落库失败会 toast 并还原。 */
  const doUploadImage = async (f: File) => {
    setPicking(false);
    setUploading(true);
    const what = `图片「${f.name}」`;
    setUpStat({ phase: "uploading", what, msg: "处理中…" });
    const prev = curImg;
    try {
      const small = await compressImage(f);
      if (small.compressed) {
        setUpStat({ phase: "uploading", what, msg: `已压缩 ${describeSaving(small)}，上传中…` });
      }
      const r = await api.uploadMedia(small.file, p.projectId);
      setCurImg(r.url);   // 立即出预览
      if (t.stage && !t.stage.virtual) {
        await api.patchStage(t.stage.id, { image_url: r.url, clear_description: true });
      } else if (t.assetId) {
        await api.patchAsset(t.assetId, { imageUrl: r.url, clearPrompt: true });
      } else {
        await api.upsertAssetImage(p.projectId, t.kind, t.name, r.url,
                                   undefined, undefined, { clearPrompt: true });
      }
      // 库里已经清空了，输入框也必须跟着清 —— 否则框里还留着旧文字，
      // 下一次失焦 `savePrompt` 会把它原样写回去，清空等于白做。
      const hadDesc = !!prompt.trim();
      setPrompt("");
      savedRef.current = "";
      setPromptDirty(false);
      setCands([]);
      p.onChanged();
      const cleared = hadDesc ? " · 旧造型描述已清空，出片将完全以这张图为准" : "";
      setUpStat({
        phase: "ok", what,
        msg: `已替换为资产图${small.compressed ? `（压缩 ${describeSaving(small)}）` : ""}${cleared}`,
      });
      p.onToast(hadDesc
        ? "✅ 已用上传图片替换资产图，并清空了与它无关的旧造型描述"
        : "✅ 已用上传图片替换资产图");
    } catch (e) {
      setCurImg(prev);    // 落库失败还原预览
      setUpStat({ phase: "err", what, msg: String(e).slice(0, 200) });
      p.onToast(`上传失败：${String(e).slice(0, 160)}`);
    }
    finally { setUploading(false); }
  };

  /** 上传参考音色（音频/视频）→ Asset.voice_url；真人剧出片时按角色注入 */
  const doUploadVoice = async (f: File) => {
    setPicking(false);
    setUploading(true);
    setUpStat({ phase: "uploading", what: `音色「${f.name}」` });
    try {
      const r = await api.uploadMedia(f, p.projectId);
      if (t.assetId) await api.patchAsset(t.assetId, { voiceUrl: r.url });
      else await api.upsertAssetImage(p.projectId, t.kind, t.name, undefined, r.url);
      setCurVoice(r.url);
      p.onChanged();
      setUpStat({ phase: "ok", what: `音色「${f.name}」`, msg: "已设为该角色音色" });
      p.onToast(`🎙 「${t.name}」参考音色已设置`);
    } catch (e) {
      setUpStat({ phase: "err", what: `音色「${f.name}」`, msg: String(e).slice(0, 200) });
      p.onToast(String(e));
    }
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
        // 场景资产名是**归一名**，所以这里必须拿 location_canonical 去比。
        // 用原名 sh.location 会全部落空（「夜 内 楚家公馆-客厅」≠「楚家公馆-客厅」），
        // 表现就是场景资产的"出场集数"永远显示为空。
        const rm = ov.remove_loc ?? [];
        const l1 = sh.location_canonical ?? sh.location;
        present = [...(l1 ? [l1] : []), ...(ov.add_loc ?? [])]
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

  /** 起止集输入框失焦保存（F18）。
   *  判定逻辑与三种踩坑（空值→0、非数字→静默忽略、无变化也发请求）
   *  见 lib/formState.ts parseEpisodeInput()。 */
  const saveStageEp = (el: HTMLInputElement, key: "ep_from" | "ep_to") => {
    if (!t.stage) return;
    const cur = t.stage[key];
    const r = parseEpisodeInput(el.value, cur);
    if (r.kind === "noop") return;
    if (r.kind === "reject") {
      el.value = String(cur);        // 回填库里的值，不留一个无效的显示
      p.onToast(r.message);
      return;
    }
    void saveStage({ [key]: r.value });
  };

  /** 造型描述落库：真实阶段写 AssetStage.description，其余写 Asset.prompt
   *  （有 id 走 PATCH，没有则按 kind+name upsert 建行）。
   *  这段文字出片时会作为参考图的文字锚点喂给提示词优化器，所以必须持久化——
   *  以前非阶段资产改完提示词只留在组件 state 里，一关弹窗就没了。 */
  const savedRef = useRef(stripAuto(savedDesc));
  const savePrompt = async (override?: string) => {
    // 无 override = 失焦触发：用户没动过就别发请求（轨道侧打开时框里可能
    // 根本没拿到库里的真值，照常保存会把真描述冲掉）。
    // 有 override = 「AI 看图补写」按钮塞进来的文字：它是程序填的，用户不会
    // 去点一下再移开，**没有失焦事件可等**，所以必须显式存。
    if (override === undefined && !promptDirty) return;
    const v = (override ?? prompt).trim();
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

  /**
   * 「🔍 AI 看图补写」：看当前这张图，写一段造型/场景描述填进输入框并存下。
   *
   * 这是视觉反推**唯一**的入口。它以前是挂在换图/上传链路上自动跑的：一次
   * 多模态调用 ~8s（还要把图整份 base64 上行），期间弹窗不许关闭 = 整页锁死，
   * 用户看到的就是"上传非常非常慢而且什么都点不了"。改成手动按钮后，
   * 不想要文字描述的人一秒都不用等；想要的人点一下、结果可当场改。
   *
   * 只转这个按钮自己，不进 `uploading` —— 它不该锁住弹窗的任何其它部分。
   */
  const doDescribe = async () => {
    if (!curImg) { p.onToast("先上传或生成一张图，才有东西可看"); return; }
    setDescBusy(true);
    try {
      // 后端只有"造型记录员"（写人物服装）与"置景记录员"（写空间陈设）两套题面。
      // custom 多是道具/物件，用置景那套（材质配色）远比让它写"人物造型"合适。
      const r = await api.describeImage(curImg, t.kind === "character" ? "character" : "location");
      setPrompt(r.description);
      setPromptDirty(false);
      await savePrompt(r.description);
      p.onToast("✅ 已按图写好描述并保存，可直接在框里修改");
    } catch (e) {
      p.onToast(`看图失败：${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
    finally { setDescBusy(false); }
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
    // 描述为空也让生：套一次模板**只用于这一次提交**，不写回输入框、不落库
    // （见 genTemplate 注释——它以前是输入框初值，被顺手存成了造型描述）。
    const imagePrompt = prompt.trim() || genTemplate(t.kind, t.name);
    if (!imagePrompt) { p.onToast("先填写生图提示词"); return; }
    setGenBusy(true);
    try {
      const useRef = !!p.baseRef && keepFace;
      await api.submitAssetCandidates({
        projectId: p.projectId, kind: t.kind, name: t.name,
        stageId: t.stage?.id ?? null,
        prompt: imagePrompt, modelId: model, size: sizeFor(aspect, hd), n: genN,
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
    <div className="drawer-mask" onClick={guardedClose}>
      <div className="wizard wizard-lg" onClick={(e) => e.stopPropagation()}>
        <h2>{t.kind === "location" ? "🏞" : t.kind === "custom" ? "✨" : "👤"} {t.name}
          {t.stage && <span className="muted" style={{ fontWeight: 400 }}> · {t.stage.stage_name}</span>}
        </h2>

        {/* 当前图 + 用途 */}
        <div className="adlg-top">
          {curImg
            ? <img className="adlg-img zoomable" src={api.mediaUrl(curImg)} alt={t.name}
                title="点击看大图"
                onClick={() => setZoom(curImg)} />
            : <div className="adlg-img ph">尚无图</div>}
          <div className="adlg-meta">
            <div><b>类型</b>{kindLabel}{t.stage ? (curImg ? " · ✅当前使用中" : " · 待生成") : ""}</div>
            {/* R1 资产改名：后端会连带迁移所有引用（镜头/造型阶段/别名表），
                所以这里不需要额外提醒用户"改名会断链"——它不会断。
                custom 类型没有镜头引用，也一并支持改名。 */}
            {t.assetId && (
              <div><b>名称</b>
                <span>{t.name} </span>
                <button className="btn ghost adlg-mini" disabled={renaming}
                  title="重命名该资产（镜头、造型阶段等所有引用会一并更新）"
                  onClick={() => { void doRename(); }}>
                  {renaming ? "⏳" : "✏️ 改名"}
                </button>
              </div>
            )}
            {t.stage && <div><b>阶段区间</b>第{t.stage.ep_from}-{t.stage.ep_to}集</div>}
            <div><b>实际用在</b>{t.kind === "custom" ? "拖到轨道/镜头槽后生效" : usage}</div>
            {t.kind === "character" && (
              <div><b>参考音色</b>
                {curVoice
                  ? <span>已设置 🎙 <button className="btn ghost adlg-mini"
                      onClick={() => { const a = new Audio(api.mediaUrl(curVoice)); void a.play(); }}>▶试听</button></span>
                  : <span className="muted">未设置（出片时该角色的说话声由模型自由发挥）</span>}
              </div>
            )}
            {/* 上传替换：图片直接替换 AI 资产图；角色可传参考音色 */}
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button className="btn adlg-mini" disabled={busyUpload}
                title="上传本地图片作为此资产图（替换 AI 生成）"
                onClick={() => openPicker(imgFileRef, "图片")}>
                {uploading ? "⏳" : "📤 上传图片"}
              </button>
              {t.kind === "character" && (
                <>
                  <button className="btn adlg-mini" disabled={busyUpload}
                    title="上传音频/视频作为此角色参考音色（出片时该角色按此音色说话，取前 15s）"
                    onClick={() => openPicker(voiceFileRef, "音色")}>
                    {uploading ? "⏳" : "🎙 上传音色"}
                  </button>
                  <button className="btn adlg-mini" disabled={busyUpload}
                    title="从音色库挑一个音色（库还在建设中）"
                    onClick={() => setVoicePicking(true)}>
                    ♪ 从音色库选
                  </button>
                </>
              )}
            </div>
            {/* 上传结果常驻一行：成功/失败都写清楚，不靠一闪而过的 toast。
                ⚠️ 文案里**不再**写「请勿关闭窗口」——上传中现在是可以关窗的
                （文件已交给 fetch，关窗不影响它跑完，见 guardedClose）。
                选文件那一步才真的不能关。 */}
            {upStat && (
              <div className={`adlg-upstat adlg-upstat-${upStat.phase}`}>
                {upStat.phase === "picking" && `⏳ 正在选择${upStat.what}…（选完或取消前请勿关闭窗口）`}
                {upStat.phase === "uploading"
                  && `⏳ 正在上传 ${upStat.what}…${upStat.msg ? ` ${upStat.msg}` : ""}（可以关掉窗口，传完会通知你）`}
                {upStat.phase === "ok" && `✅ ${upStat.what} 上传成功 · ${upStat.msg}`}
                {upStat.phase === "err" && `❌ ${upStat.what} 上传失败：${upStat.msg}`}
              </div>
            )}
            <input ref={imgFileRef} type="file" accept=".png,.jpg,.jpeg,.webp" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUploadImage(f); else setPicking(false); e.target.value = ""; }} />
            <input ref={voiceFileRef} type="file" accept=".mp3,.wav,.aac,.m4a,.mp4,.mov" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUploadVoice(f); else setPicking(false); e.target.value = ""; }} />
            {voicePicking && (
              <VoicePicker
                charName={t.name}
                currentUrl={curVoice}
                onClose={() => setVoicePicking(false)}
                onUploadInstead={() => setTimeout(() => openPicker(voiceFileRef, "音色"), 0)}
                onPick={async (v) => {
                  setUpStat({ phase: "uploading", what: `音色「${v.name}」` });
                  try {
                    if (t.assetId) await api.patchAsset(t.assetId, { voiceUrl: v.url });
                    else await api.upsertAssetImage(p.projectId, t.kind, t.name, undefined, v.url);
                    setCurVoice(v.url);
                    p.onChanged();
                    setUpStat({ phase: "ok", what: `音色「${v.name}」`, msg: "已设为该角色音色" });
                    p.onToast(`🎙 「${t.name}」音色设为「${v.name}」`);
                  } catch (e) {
                    setUpStat({ phase: "err", what: `音色「${v.name}」`, msg: String(e).slice(0, 200) });
                    p.onToast(String(e));
                  }
                }} />
            )}
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
              <input type="number" min={1} step={1} defaultValue={t.stage.ep_from}
                onBlur={(e) => saveStageEp(e.target, "ep_from")} />
            </label>
            <label style={{ flex: 1 }}>结束集
              <input type="number" min={1} step={1} defaultValue={t.stage.ep_to}
                onBlur={(e) => saveStageEp(e.target, "ep_to")} />
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
              <span style={{ fontSize: "calc(12px * var(--fs-scale, 1))" }}>
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
          <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))", marginTop: -4 }}>
            ↩ 本段与同角色另一造型是<b>同一件衣服</b>，共用那张图（自己不出图、不花钱）。
            如需让它单独出一张，上传图片或生成一张即可自动解除共用
          </div>
        )}

        {/* 形象档案（仅角色）：这个角色全剧统一的长相。
            折叠默认收起——它有 15 个字段，铺开会把"看图 / 改造型 / 生成"这三个
            高频动作挤出视野。 */}
        {t.kind === "character" && t.assetId && (
          <div className="adlg-prof">
            <button className="btn ghost adlg-mini" onClick={() => setProfOpen((v) => !v)}
              title="该角色全剧统一的五官/骨相/气质，定妆图按它生成">
              {profOpen ? "▾" : "▸"} 🧬 形象档案
              {prof && <span className="muted">
                {" "}· {prof.status === "confirmed" ? "已手动确认" : "AI 判定"}
              </span>}
              {!prof && profLoaded && <span className="muted"> · 尚未生成</span>}
            </button>
            {profOpen && (
              <div style={{ marginTop: 6 }}>
                <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))", marginBottom: 6 }}>
                  这是<b>脸</b>，上面的造型描述是<b>衣服</b>：衣服每套一份，脸全剧只有一份。
                  定妆图生成时会把这里的每一项写进提示词。
                  ⚠️ 改档案 = 换脸，但<b>已生成的定妆图不会自动重画</b>——
                  要让新档案生效，删掉该角色的定妆图再点「补齐缺失资产」。
                </div>
                {!profLoaded ? <div className="muted">加载中…</div>
                  : profAxes.length === 0 ? <div className="muted">后端暂不支持形象档案</div>
                    : (
                      <>
                        <div className="adlg-prof-grid">
                          {profAxes.map((ax) => {
                            const v = prof?.axes[ax.key] ?? "";
                            // 词表外的值（AI 自己写的特征，或用户填的）也要能显示、
                            // 不能被下拉悄悄吞掉——所以并进候选列表
                            const opts = ax.values.includes(v) || !v
                              ? ax.values : [v, ...ax.values];
                            return (
                              <label key={ax.key}>{ax.label}
                                <select value={v} disabled={profBusy}
                                  onChange={(e) => { void setAxis(ax.key, e.target.value); }}>
                                  <option value="">
                                    {ax.optional ? "（不设置）" : "（未判定）"}
                                  </option>
                                  {opts.map((o) => (
                                    <option key={o} value={o}>
                                      {ax.values.includes(o) ? o : `${o}（自定义）`}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            );
                          })}
                        </div>
                        <label style={{ marginTop: 6 }}>自由补充
                          <span className="muted" style={{ fontWeight: 400 }}>
                            {" "}· 上面的下拉放不下的独有特征（疤痕/义眼/胎记/标志性配饰）
                          </span>
                          {/* key 绑定值：「重新识别」换掉 extra 后，
                              非受控 textarea 必须重挂载才显示新内容 */}
                          <AutoTextarea key={prof?.extra ?? ""}
                            className="drawer-ta" minHeight={40}
                            defaultValue={prof?.extra ?? ""}
                            onBlur={(e) => { void saveExtra(e.target.value.trim()); }} />
                        </label>
                        <div className="row" style={{ gap: 6, marginTop: 4 }}>
                          <button className="btn ghost adlg-mini" disabled={profBusy}
                            onClick={() => { void regenProfile(); }}>
                            {profBusy ? "⏳" : "🔄 按剧本重新识别"}
                          </button>
                          {/* 体检：核验"人物图里没有场景"这条要求真的做到了没有。
                              角色图的结论不落库（assets 上没有承载它的列），
                              所以只在这里以 toast 报一次。 */}
                          <button className="btn ghost adlg-mini" disabled={qcBusy}
                            title="核验定妆图：是不是三视图、背景是否纯白、有没有混进场景元素"
                            onClick={() => { void runQc(); }}>
                            {qcBusy ? "⏳ 体检中…" : "🔍 视觉体检"}
                          </button>
                        </div>
                      </>
                    )}
              </div>
            )}
          </div>
        )}

        {/* 场景多视角参考图（仅场景）：4 方位 + 4 景别，共 8 张。
            这 8 张是**分别独立的干净单幅图**，因为它们要当参考图注入镜头；
            「设定板」才是拼版的那张，只给人看、从不进模型（见 api.buildSceneBoard）。 */}
        {isScene && (
          <div className="adlg-prof">
            <button className="btn ghost adlg-mini" onClick={() => setSvOpen((v) => !v)}
              title="该场景的多视角/多景别参考图，镜头按景别自动挑用哪一张">
              {svOpen ? "▾" : "▸"} 🏞 多视角参考图
              {svOut && <span className="muted">
                {" "}· {svOut.progress.done}/{svOut.progress.total} 张
              </span>}
            </button>
            {svOpen && (
              <div style={{ marginTop: 6 }}>
                <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))", marginBottom: 6 }}>
                  4 个方位视角 + 4 档景别。出片时按镜头的景别关键词自动挑用哪一张
                  （认不出景别就用<b>主视角</b>）。每张图左上角带场景名标注，
                  这行字<b>不会</b>被抄进镜头画面（已实测）。
                </div>
                {!svLoaded ? <div className="muted">加载中…</div>
                  : !svOut ? <div className="muted">后端暂不支持多视角参考图</div>
                    : (
                      <>
                        {["angle", "framing"].map((kind) => {
                          const rows = svOut.views.filter((v) => v.kind === kind)
                            .sort((a, b) => a.sort - b.sort);
                          if (!rows.length) return null;
                          return (
                            <div key={kind}>
                              <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))", margin: "4px 0" }}>
                                {kind === "angle" ? "多视角参考" : "景别参考 / 材质参考"}
                              </div>
                              <div className="adlg-sv-grid">
                                {rows.map((v) => {
                                  const bad = v.qc && !v.qc.ok;
                                  return (
                                    <div key={v.key} className="adlg-sv-cell">
                                      {v.image_url
                                        ? <img className="adlg-sv-img zoomable"
                                            src={api.mediaUrl(v.image_url)} alt={v.label}
                                            title="点击看大图"
                                            onClick={() => setZoom(v.image_url)} />
                                        : <div className="adlg-sv-img ph">未生成</div>}
                                      <div className="adlg-sv-label">
                                        {v.primary && <span title="主视角：也是这个场景的资产图，注入镜头的兜底图就是它">⭐ </span>}
                                        {v.label}
                                      </div>
                                      {v.qc && (
                                        <div className={bad ? "adlg-sv-qc bad" : "adlg-sv-qc ok"}
                                          title={v.qc.note}>
                                          {bad ? "⚠️ 不合格" : "✅ 已体检"}
                                        </div>
                                      )}
                                      <div className="row" style={{ gap: 4 }}>
                                        <button className="btn ghost adlg-mini" disabled={svBusy || !!svJob}
                                          title="无论有没有图都重画这一张"
                                          onClick={() => { void genViews([v.key]); }}>
                                          {v.image_url ? "🔄" : "✨"}
                                        </button>
                                        {v.image_url && (
                                          <button className="btn ghost adlg-mini" disabled={svBusy || !!svJob}
                                            title="清掉这张图的引用（磁盘文件保留）"
                                            onClick={() => { void clearView(v.key, v.label); }}>
                                            🗑
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}

                        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                          <button className="btn adlg-mini" disabled={svBusy || !!svJob}
                            title="只画还没有图的视角（已有的不动，不重复花钱）"
                            onClick={() => { void genViews(); }}>
                            {svJob ? "⏳ 生成中…" : "✨ 补齐缺失"}
                          </button>
                          <button className="btn ghost adlg-mini" disabled={svBusy || !!svJob}
                            title="8 张全部重画（会花 8 张图的钱）"
                            onClick={() => {
                              if (!window.confirm(
                                `重画「${t.name}」全部 ${svOut.progress.total} 张视角图？\n\n` +
                                `这会花 ${svOut.progress.total} 张图的生成费用。` +
                                `已有的图会被覆盖，已经用在镜头里的旧图不受影响。`)) return;
                              void genViews(svOut.defs.map((d) => d.key));
                            }}>
                            🔄 全部重画
                          </button>
                          <button className="btn ghost adlg-mini" disabled={svBusy || !!svJob}
                            title="把已有视角图拼成美术设定板（服务端拼图，不花生图钱）"
                            onClick={() => { void makeBoard(); }}>
                            🎨 生成设定板
                          </button>
                          <button className="btn ghost adlg-mini" disabled={qcBusy || !!svJob}
                            title="核验这些图里有没有出现人物、左上角标注是否到位"
                            onClick={() => { void runQc(); }}>
                            {qcBusy ? "⏳ 体检中…" : "🔍 视觉体检"}
                          </button>
                          {svOut.board_url && (
                            <button className="btn ghost adlg-mini"
                              title="看设定板大图"
                              onClick={() => setZoom(svOut.board_url)}>
                              📋 看设定板
                            </button>
                          )}
                        </div>
                      </>
                    )}
              </div>
            )}
          </div>
        )}

        {/* 生成参数：造型描述 + 比例/分辨率/模型/张数 */}
        <label>
          <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
            <span style={{ flex: 1 }}>
              {t.kind === "location" ? "场景描述" : "造型描述"}
              {/* 名字要说实话：它**不是**"生图提示词"。原来的括注直接这么写着，
                  但它真正的主业是出片时给这张参考图当**文字锚点**（拼进视频
                  提示词）；只有本弹窗的「✨生成」在描述非空时会顺带拿它当图的
                  提示词。用户按"提示词"的写法去填（"高质量, 短剧风格"这类），
                  那些词就会跟着进视频提示词。 */}
              <span className="muted" style={{ fontWeight: 400 }}>
                {t.kind === "location"
                  ? " · 这个场景有什么陈设、什么材质配色"
                  : " · 这套造型的服装 / 发型 / 配饰"}
              </span>
            </span>
            <button type="button" className="btn ghost adlg-mini"
              disabled={descBusy || !curImg}
              title={curImg
                ? "让 AI 看当前这张图写一段描述（约 8 秒），写完可以直接改"
                : "还没有图可看"}
              onClick={() => { void doDescribe(); }}>
              {descBusy ? "⏳ 看图中…" : "🔍 AI 看图补写"}
            </button>
          </div>
          {descIsAuto && <div className="muted" style={{ fontWeight: 400 }}>
            这段是早年 AI 看图自动写的，可直接修改</div>}
          <AutoTextarea className="drawer-ta" minHeight={64} value={prompt}
            placeholder={t.kind === "location"
              ? "例：老式客厅，胡桃木圆桌与藤编靠椅，米黄墙面，午后斜光"
              : "例：米色双排扣风衣，内搭黑色高领，低马尾，银色细框眼镜"}
            onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
            onBlur={() => void savePrompt()} />
          {/* 留空是**正当选择**，不是没填完。用户上传自己的图时我们就是主动清空的：
              没有文字，出片提示词便禁止书写服装发型（jobs.py 的 blind 兜底），
              外观完全由参考图钳制——这比一段与图不符的旧文字可靠得多。 */}
          <div className="muted" style={{ fontWeight: 400, fontSize: "calc(11px * var(--fs-scale, 1))" }}>
            留空也可以：那样出片时会完全以上面这张图为准，不写任何服装文字。
            填了就要与图一致，不一致会导致人物外观漂移。
          </div>
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
              {CANDIDATE_COUNTS.map((n2) => <option key={n2} value={n2}>{n2} 张</option>)}
            </select>
          </label>
        </div>

        {p.baseRef && (
          <label className="genpick-row" style={{ marginTop: -4 }}>
            <input type="checkbox" checked={keepFace}
              onChange={(e) => setKeepFace(e.target.checked)} />
            <img src={api.mediaUrl(p.baseRef)} alt="参考"
              style={{ width: 26, height: 34, objectFit: "cover", borderRadius: 3 }} />
            <span style={{ fontSize: "calc(12px * var(--fs-scale, 1))" }}>参考这张已有定妆图（换造型不换脸）</span>
          </label>
        )}

        <button className="btn primary" disabled={genBusy || candBusy} onClick={doGen}>
          {candidateButtonLabel({
            hasImage: !!curImg, n: genN, submitting: genBusy, running: candBusy,
          })}
        </button>
        {/* 花费口径摆在按钮正下方：候选是**按张计费**的，而"点选哪张才落库"这件事
            不说清的话，用户会以为一点生成当前定妆图就被顶掉了（job 化之前确实如此）。 */}
        {!candBusy && (
          <div className="muted" style={{ fontSize: "calc(11px * var(--fs-scale, 1))", marginTop: -4 }}>
            {candidateCostHint(genN, !!curImg)}
          </div>
        )}
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
              // 2026-09-09 起是软删（后端打墓碑），所以文案要说清"能撤销"以及
              // 去哪儿撤销 —— 此前只有一句"删除…阶段？"，用户会以为定妆图没了。
              if (!window.confirm(
                `删除「${t.name}·${t.stage!.stage_name}」这一套造型？\n\n`
                + `· 剧本与镜头不变，只是不再按这套造型出图\n`
                + `· 可恢复：定妆图保留，在资产页「🗑 已删除的造型」里点 ↩ 撤销`)) return;
              await api.deleteStage(t.stage!.id);
              p.onChanged(); p.onClose();
            }}>🗑 删除阶段</button>
          ) : <span />}
          <span>
            <button className="btn ghost" onClick={guardedClose}>关闭</button>
          </span>
        </div>
      </div>

      {/* 大图：缩略图只有 108px 且是 cover 裁切，全身像基本只看得见躯干 ——
          脸、发型、鞋这些**正是要确认的东西**全被裁掉了。
          两个入口共用这一个浮层：
            · 点候选图 → 放大确认再采用（点错就得重生成，花钱）
            · 点当前图 → 单纯看清楚，此时没有"采用"这回事（它已经是当前图） */}
      {zoom && (
        <div className="drawer-mask" style={{ zIndex: 60 }}
          onClick={(e) => { e.stopPropagation(); setZoom(null); }}>
          <div className="wizard" onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 560 }}>
            <img src={api.mediaUrl(zoom)} alt="大图"
              style={{ width: "100%", maxHeight: "68vh", objectFit: "contain",
                background: "#000", borderRadius: 8 }} />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setZoom(null)}>
                {zoom === curImg ? "关闭" : "返回挑选"}
              </button>
              {zoom !== curImg && (
                <button className="btn primary" onClick={() => void pick(zoom)}>
                  ✅ 采用这张
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
