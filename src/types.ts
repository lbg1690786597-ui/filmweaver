/** 共享类型：素材与时间轴。 */

export type ClipKind = "video" | "audio" | "image" | "other";

/** 素材库条目（已上传到云端） */
export interface LibClip {
  id: string;
  name: string;
  url: string;       // /fw/media/uploads/xxx
  size: number;
  kind: ClipKind;
  duration: number;  // 秒；图片/未知为 0
}

/** 素材入轨说明（P0-3）：素材库不再有独立剪辑轨，
 *  视频素材通过 addSpecialShot 作为 is_special 镜头插入镜头轨（唯一真源）。 */

export function clipKind(name: string): ClipKind {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mov", "mkv", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "aac", "m4a"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "image";
  return "other";
}

/** 读取媒体真实时长（秒），失败返回 0 */
export function probeDuration(url: string, kind: ClipKind): Promise<number> {
  if (kind !== "video" && kind !== "audio") return Promise.resolve(0);
  return new Promise((resolve) => {
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => resolve(isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => resolve(0);
    el.src = url;
  });
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}