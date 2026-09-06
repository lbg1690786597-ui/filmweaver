/**
 * CropZoomPanel — 取景：裁剪 + 画面（V2.4，按剪映的分组重做）
 *
 * ## 上一版为什么难用
 *
 * 1. **拖滑块没有任何反馈**（用户原话）。crop 只在 ffmpegCompiler 里被实现，
 *    预览层一行都没读它 —— 拖完画面纹丝不动，导出后才发现被裁了。
 *    已在 previewCss.transformToClipPath / transformToTransform 里补上，
 *    现在拖动即时可见。
 * 2. **比例预设写死了 16:9 素材**。"9:16 居中" 直接写 left/right = 0.28125，
 *    只有源画面正好是 16:9 时才对；4:3 素材上会裁歪。现在按真实 baseAspect 反算。
 * 3. **缩放滑块和画面上的控制点互相打架**。面板只写 scale，覆盖层读的却是
 *    scaleX ?? scale、写的是 scaleX/scaleY。用户一旦在画面上拖过边中点手柄
 *    （产生 scaleX ≠ scaleY），面板的缩放滑块就再也看不出效果了。
 *    现在缩放三个字段一起写。
 * 4. **少了旋转和镜像**。覆盖层能产生 rotate，面板里却没有对应控件，
 *    转歪了只能去画面上慢慢拖回来。
 *
 * ## 分组（剪映的分法）
 *
 *   裁剪：决定"从素材里取哪一块"（比例预设 + 四边 + 画面上拖裁剪框）
 *   画面：决定"取出来的画面在成片画布上怎么摆"（缩放 / 位置 / 旋转 / 镜像）
 *
 * 这两件事在剪映里就是分开的两组，合在一起用户分不清"我到底在裁素材还是在挪画面"。
 *
 * ## 落库时机（2.2）
 *
 * 滑块拖动中**即时生效**（画面跟手），但真正的 PATCH 延后到松手 ——
 * 改动前是每个 onChange 一次 PATCH，拖一次滑块几十上百笔请求。
 * 见 `lib/stagedWrite.ts`。按钮类（比例预设、90°、镜像、重置）是离散动作，仍立即落库。
 *
 * ## 对齐剪映时确认过的几点（多源一致）
 *
 * - 比例排第一个是**「自由」**，它只解开比例锁、**不清空裁切**；「原始」是另一个
 *   面板（画布比例）的概念，等于重置。这两个合成一个按钮会让锁了比例又精心拖过
 *   框的用户无路可退 —— 只能丢掉裁切才能回到自由构图。
 * - 旋转是**两层**：裁剪里的 ±45° 拉直（对地平线），和独立的 90° 步进按钮。
 *   连续 0–360 的单一滑块做不好对齐地平线这件事。
 * - 剪映的比例只有 `自由/1:1/3:4/4:3/16:9/9:16`，**没有 21:9 也不支持自定义**，
 *   这被用户当缺点吐槽。我们多给 21:9，是有意的超集，不跟随该限制。
 * - 剪映的裁剪是**模态弹窗**，我们做成侧边面板 + 画面上的裁剪框。保留了它
 *   "构图决策"与"连续微调"分开的划分，但不复刻弹窗（本产品右侧面板常驻）。
 */

import { useRef } from "react";
import { AlignCenter, RotateCcw, RotateCw, Crop,
         FlipHorizontal, FlipVertical, MousePointerClick } from "lucide-react";
import type { TransformMeta, TransformPatchOpts } from "../../api";
import { useCanvasToolStore } from "../../stores/canvasToolStore";
import "./CropZoomPanel.css";

interface CropState { left: number; top: number; right: number; bottom: number }
const DEFAULT_CROP: CropState = { left: 0, top: 0, right: 0, bottom: 0 };

interface Props {
  shotId: string;
  transform: TransformMeta | null;
  /** 落库回调。拖滑块的中间值传 `{ staged: true }`
   *  （本地即时生效、真正的 PATCH 延后到松手，见 lib/stagedWrite.ts）。 */
  onPatchTransform: (
    tm: TransformMeta | Record<string, never>, opts?: TransformPatchOpts,
  ) => void;
  onToast: (m: string) => void;
  /** 项目基准比例，形如 "16:9"。用于把比例预设换算成正确的四边裁切量 */
  baseAspect?: string;
}

