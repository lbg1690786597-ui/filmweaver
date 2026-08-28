import { useCallback, useRef, useState } from "react";
import { api, ShotInfo } from "../api";

/** G4 状态分层 · 播放器层：预览源 + P2-1 播放头联动 + 连播 + 选中镜头。
 *
 * previewShot=当前预览器里播放的镜头（素材/成片预览时为 null，播放头隐藏）；
 * playhead=镜头内播放进度；pendingSeek=切镜头后待跳转的秒数（等 loadedmetadata）。 */
export function usePlayer() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [previewShot, setPreviewShot] = useState<{ id: string; order: number } | null>(null);
  const [playhead, setPlayhead] = useState<{ order: number; offsetSec: number } | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const [autoNext, setAutoNext] = useState(false);  // 连播：本镜播完自动切下一镜
  /** ⚠️ 只存 id，**不要**存整个 ShotInfo 对象。
   *
   *  存对象的话它就是一份快照：refreshDetail() 换掉 detail.shots 里的对象后，
   *  这里仍指向旧的那个，于是多个面板长期拿着陈旧数据 ——
   *    · 特效面板「再点一次关闭」永远关不掉（读到的 vignette 还是旧值）
   *    · Inspector 切个 tab 就"回退"到保存前的数值
   *    · 保存提示词后状态徽标、版本列表的「当前」标记都不更新
   *  真实对象由调用方用这个 id 从最新的 shots 里派生（见 App.tsx）。 */
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  /** 定位线（editing cursor）：用户主动放置的工作锚点，独立于播放头。
   *  单击刻度尺放置、拖把手移动；「从定位线播放」等按钮消费此状态。 */
  const [cursor, setCursor] = useState<{ order: number; offsetSec: number } | null>(null);

  const onSelectShot = (s: ShotInfo) => {
    setSelectedShotId(s.id);
    if (s.video_url) {
      setPreviewUrl(api.mediaUrl(s.video_url));
      setPreviewLabel(`镜头 #${s.order}`);
      setPreviewShot({ id: s.id, order: s.order });
    }
  };

  /** 时间轴点击刻度尺 → 跳到该镜头的指定秒（同镜直接 seek，跨镜等元数据加载后 seek） */
  const seekTo = (s: ShotInfo, offsetSec: number) => {
    if (previewShot?.id === s.id && videoRef.current) {
      videoRef.current.currentTime = offsetSec;
      return;
    }
    pendingSeek.current = offsetSec;
    onSelectShot(s);
  };

  /** 连播：播完切下一个有片且未停用的镜头（shots 由调用方传入当前 detail） */
  const onPreviewEnded = (shots: ShotInfo[]) => {
    if (!autoNext || !previewShot) return;
    const next = shots.find(
      (s) => s.order > previewShot.order && s.video_url && !s.disabled);
    if (next) onSelectShot(next);
  };

  /** 非镜头预览（素材/成片/音频）：播放头隐藏 */
  const previewMedia = (url: string, label: string) => {
    setPreviewUrl(api.mediaUrl(url));
    setPreviewLabel(label);
    setPreviewShot(null); setPlayhead(null);
  };

  /** 指定版本预览（版本切换后同步预览器） */
  const previewShotVersion = (shot: ShotInfo, verNo: number, videoUrl: string) => {
    setPreviewUrl(api.mediaUrl(videoUrl));
    setPreviewLabel(`镜头 #${shot.order} · V${verNo}`);
    setPreviewShot({ id: shot.id, order: shot.order });
  };

  /** 切/关项目：清空预览与选中态（防上一项目串台） */
  const clearPlayer = useCallback(() => {
    setPreviewUrl(null);
    setPreviewLabel("");
    setSelectedShotId(null);
    setPreviewShot(null);
    setPlayhead(null);
    setCursor(null);
  }, []);

  return {
    videoRef, previewUrl, previewLabel, previewShot, playhead, setPlayhead,
    pendingSeek, autoNext, setAutoNext, selectedShotId, setSelectedShotId,
    onSelectShot, seekTo, onPreviewEnded, previewMedia, previewShotVersion,
    clearPlayer, cursor, setCursor,
  };
}
