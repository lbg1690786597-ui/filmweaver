import { useCallback, useEffect, useRef, useState } from "react";
import { api, AudioClipInfo } from "../api";
import type { Say } from "./useToast";
import { useLoadState } from "../stores/loadStateStore";
import { prefetcher } from "../lib/mediaCache";
import { SSE_FALLBACK_MS, isSseUp, shouldSkipTick } from "../lib/sseHealth";

/** 连续拿不到合成进度多少轮才提示（×5 秒轮询间隔）。
 *  1~2 轮是常见的网络抖动，为此弹提示是噪音；到第 3 轮（≈15 秒）
 *  就不再是抖动了，界面会一直停在「合成中」，必须说一声。 */
const POLL_MISS_LIMIT = 3;

/**
 * 合成任务成功结束时该说什么——**取决于它到底合成了几段**。
 *
 * `run_tts_batch` 查不到可合成的段时，是以 `status=done` +
 * `result={"clips": [], "note": "没有待合成的旁白"}` 结束的（这没错：任务本身
 * 确实正常跑完了）。但这里以前只看 status，一律报「✅ 旁白合成完成」——
 * 于是"提交成功、完成、什么都没出现"，用户只能怀疑是软件坏了。
 * 真人剧项目**永远**走这条路（它根本不存在 tts 段），那句 ✅ 就是纯粹的谎话。
 *
 * result 解析失败按"完成"处理：那是后端换了格式，不是"没合成"，
 * 这时报 ✅ 至少不会把成功说成失败。
 */
function doneMsg(result: string | null): string {
  try {
    const r = JSON.parse(result ?? "") as { clips?: unknown[]; note?: string };
    if (Array.isArray(r.clips) && r.clips.length === 0) {
      return `ℹ️ ${r.note || "没有需要合成的旁白"}`;
    }
    if (Array.isArray(r.clips)) return `✅ 旁白合成完成（${r.clips.length} 段）`;
  } catch { /* 见上：解析不了就按完成说 */ }
  return "✅ 旁白合成完成";
}

/** G4 状态分层 · 音频层：P2-4 音频轨（TTS 旁白 / 配乐）+ 合成 job 追踪。 */
export function useAudioTrack(projectId: string | null, say: Say) {
  const [audioClips, setAudioClips] = useState<AudioClipInfo[]>([]);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [ttsJobId, setTtsJobId] = useState<string | null>(null);
  const ttsTimer = useRef<number | null>(null);
  /** 连续拿不到 job 状态的轮数（成功即归零） */
  const pollMisses = useRef(0);

  const refreshAudio = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.listAudioClips(id);
      setAudioClips(r.clips);
      // 6.2：旁白/配乐走的是与 detail 完全分开的这条通道，所以预取也要在这儿挂一次。
      // TTS 合成期间这个函数每 5 秒被调一次（逐段点亮），正是"任务完成即落盘"最典型
      // 的场景：一段旁白合成好 → 下一轮轮询里它的 url 从 null 变成有值 → 立刻入队。
      prefetcher.warmNew(id, "audio", r.clips.map((c) => c.url));
      setTtsAvailable(r.tts_available);
      useLoadState.getState().noteLoaded("audio");
    } catch (e) {
      // 2.4：以前是静默 catch。失败后 audioClips 停在空数组，时间轴上音频轨
      // 空着 —— 与"这个项目确实还没有旁白"长得一模一样，用户会以为旁白丢了
      // 然后重新合成一遍（花钱、且覆盖掉原来的）。顶栏挂持久提示 + 提示一次。
      if (useLoadState.getState().noteFailed("audio", e)) {
        say(`⚠️ ${useLoadState.getState().failures.audio?.message ?? "音频轨没能加载"}`);
      }
    }
  }, [projectId, say]);
  useEffect(() => { if (projectId) refreshAudio(projectId); }, [projectId, refreshAudio]);

  // 顶栏「未加载」旁边那个「重试」点下来会走到这里。注销时连带清掉该条失败
  // （见 loadStateStore：提示的存活期 = 那句谎话的存活期）
  useEffect(() => useLoadState.getState().registerRetry(
    "audio", () => { void refreshAudio(); }), [refreshAudio]);

  const doSynthTts = async (clipIds?: string[]) => {
    if (!projectId || ttsJobId) return;
    try {
      const j = await api.submitTtsBatch(projectId, clipIds);
      setTtsJobId(j.id);
      pollMisses.current = 0;   // 上一次任务留下的计数不能算到这一次头上
      say("🔊 旁白合成已提交（单段约 1 分钟，可继续其他操作）");
      let tick = 0;
      ttsTimer.current = window.setInterval(async () => {
        tick += 1;
        try {
          const s = await api.jobStatus(j.id);
          pollMisses.current = 0;
          // 与拆解同理（U1 第 1 点）：**只降 refreshAudio，不降 jobStatus**。
          // jobStatus 撑着 pollMisses 那条"连不上服务器"的提示与收尾 toast，
          // 降频会让它迟到；而"逐段点亮"这件事 SSE 已经在做 —— 后端每段合成完
          // 推一条 `audio` 事件，useProdJobs 收到即 refreshAudio()。
          if (!shouldSkipTick(tick, 5000, SSE_FALLBACK_MS, isSseUp())) {
            refreshAudio();  // 逐段点亮（SSE 断线时这是唯一来源）
          }
          if (s.status === "done" || s.status === "failed") {
            if (ttsTimer.current) clearInterval(ttsTimer.current);
            setTtsJobId(null);
            refreshAudio();   // 收尾这一次无条件拉
            say(s.status === "done" ? doneMsg(s.result)
              : `⚠️ 部分旁白合成失败：${(s.error ?? "").slice(0, 120)}`);
          }
        } catch {
          // 2.4：以前是「网络抖动忽略」。抖一下确实该忽略 —— 下一轮就好了，
          // 为此弹提示反而是噪音。但**持续**拿不到状态时，界面会永远停在
          // 「合成中」（ttsJobId 一直是非空），用户等下去等不到任何结果。
          // 所以只在连续失败到第 3 轮（≈15 秒）时说一次，并且**不**停轮询、
          // 也**不**清 ttsJobId —— 任务在服务端是真的还在跑，网络恢复后会自愈。
          pollMisses.current += 1;
          if (pollMisses.current === POLL_MISS_LIMIT) {
            say("⚠️ 暂时看不到旁白合成进度（连不上服务器）—— 合成还在继续，网络恢复后会自动接上", 6000);
          }
        }
      }, 5000);
    } catch (e) { say(String(e)); }
  };

  /** 切项目：音频轨状态与合成轮询一并清 */
  const clearAudio = useCallback(() => {
    setAudioClips([]);
    setTtsJobId(null);
    pollMisses.current = 0;
    if (ttsTimer.current) { clearInterval(ttsTimer.current); ttsTimer.current = null; }
  }, []);

  return { audioClips, ttsAvailable, ttsJobId, refreshAudio, doSynthTts, clearAudio };
}
