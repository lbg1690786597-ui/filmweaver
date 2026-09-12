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

/** 各扩展名 → 类别。**这份清单同时被三处用到**（素材池上传、媒体面板、
 *  3.11 起的「从资源管理器拖入」），所以按扩展名分流必须只有这一份：
 *  拖进来的 .gif 若在这里被算成 other、在 osDrop 里被算成 image，
 *  它就会既进不了图片的归属确认、又在界面上显示成"其它"。
 *
 *  `other` 不是错误答案：它表示"认得文件，但不知道怎么用"——
 *  这类素材照常入库，只是不会参与图片归属、也没有时长。 */
const EXT_KIND: Record<string, ClipKind> = {
  mp4: "video", mov: "video", mkv: "video", webm: "video",
  avi: "video", m4v: "video", flv: "video", wmv: "video", mpg: "video", mpeg: "video",
  mp3: "audio", wav: "audio", aac: "audio", m4a: "audio",
  flac: "audio", ogg: "audio", opus: "audio", wma: "audio",
  png: "image", jpg: "image", jpeg: "image", webp: "image",
  bmp: "image", gif: "image", heic: "image", avif: "image",
};

export function clipKind(name: string): ClipKind {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_KIND[ext] ?? "other";
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