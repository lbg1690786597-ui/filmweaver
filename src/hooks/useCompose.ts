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

  const doExport = async () => {
    if (!exportClips.length) { say("镜头轨上还没有已生成的镜头"); return; }
    setComposing(true); setFilmUrl(null); setComposeJob(null);
    try {
      const aspect = detail?.base_aspect ?? "9:16";
      const [w, h] = aspect === "16:9" ? [1920, 1080] : aspect === "1:1" ? [1080, 1080] : [1080, 1920];
      const job = await api.submitCompose(exportClips.map((s) => s.video_url!), { width: w, height: h });
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
