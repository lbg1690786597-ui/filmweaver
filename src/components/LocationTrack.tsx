import { useRef, useState } from "react";
import { api, LocationInfo, ShotInfo } from "../api";
import { ShotRects } from "./CharacterTrack";
import AssetDialog, { AssetDialogTarget } from "./AssetDialog";

interface Props {
  locations: LocationInfo[];
  onToast: (m: string) => void;
  shotRects: ShotRects;
  totalW: number;
  /** P1-3 拖拽落库（is_location 通道）：与角色轨同一 ref-overrides 端点 */
  shots: ShotInfo[];
  projectId: string;
  onOverridesChanged: () => void;
  /** P2-2 撤销栈：注册可逆操作（拖拽的逆操作 = 反向 add/remove） */
  onPushUndo: (label: string, undo: () => Promise<void>) => void;
}

interface EdgeDrag {
  loc: string;
  side: "L" | "R";
  runFrom: number;
  runTo: number;
  curr: number;
}

/** 连续 order 段落合并（与 CharacterTrack.toRuns 同算法） */
function toRuns(orders: number[]): [number, number][] {
  if (!orders.length) return [];
  const sorted = [...orders].sort((a, b) => a - b);
  const runs: [number, number][] = [[sorted[0], sorted[0]]];
  for (const o of sorted.slice(1)) {
    const last = runs[runs.length - 1];
    if (o === last[1] + 1) last[1] = o;
    else runs.push([o, o]);
  }
  return runs;
}

/** P1-3 场景轨（单轨动态叠放）：全部场景共用一条轨，段 = 最终注入该场景参考图的
 *  连续镜头；同一时间重叠的场景段上下叠放（interval lane assignment），子行高 =
 *  原行高一半，轨总高随最大同时重叠数动态伸缩（与配角轨同规则）。
 *  与人物资产轨同一坐标系与拖拽契约（吸附镜头边界 → ref-overrides is_location 通道），
 *  人工段斜纹 + ↺ 重置；无参考图的场景段 ⚠ 提示（生成时不会有场景参考）。
 *  拖拽接收：资产卡拖到段上=替换该场景参考图；custom 资产拖到本轨=自动归类为场景资产。 */
