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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eye, Replace, Trash2, RefreshCw, RotateCcw, Lock, Unlock, Plus, User, MapPin,
  Image as ImageIcon,
} from "lucide-react";
import { api } from "../../api";
import type { ShotInfo, StageInfo, LocationInfo, AssetInfo, AssetDragData } from "../../api";
import ContextMenu, { MenuItem } from "../../components/ContextMenu/ContextMenu";
import { injectAssetIntoShot, replaceRunImage } from "./injectAsset";
import type { CommandDraft } from "../../lib/command";
import { inSpan } from "../timeline/virtual";
import type { SpanRange } from "../timeline/virtual";
// 3.12（F1）：资产段的三个手势（拖左边缘 / 拖右边缘 / 拖整段）与时间轴共用同一层
// —— 统一走 Pointer Events，拖动期间直接写 DOM 几何，见 gesture.ts 头注释。
import { attachDragBlock, beginGesture, stylePreview } from "../timeline/gesture";
// 3.13：本地台账。所有调整先记台账、画面立刻按台账画，落库是后台防抖的事。
import {
  displayOrdersOf, displayManualAddsOf, recordWithUndo,
  useAssetOverride, useAssetOverrideRev,
} from "../../stores/assetOverrideStore";
import type { AssetOverrideOp, EdgeWindow } from "./assetOverrides";
import {
  freeSpan, opsOf, reachSpan, runGeometry, shownForStage, snapEdge,
} from "./assetOverrides";
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
  /**
   * 这一段**自己的**可及范围（连续 order，通常与 `from..to` 相同，但**可能更宽**）。
   *
   * ⚠️ 它必须**不随当前范围一起缩**，否则"缩小"就是单向的：缩到一半之后
   * `snapEdge` 的搜索窗口跟着变窄，`orderLimit` 要求的新落点落在窗外，
   * 于是**再想拉回去一个字都不动**（实测复现：右边缘从 #1-#4 缩到 #1-#2 后，
   * 无论再往右拖多远都停在 200px；左边缘同理只能右移不能移回）。
   *
   * 所以这里存的是从**底座**往外扫出的最大范围（`reachSpan`，同 `blocked`
   * 口径），而不是台账投影后的结果。渲染仍然用 `from..to` 画。
   *
   * 为什么不能用"整个角色的出场镜头"：那条数据是按**角色名**来的，而这个角色
   * 可能有**多个造型**分段覆盖不同集数。造型 A 的段拉长进造型 B 的区间，写的
   * 台账操作会被造型 B 那条段捡走，画出第二块**重叠**的段（没有造型接住时
   * 则合成「未设阶段」段，旧名「人工注入」）—— 用户报的"拉长会创建新块、而且覆盖重叠"就是它。
   */
  reach: [number, number];
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

