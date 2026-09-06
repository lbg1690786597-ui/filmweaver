/**
 * MosaicPanel — 马赛克/遮挡的侧边面板（V2.4，按剪映的分工重做）
 *
 * ## 这一版解决的问题
 *
 * 上一版面板是"另一套平行的数值编辑器"：只有 左/上/宽/高 四个百分比输入框，
 * 区域行标签写成 `像素化　35%,5% 30%×28%`。而画面上的 MosaicOverlay 早就
 * 支持 矩形 / 圆形 / 画笔 三种工具了，面板里的 MosaicRegion 类型甚至没有
 * shape / stroke / brushSize 字段。后果有三个，用户全都撞上了：
 *
 *  1. **看不到形状概念** —— 面板里既没有几何形也没有画笔，用户以为只能画方框
 *     （用户原话："预设几何形、画笔也都没有在这里展示"）；
 *  2. **读不懂** —— 一串百分比数字无法告诉用户"这个区域在画面哪儿、是什么形状"；
 *  3. **会改坏数据** —— 画笔区域的 stroke 是独立的点集，面板改 宽/高 时不同步
 *     缩放 stroke，笔迹当场与包围盒错位。dev 库里已有 3 条 brush 笔迹，
 *     真会被改坏。
 *
 * ## 现在的分工（剪映的逻辑）
 *
 *   画面 = 唯一的绘制场（拖出形状、涂抹、拖动缩放）
 *   面板 = 遥控器 + 清单：选工具、调效果、给快捷预设、列出所有区域并精确微调
 *
 * 工具/选中态经 canvasToolStore 与 MosaicOverlay 共享，两边始终同一个状态。
 *
 * ## 关于"参考剪映"
 *
 * 查证结果：**剪映根本没有独立的马赛克面板**。它的打码要么走 `特效 → 画面特效
 * → 基础 → 马赛克`（整屏，靠拖到某条轨道上方来限定作用素材），要么走
 * `贴纸 → 遮挡` 贴马赛克贴纸，范围则由 `画面 → 蒙版` 界定；画笔只存在于
 * `抠像 → 自定义抠像`，不能直接刷出马赛克。也就是说：
 *
 *   - 剪映**没有区域列表**，一个区域 = 一层素材 + 一条特效轨道；
 *   - 剪映**没有统一的效果类型切换器**，马赛克/模糊/色块是三个不同库里的对象。
 *
 * 所以本面板是**有意的超集**，不是复刻。唯一照搬的是参数命名：剪映能确认的
 * 马赛克参数叫「像素大小」（手机端「分辨率」），语义是方块大小而非不透明度，
 * 故这里的滑块按效果类型改名（像素 / 模糊），不再一律叫"强度"。
 *
 * 明确**不**照搬的：剪映蒙版面板顶部那个默认未勾选的启用复选框 —— 公认的新手
 * 陷阱（勾之前画面上什么都不会发生）。这里改成"点工具即进入绘制态"。
 */
import { useEffect, useRef, useState } from "react";
import {
  Plus, Trash2, Square, Circle, Brush, MousePointerClick, Diamond, Crosshair,
} from "lucide-react";
import type { TransformMeta, TransformPatchOpts } from "../../api";
import type { MosaicParams } from "../../render/model";
import { regionBoxAt } from "../../render/maskGroups";
import {
  kfsOf, kfCount, findKfIndexAt, insertKfAt, removeKfAt, retimeKf, trajectory,
  clearKfs, replaceKfs,
} from "../../lib/keyframeEdit";
import { ensureCached, localSources } from "../../lib/mediaCache";
import { openVideoFrameSource } from "../../lib/track/frameSource";
import { openWorkerMatcher } from "../../lib/track/nccClient";
import { runTrack } from "../../lib/track/track";
import { useCanvasToolStore } from "../../stores/canvasToolStore";
import type { MosaicStyle, MosaicTool } from "../../stores/canvasToolStore";
import "./MosaicPanel.css";

/** 区域类型来自 render/model.ts（唯一一份），本文件不再自抄一遍 */
type MosaicRegion = MosaicParams;

