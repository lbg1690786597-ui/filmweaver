/**
 * AssetTrack — AI 资产轨（PLAN §10-11，Phase 5）
 *
 * 这是 FilmWeaver 与普通 NLE 最大的区别：资产轨表达的不是"这段时间播什么"，
 * 而是**"这段时间 AI 生成该参考哪些资产"**。
 *
 * 三种轨：
 *   人物（按角色分行，段 = 该角色某个造型的生效镜头区间）
 *   场景（按归一场景名分行）
 *   参考资产（用户手动拖入的图，不绑角色/场景）
 *
 * 交互（全部落到后端 /v2/shots/ref-overrides）：
 *   拖资产库的卡片进来  → 在落点镜头注入
 *   拖段的左/右边缘     → 改生效镜头区间（增删两端的注入）
 *   右键段              → 查看/替换/删除/重生成受影响镜头
 *   点击段              → Inspector 显示"影响哪些镜头"（自然语言，不暴露 stage_id）
 *
 * 关键约束：这里的区间单位是**镜头 order**，不是秒。后端注入是按镜头算的，
 * 拖到"第 12.5 秒"没有意义——必须吸附到镜头边界，否则用户以为改了、实际没改。
 */

import { useCallback, useMemo, useState } from "react";
import {
  Eye, Replace, Trash2, RefreshCw, RotateCcw, Lock, Unlock, Plus, User, MapPin,
  Image as ImageIcon,
} from "lucide-react";
import { api } from "../../api";
import type { ShotInfo, StageInfo, LocationInfo, AssetInfo, AssetDragData } from "../../api";
import ContextMenu, { MenuItem } from "../../components/ContextMenu/ContextMenu";
import { replaceRunImage } from "./injectAsset";
import type { CommandDraft } from "../../lib/command";
import { inSpan } from "../timeline/virtual";
import type { SpanRange } from "../timeline/virtual";
// 3.12（F1）：资产段的三个手势（拖左边缘 / 拖右边缘 / 拖整段）与时间轴共用同一层
// —— 统一走 Pointer Events，拖动期间直接写 DOM 几何，见 gesture.ts 头注释。
import { beginGesture, stylePreview } from "../timeline/gesture";
// 3.13：本地台账。所有调整先记台账、画面立刻按台账画，落库是后台防抖的事。
import {
  displayOrdersOf, displayManualAddsOf, recordWithUndo,
  useAssetOverride, useAssetOverrideRev,
} from "../../stores/assetOverrideStore";
import type { AssetOverrideOp } from "./assetOverrides";
import { clampEdge, opsOf, runGeometry } from "./assetOverrides";
import "./AssetTrack.css";

export type AssetTrackKind = "character" | "location" | "reference";

/** 一行 = 一个角色 / 一个场景；行内是若干连续注入段 */
export interface AssetRow {
  key: string;
  name: string;
  imageUrl: string | null;
  /** 该行的所有注入段（连续 order 区间） */
  runs: AssetRun[];
}

export interface AssetRun {
  id: string;
  from: number;          // 起始镜头 order
  to: number;            // 结束镜头 order（含）
  stageName?: string;    // 造型名（人物轨）
  /** 对应 AssetStage.id；场景轨/虚拟段为空，此时换图走 upsertAssetImage */
  stageId?: string;
  imageUrl?: string | null;
  /** 该段中哪些 order 是人工加入的（画斜纹，区别于 AI 判定） */
  manualAdd: number[];
  locked: boolean;
}

/** 连续 order 切段：present_orders 可能不连续（角色中途没出场），
 *  画成一整条会让人以为中间那些镜头也注入了。 */
function splitRuns(orders: number[]): number[][] {
  if (!orders.length) return [];
  const s = [...orders].sort((a, b) => a - b);
  const runs: number[][] = [];
  let cur = [s[0]];
  for (let i = 1; i < s.length; i++) {
    if (s[i] === s[i - 1] + 1) cur.push(s[i]);
    else { runs.push(cur); cur = [s[i]]; }
  }
  runs.push(cur);
  return runs;
}

/** 段覆盖的 order 列表（只保留**真实存在**的镜头；特殊镜不参与资产注入）。
 *  台账按 order 记账，所有动作都得先摊成 order。 */
function ordersOf(run: { from: number; to: number }, isSpecial?: (o: number) => boolean): number[] {
  const out: number[] = [];
  for (let o = run.from; o <= run.to; o++) {
    if (isSpecial?.(o)) continue;
    out.push(o);
  }
  return out;
}

