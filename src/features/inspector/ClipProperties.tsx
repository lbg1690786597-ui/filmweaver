/**
 * ClipProperties — Inspector 的基础 / 时间 / 音频属性编辑器（PLAN §7.1，Phase 3）
 *
 * TB-03/TB-10 已落地：变换（位置/缩放/旋转/不透明度/镜像）、变速、音量与淡化
 * 全部落库到 Shot.transform_meta，导出时由 media.py 翻译成 ffmpeg filter 链。
 *
 * 保存时机：拖动滑块**即时**提交（预览器读的是落库后的 transform_meta，
 * 不实时提交就看不到画面变化 —— 主流剪辑软件都是拖到哪儿画面就到哪儿）。
 * 松手再补一次收尾提交。拖动期间用 dragging 标记跳过回显，
 * 否则父组件刷新回来会把滑块拉回旧值。
 */

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { TransformMeta } from "../../api";
import "./ClipProperties.css";

export interface TransformState {
  x: number; y: number; scale: number; rotate: number; opacity: number;
  mirrorH: boolean; mirrorV: boolean; blend: string;
}
export interface TimeState { speed: number; freeze: boolean }
export interface AudioState { volume: number; muted: boolean; fadeIn: number; fadeOut: number }

const DEF_TRANSFORM: TransformState = {
  x: 0, y: 0, scale: 100, rotate: 0, opacity: 100,
  mirrorH: false, mirrorV: false, blend: "normal",
};
const DEF_TIME: TimeState = { speed: 1, freeze: false };
const DEF_AUDIO: AudioState = { volume: 100, muted: false, fadeIn: 0, fadeOut: 0 };

const BLEND_MODES = [
  { id: "normal", label: "正常" }, { id: "multiply", label: "正片叠底" },
  { id: "screen", label: "滤色" }, { id: "overlay", label: "叠加" },
  { id: "darken", label: "变暗" }, { id: "lighten", label: "变亮" },
];

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

interface Props {
  tab: "basic" | "time" | "audio";
  /** 用于在切换镜头时重载本地编辑态 */
  shotId: string;
  durationSec: number;
  order: number;
  disabled: boolean;
  /** 该镜已保存的调整参数（后端 transform_meta） */
  transform: TransformMeta | null;
  /** 是否为叠加层镜头（混合模式只对叠加层有意义） */
  isOverlay?: boolean;
  onPatchDuration: (sec: number) => void;
  /** TB-03/TB-10：保存调整参数；传 {} 清空 */
  onPatchTransform: (tm: TransformMeta | Record<string, never>) => void;
  onToast: (m: string) => void;
}

