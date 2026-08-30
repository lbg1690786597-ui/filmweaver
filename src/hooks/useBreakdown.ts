import { useEffect, useCallback, useRef, useState } from "react";
import { api, JobOut, ProjectDetail, ShotInfo } from "../api";
import type { Say } from "./useToast";

/** G4 状态分层 · 拆解 job 追踪 + 导出口径。
 *
 * 前身是 useCompose：它还管着「服务端拼接」那条通道。云端合成已于
 * 2026-08-30 整体下线（只做单轨顺序拼接、不混音频轨、不渲染转场、
 * 字幕写死 FontSize=18，产物与本机渲染不是一回事却同样叫"成片"），
 * 合成统一走桌面端 ffmpeg，所以那半边连同 filmUrl / composeJob 一并删掉。
 *
 * 剩下的两件事与合成无关，必须保留：
 *   · 拆解镜头 job 的提交与轮询（doBreakdown / bdProgress）
 *   · 导出口径（exportClips / totalSec）——按 order 取已生成且未停用的镜头，
 *     外部素材镜头（片头/片尾/转场）与 AI 镜头一视同仁，所见即所得。
 */
export function useBreakdown(opts: {
  detail: ProjectDetail | null;
  say: Say;
  refreshDetail: () => Promise<void> | void;
}) {
  const { detail, say, refreshDetail } = opts;

  const exportClips: ShotInfo[] = (detail?.shots ?? [])
    .filter((s) => s.video_url && !s.disabled)
    .sort((a, b) => a.order - b.order);
  const totalSec = exportClips.reduce((s, x) => s + (x.duration_sec ?? 5), 0);

  // ---- 拆解镜头并生成提示词（job 轮询，状态提升供镜头页使用）----
  const [bdProgress, setBdProgress] = useState<number | null>(null);
  const bdTimer = useRef<number | null>(null);
  const doBreakdown = async (projectId: string | null, episodes?: number[]) => {
    if (!projectId) return;
    setBdProgress(0);
    try {
      const j = await api.submitBreakdownAll(projectId, false, episodes);
      bdTimer.current = window.setInterval(async () => {
        // 轮询回调必须自己吞异常：抛出去就是 unhandled rejection，
        // 而且 interval 不会因此停止，会一直空转到切项目为止。
        let s: JobOut;
        try {
          s = await api.jobStatus(j.id);
        } catch (e) {
          console.warn("[useBreakdown] 拆解状态轮询失败，稍后重试:", e);
          return;
        }
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

  /** 切项目：停掉轮询。
   *
   *  ⚠️ 必须连定时器一起停 —— 否则切到新项目后，旧项目的拆解进度条
   *  会继续在新项目上显示百分比。 */
  const clearBreakdown = useCallback(() => {
    if (bdTimer.current) { clearInterval(bdTimer.current); bdTimer.current = null; }
    setBdProgress(null);
  }, []);

  // 卸载兜底：退到项目列表、热重载时同样要停，否则回调会对已卸载组件 setState
  useEffect(() => () => {
    if (bdTimer.current) clearInterval(bdTimer.current);
  }, []);

  return { exportClips, totalSec, bdProgress, doBreakdown, clearBreakdown };
}
