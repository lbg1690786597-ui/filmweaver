import { useEffect, useRef, useState } from "react";
import { api, ShotInfo, StageInfo } from "../api";
import AssetDialog, { AssetDialogTarget } from "./AssetDialog";

/** 镜头 order → 轨道上的像素区间（由 TimelineDock 统一计算，三轨共用同一坐标系） */
export type ShotRects = Map<number, { x: number; w: number }>;

interface Props {
  stages: StageInfo[];
  onRefresh: () => void;
  onToast: (m: string) => void;
  /** 镜头 order → 像素区间（与镜头轨槽位严格对齐） */
  shotRects: ShotRects;
  totalW: number;
  /** 阶段生成中（按 stage id）：显示脉冲 + ⏳ */
  busyStages: Set<string>;
  onGenBusy: (stageId: string, busy: boolean) => void;
  /** P1-2 拖拽落库：镜头列表（order→id 映射与集归属）+ 项目 id + 变更后刷新 */
  shots: ShotInfo[];
  projectId: string;
  onOverridesChanged: () => void;
  /** P2-2 撤销栈：注册可逆操作（拖拽的逆操作 = 反向 add/remove） */
  onPushUndo: (label: string, undo: () => Promise<void>) => void;
}

/** P1-2 边缘拖拽会话：side=L 拖左缘 / R 拖右缘；curr=当前吸附到的边界 order */
interface EdgeDrag {
  stageId: string;
  side: "L" | "R";
  runFrom: number;
  runTo: number;
  curr: number;
}

/** 连续 order 段落合并：[1,2,3,7,8] → [[1,3],[7,8]]。
 *  注意"连续"以镜头 order 相邻为准，与实际时间轴相邻一致（order 全局递增）。 */
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

/** 人物资产轨：主角（≥2 造型阶段）每人一行；配角（单阶段）全部收进一条「配角轨」，
 *  同一时间重叠的配角段上下叠放（interval lane assignment），每层高度减半，
 *  轨道总高随同时在场的配角数动态伸缩（2 人=1 倍原高、3 人=1.5 倍）。
 *  段落 = 该角色在本阶段内**最终注入**的连续镜头（present_orders，含人工覆写）。
 *  P1-2：段左右边缘可拖（吸附镜头槽边界）→ 落库 ref_overrides；人工段画斜纹并可 ↺ 重置。
 *  拖拽接收：资产页卡片拖到段上=替换定妆图；custom 资产拖到本轨=自动归类为角色资产。 */