export default function ClipProperties(p: Props) {
  const [tf, setTf] = useState<TransformState>(DEF_TRANSFORM);
  const [tm, setTm] = useState<TimeState>(DEF_TIME);
  const [au, setAu] = useState<AudioState>(DEF_AUDIO);
  const [durDraft, setDurDraft] = useState(p.durationSec);

  // 切镜头 → 载入该镜已保存的参数（没有就回默认值）
  //
  // ⚠️ 依赖里有 p.transform，而滑块拖动会 commit → 父组件刷新 → p.transform 变化
  // → 又回来重置本地 state。拖动中这条链会和用户抢滑块，手感发飘、数值回跳。
  // 用 dragging 标记跳过拖动期间的回显（松手后仍以服务端值为准）。
  const dragging = useRef(false);
  useEffect(() => {
    if (dragging.current) return;
    const t = p.transform ?? {};
    setTf({
      x: t.x ?? 0, y: t.y ?? 0, scale: t.scale ?? 100, rotate: t.rotate ?? 0,
      opacity: t.opacity ?? 100, mirrorH: !!t.mirrorH, mirrorV: !!t.mirrorV,
      // 混合模式此前硬编码 "normal"，导致重新选中镜头后已保存的
      // blendMode 显示不出来，之后任何一次 commit 都会把它丢掉
      blend: t.blendMode ?? "normal",
    });
    setTm({ speed: t.speed ?? 1, freeze: false });
    setAu({
      volume: t.volume ?? 100, muted: !!t.muted,
      fadeIn: t.fadeIn ?? 0, fadeOut: t.fadeOut ?? 0,
    });
    setDurDraft(p.durationSec);
  }, [p.shotId, p.durationSec, p.transform]);

  /** 汇总三组本地 state → transform_meta 落库。
   *  全是默认值时传 {}，后端会存 NULL，导出走"无调整"的快路径。 */
  const commit = (over?: Partial<{
    tf: TransformState; tm: TimeState; au: AudioState;
  }>) => {
    const T = over?.tf ?? tf, M = over?.tm ?? tm, A = over?.au ?? au;

    // ⚠️ 必须在**已有** transform_meta 上合并，不能从 {} 重建。
    //
    // 后端是整体替换（routes_v2.py: shot.transform_meta = json.dumps(...)），
    // 而本面板只持有位置/变换/速度/音量这几组键。从零重建再提交，
    // 等于把滤镜面板写的调色、LUT、逐帧特效全部抹掉 ——
    // 用户在滤镜面板调好色，回来拖一下音量，画面就回到原始色。
    //
    // 本面板拥有的键要显式 delete（值为默认时），否则清不掉旧值；
    // 不属于本面板的键（exposure/contrast/lut/vignette…）原样保留。
    const out: TransformMeta = { ...(p.transform ?? {}) };
    const set = <K extends keyof TransformMeta>(k: K, v: TransformMeta[K], keep: boolean) => {
      if (keep) out[k] = v; else delete out[k];
    };

    set("x", T.x, !!T.x);
    set("y", T.y, !!T.y);
    set("scale", T.scale, T.scale !== 100);
    set("rotate", T.rotate, !!T.rotate);
    set("opacity", T.opacity, T.opacity !== 100);
    set("mirrorH", true, !!T.mirrorH);
    set("mirrorV", true, !!T.mirrorV);
    set("blendMode", T.blend as NonNullable<TransformMeta["blendMode"]>,
        !!T.blend && T.blend !== "normal");
    set("speed", M.speed, M.speed !== 1);
    set("volume", A.volume, A.volume !== 100);
    set("muted", true, !!A.muted);
    set("fadeIn", A.fadeIn, !!A.fadeIn);
    set("fadeOut", A.fadeOut, !!A.fadeOut);

    p.onPatchTransform(Object.keys(out).length ? out : {});
  };

  if (p.tab === "basic") {
    return (
      <div className="fw-cp">
        <Group title="位置">
          <Slider label="X" v={tf.x} min={-500} max={500} unit="px"
            onChange={(v) => { setTf((s) => ({ ...s, x: v })); commit({ tf: { ...tf, x: v } }); }} onCommit={() => commit()} dragRef={dragging} />
          <Slider label="Y" v={tf.y} min={-500} max={500} unit="px"
            onChange={(v) => { setTf((s) => ({ ...s, y: v })); commit({ tf: { ...tf, y: v } }); }} onCommit={() => commit()} dragRef={dragging} />
        </Group>
        <Group title="变换">
          <Slider label="缩放" v={tf.scale} min={10} max={400} unit="%"
            onChange={(v) => { setTf((s) => ({ ...s, scale: v })); commit({ tf: { ...tf, scale: v } }); }} onCommit={() => commit()} dragRef={dragging} />
          <Slider label="旋转" v={tf.rotate} min={-180} max={180} unit="°"
            onChange={(v) => { setTf((s) => ({ ...s, rotate: v })); commit({ tf: { ...tf, rotate: v } }); }} onCommit={() => commit()} dragRef={dragging} />
          <Slider label="不透明度" v={tf.opacity} min={0} max={100} unit="%"
            onChange={(v) => { setTf((s) => ({ ...s, opacity: v })); commit({ tf: { ...tf, opacity: v } }); }} onCommit={() => commit()} dragRef={dragging} />
        </Group>
        <Group title="混合与镜像">
          <div className="fw-cp-row">
            <span className="fw-cp-k">混合模式</span>
            <select className="fw-cp-select" value={tf.blend}
              disabled={!p.isOverlay}
              title={p.isOverlay
                ? "叠加层与下层画面的混合方式，导出即生效"
                : "混合模式只对叠加层有意义——主轨下面没有画面可混合。"
                  + "右键镜头「移到叠加层」后可用"}
              onChange={(e) => {
                const n = { ...tf, blend: e.target.value };
                setTf(n); commit({ tf: n });
              }}>
              {BLEND_MODES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </div>
          <div className="fw-cp-row">
            <span className="fw-cp-k">镜像</span>
            <span className="fw-cp-toggles">
              <button className={tf.mirrorH ? "on" : ""}
                onClick={() => { const n = { ...tf, mirrorH: !tf.mirrorH }; setTf(n); commit({ tf: n }); }}>水平</button>
              <button className={tf.mirrorV ? "on" : ""}
                onClick={() => { const n = { ...tf, mirrorV: !tf.mirrorV }; setTf(n); commit({ tf: n }); }}>垂直</button>
            </span>
          </div>
        </Group>
        <ResetBtn onClick={() => { setTf(DEF_TRANSFORM); commit({ tf: DEF_TRANSFORM }); }} />
      </div>
    );
  }

  if (p.tab === "time") {
    return (
      <div className="fw-cp">
        <Group title="时长（可编辑）">
          <div className="fw-cp-row">
            <span className="fw-cp-k">时长</span>
            <span className="fw-cp-dur">
              <input type="number" min={1} max={15} step={1} value={durDraft}
                onChange={(e) => setDurDraft(Number(e.target.value))}
                onBlur={() => {
                  const v = Math.max(1, Math.min(15, Math.round(durDraft)));
                  setDurDraft(v);
                  if (v !== Math.round(p.durationSec)) p.onPatchDuration(v);
                }} />
              <span className="fw-cp-unit">s</span>
            </span>
          </div>
          <div className="fw-cp-hint">后端钳制 1–15 秒，与时间轴拖拽同源</div>
        </Group>

        <Group title="位置">
          <Row k="序号" v={`#${p.order}`} />
          <Row k="参与导出" v={p.disabled ? "否（已停用）" : "是"} />
        </Group>

        <Group title="速度">
          <div className="fw-cp-speeds">
            {SPEEDS.map((s) => (
              <button key={s} className={tm.speed === s ? "on" : ""}
                onClick={() => { const n = { ...tm, speed: s }; setTm(n); commit({ tm: n }); }}>
                {s}×
              </button>
            ))}
          </div>
          <div className="fw-cp-hint">变速同时改画面与声音（atempo），导出即生效</div>
        </Group>
        <ResetBtn onClick={() => { setTm(DEF_TIME); commit({ tm: DEF_TIME }); }} />
      </div>
    );
  }

  return (
    <div className="fw-cp">
      <Group title="音量">
        <Slider label="音量" v={au.volume} min={0} max={200} unit="%"
          onChange={(v) => { setAu((s) => ({ ...s, volume: v })); commit({ au: { ...au, volume: v } }); }} onCommit={() => commit()} dragRef={dragging} />
        <div className="fw-cp-row">
          <span className="fw-cp-k">静音</span>
          <button className={`fw-cp-switch ${au.muted ? "on" : ""}`}
            onClick={() => { const n = { ...au, muted: !au.muted }; setAu(n); commit({ au: n }); }}>
            {au.muted ? "开" : "关"}
          </button>
        </div>
      </Group>
      <Group title="淡化">
        <Slider label="淡入" v={au.fadeIn} min={0} max={50} unit="×0.1s"
          onChange={(v) => { setAu((s) => ({ ...s, fadeIn: v })); commit({ au: { ...au, fadeIn: v } }); }} onCommit={() => commit()} dragRef={dragging} />
        <Slider label="淡出" v={au.fadeOut} min={0} max={50} unit="×0.1s"
          onChange={(v) => { setAu((s) => ({ ...s, fadeOut: v })); commit({ au: { ...au, fadeOut: v } }); }} onCommit={() => commit()} dragRef={dragging} />
      </Group>
      <ResetBtn onClick={() => { setAu(DEF_AUDIO); commit({ au: DEF_AUDIO }); }} />
    </div>
  );
}

/* ---- 内部小组件 ---- */

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="fw-cp-group">
      <div className="fw-cp-group-title">{title}</div>
      {children}
    </section>
  );
}

function Slider({ label, v, min, max, unit, onChange, onCommit, dragRef }: {
  label: string; v: number; min: number; max: number; unit: string;
  onChange: (v: number) => void;
  /** 松手时的收尾提交（拖动中 onChange 已经在实时提交了） */
  onCommit?: () => void;
  /** 拖动标记，交给父组件用来跳过回显（见 useEffect 里的说明） */
  dragRef?: React.MutableRefObject<boolean>;
}) {
  return (
    <div className="fw-cp-slider">
      <span className="fw-cp-k">{label}</span>
      <input type="range" min={min} max={max} value={v}
        onPointerDown={() => { if (dragRef) dragRef.current = true; }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={() => { if (dragRef) dragRef.current = false; onCommit?.(); }}
        onPointerCancel={() => { if (dragRef) dragRef.current = false; }}
        onKeyUp={onCommit}
        onBlur={() => { if (dragRef) dragRef.current = false; }} />
      <span className="fw-cp-v">{v}<em>{unit}</em></span>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="fw-cp-row"><span className="fw-cp-k">{k}</span><span className="fw-cp-v">{v}</span></div>;
}

function ResetBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="fw-cp-reset" onClick={onClick}>
      <RotateCcw size={12} /> 重置本组参数
    </button>
  );
}
