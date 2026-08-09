import { useEffect, useRef, useState } from "react";
import { api, AudioClipInfo, LocationInfo, ShotInfo, StageInfo } from "../api";
import { LibClip, fmtTime } from "../types";
import CharacterTrack, { ShotRects } from "./CharacterTrack";
import AudioTrack from "./AudioTrack";
import LocationTrack from "./LocationTrack";

interface Props {
  shots: ShotInfo[];
  episodes: { order: number; title: string }[];
  selectedShotId: string | null;
  onSelectShot: (shot: ShotInfo) => void;
  stages: StageInfo[];
  /** P1-3 场景轨数据（listStages 同接口返回） */
  locations: LocationInfo[];
  onRefreshStages: () => void;
  onToast: (m: string) => void;
  onDraft: () => void;       // AI 识别换装（父组件带 busy 态）
  drafting: boolean;
  /** 版块最大化：由 App 控制布局（⛶ / Esc 还原） */
  maximized: boolean;
  onToggleMax: () => void;
  /** P0-3 轻剪辑：改时长 / 改顺序 / 停用（镜头轨为唯一真源） */
  onPatchTimeline: (shotId: string, patch: {
    durationSec?: number; toOrder?: number; disabled?: boolean;
  }) => Promise<void>;
  /** 删除外部素材镜头（AI 镜头只支持停用） */
  onDeleteShot: (shotId: string) => Promise<void>;
  /** 导出概览：可导出段数与总时长（与「🚀 快速导出」口径一致） */
  totalSec: number;
  exportCount: number;
  /** P1-2 资产条拖拽落库（ref_overrides）用 */
  projectId: string;
  onOverridesChanged: () => void;
  /** P2-1 播放头：当前预览镜头的播放进度（非镜头预览时 null，播放头隐藏） */
  playhead: { order: number; offsetSec: number } | null;
  /** 点击刻度尺/播放头跳转：跳到某镜头的第 offsetSec 秒 */
  onSeek: (shot: ShotInfo, offsetSec: number) => void;
  /** P2-2 撤销栈：注册一条可逆操作（Ctrl/⌘+Z 回退） */
  onPushUndo: (label: string, undo: () => Promise<void>) => void;
  /** P2-4 音频轨（TTS 旁白/配乐） */
  audioClips: AudioClipInfo[];
  ttsAvailable: boolean;
  onAudioChanged: () => void;
  onSynthTts: (clipIds?: string[]) => void;
  synthBusy: boolean;
  libClips: LibClip[];
  onPreviewAudio: (url: string, label: string) => void;
}

/** 单轨折叠：空轨默认折叠、可手动展开/收起；内容从无到有时自动展开。 */
function useTrackOpen(hasContent: boolean) {
  const [open, setOpen] = useState(hasContent);
  const prev = useRef(hasContent);
  useEffect(() => {
    if (!prev.current && hasContent) setOpen(true);
    prev.current = hasContent;
  }, [hasContent]);
  return { open, toggle: () => setOpen((o) => !o) };
}

const PX_PER_SEC_DEFAULT = 12;
const ZOOM_MIN = 4;      // 全局俯瞰：几百镜也能一屏看完
const ZOOM_MAX = 40;     // 精修：单镜可辨识
const MIN_W = 56;
const GAP = 3;      // 镜头槽间距
const EP_GAP = 8;   // 集与集间距
/* 集色条配色（循环使用） */
const EP_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#f97316"];
/* 时长档位：与后端 1-15s 钳制一致，右键菜单直接选 */
const DUR_STEPS = [3, 5, 8, 10, 15];

/** 刻度尺步长：按当前缩放挑一个「刻度间距不小于 48px」的整齐秒数档位 */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const pickTickStep = (pxPerSec: number) =>
  TICK_STEPS.find((s) => s * pxPerSec >= 48) ?? TICK_STEPS[TICK_STEPS.length - 1];

/** 秒 → 刻度标签（m:ss，超过 1 小时补时） */
const tickLabel = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
};

/** 镜头轨右键菜单位置与目标 */
interface MenuState { shot: ShotInfo; x: number; y: number }

/** 统一时间轴版块（类视频编辑软件轨道布局）：
 *  顶部集色条 → 人物资产轨 → 音频轨（预留）→ 镜头轨，同一横向滚动容器内列对齐；
 *  每轨左侧窄 gutter（sticky）负责折叠，无文字轨头，三轨紧贴。 */
