import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
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

  /** 删除素材（B23）。
   *
   *  之前是点一下垃圾桶就直接连文件本体一起删，没有任何确认，也不检查是否
   *  还有镜头/旁白/资产在用它 —— 删完那些引用变成死链，要等到导出或合成
   *  才炸，报错里只有一个文件路径，用户根本联系不到"上周删过一个素材"。
   *
   *  现在：后端查到引用会回 409 + 清单，这里把清单摆给用户看再让他决定。
   *  没有任何引用时也仍然确认一次 —— 文件本体是真删，且删了拿不回来。 */
  const deleteClip = async (clipId: string) => {
    const clip = libClips.find((c) => c.id === clipId);
    const label = clip?.name ?? "该素材";
    try {
      if (!window.confirm(`删除「${label}」？\n\n素材文件本体会一并删除，无法恢复。`)) return;
      await api.deleteClip(clipId);
      setLibClips((prev) => prev.filter((c) => c.id !== clipId));
      say("已从素材池删除");
    } catch (e) {
      const err = e as ApiError;
      if (err?.status === 409 && err.references?.length) {
        const list = err.references.slice(0, 8).map((r) => `　· ${r.label}`).join("\n");
        const more = err.references.length > 8
          ? `\n　… 等共 ${err.references.length} 处` : "";
        if (!window.confirm(
          `「${label}」仍被以下位置引用：\n\n${list}${more}\n\n` +
          "仍要删除吗？这些位置会变成打不开的死链（导出时会失败）。")) return;
        try {
          const r = await api.deleteClip(clipId, true);
          setLibClips((prev) => prev.filter((c) => c.id !== clipId));
          say(`已删除，${r.broken_references ?? 0} 处引用已失效`);
        } catch (e2) { say(`删除失败：${String((e2 as Error).message ?? e2)}`); }
        return;
      }
      say(`删除失败：${err?.message ?? String(e)}`);
    }
  };

  const addClips = (cs: LibClip[]) => setLibClips((prev) => [...prev, ...cs]);

  /** R2 重命名素材。只改展示名，url 不动，已插入镜头的素材不受影响。 */
  const renameClip = async (clipId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { say("素材名不能为空"); return; }
    // 乐观更新：先改本地，失败再回滚——重命名是高频轻操作，
    // 等一个往返才变名字在素材面板里体感很差
    const prev = libClips.find((c) => c.id === clipId)?.name;
    setLibClips((cs) => cs.map((c) => (c.id === clipId ? { ...c, name: trimmed } : c)));
    try {
      await api.renameClip(clipId, trimmed);
    } catch (e) {
      if (prev !== undefined) {
        setLibClips((cs) => cs.map((c) => (c.id === clipId ? { ...c, name: prev } : c)));
      }
      say(`重命名失败：${(e as ApiError)?.message ?? String(e)}`);
    }
  };

  /** 切项目：清空素材池内存态 */
  const clearClips = useCallback(() => setLibClips([]), []);

  return { libClips, refreshClips, deleteClip, renameClip, addClips, clearClips };
}