/** "16:9" → 1.777…；解析失败退回 16:9（项目默认） */
function parseAspect(s: string | undefined): number {
  if (!s) return 16 / 9;
  const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return 16 / 9;
  const w = Number(m[1]), h = Number(m[2]);
  if (!(w > 0 && h > 0)) return 16 / 9;
  return w / h;
}

/**
 * 把目标宽高比换算成"居中裁切"的四边比例。
 *
 * 关键：结果取决于**源画面**的宽高比。上一版把 16:9 源写死进常量，
 * 换个比例的项目就全错了。这里按 src / target 的大小关系决定裁哪边：
 * 目标更"窄"就裁左右，目标更"宽"就裁上下。
 */
function centerCrop(srcAspect: number, targetAspect: number): CropState {
  if (targetAspect < srcAspect) {
    // 目标更窄 → 保留的宽度比例 = target/src，左右各裁一半
    const keep = targetAspect / srcAspect;
    const side = (1 - keep) / 2;
    return { left: side, right: side, top: 0, bottom: 0 };
  }
  // 目标更宽 → 裁上下
  const keep = srcAspect / targetAspect;
  const side = (1 - keep) / 2;
  return { left: 0, right: 0, top: side, bottom: side };
}

/**
 * 比例预设。
 *
 * 剪映的这一排是 `自由 / 1:1 / 3:4 / 4:3 / 16:9 / 9:16`，**没有** 21:9 ——
 * 想要 2.35:1 只能去新建项目时自定义画布尺寸，这一点被用户当成缺点吐槽。
 * 我们多给一个 21:9，属于有意的超集，不跟随这个限制。
 */
const RATIOS: { label: string; value: number }[] = [
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "1:1",  value: 1 },
  { label: "4:3",  value: 4 / 3 },
  { label: "3:4",  value: 3 / 4 },
  { label: "21:9", value: 21 / 9 },
];

/** 局部构图预设：不是改比例，是"只要画面的这一块" */
const PARTS: { label: string; crop: CropState; hint: string }[] = [
  { label: "上半",   crop: { left: 0, top: 0, right: 0, bottom: 0.5 },   hint: "只保留上半部分" },
  { label: "下半",   crop: { left: 0, top: 0.5, right: 0, bottom: 0 },   hint: "只保留下半部分" },
  { label: "左半",   crop: { left: 0, top: 0, right: 0.5, bottom: 0 },   hint: "只保留左侧画面" },
  { label: "右半",   crop: { left: 0.5, top: 0, right: 0, bottom: 0 },   hint: "只保留右侧画面" },
  { label: "去字幕", crop: { left: 0, top: 0, right: 0, bottom: 0.18 },  hint: "裁掉底部硬字幕区" },
];

function Slider({ label, value, min, max, step, unit, onChange, onCommit, title }: {
  label: string; value: number; min: number; max: number; step: number;
  unit: string; onChange: (v: number) => void;
  /** 松手 / 键盘调完 / 失焦：把拖动中 stage 的值真正落库一次（2.2） */
  onCommit?: () => void;
  title?: string;
}) {
  return (
    <div className="fw-czp-row" title={title}>
      <span className="fw-czp-label">{label}</span>
      <input type="range" min={min} max={max} step={step}
        value={value} className="fw-czp-slider"
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        // 拖出窗口、被系统手势打断等：同样要收尾，否则这次拖动只剩本地值
        onPointerCancel={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit} />
      <span className="fw-czp-val">{Math.round(value)}{unit}</span>
    </div>
  );
}