interface Props {
  kind: AssetTrackKind;
  shots: ShotInfo[];
  stages: StageInfo[];
  locations: LocationInfo[];
  assets: AssetInfo[];
  projectId: string;
  pxPerSec: number;
  /** order → 绝对起始秒 */
  offsetMap: Map<number, number>;
  /** 定位线所在镜头 order（联动高亮） */
  cursorOrder: number | null;
  rowHeight: number;
  /** 3.10：可见区间（lane 内像素）。资产段最坏是「每隔一镜出现一次」，
   *  段数与镜头数同量级，同样要虚拟化。 */
  span: SpanRange;

  onChanged: () => void;
  /** 3.7：redo 现在是**必传**的。缺了它 useUndo 会塞一个只弹
   *  「暂不支持重做」的桩，重做按钮亮着却点了没反应。 */
  /** C2：改收 `CommandDraft`（见 injectAsset.ts 的同名参数注释） */
  onPushUndo: (draft: CommandDraft) => void;
  onToast: (m: string) => void;
  onSelectRun: (run: AssetRun & { rowName: string; kind: AssetTrackKind }) => void;
  onRegenerate: (shotIds: string[]) => void;
  selectedRunId: string | null;
}

interface CtxState { x: number; y: number; row: AssetRow; run: AssetRun }
interface EdgeDrag { runId: string; edge: "from" | "to"; order: number }

