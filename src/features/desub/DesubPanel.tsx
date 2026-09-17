/**
 * DesubPanel — 去字幕（第一期：只有前端）
 *
 * ## 这是在解决什么
 *
 * seedance 这类视频模型偶尔会把台词**烧进成片画面**（全库抽样约 5.5% 的成片中招）。
 * 那是已经进了像素的字，织影自己的字幕轨关不掉它，只能整块送去第三方擦。
 * 本面板是这件事的**总览与结账台**：哪几段要擦、一共多少秒、确认之后开工。
 *
 * ## 为什么是左侧面板而不是弹窗
 *
 * 这个功能要求「在画面上框 + 在轨道上调区间」**同时可见**。弹窗（ExportDialog
 * 那一套）会把预览和时间轴一起盖住，两个主要操作面全看不见 —— 那就只能反复
 * 开关弹窗去对位置。所以走 Rail + LeftPanel 面板体系。
 *
 * ## 为什么「时长」是这个面板的主角
 *
 * 第三方 API **按处理的视频长度计费**，且遮罩面积对耗时几乎没有影响
 * （实测 315 倍面积差只多 7 秒）。也就是说把框画小一点既不省钱也不省时间，
 * **唯一能省的旋钮是时间区间**。所以清单里每一条都把区间和秒数摆在最显眼处，
 * 底部再给一个合计 —— 用户按下「开始去字幕」之前，该知道自己要付多少秒。
 *
 * ## 两条路径，一份数据
 *
 * 标记可以来自两头，落的是同一个 `shot.transform_meta.desub`：
 *   · **自动** —— 点「识别全片字幕」，后端逐镜抽帧问 VLM，把位置与时间段标出来；
 *   · **手工** —— 预览窗工具条上的橡皮擦，在字幕上拖一个框。
 * 识别出来的每一条都要在这份清单里被人看过才会进入擦除：VLM 在两套真实素材上
 * 共 129 次分类误擦 0、漏擦 0，但**擦除不可逆且是有损重编码**，一个再准的判断
 * 也不该拿用户的画面赌。所以「识别」和「擦除」是两个按钮，中间隔着这份清单。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ScanSearch, Eraser, Crosshair, Trash2, Check, Info, Loader2 } from "lucide-react";
import { api, type ShotInfo, type JobOut } from "../../api";
import type { DesubRegion } from "../../types/desub";
import { useCanvasToolStore } from "../../stores/canvasToolStore";
import "./DesubPanel.css";

interface Props {
  shots: ShotInfo[];
  /** 当前项目 id。两个按钮都是项目级提交（后端按 project_id 去重）。 */
  projectId: string;
  /** 定位：把播放头移到这条标记的起点并选中所属镜头。
   *  `t0` 是**镜头输出秒**，换算成时间轴绝对秒的活由 App 干 ——
   *  那里才有 `buildOrderOffsetMap`（与画线同源，不能在这儿另累加一遍）。 */
  onLocate: (shotId: string, t0: number) => void;
  onDelete: (shotId: string, regionId: string) => void;
  /** 任务结束后把项目详情拉一遍：识别的结果、擦除后的新 video_url 都在那里。 */
  onRefresh: () => void | Promise<void>;
}

interface Row {
  shot: ShotInfo;
  region: DesubRegion;
}

/** 轮询间隔。识别是逐镜调 VLM、擦除更是按分钟计的第三方任务，
 *  1.5 秒足够让进度看着在动，又不会把后端问出一身 GET。 */
const POLL_MS = 1500;

