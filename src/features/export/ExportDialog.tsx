/**
 * ExportDialog — 导出对话框（PLAN §20，Phase 6）
 *
 * **只有一条渲染通道：本机 ffmpeg（Tauri sidecar）。**
 *
 * 服务端 compose 于 2026-08-30 整体下线。它只做单轨顺序拼接——不混音频轨、
 * 不渲染转场、不合成叠加层、字幕烧录写死 FontSize=18。产物与本机渲染差得
 * 不是一点半点，却同样叫"成片"，用户拿它当验收依据就会误判生成环节坏了。
 *
 * 网页预览（浏览器）里没有 Tauri API，因此**不提供导出**——网页版只给
 * 技术人员开发测试用，不是用户入口。
 */

import { useMemo, useState } from "react";
import {
  Download, FolderOpen, Monitor, Loader2, Check, AlertTriangle,
} from "lucide-react";
import type { ShotInfo } from "../../api";
import { fmtSec } from "../../types/timeline";
// 画幅→分辨率表抽到 lib/resolutions.ts 共用：一键成片的参数覆写要用同一张表，
// 各存一份必然漂移（这里原本只列了 3 种画幅，而后端 BASE_ASPECTS 支持 6 种，
// 选了 3:4 的项目会静默落到 9:16 的档位上）
import { resListOf } from "../../lib/resolutions";
import { safeFileName, pad2, episodeFileName } from "../../lib/filename";
import "./ExportDialog.css";

/** 是否运行在 Tauri 容器内（网页预览下为 false） */
export const IS_TAURI = typeof window !== "undefined"
  && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/**
 * 输出范围。前三档决定"取哪些镜头拼成一个文件"；`episode` 是另一种形态——
 * **按集拆分，一集一个文件**。
 *
 * 为什么必须有它：现网项目动辄 50-64 集（9301 项目 64 集 / 601 镜 / 103 分钟），
 * 整部一次导出就是一个 1.7 小时的单文件，渲染要跑很久，产物也没法按集分发。
 */
type Range = "all" | "generated" | "selection" | "episode";

/** 按集统计（导出对话框自己从镜头推，不额外依赖 ProjectDetail.episodes） */
interface EpStat {
  order: number;
  ready: number;      // 已出片且未停用
  total: number;      // 未停用
  sec: number;        // 已出片镜头的时长合计
}

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
  /** 集号 → 集标题（来自 ProjectDetail.episodes）。缺失只影响文件名后缀，不影响导出 */
  episodeTitles?: Record<number, string>;
  /** 已选好的导出目录（null = 还没选过）。由 App 持有并记忆到 localStorage */
  exportDir: string | null;
  /**
   * 在对话框里当场选导出位置。
   *
   * 两种模式刻意不同：
   *  · file —— 单文件导出走**系统保存对话框**。它自带「同名文件已存在，是否替换」
   *    的原生提示，而我们没法自己做这个检查（fs 权限被限死在 $APPDATA，
   *    拿不到任意路径的 exists()）。顺带把用户在对话框里改的文件名回填。
   *  · dir  —— 按集导出产出一批文件，只能选文件夹。
   *
   * 返回 null 表示用户取消（保持原选择不变）。
   */
  onPickPath: (mode: "file" | "dir", suggestName: string)
    => Promise<{ dir: string; name?: string } | null>;
  /** 本机渲染 */
  onLocalExport: (opts: {
    clips: ShotInfo[]; width: number; height: number; fps: number;
    vcodec: string; crf: number; withAudio: boolean;
    scope: "generated" | "all" | "selection" | "episode";
    /** 用户在对话框里填的文件名（不含扩展名）；缺省时由调用方兜底。
     *  scope=episode 时它是**前缀**，实际文件名再拼上「_第NN集_标题」 */
    name?: string;
    /** 已在对话框里选好的目录；缺省时由调用方临时弹选择器兜底 */
    dir?: string;
    /** scope=episode 时要导的集号（升序）；每集单独渲染成一个文件 */
    episodes?: number[];
  }) => void;
  localBusy: boolean;
  localProgress: { pct: number; stage: string; etaSec?: number } | null;
  /** 导出成功后的结果；非空时弹窗原地切成"已完成"面板（对齐剪映的导出结果页） */
  localResult: {
    path: string; segments: number; encoder: string; elapsedMs: number;
    /** 按集导出时产出的文件数（>1 时"打开所在文件夹"落在整个目录上） */
    files?: number;
  } | null;
  /** 在系统文件管理器里选中成片 */
  onReveal: (path: string) => void;
  /** 回到参数页再导一次（换个分辨率/范围重导是常见操作） */
  onResetResult: () => void;
  /** 中断本机渲染——大项目要跑几十分钟，没有取消等于卡死软件 */
  onCancel?: () => void;
  onClose: () => void;
}

