import { useCallback, useRef, useState } from "react";
import { ShotInfo } from "../api";
import { localSources } from "../lib/mediaCache";

/** G4 状态分层 · 播放器层：预览源 + P2-1 播放头联动 + 连播 + 选中镜头。
 *
 * previewShot=当前预览器里播放的镜头（素材/成片预览时为 null，播放头隐藏）；
 * playhead=镜头内播放进度；pendingSeek=切镜头后待跳转的秒数（等 loadedmetadata）。
 *
 * ## 6.3：预览源改走本地文件，云端 URL 降级为兜底
 *
 * 三处换源（`onSelectShot` / `previewMedia` / `previewShotVersion`）以前都是
 * 同步的 `setPreviewUrl(api.mediaUrl(u))`，现在先问一句 `localSources.resolve`：
 * 盘上有就给 blob 地址（零网络、seek 瞬时），没有就原样返回云端地址。
 * **不为预览去下载**（下载时机是 6.2 的事），所以最坏情况是"和 6.3 之前一样"。
 *
 * ⚠️ 换源必须在 `setPreviewUrl` **之前**解析完，不能先塞云端地址再偷偷换成 blob：
 * `Player.tsx` 是 `<video key={previewUrl}>`，换 src 就是换元素（`key` 必须保留，
 * 见 §0.5(g)，它是连播能自动播的唯一原因）—— 播到一半换地址会从头重播。
 *
 * ⚠️ 因此换源变成了异步的，而用户会连点。`gen` 是单调代次号：
 * 每次换源自增，回来时对不上就说明用户已经点了别的，这一份结果**整份丢弃**
 * （包括 label / shot / window 那几个 setState，不能只丢 URL —— 那会拼出
 * "A 的画面配 B 的标题"）。 */
