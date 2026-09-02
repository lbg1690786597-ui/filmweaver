import { useEffect, useState } from "react";
import { api, ProjectInfo } from "../api";
import ProjectCards from "../features/projects/ProjectCards";
import WindowControls from "../features/editor/WindowControls";

interface Props {
  onOpen: (id: string) => void;
}

/** 画幅可选项（与后端 BASE_ASPECTS 一致）；ratio 用于渲染比例小矩形图标 */
const ASPECTS: { key: string; w: number; h: number; hint: string }[] = [
  { key: "9:16", w: 18, h: 32, hint: "竖屏短剧" },
  { key: "16:9", w: 32, h: 18, hint: "横屏影视" },
  { key: "3:4", w: 24, h: 32, hint: "竖幅" },
  { key: "4:3", w: 32, h: 24, hint: "传统电视" },
  { key: "1:1", w: 26, h: 26, hint: "方形" },
  { key: "21:9", w: 36, h: 15, hint: "超宽银幕" },
];

/** 视频模型（按钮化展示；与后端 providers 对应） */
/** 视频模型兜底清单（后端 /v2/providers/video 不可达时用）。
 *  正常路径走后端注册表——它才知道哪些 endpoint 真的配好了。 */
const VIDEO_MODELS_FALLBACK = [
  { key: "veo-3-1-fast", label: "Veo 快速", icon: "⚡", hint: "1-3分钟出片 · 8s固定" },
  { key: "veo-3-1", label: "Veo 质量", icon: "🎥", hint: "质量档 · 8s固定" },
  { key: "minimax-h3-ref2v", label: "海螺 H3", icon: "🎭", hint: "9图参考/首帧/首尾帧 · 音色参考 · 约10分钟" },
  { key: "seedance-2.5", label: "Seedance 2.5", icon: "🏆", hint: "单镜可出 30s 长镜 · 同场戏少切几刀 · 音画一体" },
  { key: "seedance-2.0", label: "Seedance 2.0", icon: "💎", hint: "音画一体 · 首尾帧/参考图全能" },
  { key: "seedance-2.0-mini", label: "Seedance mini", icon: "🔹", hint: "轻量快出 · 成本更低" },
];

/** 生图模型的展示补充（图标/一句话用途）。
 *  **模型清单本身以后端 /v2/providers/image 为准**——两边各维护一份
 *  必然漂移（后端加了模型前端看不到，或前端列了后端不认的 id）。
 *  这里只提供人读的修饰，后端没回的 id 用兜底样式照常显示。 */
const IMAGE_MODEL_META: Record<string, { icon: string; hint: string }> = {
  "gpt-image-2": { icon: "🖼", hint: "资产定妆图 · 通用稳" },
  "nano-banana-pro": { icon: "🍌", hint: "Gemini 3 · 首帧优选" },
  "nano-banana-2": { icon: "🍌", hint: "Gemini 3.1 · 快" },
  "z-image": { icon: "👤", hint: "人像专用" },
};

/** 后端不可达时的兜底清单（离线/后端未起也能建项目） */
const IMAGE_MODELS_FALLBACK = [
  { key: "gpt-image-2", label: "GPT Image", icon: "🖼", hint: "资产定妆图 · 通用稳" },
  { key: "nano-banana-pro", label: "Nano Banana Pro", icon: "🍌", hint: "Gemini 3 · 首帧优选" },
  { key: "nano-banana-2", label: "Nano Banana 2", icon: "🍌", hint: "Gemini 3.1 · 快" },
  { key: "z-image", label: "Z-Image", icon: "👤", hint: "人像专用" },
];

/** 生成模式的展示补充；可用性由所选模型的 modes 决定（后端回）。 */
const GEN_MODES = [
  { key: "t2va", label: "纯文本", icon: "📝", hint: "无参考素材直出" },
  { key: "full_reference", label: "全能参考", icon: "🎭", hint: "参考图/音频保持一致性" },
  { key: "i2va", label: "首帧", icon: "🎬", hint: "参考图=第一帧" },
  { key: "fl2va", label: "首尾帧", icon: "🎞", hint: "两图锚定首尾" },
  { key: "l2va", label: "尾帧", icon: "🏁", hint: "参考图=最后一帧" },
];

/** 分辨率档位（映射到 H3 工作流 megapixels；veo 通道固定输出忽略） */
const RESOLUTIONS = [
  { key: "480p", label: "480p", icon: "▫", hint: "快速草稿 · 省显存" },
  { key: "720p", label: "720p", icon: "◽", hint: "均衡（默认）" },
  { key: "1080p", label: "1080p", icon: "◻", hint: "高清 · H3 仅≤3s安全" },
  { key: "2k", label: "2K", icon: "⬜", hint: "超清 · 显存要求最高" },
];