export default function LocationTrack(p: Props) {
  const [drag, setDrag] = useState<EdgeDrag | null>(null);
  /** 统一资产详情弹窗（双击场景段打开） */
  const [dlg, setDlg] = useState<AssetDialogTarget | null>(null);
  const dragCtx = useRef<{
    rowEl: HTMLElement; eligible: number[]; present: Set<number>; loc: LocationInfo;
  } | null>(null);
  const orderToShot = new Map(p.shots.map((sh) => [sh.order, sh]));

  /** 资产卡拖放到场景段上：替换该场景参考图；custom 额外归类为场景资产 */
  const onSegAssetDrop = async (e: React.DragEvent, loc: LocationInfo) => {
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const d = JSON.parse(raw) as {
        assetId: string | null; kind: string; name: string; imageUrl: string | null };
      // 无图资产：不能替换图，但 custom 仍可归类（用户先定用途后生成）
      if (!d.imageUrl) {
        if (d.kind === "custom" && d.assetId) {
          await api.patchAsset(d.assetId, { kind: "location" });
          p.onToast(`✅ 「${d.name}」已归类为场景资产（尚无图，可在资产页点开生成）`);
          p.onOverridesChanged();
        } else {
          p.onToast(`「${d.name}」还没有图——点开资产卡片可直接生成`);
        }
        return;
      }
      const prevImg = loc.image_url;
      await api.upsertAssetImage(p.projectId, "location", loc.name, d.imageUrl);
      if (d.kind === "custom" && d.assetId) {
        await api.patchAsset(d.assetId, { kind: "location" });  // 自动归类
      }
      p.onPushUndo(`替换场景「${loc.name}」参考图`, async () => {
        if (prevImg) await api.upsertAssetImage(p.projectId, "location", loc.name, prevImg);
        p.onOverridesChanged();
      });
      p.onToast(`✅ 已用「${d.name}」替换场景「${loc.name}」参考图`
        + `${d.kind === "custom" ? "（已归类为场景资产）" : ""}`);
      p.onOverridesChanged();
    } catch (err) { p.onToast(String(err)); }
  };

  /** custom 资产拖放到轨道空白处：仅归类为场景资产 */
  const onLaneAssetDrop = async (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return;
    e.preventDefault();
    try {
      const d = JSON.parse(raw) as { assetId: string | null; kind: string; name: string };
      if (d.kind === "custom" && d.assetId) {
        await api.patchAsset(d.assetId, { kind: "location" });
        p.onToast(`✅ 「${d.name}」已归类为场景资产`);
        p.onOverridesChanged();
      }
    } catch (err) { p.onToast(String(err)); }
  };

  const runRect = (from: number, to: number): { left: number; width: number } | null => {
    const rects: { x: number; w: number }[] = [];
    for (let o = from; o <= to; o++) {
      const r = p.shotRects.get(o);
      if (r) rects.push(r);
    }
    if (!rects.length) return null;
    const left = Math.min(...rects.map((r) => r.x));
    const right = Math.max(...rects.map((r) => r.x + r.w));
    return { left, width: right - left };
  };

  /** 可拖入的镜头：全部 AI 镜头（场景无 ep 区间限制，外部素材不经生成不参与） */
  const eligibleOrders = (): number[] =>
    p.shots.filter((sh) => !sh.is_special).map((sh) => sh.order).sort((a, b) => a - b);

  const dragDiff = (d: EdgeDrag): { addOrders: number[]; removeOrders: number[] } => {
    const ctx = dragCtx.current;
    if (!ctx) return { addOrders: [], removeOrders: [] };
    const { eligible, present } = ctx;
    let addOrders: number[] = [];
    let removeOrders: number[] = [];
    if (d.side === "R") {
      if (d.curr > d.runTo)
        addOrders = eligible.filter((o) => o > d.runTo && o <= d.curr && !present.has(o));
      else if (d.curr < d.runTo)
        removeOrders = eligible.filter((o) => o > d.curr && o <= d.runTo && present.has(o));
    } else {
      if (d.curr < d.runFrom)
        addOrders = eligible.filter((o) => o >= d.curr && o < d.runFrom && !present.has(o));
      else if (d.curr > d.runFrom)
        removeOrders = eligible.filter((o) => o >= d.runFrom && o < d.curr && present.has(o));
    }
    return { addOrders, removeOrders };
  };

  const beginEdgeDrag = (e: React.MouseEvent, loc: LocationInfo,
                         side: "L" | "R", runFrom: number, runTo: number) => {
    e.preventDefault();
    e.stopPropagation();
    const rowEl = (e.currentTarget as HTMLElement).closest(".ctrack-row") as HTMLElement | null;
    if (!rowEl) return;
    dragCtx.current = {
      rowEl, eligible: eligibleOrders(),
      present: new Set(loc.present_orders ?? []), loc,
    };
    let curr = side === "L" ? runFrom : runTo;
    const state: EdgeDrag = { loc: loc.name, side, runFrom, runTo, curr };
    setDrag(state);

    const orderAt = (clientX: number): number => {
      const ctx = dragCtx.current;
      if (!ctx) return curr;
      const cx = clientX - ctx.rowEl.getBoundingClientRect().left;
      let best = curr;
      let bestD = Infinity;
      for (const o of ctx.eligible) {
        if (side === "L" && o > runTo) continue;
        if (side === "R" && o < runFrom) continue;
        const r = p.shotRects.get(o);
        if (!r) continue;
        const bx = side === "L" ? r.x : r.x + r.w;
        const d = Math.abs(bx - cx);
        if (d < bestD) { bestD = d; best = o; }
      }
      return best;
    };
    const onMove = (ev: MouseEvent) => {
      const next = orderAt(ev.clientX);
      if (next !== curr) { curr = next; setDrag({ ...state, curr }); }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      void commitEdgeDrag({ ...state, curr });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const commitEdgeDrag = async (d: EdgeDrag) => {
    const ctx = dragCtx.current;
    const { addOrders, removeOrders } = dragDiff(d);
    dragCtx.current = null;
    setDrag(null);
    if (!ctx || (!addOrders.length && !removeOrders.length)) return;
    try {
      const addIds = addOrders.map((o) => orderToShot.get(o)!.id);
      const removeIds = removeOrders.map((o) => orderToShot.get(o)!.id);
      const r = await api.refOverrides(p.projectId, ctx.loc.name, {
        addShotIds: addIds,
        removeShotIds: removeIds,
        isLocation: true,
      });
      const parts = [
        addOrders.length ? `+${addOrders.length} 镜注入` : "",
        removeOrders.length ? `−${removeOrders.length} 镜注入` : "",
      ].filter(Boolean).join(" · ");
      const locName = ctx.loc.name;
      // P2-2：逆操作 = 反向 add/remove（is_location 通道同样对消可逆）
      p.onPushUndo(`场景「${locName}」${parts}`, async () => {
        await api.refOverrides(p.projectId, locName, {
          addShotIds: removeIds, removeShotIds: addIds, isLocation: true,
        });
        p.onOverridesChanged();
      });
      p.onToast(`✅ 场景「${locName}」：${parts}`
        + `${r.stale.length ? `（${r.stale.length} 镜已出片，参考图已变可重新生成 ↻）` : ""}`
        + " · Ctrl+Z 可撤销");
      p.onOverridesChanged();
    } catch (e) { p.onToast(`❌ 场景参考调整失败：${String(e)}`); }
  };

  const resetOverrides = async (loc: string, orders: number[]) => {
    const ids = orders.map((o) => orderToShot.get(o)?.id).filter((x): x is string => !!x);
    if (!ids.length) return;
    try {
      await api.refOverrides(p.projectId, loc, { resetShotIds: ids, isLocation: true });
      p.onToast(`↺ 场景「${loc}」：${ids.length} 镜已重置为 AI 判定`);
      p.onOverridesChanged();
    } catch (e) { p.onToast(`❌ 重置失败：${String(e)}`); }
  };

  // ---- 单轨叠放：所有场景段做 interval lane assignment（与配角轨同算法）----
  const segs: { loc: LocationInfo; from: number; to: number; lane: number }[] = [];
  {
    const raw: { loc: LocationInfo; from: number; to: number }[] = [];
    for (const loc of p.locations)
      for (const [from, to] of toRuns(loc.present_orders ?? []))
        raw.push({ loc, from, to });
    raw.sort((a, b) => a.from - b.from || a.to - b.to);
    const laneEnds: number[] = [];
    for (const g of raw) {
      let li = laneEnds.findIndex((end) => end < g.from);
      if (li < 0) { li = laneEnds.length; laneEnds.push(g.to); }
      else laneEnds[li] = Math.max(laneEnds[li], g.to);
      segs.push({ ...g, lane: li });
    }
  }
  const laneCount = Math.max(1, segs.reduce((m, g) => Math.max(m, g.lane + 1), 1));
  const SUB_H = 24;   // 子行高 = 原行高(48px)的一半

  return (
    <section className="ctrack"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-fw-asset")) e.preventDefault(); }}
      onDrop={onLaneAssetDrop}>
      {segs.length > 0 && (
        <div className="ctrack-row sup" style={{
          width: p.totalW || undefined,
          height: laneCount * SUB_H + 8,
        }}>
          <span className="ctrack-name" title={`场景轨：${p.locations.length} 个场景`}>
            🏞 ×{p.locations.length}
          </span>
          {segs.map((g) => {
            const loc = g.loc;
            const rect = runRect(g.from, g.to);
            if (!rect) return null;
            const manualAdd = new Set(loc.manual_add_orders ?? []);
            const runManual: number[] = [];
            for (let o = g.from; o <= g.to; o++) if (manualAdd.has(o)) runManual.push(o);
            const isManual = runManual.length > 0;
            const dragging = drag && drag.loc === loc.name
              && drag.runFrom === g.from && drag.runTo === g.to;
            const diff = dragging ? dragDiff(drag) : null;
            const staleOrders: number[] = [];
            for (let o = g.from; o <= g.to; o++)
              if (orderToShot.get(o)?.refs_stale) staleOrders.push(o);
            const cls = `ctrack-stage loc sub ${loc.image_url ? "ok" : "noimg"}`
              + `${isManual ? " manual" : ""}${dragging ? " edge-dragging" : ""}`;
            return (
              <div key={`${loc.name}-${g.from}`} className={cls}
                style={{ position: "absolute", left: rect.left, width: rect.width,
                         top: 4 + g.lane * SUB_H, height: SUB_H - 4, minWidth: 0 }}
                title={`场景「${loc.name}」\n`
                  + `本段：镜头 #${g.from}-#${g.to}（${g.to - g.from + 1} 镜，生成时注入此场景参考图）\n`
                  + `${loc.image_url ? "" : "⚠ 此场景还没有参考图，生成时不会有场景参考\n"}`
                  + `${isManual ? `✋ 含 ${runManual.length} 镜人工加入（斜纹）· ↺ 可重置为 AI 判定\n` : ""}`
                  + `${staleOrders.length ? `↻ ${staleOrders.length} 镜已出片但参考图已变，可重新生成\n` : ""}`
                  + `⇤⇥ 拖左右边缘可增删注入范围（吸附镜头边界）· 双击编辑`}
                onDoubleClick={() => { if (!drag) setDlg({
                  kind: "location", name: loc.name, assetId: null,
                  stage: null, imageUrl: loc.image_url }); }}
                onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-fw-asset")) { e.preventDefault(); e.stopPropagation(); } }}
                onDrop={(e) => void onSegAssetDrop(e, loc)}>
                {loc.image_url && rect.width >= 36 && <img src={api.mediaUrl(loc.image_url)} alt="" />}
                {rect.width >= 56 && (
                  <span className="ctrack-stage-label">{loc.name}</span>
                )}
                {!loc.image_url && <span className="ctrack-stage-warn" title="缺场景参考图">⚠</span>}
                {staleOrders.length > 0 && (
                  <span className="ctrack-stage-stale"
                    title={`镜头 ${staleOrders.map((o) => `#${o}`).join(" ")} 已出片但参考图已变，可重新生成`}>↻</span>
                )}
                {isManual && (
                  <button className="ctrack-stage-reset" title="重置本段人工调整为 AI 判定"
                    onClick={(e) => { e.stopPropagation(); void resetOverrides(loc.name, runManual); }}>↺</button>
                )}
                <span className="ctrack-handle hl" title="拖动调整注入起点"
                  onMouseDown={(e) => beginEdgeDrag(e, loc, "L", g.from, g.to)} />
                <span className="ctrack-handle hr" title="拖动调整注入终点"
                  onMouseDown={(e) => beginEdgeDrag(e, loc, "R", g.from, g.to)} />
                {dragging && diff && (
                  <span className="ctrack-drag-tip">
                    {diff.addOrders.length > 0 && `＋${diff.addOrders.length} 镜`}
                    {diff.removeOrders.length > 0 && `−${diff.removeOrders.length} 镜`}
                    {diff.addOrders.length === 0 && diff.removeOrders.length === 0 && "无变化"}
                  </span>
                )}
              </div>
            );
          })}
          {drag && (() => {
            const start = drag.side === "L" ? drag.curr : drag.runFrom;
            const end = drag.side === "R" ? drag.curr : drag.runTo;
            const tgt = runRect(Math.min(start, end), Math.max(start, end));
            if (!tgt) return null;
            return <div className="ctrack-drag-ghost"
              style={{ left: tgt.left, width: tgt.width }} />;
          })()}
        </div>
      )}
      {/* 统一资产详情弹窗（双击场景段打开） */}
      {dlg && (
        <AssetDialog projectId={p.projectId} target={dlg} shots={p.shots}
          onClose={() => setDlg(null)} onToast={p.onToast}
          onChanged={p.onOverridesChanged} />
      )}
    </section>
  );
}