/** 秒 → "约 3 分 20 秒"。导出动辄几十分钟，纯秒数读起来没概念。 */
function fmtEta(sec: number): string {
  if (sec < 60) return `约 ${Math.max(1, sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `约 ${m} 分 ${s} 秒` : `约 ${m} 分钟`;
  return `约 ${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export default function ExportDialog(p: Props) {
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

  /** 按集统计。集号取自 Shot.episode（拆解时写入），缺省视作第 1 集。 */
  const epStats = useMemo<EpStat[]>(() => {
    const m = new Map<number, EpStat>();
    for (const s of p.shots) {
      if (s.disabled) continue;
      const e = s.episode ?? 1;
      const r = m.get(e) ?? { order: e, ready: 0, total: 0, sec: 0 };
      r.total += 1;
      if (s.video_url) { r.ready += 1; r.sec += s.duration_sec ?? 5; }
      m.set(e, r);
    }
    return [...m.values()].sort((a, b) => a.order - b.order);
  }, [p.shots]);

  /** 勾选的集号。null = 用户还没动过 → 默认全选"有已出片镜头"的集
   *  （没画面的集导出来是个空文件）。空数组是合法状态（用户主动清空）。 */
  const [selEps, setSelEps] = useState<number[] | null>(null);
  const pickedEps = useMemo(() => {
    const avail = epStats.filter((e) => e.ready > 0).map((e) => e.order);
    if (selEps === null) return avail;
    const ok = new Set(avail);
    return selEps.filter((e) => ok.has(e)).sort((a, b) => a - b);
  }, [selEps, epStats]);
  const toggleEp = (order: number) => setSelEps(
    pickedEps.includes(order)
      ? pickedEps.filter((e) => e !== order)
      : [...pickedEps, order].sort((a, b) => a - b));

  const clips = useMemo(() => {
    const sorted = [...p.shots].sort((a, b) => a.order - b.order);
    if (range === "selection") {
      return sorted.filter((s) => p.selectedShotIds.includes(s.id) && s.video_url);
    }
    if (range === "episode") {
      const want = new Set(pickedEps);
      return sorted.filter((s) => !s.disabled && s.video_url
        && want.has(s.episode ?? 1));
    }
    if (range === "generated") return sorted.filter((s) => s.video_url && !s.disabled);
    return sorted.filter((s) => !s.disabled);
  }, [p.shots, range, p.selectedShotIds, pickedEps]);

  const totalSec = clips.reduce((a, s) => a + (s.duration_sec ?? 5), 0);
  const missing = clips.filter((s) => !s.video_url).length;
  const busy = p.localBusy;
  const done = p.localResult;
  const byEpisode = range === "episode";
  const fileCount = byEpisode ? pickedEps.length : 1;

  /** 在对话框里当场选位置。单文件模式会把用户改的文件名一并回填。 */
  const pickPath = async () => {
    const got = await p.onPickPath(byEpisode ? "dir" : "file",
      safeFileName(name.trim() || p.projectTitle || "film", 60) || "film");
    if (got?.name) setName(got.name);
  };

  /** 首个产出文件的完整路径。必须和 App 里真正拼路径的规则**同一套**
   *  （共用 episodeFileName），否则预览会骗人。 */
  const previewPath = useMemo(() => {
    if (!p.exportDir) return "";
    const sep = p.exportDir.includes("\\") ? "\\" : "/";
    const base = safeFileName(name.trim() || p.projectTitle || "film", 60) || "film";
    const file = byEpisode
      ? episodeFileName(base, pickedEps[0] ?? 1, p.episodeTitles?.[pickedEps[0] ?? 1])
      : `${base}.mp4`;
    return `${p.exportDir}${p.exportDir.endsWith(sep) ? "" : sep}${file}`;
  }, [p.exportDir, p.episodeTitles, p.projectTitle, name, byEpisode, pickedEps]);

  const doExport = () => {
    if (!clips.length || !IS_TAURI) return;
    if (byEpisode && !pickedEps.length) return;
    const crfNum = { crf20: 20, crf23: 23, crf28: 28 }[bitrate] ?? 20;
    p.onLocalExport({
      clips, width: res.w, height: res.h, fps,
      vcodec: codec, crf: crfNum, withAudio, scope: range,
      // 文件名输入框此前完全没接线：用户改完名字点导出，
      // 系统保存对话框里仍然是「项目名_日期」的默认值。
      name: name.trim() || undefined,
      // 已在对话框里选好位置就直接用；没选过则由 App 在导出前兜底弹一次
      dir: p.exportDir ?? undefined,
      episodes: byEpisode ? pickedEps : undefined,
    });
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
          {done && (
            <div className="fw-ex-done">
              <Check size={14} />
              <div>
                <div className="fw-ex-done-title">导出完成</div>
                <div className="fw-ex-done-path" title={done.path}>{done.path}</div>
              </div>
            </div>
          )}

          {/* ---- 渲染方式（只剩本机一条）---- */}
          <Section title="渲染方式">
            <div className="fw-ex-channels">
              <button className="fw-ex-channel on" disabled>
                <Monitor size={15} />
                <span className="fw-ex-channel-name">本机渲染</span>
                <span className="fw-ex-channel-desc">多轨合成 · 转场 · 字幕 · 硬件编码</span>
              </button>
            </div>
            {!IS_TAURI && (
              <div className="fw-ex-note">
                <AlertTriangle size={11} />
                网页预览环境无法调用本机 ffmpeg，导出请使用桌面版
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
              {/* 按集：与前三档不同，它产出**多个**文件（一集一个） */}
              <RangeBtn on={byEpisode} onClick={() => setRange("episode")}
                label="按集导出" n={epStats.length}
                disabled={epStats.length < 1} />
            </div>

            {byEpisode ? (
              <>
                <div className="fw-ex-eps-bar">
                  <span>选择要导出的集（每集一个文件）</span>
                  <button className="fw-ex-linkbtn"
                    onClick={() => setSelEps(null)}>全选</button>
                  <button className="fw-ex-linkbtn"
                    onClick={() => setSelEps([])}>清空</button>
                </div>
                <div className="fw-ex-eps">
                  {epStats.map((e) => (
                    <button key={e.order}
                      className={`fw-ex-ep ${pickedEps.includes(e.order) ? "on" : ""}`}
                      disabled={e.ready === 0}
                      title={e.ready === 0
                        ? `第 ${e.order} 集还没有已生成的镜头`
                        : `${p.episodeTitles?.[e.order] ?? ""} ${e.ready}/${e.total} 段 · ${fmtSec(e.sec)}`.trim()}
                      onClick={() => toggleEp(e.order)}>
                      <span className="fw-ex-ep-n">第 {e.order} 集</span>
                      <span className="fw-ex-ep-meta">
                        {e.ready === 0 ? "无画面" : `${e.ready} 段 · ${fmtSec(e.sec)}`}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="fw-ex-summary">
                  {pickedEps.length
                    ? <>已选 {pickedEps.length} 集 · 共 {clips.length} 段 ·{" "}
                      {fmtSec(totalSec)} · 产出 <b>{fileCount}</b> 个文件</>
                    : <span className="fw-ex-warn">未选择任何集</span>}
                </div>
              </>
            ) : (
              <div className="fw-ex-summary">
                {clips.length} 段 · {fmtSec(totalSec)}
                {missing > 0 && (
                  <span className="fw-ex-warn"> · {missing} 段未生成，将被跳过</span>
                )}
              </div>
            )}
          </Section>

          {/* ---- 文件 ---- */}
          <Section title="文件">
            <Field label={byEpisode ? "文件名前缀" : "文件名"}>
              <input className="fw-ex-input" value={name}
                onChange={(e) => setName(e.target.value)} spellCheck={false} />
              <span className="fw-ex-ext">
                {byEpisode ? `_第${pad2(pickedEps[0] ?? 1)}集.mp4` : ".mp4"}
              </span>
            </Field>
            <Field label="保存位置">
              <button className="fw-ex-dir" onClick={pickPath} disabled={!IS_TAURI}
                title={p.exportDir ?? "点击选择导出位置"}>
                <FolderOpen size={11} />
                <span className="fw-ex-dir-path">
                  {p.exportDir ?? (IS_TAURI ? "点击选择…" : "需桌面版")}
                </span>
                <span className="fw-ex-dir-act">选择…</span>
              </button>
            </Field>
            {/* 完整路径预览：选完位置后用户最想确认的就是"到底写到哪个文件"。
                按集导出给第一个文件 + 总数，不铺 64 行。 */}
            {p.exportDir && (
              <div className="fw-ex-preview" title={previewPath}>
                <span className="fw-ex-preview-path">{previewPath}</span>
                {byEpisode && pickedEps.length > 1
                  && <span className="fw-ex-preview-more">等 {pickedEps.length} 个文件</span>}
              </div>
            )}
          </Section>

          {/* ---- 编码参数 ---- */}
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
            <div className="fw-ex-note">
              本机渲染使用 Render Engine V2（分段合成），支持多轨、转场、字幕烧录
              与画面调整；有可用硬件编码器时自动启用
            </div>
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
                  : "准备中"}
                {/* 剩余时间：几十分钟的渲染里，只给百分比等于不告诉用户还要等多久 */}
                {p.localProgress?.etaSec != null && (
                  <span className="fw-ex-eta">剩余 {fmtEta(p.localProgress.etaSec)}</span>
                )}
              </span>
              <div className="fw-ex-progress-bar">
                <div style={{ width: `${p.localProgress?.pct ?? 0}%` }} />
              </div>
              {p.onCancel && (
                <button className="fw-ex-btn" onClick={p.onCancel}>取消</button>
              )}
            </div>
          ) : done ? (
            <>
              <span className="fw-ex-foot-info done">
                <Check size={13} /> 已导出{done.files && done.files > 1
                  ? ` ${done.files} 个文件` : ""} · {done.segments} 段 ·{" "}
                {(done.elapsedMs / 1000).toFixed(0)}s · {done.encoder}
              </span>
              <button className="fw-ex-btn" onClick={p.onResetResult}>再导一次</button>
              <button className="fw-ex-btn primary" onClick={() => p.onReveal(done.path)}>
                <FolderOpen size={13} /> 打开所在文件夹
              </button>
            </>
          ) : (
            <>
              <span className="fw-ex-foot-info">
                {!clips.length ? "没有可导出的镜头"
                  : byEpisode
                    ? `将导出 ${pickedEps.length} 集 → ${fileCount} 个文件 · 共 ${fmtSec(totalSec)}`
                    : `将导出 ${clips.length} 段 · ${fmtSec(totalSec)}`}
              </span>
              <button className="fw-ex-btn" onClick={p.onClose}>取消</button>
              <button className="fw-ex-btn primary"
                disabled={!clips.length || !IS_TAURI || (byEpisode && !pickedEps.length)}
                title={IS_TAURI ? undefined : "导出需使用桌面版"}
                onClick={doExport}>
                <Check size={13} /> {IS_TAURI
                  ? (byEpisode ? `导出 ${fileCount} 集` : "开始导出") : "需桌面版"}
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
