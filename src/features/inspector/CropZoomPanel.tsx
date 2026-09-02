/**
 * CropZoomPanel — 取景框裁切 / 平移 / 缩放编辑器（V2.3）
 *
 * 用途：在某些镜头里只显示画面的一部分，并让这部分铺满导出分辨率。
 * 常见场景：竖屏素材 → 横屏输出时剪掉两侧黑边；特写重构；画面平移。
 *
 * 实现：
 *  - crop：裁切（相对原始画面 0..1 比例，四边各自独立）
 *  - scale/x/y：在画布上的缩放和位置偏移（scale 可超过 100% = 放大并裁边）
 *
 * 注意：crop 控制"从原始素材截取哪部分"，scale/x/y 控制"截取出来的画面
 * 如何在成片画布上摆放"。两者叠加可实现"只取右半边画面，铺满全屏"等效果。
 */

import { AlignCenter, Maximize2, RotateCcw } from "lucide-react";
import type { TransformMeta } from "../../api";
import "./CropZoomPanel.css";

interface CropState { left: number; top: number; right: number; bottom: number }
const DEFAULT_CROP: CropState = { left: 0, top: 0, right: 0, bottom: 0 };

interface Props {
  shotId: string;
  transform: TransformMeta | null;
  onPatchTransform: (tm: TransformMeta | Record<string, never>) => void;
  onToast: (m: string) => void;
}

/** 将 0..1 比例显示为百分比，保留一位小数 */
const p1 = (v: number) => (v * 100).toFixed(1);

/** 常见裁切预设 */
const CROP_PRESETS: { label: string; crop: CropState; hint?: string }[] = [
  { label: "无裁切",     crop: DEFAULT_CROP },
  { label: "16:9 居中",  crop: { left: 0, top: 0.125, right: 0, bottom: 0.125 }, hint: "从 4:3 画面裁出 16:9" },
  { label: "9:16 居中",  crop: { left: 0.28125, top: 0, right: 0.28125, bottom: 0 }, hint: "从 16:9 画面裁出 9:16 竖屏" },
  { label: "1:1 居中",   crop: { left: 0.125, top: 0, right: 0.125, bottom: 0 }, hint: "从 16:9 裁出正方形" },
  { label: "4:3 居中",   crop: { left: 0.0833, top: 0, right: 0.0833, bottom: 0 }, hint: "从 16:9 裁出 4:3" },
  { label: "上三分之二", crop: { left: 0, top: 0, right: 0, bottom: 0.333 }, hint: "去掉下三分之一" },
  { label: "下三分之二", crop: { left: 0, top: 0.333, right: 0, bottom: 0 }, hint: "去掉上三分之一" },
  { label: "左半边",     crop: { left: 0, top: 0, right: 0.5, bottom: 0 }, hint: "只保留左侧画面" },
  { label: "右半边",     crop: { left: 0.5, top: 0, right: 0, bottom: 0 }, hint: "只保留右侧画面" },
];

function Slider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  unit: string; onChange: (v: number) => void;
}) {
  return (
    <div className="fw-czp-row">
      <span className="fw-czp-label">{label}</span>
      <input type="range" min={min} max={max} step={step}
        value={value} className="fw-czp-slider"
        onChange={(e) => onChange(Number(e.target.value))} />
      <span className="fw-czp-val">{value.toFixed(step < 1 ? 1 : 0)}{unit}</span>
    </div>
  );
}