interface Props {
  shotId: string;
  transform: TransformMeta | null;
  /** 落库回调。拖强度滑块的中间值传 `{ staged: true }`
   *  （本地即时生效、真正的 PATCH 延后到松手，见 lib/stagedWrite.ts）。 */
  onPatchTransform: (
    tm: TransformMeta | Record<string, never>, opts?: TransformPatchOpts,
  ) => void;
  onToast: (m: string) => void;
  /**
   * 播放头在**该镜头内**的秒数；播放头不在本镜头时为 null。
   *
   * 走 props 而不是塞进 `canvasToolStore`：播放头的真源是 `App` 的 `playhead`
   * （`timeupdate` 每次刷新），在 store 里再存一份就是第二个真源，
   * 一旦两边不同步，「菱形说这里有关键帧、画面上却没有」这种错没人看得出来。
   */
  playheadSec: number | null;
  /** 镜头输出时长（秒），迷你时间条的横轴长度 */
  durationSec: number;
  /** 点迷你时间条上的关键帧 → 把播放头跳过去 */
  onSeekSec: (sec: number) => void;
  /**
   * 该镜头的视频素材 url（`ShotInfo.video_url`）。跟踪要读它的本地副本；
   * 没有素材时跟踪按钮直接禁用，而不是点下去才说"没画面"。
   */
  videoUrl: string | null;
  /** 素材入点秒（`ShotInfo.clip_in_sec`）。抽帧要用它把输出秒换回素材秒。 */
  clipInSec: number;
  /** 变速倍率。同上，只在抽帧那一步用到。 */
  speed: number | undefined;
}

const STYLE_LABEL: Record<MosaicStyle, string> = {
  pixel: "马赛克", gaussblur: "模糊", blackbox: "遮挡",
};

const SHAPE_LABEL: Record<MosaicTool, string> = {
  rect: "矩形", ellipse: "圆形", brush: "画笔",
};

const TOOLS: { id: MosaicTool; Icon: typeof Square; hint: string }[] = [
  { id: "rect",    Icon: Square, hint: "在画面上拖拽拉出矩形遮罩（快捷键 1）" },
  { id: "ellipse", Icon: Circle, hint: "在画面上拖拽拉出圆形遮罩，按住 Shift 锁正圆（快捷键 2）" },
  { id: "brush",   Icon: Brush,  hint: "在画面上按住涂抹，笔迹即遮罩；滚轮调笔刷大小（快捷键 3）" },
];

/**
 * 一键遮挡预设。
 *
 * 这些是**位置**预设，不是形状预设 —— 覆盖的是"我就想快点把脸/字幕挡掉"
 * 这类高频诉求，省去在画面上比划。名字按用途写（"人脸"而不是"上方 35%,5%"），
 * 用户不需要在脑子里把百分比翻译成画面位置。
 */
const PRESETS: { label: string; hint: string; region: MosaicRegion }[] = [
  { label: "人脸·上", hint: "画面上方的人脸位置，像素化",
    region: { x: 0.35, y: 0.05, w: 0.30, h: 0.28, style: "pixel", intensity: 60, shape: "ellipse" } },
  { label: "人脸·中", hint: "画面居中的人脸位置，像素化",
    region: { x: 0.35, y: 0.20, w: 0.30, h: 0.28, style: "pixel", intensity: 60, shape: "ellipse" } },
  { label: "字幕条", hint: "遮掉画面底部的硬字幕，纯黑",
    region: { x: 0.05, y: 0.82, w: 0.90, h: 0.14, style: "blackbox", intensity: 80, shape: "rect" } },
  { label: "左上角标", hint: "遮掉左上角台标，高斯模糊",
    region: { x: 0.00, y: 0.00, w: 0.25, h: 0.12, style: "gaussblur", intensity: 70, shape: "rect" } },
  { label: "右下水印", hint: "遮掉右下角水印，像素化",
    region: { x: 0.70, y: 0.85, w: 0.28, h: 0.13, style: "pixel", intensity: 50, shape: "rect" } },
  { label: "整屏柔化", hint: "整个画面轻微模糊",
    region: { x: 0.00, y: 0.00, w: 1.00, h: 1.00, style: "gaussblur", intensity: 30, shape: "rect" } },
];

const DEFAULT_REGION: Omit<MosaicRegion, "style" | "intensity" | "shape"> =
  { x: 0.25, y: 0.25, w: 0.50, h: 0.50 };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 把区域位置翻译成人话方位，比 `35%,5%` 好读得多 */
function positionWord(r: MosaicRegion): string {
  if (r.w > 0.95 && r.h > 0.95) return "整个画面";
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const v = cy < 0.34 ? "上" : cy > 0.66 ? "下" : "中";
  const h = cx < 0.34 ? "左" : cx > 0.66 ? "右" : "";
  if (v === "中" && h === "") return "画面中央";
  return `${v}${h || "方"}`;
}

/**
 * 区域缩略图 —— 16:9 小方块里按真实比例画出这个区域的位置和形状。
 * 一眼就能看出"哦这个是挡右下角的"，这是纯数字标签给不了的。
 */
