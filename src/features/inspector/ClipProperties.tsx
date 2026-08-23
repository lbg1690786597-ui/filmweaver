/**
 * ClipProperties — Inspector 的基础 / 时间 / 音频属性编辑器（PLAN §7.1，Phase 3）
 *
 * TB-03/TB-10 已落地：变换（位置/缩放/旋转/不透明度/镜像）、变速、音量与淡化
 * 全部落库到 Shot.transform_meta，导出时由 media.py 翻译成 ffmpeg filter 链。
 *
 * 保存时机：拖动滑块只更新本地 state（不然拖一次发几十个 PATCH），
 * 松手（onPointerUp）与开关类点击才提交。
 */

import { useEffect, useState } from "react";
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
  useEffect(() => {
    const t = p.transform ?? {};
    setTf({
      x: t.x ?? 0, y: t.y ?? 0, scale: t.scale ?? 100, rotate: t.rotate ?? 0,
      opacity: t.opacity ?? 100, mirrorH: !!t.mirrorH, mirrorV: !!t.mirrorV,
      blend: "normal",
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
    const out: TransformMeta = {};
    if (T.x) out.x = T.x;
    if (T.y) out.y = T.y;
    if (T.scale !== 100) out.scale = T.scale;
    if (T.rotate) out.rotate = T.rotate;
    if (T.opacity !== 100) out.opacity = T.opacity;
    if (T.mirrorH) out.mirrorH = true;
    if (T.mirrorV) out.mirrorV = true;
    if (T.blend && T.blend !== "normal") {
      out.blendMode = T.blend as NonNullable<TransformMeta["blendMode"]>;
    }
    if (M.speed !== 1) out.speed = M.speed;
    if (A.volume !== 100) out.volume = A.volume;
    if (A.muted) out.muted = true;
    if (A.fadeIn) out.fadeIn = A.fadeIn;
    if (A.fadeOut) out.fadeOut = A.fadeOut;
    p.onPatchTransform(Object.keys(out).length ? out : {});
  };

  if (p.tab === "basic") {
    return (
      <div className="fw-cp">
        <Group title="位置">
          <Slider label="X" v={tf.x} min={-500} max={500} unit="px"
            onChange={(v) => setTf((s) => ({ ...s, x: v }))} onCommit={() => commit()} />
          <Slider label="Y" v={tf.y} min={-500} max={500} unit="px"
            onChange={(v) => setTf((s) => ({ ...s, y: v }))} onCommit={() => commit()} />
        </Group>
        <Group title="变换">
          <Slider label="缩放" v={tf.scale} min={10} max={400} unit="%"
            onChange={(v) => setTf((s) => ({ ...s, scale: v }))} onCommit={() => commit()} />
          <Slider label="旋转" v={tf.rotate} min={-180} max={180} unit="°"
            onChange={(v) => setTf((s) => ({ ...s, rotate: v }))} onCommit={() => commit()} />
          <Slider label="不透明度" v={tf.opacity} min={0} max={100} unit="%"
            onChange={(v) => setTf((s) => ({ ...s, opacity: v }))} onCommit={() => commit()} />
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
          onChange={(v) => setAu((s) => ({ ...s, volume: v }))} onCommit={() => commit()} />
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
          onChange={(v) => setAu((s) => ({ ...s, fadeIn: v }))} onCommit={() => commit()} />
        <Slider label="淡出" v={au.fadeOut} min={0} max={50} unit="×0.1s"
          onChange={(v) => setAu((s) => ({ ...s, fadeOut: v }))} onCommit={() => commit()} />
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

function Slider({ label, v, min, max, unit, onChange, onCommit }: {
  label: string; v: number; min: number; max: number; unit: string;
  onChange: (v: number) => void;
  /** 松手才落库：拖动中每帧发一次 PATCH 会把后端打满 */
  onCommit?: () => void;
}) {
  return (
    <div className="fw-cp-slider">
      <span className="fw-cp-k">{label}</span>
      <input type="range" min={min} max={max} value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit} onKeyUp={onCommit} />
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
