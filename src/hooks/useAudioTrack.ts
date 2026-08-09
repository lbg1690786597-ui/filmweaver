import { useCallback, useEffect, useRef, useState } from "react";
import { api, AudioClipInfo } from "../api";
import type { Say } from "./useToast";

/** G4 状态分层 · 音频层：P2-4 音频轨（TTS 旁白 / 配乐）+ 合成 job 追踪。 */
export function useAudioTrack(projectId: string | null, say: Say) {
  const [audioClips, setAudioClips] = useState<AudioClipInfo[]>([]);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [ttsJobId, setTtsJobId] = useState<string | null>(null);
  const ttsTimer = useRef<number | null>(null);

  const refreshAudio = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.listAudioClips(id);
      setAudioClips(r.clips);
      setTtsAvailable(r.tts_available);
    } catch { /* 旧后端无此接口时静默 */ }
  }, [projectId]);
  useEffect(() => { if (projectId) refreshAudio(projectId); }, [projectId, refreshAudio]);

  const doSynthTts = async (clipIds?: string[]) => {
    if (!projectId || ttsJobId) return;
    try {
      const j = await api.submitTtsBatch(projectId, clipIds);
      setTtsJobId(j.id);
      say("🔊 旁白合成已提交（单段约 1 分钟，可继续其他操作）");
      ttsTimer.current = window.setInterval(async () => {
        try {
          const s = await api.jobStatus(j.id);
          refreshAudio();  // 逐段点亮
          if (s.status === "done" || s.status === "failed") {
            if (ttsTimer.current) clearInterval(ttsTimer.current);
            setTtsJobId(null);
            refreshAudio();
            say(s.status === "done" ? "✅ 旁白合成完成" : `⚠️ 部分旁白合成失败：${(s.error ?? "").slice(0, 120)}`);
          }
        } catch { /* 网络抖动忽略 */ }
      }, 5000);
    } catch (e) { say(String(e)); }
  };

  /** 切项目：音频轨状态与合成轮询一并清 */
  const clearAudio = useCallback(() => {
    setAudioClips([]);
    setTtsJobId(null);
    if (ttsTimer.current) { clearInterval(ttsTimer.current); ttsTimer.current = null; }
  }, []);

  return { audioClips, ttsAvailable, ttsJobId, refreshAudio, doSynthTts, clearAudio };
}
