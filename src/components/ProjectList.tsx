import { useEffect, useState } from "react";
import { api, ProjectInfo } from "../api";
import ProjectCards from "../features/projects/ProjectCards";

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

/** 预设 → 各选项定位（点预设联动；用户再改任一项 → 归入 custom） */
const PRESETS: Record<string, { video: string; image: string; gen: string; res: string }> = {
  // 快速验证 = 海螺 H3 全能参考：资产图直接作身份参考，不经首帧那一跳，链路短、成功率高
  fast: { video: "minimax-h3-ref2v", image: "gpt-image-2", gen: "full_reference", res: "720p" },
  // 角色一致 = 同 H3 全参考链路，1080p 档位偏成片质量
  consistent: { video: "minimax-h3-ref2v", image: "gpt-image-2", gen: "full_reference", res: "1080p" },
  premium: { video: "seedance-2.0", image: "gpt-image-2", gen: "full_reference", res: "1080p" },
  first_frame: { video: "seedance-2.0", image: "nano-banana-pro", gen: "i2va", res: "1080p" },
};

/** 项目列表 + 新建向导（画幅图标化 / 生产模式展开可视化 / 预设联动）。 */
export default function ProjectList(p: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  // 向导表单
  const [title, setTitle] = useState("");
  const [aspect, setAspect] = useState("9:16");        // 默认 9:16
  const [mode, setMode] = useState("fast");
  const [videoModel, setVideoModel] = useState(PRESETS.fast.video);
  const [imageModel, setImageModel] = useState(PRESETS.fast.image);
  const [genMode, setGenMode] = useState(PRESETS.fast.gen);
  const [resolution, setResolution] = useState(PRESETS.fast.res);
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

  /** 点预设：把所有选项定位到预设值 */
  const applyPreset = (k: "fast" | "consistent" | "premium" | "first_frame") => {
    setMode(k);
    setVideoModel(PRESETS[k].video);
    setImageModel(PRESETS[k].image);
    setGenMode(PRESETS[k].gen);
    setResolution(PRESETS[k].res);
  };
  /** 用户改具体选项：若偏离当前预设 → 定位到自定义 */
  const touch = (patch: { video?: string; image?: string; gen?: string; res?: string }) => {
    const next = {
      video: patch.video ?? videoModel,
      image: patch.image ?? imageModel,
      gen: patch.gen ?? genMode,
      res: patch.res ?? resolution,
    };
    if (patch.video) setVideoModel(patch.video);
    if (patch.image) setImageModel(patch.image);
    if (patch.gen) setGenMode(patch.gen);
    if (patch.res) setResolution(patch.res);
    const hit = Object.entries(PRESETS).find(([, v]) =>
      v.video === next.video && v.image === next.image && v.gen === next.gen && v.res === next.res);
    setMode(hit ? hit[0] : "custom");
  };

  const doCreate = async () => {
    if (!title.trim()) return;
    setBusy(true); setErr("");
    try {
      const proj = await api.createProject(title.trim(), aspect, mode,
        mode === "custom"
          ? { video_model: videoModel, image_model: imageModel,
              generation_mode: genMode, resolution }
          : undefined);
      p.onOpen(proj.id);
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  return (
    <div className="plist">
      <header className="plist-head">
        <h1>🎬 FilmWeaver 织影</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>＋ 新建项目</button>
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

            <label>生产模式（点预设一键定位下方选项；手动调整则归入自定义）
              <div className="mode-cards">
                <button className={`mode-card ${mode === "fast" ? "on" : ""}`}
                  onClick={() => applyPreset("fast")}>⚡ 快速验证</button>
                <button className={`mode-card ${mode === "consistent" ? "on" : ""}`}
                  onClick={() => applyPreset("consistent")}>🎭 角色一致</button>
                <button className={`mode-card ${mode === "premium" ? "on" : ""}`}
                  onClick={() => applyPreset("premium")}>💎 精品制作</button>
                <button className={`mode-card ${mode === "first_frame" ? "on" : ""}`}
                  title="先出每镜首帧图（图生图喂角色/场景资产 + 场景基准帧），再由首帧生长为视频。可控性最高、最防场景偏移"
                  onClick={() => applyPreset("first_frame")}>🎬 首帧精控</button>
                <button className={`mode-card ${mode === "custom" ? "on" : ""}`}
                  title="修改下方任一选项即进入自定义">🛠 自定义</button>
              </div>
            </label>

            <label>视频模型
              <div className="opt-grid">
                {videoModels.map((m) => (
                  <button key={m.key} className={`opt-btn ${videoModel === m.key ? "on" : ""}`}
                    title={m.hint} onClick={() => touch({ video: m.key })}>
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
                    title={m.hint} onClick={() => touch({ image: m.key })}>
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
                    title={m.hint} onClick={() => touch({ res: m.key })}>
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
                    onClick={() => touch({ gen: m.key })}>
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
