/**
 * EffectsPanel — 转场 / 特效 / 滤镜（PLAN §5.4-5.6，Phase 3）
 *
 * 三个面板共用一个组件（结构相同：分组 + 卡片网格 + 应用），由 kind 区分。
 *
 * 落地情况（Render V2 之后）：
 *   调色 / LUT  —— 已接通，写进 Shot.transform_meta
 *   转场        —— 已接通（落库 transitions 表）。Render V2.1 真正渲染
 *                  fade / fadeblack / fadewhite 三种；其余照常落库，
 *                  由编译器按 capabilities 决定，渲染不了时降级为硬切。
 *   逐帧特效    —— 仍是 Mock：需要逐帧合成，待 V2.2
 */

/** 可渲染转场：**运行时向 ffmpeg 探测**，不硬编码。
 *  转场类型随版本增删（本机 4.4.2 无 zoomin，新版有），
 *  写死清单必然在某些用户机器上骗人。网页预览无 sidecar 时退回 fade 系。 */
const FALLBACK_TRANSITIONS = new Set(["fade", "fadeblack", "fadewhite"]);

/** V2.2：特效卡 id → transform_meta 里的字段名。
 *  只有列在这里的才真正参与渲染（每个都经真实 ffmpeg 验证）。 */
const EFFECT_FIELD: Record<string, string> = {
  "blur-bg": "blur",
  vignette: "vignette",
  "film-grain": "grain",
  glitch: "glitch",
  "rgb-split": "glitch",     // 与故障风同一实现（rgbashift）
  shake: "shake",
  "zoom-pulse": "zoomPulse",
  flash: "flash",
  glow: "glow",
};

import { useEffect, useRef, useState } from "react";
import { Check, Info, Upload, Loader2 } from "lucide-react";
import { api } from "../../api";
import { probeCapabilities } from "../../render/capabilities";
import type { TransformMeta } from "../../api";
import "./EffectsPanel.css";

export type EffectKind = "transition" | "effect" | "filter";

interface Item {
  id: string;
  name: string;
  /** CSS 预览用的渐变/滤镜表达式（纯前端演示，不代表最终渲染效果） */
  preview: string;
  group: string;
}

/* ---- 转场库（对应 FFmpeg xfade 的常见 transition） ---- */
const TRANSITIONS: Item[] = [
  { id: "fade", name: "淡入淡出", group: "基础", preview: "linear-gradient(90deg,#000,#888,#fff)" },
  { id: "fadeblack", name: "黑场过渡", group: "基础", preview: "linear-gradient(90deg,#fff,#000,#fff)" },
  { id: "fadewhite", name: "白场过渡", group: "基础", preview: "linear-gradient(90deg,#333,#fff,#333)" },
  { id: "dissolve", name: "溶解", group: "基础", preview: "radial-gradient(circle,#888,#222)" },
  { id: "slideleft", name: "左滑", group: "运动", preview: "linear-gradient(90deg,#4a5,#254)" },
  { id: "slideright", name: "右滑", group: "运动", preview: "linear-gradient(270deg,#4a5,#254)" },
  { id: "slideup", name: "上滑", group: "运动", preview: "linear-gradient(0deg,#4a5,#254)" },
  { id: "slidedown", name: "下滑", group: "运动", preview: "linear-gradient(180deg,#4a5,#254)" },
  { id: "wipeleft", name: "左擦除", group: "擦除", preview: "linear-gradient(90deg,#a54,#421)" },
  { id: "wiperight", name: "右擦除", group: "擦除", preview: "linear-gradient(270deg,#a54,#421)" },
  { id: "circleopen", name: "圆形展开", group: "擦除", preview: "radial-gradient(circle,#fff 30%,#222 70%)" },
  { id: "circleclose", name: "圆形收拢", group: "擦除", preview: "radial-gradient(circle,#222 30%,#fff 70%)" },
  { id: "smoothleft", name: "平滑左移", group: "运动", preview: "linear-gradient(100deg,#57a,#235)" },
  { id: "pixelize", name: "像素化", group: "风格", preview: "repeating-linear-gradient(45deg,#666 0 6px,#333 6px 12px)" },
  { id: "zoomin", name: "缩放推入", group: "运动", preview: "radial-gradient(circle,#a85 20%,#432 80%)" },
];