export default function CharacterTrack(p: Props) {
  /** 统一资产详情弹窗（双击轨道段打开；防止调覆盖范围时误触） */
  const [dlg, setDlg] = useState<AssetDialogTarget | null>(null);
  const openStageDlg = (s: StageInfo) => setDlg(s.virtual
    // 虚拟段（拖拽注入的无阶段角色）：无 AssetStage 行，走纯资产上下文（生成写回 Asset）
    ? { kind: "character", name: s.character_name, assetId: null,
        stage: null, imageUrl: s.image_url }
    : { kind: "character", name: s.character_name, assetId: null,
        stage: s, imageUrl: s.image_url });
  /** P1-2 进行中的边缘拖拽（渲染预览用）；静态上下文放 dragCtx（不触发重渲） */
  const [drag, setDrag] = useState<EdgeDrag | null>(null);
  const dragCtx = useRef<{
    rowEl: HTMLElement; eligible: number[]; present: Set<number>; stage: StageInfo;
  } | null>(null);

  const byChar = new Map<string, StageInfo[]>();
  for (const s of p.stages) {
    const arr = byChar.get(s.character_name) ?? [];
    arr.push(s);
    byChar.set(s.character_name, arr);
  }
  // 行序 = 出场镜头数降序（主角自然排最上），同数按名字稳定排序
  const charRows = [...byChar.entries()].sort((a, b) => {
    const ca = a[1].reduce((n, s) => n + (s.present_orders?.length ?? 0), 0);
    const cb = b[1].reduce((n, s) => n + (s.present_orders?.length ?? 0), 0);
    return cb - ca || a[0].localeCompare(b[0]);
  });
  // 主角 = ≥2 个造型阶段（独立一行）；其余单阶段配角全部进「配角轨」
  const mains = charRows.filter(([, sts]) => sts.length >= 2);
  const supports = charRows.filter(([, sts]) => sts.length < 2);

  // ---- 配角轨子行分配（interval lane assignment）----
  // 所有配角段按起点排序，贪心塞进「上一段已结束」的最浅子行；子行数=最大同时重叠数
  const supSegs: { stage: StageInfo; from: number; to: number; lane: number }[] = [];
  {
    const raw: { stage: StageInfo; from: number; to: number }[] = [];
    for (const [, sts] of supports)
      for (const s of sts)
        for (const [from, to] of toRuns(s.present_orders ?? []))
          raw.push({ stage: s, from, to });
    raw.sort((a, b) => a.from - b.from || a.to - b.to);
    const laneEnds: number[] = [];
    for (const g of raw) {
      let li = laneEnds.findIndex((end) => end < g.from);
      if (li < 0) { li = laneEnds.length; laneEnds.push(g.to); }
      else laneEnds[li] = Math.max(laneEnds[li], g.to);
      supSegs.push({ ...g, lane: li });
    }
  }
  const supLaneCount = Math.max(1, supSegs.reduce((m, g) => Math.max(m, g.lane + 1), 1));
  const SUB_H = 24;   // 配角子行高 = 主行(48px)的一半
  const orderToShot = new Map(p.shots.map((sh) => [sh.order, sh]));

  // ---- 段选中 + 复制/粘贴/删除 + 整段移动 ----
  const [sel, setSel] = useState<{ stageId: string; char: string; from: number; to: number } | null>(null);
  const clipRef = useRef<{ char: string } | null>(null);
  const [move, setMove] = useState<{ stageId: string; from: number; to: number;
    newFrom: number; newTo: number } | null>(null);
  const movedRef = useRef(false);   // 移动后抑制 click（防选中/弹窗误触）

  // 跨轨互斥：别的轨道选中时清掉本轨选中（Delete 只作用一个段）
  useEffect(() => {
    const onSel = (e: Event) => { if ((e as CustomEvent).detail !== "char") setSel(null); };
    window.addEventListener("fw-track-select", onSel);
    return () => window.removeEventListener("fw-track-select", onSel);
  }, []);
  const select = (s: StageInfo, from: number, to: number) => {
    window.dispatchEvent(new CustomEvent("fw-track-select", { detail: "char" }));
    setSel({ stageId: s.id, char: s.character_name, from, to });
  };

  /** 角色当前全部注入 orders（跨阶段并集，粘贴查重用） */
  const presentOf = (char: string): Set<number> => {
    const out = new Set<number>();
    for (const s of p.stages)
      if (s.character_name === char)
        for (const o of s.present_orders ?? []) out.add(o);
    return out;
  };

  /** 删除段 = 移除该角色在 [from..to] 的注入（可撤销） */
  const removeRun = async (char: string, from: number, to: number) => {
    const ids: string[] = [];
    for (let o = from; o <= to; o++) {
      const sh = orderToShot.get(o);
      if (sh) ids.push(sh.id);
    }
    if (!ids.length) return;
    try {
      await api.refOverrides(p.projectId, char, { removeShotIds: ids });
      p.onPushUndo(`删除「${char}」#${from}-#${to} 注入段`, async () => {
        await api.refOverrides(p.projectId, char, { addShotIds: ids });
        p.onOverridesChanged();
      });
      p.onToast(`🗑 已删除「${char}」#${from}-#${to} 注入段（Ctrl+Z 可撤销）`);
      p.onOverridesChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  /** 粘贴 = 把剪贴板角色注入到目标段范围（跳过已注入镜头，可撤销） */
  const pasteRun = async (char: string, from: number, to: number) => {
    const present = presentOf(char);
    const ids: string[] = [];
    const orders: number[] = [];
    for (let o = from; o <= to; o++) {
      const sh = orderToShot.get(o);
      if (sh && !sh.is_special && !present.has(o)) { ids.push(sh.id); orders.push(o); }
    }
    if (!ids.length) { p.onToast(`「${char}」已覆盖该范围，无需粘贴`); return; }
    try {
      await api.refOverrides(p.projectId, char, { addShotIds: ids });
      p.onPushUndo(`粘贴「${char}」到 #${from}-#${to}`, async () => {
        await api.refOverrides(p.projectId, char, { removeShotIds: ids });
        p.onOverridesChanged();
      });
      p.onToast(`📋 「${char}」已注入 #${from}-#${to}（${orders.length} 镜）`);
      p.onOverridesChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  // 快捷键：Delete 删段 / Ctrl+C 复制 / Ctrl+V 粘贴到选中段范围 / Esc 取消选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sel) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void removeRun(sel.char, sel.from, sel.to);
        setSel(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        clipRef.current = { char: sel.char };
        p.onToast(`📋 已复制「${sel.char}」——点选目标段后 Ctrl+V 粘贴注入`);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        if (clipRef.current) { e.preventDefault(); void pasteRun(clipRef.current.char, sel.from, sel.to); }
      } else if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, p.stages]);

  /** 拖资产卡落在「某主角的行」上（未命中具体段）：按落点镜头替换该角色该段的资产。
   *  角色资产/自定义 → 落点所在段替换定妆图（=onSegAssetDrop 语义）；无段落点时提示。 */
  const onRowAssetDrop = async (e: React.DragEvent, rowChar: string, rowStages: StageInfo[]) => {
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const d = JSON.parse(raw) as {
        assetId: string | null; kind: string; name: string; imageUrl: string | null };
      // 落点 → 镜头 order → 该角色覆盖此 order 的阶段
      const rowEl = e.currentTarget as HTMLElement;
      const cx = e.clientX - rowEl.getBoundingClientRect().left;
      let hitOrder: number | null = null;
      for (const [o, r] of p.shotRects) {
        if (cx >= r.x && cx <= r.x + r.w) { hitOrder = o; break; }
      }
      const hitStage = hitOrder != null
        ? rowStages.find((s) => (s.present_orders ?? []).includes(hitOrder!)) ?? null
        : null;
      if (hitStage) {   // 落在该角色已有覆盖上 → 替换该段资产
        await applyReplace(hitStage, d);
        return;
      }
      // 落在该角色行的空白处 → 把该镜头加入此角色注入（行语义：拖到谁的轨就是谁）
      if (hitOrder != null) {
        const sh = orderToShot.get(hitOrder);
        if (sh && !sh.is_special) {
          await api.refOverrides(p.projectId, rowChar, { addShotIds: [sh.id] });
          if (d.kind === "custom" && d.assetId) await api.patchAsset(d.assetId, { kind: "character" });
          p.onPushUndo(`「${rowChar}」注入镜头 #${hitOrder}`, async () => {
            await api.refOverrides(p.projectId, rowChar, { removeShotIds: [sh.id] });
            p.onOverridesChanged();
          });
          p.onToast(`✅ 「${rowChar}」已注入镜头 #${hitOrder}`);
          p.onOverridesChanged();
          return;
        }
      }
      p.onToast("请拖到轨道上的镜头范围内");
    } catch (err) { p.onToast(String(err)); }
  };

  /** 替换段资产的公共实现（onSegAssetDrop 与行落点共用） */
  const applyReplace = async (st: StageInfo, d: {
    assetId: string | null; kind: string; name: string; imageUrl: string | null }) => {
    if (!d.imageUrl) {
      if (d.kind === "custom" && d.assetId) {
        await api.patchAsset(d.assetId, { kind: "character" });
        p.onToast(`✅ 「${d.name}」已归类为角色资产（尚无图，可在资产页点开生成）`);
        p.onOverridesChanged();
      } else p.onToast(`「${d.name}」还没有图——点开资产卡片可直接生成`);
      return;
    }
    const prevImg = st.image_url;
    if (st.virtual) {
      await api.upsertAssetImage(p.projectId, "character", st.character_name, d.imageUrl);
    } else {
      await api.patchStage(st.id, { image_url: d.imageUrl });
    }
    if (d.kind === "custom" && d.assetId) await api.patchAsset(d.assetId, { kind: "character" });
    p.onPushUndo(`替换「${st.character_name}·${st.stage_name}」定妆图`, async () => {
      if (st.virtual) {
        if (prevImg) await api.upsertAssetImage(p.projectId, "character", st.character_name, prevImg);
      } else {
        await api.patchStage(st.id, { image_url: prevImg ?? "" });
      }
      p.onRefresh();
    });
    p.onToast(`✅ 已用「${d.name}」替换「${st.character_name}·${st.stage_name}」定妆图`
      + `${d.kind === "custom" ? "（已归类为角色资产）" : ""}`);
    p.onOverridesChanged();
  };

  /** 资产卡拖放到段上：替换定妆图；custom 资产额外归类为角色资产 */
  const onSegAssetDrop = async (e: React.DragEvent, st: StageInfo) => {
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return false;
    e.preventDefault();
    e.stopPropagation();
    try {
      const d = JSON.parse(raw) as {
        assetId: string | null; kind: string; name: string; imageUrl: string | null };
      await applyReplace(st, d);
    } catch (err) { p.onToast(String(err)); }
    return true;
  };

  /** custom 资产拖放到轨道空白处：仅归类（不动任何阶段图） */
  const onLaneAssetDrop = async (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return;
    e.preventDefault();
    try {
      const d = JSON.parse(raw) as { assetId: string | null; kind: string; name: string };
      if (d.kind === "custom" && d.assetId) {
        await api.patchAsset(d.assetId, { kind: "character" });
        p.onToast(`✅ 「${d.name}」已归类为角色资产`);
        p.onOverridesChanged();
      }
    } catch (err) { p.onToast(String(err)); }
  };

  /** 配角轨落卡：把拖入资产（它自己的角色）注入落点镜头——拖到配角轨=放在配角轨 */
  const onSupLaneAssetDrop = async (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData("application/x-fw-asset");
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const d = JSON.parse(raw) as {
        assetId: string | null; kind: string; name: string; imageUrl: string | null };
      const rowEl = e.currentTarget as HTMLElement;
      const cx = e.clientX - rowEl.getBoundingClientRect().left;
      let hitOrder: number | null = null;
      for (const [o, r] of p.shotRects) {
        if (cx >= r.x && cx <= r.x + r.w) { hitOrder = o; break; }
      }
      if (hitOrder == null) { p.onToast("请拖到轨道上的镜头范围内"); return; }
      const sh = orderToShot.get(hitOrder);
      if (!sh || sh.is_special) { p.onToast("外部素材镜头不参与注入"); return; }
      await api.refOverrides(p.projectId, d.name, { addShotIds: [sh.id] });
      if (d.kind === "custom" && d.assetId) await api.patchAsset(d.assetId, { kind: "character" });
      p.onPushUndo(`「${d.name}」注入镜头 #${hitOrder}`, async () => {
        await api.refOverrides(p.projectId, d.name, { removeShotIds: [sh.id] });
        p.onOverridesChanged();
      });
      p.onToast(`✅ 「${d.name}」已注入镜头 #${hitOrder}（配角轨）`);
      p.onOverridesChanged();
    } catch (err) { p.onToast(String(err)); }
  };

  /** 按住段身拖动 = 整段平移覆盖位置（松手提交 remove 旧 + add 新，可撤销）。
   *  从把手/长按边缘发起的拖不走这里；移动距离 <4px 视为点击（选中）。 */
  const beginMoveDrag = (e: React.MouseEvent, s: StageInfo, from: number, to: number) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const span = to - from;
    const allOrders = p.shots.filter((sh) => !sh.is_special)
      .map((sh) => sh.order).sort((a, b) => a - b);
    if (!allOrders.length) return;
    let started = false;
    let lastFrom = from;
    const orderAtDelta = (clientX: number): number => {
      // 拖动位移 → 目标起点 order：按落点像素找最近的槽起点
      const rowEl = (e.target as HTMLElement).closest(".ctrack-row") as HTMLElement | null;
      if (!rowEl) return lastFrom;
      const cx = clientX - rowEl.getBoundingClientRect().left;
      let best = lastFrom;
      let bestD = Infinity;
      for (const o of allOrders) {
        if (o + span > allOrders[allOrders.length - 1]) continue;  // 尾部越界
        const r = p.shotRects.get(o);
        if (!r) continue;
        const d0 = Math.abs(r.x - (cx - dragOffset));
        if (d0 < bestD) { bestD = d0; best = o; }
      }
      return best;
    };
    const startRect = p.shotRects.get(from);
    const rowEl0 = (e.target as HTMLElement).closest(".ctrack-row") as HTMLElement | null;
    const dragOffset = rowEl0 && startRect
      ? (e.clientX - rowEl0.getBoundingClientRect().left) - startRect.x : 0;
    const onMove = (ev: MouseEvent) => {
      if (!started && Math.abs(ev.clientX - startX) < 4) return;  // 抖动阈值
      started = true;
      movedRef.current = true;
      const nf = orderAtDelta(ev.clientX);
      if (nf !== lastFrom) {
        lastFrom = nf;
        setMove({ stageId: s.id, from, to, newFrom: nf, newTo: nf + span });
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setMove(null);
      if (!started) { movedRef.current = false; return; }
      setTimeout(() => { movedRef.current = false; }, 0);  // 抑制本次 click
      if (lastFrom !== from) void commitMove(s, from, to, lastFrom);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const commitMove = async (s: StageInfo, from: number, to: number, newFrom: number) => {
    const span = to - from;
    const char = s.character_name;
    const oldIds: string[] = [];
    const newIds: string[] = [];
    for (let o = from; o <= to; o++) {
      const sh = orderToShot.get(o);
      if (sh && !sh.is_special) oldIds.push(sh.id);
    }
    for (let o = newFrom; o <= newFrom + span; o++) {
      const sh = orderToShot.get(o);
      if (sh && !sh.is_special) newIds.push(sh.id);
    }
    const removeIds = oldIds.filter((id) => !newIds.includes(id));
    const addIds = newIds.filter((id) => !oldIds.includes(id));
    if (!removeIds.length && !addIds.length) return;
    try {
      await api.refOverrides(p.projectId, char, { addShotIds: addIds, removeShotIds: removeIds });
      p.onPushUndo(`移动「${char}」段 #${from} → #${newFrom}`, async () => {
        await api.refOverrides(p.projectId, char, { addShotIds: removeIds, removeShotIds: addIds });
        p.onOverridesChanged();
      });
      p.onToast(`↔ 「${char}」覆盖段已移到 #${newFrom}-#${newFrom + span}`);
      p.onOverridesChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  /** 把一段连续 order 映射为像素区间（缺失的 order 跳过） */
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

  /** 本阶段可拖入的镜头 order（ep/shot 区间内、非外部素材——外部素材不经生成，注入无意义）；
   *  虚拟段无区间约束：全部 AI 镜头可拖 */
  const eligibleOrders = (s: StageInfo): number[] =>
    p.shots
      .filter((sh) => !sh.is_special
        && (s.virtual || (sh.episode >= s.ep_from && sh.episode <= s.ep_to
          && (s.shot_from == null || sh.order >= s.shot_from)
          && (s.shot_to == null || sh.order <= s.shot_to))))
      .map((sh) => sh.order)
      .sort((a, b) => a - b);

  /** 拖拽中的增/减镜头数（预览标签与提交共用同一算法，保证所见即所得） */
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

  /** P1-2 边缘拖拽：吸附镜头槽边界（与镜头轨严格同坐标系），松手一次事务落库 */
  const beginEdgeDrag = (e: React.MouseEvent, s: StageInfo,
                         side: "L" | "R", runFrom: number, runTo: number) => {
    e.preventDefault();
    e.stopPropagation();
    const rowEl = (e.currentTarget as HTMLElement).closest(".ctrack-row") as HTMLElement | null;
    if (!rowEl) return;
    dragCtx.current = {
      rowEl, eligible: eligibleOrders(s),
      present: new Set(s.present_orders ?? []), stage: s,
    };
    let curr = side === "L" ? runFrom : runTo;
    const state: EdgeDrag = { stageId: s.id, side, runFrom, runTo, curr };
    setDrag(state);

    const orderAt = (clientX: number): number => {
      const ctx = dragCtx.current;
      if (!ctx) return curr;
      const cx = clientX - ctx.rowEl.getBoundingClientRect().left;
      let best = curr;
      let bestD = Infinity;
      for (const o of ctx.eligible) {
        if (side === "L" && o > runTo) continue;   // 左缘不能越过段右端
        if (side === "R" && o < runFrom) continue; // 右缘不能越过段左端
        const r = p.shotRects.get(o);
        if (!r) continue;
        const bx = side === "L" ? r.x : r.x + r.w; // 吸附边界：左缘对槽左沿，右缘对槽右沿
        const d = Math.abs(bx - cx);
        if (d < bestD) { bestD = d; best = o; }
      }
      return best;
    };
    const onMove = (ev: MouseEvent) => {
      const next = orderAt(ev.clientX);
      if (next !== curr) {
        curr = next;
        setDrag({ ...state, curr });
      }
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
    const char = ctx.stage.character_name;
    try {
      const addIds = addOrders.map((o) => orderToShot.get(o)!.id);
      const removeIds = removeOrders.map((o) => orderToShot.get(o)!.id);
      const r = await api.refOverrides(p.projectId, char, {
        addShotIds: addIds,
        removeShotIds: removeIds,
      });
      const parts = [
        addOrders.length ? `+${addOrders.length} 镜注入` : "",
        removeOrders.length ? `−${removeOrders.length} 镜注入` : "",
      ].filter(Boolean).join(" · ");
      // P2-2：逆操作 = 反向 add/remove（后端最小差集对消保证精确还原）
      p.onPushUndo(`${char} ${parts}`, async () => {
        await api.refOverrides(p.projectId, char, {
          addShotIds: removeIds, removeShotIds: addIds,
        });
        p.onOverridesChanged();
      });
      p.onToast(`✅ ${char}：${parts}`
        + `${r.stale.length ? `（${r.stale.length} 镜已出片，参考图已变可重新生成 ↻）` : ""}`
        + " · Ctrl+Z 可撤销");
      p.onOverridesChanged();
    } catch (e) { p.onToast(`❌ 参考图调整失败：${String(e)}`); }
  };

  /** ↺ 重置：清掉该角色在指定镜头上的全部人工覆写，回到拆解 AI 判定 */
  const resetOverrides = async (char: string, orders: number[]) => {
    const ids = orders.map((o) => orderToShot.get(o)?.id).filter((x): x is string => !!x);
    if (!ids.length) return;
    try {
      await api.refOverrides(p.projectId, char, { resetShotIds: ids });
      p.onToast(`↺ ${char}：${ids.length} 镜已重置为 AI 判定`);
      p.onOverridesChanged();
    } catch (e) { p.onToast(`❌ 重置失败：${String(e)}`); }
  };

  /** ↺ 重置本段人工调整 */

  return (
    <section className="ctrack"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-fw-asset")) e.preventDefault(); }}
      onDrop={onLaneAssetDrop}>
      {/* 主角行：每人一行（≥2 造型阶段）；拖资产卡到行上=替换/注入该角色 */}
      {mains.map(([name, stages]) => (
        <div key={name} className="ctrack-row" style={{ width: p.totalW || undefined }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-fw-asset")) e.preventDefault(); }}
          onDrop={(e) => void onRowAssetDrop(e, name, stages)}>
          <span className="ctrack-name" title={name}>{name}</span>
          {stages.map((s, si) => {
            const runs = toRuns(s.present_orders ?? []);
            const busy = p.busyStages.has(s.id);
            const cls = `ctrack-stage ${s.status === "confirmed" ? "ok" : ""}`
              + `${busy ? " busy" : ""}${!s.image_url ? " noimg" : ""}`;
            // 无出场镜头（该阶段区间内角色未登场）：不占轨道，仅在行尾给一个提示胶囊
            if (!runs.length) {
              return (
                <div key={s.id} className={`${cls} ctrack-stage-idle`}
                  style={{ position: "relative", marginLeft: si ? 4 : 0 }}
                  title={`${s.stage_name} 第${s.ep_from}-${s.ep_to}集\n该区间内此角色无出场镜头，生成时不会注入其参考图`}
                  onClick={() => openStageDlg(s)}>
                  <span className="ctrack-stage-label">{s.stage_name} <em>未出场</em></span>
                </div>
              );
            }
            return runs.map(([from, to], ri) => {
              const rect = runRect(from, to);
              if (!rect) return null;
              const shotCount = to - from + 1;
              // P1-2：段内人工痕迹（画斜纹 + ↺）与本段拖拽会话
              const manualAdd = new Set(s.manual_add_orders ?? []);
              const runManual: number[] = [];
              for (let o = from; o <= to; o++) if (manualAdd.has(o)) runManual.push(o);
              const isManual = runManual.length > 0;
              const dragging = drag && drag.stageId === s.id
                && drag.runFrom === from && drag.runTo === to;
              const diff = dragging ? dragDiff(drag) : null;
              const isSel = sel && sel.stageId === s.id && sel.from === from && sel.to === to;
              const moving = move && move.stageId === s.id && move.from === from && move.to === to;
              // 已出片但注入被改：段内任一镜 refs_stale → ↻ 提示
              const staleOrders: number[] = [];
              for (let o = from; o <= to; o++)
                if (orderToShot.get(o)?.refs_stale) staleOrders.push(o);
              return (
                <div key={`${s.id}-${from}`}
                  className={`${cls}${isManual ? " manual" : ""}${dragging ? " edge-dragging" : ""}${isSel ? " selected" : ""}${moving ? " moving" : ""}`}
                  style={{ position: "absolute", left: rect.left, width: rect.width, top: 4, minWidth: 0 }}
                  title={`${s.stage_name}（第${s.ep_from}-${s.ep_to}集）\n`
                    + `本段：镜头 #${from}-#${to}（${shotCount} 镜，生成时注入此定妆图）\n`
                    + `${s.image_url ? "" : "⚠ 此阶段还没有定妆图，生成时不会有参考\n"}`
                    + `${isManual ? `✋ 含 ${runManual.length} 镜人工加入（斜纹）· ↺ 可重置为 AI 判定\n` : ""}`
                    + `${staleOrders.length ? `↻ ${staleOrders.length} 镜已出片但参考图已变，可重新生成\n` : ""}`
                    + `点击=选中（Del删/Ctrl+C复制/Ctrl+V粘贴）· 按住拖动=移动覆盖位置\n`
                    + `⇤⇥ 拖左右边缘可增删注入范围 · 双击编辑\n`
                    + `${s.description ?? ""}`}
                  onClick={() => { if (!drag && !movedRef.current) select(s, from, to); }}
                  onDoubleClick={() => { if (!drag && !movedRef.current) openStageDlg(s); }}
                  onMouseDown={(e) => {
                    const tgt = e.target as HTMLElement;
                    if (tgt.classList.contains("ctrack-handle")) return;  // 边缘把手另有拖拽
                    beginMoveDrag(e, s, from, to);
                  }}
                  onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-fw-asset")) { e.preventDefault(); e.stopPropagation(); } }}
                  onDrop={(e) => void onSegAssetDrop(e, s)}>
                  {s.image_url && rect.width >= 44 && <img src={api.mediaUrl(s.image_url)} alt="" />}
                  {rect.width >= 64 && (
                    <span className="ctrack-stage-label">
                      {ri === 0 ? s.stage_name : "↳"} <em>#{from}-{to}</em>
                    </span>
                  )}
                  {busy && <span className="ctrack-stage-spin">⏳</span>}
                  {!s.image_url && !busy && <span className="ctrack-stage-warn" title="缺定妆图">⚠</span>}
                  {staleOrders.length > 0 && (
                    <span className="ctrack-stage-stale"
                      title={`镜头 ${staleOrders.map((o) => `#${o}`).join(" ")} 已出片但参考图已变，可重新生成`}>↻</span>
                  )}
                  {isManual && !busy && (
                    <button className="ctrack-stage-reset" title="重置本段人工调整为 AI 判定"
                      onClick={(e) => { e.stopPropagation(); void resetOverrides(s.character_name, runManual); }}>↺</button>
                  )}
                  {/* P1-2 左右拖拽把手（吸附镜头槽边界） */}
                  <span className="ctrack-handle hl" title="拖动调整注入起点"
                    onMouseDown={(e) => beginEdgeDrag(e, s, "L", from, to)} />
                  <span className="ctrack-handle hr" title="拖动调整注入终点"
                    onMouseDown={(e) => beginEdgeDrag(e, s, "R", from, to)} />
                  {/* 拖拽实时反馈：影响 N 镜 */}
                  {dragging && diff && (
                    <span className="ctrack-drag-tip">
                      {diff.addOrders.length > 0 && `＋${diff.addOrders.length} 镜`}
                      {diff.removeOrders.length > 0 && `−${diff.removeOrders.length} 镜`}
                      {diff.addOrders.length === 0 && diff.removeOrders.length === 0 && "无变化"}
                    </span>
                  )}
                </div>
              );
            });
          })}
          {/* 拖拽目标预览：把「拖到的边界」画成半透明覆盖层，所见即所得 */}
          {drag && (() => {
            const st = p.stages.find((x) => x.id === drag.stageId);
            if (!st || st.character_name !== name) return null;
            const start = drag.side === "L" ? drag.curr : drag.runFrom;
            const end = drag.side === "R" ? drag.curr : drag.runTo;
            const tgt = runRect(Math.min(start, end), Math.max(start, end));
            if (!tgt) return null;
            return <div className="ctrack-drag-ghost"
              style={{ left: tgt.left, width: tgt.width }} />;
          })()}
          {/* 整段移动预览 */}
          {move && (() => {
            const st = p.stages.find((x) => x.id === move.stageId);
            if (!st || st.character_name !== name) return null;
            const tgt = runRect(move.newFrom, move.newTo);
            if (!tgt) return null;
            return <div className="ctrack-drag-ghost move"
              style={{ left: tgt.left, width: tgt.width }} />;
          })()}
        </div>
      ))}

      {/* 配角轨：全部单阶段配角共用一条轨，重叠段上下叠放（子行高=主行一半），
          轨高随最大同时重叠数动态伸缩；拖资产卡到轨上=该角色注入落点镜头 */}
      {supSegs.length > 0 && (
        <div className="ctrack-row sup" style={{
          width: p.totalW || undefined,
          height: supLaneCount * SUB_H + 8,
        }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-fw-asset")) e.preventDefault(); }}
          onDrop={(e) => void onSupLaneAssetDrop(e)}>
          <span className="ctrack-name" title={`配角轨：${supports.length} 个单一设定角色`}>
            配角 ×{supports.length}
          </span>
          {supSegs.map((g) => {
            const rect = runRect(g.from, g.to);
            if (!rect) return null;
            const s = g.stage;
            const busy = p.busyStages.has(s.id);
            const manualAdd = new Set(s.manual_add_orders ?? []);
            const runManual: number[] = [];
            for (let o = g.from; o <= g.to; o++) if (manualAdd.has(o)) runManual.push(o);
            const staleOrders: number[] = [];
            for (let o = g.from; o <= g.to; o++)
              if (orderToShot.get(o)?.refs_stale) staleOrders.push(o);
            const dragging = drag && drag.stageId === s.id
              && drag.runFrom === g.from && drag.runTo === g.to;
            const diff = dragging ? dragDiff(drag) : null;
            const isSel = sel && sel.stageId === s.id && sel.from === g.from && sel.to === g.to;
            const moving = move && move.stageId === s.id && move.from === g.from && move.to === g.to;
            const cls = `ctrack-stage sub ${s.status === "confirmed" ? "ok" : ""}`
              + `${busy ? " busy" : ""}${!s.image_url ? " noimg" : ""}`
              + `${runManual.length ? " manual" : ""}${dragging ? " edge-dragging" : ""}`
              + `${isSel ? " selected" : ""}${moving ? " moving" : ""}`;
            return (
              <div key={`${s.id}-${g.from}`} className={cls}
                style={{ position: "absolute", left: rect.left, width: rect.width,
                         top: 4 + g.lane * SUB_H, height: SUB_H - 4, minWidth: 0 }}
                title={`${s.character_name}\n本段：镜头 #${g.from}-#${g.to}（${g.to - g.from + 1} 镜）\n`
                  + `${s.image_url ? "" : "⚠ 还没有定妆图\n"}`
                  + `${staleOrders.length ? `↻ ${staleOrders.length} 镜已出片但参考图已变\n` : ""}`
                  + `点击=选中（Del/Ctrl+C/Ctrl+V）· 按住拖=移动 · ⇤⇥边缘调范围 · 双击编辑`}
                onClick={() => { if (!drag && !movedRef.current) select(s, g.from, g.to); }}
                onDoubleClick={() => { if (!drag && !movedRef.current) openStageDlg(s); }}
                onMouseDown={(e) => {
                  const tgt = e.target as HTMLElement;
                  if (tgt.classList.contains("ctrack-handle")) return;
                  beginMoveDrag(e, s, g.from, g.to);
                }}
                onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-fw-asset")) { e.preventDefault(); e.stopPropagation(); } }}
                onDrop={(e) => void onSegAssetDrop(e, s)}>
                {s.image_url && rect.width >= 36 && <img src={api.mediaUrl(s.image_url)} alt="" />}
                {rect.width >= 56 && (
                  <span className="ctrack-stage-label">{s.character_name}</span>
                )}
                {busy && <span className="ctrack-stage-spin">⏳</span>}
                {!s.image_url && !busy && <span className="ctrack-stage-warn" title="缺定妆图">⚠</span>}
                {staleOrders.length > 0 && <span className="ctrack-stage-stale">↻</span>}
                <span className="ctrack-handle hl" title="拖动调整注入起点"
                  onMouseDown={(e) => beginEdgeDrag(e, s, "L", g.from, g.to)} />
                <span className="ctrack-handle hr" title="拖动调整注入终点"
                  onMouseDown={(e) => beginEdgeDrag(e, s, "R", g.from, g.to)} />
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
          {/* 配角轨拖拽目标预览 */}
          {drag && (() => {
            const seg = supSegs.find((g) => g.stage.id === drag.stageId
              && g.from === drag.runFrom && g.to === drag.runTo);
            if (!seg) return null;
            const start = drag.side === "L" ? drag.curr : drag.runFrom;
            const end = drag.side === "R" ? drag.curr : drag.runTo;
            const tgt = runRect(Math.min(start, end), Math.max(start, end));
            if (!tgt) return null;
            return <div className="ctrack-drag-ghost"
              style={{ left: tgt.left, width: tgt.width }} />;
          })()}
          {/* 配角轨整段移动预览 */}
          {move && (() => {
            const seg = supSegs.find((g) => g.stage.id === move.stageId
              && g.from === move.from && g.to === move.to);
            if (!seg) return null;
            const tgt = runRect(move.newFrom, move.newTo);
            if (!tgt) return null;
            return <div className="ctrack-drag-ghost move"
              style={{ left: tgt.left, width: tgt.width }} />;
          })()}
        </div>
      )}

      {/* 统一资产详情弹窗（双击轨道段打开） */}
      {dlg && (
        <AssetDialog projectId={p.projectId} target={dlg} shots={p.shots}
          onClose={() => setDlg(null)} onToast={p.onToast}
          onChanged={() => { p.onRefresh(); p.onOverridesChanged(); }} />
      )}
    </section>
  );
}
