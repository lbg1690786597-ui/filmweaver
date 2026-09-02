/**
 * MosaicPanel — 区域马赛克/遮罩编辑器（V2.3）
 *
 * 支持三种效果：像素化马赛克、高斯模糊、纯黑遮挡。
 * 每个镜头可添加多个区域，每个区域独立设置位置/大小/样式/强度。
 * 区域坐标以相对画面比例（0..1）存储，与分辨率无关。
 */

import { useState } from "react";
import { Plus, Trash2, Move } from "lucide-react";
import type { TransformMeta } from "../../api";
import "./MosaicPanel.css";

type MosaicStyle = "pixel" | "gaussblur" | "blackbox";

interface MosaicRegion {
  x: number; y: number; w: number; h: number;
  style: MosaicStyle;
  intensity: number;
}

interface Props {
  shotId: string;
  transform: TransformMeta | null;
  onPatchTransform: (tm: TransformMeta | Record<string, never>) => void;
  onToast: (m: string) => void;
}

/** 预设马赛克区域 */
const PRESETS: { label: string; region: MosaicRegion }[] = [
  { label: "脸部（上方）",  region: { x: 0.35, y: 0.05, w: 0.30, h: 0.28, style: "pixel",     intensity: 60 } },
  { label: "脸部（居中）",  region: { x: 0.35, y: 0.20, w: 0.30, h: 0.28, style: "pixel",     intensity: 60 } },
  { label: "下方字幕区",    region: { x: 0.05, y: 0.82, w: 0.90, h: 0.14, style: "blackbox",   intensity: 80 } },
  { label: "左上角标识",    region: { x: 0.00, y: 0.00, w: 0.25, h: 0.12, style: "gaussblur",  intensity: 70 } },
  { label: "右下角水印",    region: { x: 0.70, y: 0.85, w: 0.28, h: 0.13, style: "pixel",      intensity: 50 } },
  { label: "全画面柔化",    region: { x: 0.00, y: 0.00, w: 1.00, h: 1.00, style: "gaussblur",  intensity: 30 } },
];

const STYLE_LABELS: Record<MosaicStyle, string> = {
  pixel:     "像素化",
  gaussblur: "高斯模糊",
  blackbox:  "纯黑遮挡",
};

const DEFAULT_REGION: MosaicRegion = { x: 0.25, y: 0.25, w: 0.50, h: 0.50, style: "pixel", intensity: 60 };

/** 将 0..1 的比例格式化为百分比显示 */
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 受限数值输入（0..1 比例） */
function PctInput({ label, value, onChange }: {
  label: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="fw-mp-field">
      <span className="fw-mp-field-label">{label}</span>
      <input
        type="number" min={0} max={100} step={1}
        className="fw-mp-num-input"
        value={Math.round(value * 100)}
        onChange={(e) => {
          const n = Math.max(0, Math.min(100, Number(e.target.value)));
          onChange(n / 100);
        }}
      />
      <span className="fw-mp-field-unit">%</span>
    </div>
  );
}

export default function MosaicPanel({ transform, onPatchTransform, onToast }: Props) {
  const mosaics: MosaicRegion[] = (transform?.mosaics as MosaicRegion[] | undefined) ?? [];
  const [expanded, setExpanded] = useState<number | null>(null);

  function save(next: MosaicRegion[]) {
    onPatchTransform({ ...(transform ?? {}), mosaics: next } as TransformMeta);
  }

  function addRegion(preset?: MosaicRegion) {
    const r = preset ? { ...preset } : { ...DEFAULT_REGION };
    const next = [...mosaics, r];
    save(next);
    setExpanded(next.length - 1);
  }

  function removeRegion(idx: number) {
    const next = mosaics.filter((_, i) => i !== idx);
    save(next);
    if (expanded === idx) setExpanded(null);
    else if (expanded !== null && expanded > idx) setExpanded(expanded - 1);
  }

  function patchRegion(idx: number, patch: Partial<MosaicRegion>) {
    const next = mosaics.map((r, i) => i === idx ? { ...r, ...patch } : r);
    save(next);
  }

  return (
    <div className="fw-mp">
      {/* 当前区域列表 */}
      {mosaics.length === 0 && (
        <div className="fw-mp-empty">还没有马赛克区域，选择预设或手动添加</div>
      )}

      {mosaics.map((r, idx) => (
        <div key={idx} className={`fw-mp-region ${expanded === idx ? "open" : ""}`}>
          <button className="fw-mp-region-head" onClick={() => setExpanded(expanded === idx ? null : idx)}>
            <Move size={11} />
            <span className="fw-mp-region-label">
              {STYLE_LABELS[r.style]}　{pct(r.x)},{pct(r.y)} {pct(r.w)}×{pct(r.h)}
            </span>
            <button className="fw-mp-del" onClick={(e) => { e.stopPropagation(); removeRegion(idx); }}>
              <Trash2 size={11} />
            </button>
          </button>

          {expanded === idx && (
            <div className="fw-mp-region-body">
              {/* 样式选择 */}
              <div className="fw-mp-style-row">
                {(["pixel", "gaussblur", "blackbox"] as MosaicStyle[]).map((s) => (
                  <button key={s}
                    className={`fw-mp-style-btn ${r.style === s ? "active" : ""}`}
                    onClick={() => patchRegion(idx, { style: s })}>
                    {STYLE_LABELS[s]}
                  </button>
                ))}
              </div>

              {/* 强度滑块（blackbox 不需要） */}
              {r.style !== "blackbox" && (
                <div className="fw-mp-field">
                  <span className="fw-mp-field-label">强度</span>
                  <input type="range" min={10} max={100} step={5}
                    value={r.intensity}
                    className="fw-mp-slider"
                    onChange={(e) => patchRegion(idx, { intensity: Number(e.target.value) })} />
                  <span className="fw-mp-field-unit">{r.intensity}</span>
                </div>
              )}

              {/* 位置和大小 */}
              <div className="fw-mp-grid2">
                <PctInput label="左边距" value={r.x} onChange={(v) => patchRegion(idx, { x: v })} />
                <PctInput label="上边距" value={r.y} onChange={(v) => patchRegion(idx, { y: v })} />
                <PctInput label="宽度"   value={r.w} onChange={(v) => patchRegion(idx, { w: Math.max(0.01, v) })} />
                <PctInput label="高度"   value={r.h} onChange={(v) => patchRegion(idx, { h: Math.max(0.01, v) })} />
              </div>
            </div>
          )}
        </div>
      ))}

      {/* 预设快捷按钮 */}
      <div className="fw-mp-presets-label">预设</div>
      <div className="fw-mp-presets">
        {PRESETS.map((p) => (
          <button key={p.label} className="fw-mp-preset-btn" onClick={() => addRegion(p.region)}>
            {p.label}
          </button>
        ))}
      </div>

      <button className="fw-mp-add-btn" onClick={() => addRegion()}>
        <Plus size={13} /> 手动添加区域
      </button>

      {mosaics.length > 0 && (
        <button className="fw-mp-clear-btn" onClick={() => { save([]); onToast("已清除所有马赛克区域"); }}>
          清除全部
        </button>
      )}
    </div>
  );
}
