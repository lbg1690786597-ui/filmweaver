/**
 * ExportDialog — 导出对话框（PLAN §20，Phase 6）
 *
 * 两条渲染通道：
 *   本机 ffmpeg（Tauri sidecar）—— 桌面端优先，不占服务器、不上传、可自选参数
 *   服务端 compose        —— 网页预览下的唯一选择，参数固定
 *
 * 网页预览（浏览器）里没有 Tauri API，本机渲染必须**先探测再启用**，
 * 否则点下去直接抛 "Command not found"。
 */

import { useMemo, useState } from "react";
import {
  Download, FolderOpen, Monitor, Cloud, Loader2, Check, AlertTriangle,
} from "lucide-react";
import type { ShotInfo } from "../../api";
import { fmtSec } from "../../types/timeline";
// 画幅→分辨率表抽到 lib/resolutions.ts 共用：一键成片的参数覆写要用同一张表，
// 各存一份必然漂移（这里原本只列了 3 种画幅，而后端 BASE_ASPECTS 支持 6 种，
// 选了 3:4 的项目会静默落到 9:16 的档位上）
import { resListOf } from "../../lib/resolutions";
import "./ExportDialog.css";

/** 是否运行在 Tauri 容器内（网页预览下为 false） */
export const IS_TAURI = typeof window !== "undefined"
  && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

type Channel = "local" | "server";
type Range = "all" | "generated" | "selection";

const FPS_OPTIONS = [24, 25, 30, 60];
const CODECS = [
  { id: "libx264", label: "H.264 (通用兼容)" },
  { id: "libx265", label: "H.265 (体积小，兼容性差)" },
];
const BITRATES = [
  { id: "crf20", label: "高质量 (CRF 20)" },
  { id: "crf23", label: "标准 (CRF 23)" },
  { id: "crf28", label: "小体积 (CRF 28)" },
];

interface Props {
  shots: ShotInfo[];
  baseAspect: string;
  projectTitle: string;
  selectedShotIds: string[];
  /** 服务端拼接。TB-12：编码参数由对话框决定 */
  onServerExport: (opts: {
    width: number; height: number; fps: number;
    vcodec: string; crf: number; withAudio: boolean;
  }) => void;
  serverBusy: boolean;
  serverProgress: number;
  /** 本机渲染 */
  onLocalExport: (opts: {
    clips: ShotInfo[]; width: number; height: number; fps: number;
    vcodec: string; crf: number; withAudio: boolean;
    scope: "generated" | "all" | "selection";
  }) => void;
  localBusy: boolean;
  localProgress: { pct: number; stage: string } | null;
  /** 中断本机渲染（服务端 job 不支持中断，故仅本机通道显示） */
  onCancel?: () => void;
  onClose: () => void;
}