export function usePlayer(projectId: string | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [previewShot, setPreviewShot] = useState<{ id: string; order: number } | null>(null);
  /** 3.1 当前预览镜头的取片窗口 `[inSec, inSec+durSec)`。null = 整段使用。
   *
   *  为什么播放器必须知道它：修剪过入点的镜头，素材文件里前面那一段是**被剪掉的**。
   *  播放器若从 0 播起，用户看到的是自己刚刚剪掉的内容，还会以为剪辑没生效。
   *  时间轴上的"镜内第几秒"从此与 `video.currentTime` 差一个 inSec，
   *  两者的换算统一走 toMediaTime / toShotTime，不要各处手写加减。 */
  const [previewWindow, setPreviewWindow] =
    useState<{ inSec: number; durSec: number } | null>(null);
  const [playhead, setPlayhead] = useState<{ order: number; offsetSec: number } | null>(null);
  const pendingSeek = useRef<number | null>(null);
  /** 3.3：这次 seek 之后要不要立刻暂停。
   *
   *  `<video>` 带 `autoPlay`（见 `Player.tsx`），所以一换 previewUrl 就必然自动播。
   *  而"只是把播放头挪过去"的操作（方向键 / Home / End / ↑↓ / 点刻度尺）
   *  跨镜时不该开始播放 —— 按一下右键就播起来是个很难忍的手感。
   *
   *  ⚠️ 原先的写法是 `setTimeout(() => videoRef.current?.pause(), 400)`，
   *  400ms 是在赌元数据什么时候加载完：赌早了 pause 跑在 autoplay 之前、毫无作用；
   *  赌晚了则用户在这 400ms 内按空格开播会被这个迟到的定时器打断。
   *  改成标志位、由 loadedmetadata 消费，与加载快慢无关。 */
  const pendingPause = useRef(false);
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

  /** 该镜头的取片窗口（从后端字段派生）。判据是 clip_dur_sec 而非 clip_in_sec：
   *  入点为 0 的头段（split 出来的第一段）同样是有窗口的。 */
  const windowOf = (s: ShotInfo) =>
    (s.clip_dur_sec != null && s.clip_dur_sec > 0)
      ? { inSec: s.clip_in_sec ?? 0, durSec: s.clip_dur_sec }
      : null;

  /** 6.3：换源代次号。每次换源自增；异步解析回来对不上就说明用户已经点了别的。
   *
   *  用 ref 而不是 state：它每次换源都变，做成 state 会白白多一轮 render，
   *  而且回调里读到的会是闭包捕获的旧值 —— 那正好是这个守卫要防的东西。
   *
   *  `clearPlayer` 也自增它：切项目后，上一个项目那次还在飞的 resolve 回来时
   *  必须被丢掉，否则刚清空的预览器会被上一个项目的画面重新填上。 */
  const gen = useRef(0);

  /**
   * 6.3：把预览源换成 `url`。**本地优先、云端兜底**，解析完再一次性落 state。
   *
   * `apply` 里放的是"这次换源要改的其余 state"（label / shot / window …）：
   * 它们必须和 URL 一起在代次守卫**之后**落，否则连点两次会拼出
   * "A 的画面配 B 的标题"。
   */
  const swapSource = (url: string, apply: () => void) => {
    const my = ++gen.current;
    void localSources.resolve(projectId ?? "", url).then((src) => {
      if (my !== gen.current) return;   // 用户已经点了别的，这一份整份作废
      // 钉住真正交给 `<video>` 的那一个：被钉的不会被 LRU 回收。
      // 拿到的是云端兜底地址时这是空操作（见 localSource.ts 的 `pin`）。
      localSources.pin(src);
      setPreviewUrl(src);
      apply();
    });
  };

  const onSelectShot = (s: ShotInfo) => {
    setSelectedShotId(s.id);
    if (s.video_url) {
      swapSource(s.video_url, () => {
        setPreviewLabel(`镜头 #${s.order}`);
        setPreviewShot({ id: s.id, order: s.order });
        setPreviewWindow(windowOf(s));
      });
    }
  };

  /** 镜内秒 → `video.currentTime`（加上入点偏移） */
  const toMediaTime = (offsetSec: number) => (previewWindow?.inSec ?? 0) + offsetSec;
  /** `video.currentTime` → 镜内秒（时间轴播放头用的口径） */
  const toShotTime = (mediaSec: number) =>
    Math.max(0, mediaSec - (previewWindow?.inSec ?? 0));

  /** 时间轴点击刻度尺 → 跳到该镜头的指定秒（同镜直接 seek，跨镜等元数据加载后 seek）
   *
   *  `opts.pause`：这次 seek 只是移动播放头，不要因此开始播放（见 `pendingPause`）。 */
  const seekTo = (s: ShotInfo, offsetSec: number, opts?: { pause?: boolean }) => {
    if (previewShot?.id === s.id && videoRef.current) {
      videoRef.current.currentTime = toMediaTime(offsetSec);
      if (opts?.pause) videoRef.current.pause();
      return;
    }
    // 跨镜：pendingSeek 存的是**素材时间**（已含入点），不是镜内秒。
    // 直接从 s 算，不依赖 previewWindow 这个 state —— 它要等这次
    // setState 生效后才是新镜头的窗口，而 loadedmetadata 的时序不该由我们赌。
    pendingSeek.current = (windowOf(s)?.inSec ?? 0) + offsetSec;
    pendingPause.current = !!opts?.pause;
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
    // 用户主动要看另一个东西，上一次"挪播放头"留下的暂停意图不该殃及它。
    // 这一句在 swapSource 之外：它是"现在就作废"的意图，不该等解析回来才生效
    // （解析期间 loadedmetadata 可能已经消费掉这个标志了）。
    pendingPause.current = false;
    swapSource(url, () => {
      setPreviewLabel(label);
      setPreviewShot(null); setPlayhead(null);
      setPreviewWindow(null);
    });
  };

  /** 指定版本预览（版本切换后同步预览器）。
   *
   *  3.1：窗口置空 —— 窗口是绑在**当前采用**的那个 video_url 上的坐标，
   *  拿它去限制另一个版本的播放范围只会切错地方（后端在采纳时也会清掉它）。 */
  const previewShotVersion = (shot: ShotInfo, verNo: number, videoUrl: string) => {
    pendingPause.current = false;
    swapSource(videoUrl, () => {
      setPreviewLabel(`镜头 #${shot.order} · V${verNo}`);
      setPreviewShot({ id: shot.id, order: shot.order });
      setPreviewWindow(null);
    });
  };

  /** 切/关项目：清空预览与选中态（防上一项目串台） */
  const clearPlayer = useCallback(() => {
    // 先废掉在飞的换源：不然上一个项目那次 resolve 回来会把刚清空的预览器填回去。
    gen.current++;
    setPreviewUrl(null);
    setPreviewLabel("");
    setSelectedShotId(null);
    setPreviewShot(null);
    setPlayhead(null);
    setCursor(null);
    setPreviewWindow(null);
    pendingPause.current = false;
  }, []);

  return {
    videoRef, previewUrl, previewLabel, previewShot, playhead, setPlayhead,
    pendingSeek, pendingPause, autoNext, setAutoNext, selectedShotId, setSelectedShotId,
    onSelectShot, seekTo, onPreviewEnded, previewMedia, previewShotVersion,
    clearPlayer, cursor, setCursor,
    previewWindow, toMediaTime, toShotTime,
  };
}
