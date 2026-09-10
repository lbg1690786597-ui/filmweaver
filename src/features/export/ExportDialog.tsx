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
import {
  safeFileName, pad2, pad3, episodeFileName, clipFileName,
} from "../../lib/filename";
import { planClipJobs, planPickedClipJobs } from "./exportRun";
import { IS_TAURI } from "../../lib/isTauri";
import "./ExportDialog.css";

/** 是否运行在 Tauri 容器内（网页预览下为 false）。
 *
 *  6.2 起判据搬到了 `lib/isTauri.ts`：本文件 `import "./ExportDialog.css"`，
 *  非 UI 模块（预取接线）只为问一句"在不在桌面端"就得把整个导出对话框
 *  连同它的 CSS 一起拖进依赖图。这里 re-export，保持既有 7 个 import 一行不改。 */
export { IS_TAURI };

/**
 * 输出范围。前两档决定"取哪些镜头拼成**一个**文件"；后两档是另一种形态——
 * **拆分成多个文件**：`episode` 一集一个，`clip` 一个镜头一个。
 *
 * 为什么要按集：现网项目动辄 50-64 集（9301 项目 64 集 / 601 镜 / 103 分钟），
 * 整部一次导出就是一个 1.7 小时的单文件，渲染要跑很久，产物也没法按集分发。
 *
 * 为什么要按片段（2026-09-09 用户需求）：单个镜头是投流/送审/二次剪辑的最小
 * 交付单位，此前只能整部或整集导出，用户得自己再切一遍。它**替换掉**了旧的
 * 「仅选中」档——把选中的几段拼成一个文件几乎没人用。
 *
 * 要导哪些片段**在这个对话框里勾**（与按集导出同一套交互），而不是去读时间轴
 * 上的选中态：时间轴一次只能选一个片段，"选中即范围"实际等于只能一个一个导；
 * 而且用户点开导出对话框时看不见轨道，无从知道自己"选中"了什么。
 */
type Range = "all" | "generated" | "episode" | "clip";

/** 按集统计（导出对话框自己从镜头推，不额外依赖 ProjectDetail.episodes） */
interface EpStat {
  order: number;
  ready: number;      // 已出片且未停用
  total: number;      // 未停用
  sec: number;        // 已出片镜头的时长合计
}