export default function CropZoomPanel({ transform, onPatchTransform, onToast }: Props) {
  const tm = transform ?? {};
  const crop: CropState = (tm.crop as CropState | undefined) ?? { ...DEFAULT_CROP };
  const scale = tm.scale ?? 100;
  const x = tm.x ?? 0;
  const y = tm.y ?? 0;

  // 预览用：裁切后剩余画面宽高百分比
  const visW = Math.max(0.01, 1 - crop.left - crop.right);
  const visH = Math.max(0.01, 1 - crop.top - crop.bottom);

  function patch(update: Partial<TransformMeta>) {
    onPatchTransform({ ...tm, ...update } as TransformMeta);
  }

  function applyCropPreset(c: CropState) {
    patch({ crop: { ...c } });
  }

  function resetCrop() {
    patch({ crop: { ...DEFAULT_CROP } });
    onToast("已重置裁切");
  }

  function resetAll() {
    patch({ crop: { ...DEFAULT_CROP }, scale: 100, x: 0, y: 0 });
    onToast("已重置取景框");
  }

  function centerAlign() {
    patch({ x: 0, y: 0 });
    onToast("已居中对齐");
  }

  const hasCrop = crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0;
  const hasTransform = scale !== 100 || x !== 0 || y !== 0;

  return (
    <div className="fw-czp">
      {/* 裁切示意图 */}
      <div className="fw-czp-preview" title="裁切区域示意（蓝色为保留区域）">
        <div className="fw-czp-preview-outer">
          <div className="fw-czp-preview-shadow top"    style={{ height: `${crop.top * 100}%` }} />
          <div className="fw-czp-preview-shadow bottom" style={{ height: `${crop.bottom * 100}%` }} />
          <div className="fw-czp-preview-shadow left"   style={{ width: `${crop.left * 100}%` }} />
          <div className="fw-czp-preview-shadow right"  style={{ width: `${crop.right * 100}%` }} />
          <div className="fw-czp-preview-center"
            style={{
              left:   `${crop.left * 100}%`,
              top:    `${crop.top * 100}%`,
              width:  `${visW * 100}%`,
              height: `${visH * 100}%`,
            }}>
            <span className="fw-czp-preview-label">{p1(visW * 100)}%×{p1(visH * 100)}%</span>
          </div>
        </div>
      </div>

      {/* 裁切四边 */}
      <div className="fw-czp-section-title">裁切边距</div>
      {(["top", "bottom", "left", "right"] as const).map((side) => {
        const labels = { top: "上", bottom: "下", left: "左", right: "右" };
        const opposite = side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
        const maxVal = Math.max(0, 1 - crop[opposite] - 0.05);
        return (
          <div key={side} className="fw-czp-row">
            <span className="fw-czp-label">裁{labels[side]}</span>
            <input type="range" min={0} max={Math.round(maxVal * 100)} step={1}
              value={Math.round(crop[side] * 100)}
              className="fw-czp-slider"
              onChange={(e) => patch({ crop: { ...crop, [side]: Number(e.target.value) / 100 } })} />
            <span className="fw-czp-val">{(crop[side] * 100).toFixed(0)}%</span>
          </div>
        );
      })}

      {hasCrop && (
        <button className="fw-czp-reset-link" onClick={resetCrop}>
          <RotateCcw size={10} /> 重置裁切
        </button>
      )}

      {/* 裁切预设 */}
      <div className="fw-czp-section-title" style={{ marginTop: 8 }}>比例预设</div>
      <div className="fw-czp-presets">
        {CROP_PRESETS.map((p) => (
          <button key={p.label}
            className={`fw-czp-preset-btn ${!hasCrop && p.label === "无裁切" ? "active" : ""}`}
            title={p.hint}
            onClick={() => applyCropPreset(p.crop)}>
            {p.label}
          </button>
        ))}
      </div>

      {/* 位置和缩放 */}
      <div className="fw-czp-section-title" style={{ marginTop: 10 }}>位置与缩放</div>
      <Slider label="缩放" value={scale} min={50} max={300} step={1} unit="%" onChange={(v) => patch({ scale: v })} />
      <Slider label="水平" value={x}     min={-500} max={500} step={1} unit="px" onChange={(v) => patch({ x: v })} />
      <Slider label="垂直" value={y}     min={-500} max={500} step={1} unit="px" onChange={(v) => patch({ y: v })} />

      {/* 操作按钮 */}
      <div className="fw-czp-actions">
        {(x !== 0 || y !== 0) && (
          <button className="fw-czp-action-btn" onClick={centerAlign}>
            <AlignCenter size={10} /> 居中
          </button>
        )}
        {(hasCrop || hasTransform) && (
          <button className="fw-czp-action-btn" onClick={resetAll}>
            <Maximize2 size={10} /> 全部重置
          </button>
        )}
      </div>
    </div>
  );
}