/* ---- 特效库 ---- */
const EFFECTS: Item[] = [
  { id: "shake", name: "画面抖动", group: "画面效果", preview: "repeating-linear-gradient(0deg,#446 0 3px,#224 3px 6px)" },
  { id: "zoom-pulse", name: "心跳缩放", group: "画面效果", preview: "radial-gradient(circle,#a44,#422)" },
  { id: "glitch", name: "故障风", group: "画面效果", preview: "repeating-linear-gradient(90deg,#f0f 0 4px,#0ff 4px 8px,#222 8px 14px)" },
  { id: "vignette", name: "暗角", group: "画面效果", preview: "radial-gradient(circle,#999 30%,#000 90%)" },
  { id: "light-leak", name: "漏光", group: "画面效果", preview: "linear-gradient(120deg,#fa6,#633)" },
  { id: "film-grain", name: "胶片颗粒", group: "画面效果", preview: "repeating-conic-gradient(#555 0% 25%,#333 0% 50%)" },
  { id: "blur-bg", name: "背景虚化", group: "人物特效", preview: "linear-gradient(90deg,#456,#89a)" },
  { id: "glow", name: "人物发光", group: "人物特效", preview: "radial-gradient(circle,#ffd 20%,#556 80%)" },
  { id: "outline", name: "描边", group: "人物特效", preview: "linear-gradient(45deg,#fff 0 2px,#333 2px)" },
  { id: "speed-ramp", name: "速度斜坡", group: "视频特效", preview: "linear-gradient(90deg,#345,#8ab,#345)" },
  { id: "flash", name: "闪白", group: "视频特效", preview: "linear-gradient(90deg,#222,#fff,#222)" },
  { id: "rgb-split", name: "RGB 分离", group: "视频特效", preview: "linear-gradient(90deg,#f44,#4f4,#44f)" },
];

/* ---- 滤镜预设 ---- */
const FILTERS: Item[] = [
  { id: "none", name: "原图", group: "基础", preview: "linear-gradient(135deg,#8a9,#567)" },
  { id: "warm", name: "暖阳", group: "色调", preview: "linear-gradient(135deg,#fc8,#a74)" },
  { id: "cool", name: "冷调", group: "色调", preview: "linear-gradient(135deg,#8cf,#357)" },
  { id: "cinematic", name: "电影感", group: "影视", preview: "linear-gradient(135deg,#3a4a5a,#c9a06a)" },
  { id: "teal-orange", name: "青橙", group: "影视", preview: "linear-gradient(135deg,#0a7,#f83)" },
  { id: "noir", name: "黑白", group: "影视", preview: "linear-gradient(135deg,#eee,#222)" },
  { id: "vintage", name: "复古", group: "风格", preview: "linear-gradient(135deg,#d4b483,#8a6f4a)" },
  { id: "fade-film", name: "褪色胶片", group: "风格", preview: "linear-gradient(135deg,#bba,#776)" },
  { id: "high-contrast", name: "高对比", group: "风格", preview: "linear-gradient(135deg,#fff,#000)" },
  { id: "soft", name: "柔光", group: "风格", preview: "linear-gradient(135deg,#fde,#caa)" },
];

