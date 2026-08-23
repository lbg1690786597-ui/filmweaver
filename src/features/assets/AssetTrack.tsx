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

  onChanged: () => void;
  onPushUndo: (label: string, undo: () => Promise<void>) => void;
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
  const rows: AssetRow[] = useMemo(() => {
    if (p.kind === "character") {
      const byChar = new Map<string, AssetRow>();
      for (const st of p.stages) {
        if (!st.present_orders?.length) continue;
        let row = byChar.get(st.character_name);
        if (!row) {
          const asset = p.assets.find(
            (a) => a.kind === "character" && a.name === st.character_name);
          row = { key: st.character_name, name: st.character_name,
                  imageUrl: asset?.image_url ?? null, runs: [] };
          byChar.set(st.character_name, row);
        }
        for (const run of splitRuns(st.present_orders)) {
          row.runs.push({
            id: `${st.id}:${run[0]}`,
            from: run[0], to: run[run.length - 1],
            stageName: st.stage_name,
            stageId: st.virtual ? undefined : st.id,
            imageUrl: st.effective_image_url ?? st.image_url,
            manualAdd: (st.manual_add_orders ?? []).filter((o) => run.includes(o)),
            locked: st.status === "confirmed",
          });
        }
      }
      return [...byChar.values()];
    }

    if (p.kind === "location") {
      return p.locations
        .filter((l) => l.present_orders?.length)
        .map((l) => ({
          key: l.name, name: l.name, imageUrl: l.image_url,
          runs: splitRuns(l.present_orders).map((run) => ({
            id: `loc:${l.name}:${run[0]}`,
            from: run[0], to: run[run.length - 1],
            imageUrl: l.image_url,
            manualAdd: (l.manual_add_orders ?? []).filter((o) => run.includes(o)),
            locked: false,
          })),
        }));
    }

    // 参考资产轨：custom 类资产（无角色/场景绑定）
    return p.assets
      .filter((a) => a.kind === "custom")
      .map((a) => ({ key: a.id, name: a.name, imageUrl: a.image_url, runs: [] }));
  }, [p.kind, p.stages, p.locations, p.assets]);

  // ---- 改生效范围（拖边缘）----
  const applyEdge = async (row: AssetRow, run: AssetRun, edgeKind: "from" | "to", newOrder: number) => {
    const isLoc = p.kind === "location";
    const oldFrom = run.from, oldTo = run.to;
    const nf = edgeKind === "from" ? Math.min(newOrder, run.to) : run.from;
    const nt = edgeKind === "to" ? Math.max(newOrder, run.from) : run.to;
    if (nf === oldFrom && nt === oldTo) return;

    // 差集：新区间多出来的 → add；旧区间少掉的 → remove
    const inOld = (o: number) => o >= oldFrom && o <= oldTo;
    const inNew = (o: number) => o >= nf && o <= nt;
    const addIds: string[] = [], removeIds: string[] = [];
    const lo = Math.min(oldFrom, nf), hi = Math.max(oldTo, nt);
    for (let o = lo; o <= hi; o++) {
      const sh = orderToShot.get(o);
      if (!sh || sh.is_special) continue;
      if (inNew(o) && !inOld(o)) addIds.push(sh.id);
      if (!inNew(o) && inOld(o)) removeIds.push(sh.id);
    }
    if (!addIds.length && !removeIds.length) return;

    try {
      await api.refOverrides(p.projectId, row.name,
        { addShotIds: addIds, removeShotIds: removeIds, isLocation: isLoc });
      p.onPushUndo(`「${row.name}」生效范围 #${oldFrom}-#${oldTo} → #${nf}-#${nt}`,
        async () => {
          await api.refOverrides(p.projectId, row.name,
            { addShotIds: removeIds, removeShotIds: addIds, isLocation: isLoc });
          p.onChanged();
        });
      p.onToast(`「${row.name}」生效范围改为 #${nf}-#${nt}`);
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  const beginEdgeDrag = (e: React.MouseEvent, row: AssetRow, run: AssetRun, edgeKind: "from" | "to") => {
    e.preventDefault(); e.stopPropagation();
    if (run.locked) { p.onToast(`「${row.name}」该造型已确认，先解锁再调整`); return; }
    let latest = edgeKind === "from" ? run.from : run.to;
    setEdge({ runId: run.id, edge: edgeKind, order: latest });
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: MouseEvent) => {
      const lane = (e.target as HTMLElement).closest(".fw-at-lane");
      if (!lane) return;
      const r = lane.getBoundingClientRect();
      const sec = Math.max(0, (ev.clientX - r.left) / p.pxPerSec);
      const o = secToOrder(sec);
      if (o == null || o === latest) return;
      latest = o;
      setEdge({ runId: run.id, edge: edgeKind, order: o });
    };
    const onUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setEdge(null);
      void applyEdge(row, run, edgeKind, latest);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ---- 拖资产卡片进轨道 → 在落点镜头注入 ----
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
    if (sh.is_special) { p.onToast("外部素材镜头不参与 AI 参考注入"); return; }

    const name = row?.name ?? d.name;
    const isLoc = p.kind === "location";
    try {
      await api.refOverrides(p.projectId, name, { addShotIds: [sh.id], isLocation: isLoc });
      p.onPushUndo(`「${name}」注入镜头 #${order}`, async () => {
        await api.refOverrides(p.projectId, name, { removeShotIds: [sh.id], isLocation: isLoc });
        p.onChanged();
      });
      p.onToast(`「${name}」已注入镜头 #${order}（Ctrl+Z 可撤销）`);
      p.onChanged();
    } catch (err) { p.onToast(String(err)); }
  };

  const onLaneDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-fw-asset")) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sec = Math.max(0, (e.clientX - r.left) / p.pxPerSec);
    setDropOrder(secToOrder(sec));
  };

  // ---- 删除段 ----
  const removeRun = async (row: AssetRow, run: AssetRun) => {
    const ids: string[] = [];
    for (let o = run.from; o <= run.to; o++) {
      const sh = orderToShot.get(o);
      if (sh) ids.push(sh.id);
    }
    if (!ids.length) return;
    const isLoc = p.kind === "location";
    try {
      await api.refOverrides(p.projectId, row.name, { removeShotIds: ids, isLocation: isLoc });
      p.onPushUndo(`删除「${row.name}」#${run.from}-#${run.to} 注入段`, async () => {
        await api.refOverrides(p.projectId, row.name, { addShotIds: ids, isLocation: isLoc });
        p.onChanged();
      });
      p.onToast(`已删除「${row.name}」#${run.from}-#${run.to} 注入段（Ctrl+Z 可撤销）`);
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  // ---- 替换资产图（拖资产卡到段上）----
  // 旧 CharacterTrack 的核心能力之一：拖一张图到某个造型段 = 换这套造型的定妆图。
  // virtual 段（无 AssetStage 行，服务端合成出来的）没有 stage 可 patch，走 upsertAssetImage。
  const replaceStageImage = async (
    row: AssetRow, run: AssetRun, d: AssetDragData,
  ): Promise<boolean> => {
    if (!d.imageUrl) {
      // custom 资产没有图时，拖进来的意义是"归类"，不是换图
      if (d.kind === "custom" && d.assetId) {
        await api.patchAsset(d.assetId, { kind: p.kind === "location" ? "location" : "character" });
        p.onToast(`「${d.name}」已归类，可在「AI 图片」里生成图`);
        p.onChanged();
        return true;
      }
      p.onToast(`「${d.name}」还没有图——先在「AI 图片」里生成`);
      return true;
    }

    const stageId = run.stageId;
    const isVirtual = !stageId || run.id.startsWith("loc:");
    const prevImg = run.imageUrl ?? null;
    try {
      if (isVirtual) {
        await api.upsertAssetImage(p.projectId,
          p.kind === "location" ? "location" : "character", row.name, d.imageUrl);
      } else {
        await api.patchStage(stageId, { image_url: d.imageUrl });
      }
      if (d.kind === "custom" && d.assetId) {
        await api.patchAsset(d.assetId,
          { kind: p.kind === "location" ? "location" : "character" });
      }
      p.onPushUndo(`替换「${row.name}${run.stageName ? `·${run.stageName}` : ""}」参考图`,
        async () => {
          if (isVirtual) {
            if (prevImg) await api.upsertAssetImage(p.projectId,
              p.kind === "location" ? "location" : "character", row.name, prevImg);
          } else {
            await api.patchStage(stageId!, { image_url: prevImg ?? "" });
          }
          p.onChanged();
        });
      p.onToast(`已用「${d.name}」替换「${row.name}${run.stageName ? `·${run.stageName}` : ""}」的参考图`);
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
    return true;
  };

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
  const resetRun = async (row: AssetRow, run: AssetRun) => {
    const ids: string[] = [];
    for (let o = run.from; o <= run.to; o++) {
      const sh = orderToShot.get(o);
      if (sh) ids.push(sh.id);
    }
    if (!ids.length) return;
    try {
      await api.refOverrides(p.projectId, row.name,
        { resetShotIds: ids, isLocation: p.kind === "location" });
      p.onToast(`已重置「${row.name}」#${run.from}-#${run.to} 的人工调整，回到 AI 判定`);
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  // ---- 整段平移（按住段身拖动）----
  const beginMoveRun = (e: React.MouseEvent, row: AssetRow, run: AssetRun) => {
    if (run.locked) return;
    // 只在段身（非边缘手柄）按下时触发
    if ((e.target as HTMLElement).classList.contains("fw-at-edge")) return;
    const lane = (e.currentTarget as HTMLElement).parentElement;
    if (!lane) return;
    const startX = e.clientX;
    const span = run.to - run.from;
    let delta = 0;
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      const dxSec = (ev.clientX - startX) / p.pxPerSec;
      // 位移换算成"跨了几个镜头"：用平均镜头时长估，落点仍吸附到真实 order
      const startSec = (p.offsetMap.get(run.from) ?? 0) + dxSec;
      const target = secToOrder(Math.max(0, startSec));
      if (target == null) return;
      const d = target - run.from;
      if (d === delta) return;
      delta = d;
      moved = true;
      document.body.style.cursor = "grabbing";
    };
    const onUp = async () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!moved || delta === 0) return;
      const nf = Math.max(1, run.from + delta);
      const nt = nf + span;
      const addIds: string[] = [], removeIds: string[] = [];
      for (let o = run.from; o <= run.to; o++) {
        const sh = orderToShot.get(o);
        if (sh && (o < nf || o > nt)) removeIds.push(sh.id);
      }
      for (let o = nf; o <= nt; o++) {
        const sh = orderToShot.get(o);
        if (sh && !sh.is_special && (o < run.from || o > run.to)) addIds.push(sh.id);
      }
      if (!addIds.length && !removeIds.length) return;
      const isLoc = p.kind === "location";
      try {
        await api.refOverrides(p.projectId, row.name,
          { addShotIds: addIds, removeShotIds: removeIds, isLocation: isLoc });
        p.onPushUndo(`平移「${row.name}」#${run.from}-#${run.to} → #${nf}-#${nt}`,
          async () => {
            await api.refOverrides(p.projectId, row.name,
              { addShotIds: removeIds, removeShotIds: addIds, isLocation: isLoc });
            p.onChanged();
          });
        p.onToast(`「${row.name}」已平移到 #${nf}-#${nt}`);
        p.onChanged();
      } catch (err) { p.onToast(String(err)); }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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
      <div className="fw-at-empty" onDragOver={onLaneDragOver} onDrop={(e) => onLaneDrop(e)}>
        <KindIcon size={12} />
        {p.kind === "character" ? "尚无人物造型，可在「AI 图片」生成资产后拖到此处"
          : p.kind === "location" ? "尚无场景，拆解剧本后自动生成"
            : "把资产库里的图片拖到这里，作为该时间段的额外参考"}
      </div>
    );
  }

  return (
    <div className={`fw-at kind-${p.kind}`}>
      {rows.map((row) => (
        <div key={row.key} className="fw-at-row" style={{ height: p.rowHeight }}>
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
              const left = (p.offsetMap.get(from) ?? 0) * p.pxPerSec;
              const endStart = p.offsetMap.get(to) ?? 0;
              const width = Math.max(16, (endStart + durOf(to)) * p.pxPerSec - left);
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
                  onClick={() => p.onSelectRun({ ...run, from, to, rowName: row.name, kind: p.kind })}
                  onMouseDown={(e) => { if (e.button === 0) beginMoveRun(e, row, run); }}
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
                    onMouseDown={(e) => beginEdgeDrag(e, row, run, "from")} />
                  <span className="fw-at-edge right"
                    title="拖动改变生效终点（吸附到镜头边界）"
                    onMouseDown={(e) => beginEdgeDrag(e, row, run, "to")} />
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