export default function ExportDialog(p: Props) {
  const [channel, setChannel] = useState<Channel>(IS_TAURI ? "local" : "server");
  const [range, setRange] = useState<Range>("generated");
  const [resIdx, setResIdx] = useState(0);
  const [fps, setFps] = useState(30);
  const [codec, setCodec] = useState("libx264");
  const [bitrate, setBitrate] = useState("crf20");
  const [withAudio, setWithAudio] = useState(true);
  const [name, setName] = useState(
    () => `${p.projectTitle || "film"}_${new Date().toISOString().slice(0, 10)}`);

  const resList = resListOf(p.baseAspect);
  const res = resList[Math.min(resIdx, resList.length - 1)];

  const clips = useMemo(() => {
    const sorted = [...p.shots].sort((a, b) => a.order - b.order);
    if (range === "selection") {
      return sorted.filter((s) => p.selectedShotIds.includes(s.id) && s.video_url);
    }
    if (range === "generated") return sorted.filter((s) => s.video_url && !s.disabled);
    return sorted.filter((s) => !s.disabled);
  }, [p.shots, range, p.selectedShotIds]);

  const totalSec = clips.reduce((a, s) => a + (s.duration_sec ?? 5), 0);
  const missing = clips.filter((s) => !s.video_url).length;
  const busy = p.serverBusy || p.localBusy;

  const doExport = () => {
    if (!clips.length) return;
    const crfNum = { crf20: 20, crf23: 23, crf28: 28 }[bitrate] ?? 20;
    if (channel === "local") {
      // Render V2：编码参数与服务端通道对齐（分段器已让大项目可行）
      p.onLocalExport({
        clips, width: res.w, height: res.h, fps,
        vcodec: codec, crf: crfNum, withAudio, scope: range,
      });
    } else {
      p.onServerExport({
        width: res.w, height: res.h, fps,
        vcodec: codec, crf: crfNum, withAudio,
      });
    }
  };

  return (
    <div className="fw-ex-mask" onClick={busy ? undefined : p.onClose}>
      <div className="fw-ex" onClick={(e) => e.stopPropagation()}>
        <header className="fw-ex-head">
          <Download size={16} />
          <span>导出成片</span>
          {!busy && <button className="fw-ex-close" onClick={p.onClose}>×</button>}
        </header>

        <div className="fw-ex-body">
          {/* ---- 渲染通道 ---- */}
          <Section title="渲染方式">
            <div className="fw-ex-channels">
              <button className={`fw-ex-channel ${channel === "local" ? "on" : ""}`}
                disabled={!IS_TAURI || busy}
                onClick={() => setChannel("local")}
                title={IS_TAURI ? "用本机 ffmpeg 渲染，不占服务器"
                  : "网页预览下不可用，请使用桌面版"}>
                <Monitor size={15} />
                <span className="fw-ex-channel-name">本机渲染</span>
                <span className="fw-ex-channel-desc">
                  {IS_TAURI ? "多轨合成 · 转场 · 硬件编码" : "需桌面版"}
                </span>
              </button>
              <button className={`fw-ex-channel ${channel === "server" ? "on" : ""}`}
                disabled={busy}
                onClick={() => setChannel("server")}>
                <Cloud size={15} />
                <span className="fw-ex-channel-name">服务端拼接</span>
                <span className="fw-ex-channel-desc">快速输出，单轨顺序拼接</span>
              </button>
            </div>
            {!IS_TAURI && (
              <div className="fw-ex-note">
                <AlertTriangle size={11} />
                网页预览环境无法调用本机 ffmpeg，已自动选择服务端拼接
              </div>
            )}
          </Section>

          {/* ---- 输出范围 ---- */}
          <Section title="输出范围">
            <div className="fw-ex-ranges">
              <RangeBtn on={range === "generated"} onClick={() => setRange("generated")}
                label="已生成镜头"
                n={p.shots.filter((s) => s.video_url && !s.disabled).length} />
              <RangeBtn on={range === "all"} onClick={() => setRange("all")}
                label="全部启用镜头"
                n={p.shots.filter((s) => !s.disabled).length} />
              <RangeBtn on={range === "selection"} onClick={() => setRange("selection")}
                label="仅选中"
                n={p.selectedShotIds.length}
                disabled={!p.selectedShotIds.length} />
            </div>
            <div className="fw-ex-summary">
              {clips.length} 段 · {fmtSec(totalSec)}
              {missing > 0 && (
                <span className="fw-ex-warn"> · {missing} 段未生成，将被跳过</span>
              )}
            </div>
          </Section>

          {/* ---- 文件 ---- */}
          <Section title="文件">
            <Field label="文件名">
              <input className="fw-ex-input" value={name}
                onChange={(e) => setName(e.target.value)} spellCheck={false} />
              <span className="fw-ex-ext">.mp4</span>
            </Field>
            <Field label="保存位置">
              <span className="fw-ex-path">
                <FolderOpen size={11} />
                {channel === "local" ? "导出时选择" : "服务器生成后下载"}
              </span>
            </Field>
          </Section>

          {/* ---- 编码参数（本机渲染才可调）---- */}
          <Section title="编码参数">
            <Field label="分辨率">
              <select className="fw-ex-select" value={resIdx}
                onChange={(e) => setResIdx(Number(e.target.value))}>
                {resList.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
              </select>
            </Field>
            <Field label="帧率">
              <select className="fw-ex-select" value={fps}
                onChange={(e) => setFps(Number(e.target.value))}>
                {FPS_OPTIONS.map((f) => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </Field>
            <Field label="编码">
              <select className="fw-ex-select" value={codec}
                onChange={(e) => setCodec(e.target.value)}>
                {CODECS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="码率">
              <select className="fw-ex-select" value={bitrate}
                onChange={(e) => setBitrate(e.target.value)}>
                {BITRATES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </Field>
            <Field label="包含音频">
              <button className={`fw-ex-switch ${withAudio ? "on" : ""}`}
                onClick={() => setWithAudio((v) => !v)}>
                {withAudio ? "开" : "关"}
              </button>
            </Field>
            {channel === "local" && (
              <div className="fw-ex-note">
                本机渲染使用 Render Engine V2（分段合成），支持多轨、转场与画面调整；
                有可用硬件编码器时自动启用
              </div>
            )}
          </Section>
        </div>

        {/* ---- 底部：进度 + 动作 ---- */}
        <footer className="fw-ex-foot">
          {busy ? (
            <div className="fw-ex-progress">
              <Loader2 size={13} className="fw-spin" />
              <span className="fw-ex-progress-label">
                {p.localProgress
                  ? `${p.localProgress.stage} ${p.localProgress.pct}%`
                  : `服务端拼接中 ${p.serverProgress}%`}
              </span>
              <div className="fw-ex-progress-bar">
                <div style={{ width: `${p.localProgress?.pct ?? p.serverProgress}%` }} />
              </div>
              {/* 本机渲染可中断——大项目要跑几十分钟，没有取消等于卡死软件 */}
              {p.localBusy && p.onCancel && (
                <button className="fw-ex-btn" onClick={p.onCancel}>取消</button>
              )}
            </div>
          ) : (
            <>
              <span className="fw-ex-foot-info">
                {clips.length ? `将导出 ${clips.length} 段 · ${fmtSec(totalSec)}` : "没有可导出的镜头"}
              </span>
              <button className="fw-ex-btn" onClick={p.onClose}>取消</button>
              <button className="fw-ex-btn primary" disabled={!clips.length} onClick={doExport}>
                <Check size={13} /> 开始导出
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/* ---- 内部小组件 ---- */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="fw-ex-sec">
      <div className="fw-ex-sec-title">{title}</div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fw-ex-field">
      <span className="fw-ex-label">{label}</span>
      <span className="fw-ex-control">{children}</span>
    </div>
  );
}

function RangeBtn({ on, label, n, disabled, onClick }: {
  on: boolean; label: string; n: number; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button className={`fw-ex-range ${on ? "on" : ""}`} disabled={disabled} onClick={onClick}>
      {label}<span className="fw-ex-range-n">{n}</span>
    </button>
  );
}