export default function TimelineDock(p: Props) {
  const assets = useTrackOpen(p.stages.length > 0);
  const locsT = useTrackOpen(p.locations.length > 0);  // P1-3 场景轨
  const audio = useTrackOpen(p.audioClips.length > 0);  // P2-4 音频轨（TTS 旁白/配乐）
  const shotsT = useTrackOpen(p.shots.length > 0);
  /** 定妆图生成中的阶段（关掉弹窗也保留，轨道上可见） */
  const [busyStages, setBusyStages] = useState<Set<string>>(new Set());
  const setGenBusy = (id: string, busy: boolean) =>
    setBusyStages((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });

  /** 镜头轨拖拽排序：dragOrder=拖起的镜头 order，overOrder=当前悬停目标 */
  const [dragOrder, setDragOrder] = useState<number | null>(null);
  const [overOrder, setOverOrder] = useState<number | null>(null);
  /** 右键菜单（时长档位/停用/删除） */
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 正在提交轻剪辑的镜头（避免连点导致 order 竞争） */
  const [patching, setPatching] = useState<string | null>(null);
  /** P1-2 镜头右缘拖时长：实时预览秒数（提交前本地显示） */
  const [durDrag, setDurDrag] = useState<{ shotId: string; sec: number } | null>(null);

  /** P1-1 缩放：像素/秒。Ctrl+滚轮以光标为锚点，工具条 ±/适配全宽 */
  const [pxPerSec, setPxPerSec] = useState(PX_PER_SEC_DEFAULT);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const slotW = (s: ShotInfo) => Math.max(
    MIN_W,
    (durDrag?.shotId === s.id ? durDrag.sec : (s.duration_sec ?? 5)) * pxPerSec,
  );

  /** P1-2 镜头右缘拖时长：吸附整数秒、钳 1-15（与后端 patch_shot_timeline 一致），
   *  拖动中槽宽实时预览，松手才提交（避免拖动过程连发 PATCH）。 */
  const beginDurDrag = (e: React.MouseEvent, s: ShotInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startSec = Math.round(s.duration_sec ?? 5);
    let sec = startSec;
    setDurDrag({ shotId: s.id, sec });
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(1, Math.min(15,
        Math.round(startSec + (ev.clientX - startX) / pxPerSec)));
      if (next !== sec) { sec = next; setDurDrag({ shotId: s.id, sec }); }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDurDrag(null);
      if (sec !== startSec) void submit(s.id, { durationSec: sec });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** 缩放并保持锚点像素不动：anchorClientX 缺省则用视口中心 */
  const zoomTo = (next: number, anchorClientX?: number) => {
    const el = scrollRef.current;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (!el) { setPxPerSec(clamped); return; }
    const box = el.getBoundingClientRect();
    const anchor = anchorClientX ?? box.left + box.width / 2;
    // 锚点在内容坐标系里的位置（缩放前）
    const contentX = el.scrollLeft + (anchor - box.left);
    const ratio = clamped / pxPerSec;
    setPxPerSec(clamped);
    // 缩放后把同一内容点重新对回锚点（布局已按新比例重算，故乘 ratio）
    requestAnimationFrame(() => {
      el.scrollLeft = contentX * ratio - (anchor - box.left);
    });
  };

  /** Ctrl/⌘ + 滚轮缩放（不带修饰键时保留原生横向滚动） */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // deltaY<0 = 向上滚 = 放大
      zoomTo(pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pxPerSec]);

  // 点击空白/按 Esc 关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const submit = async (shotId: string, patch: {
    durationSec?: number; toOrder?: number; disabled?: boolean;
  }) => {
    setPatching(shotId);
    setMenu(null);
    try { await p.onPatchTimeline(shotId, patch); }
    finally { setPatching(null); }
  };

  const onDrop = (target: ShotInfo) => {
    if (dragOrder !== null && dragOrder !== target.order) {
      const src = p.shots.find((s) => s.order === dragOrder);
      if (src) submit(src.id, { toOrder: target.order });
    }
    setDragOrder(null); setOverOrder(null);
  };

  /** 资产卡拖放到镜头槽：把该资产加入本镜注入（ref_overrides add / add_loc）。
   *  custom 资产：默认按角色语义加入并自动归类为 character（拖到场景轨才归 location）。 */
  const onSlotAssetDrop = async (e: React.DragEvent, target: ShotInfo) => {
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return false;
    e.preventDefault();
    e.stopPropagation();
    setDragOrder(null); setOverOrder(null);
    if (target.is_special) { p.onToast("外部素材镜头不经生成，无需注入参考图"); return true; }
    try {
      const d = JSON.parse(raw) as {
        assetId: string | null; kind: string; name: string; imageUrl: string | null };
      const isLoc = d.kind === "location";
      // 已在注入集合中 → 幂等提示（effective = (L1 ∪ add) − remove）
      const ov = target.ref_overrides ?? {};
      const l1 = isLoc ? (target.location ? [target.location] : []) : target.characters;
      const adds = (isLoc ? ov.add_loc : ov.add) ?? [];
      const removes = (isLoc ? ov.remove_loc : ov.remove) ?? [];
      const present = new Set([...l1, ...adds].filter((c) => !removes.includes(c)));
      if (present.has(d.name)) {
        p.onToast(`「${d.name}」已在镜头 #${target.order} 的注入列表中`);
        return true;
      }
      await api.refOverrides(p.projectId, d.name, {
        addShotIds: [target.id], isLocation: isLoc });
      if (d.kind === "custom" && d.assetId) {
        await api.patchAsset(d.assetId, { kind: "character" });  // 自动归类（默认角色语义）
      }
      p.onPushUndo(`镜头 #${target.order} 加入「${d.name}」注入`, async () => {
        await api.refOverrides(p.projectId, d.name, {
          removeShotIds: [target.id], isLocation: isLoc });
        p.onOverridesChanged();
      });
      p.onToast(`✅ 「${d.name}」已加入镜头 #${target.order} 的参考图注入`
        + `${d.kind === "custom" ? "（已归类为角色资产）" : ""}`);
      p.onOverridesChanged();
    } catch (err) { p.onToast(String(err)); }
    return true;
  };

  // 按集分组（shots 已按 order 排序，同集连续）+ 集/镜头 → 像素区间映射（三轨共用坐标系）
  const groups: { ep: number; shots: ShotInfo[]; w: number; x: number }[] = [];
  for (const s of p.shots) {
    const last = groups[groups.length - 1];
    if (last && last.ep === s.episode) { last.shots.push(s); }
    else groups.push({ ep: s.episode, shots: [s], w: 0, x: 0 });
  }
  let x = 0;
  const shotRects: ShotRects = new Map();
  for (const g of groups) {
    g.w = g.shots.reduce((w, s) => w + slotW(s), 0) + (g.shots.length - 1) * GAP;
    g.x = x;
    // 每镜精确像素区间：资产轨据此按镜头对齐（而非按整集）
    let sx = x;
    for (const s of g.shots) {
      const w = slotW(s);
      shotRects.set(s.order, { x: sx, w });
      sx += w + GAP;
    }
    x += g.w + EP_GAP;
  }
  const totalW = groups.length ? x - EP_GAP : 0;
  const epTitle = (ep: number) => p.episodes.find((e) => e.order === ep)?.title ?? `第${ep}集`;

  /** 时间→像素映射（P1-1 刻度尺）：槽宽有 MIN_W 下限且集间有间距，
   *  故不能用 t*pxPerSec 直算，必须按真实槽位累计后在槽内线性插值，
   *  否则刻度会与镜头槽逐渐错位。 */
  const timeMarks: { sec: number; x: number }[] = [];
  {
    let accSec = 0;
    for (const g of groups) {
      for (const s of g.shots) {
        const r = shotRects.get(s.order)!;
        timeMarks.push({ sec: accSec, x: r.x });
        accSec += s.duration_sec ?? 5;
      }
    }
    timeMarks.push({ sec: accSec, x: totalW });
  }
  const totalSecs = timeMarks.length ? timeMarks[timeMarks.length - 1].sec : 0;
  /** 秒 → 像素（分段线性插值） */
  const secToX = (sec: number) => {
    if (timeMarks.length < 2) return 0;
    for (let i = 0; i < timeMarks.length - 1; i++) {
      const a = timeMarks[i], b = timeMarks[i + 1];
      if (sec >= a.sec && sec <= b.sec) {
        const span = b.sec - a.sec;
        return span <= 0 ? a.x : a.x + ((sec - a.sec) / span) * (b.x - a.x);
      }
    }
    return totalW;
  };

  /** P2-1 播放头：镜头内进度 → 像素（槽内线性插值，槽宽受 MIN_W 影响也不偏） */
  const playheadX = (() => {
    if (!p.playhead) return null;
    const r = shotRects.get(p.playhead.order);
    const s = p.shots.find((sh) => sh.order === p.playhead!.order);
    if (!r || !s) return null;
    const dur = Math.max(0.01, s.duration_sec ?? 5);
    return r.x + Math.min(1, p.playhead.offsetSec / dur) * r.w;
  })();

  /** 播放头跟随：播放中若跑出可视区则滚动跟上（贴右缘 1/5 处，接近剪辑软件手感） */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || playheadX == null) return;
    const view = playheadX + 34 - el.scrollLeft;  // 34 = gutter + lane 左 padding
    if (view < 0 || view > el.clientWidth - 40)
      el.scrollLeft = Math.max(0, playheadX + 34 - el.clientWidth / 5);
  }, [playheadX]);

  /** 刻度尺点击 → 定位镜头与镜内秒数并跳转（间隙处吸附最近镜头起点） */
  const onRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const cx = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best: { s: ShotInfo; off: number } | null = null;
    let bestD = Infinity;
    for (const g of groups) {
      for (const s of g.shots) {
        const r = shotRects.get(s.order)!;
        if (cx >= r.x && cx <= r.x + r.w) {
          const dur = Math.max(0.01, s.duration_sec ?? 5);
          best = { s, off: ((cx - r.x) / r.w) * dur };
          bestD = 0;
          break;
        }
        const d = Math.min(Math.abs(cx - r.x), Math.abs(cx - (r.x + r.w)));
        if (d < bestD) { bestD = d; best = { s, off: 0 }; }
      }
      if (bestD === 0) break;
    }
    if (best) {
      if (!best.s.video_url) { p.onToast(`镜头 #${best.s.order} 尚未生成，无法预览`); return; }
      p.onSeek(best.s, best.off);
    }
  };

  return (
    <section className={`dock ${p.maximized ? "maxed" : ""}`}>
      <button className="dock-max" title={p.maximized ? "还原 (Esc)" : "最大化时间轴"}
        onClick={p.onToggleMax}>{p.maximized ? "⤡" : "⛶"}</button>
      {/* 导出概览：与「🚀 快速导出」同一口径（镜头轨=唯一真源） */}
      <div className="dock-summary" title="导出即按镜头轨顺序拼接已生成且未停用的镜头">
        🎞 {p.exportCount} 段可导出 · {fmtTime(p.totalSec)}
      </div>
      {/* P1-1 缩放工具条：± / 适配全宽（Ctrl+滚轮同效） */}
      <div className="dock-zoom" title="Ctrl/⌘ + 滚轮 也可缩放">
        <button className="zoom-btn" title="缩小" disabled={pxPerSec <= ZOOM_MIN}
          onClick={() => zoomTo(pxPerSec / 1.3)}>−</button>
        <button className="zoom-btn" title="适配全宽"
          onClick={() => {
            const el = scrollRef.current;
            if (!el || totalSecs <= 0) return;
            // 预留 gutter 与集间距的余量，避免适配后仍出现横向滚动条
            const avail = el.clientWidth - 48 - groups.length * EP_GAP;
            zoomTo(avail / totalSecs);
          }}>⇔</button>
        <button className="zoom-btn" title="放大" disabled={pxPerSec >= ZOOM_MAX}
          onClick={() => zoomTo(pxPerSec * 1.3)}>＋</button>
      </div>
      <div className="dock-scroll" ref={scrollRef}>

        {/* P2-1 播放头：贯穿所有轨道的竖线（跟随预览器播放进度，非镜头预览时隐藏）
            34 = gutter(26) + lane 左 padding(8)，与三轨内容坐标系对齐 */}
        {playheadX != null && (
          <div className="stl-playhead" style={{ left: playheadX + 34 }}>
            <div className="stl-playhead-cap" />
          </div>
        )}

        {/* 时间刻度尺（P1-1）：按缩放自适应步长；P2-1 点击跳转到对应时刻 */}
        {groups.length > 0 && (
          <div className="dock-lane">
            <div className="lane-gutter mute" />
            <div className="lane-body">
              <div className="stl-ruler seekable" style={{ width: totalW }}
                title="点击跳转预览到该时刻" onClick={onRulerClick}>
                {(() => {
                  const step = pickTickStep(pxPerSec);
                  const ticks = [];
                  for (let t = 0; t <= totalSecs; t += step) {
                    ticks.push(
                      <div key={t} className="stl-tick" style={{ left: secToX(t) }}>
                        <span>{tickLabel(t)}</span>
                      </div>,
                    );
                  }
                  return ticks;
                })()}
              </div>
            </div>
          </div>
        )}

        {/* 集号色条（人物资产轨上边） */}
        {groups.length > 0 && (
          <div className="dock-lane">
            <div className="lane-gutter mute" />
            <div className="lane-body">
              <div className="stl-epbars" style={{ width: totalW }}>
                {groups.map((g, gi) => (
                  <div key={g.ep} className="stl-epbar"
                    style={{ left: g.x, width: g.w, background: EP_COLORS[gi % EP_COLORS.length] }}
                    title={epTitle(g.ep)}>
                    <span>{epTitle(g.ep)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 人物资产轨（最上） */}
        <div className="dock-lane">
          <div className="lane-gutter" title="人物资产轨" onClick={assets.toggle}>
            <span className={`dock-caret ${assets.open ? "open" : ""}`}>▶</span>
            <button className="gutter-btn" title="AI 识别换装" disabled={p.drafting}
              onClick={(e) => { e.stopPropagation(); p.onDraft(); }}>
              {p.drafting ? "⏳" : "✨"}
            </button>
          </div>
          {assets.open && p.stages.length > 0 && (
            <div className="lane-body">
              <CharacterTrack stages={p.stages} onRefresh={p.onRefreshStages} onToast={p.onToast}
                shotRects={shotRects} totalW={totalW}
                busyStages={busyStages} onGenBusy={setGenBusy}
                shots={p.shots} projectId={p.projectId}
                onOverridesChanged={p.onOverridesChanged}
                onPushUndo={p.onPushUndo} />
            </div>
          )}
        </div>

        {/* 场景轨（P1-3）：人物轨之下，与镜头轨同坐标系 */}
        <div className="dock-lane">
          <div className="lane-gutter" title="场景轨" onClick={locsT.toggle}>
            <span className={`dock-caret ${locsT.open ? "open" : ""}`}>▶</span>
          </div>
          {locsT.open && p.locations.length > 0 && (
            <div className="lane-body">
              <LocationTrack locations={p.locations} onToast={p.onToast}
                shotRects={shotRects} totalW={totalW}
                shots={p.shots} projectId={p.projectId}
                onOverridesChanged={p.onOverridesChanged}
                onPushUndo={p.onPushUndo} />
            </div>
          )}
        </div>

        {/* 音频轨（P2-4）：TTS 旁白 / 配乐段，锚定镜头坐标系 */}
        <div className="dock-lane">
          <div className="lane-gutter" title="音频轨" onClick={audio.toggle}>
            <span className={`dock-caret ${audio.open ? "open" : ""}`}>▶</span>
          </div>
          {audio.open && (
            <div className="lane-body">
              <AudioTrack clips={p.audioClips} ttsAvailable={p.ttsAvailable}
                onToast={p.onToast} shotRects={shotRects} totalW={totalW}
                shots={p.shots} projectId={p.projectId}
                onChanged={p.onAudioChanged} onSynth={p.onSynthTts}
                synthBusy={p.synthBusy} libClips={p.libClips}
                onPreview={p.onPreviewAudio} />
            </div>
          )}
        </div>

        {/* 镜头轨（最下）：单行 + 横向滚动 */}
        <div className="dock-lane">
          <div className="lane-gutter" title="镜头轨" onClick={shotsT.toggle}>
            <span className={`dock-caret ${shotsT.open ? "open" : ""}`}>▶</span>
          </div>
          {shotsT.open && groups.length > 0 && (
            <div className="lane-body">
              <div className="stl-groups">
                {groups.map((g) => (
                  <div key={g.ep} className="stl-row" style={{ width: g.w }}>
                    {g.shots.map((s) => (
                      <div key={s.id}
                        className={`stl-slot ${s.video_url ? "filled" : "empty"} ${p.selectedShotId === s.id ? "sel" : ""} ${s.stale ? "stale" : ""} ${s.status === "failed" ? "failed" : ""} ${s.disabled ? "off" : ""} ${s.is_special ? "special" : ""} ${overOrder === s.order ? "over" : ""} ${dragOrder === s.order ? "dragging" : ""}`}
                        style={{ width: slotW(s) }}
                        draggable={!patching && !durDrag}
                        onDragStart={() => setDragOrder(s.order)}
                        onDragOver={(e) => { e.preventDefault(); setOverOrder(s.order); }}
                        onDragLeave={() => setOverOrder((o) => (o === s.order ? null : o))}
                        onDrop={(e) => {
                          if (e.dataTransfer.types.includes("application/x-fw-asset")) { void onSlotAssetDrop(e, s); return; }
                          onDrop(s);
                        }}
                        onDragEnd={() => { setDragOrder(null); setOverOrder(null); }}
                        title={`#${s.order} ${s.duration_sec ?? "?"}s`
                          + `${s.is_special ? `\n🎬 外部素材：${s.special_name ?? s.script_ref}` : ""}`
                          + `${s.video_url ? "" : "（未生成，占位）"}`
                          + `${s.disabled ? "\n⛔ 已停用：不参与导出与生成" : ""}`
                          + `${s.status === "failed" ? "\n❌ 生成失败，可在镜头页重试" : ""}`
                          + `${s.refs_stale ? "\n↻ 参考图已变，可重新生成" : ""}`
                          + `\n${(s.is_special ? s.special_name ?? s.script_ref : s.script_ref).slice(0, 60)}`
                          + `\n\n拖动=改顺序 · 拖右缘=改时长(1-15s) · 右键=时长/停用`}
                        onClick={() => p.onSelectShot(s)}
                        onContextMenu={(e) => {
                          e.preventDefault(); e.stopPropagation();
                          setMenu({ shot: s, x: e.clientX, y: e.clientY });
                        }}>
                        {s.video_url
                          ? (s.thumb_url
                            ? <img src={api.mediaUrl(s.thumb_url)} alt={`镜头 #${s.order} 首帧预览`}
                              loading="lazy" decoding="async" draggable={false} />
                            /* 缩略图缺失（回填前的存量镜头）：显示已生成标记而非再挂 video */
                            : <span className="stl-slot-ok" title="已生成（缩略图待生成）">▣</span>)
                          : <span className="stl-slot-no">#{s.order}</span>}
                        <span className="stl-slot-dur">
                          {durDrag?.shotId === s.id ? `${durDrag.sec}s` : `${s.duration_sec ?? "?"}s`}
                        </span>
                        {s.is_special && <span className="stl-slot-badge" title="外部素材">🎬</span>}
                        {s.disabled && <span className="stl-slot-off">⛔</span>}
                        {patching === s.id && <span className="stl-slot-spin">⏳</span>}
                        {patching !== s.id && (s.status === "generating" || s.status === "prompting") && (
                          <span className="stl-slot-spin">⏳</span>
                        )}
                        {s.status === "failed" && <span className="stl-slot-fail">⚠</span>}
                        {s.refs_stale && s.status !== "failed" && (
                          <span className="stl-slot-stale-ref" title="参考图已变，可重新生成">↻</span>
                        )}
                        {/* P1-2 右缘拖时长把手（外部素材/停用镜头不提供：时长跟素材或不导出） */}
                        {!s.is_special && !s.disabled && (
                          <span className="stl-slot-durgrip" title="拖动改时长（吸附整数秒，1-15s）"
                            draggable={false}
                            onMouseDown={(e) => beginDurDrag(e, s)} />
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 镜头轨右键菜单：改时长 / 停用 / 删除（外部素材） */}
      {menu && (
        <div className="stl-menu" style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <div className="stl-menu-title">
            #{menu.shot.order} {menu.shot.is_special ? "🎬 外部素材" : "AI 镜头"}
          </div>
          <div className="stl-menu-sec">时长</div>
          {DUR_STEPS.map((d) => (
            <button key={d} className={`stl-menu-item ${menu.shot.duration_sec === d ? "on" : ""}`}
              onClick={() => submit(menu.shot.id, { durationSec: d })}>
              {d}s{menu.shot.duration_sec === d ? " ✓" : ""}
            </button>
          ))}
          <div className="stl-menu-sep" />
          <button className="stl-menu-item"
            onClick={() => submit(menu.shot.id, { disabled: !menu.shot.disabled })}>
            {menu.shot.disabled ? "✅ 恢复启用" : "⛔ 停用（不导出）"}
          </button>
          {menu.shot.is_special && (
            <button className="stl-menu-item danger"
              onClick={() => { const id = menu.shot.id; setMenu(null); p.onDeleteShot(id); }}>
              🗑 删除此外部素材
            </button>
          )}
        </div>
      )}
    </section>
  );
}

