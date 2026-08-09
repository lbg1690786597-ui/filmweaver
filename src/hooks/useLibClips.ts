import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { LibClip } from "../types";
import type { Say } from "./useToast";

/** G4 状态分层 · 素材层：P1-3 素材池落库（项目维度持久化，刷新/换设备不丢）。 */
export function useLibClips(projectId: string | null, say: Say) {
  const [libClips, setLibClips] = useState<LibClip[]>([]);

  const refreshClips = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    try {
      const r = await api.listClips(id);
      setLibClips(r.clips.map((c) => ({
        id: c.id, name: c.name, url: c.url, size: c.size,
        kind: (c.kind as LibClip["kind"]) ?? "other", duration: c.duration,
      })));
    } catch { /* 旧后端无此接口时保持内存态 */ }
  }, [projectId]);
  useEffect(() => { if (projectId) refreshClips(projectId); }, [projectId, refreshClips]);

  const deleteClip = async (clipId: string) => {
    try {
      await api.deleteClip(clipId);
      setLibClips((prev) => prev.filter((c) => c.id !== clipId));
      say("已从素材池删除");
    } catch (e) { say(String(e)); }
  };

  const addClips = (cs: LibClip[]) => setLibClips((prev) => [...prev, ...cs]);

  /** 切项目：清空素材池内存态 */
  const clearClips = useCallback(() => setLibClips([]), []);

  return { libClips, refreshClips, deleteClip, addClips, clearClips };
}