export default function DesubPanel({ shots, projectId, onLocate, onDelete,
                                    onRefresh }: Props) {
  // 选中态与预览窗里的蓝框共用一份（canvasToolStore.desubSel）：
  // 面板点一条 → 画面上那个框高亮，两个视图看的是同一件东西。
  const selId = useCanvasToolStore((s) => s.desubSel);
  const setSelId = useCanvasToolStore((s) => s.setDesubSel);

  // 正在跑的那个 job（识别或擦除，同时只会有一个 —— 两者都在 shots 互斥组里）。
  const [job, setJob] = useState<JobOut | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 卸载后不再 setState：面板是可以随时切走的，而轮询还在飞。
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  // 轮询：job 存在且没落终态就每 POLL_MS 问一次。
  // 终态到达时**必须 onRefresh()** —— 识别的结果写在各镜的 transform_meta 里，
  // 不重新拉详情的话清单会一直空着，看起来就像"识别完了什么也没找到"。
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    let stop = false;
    const tick = async () => {
      try {
        const next = await api.jobStatus(job.id);
        if (stop || !aliveRef.current) return;
        setJob(next);
        if (next.status === "done" || next.status === "failed") {
          if (next.status === "failed") setErr(next.error || "任务失败");
          await onRefresh();
        }
      } catch (e) {
        if (!stop && aliveRef.current) setErr(String((e as Error)?.message ?? e));
      }
    };
    const h = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(h); };
  }, [job, onRefresh]);

  const running = !!job && job.status !== "done" && job.status !== "failed";

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of [...shots].sort((a, b) => a.order - b.order)) {
      // 叠加层（track_index>0）不参与：它盖在主轨之上，成片里的那份画面来自
      // 主轨的镜头文件，对它做去字幕擦不到用户看见的那一层。
      if ((s.track_index ?? 0) > 0) continue;
      for (const r of [...(s.transform_meta?.desub ?? [])].sort((a, b) => a.t0 - b.t0)) {
        out.push({ shot: s, region: r });
      }
    }
    return out;
  }, [shots]);

  const pending = rows.filter((x) => x.region.appliedVersion == null);
  const applied = rows.length - pending.length;
  // 计费预估：只算没擦过的。已擦过的再算进去就是重复收费的错觉 ——
  // 它们不会被提交（后端按 appliedVersion 跳过），也不该出现在账单里。
  const billSec = pending.reduce(
    (acc, x) => acc + Math.max(0, x.region.t1 - x.region.t0), 0);
  const shotCount = new Set(pending.map((x) => x.shot.id)).size;

  const submit = async (what: "scan" | "apply") => {
    setErr(null);
    try {
      const j = what === "scan"
        ? await api.submitDesubScan(projectId)
        : await api.submitDesubApply(projectId);
      setJob(j);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };

  const onApply = async () => {
    if (!pending.length) return;
    // 二次确认**复述数字**而不是问一句"确定吗"：用户要判断的是
    // "这些秒数值不值得"，而那个数字只有这里知道。
    const ok = window.confirm(
      `将擦除 ${shotCount} 个镜头里的 ${pending.length} 段画面，`
      + `合计 ${billSec.toFixed(1)} 秒（服务方按处理时长计费）。\n\n`
      + `结果会存成新的镜头版本，原片保留、随时可在检查器的版本区切回，`
      + `但擦掉的字回不来，且画面会经过一次有损重编码。\n\n确定开始吗？`);
    if (ok) await submit("apply");
  };

  // 进度文案：后端把「第几镜/共几镜」放在 phase 里，有就用它 ——
  // 只有一个百分比的话，一个 30 镜的项目在前几分钟看着就像卡死了。
  const progressText = (() => {
    if (!job) return "";
    const p = job.phase;
    if (p && p.total > 0) return `${p.label}：${p.done}/${p.total}`;
    return `${job.progress || 0}%`;
  })();
  const scanning = running && job?.kind === "desub_scan";
  const applying = running && job?.kind === "desub_apply";

  return (
    <div className="fw-dsp">
      <p className="fw-dsp-intro">
        视频模型有时会把台词<b>烧进画面</b>，这种字幕关不掉，只能送去擦。
        点下面的按钮让 AI 通读全片找出来，或在预览窗工具条点 <Eraser size={11} /> 橡皮擦
        自己框；标记都会落到时间轴的「去字幕」轨上，拖两端可以调区间。
      </p>

      <button className="fw-dsp-act" disabled={running}
        onClick={() => void submit("scan")}
        title="逐镜抽帧识别烧录字幕的位置与时间段。只花识别的 token，不动任何素材">
        {scanning ? <Loader2 size={13} className="fw-dsp-spin" /> : <ScanSearch size={13} />}
        {scanning ? `识别中 ${progressText}` : "识别全片字幕"}
      </button>

      {err && <div className="fw-dsp-err">{err}</div>}

      {/* 计费口径要摆在清单**之前**：它是用户决定"要不要把这一条留下"的依据，
          放在最底下就成了事后通知。 */}
      <div className="fw-dsp-bill">
        <div className="fw-dsp-bill-main">
          <b>{pending.length}</b> 段待处理 · 合计 <b>{billSec.toFixed(1)}</b> 秒
        </div>
        <div className="fw-dsp-bill-sub">
          涉及 {shotCount} 个镜头{applied > 0 ? ` · 另有 ${applied} 段已擦除` : ""}
        </div>
        <div className="fw-dsp-note">
          <Info size={11} />
          <span>
            按<b>处理的视频时长</b>计费，所以能省钱的只有区间长短；
            框的大小不影响费用和耗时（实测 315 倍面积差只多 7 秒），
            宁可框大一点也别切到半个字。
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="fw-dsp-empty">
          还没有任何标记。
          <br />
          用预览窗的橡皮擦工具框一下字幕 —— 标记的时间段会自动取
          「当前帧往前 1 秒 → 本片段结尾」：人是<b>看到字幕之后</b>才按下的，
          往前留 1 秒才不会漏掉开头那几帧。
        </div>
      ) : (
        <div className="fw-dsp-list">
          {rows.map(({ shot, region: r }) => {
            const done = r.appliedVersion != null;
            return (
              <div key={r.id}
                className={`fw-dsp-row${selId === r.id ? " sel" : ""}${done ? " done" : ""}`}
                onClick={() => { setSelId(r.id); onLocate(shot.id, r.t0); }}>
                <div className="fw-dsp-row-main">
                  <span className="fw-dsp-shot">#{shot.order}</span>
                  <span className="fw-dsp-text" title={r.text || undefined}>
                    {done && <Check size={10} className="fw-dsp-ok" />}
                    {r.text || (r.src === "auto" ? "识别结果" : "手工标记")}
                  </span>
                </div>
                <div className="fw-dsp-row-meta">
                  <span className="fw-dsp-range">
                    {r.t0.toFixed(1)}s – {r.t1.toFixed(1)}s
                  </span>
                  <span className="fw-dsp-dur">{(r.t1 - r.t0).toFixed(1)}s</span>
                  <button className="fw-dsp-icon" title="把播放头移到这一段的开头"
                    onClick={(e) => { e.stopPropagation(); onLocate(shot.id, r.t0); }}>
                    <Crosshair size={12} />
                  </button>
                  {/* 删已擦除的标记**不会**还原画面（那要去版本区切回旧版本），
                      所以两种情形的 title 必须说不同的话。 */}
                  <button className="fw-dsp-icon danger"
                    title={done
                      ? "删除这条记录（画面不会还原，要回到原片请去检查器的版本区切回）"
                      : "删除这个标记"}
                    onClick={(e) => { e.stopPropagation(); onDelete(shot.id, r.id); }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button className="fw-dsp-act primary"
        disabled={running || pending.length === 0}
        onClick={() => void onApply()}
        title={pending.length === 0
          ? "没有待处理的标记"
          : "擦除结果会存成新的镜头版本，原片保留。按处理时长计费"}>
        {applying ? <Loader2 size={13} className="fw-dsp-spin" /> : <Eraser size={13} />}
        {applying ? `擦除中 ${progressText}` : "开始去字幕"}
      </button>
      <div className="fw-dsp-foot">
        擦除会重新编码画面（有损），所以结果会存成<b>新的镜头版本</b>，原片始终保留，
        随时可以在检查器的版本区切回去。
      </div>
    </div>
  );
}