/* `freeSpan`/`reachSpan`（一段的可及范围）放在规则层 `assetOverrides.ts` ——
 * 守卫脚本要拿真实数据跑**同一份**实现，口径写两遍必然漂移，而漂移的方向恰好
 * 就是这次修的 bug（预览一套、提交一套）。
 *
 * 两段式是有意的：先 `freeSpan` 从底座扫一遍（挡住别的造型），再 `reachSpan`
 * 从那个结果继续往外扫。分两步而不是一步，是因为 `splitRuns` 切出来的每一段
 * 各扫各的，合并成一个会把"另一段挡住了"这件事算丢。 */

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

  /**
   * 掐掉浏览器自起的原生拖拽（见 `gesture.ts` 的 `attachDragBlock`）。
   *
   * 必须挂在**最外层容器**上、走**捕获阶段**：段身里有造型图、行头有缩略图、
   * 段上还有文字，`pointerdown` 的默认行为没被取消时，浏览器一看到指针移动就
   * 判成"用户在拖这张图/这段文字"，先派 `dragstart` 再给页面一个
   * `pointercancel` —— 我们挂在 `window` 上的 `pointermove` / `pointerup`
   * 当场作废，手势僵死且不报错。实测表现为"第一次拖有用、后面几次纹丝不动"。
   *
   * 为什么不能依赖组件自己的 `onPointerDown`：那要等事件冒泡到 React 根容器
   * 才跑，那时浏览器已经在追踪这次按下了。`preventDefault` 必须在**这一次
   * `pointerdown` 派发之内**发生，捕获阶段是唯一来得及的位置。
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => attachDragBlock(rootRef.current), [p.kind]);

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
    /**
     * "这一格能不能被资产块占住"。
     *
     * ⚠️ 特殊镜（外部素材镜）**必须算不能**。它没有"这一镜里的角色"，注入进去
     * 没有任何意义；更重要的是：`freeSpan` 拿它当"再往外就没有了"的判据。
     * 老写法 `orderToShot.has(o)` 把特殊镜也算成"有"，于是被特殊镜隔开的两段
     * 会各自**朝特殊镜扩张一格**（扩张出来的 order 不合法、`win.ok` 又把它滤掉）
     * —— 拖动时表现为"拉到某一格突然僵住不动"，且极限位置比肉眼看到的边界
     * 少一格。
     */
    const hasShot = (o: number) => {
      const sh = orderToShot.get(o);
      return !!sh && !sh.is_special;
    };
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
      /** 角色名 → 被**某个**造型覆盖的 orders。A↔B 相邻造型之间没被覆盖的镜头
       *  才是"公共空地"：两边都能拉进来，谁先拉算谁的。 */
      const claimed = new Map<string, Set<number>>();
      for (const st of p.stages) {
        const s = claimed.get(st.character_name) ?? new Set<number>();
        for (const o of st.present_orders ?? []) s.add(o);
        claimed.set(st.character_name, s);
      }

      const charOps = (name: string) => opsOf(table, name);
      for (const st of p.stages) {
        // ⚠️ 底座用的是**这一个造型**的 `present_orders`，不是整个角色的并集。
        // 并集会把两个造型的区间画成同一条（同一角色的不同造型区段会重叠），
        // 那正是 `splitRuns` 要避免的事。
        const base = st.present_orders ?? [];
        if (!base.length) continue;
        const name = st.character_name;
        const asset = p.assets.find((a) => a.kind === "character" && a.name === name);
        const row = mkRow(name, asset?.image_url ?? null);
        // 别的造型**声明过**的镜头：本造型不许捡（详见 `shownForStage` 头注释）
        const otherBase = new Set<number>();
        for (const o of claimed.get(name) ?? []) if (!base.includes(o)) otherBase.add(o);
        const { shown, manual } = shownForStage(
          base, charOps(name), otherBase, isSpecial, st.virtual ? undefined : st.id);
        if (!shown.length) continue;
        /** 本段自己的出场镜头（含台账加进来的）。拖动时的合法落点。 */
        const own = new Set(shown);
        /**
         * 别人（同一角色的**别的造型**）覆盖的镜头：一步都不许踩进去。
         *
         * ⚠️ 判据必须用**服务端底座**的并集（`claimed`），不能用"别的造型现在
         * 显示到哪" —— 后者会随本轮台账改动漂移，而这个集合是**生长边界**：
         * 一个造型只允许在自己的底座区间里缩、再把让出来的格子吃回来，**不许
         * 长进底座之外**。"拉长"的本意是"把刚才缩掉的拉回来"，不是"长出一条
         * 新段"。越过底座就是别的地盘（别的造型 / 谁都没声明的公共空地），
         * 在那儿写下 present:true 会让"别的造型"或「未设阶段」段同时捡到它，
         * 画出第二块**重叠**的块（实测：常服从 #1-#2 往右拉 3 格 → 夜行衣行
         * 冒出 st-night:5[400+100]，还并排一条 local:林昭:5）。用户原话：
         * 「而拉长资产块时，回创建一个新的资产块…而且是覆盖重叠的-这显然错了」。
         *
         * 想真正改区间，要用边缘缩（在底座内），或右键重生成 / 资产页改阶段区间。
         */
        const others = new Set<number>();
        for (const o of claimed.get(name) ?? []) if (!own.has(o)) others.add(o);
        /**
         * ⚠️ **`reach` 要以"底座 ∪ 当前"为根往外扫**，不能只从**当前**的 `r` 扫。
         *
         * `r` 是台账投影之后的区间：把右边缘缩到 #1-#2，下一帧 `r` 就成了 `[1,2]`，
         * 从这里往外扫出的 `reach` 也是 `[1,2]` —— 窗口 `hi=2`，而 `snapEdge` 的
         * `orderLimit` 要求右边缘 order `>= anchorOrder+1 = 3`，**无解** → 返回
         * `order:null` → 预览保持原样、松手 `applyEdge` 拿到 `want=2` 等于现状而
         * 提前 return。**这就是"缩短一镜后没反应"**：缩回去的那一格再也拿不回来，
         * 只能刷新页面。用户原话：「缩短一个片段距离后视觉上没有反应，但再次拖到
         * 缩小，新的缩小起点在上一次缩小的预期结果上」。
         *
         * 根取并集之后，"本段自己让出来的格子"仍在窗口里，缩了能再拉回来；而别的
         * 造型（`others`）、没有镜头、特殊镜（`hasShot`）一个都没放宽，仍然在外侧
         * 把窗口卡住 —— 不会踩进别人的区间画出重叠的第二块。
         */
        const roots = [...new Set([...base, ...shown])].sort((a, b) => a - b);
        for (const r of splitRuns(shown)) {
          row.runs.push({
            id: `${st.id}:${r[0]}`,
            from: r[0], to: r[r.length - 1],
            stageName: st.stage_name,
            stageId: st.virtual ? undefined : st.id,
            imageUrl: st.effective_image_url ?? st.image_url,
            manualAdd: manual.filter((o) => r.includes(o)),
            locked: st.status === "confirmed",
            reach: reachSpan(freeSpan(roots, others, hasShot), others, hasShot),
          });
        }
      }

      // 台账里那些**不属于任何造型区段**的 order：第一次把某个角色注入进去时
      // 就是这种情况 —— 服务端还没有这一行，只按造型画的话用户的注入会
      // 完全看不见。单独合成一条段，坐标仍然精确到镜头。
      //
      // ⚠️ 这条段的名字是「未设阶段」，**不是**「人工注入」。
      // 旧名字把"用户亲手把资产从资产窗拖进来"说成了系统生成的产物 ——
      // 用户原话：「用户从资产窗把资产拖到轨道上也会显示人工注入」。注入本身是
      // 人的操作，该被质疑的是"这段归哪套造型"，而不是"它是不是人干的"。
      // 现在的分工是：
      //   · 落点在**某套造型的区间里** → 那条 op 已由 `stageIdAt` 盖上造型的章，
      //     投影时直接并进那个造型段，画的是造型自己的名字（`st-day:1` 这种），
      //     根本走不到这里；
      //   · 只有**谁都没声明过**的公共空地才落到这条段上 —— 服务端确实没有对应
      //     的造型行，用「未设阶段」如实描述（与后端合成虚拟段时的
      //     `stage_name="未设阶段"` 用词一致）。
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
        // ⚠️ 只有"哪个造型都没声明过、且台账里是 present:true"的 order 才算没主的注入。
        // 老写法用**行级**投影 `displayOrdersOf([], …)` 再减掉底座覆盖，于是某个造型
        // 缩掉的格子（台账 present:false）不会被算进来（这步对），但**别的造型底座里
        // 没有、台账加进来的**格子会被算进来合成 `local:` 段；那些格子如果正好落在
        // 本造型的可见区间旁，就和造型段并排画出第二块重叠的块。这里只认"没被任何
        // 造型声明过的公共空地"。
        const extra = shownForStage([], opsOf(table, name), cov, isSpecial).shown;
        if (!extra.length) continue;
        const asset = p.assets.find((a) => a.kind === "character" && a.name === name);
        const row = mkRow(name, asset?.image_url ?? null);
        const manual = manualSet(name);
        // 「未设阶段」段没有造型行，能到哪儿由"别的造型没占的镜头"决定：
        // 往两边走到撞上某个造型的区间为止。
        const blocked = new Set(cov);
        for (const r of splitRuns(extra)) {
          row.runs.push({
            id: `local:${name}:${r[0]}`,
            from: r[0], to: r[r.length - 1],
            stageName: "未设阶段",
            // 没有 AssetStage 行 → 换图走 upsertAssetImage（同场景轨的 virtual 段）
            stageId: undefined,
            imageUrl: asset?.image_url ?? null,
            manualAdd: r.filter((o) => manual.has(o)),
            locked: false,
            reach: reachSpan(freeSpan(extra, blocked, hasShot), blocked, hasShot),
          });
        }
      }
      return [...byName.values()];
    }

    // 场景轨
    /** 场景名 → 被某个 `LocationInfo` 覆盖的 orders（场景轨的"别的段"）。 */
    const locClaimed = new Map<string, Set<number>>();
    for (const l of p.locations) {
      const s = locClaimed.get(l.name) ?? new Set<number>();
      for (const o of l.present_orders ?? []) s.add(o);
      locClaimed.set(l.name, s);
    }
    for (const l of p.locations) {
      const base = l.present_orders ?? [];
      if (!base.length) continue;
      const row = mkRow(l.name, l.image_url);
      const shown = displayOrdersOf(base, p.projectId, l.name, isSpecial);
      const manual = displayManualAddsOf(base, shown, p.projectId, l.name);
      const own = new Set(shown);
      const others = new Set<number>();
      for (const o of locClaimed.get(l.name) ?? []) if (!own.has(o)) others.add(o);
      for (const r of splitRuns(shown)) {
        row.runs.push({
          id: `loc:${l.name}:${r[0]}`,
          from: r[0], to: r[r.length - 1],
          imageUrl: l.image_url,
          manualAdd: manual.filter((o) => r.includes(o)),
          locked: false,
          reach: reachSpan(freeSpan([...new Set([...base, ...shown])], others, hasShot), others, hasShot),
        });
      }
    }
    const locNames = new Set<string>([...p.locations.map((l) => l.name), ...Object.keys(table)]);
    for (const name of locNames) {
      const extra = displayOrdersOf([], p.projectId, name, isSpecial);
      if (!extra.length) continue;
      const asset = p.assets.find((a) => a.name === name);
      const row = mkRow(name, asset?.image_url ?? null);
      const blocked = locClaimed.get(name) ?? new Set<number>();
      for (const r of splitRuns(extra)) {
        row.runs.push({
          id: `local:loc:${name}:${r[0]}`,
          from: r[0], to: r[r.length - 1],
          imageUrl: asset?.image_url ?? null,
          manualAdd: [],
          locked: false,
          reach: reachSpan(freeSpan(extra, blocked, hasShot), blocked, hasShot),
        });
      }
    }
    const out = [...byName.values()];
    return out;
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
    // ⚠️ 落到**这一段自己的可及范围**（`reach`，不是当前范围）里。外面拦不住
    // 的时候（比如程序化调用）这里兜底 —— 写进别的造型区间的 op 会被那条段
    // 捡走，画出重叠的第二块，属于**数据面**的错误，比画面错更难收场。
    //
    // 夹的是 `reach` 而非 `span`（两者口径见 AssetRun 的注释）：夹到当前范围
    // 的话，"缩了再拉回"的落点会被这里悄悄驳回，表现为"手势明明走完了、
    // toast 也报了，但范围没变"。
    const ord = Math.min(Math.max(newOrder, run.reach[0]), run.reach[1]);
    const anchor = edgeKind === "from" ? run.to : run.from;
    const nf = edgeKind === "from" ? Math.min(ord, anchor) : run.from;
    const nt = edgeKind === "to" ? Math.max(ord, anchor) : run.to;
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
      // ⚠️ 记上**写下它的造型**。台账按角色名存，一个角色有多套造型时行级
      // op 会被兄弟造型一起读到 —— "常服拉长吃进 #5"被夜行衣捡去画成重叠
      // 第二块（实测 ④）就是它。`stageId` 让投影只把这条还给作者。
      ops.push({ order: o, present: inNew, manual: inNew && manual, stageId: run.stageId });
    }
    if (!ops.length) return;

    const affected: string[] = [];
    for (let o = lo; o <= hi; o++) {
      const sh = orderToShot.get(o);
      if (sh) affected.push(sh.id);
    }
    // ⚠️ 只有台账**确实接受**了这批 op 才报成功。`recordWithUndo` 返回 false 的
    // 唯一情形是"台账还没 openProject"（首帧竞态）。此时预览已经动过了，若照样
    // 弹一句「生效范围改为 #1-#3」，用户看到的就是"缩了一格没反应、刷新又回来"
    // —— 一句假成功的 toast 比什么都不说更糟。
    if (!recordWithUndo(
      `「${row.name}」生效范围 #${run.from}-#${run.to} → #${nf}-#${nt}`,
      row.name, ops, affected)) {
      p.onToast("台账尚未就绪，这次调整没有保存 —— 请稍后重试");
      return;
    }
    p.onToast(`「${row.name}」生效范围改为 #${nf}-#${nt}`);
  };

  /** 段边缘的手势。**按下时一次性冻结几何**，之后全部基于这份冻结值算 ——
   *  每帧 `parseFloat(el.style.left)` 读回自己刚写的、已取整的值，误差会随
   *  拖动距离累加，就是用户报的"鼠标移动距离和段边缘有微小差异，越拖越明显"。 */
  const beginEdgeDrag = (
    e: React.PointerEvent, row: AssetRow, run: AssetRun, edgeKind: "from" | "to",
  ) => {
    // ⚠️ **不要**在这里 `stopPropagation`。
    //
    // 边缘手柄是叠在段身上的 6px 隐形层（`.fw-at-edge`，`z-index: 5`），
    // 而"点一下选中"靠的是段身上的 `onClick`。老写法把事件在这里掐掉，
    // 点在边缘上既不选中、也进不了整段拖拽 —— 更糟的是它**照样起手势**，
    // 于是"点一下"被当成了"拖边缘"，见下面 `onCommit` 的注释。
    //
    // 放行之后：`onPointerDown` 冒泡到段身，`beginMoveRun` 认出目标是
    // `.fw-at-edge` 会自己早退，两条通道不会同时开工。
    //
    // ⚠️ 但 `preventDefault` **必须调**，且只在按到"浏览器认得出的可拖物"上时调。
    // 段身里有 `<img>`（造型图）和文字标签，按下就动会自起一次**原生拖拽**：
    // 先 `dragstart`，再给页面一个 `pointercancel` 把指针流掐断 —— 此后
    // `pointermove` / `pointerup` 一个都不再来，手势僵死。
    // 实测（Playwright 抓的真机事件流）「拖右边缘」的第二次正是这条：
    //   pointerdown → pointermove(仅 1 次) → dragstart → **pointercancel** → drag/dragend
    // 表现是"拖第一次有用、第二次纹丝不动"，且不报任何错。
    // 第一次没暴露，是因为那次按下先触发了 `selectstart`，浏览器那一路抢先中断，
    // 反倒没轮到原生拖拽成型。（`<img draggable={false}>` 只管住图片自己，
    // 管不住它旁边的文字节点。）
    if (run.locked) { p.onToast(`「${row.name}」该造型已确认，先解锁再调整`); return; }
    const self = e.currentTarget as HTMLElement;
    const lane = self.closest<HTMLElement>(".fw-at-lane") ?? self.parentElement;
    const el = self.closest<HTMLElement>(".fw-at-run");
    if (!lane || !el) return;
    const box = lane.getBoundingClientRect();
    const scroll0 = lane.scrollLeft;
    // 冻结几何：与渲染同一个函数、同一组入参（`run.from/to`），不是读回 DOM。
    const g0 = runGeometry(run.from, run.to, p.offsetMap, p.pxPerSec, durOf);
    // 另一端的 order —— `snapEdge` 用它**按 order** 保证两端不交叉。
    //
    // ⚠️ 老写法传的是像素口径的 `minSpan = durOf(另一端那一镜) × pxPerSec`。
    // 镜头时长相等时两者等价，长短不一时像素口径会卡在两个镜头边界之间：
    // 指针对面的那一格被整格滤掉，于是"缩一格没反应、再缩从上一次该到的
    // 位置开始"。现在极限位置永远是**另一端的相邻那一格**，与时长无关。
    const anchorOrder = edgeKind === "from" ? run.to : run.from;
    // 像素兜底仍然要一个整镜宽（`anchorOrder` 不在 offsetMap 里时才会用到）。
    const minSpan = durOf(anchorOrder) * p.pxPerSec;
    // 另一端边缘的 px：`snapEdge` 用它保证两端不交叉（拖动期间另一端不动）
    const otherPx = edgeKind === "from" ? g0.right : g0.left;
    // ⚠️ **窗口在按下时冻结**，拖动全程用同一份。它同时是"能落到哪些镜头"
    // 与"退到哪儿为止"的答案 —— 见 `snapEdge` 与 `freeSpan` 的注释：窗外是
    // 别的造型的区间，写进去会被那条段捡走，画出重叠的第二块。
    //
    // ⚠️ 用 `run.reach`（底座往外扫出的最大范围）而**不是**当前范围。
    // 拖动期间窗口必须**不动**：既不能用会随编辑变化的当前值（那会让"缩一镜"
    // 之后窗口跟着收，段再也拉不回来），也不能用渲染期算出的 `edge` 预览值
    // （每帧都在变，窗口跟着漂，落点会自激）。
    const win: EdgeWindow = {
      lo: run.reach[0],
      hi: run.reach[1],
      ok: (o) => {
        const sh = orderToShot.get(o);
        return !!sh && !sh.is_special && o >= run.reach[0] && o <= run.reach[1];
      },
    };
    // 指针相对**它抓的那条边**的偏移：拖的时候保持它不变，边就贴着指针走
    const grabOffset = e.clientX
      - (box.left - scroll0 + (edgeKind === "from" ? g0.left : g0.right));
    const pv = stylePreview(el);
    let latest: number | null = anchorOrder;   // 还没定下来时 = 原来的边缘位置
    let moved = false;   // 越过阈值才置位；见 `onCommit`
    let hitLimit = false;   // 撞过窗口边界（拖到头）—— 见 `onCommit` 的"到界"提示
    beginGesture(e.nativeEvent, {
      thresholdPx: 3,      // 误点不该改数据
      cursor: "ew-resize",
      onFrame: (g) => {
        if (!g.moved) return;   // 纯点击：一帧预览都不画（见 `onCommit`）
        moved = true;
        const edgePx = (g.clientX - box.left + lane.scrollLeft) - grabOffset;
        // ⚠️ **吸附后再画**。老写法把边缘贴到指针的原始像素上，松手才吸附成
        // 镜头 —— 两者差半个到一个镜头，于是"缩了一镜宽没反应、再缩却从上一次
        // 该到的位置开始"（用户报的原话）。现在预览与提交走同一个 `snapEdge`：
        // 看到哪就是哪。代价是边缘一格一格地走，那是**对的**，它本来就只允许
        // 停在镜头边界上。
        const snap = snapEdge(edgePx, edgeKind, p.offsetMap, p.pxPerSec,
          durOf, win, otherPx, minSpan, anchorOrder);
        if (snap.order != null && snap.atLimit) hitLimit = true;
        // ⚠️ `snap.order == null` 时**不要**画 `snap.px`：那个值等于 `otherPx`，
        // 画出来段宽就是 0 —— 屏幕上一闪而过的"塌成一条线"，而松手又不提交，
        // 用户看到的是"拖的时候块消失了，松手又回来"。正确做法：没有合法落点
        // 就**保持上一帧的位置**（`latest` 那一格算出来的 px）。
        const o = snap.order;
        const at = latest ?? anchorOrder;
        const clamped = o == null
          ? (edgeKind === "from"
            ? (p.offsetMap.get(at) ?? run.from) * p.pxPerSec
            : ((p.offsetMap.get(at) ?? run.from) + durOf(at)) * p.pxPerSec)
          : snap.px;
        // ① 跟手：直接写 DOM 几何，不等任何 state。
        if (edgeKind === "from") {
          pv.widthPx(Math.max(1, g0.right - clamped), clamped - g0.left);
        } else {
          pv.widthPx(Math.max(1, clamped - g0.left));
        }
        // ② 离散的那部分（落点提示 + 松手提交用哪个 order）才碰 React。
        if (o == null || o === latest) return;
        latest = o;
        setEdge({ runId: run.id, edge: edgeKind, order: o });
      },
      onCommit: (g) => {
        // ⚠️ **这是"点一下就缩到最短"的真正来源**：`thresholdPx: 3` 只管住
        // `onFrame`，管不住 `onCommit` —— 老写法无论有没有越过阈值都照样提交。
        // 而且 `onUp` 会为最后一个 `pending` 事件补跑一次 `onFrame`（那是为了
        // 不丢最后一帧的拖拽位置），于是**连一次都没挪动的纯点击**也会先算出
        // 一个 `lastPx`（= 指针所在处）再拿去吸附提交。
        //
        // 手柄是 6px 隐形层，点在段身靠边的地方就会命中它。用户"点一下"时
        // 手指/鼠标的抖动通常有几 px，`clamped` 一旦被 `Math.max` 夹到
        // `anchorPx + minSpan`，那一段就被提交成最短的一段 —— 毫无征兆。
        if (!moved || g.cancelled) return;
        // ⚠️ 拖到头要说一声。窗口 `win` 卡在别的造型区间/没有镜头/特殊镜前面，
        // 用户看到的是"拖了半天块不动" —— 一句"到界了"比默默无效好。
        // 只在**真的没动**时说：动过了就别拿提示盖掉成功的 toast 与撤销栈说明。
        if (hitLimit && latest != null
          && (edgeKind === "from" ? latest === run.from : latest === run.to)) {
          p.onToast(edgeKind === "from"
            ? `「${row.name}」左边缘已到可调范围的尽头（再过去是别的造型 / 没有镜头）`
            : `「${row.name}」右边缘已到可调范围的尽头（再过去是别的造型 / 没有镜头）`);
        }
        // 用**最后一帧吸附到的**镜头提交 —— 与预览同一个值，不重新吸附一遍
        // （重新吸附会把"指针"再解释一次，又制造出预览/提交不一致的机会）。
        if (latest != null) applyEdge(row, run, edgeKind, latest);
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
    // ⚠️ **写入走注入函数本身，不在这里再抄一遍**。
    //
    // 这段代码原来是第三份注入实现（另有 `useAssetDrop.commitAssetDrop` 走指针
    // 通道、`Timeline.tsx` 走镜头轨），三份必然漂移 —— 实测漂的就是**话术**：
    // 指针那条链改了"空操作不许报成功"之后，HTML5 这条还在无条件弹
    // 「已把「林昭」注入镜头 #3」，而 #3 早就在常服底座里了，轨道上一格没变。
    // 用户看到的是同一句话、同一个假象，只是入口不同。
    //
    // 归属推断（`stageIdAt`）与"画出来了吗"（`injectionOutcome`）都在
    // `injectAssetIntoShot` 里，这里只负责把**这一行的**造型喂给它。
    injectAssetIntoShot({
      projectId: p.projectId, name, isLocation: p.kind === "location",
      shot: sh, order,
      // 场景轨没有造型这一层，传空数组自然推出 undefined。
      stages: p.kind === "character"
        ? (p.stages ?? []).map((s) => ({
          stageId: s.virtual ? undefined : s.id, base: s.present_orders ?? [],
        }))
        : undefined,
      // 上面那份是**全量**造型；不筛的话，"这个角色还没有造型行"会被当成
      // "有造型但这一格没画上"，往公共空地拖卡片就会误报「没能画上去」。
      ownStageIds: p.kind === "character"
        ? new Set((p.stages ?? [])
          .filter((s) => s.character_name === name && !s.virtual)
          .map((s) => s.id))
        : undefined,
      ops: p.kind === "character" ? opsOf(table, name) : undefined,
      onToast: p.onToast,
      onChanged: p.onChanged,
    });
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
    if (!recordWithUndo(
      `删除「${row.name}」#${run.from}-#${run.to} 注入段`,
      row.name,
      orders.map((o) => ({ order: o, present: false, manual: false })),
      orders.map((o) => orderToShot.get(o)!.id))) {
      p.onToast("台账尚未就绪，没有删除 —— 请稍后重试");
      return;
    }
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
    // 只在段身（非边缘手柄）按下时触发。手柄的 `onPointerDown` 挂在子元素上，
    // 先于段身触发且**不再** `stopPropagation`（见 `beginEdgeDrag`），事件会
    // 冒泡到这里 —— 靠这个 `target` 判定把两条通道分开，两者不会同时开工。
    if ((e.target as HTMLElement).classList.contains("fw-at-edge")) return;
    const lane = e.currentTarget.parentElement as HTMLElement | null;
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
    // ⚠️ **整段平移必须留在这一段自己的可及范围里**（`run.span`，与拖边缘
    // 同一份口径）。
    //
    // 老写法只夹在"整条时间轴的第一个镜头 … 最后一个镜头"之间 —— 那等于没夹：
    // 把「林昭·常服」#1-4 往右拖三格，就拖进了「林昭·夜行衣」#9-12 的区间，
    // 写下的 `present` 操作会被**夜行衣那条段**捡走（台账按角色名存、渲染按
    // 造型过滤），屏幕上就多出一块和夜行衣重叠的块 —— 用户报的"拉长会创建
    // 一个新块，而且是覆盖重叠的"。
    const daySpan = run.reach;
    const maxFromBySpan = daySpan[1] - (run.to - run.from);
    const orders = [...p.offsetMap.keys()].sort((a, b) => a - b);
    const minFrom = Math.max(orders.length ? orders[0] : run.from, daySpan[0]);
    const maxFrom = Math.min(
      (orders.length ? orders[orders.length - 1] - (run.to - run.from) : run.from),
      maxFromBySpan);
    // 提交用：跨了几个镜头（吸附后）
    let delta = 0;
    let moved = false;
    const pv = stylePreview(el);
    beginGesture(e.nativeEvent, {
      thresholdPx: 3,
      onFrame: (g) => {
        // 纯点击（没越过阈值）什么都不做。`onUp` 会为最后一个 `pending`
        // 事件补跑一次 `onFrame`，所以这一条**必须**有 —— 否则一次点击也会
        // 走进下面的吸附逻辑，把段整个挪到指针所在的镜头，并且 `moved`
        // 被置位后 `onCommit` 还会把它提交成一次真实平移。
        if (!g.moved) return;
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
      onCommit: (g) => {
        if (g.cancelled) return;
        // ⚠️ 拖了但一格都没挪动：屏幕上什么都不发生、也没有任何提示 ——
        // 用户报的"拖了没反应"。绝大多数情况是**到了本段可及范围的尽头**
        // （实测 ⑩：段身左移 4 格，#1 左边没有镜头可站）。这种"静默失败"
        // 是资产轨最让人困惑的一类反馈，这里补一句。
        //
        // ⚠️ 判据必须是 `g.moved`（越过了 3px 阈值 = 用户**确实在拖**），
        // 不能用本地的 `moved`。`moved` 只在 `d !== delta` 时置位，而
        // `delta` 初值就是 0 —— 一旦夹取把 `d` 死死按在 0（正是"到头了"
        // 这个场景），`moved` 永远是 false，上面那个 `!moved` 就先 return
        // 了，下面这句提示是**永远跑不到的死代码**。实测 ⑩ 的 toast 为空
        // 就是它：改完之前"到头了"从来没能说出口。
        // 反过来，没越过阈值的纯点击要继续保持安静（点一下只是选中）。
        if (!moved || delta === 0) {
          if (!g.moved) return;
          p.onToast(`「${row.name}」这一段已经到头了（#${run.from}-#${run.to}）—— 再过去是别的造型或没有镜头`);
          return;
        }
        // 兜底再夹一次 `run.span`：拖动期间 span 不会变（台账要松手才写），
        // 但这样读代码的人不必去追"`delta` 是不是一定在范围内"。
        const nf = Math.min(Math.max(run.from + delta, daySpan[0]), maxFromBySpan);
        const nt = nf + (run.to - run.from);
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
          //
          // ⚠️ 标上 `stageId`：**两端**（放弃的和吃进来的）都是本段自己的
          // 意图。不标的话，实测 ⑨（段身右移 1 格）会被夜行衣段捡走 ——
          // 它底座里没有 #5，却因为行级 op 而画出 `st-night:5[400+100]`，
          // 还并一条 `local:林昭:5`，三块叠在一起。
          ops.push({
            order: o, present: inNew,
            manual: inNew && (o < run.from || o > run.to),
            stageId: run.stageId,
          });
        }
        if (!ops.length) return;
        const affected: string[] = [];
        for (let o = lo; o <= hi; o++) {
          const sh = orderToShot.get(o);
          if (sh) affected.push(sh.id);
        }
        if (!recordWithUndo(
          `平移「${row.name}」#${run.from}-#${run.to} → #${nf}-#${nt}`,
          row.name, ops, affected)) {
          p.onToast("台账尚未就绪，这次平移没有保存 —— 请稍后重试");
          return;
        }
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
      <div ref={rootRef} className="fw-at-empty" data-row-kind={p.kind}
        onDragOver={onLaneDragOver} onDrop={(e) => onLaneDrop(e)}>
        <KindIcon size={12} />
        {p.kind === "character" ? "尚无人物造型，可在「AI 图片」生成资产后拖到此处"
          : p.kind === "location" ? "尚无场景，拆解剧本后自动生成"
            : "把资产库里的图片拖到这里，作为该时间段的额外参考"}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`fw-at kind-${p.kind}`} data-row-kind={p.kind}>
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
              //
              // ⚠️ 预览值要**夹在 `run.reach` 里**（不是当前 `from..to`）。
              // 手势窗口就是 `reach`，落点由它保证合法；这里再夹一道是因为
              // 渲染不能信任"历史拖动留下的状态"——`edge` 只在拖动期间存在，
              // 但它参与视觉的是**每一帧的自由变量**，越界的值会画出
              // 覆盖另一造型的块，那正是用户报的"覆盖重叠"。
              const from = edge?.runId === run.id && edge.edge === "from"
                ? Math.min(Math.max(edge.order, run.reach[0]), run.to) : run.from;
              const to = edge?.runId === run.id && edge.edge === "to"
                ? Math.max(Math.min(edge.order, run.reach[1]), run.from) : run.to;
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
                    onPointerDown={(e) => { if (e.button === 0) beginEdgeDrag(e, row, run, "from"); }} />
                  <span className="fw-at-edge right"
                    title="拖动改变生效终点（吸附到镜头边界）"
                    onPointerDown={(e) => { if (e.button === 0) beginEdgeDrag(e, row, run, "to"); }} />
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