export default function CropZoomPanel({
  transform, onPatchTransform, onToast, baseAspect,
}: Props) {
  const tm = transform ?? {};
  const crop: CropState = (tm.crop as CropState | undefined) ?? { ...DEFAULT_CROP };
  const scale = tm.scale ?? 100;
  const x = tm.x ?? 0;
  const y = tm.y ?? 0;
  const rotate = tm.rotate ?? 0;

  const overlayMode    = useCanvasToolStore((s) => s.overlayMode);
  const setOverlayMode = useCanvasToolStore((s) => s.setOverlayMode);
  const cropRatio      = useCanvasToolStore((s) => s.cropRatio);
  const setCropRatio   = useCanvasToolStore((s) => s.setCropRatio);

  const srcAspect = parseAspect(baseAspect);
  const onCanvas = overlayMode === "cropzoom";

  // 裁切后仍保留的画面比例
  const visW = Math.max(0.01, 1 - crop.left - crop.right);
  const visH = Math.max(0.01, 1 - crop.top - crop.bottom);
  /** 裁切后的实际宽高比，用来判断哪个比例预设正在生效 */
  const curAspect = srcAspect * (visW / visH);

  const hasCrop = crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0;
  const hasPicture = scale !== 100 || x !== 0 || y !== 0 || rotate !== 0
    || !!tm.mirrorH || !!tm.mirrorV;

  /**
   * 旋转拆成两层（剪映的分法）：90° 步进是独立按钮，拉直是 ±45° 微调。
   * 这里把 rotate 分解成「最近的 90° 整数倍」+「残差」，拉直滑块只动残差 ——
   * 于是已经转过 90° 的镜头照样能拉直，两个控件互不打架。
   */
  const quarter = Math.round(rotate / 90) * 90;
  const straighten = rotate - quarter;   // 落在 [-45, 45]

  /** 拖动中最后一次 stage 出去的值；松手时原样重发一遍做真落库（2.2）。
   *  ⚠️ 不在松手回调里重算：拖动的 onChange 是连续事件，React 可能把
   *  最后一次渲染推迟到 pointerup 之后，重算会漏掉最后一格 ——
   *  而「松手后的最终值确实落库」正是本条的验收标准。 */
  const stagedRef = useRef<TransformMeta | Record<string, never> | null>(null);

  /** `staged`（2.2）：拖动中的中间值只在本地生效（App 会把未落库的值盖回
   *  detail.shots，画面照旧跟手），真正的 PATCH 延后到松手。
   *  改动前这里是**每个 onChange 一次 PATCH**，拖一次滑块几十上百笔。 */
  function patch(update: Partial<TransformMeta>, staged = false) {
    const payload = { ...tm, ...update } as TransformMeta;
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

  function applyRatio(r: number) {
    setCropRatio(r);
    patch({ crop: centerCrop(srcAspect, r) });
  }

  /**
   * 自由 = 只解开比例锁，**保留当前裁切**。
   *
   * 上一版把「自由」和「原始」合成了一个按钮（原始 = 解锁 + 清空裁切），
   * 于是锁了 9:16 又在画面上仔细拖过框的用户，想回到自由构图只能先把
   * 自己的裁切全部丢掉。剪映的这一排第一个就是「自由」，和「重置」是两件事。
   */
  function unlockRatio() {
    setCropRatio(null);
    onToast(hasCrop ? "已解除比例锁定，裁切保留" : "比例不限");
  }

  /**
   * 缩放必须三个字段一起写。
   *
   * 覆盖层拖边中点手柄时只写 scaleX 或 scaleY（单轴拉伸），而预览取的是
   * `scaleX ?? scale`。若这里只写 scale，用户拖过手柄之后再动这个滑块，
   * 画面完全不动 —— 又是一次"拖了没反馈"。写死三个字段等于"回到等比"。
   */
  function applyScale(v: number) {
    patch({ scale: v, scaleX: v, scaleY: v }, true);
  }

  function resetCrop() {
    patch({ crop: { ...DEFAULT_CROP } });
    setCropRatio(null);
    onToast("已重置裁剪");
  }

  function resetPicture() {
    patch({ scale: 100, scaleX: 100, scaleY: 100, x: 0, y: 0, rotate: 0,
            mirrorH: false, mirrorV: false });
    onToast("已重置画面");
  }

  /** 顺时针转 90°，超过 360 归零（剪映的「旋转」按钮就是这个行为） */
  function rotate90() {
    patch({ rotate: (Math.round(rotate) + 90) % 360 });
  }

  return (
    <div className="fw-czp">
      {/* ================= 裁剪 ================= */}
      <div className="fw-czp-section-title">
        裁剪
        <span className="fw-czp-section-note">从素材里取哪一块</span>
      </div>

      {/* 裁切示意图：和成片一致的取景框，蓝框内是保留区 */}
      <div className="fw-czp-preview" title="蓝框内为保留区域，框外会被裁掉">
        <div className="fw-czp-preview-outer"
          style={{ aspectRatio: `${srcAspect.toFixed(4)}` }}>
          <div className="fw-czp-preview-shadow top"    style={{ height: `${crop.top * 100}%` }} />
          <div className="fw-czp-preview-shadow bottom" style={{ height: `${crop.bottom * 100}%` }} />
          <div className="fw-czp-preview-shadow left"   style={{ width: `${crop.left * 100}%` }} />
          <div className="fw-czp-preview-shadow right"  style={{ width: `${crop.right * 100}%` }} />
          <div className="fw-czp-preview-center"
            style={{
              left:   `${crop.left * 100}%`,
              top:    `${crop.top * 100}%`,
              width:  `${visW * 100}%`,
              height: `${visH * 100}%`,
            }}>
            <span className="fw-czp-preview-label">
              {curAspect >= 1
                ? `${curAspect.toFixed(2)} : 1`
                : `1 : ${(1 / curAspect).toFixed(2)}`}
            </span>
          </div>
        </div>
      </div>

      {/* 在画面上直接拖裁剪框 —— 和预览窗口下方那个小按钮是同一个开关 */}
      <button
        className={`fw-czp-canvas-btn${onCanvas ? " on" : ""}`}
        onClick={() => setOverlayMode(onCanvas ? null : "cropzoom")}>
        <MousePointerClick size={12} />
        {onCanvas ? "正在画面上调整，点此退出" : "在画面上直接拖拽调整"}
      </button>

      {/* 比例预设。「自由」只解锁不清空，「原始」才是清空 —— 见 unlockRatio 的说明 */}
      <div className="fw-czp-presets">
        <button
          className={`fw-czp-preset-btn${cropRatio === null ? " active" : ""}`}
          title="不限比例：在画面上可以任意拖拽裁剪框（当前裁切保留）"
          onClick={unlockRatio}>
          自由
        </button>
        {RATIOS.map((r) => {
          // 当前裁切结果与该比例接近就点亮（容差 1%，避免手动微调后全部熄灭）
          const active = Math.abs(curAspect - r.value) / r.value < 0.01;
          return (
            <button key={r.label}
              className={`fw-czp-preset-btn${active ? " active" : ""}`}
              title={`按 ${r.label} 居中裁剪（源画面 ${baseAspect ?? "16:9"}）`}
              onClick={() => applyRatio(r.value)}>
              {r.label}
            </button>
          );
        })}
        <button
          className={`fw-czp-preset-btn${!hasCrop ? " active" : ""}`}
          title="取消裁剪，恢复整幅画面"
          onClick={() => { setCropRatio(null); patch({ crop: { ...DEFAULT_CROP } }); }}>
          原始
        </button>
      </div>

      <div className="fw-czp-presets">
        {PARTS.map((p) => (
          <button key={p.label} className="fw-czp-preset-btn subtle" title={p.hint}
            onClick={() => { setCropRatio(null); patch({ crop: { ...p.crop } }); }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* 四边微调 */}
      {(["top", "bottom", "left", "right"] as const).map((side) => {
        const labels = { top: "上", bottom: "下", left: "左", right: "右" };
        const opposite = side === "top" ? "bottom" : side === "bottom" ? "top"
          : side === "left" ? "right" : "left";
        // 留 5% 的最小可见区，否则裁到 0 会得到空画面
        const maxVal = Math.max(0, 1 - crop[opposite] - 0.05);
        return (
          <div key={side} className="fw-czp-row">
            <span className="fw-czp-label">裁{labels[side]}</span>
            <input type="range" min={0} max={Math.round(maxVal * 100)} step={1}
              value={Math.round(crop[side] * 100)}
              className="fw-czp-slider"
              onChange={(e) => {
                setCropRatio(null);   // 手动改过就不再算作某个比例预设
                patch({ crop: { ...crop, [side]: Number(e.target.value) / 100 } }, true);
              }}
              onPointerUp={commitStaged}
              onPointerCancel={commitStaged}
              onKeyUp={commitStaged}
              onBlur={commitStaged} />
            <span className="fw-czp-val">{Math.round(crop[side] * 100)}%</span>
          </div>
        );
      })}

      {/* 拉直：剪映把旋转拆成两层，±45° 微调在裁剪面板里，90° 步进是独立按钮。
          放在裁剪组而不是画面组，是因为转正地平线之后必然要裁掉露出来的黑角，
          两个动作连着做。 */}
      <div className="fw-czp-row"
        title="对齐地平线用的微调（±45°）。整圈旋转请用下方「画面」组的 90° 按钮">
        <span className="fw-czp-label">拉直</span>
        <input type="range" min={-45} max={45} step={0.5}
          value={straighten} className="fw-czp-slider"
          onChange={(e) => {
            const v = Number(e.target.value);
            // 接近 0 时吸附归零：否则"看着是正的、其实差 0.5°"，导出才发现
            const snapped = Math.abs(v) < 1 ? 0 : v;
            patch({ rotate: Math.round((quarter + snapped) * 10) / 10 }, true);
          }}
          onPointerUp={commitStaged}
          onPointerCancel={commitStaged}
          onKeyUp={commitStaged}
          onBlur={commitStaged} />
        <span className="fw-czp-val">{straighten.toFixed(1)}°</span>
      </div>

      {hasCrop && (
        <button className="fw-czp-reset-link" onClick={resetCrop}>
          <RotateCcw size={10} /> 重置裁剪
        </button>
      )}

      {/* ================= 画面 ================= */}
      <div className="fw-czp-section-title">
        画面
        <span className="fw-czp-section-note">在成片画布上怎么摆</span>
      </div>

      <Slider label="缩放" value={scale} min={50} max={300} step={1} unit="%"
        title="等比缩放。会同时重置画面上单轴拉伸产生的不等比缩放"
        onChange={applyScale} onCommit={commitStaged} />
      {/* 单位是**画布百分比**不是像素：编辑期不知道会导 720p 还是 1080p，
          存像素等于让同一次调整在两种分辨率下把画面挪到不同的相对位置。
          ±100% = 整整推出画布一屏，够用且不会一拖就飞出去。 */}
      <Slider label="水平" value={x} min={-100} max={100} step={1} unit="%"
        title="相对画布宽度的偏移；100% = 向右推出整整一个画布宽"
        onChange={(v) => patch({ x: v }, true)} onCommit={commitStaged} />
      <Slider label="垂直" value={y} min={-100} max={100} step={1} unit="%"
        title="相对画布高度的偏移；100% = 向下推出整整一个画布高"
        onChange={(v) => patch({ y: v }, true)} onCommit={commitStaged} />
      <Slider label="旋转" value={rotate} min={-180} max={180} step={1} unit="°"
        onChange={(v) => patch({ rotate: v }, true)} onCommit={commitStaged} />

      <div className="fw-czp-btn-row">
        <button className="fw-czp-icon-btn" title="顺时针旋转 90°" onClick={rotate90}>
          <RotateCw size={12} /> 90°
        </button>
        <button className={`fw-czp-icon-btn${tm.mirrorH ? " on" : ""}`}
          title="水平镜像（左右翻转）"
          onClick={() => patch({ mirrorH: !tm.mirrorH })}>
          <FlipHorizontal size={12} /> 水平
        </button>
        <button className={`fw-czp-icon-btn${tm.mirrorV ? " on" : ""}`}
          title="垂直镜像（上下翻转）"
          onClick={() => patch({ mirrorV: !tm.mirrorV })}>
          <FlipVertical size={12} /> 垂直
        </button>
      </div>

      <div className="fw-czp-actions">
        {(x !== 0 || y !== 0) && (
          <button className="fw-czp-action-btn"
            onClick={() => { patch({ x: 0, y: 0 }); onToast("已居中对齐"); }}>
            <AlignCenter size={10} /> 居中
          </button>
        )}
        {hasPicture && (
          <button className="fw-czp-action-btn" onClick={resetPicture}>
            <RotateCcw size={10} /> 重置画面
          </button>
        )}
        {(hasCrop || hasPicture) && (
          <button className="fw-czp-action-btn"
            onClick={() => {
              patch({ crop: { ...DEFAULT_CROP }, scale: 100, scaleX: 100, scaleY: 100,
                      x: 0, y: 0, rotate: 0, mirrorH: false, mirrorV: false });
              setCropRatio(null);
              onToast("已重置取景");
            }}>
            <Crop size={10} /> 全部重置
          </button>
        )}
      </div>

      {/* 裁剪比例锁只影响画面上拖框的行为，这里给个状态提示，免得用户以为没生效 */}
      {cropRatio !== null && onCanvas && (
        <div className="fw-czp-lock-note">
          画面上的裁剪框已锁定为该比例，拖动时保持比例不变
        </div>
      )}
    </div>
  );
}