/** 生产模式 = **配音策略**（2026-08 改版）。
 *
 *  改版前这里是 5 个技术参数预设（快速验证/角色一致/精品制作/首帧精控/自定义），
 *  但随着视频模型能力拉齐，"用哪个模型/什么分辨率"已经不再构成生产模式的区别 ——
 *  两种剧型都会按需混用各种模型。真正的分野只有一个：**台词怎么配音**。
 *
 *  所以模型/分辨率/生成方式降级为并列的独立选项（不再有预设联动），
 *  生产模式只保留下面两种。 */
const PRODUCTION_MODES = [
  {
    key: "drama", icon: "🎭", label: "真人剧",
    hint: "剧本里人物说什么，人物就配什么台词",
  },
  {
    key: "narration", icon: "📖", label: "解说剧",
    hint: "整段剧本作为旁白解说，画面原声不出声",
  },
];

/** 各选项的默认值（新建项目时的起手式，不是"预设"——用户可自由改任意一项）。 */
const DEFAULTS = {
  video: "minimax-h3-ref2v",
  image: "gpt-image-2",
  gen: "full_reference",
  res: "720p",
};

/** 项目列表 + 新建向导（画幅图标化 / 生产模式 / 技术参数独立可选）。 */
export default function ProjectList(p: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  // 向导表单
  const [title, setTitle] = useState("");
  const [aspect, setAspect] = useState("9:16");        // 默认 9:16
  const [mode, setMode] = useState("drama");           // 配音策略，默认真人剧
  const [videoModel, setVideoModel] = useState(DEFAULTS.video);
  const [imageModel, setImageModel] = useState(DEFAULTS.image);
  const [genMode, setGenMode] = useState(DEFAULTS.gen);
  const [resolution, setResolution] = useState(DEFAULTS.res);
  /** 生图模型清单以后端为准，取不到时用兜底（离线也能建项目） */
  const [imageModels, setImageModels] = useState(IMAGE_MODELS_FALLBACK);
  const [videoModels, setVideoModels] = useState(VIDEO_MODELS_FALLBACK);
  /** model_id → 各生成模式的可用性与不可用原因。
   *  ⚠️ modes 的值是 {available, reason} 对象而非布尔——按真值过滤会把
   *  不可用的模式也当成可用（对象恒为真），实测 H3 的 l2va 就是这种情况。 */
  const [modelModes, setModelModes] =
    useState<Record<string, Record<string, { available: boolean; reason?: string | null }>>>({});

  useEffect(() => {
    api.videoProviders()
      .then((r) => {
        if (!r.providers?.length) return;
        const meta = Object.fromEntries(
          VIDEO_MODELS_FALLBACK.map((m) => [m.key, m]));
        setVideoModels(r.providers.map((pv) => ({
          key: pv.model_id,
          label: meta[pv.model_id]?.label ?? pv.model_id,
          icon: meta[pv.model_id]?.icon ?? "🎬",
          hint: meta[pv.model_id]?.hint ?? "",
        })));
        setModelModes(Object.fromEntries(
          r.providers.map((pv) => [pv.model_id, pv.modes ?? {}])));
      })
      .catch(() => { /* 后端不可达：保留兜底清单 */ });

    api.imageProviders()
      .then((r) => {
        if (!r.models?.length) return;
        setImageModels(r.models.map((m) => ({
          key: m.id,
          label: m.label,
          icon: IMAGE_MODEL_META[m.id]?.icon ?? "🖼",
          hint: IMAGE_MODEL_META[m.id]?.hint ?? "",
        })));
      })
      .catch(() => { /* 后端不可达：保留兜底清单 */ });
  }, []);

  // 换模型后若当前模式在新模型上不可用，自动落到第一个可用模式。
  // 不做这一步，用户带着无效模式建项目，直到第一次生成才报错。
  useEffect(() => {
    const modes = modelModes[videoModel];
    if (!modes || modes[genMode]?.available !== false) return;
    const fallback = GEN_MODES.find((m) => modes[m.key]?.available !== false);
    if (fallback) setGenMode(fallback.key);
  }, [videoModel, modelModes, genMode]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listProjects().then((r) => setProjects(r.projects)).catch((e) => setErr(String(e)));
  }, []);

  const doCreate = async () => {
    if (!title.trim()) return;
    setBusy(true); setErr("");
    try {
      // 技术参数**始终**随创建请求发送。
      // 改版前只有 custom 模式才发，其余靠后端预设推导；现在预设没了，
      // 不发的话后端拿不到用户的选择，会静默退回全局默认。
      const proj = await api.createProject(title.trim(), aspect, mode, {
        video_model: videoModel, image_model: imageModel,
        generation_mode: genMode, resolution,
      });
      p.onOpen(proj.id);
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  return (
    <div className="plist">
      {/* 标题栏：decorations:false 关掉了系统标题栏，这一层要自己补。
          之前只有编辑器页有（EditorLayout → TopBar），项目列表页漏了 ——
          进入软件的第一个页面反而没法最小化/关闭/拖动窗口。

          drag region 加在 header 上，内部按钮逐个 data-tauri-drag-region="false"
          排除，否则点按钮会被当成拖窗口。 */}
      <header className="plist-head" data-tauri-drag-region>
        <h1 data-tauri-drag-region>🎬 FilmWeaver 织影</h1>
        <button className="btn primary" data-tauri-drag-region="false"
          onClick={() => setCreating(true)}>＋ 新建项目</button>
        <WindowControls />
      </header>
      {err && <div className="err">{err}</div>}

      {creating && (
        <div className="drawer-mask" onClick={() => setCreating(false)}>
          <div className="wizard wizard-lg" onClick={(e) => e.stopPropagation()}>
            <h2>新建项目</h2>
            <label>项目名
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="如：都市短剧《重逢》" autoFocus />
            </label>

            <label>画幅基准（生成与导出默认继承）
              <div className="aspect-grid">
                {ASPECTS.map((a) => (
                  <button key={a.key} className={`aspect-btn ${aspect === a.key ? "on" : ""}`}
                    title={a.hint} onClick={() => setAspect(a.key)}>
                    <span className="aspect-rect" style={{ width: a.w, height: a.h }} />
                    <span>{a.key}</span>
                    <span className="muted" style={{ fontSize: 10 }}>{a.hint}</span>
                  </button>
                ))}
              </div>
            </label>

            <label>生产模式（决定台词怎么配音；模型与画质在下方独立选择）
              <div className="mode-cards">
                {PRODUCTION_MODES.map((m) => (
                  <button key={m.key} title={m.hint}
                    className={`mode-card ${mode === m.key ? "on" : ""}`}
                    onClick={() => setMode(m.key)}>
                    {m.icon} {m.label}
                  </button>
                ))}
              </div>
              <span className="muted" style={{ fontSize: 11, display: "block", marginTop: 4 }}>
                {PRODUCTION_MODES.find((m) => m.key === mode)?.hint}
              </span>
            </label>

            <label>视频模型
              <div className="opt-grid">
                {videoModels.map((m) => (
                  <button key={m.key} className={`opt-btn ${videoModel === m.key ? "on" : ""}`}
                    title={m.hint} onClick={() => setVideoModel(m.key)}>
                    <span className="opt-icon">{m.icon}</span>
                    <span>{m.label}</span>
                    <span className="muted" style={{ fontSize: 10 }}>{m.hint}</span>
                  </button>
                ))}
              </div>
            </label>

            <label>生图模型（资产定妆图）
              <div className="opt-grid">
                {imageModels.map((m) => (
                  <button key={m.key} className={`opt-btn ${imageModel === m.key ? "on" : ""}`}
                    title={m.hint} onClick={() => setImageModel(m.key)}>
                    <span className="opt-icon">{m.icon}</span>
                    <span>{m.label}</span>
                    <span className="muted" style={{ fontSize: 10 }}>{m.hint}</span>
                  </button>
                ))}
              </div>
            </label>

            <label>分辨率（H3 通道生效；Veo 固定输出。高档位+长时长有显存风险，超限会失败可降档重试）
              <div className="opt-grid">
                {RESOLUTIONS.map((m) => (
                  <button key={m.key} className={`opt-btn ${resolution === m.key ? "on" : ""}`}
                    title={m.hint} onClick={() => setResolution(m.key)}>
                    <span className="opt-icon">{m.icon}</span>
                    <span>{m.label}</span>
                    <span className="muted" style={{ fontSize: 10 }}>{m.hint}</span>
                  </button>
                ))}
              </div>
            </label>

            <label>生成模式（全能参考 / 首尾帧等；镜头级可单独覆盖）
              <div className="opt-grid">
                {GEN_MODES.map((m) => {
                  // 后端没回该模型的 modes 时按全支持处理——宁可让用户试一次，
                  // 也不要因为探测失败把功能全灰掉
                  const modes = modelModes[videoModel];
                  const info = modes?.[m.key];
                  const ok = !modes || info?.available !== false;
                  const why = info?.reason ?? "当前模型不支持";
                  return (
                  <button key={m.key} disabled={!ok}
                    className={`opt-btn ${genMode === m.key ? "on" : ""}`}
                    title={ok ? m.hint : why}
                    onClick={() => setGenMode(m.key)}>
                    <span className="opt-icon">{m.icon}</span>
                    <span>{m.label}</span>
                    <span className="muted" style={{ fontSize: 10 }}>
                      {ok ? m.hint : "该模型不支持"}
                    </span>
                  </button>);
                })}
              </div>
            </label>

            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setCreating(false)}>取消</button>
              <button className="btn primary" disabled={!title.trim() || busy} onClick={doCreate}>
                {busy ? "创建中…" : "创建并进入"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 6：卡片网格（缩略图 / 进度 / 时长 / 搜索）替换原纯文字列表 */}
      <ProjectCards projects={projects} onOpen={p.onOpen} />
    </div>
  );
}