export default function AssetTrack(p: Props) {
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [edge, setEdge] = useState<EdgeDrag | null>(null);
  const [dropOrder, setDropOrder] = useState<number | null>(null);

  const orderToShot = useMemo(
    () => new Map(p.shots.map((s) => [s.order, s])), [p.shots]);
  const durOf = useCallback(
    (order: number) => orderToShot.get(order)?.duration_sec ?? 5, [orderToShot]);

  /** 秒坐标 → 最近的镜头 order（拖拽落点吸附用） */
  const secToOrder = useCallback((sec: number): number | null => {
    let best: number | null = null;
    let bestD = Infinity;
    for (const [order, start] of p.offsetMap) {
      const d = Math.abs(start - sec);
      if (d < bestD) { bestD = d; best = order; }
    }
    return best;
  }, [p.offsetMap]);

  // ---- 组装行数据 ----
  // 3.13：行数据取自**本地台账投影后**的 order（`displayOrdersOf`），不是服务端
  // 底座。改完一段边缘，画面下一帧就该变 —— 不能等服务端算完再回来。`rev` 是
  // 台账版本号，用它当依赖才会重算。
  const rev = useAssetOverrideRev();
  const table = useAssetOverride((s) => s.table);
  const rows: AssetRow[] = useMemo(() => {
    void rev;   // 台账变了要重算（值本身不参与计算，只是触发）
    if (p.kind === "reference") {
      return p.assets
        .filter((a) => a.kind === "custom")
        .map((a) => ({ key: a.id, name: a.name, imageUrl: a.image_url, runs: [] }));
    }
    const isSpecial = (o: number) => !!orderToShot.get(o)?.is_special;
    const byName = new Map<string, AssetRow>();

    const mkRow = (name: string, imageUrl: string | null): AssetRow => {
      let row = byName.get(name);
      if (!row) { row = { key: name, name, imageUrl, runs: [] }; byName.set(name, row); }
      return row;
    };

    if (p.kind === "character") {
      /** 台账里被标成"人工加入"的 order（该角色） —— 服务端底座之外的本地意图 */
      const manualSet = (name: string): Set<number> => {
        const ops = opsOf(table, name);
        return new Set(ops.filter((o) => o.manual && o.present).map((o) => o.order));
      };

      for (const st of p.stages) {
        // ⚠️ 底座用的是**这一个造型**的 `present_orders`，不是整个角色的并集。
        // 并集会把两个造型的区间画成同一条（同一角色的不同造型区段会重叠），
        // 那正是 `splitRuns` 要避免的事。
        const base = st.present_orders ?? [];
        if (!base.length) continue;
        const name = st.character_name;
        const asset = p.assets.find((a) => a.kind === "character" && a.name === name);
        const row = mkRow(name, asset?.image_url ?? null);
        const shown = displayOrdersOf(base, p.projectId, name, isSpecial);
        const manual = displayManualAddsOf(base, shown, p.projectId, name);
        for (const r of splitRuns(shown)) {
          row.runs.push({
            id: `${st.id}:${r[0]}`,
            from: r[0], to: r[r.length - 1],
            stageName: st.stage_name,
            stageId: st.virtual ? undefined : st.id,
            imageUrl: st.effective_image_url ?? st.image_url,
            manualAdd: manual.filter((o) => r.includes(o)),
            locked: st.status === "confirmed",
          });
        }
      }

      // 台账里那些**不属于任何造型区段**的 order：第一次把某个角色注入进去时
      // 就是这种情况 —— 服务端还没有这一行，只按造型画的话用户的注入会
      // 完全看不见。单独合成一条「人工注入」段，坐标仍然精确到镜头。
      const covered = new Map<string, Set<number>>();
      for (const st of p.stages) {
        const s = covered.get(st.character_name) ?? new Set<number>();
        for (const o of st.present_orders ?? []) s.add(o);
        covered.set(st.character_name, s);
      }
      const names = new Set<string>([
        ...covered.keys(),
        ...p.assets.filter((a) => a.kind === "character").map((a) => a.name),
        ...Object.keys(table),
      ]);
      for (const name of names) {
        const cov = covered.get(name) ?? new Set<number>();
        const extra = displayOrdersOf([], p.projectId, name, isSpecial)
          .filter((o) => !cov.has(o));
        if (!extra.length) continue;
        const asset = p.assets.find((a) => a.kind === "character" && a.name === name);
        const row = mkRow(name, asset?.image_url ?? null);
        const manual = manualSet(name);
        for (const r of splitRuns(extra)) {
          row.runs.push({
            id: `local:${name}:${r[0]}`,
            from: r[0], to: r[r.length - 1],
            stageName: "人工注入",
            // 没有 AssetStage 行 → 换图走 upsertAssetImage（同场景轨的 virtual 段）
            stageId: undefined,
            imageUrl: asset?.image_url ?? null,
            manualAdd: r.filter((o) => manual.has(o)),
            locked: false,
          });
        }
      }
      return [...byName.values()];
    }

    // 场景轨
    for (const l of p.locations) {
      const base = l.present_orders ?? [];
      if (!base.length) continue;
      const row = mkRow(l.name, l.image_url);
      const shown = displayOrdersOf(base, p.projectId, l.name, isSpecial);
      const manual = displayManualAddsOf(base, shown, p.projectId, l.name);
      for (const r of splitRuns(shown)) {
        row.runs.push({
          id: `loc:${l.name}:${r[0]}`,
          from: r[0], to: r[r.length - 1],
          imageUrl: l.image_url,
          manualAdd: manual.filter((o) => r.includes(o)),
          locked: false,
        });
      }
    }
    const locNames = new Set<string>([...p.locations.map((l) => l.name), ...Object.keys(table)]);
    for (const name of locNames) {
      const extra = displayOrdersOf([], p.projectId, name, isSpecial);
      if (!extra.length) continue;
      const asset = p.assets.find((a) => a.name === name);
      const row = mkRow(name, asset?.image_url ?? null);
      for (const r of splitRuns(extra)) {
        row.runs.push({
          id: `local:loc:${name}:${r[0]}`,
          from: r[0], to: r[r.length - 1],
          imageUrl: asset?.image_url ?? null,
          manualAdd: [],
          locked: false,
        });
      }
    }
    return [...byName.values()];
  }, [p.kind, p.stages, p.locations, p.assets, p.projectId, orderToShot, rev]);

  // ---- 改生效范围（拖边缘）----
  /** 该行当前**生效**的操作（后写覆盖先写），用于算"要不要新增一条 op"。 */
  const effective = (rowName: string): Map<number, { present: boolean; manual: boolean }> => {
    const m = new Map<number, { present: boolean; manual: boolean }>();
    for (const o of opsOf(table, rowName)) m.set(o.order, { present: o.present, manual: o.manual });
    return m;
  };

  /**
   * 改生效范围。**只写本地台账** —— 不再 `await api.refOverrides`。
   *
   * 3.13 之前这里是真的发请求：于是每拖一下都要等一个来回，服务端算完返回前
   * 画面只能按旧值渲染 —— 用户报的"每次调整都会闪一下才到正确位置"就是这个。
   * 现在几何由台账投影直接决定，下一帧就是最终位置；落库交给 store 的防抖队列。
   *
   * `manual` 落在**被拖进来的那一端**：用户手动把边缘拖过去覆盖的镜头是"人工
   * 判定"，与 AI 拆解出来的区分开（画斜纹），右键"重置"才有东西可回。
   */
  const applyEdge = (
    row: AssetRow, run: AssetRun, edgeKind: "from" | "to", newOrder: number,
  ): void => {
    const anchor = edgeKind === "from" ? run.to : run.from;
    const nf = edgeKind === "from" ? Math.min(newOrder, anchor) : run.from;
    const nt = edgeKind === "to" ? Math.max(newOrder, anchor) : run.to;
    if (nf === run.from && nt === run.to) return;

    const manual = edgeKind === "from" ? nf === run.from : nt === run.to;
    const cur = effective(row.name);
    const ops: Omit<AssetOverrideOp, "at">[] = [];
    const lo = Math.min(run.from, nf), hi = Math.max(run.to, nt);
    for (let o = lo; o <= hi; o++) {
      const sh = orderToShot.get(o);
      if (!sh || sh.is_special) continue;          // 外部素材镜头不参与注入
      const inNew = o >= nf && o <= nt;
      const inOld = o >= run.from && o <= run.to;
      if (inNew === inOld) continue;
      const prev = cur.get(o);
      if (prev && prev.present === inNew) continue; // 台账已经表达了同一件事
      ops.push({ order: o, present: inNew, manual: inNew && manual });
    }
    if (!ops.length) return;

    const affected: string[] = [];
    for (let o = lo; o <= hi; o++) {
      const sh = orderToShot.get(o);
      if (sh) affected.push(sh.id);
    }
    recordWithUndo(
      `「${row.name}」生效范围 #${run.from}-#${run.to} → #${nf}-#${nt}`,
      row.name, ops, affected);
    p.onToast(`「${row.name}」生效范围改为 #${nf}-#${nt}`);
  };

  /** 段边缘的手势。**按下时一次性冻结几何**，之后全部基于这份冻结值算 ——
   *  每帧 `parseFloat(el.style.left)` 读回自己刚写的、已取整的值，误差会随
   *  拖动距离累加，就是用户报的"鼠标移动距离和段边缘有微小差异，越拖越明显"。 */
  const beginEdgeDrag = (
    e: React.PointerEvent, row: AssetRow, run: AssetRun, edgeKind: "from" | "to",
  ) => {
    e.preventDefault(); e.stopPropagation();
    if (run.locked) { p.onToast(`「${row.name}」该造型已确认，先解锁再调整`); return; }
    const self = e.currentTarget as HTMLElement;
    const lane = self.closest<HTMLElement>(".fw-at-lane") ?? self.parentElement;
    const el = self.closest<HTMLElement>(".fw-at-run");
    if (!lane || !el) return;
    const box = lane.getBoundingClientRect();
    const scroll0 = lane.scrollLeft;
    // 冻结几何：与渲染同一个函数、同一组入参（`run.from/to`），不是读回 DOM。
    const g0 = runGeometry(run.from, run.to, p.offsetMap, p.pxPerSec, durOf);
    // 一格的最小宽度：拖到极限时这一段至少还完整覆盖一镜
    const minSpan = durOf(edgeKind === "from" ? run.to : run.from) * p.pxPerSec / 2;
    const anchorPx = edgeKind === "from" ? g0.right : g0.left;
    // 指针相对**它抓的那条边**的偏移：拖的时候保持它不变，边就贴着指针走
    const grabOffset = e.clientX
      - (box.left - scroll0 + (edgeKind === "from" ? g0.left : g0.right));
    const pv = stylePreview(el);
    let latest = edgeKind === "from" ? run.from : run.to;
    let lastPx = edgeKind === "from" ? g0.left : g0.right;   // 最后算出的边缘 px（提交用）
    beginGesture(e.nativeEvent, {
      thresholdPx: 3,      // 误点不该改数据
      cursor: "ew-resize",
      onFrame: (g) => {
        const edgePx = (g.clientX - box.left + lane.scrollLeft) - grabOffset;
        const clamped = clampEdge(edgePx, edgeKind, anchorPx, minSpan);
        lastPx = clamped;
        // ① 跟手：直接写 DOM 几何，不等任何 state。
        if (edgeKind === "from") {
          pv.widthPx(g0.right - clamped, clamped - g0.left);
        } else {
          pv.widthPx(clamped - g0.left);
        }
        // ② 离散的那部分（落点提示 + 松手提交用哪个 order）才碰 React。
        const o = secToOrder(Math.max(0, clamped / p.pxPerSec));
        if (o == null || o === latest) return;
        latest = o;
        setEdge({ runId: run.id, edge: edgeKind, order: o });
      },
      onCommit: () => {
        // 用**最后一帧算出的**边缘 px 吸附（不是指针位置），保证"看到哪就是哪"
        const o = secToOrder(Math.max(0, lastPx / p.pxPerSec));
        if (o != null) applyEdge(row, run, edgeKind, o);
      },
      onSettle: () => { pv.reset(); setEdge(null); },
    });
  };

  // ---- 拖资产卡片进轨道 → 在落点镜头注入 ----
  // 3.13：不再发请求，改成往本地台账写一条 `{order, present:true, manual:true}`。
  // 真正上传发生在"发起需要服务端的能力"那一刻（见 `flushAssetOverrides`）。
  //
  // ⚠️ 身份检查：拖进来的卡片是谁，就只注入谁。
  // 旧版 `name: row?.name ?? d.name` 把**落点行**的名字当成了资产名 ——
  // 把角色 A 的卡片拖到角色 B 的轨道上，会静默在 B 上注入 B 的造型图，
  // 用户看到的和自己拖的完全不是一回事。落到别的行上必须拒绝并说清原因。
  const onLaneDrop = async (e: React.DragEvent, row?: AssetRow) => {
    e.preventDefault();
    setDropOrder(null);
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return;
    let d: AssetDragData;
    try { d = JSON.parse(raw); } catch { return; }

    const lane = e.currentTarget as HTMLElement;
    const r = lane.getBoundingClientRect();
    const sec = Math.max(0, (e.clientX - r.left) / p.pxPerSec);
    const order = secToOrder(sec);
    if (order == null) { p.onToast("请拖到某个镜头上方"); return; }
    const sh = orderToShot.get(order);
    if (!sh) return;
    if (sh.is_special) { p.onToast("特殊镜不参与资产注入"); return; }

    // 卡片身份 vs 落点行身份
    if (row && d.kind === "character" && d.name !== row.name) {
      p.onToast(`「${d.name}」不能注入到「${row.name}」的轨道上 —— 请拖到「${d.name}」自己那一行`);
      return;
    }
    if (p.kind === "character" && d.kind !== "character") {
      p.onToast("人物轨只接受人物资产卡");
      return;
    }
    if (p.kind === "location" && d.kind !== "location") {
      p.onToast("场景轨只接受场景资产卡");
      return;
    }

    // 落点行没给（空轨的 onDrop）时用卡片自己的名字建行
    const name = row?.name ?? d.name;
    recordWithUndo(
      `注入「${name}」到镜头 #${order}`,
      name,
      [{ order, present: true, manual: true }],
      [sh.id]);
    p.onToast(`已把「${name}」注入镜头 #${order}`);
  };

  const onLaneDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-fw-asset")) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sec = Math.max(0, (e.clientX - r.left) / p.pxPerSec);
    setDropOrder(secToOrder(sec));
  };

  // ---- 删除段 ----
  // 台账记成「这一批 order 都不生效」，不再发请求、不再进 undo 网络栈。
  const removeRun = (row: AssetRow, run: AssetRun) => {
    const orders = ordersOf(run).filter((o) => {
      const sh = orderToShot.get(o);
      return !!sh && !sh.is_special;
    });
    if (!orders.length) return;
    recordWithUndo(
      `删除「${row.name}」#${run.from}-#${run.to} 注入段`,
      row.name,
      orders.map((o) => ({ order: o, present: false, manual: false })),
      orders.map((o) => orderToShot.get(o)!.id));
    p.onToast(`已删除「${row.name}」#${run.from}-#${run.to} 注入段（Ctrl+Z 可撤销）`);
  };

  // ---- 替换资产图（拖资产卡到段上）----
  // 旧 CharacterTrack 的核心能力之一：拖一张图到某个造型段 = 换这套造型的定妆图。
  // 3.11 起实现搬到 injectAsset.ts 的 replaceRunImage —— 指针拖拽那条通道
  // 也会落到段上（useAssetDrop.ts），两边必须走同一份实现，否则同一个手势
  // 会因为"从哪个通道拖过来"而行为不同。
  const replaceStageImage = (
    row: AssetRow, run: AssetRun, d: AssetDragData,
  ): Promise<boolean> => replaceRunImage({
    projectId: p.projectId, rowName: row.name, d, run,
    isLocation: p.kind === "location",
    onPushUndo: p.onPushUndo, onToast: p.onToast, onChanged: p.onChanged,
  });

  /** 段上放下：优先当作"换图"，没有图信息才退回"注入" */
  const onRunDrop = async (e: React.DragEvent, row: AssetRow, run: AssetRun) => {
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();   // 别让 lane 的 onDrop 再当成"注入"处理一次
    try {
      const d: AssetDragData = JSON.parse(raw);
      await replaceStageImage(row, run, d);
    } catch (err) { p.onToast(String(err)); }
  };

  // ---- 重置人工覆写（回到 AI 拆解判定）----
  // 「回到 AI 判定」= 把这一行的本地台账整个抹掉，而不是给服务端发 reset。
  // 发 reset 的话，本地台账里还压着没落库的调账，等服务端回来又把它盖回去。
  const resetRun = (row: AssetRow, run: AssetRun) => {
    if (!opsOf(table, row.name).length) return;
    useAssetOverride.getState().clearRow(row.name);
    p.onToast(`已重置「${row.name}」#${run.from}-#${run.to} 的人工调整，回到 AI 判定`);
  };

  // ---- 整段平移（按住段身拖动）----
  //
  // 3.12（F1）：改走 `beginGesture`。旧版有三个毛病，而且这个手势是三个里最差的
  // —— 它**一个像素的预览都没有**：`onMove` 里只算出 `delta` 然后改光标，
  // 段全程钉在原地，松手才"啪"地跳过去。用户原话就是"拖动时看不到拖动位置，
  // 松手时素材块会突然移动到松手的位置"。
  //
  // 现在：段直接跟着指针 `transform` 走（`stylePreview`），落点仍吸附到真实
  // 镜头边界 —— 提交用的 `delta` 一直是**吸附后**的值，不会把段拖到半格上。
  const beginMoveRun = (e: React.PointerEvent, row: AssetRow, run: AssetRun) => {
    if (run.locked) return;
    // 只在段身（非边缘手柄）按下时触发
    if ((e.target as HTMLElement).classList.contains("fw-at-edge")) return;
    const lane = (e.currentTarget as HTMLElement).parentElement;
    const el = e.currentTarget as HTMLElement;
    if (!lane) return;
    const box = lane.getBoundingClientRect();
    const lane0 = lane.scrollLeft;

    // 3.13：按下时把几何**冻结**一次，之后所有换算都基于它。
    // 旧版每帧 `parseFloat(el.style.left)` 读的是被 `Math.round` 过的像素值，
    // 拿它反推"想在哪"会逐帧累积舍入误差 —— 拖得越长偏得越多，正是用户报的
    // 「鼠标移动距离和实际资产块边缘有微小的差异，移动距离越长越明显」。
    const g0 = runGeometry(run.from, run.to, p.offsetMap, p.pxPerSec, durOf);
    const grabOffset = e.clientX - (box.left - lane0 + g0.left);
    const span = run.to - run.from;
    // 可移区间：段整体不许移出镜头范围
    const orders = [...p.offsetMap.keys()].sort((a, b) => a - b);
    const minFrom = orders.length ? orders[0] : run.from;
    const maxFrom = orders.length ? orders[orders.length - 1] - span : run.from;
    // 提交用：跨了几个镜头（吸附后）
    let delta = 0;
    let moved = false;
    const pv = stylePreview(el);
    beginGesture(e.nativeEvent, {
      thresholdPx: 3,
      onFrame: (g) => {
        const px = g.clientX - (box.left - lane0) - grabOffset;   // 段左边缘**想**在的 px
        const sec = Math.max(0, px / p.pxPerSec);
        const target = secToOrder(sec);
        if (target == null) return;
        let d = target - run.from;
        d = Math.max(minFrom - run.from, Math.min(maxFrom - run.from, d));
        // ① 跟手：位移直接写 transform，不等 state、不量化到"格"。
        const startSec = p.offsetMap.get(run.from) ?? 0;
        pv.shiftPx(((p.offsetMap.get(run.from + d) ?? startSec) - startSec) * p.pxPerSec);
        // ② 离散部分：只有真的跨了一格才记，提交与 toast 都用它。
        if (d !== delta) { delta = d; moved = true; }
      },
      onCommit: () => {
        if (!moved || delta === 0) return;
        const nf = run.from + delta;
        const nt = nf + span;
        const cur = effective(row.name);
        const ops: Omit<AssetOverrideOp, "at">[] = [];
        const lo = Math.min(run.from, nf), hi = Math.max(run.to, nt);
        for (let o = lo; o <= hi; o++) {
          const sh = orderToShot.get(o);
          if (!sh || sh.is_special) continue;
          const inNew = o >= nf && o <= nt, inOld = o >= run.from && o <= run.to;
          if (inNew === inOld) continue;
          const prev = cur.get(o);
          if (prev && prev.present === inNew) continue;
          // 平移靠"人工搬过去"的那一端也算人工判定
          ops.push({ order: o, present: inNew, manual: inNew && (o < run.from || o > run.to) });
        }
        if (!ops.length) return;
        const affected: string[] = [];
        for (let o = lo; o <= hi; o++) {
          const sh = orderToShot.get(o);
          if (sh) affected.push(sh.id);
        }
        recordWithUndo(
          `平移「${row.name}」#${run.from}-#${run.to} → #${nf}-#${nt}`,
          row.name, ops, affected);
        p.onToast(`「${row.name}」已平移到 #${nf}-#${nt}`);
      },
      // 预览撤销：本地台账当场就出结果了，没有"等服务端渲染"这一步，
      // 下一帧 `rows` 重算后段就在新位置上，撤掉 transform 不会回跳。
      onSettle: () => { pv.reset(); },
    });
  };

  const menuItems = (row: AssetRow, run: AssetRun): MenuItem[] => {
    const affected: string[] = [];
    for (let o = run.from; o <= run.to; o++) {
      const sh = orderToShot.get(o);
      if (sh) affected.push(sh.id);
    }
    return [
      { id: "view", label: `查看资产「${row.name}」`, icon: <Eye size={12} />,
        onClick: () => p.onSelectRun({ ...run, rowName: row.name, kind: p.kind }) },
      { id: "replace", label: "替换参考图", icon: <Replace size={12} />,
        onClick: () => p.onToast("把「AI 图片」面板里的资产卡片拖到这个色块上即可替换") },
      { id: "sep1", label: "", separator: true },
      { id: "regen", label: `重新生成受影响的 ${affected.length} 个镜头`,
        icon: <RefreshCw size={12} />,
        disabled: !affected.length,
        onClick: () => p.onRegenerate(affected) },
      { id: "reset", label: "重置人工调整（回到 AI 判定）",
        icon: <RotateCcw size={12} />,
        disabled: !run.manualAdd.length,
        onClick: () => void resetRun(row, run) },
      { id: "sep2", label: "", separator: true },
      { id: "lock", label: run.locked ? "解锁造型" : "锁定造型",
        icon: run.locked ? <Unlock size={12} /> : <Lock size={12} />,
        disabled: p.kind !== "character" || !run.stageId,
        onClick: async () => {
          if (!run.stageId) return;
          try {
            await api.patchStage(run.stageId, { status: run.locked ? "draft" : "confirmed" });
            p.onToast(run.locked ? "已解锁，可继续调整" : "已锁定，AI 重识别不会覆盖");
            p.onChanged();
          } catch (e) { p.onToast(String(e)); }
        } },
      { id: "del", label: "删除此注入段", icon: <Trash2 size={12} />, danger: true,
        onClick: () => void removeRun(row, run) },
    ];
  };

  const KindIcon = p.kind === "character" ? User
    : p.kind === "location" ? MapPin : ImageIcon;

  if (!rows.length) {
    return (
      <div className="fw-at-empty" data-row-kind={p.kind}
        onDragOver={onLaneDragOver} onDrop={(e) => onLaneDrop(e)}>
        <KindIcon size={12} />
        {p.kind === "character" ? "尚无人物造型，可在「AI 图片」生成资产后拖到此处"
          : p.kind === "location" ? "尚无场景，拆解剧本后自动生成"
            : "把资产库里的图片拖到这里，作为该时间段的额外参考"}
      </div>
    );
  }

  return (
    <div className={`fw-at kind-${p.kind}`} data-row-kind={p.kind}>
      {rows.map((row) => (
        <div key={row.key} className="fw-at-row" data-row-name={row.name}
          data-row-kind={p.kind} style={{ height: p.rowHeight }}>
          {/* 行头：角色/场景名 + 缩略图（sticky 跟随横向滚动） */}
          <div className="fw-at-rowhead" title={row.name}>
            {row.imageUrl
              ? <img src={api.mediaUrl(row.imageUrl)} alt="" loading="lazy" />
              : <span className="fw-at-ph"><KindIcon size={10} /></span>}
            <span className="fw-at-rowname">{row.name}</span>
          </div>

          {/* 轨道内容：段 */}
          <div className="fw-at-lane"
            onDragOver={onLaneDragOver}
            onDragLeave={() => setDropOrder(null)}
            onDrop={(e) => onLaneDrop(e, row)}>
            {row.runs.map((run) => {
              // 拖边缘时用预览值，松手才提交
              const from = edge?.runId === run.id && edge.edge === "from"
                ? Math.min(edge.order, run.to) : run.from;
              const to = edge?.runId === run.id && edge.edge === "to"
                ? Math.max(edge.order, run.from) : run.to;
              // 3.13：渲染与手势共用同一个 `runGeometry`。旧版这里手算 left/width，
              // 手势里另有一套 `parseFloat(el.style.left)`，两套算法对"段在哪"的
              // 认识本来就不一致 —— 拖拽越久偏得越多。
              const geom = runGeometry(from, to, p.offsetMap, p.pxPerSec, durOf);
              const left = geom.left;
              const width = geom.width;
              // 3.10：视口外的段不进 DOM。正在拖边缘的那个例外——它可能被拖出
              // 视口，卸载了预览就没了（拖拽本身挂在 window 上不会断，
              // 于是表现为"段凭空消失、松手又回来"，不报任何错）。
              if (edge?.runId !== run.id
                && !inSpan([left, left + width], p.span)) return null;
              const hasCursor = p.cursorOrder != null
                && p.cursorOrder >= from && p.cursorOrder <= to;

              return (
                <div key={run.id}
                  className={[
                    "fw-at-run",
                    p.selectedRunId === run.id ? "selected" : "",
                    hasCursor ? "at-cursor" : "",
                    run.locked ? "locked" : "",
                    run.manualAdd.length ? "has-manual" : "",
                  ].filter(Boolean).join(" ")}
                  style={{ left, width }}
                  data-run-id={run.id}
                  data-run-stage-id={run.stageId ?? ""}
                  data-run-stage-name={run.stageName ?? ""}
                  data-run-image={run.imageUrl ?? ""}
                  onClick={() => p.onSelectRun({ ...run, from, to, rowName: row.name, kind: p.kind })}
                  onPointerDown={(e) => { if (e.button === 0) beginMoveRun(e, row, run); }}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes("application/x-fw-asset")) {
                      e.preventDefault(); e.stopPropagation();
                    }
                  }}
                  onDrop={(e) => void onRunDrop(e, row, run)}
                  onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, row, run }); }}
                  title={`${row.name}${run.stageName ? ` · ${run.stageName}` : ""}\n影响镜头 #${from}–#${to}（${to - from + 1} 个）`}>

                  {run.imageUrl && (
                    <img className="fw-at-run-img" src={api.mediaUrl(run.imageUrl)}
                      alt="" loading="lazy" draggable={false} />
                  )}
                  <span className="fw-at-run-label">
                    {run.stageName ?? row.name}
                  </span>
                  {run.locked && <Lock size={9} className="fw-at-run-lock" />}

                  {/* 左右边缘手柄：改生效范围 */}
                  <span className="fw-at-edge left"
                    title="拖动改变生效起点（吸附到镜头边界）"
                    onPointerDown={(e) => beginEdgeDrag(e, row, run, "from")} />
                  <span className="fw-at-edge right"
                    title="拖动改变生效终点（吸附到镜头边界）"
                    onPointerDown={(e) => beginEdgeDrag(e, row, run, "to")} />
                </div>
              );
            })}

            {/* 拖入落点提示 */}
            {dropOrder != null && (
              <div className="fw-at-dropmark"
                style={{
                  left: (p.offsetMap.get(dropOrder) ?? 0) * p.pxPerSec,
                  width: Math.max(16, durOf(dropOrder) * p.pxPerSec),
                }}>
                <Plus size={10} /> #{dropOrder}
              </div>
            )}
          </div>
        </div>
      ))}

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y}
          items={menuItems(ctx.row, ctx.run)}
          onClose={() => setCtx(null)} />
      )}
    </div>
  );
}