function RegionThumb({ r, active }: { r: MosaicRegion; active: boolean }) {
  const W = 44, H = 25;
  const shape = r.shape ?? "rect";
  // 用 inline style 而不是 fill="var(--…)" —— CSS 变量写在 SVG 表现属性里
  // 在部分 WebView 上不解析，图形会退化成黑色。
  const paint = active ? "var(--c-accent)" : "var(--c-muted)";
  // 有关键帧时把**中心轨迹**画成折线：缩略图里一眼看出"它在动、往哪动"。
  // 静态区域下 `trajectory` 返回空数组，什么都不画。
  const traj = trajectory(r);
  return (
    <svg className="fw-mp-thumb" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={2}
        className="fw-mp-thumb-bg" />
      {shape === "ellipse" && (
        <ellipse cx={(r.x + r.w / 2) * W} cy={(r.y + r.h / 2) * H}
          rx={Math.max(1, (r.w / 2) * W)} ry={Math.max(1, (r.h / 2) * H)}
          style={{ fill: paint, fillOpacity: 0.55, stroke: paint, strokeWidth: 0.8 }} />
      )}
      {shape === "rect" && (
        <rect x={r.x * W} y={r.y * H}
          width={Math.max(1.5, r.w * W)} height={Math.max(1.5, r.h * H)}
          style={{ fill: paint, fillOpacity: 0.55, stroke: paint, strokeWidth: 0.8 }} />
      )}
      {shape === "brush" && r.stroke && r.stroke.length > 0 && (
        <path
          d={r.stroke.map((p, i) => `${i ? "L" : "M"}${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join("")}
          strokeLinecap="round" strokeLinejoin="round"
          style={{
            fill: "none", stroke: paint, strokeOpacity: 0.85,
            strokeWidth: Math.max(1.5, (r.brushSize ?? 0.1) * W),
          }} />
      )}
      {traj.length >= 2 && (
        <>
          <path className="fw-mp-thumb-traj"
            d={traj.map((p, i) => `${i ? "L" : "M"}${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join("")} />
          {traj.map((p, i) => (
            <circle key={i} className="fw-mp-thumb-tdot"
              cx={(p.x * W).toFixed(1)} cy={(p.y * H).toFixed(1)} r={1.1} />
          ))}
        </>
      )}
    </svg>
  );
}

/** 百分比数值输入（只用于矩形/圆形；画笔区域不给数值编辑，见下方说明） */
function PctInput({ label, value, onChange }: {
  label: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="fw-mp-field">
      <span className="fw-mp-field-label">{label}</span>
      <input type="number" min={0} max={100} step={1} className="fw-mp-num-input"
        value={Math.round(value * 100)}
        onChange={(e) => onChange(clamp01(Number(e.target.value) / 100))} />
      <span className="fw-mp-field-unit">%</span>
    </label>
  );
}

export default function MosaicPanel({
  shotId, transform, onPatchTransform, onToast, playheadSec, durationSec, onSeekSec,
  videoUrl, clipInSec, speed,
}: Props) {
  const mosaics: MosaicRegion[] = transform?.mosaics ?? [];

  const overlayMode      = useCanvasToolStore((s) => s.overlayMode);
  const setOverlayMode   = useCanvasToolStore((s) => s.setOverlayMode);
  const tool             = useCanvasToolStore((s) => s.mosaicTool);
  const setTool          = useCanvasToolStore((s) => s.setMosaicTool);
  const sel              = useCanvasToolStore((s) => s.mosaicSel);
  const setSel           = useCanvasToolStore((s) => s.setMosaicSel);
  const style            = useCanvasToolStore((s) => s.mosaicStyle);
  const setStyle         = useCanvasToolStore((s) => s.setMosaicStyle);
  const intensity        = useCanvasToolStore((s) => s.mosaicIntensity);
  const setIntensity     = useCanvasToolStore((s) => s.setMosaicIntensity);
  const brushSize        = useCanvasToolStore((s) => s.brushSize);
  const setBrushSize     = useCanvasToolStore((s) => s.setBrushSize);

  const drawing = overlayMode === "mosaic";
  /** 选中的区域（下标可能因删除而越界，取值时兜一下） */
  const selRegion = sel !== null ? mosaics[sel] ?? null : null;
  /** 效果控件此刻作用于谁：选中了就是那个区域，否则是"下次新建的默认值" */
  const effStyle = selRegion?.style ?? style;
  const effIntensity = selRegion?.intensity ?? intensity;

  /** 拖动中最后一次 stage 出去的值；松手时原样重发一遍做真落库（2.2）。
   *  ⚠️ 不在松手回调里从 mosaics 现算：拖动的 onChange 是连续事件，
   *  React 可能把最后一次渲染推迟到 pointerup 之后，那样会漏掉最后一格。 */
  const stagedRef = useRef<TransformMeta | Record<string, never> | null>(null);

  function save(next: MosaicRegion[], staged = false) {
    const payload = { ...(transform ?? {}), mosaics: next };
    stagedRef.current = staged ? payload : null;
    onPatchTransform(payload, staged ? { staged: true } : undefined);
  }

  /** 松手 / 键盘调完 / 失焦：把 stage 的值真正落库一次 */
  function commitStaged() {
    const v = stagedRef.current;
    stagedRef.current = null;
    // 只按了一下没拖动 → 没有待落库的值，不平白多发一笔 PATCH
    if (v) onPatchTransform(v);
  }

  /** 选工具 = 同时把画面切进绘制态，否则用户点了工具却发现画面上没反应 */
  function pickTool(t: MosaicTool) {
    setTool(t);
    setOverlayMode("mosaic");
  }

  function addPreset(preset: MosaicRegion) {
    const next = [...mosaics, { ...preset }];
    save(next);
    setSel(next.length - 1);
    setOverlayMode("mosaic");
  }

  function addManual() {
    const r: MosaicRegion = {
      ...DEFAULT_REGION, style, intensity,
      shape: tool === "brush" ? "rect" : tool,   // 画笔没法凭空生成笔迹，退回矩形
    };
    const next = [...mosaics, r];
    save(next);
    setSel(next.length - 1);
    setOverlayMode("mosaic");
    if (tool === "brush") onToast("画笔区域需要在画面上涂抹，已先加一个矩形");
  }

  function removeRegion(idx: number) {
    save(mosaics.filter((_, i) => i !== idx));
    if (sel === idx) setSel(null);
    else if (sel !== null && sel > idx) setSel(sel - 1);
  }

  function patchRegion(idx: number, patch: Partial<MosaicRegion>, staged = false) {
    save(mosaics.map((r, i) => (i === idx ? { ...r, ...patch } : r)), staged);
  }

  /** 改效果：选中了就改那个区域，没选中就改"下次新建"的默认值 */
  function applyStyle(s: MosaicStyle) {
    setStyle(s);
    if (sel !== null && mosaics[sel]) patchRegion(sel, { style: s });
  }
  /** 强度是滑块：拖动中只 stage（本地即时生效），松手由 commitStaged 落库 */
  function applyIntensity(v: number, staged = false) {
    setIntensity(v);
    if (sel !== null && mosaics[sel]) patchRegion(sel, { intensity: v }, staged);
  }

  /**
   * 平移画笔区域：包围盒和笔迹必须一起动。
   * 上一版直接改 x/y 不动 stroke，笔迹会当场脱离包围盒 —— 而导出时
   * ffmpeg 是按 stroke 相对包围盒的位置算 alpha 的（ffmpegCompiler.ts），
   * 错位后遮挡的就不是用户看到的那块了。
   */
  function moveRegion(idx: number, nx: number, ny: number) {
    const r = mosaics[idx];
    const x = clamp01(Math.min(nx, 1 - r.w));
    const y = clamp01(Math.min(ny, 1 - r.h));
    const dx = x - r.x, dy = y - r.y;
    patchRegion(idx, {
      x, y,
      stroke: r.stroke?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    });
  }

  /** 把一次区域级编辑写回列表 */
  function patchWhole(idx: number, next: MosaicRegion, staged = false) {
    save(mosaics.map((r, i) => (i === idx ? next : r)), staged);
  }

  /**
   * 菱形：播放头处**有**关键帧就删、**没有**就插。
   *
   * 只做**区域级一个**菱形（剪映是每个参数一个）：本项目的区域只有"位置 + 大小"
   * 这一组值，拆成四个菱形只会让用户在四个几乎总是同时变化的东西之间点来点去。
   */
  function toggleKf(idx: number) {
    const r = mosaics[idx];
    if (!r || playheadSec === null) return;
    const t = playheadSec;
    if (findKfIndexAt(r, t) >= 0) {
      patchWhole(idx, removeKfAt(r, t));
      onToast(`已删除 ${t.toFixed(1)}s 的关键帧`);
      return;
    }
    // 记的是**当前这一帧看到的框**，所以第一次点菱形画面不会有任何跳动
    patchWhole(idx, insertKfAt(r, t, regionBoxAt(r, t)));
    onToast(kfCount(r) === 0
      ? `已在 ${t.toFixed(1)}s 记录第一个关键帧，再到别处记一个就会动起来`
      : `已在 ${t.toFixed(1)}s 记录关键帧`);
  }

  function deleteKfAt(idx: number, tSec: number) {
    const r = mosaics[idx];
    if (!r) return;
    patchWhole(idx, removeKfAt(r, tSec));
    onToast(`已删除 ${tSec.toFixed(1)}s 的关键帧`);
  }

  /** 迷你时间条：横轴 = 0..durationSec */
  function kfTimeAt(clientX: number, bar: DOMRect): number {
    const u = bar.width > 0 ? (clientX - bar.left) / bar.width : 0;
    return clamp01(u) * durationSec;
  }

  /** 拖动中的那颗菱形。`kf` 会在撞车合并后被重新定位，见 onKfDotMove。 */
  const kfDragRef = useRef<{ region: number; kf: number; bar: DOMRect } | null>(null);
  /** 拖过就不再把随后的 click 当成"跳转到该关键帧"——否则松手时播放头会乱跳 */
  const kfMovedRef = useRef(false);

  function onKfDotDown(e: React.PointerEvent<HTMLButtonElement>, regionIdx: number, kfIdx: number) {
    if (e.button !== 0 || durationSec <= 0) return;
    const bar = (e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
    if (!bar) return;
    kfDragRef.current = { region: regionIdx, kf: kfIdx, bar };
    kfMovedRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onKfDotMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = kfDragRef.current;
    if (!d) return;
    const r = mosaics[d.region];
    if (!r) return;
    kfMovedRef.current = true;
    const t = kfTimeAt(e.clientX, d.bar);
    const next = retimeKf(r, d.kf, t, durationSec);
    // 拖到另一条头上时两条会合并，下标随之变化。按**时刻**重新定位被拖动的那条，
    // 否则接下来几个 move 事件会拖到邻居身上（一次拖动把两条都搅乱）。
    const ni = kfsOf(next).findIndex((k) => k.tSec === Math.max(0, Math.min(durationSec, t)));
    if (ni >= 0) d.kf = ni;
    patchWhole(d.region, next, true);
  }

  function onKfDotUp(e: React.PointerEvent<HTMLButtonElement>) {
    if (!kfDragRef.current) return;
    kfDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    commitStaged();
  }

  // ---------------------------------------------------------------- 运动跟踪
  /**
   * 跟踪是**显式动作**（对齐剪映）：用户点「开始跟踪」才跑，不在拖框时偷偷启动。
   * 面板里只留三件事——凑参数、报进度、把结果写回；算法与流程都在
   * `lib/track/`（纯函数 + 注入 I/O，能在 node 下被 `verify-track.ts` 真跑）。
   */
  const [tracking, setTracking] = useState<{ region: number; done: number; total: number } | null>(null);
  const trackAbortRef = useRef<{ aborted: boolean } | null>(null);

  // 换镜头 / 面板卸载时把在跑的跟踪掐掉：否则结果会写到**另一个镜头**的区域上
  // （`patchWhole` 闭包里捕获的是发起时那一份 mosaics）。
  useEffect(() => () => {
    if (trackAbortRef.current) trackAbortRef.current.aborted = true;
  }, [shotId]);

  /** 跟踪至少要这么长一段才有意义（低于它连两个采样点都排不出）。 */
  const MIN_TRACK_SPAN_SEC = 0.3;

  /**
   * 拿这个镜头素材的**本地** blob 地址。
   *
   * 顺序是「先看盘上有没有 → 没有才下载」。下载这一步是**用户显式点了跟踪**才做的，
   * 与 6.3 「不为了预览去下载」并不冲突：那条规则针对的是随手预览，
   * 而这里用户要的就是对这一个素材做一件重活。
   */
  async function localBlobFor(url: string): Promise<string | null> {
    const hit = await localSources.localBlobForCurrent(url);
    if (hit) return hit;
    const pid = localSources.currentProject();
    if (!pid) return null;
    try {
      await ensureCached(pid, url);
    } catch {
      return null;    // 下不下来就是没有；上层会如实告诉用户
    }
    return localSources.localBlobForCurrent(url);
  }

  async function startTrack(idx: number) {
    const r = mosaics[idx];
    if (!r || tracking) return;
    if (!videoUrl) { onToast("这个镜头还没有视频素材，没法跟踪"); return; }

    // 从**播放头**开始往后跟（剪映即此行为）：用户把框摆在哪一帧，就从哪一帧开始。
    const t0 = Math.max(0, Math.min(playheadSec ?? 0, durationSec));
    if (durationSec - t0 < MIN_TRACK_SPAN_SEC) {
      onToast("从播放头到镜头结尾太短了，先把播放头往前挪一点");
      return;
    }

    const signal = { aborted: false };
    trackAbortRef.current = signal;
    setTracking({ region: idx, done: 0, total: 0 });
    try {
      const blobUrl = await localBlobFor(videoUrl);
      if (signal.aborted) { onToast("已取消跟踪"); return; }
      if (!blobUrl) {
        // 说清楚"为什么不行"和"怎么才行"。浏览器里（`/fw/app/`）没有 plugin-fs，
        // 这条路根本不存在，含糊其辞只会让用户反复点。
        onToast("跟踪需要素材的本地副本，这里拿不到（网页版不支持，请用桌面客户端）");
        return;
      }
      const src = await openVideoFrameSource(blobUrl, { clipInSec, speed });
      try {
        const run = await runTrack(
          src, openWorkerMatcher, regionBoxAt(r, t0), t0, durationSec,
          {
            signal,
            onProgress: (done, total) => setTracking({ region: idx, done, total }),
          },
        );
        if (run.keyframes.length >= 2) {
          patchWhole(idx, replaceKfs(r, run.keyframes, {
            generatedAt: Date.now(),
            sampleFps: run.sampleFps,
            ok: run.ok,
            total: run.total,
          }));
        }
        // 成功与失败都只说这一句：它已经把「在哪儿、为什么、保住了什么」说全了
        onToast(run.message);
      } finally {
        src.close();
      }
    } catch (e) {
      if ((e as Error)?.name === "Aborted") onToast("已取消跟踪");
      else onToast(`跟踪没跑起来：${(e as Error)?.message ?? String(e)}`);
    } finally {
      trackAbortRef.current = null;
      setTracking(null);
    }
  }

  function cancelTrack() {
    if (trackAbortRef.current) trackAbortRef.current.aborted = true;
  }

  function clearTrack(idx: number) {
    const r = mosaics[idx];
    if (!r) return;
    patchWhole(idx, clearKfs(r));
    onToast("已清除该区域的关键帧，区域退回静态");
  }

  return (
    <div className="fw-mp">
      {/* ---- 1. 绘制工具：把三种形状摆在最显眼的位置 ---- */}
      <div className="fw-mp-sec-title">绘制工具</div>
      <div className="fw-mp-tools">
        {TOOLS.map(({ id, Icon, hint }) => (
          <button key={id} title={hint}
            className={`fw-mp-tool${tool === id && drawing ? " on" : ""}`}
            onClick={() => pickTool(id)}>
            <Icon size={15} />
            <span>{SHAPE_LABEL[id]}</span>
          </button>
        ))}
      </div>

      <div className={`fw-mp-tip${drawing ? " on" : ""}`}>
        {drawing ? (
          tool === "brush"
            ? "在预览画面上按住涂抹，滚轮调笔刷粗细"
            : `在预览画面上拖拽，拉出${SHAPE_LABEL[tool]}遮罩`
        ) : (
          <>点上面任一工具，即可在预览画面上直接绘制</>
        )}
      </div>

      {drawing && tool === "brush" && (
        <label className="fw-mp-field">
          <span className="fw-mp-field-label">笔刷</span>
          <input type="range" min={2} max={40} step={1} className="fw-mp-slider"
            value={Math.round(brushSize * 100)}
            onChange={(e) => setBrushSize(Number(e.target.value) / 100)} />
          <span className="fw-mp-field-unit">{Math.round(brushSize * 100)}</span>
        </label>
      )}

      {/* ---- 2. 效果 ---- */}
      <div className="fw-mp-sec-title">
        效果
        <span className="fw-mp-sec-note">
          {selRegion ? `编辑第 ${sel! + 1} 个区域` : "新建区域将使用"}
        </span>
      </div>
      <div className="fw-mp-style-row">
        {(["pixel", "gaussblur", "blackbox"] as MosaicStyle[]).map((s) => (
          <button key={s}
            className={`fw-mp-style-btn${effStyle === s ? " active" : ""}`}
            onClick={() => applyStyle(s)}>
            {STYLE_LABEL[s]}
          </button>
        ))}
      </div>
      {effStyle !== "blackbox" && (
        /* 参数名跟着效果走：马赛克调的是**方块大小**（剪映叫「像素大小」/手机端
           叫「分辨率」），模糊调的才是强度。上一版两种都叫「强度」，用户拖的时候
           不知道自己在改什么 —— 马赛克拖大了是格子变粗，不是变得更不透明。 */
        <label className="fw-mp-field"
          title={effStyle === "pixel"
            ? "马赛克方块的大小，越大越看不清"
            : "高斯模糊的强度，越大越糊"}>
          <span className="fw-mp-field-label">
            {effStyle === "pixel" ? "像素" : "模糊"}
          </span>
          <input type="range" min={10} max={100} step={5} className="fw-mp-slider"
            value={effIntensity}
            onChange={(e) => applyIntensity(Number(e.target.value), true)}
            onPointerUp={commitStaged}
            onPointerCancel={commitStaged}
            // 键盘调节（←→）没有 pointer 事件，靠 keyup / blur 收尾
            onKeyUp={commitStaged}
            onBlur={commitStaged} />
          <span className="fw-mp-field-unit">{effIntensity}</span>
        </label>
      )}

      {/* ---- 3. 一键遮挡 ---- */}
      <div className="fw-mp-sec-title">一键遮挡</div>
      <div className="fw-mp-presets">
        {PRESETS.map((p) => (
          <button key={p.label} className="fw-mp-preset-btn" title={p.hint}
            onClick={() => addPreset(p.region)}>
            {p.label}
          </button>
        ))}
      </div>

      {/* ---- 4. 区域清单 ---- */}
      <div className="fw-mp-sec-title">
        区域
        {mosaics.length > 0 && <span className="fw-mp-sec-note">{mosaics.length} 个</span>}
      </div>

      {mosaics.length === 0 ? (
        <div className="fw-mp-empty">
          还没有遮挡区域<br />
          用上面的工具在画面上画一个，或点「一键遮挡」
        </div>
      ) : (
        <div className="fw-mp-list">
          {mosaics.map((r, idx) => {
            const active = sel === idx;
            const shape = r.shape ?? "rect";
            const ks = kfsOf(r);
            const hitKf = active && playheadSec !== null ? findKfIndexAt(r, playheadSec) : -1;
            const busyTrack = tracking !== null && tracking.region === idx;
            // 进度按**采样点**算而不是按时间：跟丢会提前结束，按时间算出来的
            // 百分比会停在半路不动，看着像卡死。
            const trackPct = busyTrack && tracking.total > 0
              ? Math.round((tracking.done / tracking.total) * 100)
              : 0;
            return (
              <div key={idx} className={`fw-mp-item${active ? " active" : ""}`}>
                <button className="fw-mp-item-head"
                  title="点击在画面上选中该区域"
                  onClick={() => {
                    setSel(active ? null : idx);
                    if (!active) setOverlayMode("mosaic");
                  }}>
                  <RegionThumb r={r} active={active} />
                  <span className="fw-mp-item-text">
                    <span className="fw-mp-item-title">
                      {SHAPE_LABEL[shape]} · {STYLE_LABEL[r.style]}
                      {r.style !== "blackbox" && ` ${r.intensity}`}
                      {ks.length >= 2 && (
                        <span className="fw-mp-badge" title={`该区域在 ${ks.length} 个时刻之间移动`}>
                          动 · {ks.length}帧
                        </span>
                      )}
                      {ks.length === 1 && (
                        <span className="fw-mp-badge"
                          title="只有 1 个关键帧还不会动 —— 把播放头移到别的时刻再记一个">
                          ◇ 1帧
                        </span>
                      )}
                    </span>
                    <span className="fw-mp-item-sub">
                      {positionWord(r)} · {pct(r.w)}×{pct(r.h)}
                    </span>
                  </span>
                </button>
                <button className="fw-mp-del" title="删除该区域"
                  onClick={() => removeRegion(idx)}>
                  <Trash2 size={12} />
                </button>

                {active && (
                  <div className="fw-mp-item-body">
                    {shape === "brush" ? (
                      /* 画笔区域**不给宽高数值编辑**：包围盒和笔迹要同步缩放，
                         用输入框改一个数就会让两者错位（导出遮的和看到的不是同一块）。
                         缩放请到画面上拖控制点 —— 那条路径会同步缩放 stroke。 */
                      <div className="fw-mp-brush-note">
                        <MousePointerClick size={11} />
                        画笔区域的形状请在画面上拖拽调整，这里只提供位置微调
                      </div>
                    ) : null}
                    <div className="fw-mp-grid2">
                      <PctInput label="左" value={r.x}
                        onChange={(v) => moveRegion(idx, v, r.y)} />
                      <PctInput label="上" value={r.y}
                        onChange={(v) => moveRegion(idx, r.x, v)} />
                      {shape !== "brush" && <>
                        <PctInput label="宽" value={r.w}
                          onChange={(v) => patchRegion(idx, { w: Math.max(0.02, v) })} />
                        <PctInput label="高" value={r.h}
                          onChange={(v) => patchRegion(idx, { h: Math.max(0.02, v) })} />
                      </>}
                    </div>

                    {/* 羽化：让遮挡边缘柔和过渡。上限 40 而不是 100 —— 语义是
                        「占区域**短边**的百分比」，100% 意味着软边和区域一样宽，
                        整块糊成一团，没有可用性可言。 */}
                    <label className="fw-mp-field"
                      title="边缘柔化宽度，按该区域短边的百分比计算；0 = 硬边">
                      <span className="fw-mp-field-label">羽化</span>
                      <input type="range" min={0} max={40} step={1} className="fw-mp-slider"
                        value={Math.round(r.feather ?? 0)}
                        onChange={(e) => patchRegion(idx, { feather: Number(e.target.value) }, true)}
                        onPointerUp={commitStaged}
                        onPointerCancel={commitStaged}
                        onKeyUp={commitStaged}
                        onBlur={commitStaged} />
                      <span className="fw-mp-field-unit">{Math.round(r.feather ?? 0)}</span>
                    </label>

                    {/* 关键帧：区域级一个菱形 + 迷你时间条 */}
                    <div className="fw-mp-kfrow">
                      <button
                        className={`fw-mp-kfbtn${hitKf >= 0 ? " on" : ""}`}
                        disabled={playheadSec === null}
                        title={playheadSec === null
                          ? "把播放头移到本镜头内，才能记录关键帧"
                          : hitKf >= 0
                            ? `删除 ${ks[hitKf].tSec.toFixed(2)}s 处的关键帧`
                            : `在 ${playheadSec.toFixed(2)}s 记录当前位置`}
                        onClick={() => toggleKf(idx)}>
                        <Diamond size={11} fill={hitKf >= 0 ? "currentColor" : "none"} />
                        关键帧
                      </button>

                      <div className="fw-mp-kfbar"
                        title={ks.length
                          ? "菱形按时刻排布：点击跳转 · 拖动改时刻 · 右键删除"
                          : "移动播放头到想要的时刻，点左边的菱形记录一个关键帧"}
                        onPointerDown={(e) => {
                          // 只有点在**条的空白处**才跳播放头；点在菱形上由菱形自己处理
                          if (e.target === e.currentTarget && durationSec > 0) {
                            onSeekSec(kfTimeAt(e.clientX, e.currentTarget.getBoundingClientRect()));
                          }
                        }}>
                        {playheadSec !== null && durationSec > 0 && (
                          <div className="fw-mp-kfhead"
                            style={{ left: `${clamp01(playheadSec / durationSec) * 100}%` }} />
                        )}
                        {ks.map((k, ki) => (
                          <button key={ki}
                            className={`fw-mp-kfdot${ki === hitKf ? " on" : ""}`}
                            style={{ left: `${durationSec > 0 ? clamp01(k.tSec / durationSec) * 100 : 0}%` }}
                            title={`${k.tSec.toFixed(2)}s · 拖动改时刻 · 右键删除`}
                            onPointerDown={(e) => onKfDotDown(e, idx, ki)}
                            onPointerMove={onKfDotMove}
                            onPointerUp={onKfDotUp}
                            onPointerCancel={onKfDotUp}
                            onClick={() => {
                              // 刚拖完的那一下 click 不当成跳转，否则播放头会跟着乱跳
                              if (kfMovedRef.current) { kfMovedRef.current = false; return; }
                              onSeekSec(k.tSec);
                            }}
                            onContextMenu={(e) => { e.preventDefault(); deleteKfAt(idx, k.tSec); }} />
                        ))}
                      </div>

                      <span className="fw-mp-kfhint">
                        {ks.length === 0 ? "静态" : ks.length === 1 ? "1 帧" : `${ks.length} 帧`}
                      </span>
                    </div>

                    {/* 运动跟踪：显式动作，三态（可跟 / 跟踪中 / 已跟踪） */}
                    <div className="fw-mp-trkrow">
                      {busyTrack ? (
                        <>
                          <span className="fw-mp-trk-prog">
                            跟踪中 {trackPct}%
                          </span>
                          <button className="fw-mp-trk-cancel" onClick={cancelTrack}>
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="fw-mp-trk-btn"
                            disabled={!videoUrl || tracking !== null}
                            title={!videoUrl
                              ? "这个镜头还没有视频素材"
                              : "从播放头开始，逐帧跟住框里的内容；会替换该区域已有的关键帧"}
                            onClick={() => startTrack(idx)}>
                            <Crosshair size={11} />
                            {r.track ? "重新跟踪" : "开始跟踪"}
                          </button>
                          {r.track && (
                            <span className="fw-mp-trk-ok"
                              title={`采样 ${r.track.sampleFps} fps，跟到 ${r.track.ok}/${r.track.total} 个采样点`}>
                              ✓ 已跟踪 · {ks.length} 个关键帧
                            </span>
                          )}
                          {ks.length > 0 && (
                            <button className="fw-mp-trk-clear"
                              title="删掉该区域的全部关键帧，退回静态遮挡"
                              onClick={() => clearTrack(idx)}>
                              清除
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="fw-mp-actions">
        <button className="fw-mp-add-btn" onClick={addManual}
          title="在画面中央加一个默认大小的区域，再拖到需要的位置">
          <Plus size={13} /> 添加区域
        </button>
        {mosaics.length > 0 && (
          <button className="fw-mp-clear-btn"
            onClick={() => { save([]); setSel(null); onToast("已清除所有遮挡区域"); }}>
            清除全部
          </button>
        )}
      </div>
    </div>
  );
}
