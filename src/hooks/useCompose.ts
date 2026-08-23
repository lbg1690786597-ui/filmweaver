import { useCallback, useRef, useState } from "react";
import { api, JobOut, ProjectDetail, ShotInfo } from "../api";
import type { Say } from "./useToast";

/** G4 状态分层 · 导出层：快速导出（compose job）+ 拆解 job 追踪。
 *
 * 导出（P0-3 时间轴归一）：直接消费镜头轨——按 order 取已生成且未停用的镜头，
 * 外部素材镜头（片头/片尾/转场）与 AI 镜头一视同仁，所见即所得。 */
export function useCompose(opts: {
  detail: ProjectDetail | null;
  say: Say;
  refreshDetail: () => Promise<void> | void;
  onFilmReady: (url: string) => void;
}) {
  const { detail, say, refreshDetail, onFilmReady } = opts;
  const [composeJob, setComposeJob] = useState<JobOut | null>(null);
  const [composing, setComposing] = useState(false);
  const composeTimer = useRef<number | null>(null);
  const [filmUrl, setFilmUrl] = useState<string | null>(null);

  const exportClips: ShotInfo[] = (detail?.shots ?? [])
    .filter((s) => s.video_url && !s.disabled)
    .sort((a, b) => a.order - b.order);
  const totalSec = exportClips.reduce((s, x) => s + (x.duration_sec ?? 5), 0);

  const doExport = async (opts?: {
    width: number; height: number; fps: number;
    vcodec: string; crf: number; withAudio: boolean;
  }) => {
    if (!exportClips.length) { say("镜头轨上还没有已生成的镜头"); return; }
    setComposing(true); setFilmUrl(null); setComposeJob(null);
    try {
      const aspect = detail?.base_aspect ?? "9:16";
      const [dw, dh] = aspect === "16:9" ? [1920, 1080] : aspect === "1:1" ? [1080, 1080] : [1080, 1920];
      const w = opts?.width ?? dw, h = opts?.height ?? dh;
      // TB-02：有字幕就取 SRT 一起烧进成片（时间码由后端按镜头顺序换算）
      let burnSrt: string | undefined;
      try {
        const r = await api.subtitlesSrt(detail!.id);
        if (r.count > 0) burnSrt = r.srt;
      } catch { /* 拉不到字幕不该挡住导出 */ }

      // TB-01：被分割过的镜头带取片窗口，后端 ffmpeg 用 -ss/-t 裁出对应片段
      // TB-03/TB-10：带调整参数的镜头把 transform_meta 一并下发
      const job = await api.submitCompose(
        exportClips.map((s) => {
          const hasClip = s.clip_in_sec != null || s.clip_dur_sec != null;
          const hasTm = !!s.transform_meta && Object.keys(s.transform_meta).length > 0;
          if (!hasClip && !hasTm) return s.video_url!;
          return {
            url: s.video_url!,
            in: s.clip_in_sec ?? 0,
            dur: s.clip_dur_sec ?? (s.duration_sec ?? undefined),
            tm: hasTm ? s.transform_meta! : undefined,
          };
        }),
        {
          width: w, height: h, fps: opts?.fps ?? 30, burn_srt: burnSrt,
          vcodec: opts?.vcodec ?? "libx264",
          crf: opts?.crf ?? 20,
          with_audio: opts?.withAudio ?? true,
        });
      setComposeJob(job);
      composeTimer.current = window.setInterval(async () => {
        const s = await api.jobStatus(job.id);
        setComposeJob(s);
        if (s.status === "done" || s.status === "failed") {
          if (composeTimer.current) clearInterval(composeTimer.current);
          setComposing(false);
          if (s.status === "done" && s.result) {
            const url = api.mediaUrl(JSON.parse(s.result).url);
            setFilmUrl(url);
            onFilmReady(url);
            say("拼接完成！");
          } else say(`拼接失败: ${s.error}`);
        }
      }, 3000);
    } catch (e) { say(String(e)); setComposing(false); }
  };

  // ---- 拆解镜头并生成提示词（job 轮询，状态提升供镜头页使用）----
  const [bdProgress, setBdProgress] = useState<number | null>(null);
  const bdTimer = useRef<number | null>(null);
  const doBreakdown = async (projectId: string | null, episodes?: number[]) => {
    if (!projectId) return;
    setBdProgress(0);
    try {
      const j = await api.submitBreakdownAll(projectId, false, episodes);
      bdTimer.current = window.setInterval(async () => {
        const s = await api.jobStatus(j.id);
        setBdProgress(s.progress);
        void refreshDetail();  // 实时把已拆完的集刷进镜头列表
        if (s.status === "done" || s.status === "failed") {
          if (bdTimer.current) clearInterval(bdTimer.current);
          setBdProgress(null);
          void refreshDetail();
          say(s.status === "done" ? "✅ 分镜与提示词生成完成" : "⚠️ 部分集拆解失败，可重拆");
        }
      }, 3000);
    } catch (e) { say(String(e)); setBdProgress(null); }
  };

  /** 切项目：清成片地址（compose/breakdown 轮询保留原行为：完成即自停） */
  const clearCompose = useCallback(() => setFilmUrl(null), []);

  return {
    composeJob, composing, filmUrl, exportClips, totalSec, doExport,
    bdProgress, doBreakdown, clearCompose,
  };
}