/* ---- 调节参数（滤镜面板下半部分）---- */
const ADJUSTMENTS = [
  { id: "exposure", label: "曝光", min: -100, max: 100, def: 0 },
  { id: "contrast", label: "对比度", min: -100, max: 100, def: 0 },
  { id: "saturation", label: "饱和度", min: -100, max: 100, def: 0 },
  { id: "temperature", label: "色温", min: -100, max: 100, def: 0 },
  { id: "tint", label: "色调", min: -100, max: 100, def: 0 },
  { id: "highlights", label: "高光", min: -100, max: 100, def: 0 },
  { id: "shadows", label: "阴影", min: -100, max: 100, def: 0 },
  { id: "sharpen", label: "锐化", min: 0, max: 100, def: 0 },
];

const DATA: Record<EffectKind, Item[]> = {
  transition: TRANSITIONS, effect: EFFECTS, filter: FILTERS,
};

const HINT: Record<EffectKind, string> = {
  transition: "选中一个镜头，点击转场即加在它与下一个镜头的接缝上",
  effect: "选中镜头后点击特效应用；再次点击关闭",
  filter: "选中镜头后应用滤镜预设，或在下方手动调节参数",
};

interface Props {
  kind: EffectKind;
  hasSelection: boolean;
  /** 当前选中镜头的 id。回显 effect 必须依赖它 —— 只依赖 transform 的话，
   *  两个都没有调色的镜头之间切换时 prop 恒为 null、effect 不触发，
   *  在 A 镜拖了但没应用的值会原样带到 B 镜。 */
  shotId?: string | null;
  projectId: string;
  /** 当前选中镜头已保存的调整（滤镜面板据此回显） */
  transform: TransformMeta | null;
  /** 保存调色/LUT 到选中镜头 */
  onPatchTransform: (tm: TransformMeta) => void;
  /** Render V2：把转场加在选中镜头之后的接缝上 */
  onApplyTransition?: (type: string) => void;
  onToast: (m: string) => void;
}

/** 滤镜预设 → 调色参数（把"暖阳/青橙"这种说法翻译成具体数值） */
const FILTER_PRESET_VALUES: Record<string, Partial<TransformMeta>> = {
  none: {},
  warm: { temperature: 35, saturation: 10 },
  cool: { temperature: -35, saturation: 5 },
  cinematic: { contrast: 18, saturation: -8, shadows: -12, temperature: 10 },
  "teal-orange": { temperature: 25, tint: -18, saturation: 22, contrast: 12 },
  noir: { saturation: -100, contrast: 25 },
  vintage: { temperature: 28, saturation: -25, contrast: -10, highlights: -15 },
  "fade-film": { contrast: -22, saturation: -18, shadows: 20 },
  "high-contrast": { contrast: 45, sharpen: 20 },
  soft: { contrast: -15, highlights: 12, sharpen: 0 },
};