const FPS_OPTIONS = [24, 25, 30, 60];
// 4.4 起这个选择**真的生效**了（此前 plan.output.vcodec 无人读取，选 H.265
// 拿到的一直是 H.264）。随之而来的代价必须写在标签上：没有 HEVC 硬件编码的
// 机器会真的走 libx265 软件编码，比硬件 H.264 慢一个数量级。
const CODECS = [
  { id: "libx264", label: "H.264 (通用兼容)" },
  { id: "libx265", label: "H.265 (体积小，兼容性差，无硬件加速时较慢)" },
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
    scope: "generated" | "all" | "selection" | "episode" | "clip";
    /** 用户在对话框里填的文件名（不含扩展名）；缺省时由调用方兜底。
     *  scope=episode 时它是**前缀**，实际文件名再拼上「_第NN集_标题」；
     *  scope=clip 时同为前缀，再拼上「_第NN集_镜NNN」 */
    name?: string;
    /** 已在对话框里选好的目录；缺省时由调用方临时弹选择器兜底 */
    dir?: string;
    /** scope=episode 时要导的集号（升序）；每集单独渲染成一个文件 */
    episodes?: number[];
    /** scope=clip 时要导的镜头 id（剧情顺序）；每个镜头单独渲染成一个文件。
     *  由用户在对话框里勾选，不再读时间轴选中态。 */
    clipIds?: string[];
  }) => void;
  localBusy: boolean;
  localProgress: { pct: number; stage: string; etaSec?: number } | null;
  /** 导出成功后的结果；非空时弹窗原地切成"已完成"面板（对齐剪映的导出结果页） */
  localResult: {
    path: string; segments: number; encoder: string; elapsedMs: number;
    /** 按集导出时产出的文件数（>1 时"打开所在文件夹"落在整个目录上） */
    files?: number;
    /**
     * 失败的文件数（6.0）。>0 时面板标题必须说「部分完成」——
     * 一批里少了几个文件，在文件管理器里是看不出来的，用户只会以为导全了。
     */
    failed?: number;
    /**
     * 降级提示（5.8）：导出**成功**了，但有东西没按用户设置的样子出来。
     * 放在结果面板而不是 toast —— 见 ExportDialog.css 的 `.fw-ex-notices`。
     * 6.0 起也承载"哪一集失败、为什么"（同理：toast 装不下，也留不住）。
     */
    notices?: string[];
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

  /** 可导出的片段（已出片、未停用），剧情顺序。
   *  与 App 里真正排 job 的地方共用 planClipJobs——各写一份筛选条件，
   *  对话框显示的"要产出几个文件"和实际落盘的数量迟早对不上。 */
  const clipCands = useMemo(
    () => planClipJobs([...p.shots].sort((a, b) => a.order - b.order)),
    [p.shots]);

  /** 勾选的片段 id。null = 用户还没动过 → 默认全选（与按集导出一致）。
   *  空数组是合法状态（用户主动清空），此时**不产出任何文件**，
   *  不能退化成 planClipJobs 的"空 = 全部"。 */
  const [selClips, setSelClips] = useState<string[] | null>(null);
  const pickedClipIds = useMemo(() => {
    const avail = clipCands.map((j) => j.shot.id);
    if (selClips === null) return avail;
    const want = new Set(selClips);
    return avail.filter((id) => want.has(id));   // 按 avail 的顺序 = 剧情顺序
  }, [selClips, clipCands]);
  const pickedClipSet = useMemo(() => new Set(pickedClipIds), [pickedClipIds]);
  const toggleClip = (id: string) => setSelClips(
    pickedClipSet.has(id)
      ? pickedClipIds.filter((x) => x !== id)
      : [...pickedClipIds, id]);

  /** 片段按集分组：一部剧动辄 600 镜，平铺成一片小方块没法找。
   *  每组给一个「本集全选/取消」的行首按钮。 */
  const clipGroups = useMemo(() => {
    const m = new Map<number, typeof clipCands>();
    for (const j of clipCands) {
      const arr = m.get(j.episode);
      if (arr) arr.push(j); else m.set(j.episode, [j]);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0])
      .map(([order, jobs]) => ({ order, jobs }));
  }, [clipCands]);
  const toggleEpClips = (order: number) => {
    const ids = clipGroups.find((g) => g.order === order)?.jobs
      .map((j) => j.shot.id) ?? [];
    const allOn = ids.length > 0 && ids.every((id) => pickedClipSet.has(id));
    setSelClips(allOn
      ? pickedClipIds.filter((id) => !ids.includes(id))
      : [...pickedClipIds, ...ids.filter((id) => !pickedClipSet.has(id))]);
  };

  const clips = useMemo(() => {
    const sorted = [...p.shots].sort((a, b) => a.order - b.order);
    if (range === "clip") {
      // planPickedClipJobs 而不是 planClipJobs：后者把"空 id 列表"当作"全部"，
      // 用户主动清空勾选反而会导出 601 个文件。
      return planPickedClipJobs(sorted, pickedClipIds).map((j) => j.shot);
    }
    if (range === "episode") {
      const want = new Set(pickedEps);
      return sorted.filter((s) => !s.disabled && s.video_url
        && want.has(s.episode ?? 1));
    }
    if (range === "generated") return sorted.filter((s) => s.video_url && !s.disabled);
    return sorted.filter((s) => !s.disabled);
  }, [p.shots, range, pickedClipIds, pickedEps]);

  const totalSec = clips.reduce((a, s) => a + (s.duration_sec ?? 5), 0);
  const missing = clips.filter((s) => !s.video_url).length;
  const busy = p.localBusy;
  const done = p.localResult;
  const byEpisode = range === "episode";
  const byClip = range === "clip";
  /** 一次导出会产出几个文件。按片段 = 片段数（一镜一文件） */
  const multiFile = byEpisode || byClip;
  const fileCount = byEpisode ? pickedEps.length : byClip ? clips.length : 1;

  /** 在对话框里当场选位置。单文件模式会把用户改的文件名一并回填。 */
  const pickPath = async () => {
    const got = await p.onPickPath(multiFile ? "dir" : "file",
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
      : byClip
        ? clipFileName(base, clips[0]?.order ?? 1, clips[0]?.episode ?? 1)
        : `${base}.mp4`;
    return `${p.exportDir}${p.exportDir.endsWith(sep) ? "" : sep}${file}`;
  }, [p.exportDir, p.episodeTitles, p.projectTitle, name, byEpisode, byClip,
      pickedEps, clips]);

  const doExport = () => {
    if (!clips.length || !IS_TAURI) return;
    if (byEpisode && !pickedEps.length) return;
    if (byClip && !pickedClipIds.length) return;
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
      clipIds: byClip ? pickedClipIds : undefined,
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
                <div className="fw-ex-done-title">
                  {done.failed
                    ? `部分完成 · ${done.files ?? 1} 个成功，${done.failed} 个失败`
                    : "导出完成"}
                </div>
                <div className="fw-ex-done-path" title={done.path}>{done.path}</div>
              </div>
            </div>
          )}

          {done && !!done.notices?.length && (
            <div className="fw-ex-notices">
              {done.notices.map((n) => (
                <div className="fw-ex-notice" key={n}>{n}</div>
              ))}
            </div>
          )}

          {/* ---- 渲染方式（只剩本机一条）---- */}
          <Section title="渲染方式">
            <div className="fw-ex-channels">
              <button className="fw-ex-channel on" disabled>
                <Monitor size={15} />
                <span className="fw-ex-channel-name">在这台电脑上导出</span>
                <span className="fw-ex-channel-desc">画面、转场、字幕、配音一次合成</span>
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
              {/* 按集 / 按片段：与前两档不同，它们产出**多个**文件 */}
              <RangeBtn on={byEpisode} onClick={() => setRange("episode")}
                label="按集导出" n={epStats.length}
                disabled={epStats.length < 1} />
              {/* 按片段替换了旧的「仅选中」：要导哪些片段在下面勾，
                  与按集导出同一套交互（不读时间轴选中态）。 */}
              <RangeBtn on={byClip} onClick={() => setRange("clip")}
                label="按片段导出"
                n={clipCands.length}
                disabled={!clipCands.length} />
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
            ) : byClip ? (
              <>
                <div className="fw-ex-eps-bar">
                  <span>选择要导出的片段（每片段一个文件）</span>
                  <button className="fw-ex-linkbtn"
                    onClick={() => setSelClips(null)}>全选</button>
                  <button className="fw-ex-linkbtn"
                    onClick={() => setSelClips([])}>清空</button>
                </div>
                {clipCands.length ? (
                  <div className="fw-ex-clips">
                    {clipGroups.map((g) => {
                      const on = g.jobs.filter((j) => pickedClipSet.has(j.shot.id)).length;
                      return (
                        <div className="fw-ex-clip-grp" key={g.order}>
                          <button className="fw-ex-clip-ep"
                            title={`第 ${g.order} 集：${on}/${g.jobs.length} 段已勾选`}
                            onClick={() => toggleEpClips(g.order)}>
                            第 {g.order} 集
                            <span className="fw-ex-clip-ep-n">{on}/{g.jobs.length}</span>
                          </button>
                          <div className="fw-ex-clip-row">
                            {g.jobs.map((j) => (
                              <button key={j.shot.id}
                                className={`fw-ex-clip ${pickedClipSet.has(j.shot.id) ? "on" : ""}`}
                                title={`${j.shot.script_ref ?? ""} · ${fmtSec(j.shot.duration_sec ?? 5)}`.trim()}
                                onClick={() => toggleClip(j.shot.id)}>
                                镜{pad3(j.order)}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                <div className="fw-ex-summary">
                  {clips.length
                    ? <>已选 {clips.length} 段 · {fmtSec(totalSec)} ·{" "}
                      产出 <b>{fileCount}</b> 个文件
                      <span className="fw-ex-hint">
                        {" "}· 一个镜头一个文件
                      </span></>
                    : clipCands.length
                      ? <span className="fw-ex-warn">未选择任何片段</span>
                      : <span className="fw-ex-warn">没有已生成的片段可导出</span>}
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
            <Field label={multiFile ? "文件名前缀" : "文件名"}>
              <input className="fw-ex-input" value={name}
                onChange={(e) => setName(e.target.value)} spellCheck={false} />
              <span className="fw-ex-ext">
                {byEpisode ? `_第${pad2(pickedEps[0] ?? 1)}集.mp4`
                  : byClip ? `_第${pad2(clips[0]?.episode ?? 1)}集_镜${pad3(clips[0]?.order ?? 1)}.mp4`
                    : ".mp4"}
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
                {multiFile && fileCount > 1
                  && <span className="fw-ex-preview-more">等 {fileCount} 个文件</span>}
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
              与画面调整；有可用硬件编码器时自动启用（会优先选与上面「编码」
              同格式的那个，实际用到的编码器名会在导出完成时显示）
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
                {!clips.length
                  ? (byClip && clipCands.length ? "未选择任何片段" : "没有可导出的镜头")
                  : byEpisode
                    ? `将导出 ${pickedEps.length} 集 → ${fileCount} 个文件 · 共 ${fmtSec(totalSec)}`
                    : byClip
                      ? `将导出 ${fileCount} 个片段文件 · 共 ${fmtSec(totalSec)}`
                      : `将导出 ${clips.length} 段 · ${fmtSec(totalSec)}`}
              </span>
              <button className="fw-ex-btn" onClick={p.onClose}>取消</button>
              <button className="fw-ex-btn primary"
                disabled={!clips.length || !IS_TAURI || (byEpisode && !pickedEps.length)}
                title={IS_TAURI ? undefined : "导出需使用桌面版"}
                onClick={doExport}>
                <Check size={13} /> {IS_TAURI
                  ? (byEpisode ? `导出 ${fileCount} 集`
                    : byClip ? `导出 ${fileCount} 个片段` : "开始导出")
                  : "需桌面版"}
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