export default function EffectsPanel({
  kind, hasSelection, shotId, projectId, transform, onPatchTransform,
  onApplyTransition, onToast,
}: Props) {
  const items = DATA[kind];
  const [applied, setApplied] = useState<string | null>(null);
  const [adj, setAdj] = useState<Record<string, number>>(
    () => Object.fromEntries(ADJUSTMENTS.map((a) => [a.id, a.def])));
  const [lutBusy, setLutBusy] = useState(false);
  const [okTransitions, setOkTransitions] = useState<Set<string>>(FALLBACK_TRANSITIONS);

  useEffect(() => {
    if (kind !== "transition") return;
    void probeCapabilities().then((c) => {
      if (c.transitions.size) setOkTransitions(c.transitions);
    }).catch(() => { /* 网页预览无 sidecar，保持 fallback */ });
  }, [kind]);
  const lutRef = useRef<HTMLInputElement | null>(null);
  const groups = [...new Set(items.map((i) => i.group))];

  // 拖动中标记：拖的时候不能被下面的回显 effect 覆盖，
  // 否则每次 onPatchTransform 引起父组件刷新，滑块会被拉回旧值、手感发飘。
  const dragging = useRef(false);

  // 选中镜头变化 → 回显它已保存的调色参数
  useEffect(() => {
    if (dragging.current) return;   // 见上
    const t = transform ?? {};
    setAdj(Object.fromEntries(ADJUSTMENTS.map(
      (a) => [a.id, (t as Record<string, number>)[a.id] ?? a.def])));
    // applied 是"刚点过哪张卡"的一次性视觉反馈，属于**上一个镜头**的状态。
    // 不清的话切到别的镜头，那张卡还挂着 ✓，看起来像这一镜也应用了。
    setApplied(null);
  }, [transform, shotId]);

  /** 把当前滑块值合并进 transform_meta 并落库。
   *
   *  必须在**已有** transform_meta 上合并：这个面板只管调色那几项，
   *  从零重建会把 Inspector 写的位置/变速/音量全抹掉（后端是整体替换）。
   *  默认值要显式 delete，否则清不掉旧值。 */
  const pushAdj = (vals: Record<string, number>) => {
    if (!hasSelection) return;
    const next = { ...(transform ?? {}) } as Record<string, unknown>;
    for (const a of ADJUSTMENTS) {
      if (vals[a.id] !== a.def) next[a.id] = vals[a.id];
      else delete next[a.id];
    }
    onPatchTransform(next as TransformMeta);
  };

  const apply = (it: Item) => {
    if (!hasSelection) { onToast("请先在时间轴选中镜头"); return; }
    setApplied(it.id);
    if (kind === "filter") {
      // 滤镜预设直接落库（调色已接通导出）
      const vals = FILTER_PRESET_VALUES[it.id] ?? {};
      const next = { ...(transform ?? {}) };
      for (const a of ADJUSTMENTS) delete (next as Record<string, unknown>)[a.id];
      onPatchTransform({ ...next, ...vals });
      onToast(`已应用滤镜「${it.name}」，导出即生效`);
      return;
    }
    if (kind === "transition") {
      // 转场落库（无论能否渲染——用户的编排不该因引擎没跟上就丢失）
      onApplyTransition?.(it.id);
      if (!okTransitions.has(it.id)) {
        onToast(`「${it.name}」已保存，但当前渲染引擎尚未实现此转场，导出时会降级为硬切`);
      }
      return;
    }
    // V2.2 逐帧特效：能映射到实现的直接落库
    const field = EFFECT_FIELD[it.id];
    if (field) {
      const cur = (transform ?? {}) as Record<string, unknown>;
      const on = (cur[field] as number | undefined) ?? 0;
      // 再次点击同一特效 = 关闭（强度归零），符合"开关"直觉
      const next = { ...cur, [field]: on > 0 ? 0 : 60 };
      onPatchTransform(next as TransformMeta);
      onToast(on > 0 ? `已关闭「${it.name}」` : `已应用「${it.name}」，导出即生效`);
      return;
    }
    onToast(`「${it.name}」尚无渲染实现，暂不参与导出`);
  };

  return (
    <div className="fw-fx">
      <div className="fw-fx-hint"><Info size={11} /> {HINT[kind]}</div>

      {groups.map((g) => (
        <div key={g} className="fw-fx-group">
          <div className="fw-fx-group-title">{g}</div>
          <div className="fw-fx-grid">
            {items.filter((i) => i.group === g).map((it) => (
              <button key={it.id}
                className={`fw-fx-card ${
                  applied === it.id
                  || (kind === "effect" && EFFECT_FIELD[it.id]
                      && ((transform as Record<string, number> | null)
                          ?.[EFFECT_FIELD[it.id]] ?? 0) > 0)
                    ? "on" : ""}`}
                onClick={() => apply(it)} title={it.name}>
                <span className="fw-fx-preview" style={{ background: it.preview }}>
                  {applied === it.id && <Check size={14} className="fw-fx-check" />}
                  {((kind === "transition" && okTransitions.has(it.id))
                    || (kind === "effect" && EFFECT_FIELD[it.id])) && (
                    <span className="fw-fx-ready" title="可渲染">●</span>
                  )}
                </span>
                <span className="fw-fx-name">{it.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* 滤镜面板额外提供手动调节 */}
      {kind === "filter" && (
        <div className="fw-fx-group">
          <div className="fw-fx-group-title">手动调节</div>
          <div className="fw-fx-adjust">
            {ADJUSTMENTS.map((a) => (
              <div key={a.id} className="fw-fx-slider-row">
                <span className="fw-fx-slider-label">{a.label}</span>
                {/* 拖动即预览：onChange 立刻把新值送出去，画面跟着动
                    （预览器读的是同一份 transform_meta）。
                    落库放在 onPointerUp/onKeyUp —— 拖一次滑块会触发几十次
                    onChange，每次都 PATCH 会把后端刷爆，也会让撤销栈塞满噪声。 */}
                <input type="range" min={a.min} max={a.max} value={adj[a.id]}
                  onPointerDown={() => { dragging.current = true; }}
                  onChange={(e) => {
                    const next = { ...adj, [a.id]: Number(e.target.value) };
                    setAdj(next);
                    pushAdj(next);          // 实时预览
                  }}
                  onPointerUp={() => { dragging.current = false; }}
                  onPointerCancel={() => { dragging.current = false; }}
                  // 键盘调节（←→）没有 pointer 事件，靠 blur 收尾
                  onBlur={() => { dragging.current = false; }} />
                <span className="fw-fx-slider-val">{adj[a.id]}</span>
              </div>
            ))}
            <div className="fw-fx-adjust-acts">
              {/* 「应用到选中镜头」已移除：拖动滑块即时生效并落库，
                  留着那个按钮反而误导（让人以为不点就没保存）。 */}
              <button disabled={!hasSelection} onClick={() => {
                const d = Object.fromEntries(ADJUSTMENTS.map((a) => [a.id, a.def]));
                setAdj(d);
                pushAdj(d);
                onToast("已重置本镜调色");
              }}>重置本镜调色</button>
              {!hasSelection && (
                <span className="fw-fx-hint">先在镜头轨选中一个镜头</span>
              )}
            </div>
          </div>
          <div className="fw-fx-group-title">LUT</div>
          <div className="fw-fx-lut">
            <input ref={lutRef} type="file" accept=".cube" hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                if (!hasSelection) { onToast("请先在时间轴选中镜头"); return; }
                setLutBusy(true);
                try {
                  const r = await api.uploadMedia(f, projectId);
                  onPatchTransform({ ...(transform ?? {}), lut: r.url });
                  onToast(`已应用 LUT「${f.name}」，导出即生效`);
                } catch (err) { onToast(String(err)); }
                finally { setLutBusy(false); }
              }} />
            <button disabled={lutBusy} onClick={() => lutRef.current?.click()}
              title="导入 .cube 色彩查找表，导出时由 ffmpeg lut3d 应用">
              {lutBusy ? <Loader2 size={11} className="fw-spin" /> : <Upload size={11} />}
              {transform?.lut ? " 更换 .cube LUT" : " 导入 .cube LUT 文件"}
            </button>
            {transform?.lut && (
              <button onClick={() => {
                const next = { ...(transform ?? {}) };
                delete next.lut;
                onPatchTransform(next);
                onToast("已移除 LUT");
              }}>移除当前 LUT</button>
            )}
          </div>
        </div>
      )}

      <div className="fw-fx-footer">
        {kind === "filter" ? "调色与 LUT 已接通导出渲染"
          : kind === "transition"
            ? `带 ● 的 ${okTransitions.size ? [...okTransitions].filter((t) =>
                TRANSITIONS.some((x) => x.id === t)).length : 3} 种转场已可渲染，其余保存后降级为硬切`
            : "带 ● 的特效已接通导出渲染；再次点击可关闭"}
      </div>
    </div>
  );
}
