/**
 * dev/AssetTrackHarness.tsx —— 资产轨的**真机验证台**（仅 dev，生产不打包）
 *
 * 为什么需要它：`scripts/verify-draggeom.ts` 那一类手工重放，验证的是"我把
 * `beginEdgeDrag` + `applyEdge` 的逻辑抄一遍、抄得对不对"。它既不能证明真组件
 * 跑的是同一套，也看不见**预览与渲染两套几何打架**（`pv.widthPx` 直接写内联
 * width，而渲染路径拿 `edge.order` 再算一遍 left/width）。
 *
 * 这个台子把**真的 `AssetTrack`** 挂起来，喂一份确定的 fixture，让 Playwright 用
 * **真指针事件**驱动。台子本身只会"读"：读台账投影、读 DOM 实测几何、读行高。
 * 几何的"应当值"一律由被测组件自己算（它的 `style.left/width` 就是），台子
 * 另算一套只用来做**对照**，不参与断言口径的制定。
 *
 * 用法：http://127.0.0.1:1430/?at-harness=1
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import AssetTrack from "../features/assets/AssetTrack";
import type { AssetTrackKind } from "../features/assets/AssetTrack";
import type { AssetInfo, LocationInfo, ShotInfo, StageInfo } from "../api";
import {
  deleteRunOrders, displayManualAddsOf, displayOrdersOf, inverseOps,
  pasteRunOrders, readRunOrders, setAssetSyncContext, useAssetOverride,
  useAssetOverrideRev,
} from "../stores/assetOverrideStore";
import type { AssetOverrideOp, AssetOverrideTable } from "../features/assets/assetOverrides";
import { opsOf, projectStages, stageIdAt } from "../features/assets/assetOverrides";
import { assetDropStageFacts } from "../features/assets/dropContext";
import { commitAssetDrop, type AssetDropCtx } from "../features/assets/useAssetDrop";
import { injectAssetIntoShot } from "../features/assets/injectAsset";
import type { AssetDragData } from "../api";
import "../styles/tokens.css";
import "../styles.css";

const PROJECT_ID = "harness";
const PX_PER_SEC = 20;          // 1 镜 = 5 秒 = 100px，正好一格
const SHOT_SEC = 5;
const MIN_ORDER = 1;
const MAX_ORDER = 12;
/** 造一个"外部素材镜"（不参与注入），用来测特殊镜的跳过。 */
const SPECIAL_ORDER = 8;

function makeShots(): ShotInfo[] {
  const out: ShotInfo[] = [];
  for (let o = MIN_ORDER; o <= MAX_ORDER; o++) {
    out.push({
      id: `s${o}`,
      order: o,
      episode: 1,
      script_ref: `镜${o}`,
      link_to_prev: "",
      characters: ["林昭"],
      location: "楚家公馆-客厅",
      video_url: null,
      thumb_url: null,
      status: "adopted",
      adopted_version: 1,
      is_special: o === SPECIAL_ORDER,
      duration_sec: SHOT_SEC,
      gen_prompt: null,
    } as unknown as ShotInfo);
  }
  return out;
}

/**
 * fixture 的底座（= "服务端"那一侧的真值，`present_orders`）。
 *
 * 布局（order 轴，1 格 = 1 镜 = 100px）：
 *   #1–#4   「林昭·常服」
 *   #5–#7   公共空地（同角色另一造型没占，谁先拉算谁的）
 *   #8      特殊镜（外部素材，不参与注入）
 *   #9–#12  「林昭·夜行衣」
 *   「沈砚·常服」在 #2–#3，用来测"拖到别人的行"
 *
 * 特意造出两块**分离**的区间：`splitRuns` 会把它们切成两段，`freeSpan` 让两段
 * 各自向中间的空地扩张 —— 同角色跨造型重叠就是从这儿来的。
 */
const FIXTURE = {
  stages: (): StageInfo[] => ([
    {
      id: "st-day", character_name: "林昭", stage_name: "常服",
      ep_from: 1, ep_to: 1, shot_from: 1, shot_to: 4,
      image_url: null, description: null, status: "draft",
      present_orders: [1, 2, 3, 4], manual_add_orders: [], manual_remove_orders: [],
    },
    {
      id: "st-night", character_name: "林昭", stage_name: "夜行衣",
      ep_from: 1, ep_to: 1, shot_from: 9, shot_to: 12,
      image_url: null, description: null, status: "draft",
      present_orders: [9, 10, 11, 12], manual_add_orders: [], manual_remove_orders: [],
    },
    {
      id: "st-shen", character_name: "沈砚", stage_name: "常服",
      ep_from: 1, ep_to: 1, shot_from: 2, shot_to: 3,
      image_url: null, description: null, status: "draft",
      present_orders: [2, 3], manual_add_orders: [], manual_remove_orders: [],
    },
  ] as unknown as StageInfo[]),
  locations: (): LocationInfo[] => ([
    {
      name: "楚家公馆-客厅", image_url: null,
      present_orders: [1, 2, 3, 4, 5], manual_add_orders: [], manual_remove_orders: [],
    },
  ] as unknown as LocationInfo[]),
  assets: (): AssetInfo[] => ([
    { id: "a-ling", kind: "character", name: "林昭", image_url: null },
    { id: "a-shen", kind: "character", name: "沈砚", image_url: null },
    { id: "a-loc", kind: "location", name: "楚家公馆-客厅", image_url: null },
    { id: "a-custom", kind: "custom", name: "打光参考", image_url: null },
  ] as AssetInfo[]),
};

/** 一段在 DOM 里的实测样子 */
interface DomRun {
  id: string;
  stageName: string;
  /** 相对 lane 左边缘的实测像素 */
  left: number;
  width: number;
  /** 内联样式原文 —— 预览若还挂着，这里会留下宽/位移 */
  inlineWidth: string;
  inlineTransform: string;
  inlineLeft: string;
  rowsHint: string;
}

function Harness() {
  const [kind, setKind] = useState<AssetTrackKind>("character");
  const [seed, setSeed] = useState(0);
  const rev = useAssetOverrideRev();
  const table = useAssetOverride((s) => s.table);

  const shots = useMemo(() => makeShots(), []);

  /**
   * ⚠️ **必须打开台账**，否则这个台子测的全是空气。
   *
   * `useAssetOverride.record()` 第一行是 `if (!projectId) return false` —— 没
   * `openProject` 过的 store，`projectId` 是空串，**每一次写入都被静默丢掉**。
   * 台子照样预览、照样弹 toast，于是看起来"拖动生效了"，可台账里一条 op 都没有，
   * 松手回弹。这里少这一句，探针得出的所有结论（"拉长完全没反应"、"左边缘拖不动"）
   * 都是这个假象，不是组件的问题。
   *
   * 真机上这条由 `App.tsx` 的 `useEffect([projectId])` 负责；台子没有 App 外壳，
   * 得自己接上。
   */
  useEffect(() => {
    useAssetOverride.getState().openProject(PROJECT_ID);
  }, []);

  /** 真机上落库/投影用的 `ctx`（`App.tsx` 里那段 `setAssetSyncContext`）在这里
   *  复刻一份最小版：`baseOf` 读 fixture 底座，`pushUndo` 丢弃（台子不测撤销栈）。
   *  不接的话 `deleteRunOrders` / `pasteRunOrders` 会把"底座为空"当成真值 ——
   *  它们正是靠底座算"这一行现在显示哪些镜头"的。 */
  useEffect(() => {
    setAssetSyncContext({
      projectId: PROJECT_ID,
      shots,
      baseOf: (rowName) => {
        // ⚠️ **按角色名取并集**，与 App 里 `setAssetSyncContext` 的口径一致。
        // 一个角色可以有多套造型（这里「林昭」= 常服 #1-4 ∪ 夜行衣 #9-12），
        // 台账是**按行名（角色名）**记账的，底座若只取 `find` 到的第一个造型，
        // 台子里的 `readRunOrders/deleteRunOrders/pasteRunOrders` 就只认常服那
        // 四个 order —— 测夜行衣的删除会返回空数组，看着像"删除快捷键坏了"，
        // 其实是台子自己少喂了一半数据。
        const same = FIXTURE.stages().filter((s) => s.character_name === rowName);
        if (same.length) {
          return {
            present: [...new Set(same.flatMap((s) => s.present_orders ?? []))].sort((a, b) => a - b),
            manualAdd: [...new Set(same.flatMap((s) => s.manual_add_orders ?? []))].sort((a, b) => a - b),
            isSpecial: false,
            isLocation: false,
          };
        }
        const st = same[0];
        if (st) {
          return {
            present: st.present_orders, manualAdd: [], isSpecial: false, isLocation: false,
          };
        }
        const loc = FIXTURE.locations().find((l) => l.name === rowName);
        if (loc) {
          // 场景轨的底座就是它的 `present_orders`；台子里放 `loc.present_orders`。
          return {
            present: loc.present_orders, manualAdd: [], isSpecial: false, isLocation: true,
          };
        }
        return null;
      },
      pushUndo: () => {},
    });
    return () => setAssetSyncContext(null);
  }, [shots]);

  const offsetMap = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of shots) m.set(s.order, (s.order - MIN_ORDER) * SHOT_SEC);
    return m;
  }, [shots]);

  const { stages, locations, assets } = useMemo(() => ({
    stages: FIXTURE.stages(),
    locations: FIXTURE.locations(),
    assets: FIXTURE.assets(),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [seed]);

  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [pushes, setPushes] = useState(0);

  /**
   * 造型底座 + 「这个角色自己的造型 id」——**只组装一次**，两个下游共用：
   * `assetDropCtx`（拖卡片落点）与 `iface.injectDirect`（探针点名注入）。
   *
   * 两处各调一次工厂的话，等于又留了两份能各自漂移的真相 —— 这次是在
   * 同一个文件里，比跨文件更难发现。
   */
  const stageFacts = useMemo(() => assetDropStageFacts(stages), [stages]);

  /**
   * 资产卡**拖拽落点**的上下文（真机上由 `App.tsx` 的 `assetDropCtx` useMemo 组装）。
   *
   * ⚠️ 台子以前**不给**这个 ctx，于是「从资产窗拖卡片到轨道」这条链
   * （`LibraryPanel.dragStartAssetPointer` → `startDrag` → `commitAssetDrop`
   * → `injectAssetIntoShot`）在台子上**根本跑不到** —— 探针只能绕过它、自己抄一份
   * 注入逻辑，于是"toast 说成功、轨道上什么都没有"这类偏差永远测不出来。
   * 用户实测的正是这条链，所以台子必须把它接上。
   */
  const assetDropCtx = useMemo<AssetDropCtx>(() => ({
    // ⚠️ 造型底座 + 「这个角色自己的造型 id」**从真机的同一个工厂取**
    // （features/assets/dropContext.ts）。以前这里是与 App.tsx 逐字重复的一份，
    // 靠注释「与 App.tsx 同款」手工同步 —— 而这个台子是**唯一能自动跑这条链**
    // 的地方，两边口径一旦能各自漂移，"台子绿了"就推不出"真机对了"。
    ...stageFacts,
    projectId: PROJECT_ID,
    shots,
    offsetMap,
    pxPerSec: PX_PER_SEC,
    // ⚠️ 台账要**现读**：`stageIdAt` 靠它认"先缩掉、再拖回来"那一格的原作者。
    table: useAssetOverride.getState().table,
    onToast: (m) => setToast(m),
    onPushUndo: () => setPushes((n) => n + 1),
    onChanged: () => {},
  }), [shots, offsetMap, stageFacts, rev]);

  const isSpecial = useCallback((o: number) => o === SPECIAL_ORDER, []);

  /**
   * 某一行的底座（fixture 真值）。
   *
   * ⚠️ **要按造型聚合，不能用 `find` 拿第一个同名造型**。一个角色可以有多套
   * 造型（这里「林昭」就有常服 #1-4 与夜行衣 #9-12），而**台账是按角色名记的**
   * ——`displayOrdersOf(base, …, "林昭")` 里那个 `base` 只是"补集运算的起点"，
   * 真正参与渲染的是"台账投影到这一行"。`find` 取第一个，测夜行衣那一行时
   * 起点就成了常服的 #1-4，投影出来的集合与组件画的根本不是同一份，
   * 台子就变成了在和自己的错觉对账。
   */
  const baseOfRow = useCallback((name: string) => {
    const st = stages.filter((s) => s.character_name === name);
    if (st.length) return [...new Set(st.flatMap((s) => s.present_orders ?? []))].sort((a, b) => a - b);
    const loc = locations.find((l) => l.name === name);
    return loc ? [...(loc.present_orders ?? [])].sort((a, b) => a - b) : [];
  }, [stages, locations]);

  /** 某一行的底座 + 台账投影后的 order */
  const shownOf = useCallback((name: string) => {
    return displayOrdersOf(baseOfRow(name), PROJECT_ID, name, isSpecial);
  }, [baseOfRow, isSpecial]);

  /**
   * **造型级**投影 —— 探针核对几何时该用的那一份。
   *
   * ⚠️ 上面的 `shownOf` 是**行级**并集（后端就是按角色名寻址），它无法表达
   * "同一角色的两套造型各自管哪些镜头"：常服 #1-6 与夜行衣 #9-12 的并集是
   * `[[1,6],[9,12]]`，夜行衣要是在 #5 另有一段，并集里根本看不出来，
   * `domMatchesLedger` 就会把**量具的失真**报成组件的错。
   */
  const stageShownOf = useCallback((name: string) => {
    const same = stages.filter((st) => st.character_name === name);
    if (!same.length) {
      const loc = locations.find((l) => l.name === name);
      if (!loc) return [];
      return projectStages(
        [{ stageId: undefined, base: loc.present_orders ?? [] }],
        opsOf(useAssetOverride.getState().table, name), isSpecial);
    }
    return projectStages(
      same.map((st) => ({ stageId: st.id, base: st.present_orders ?? [] })),
      opsOf(useAssetOverride.getState().table, name), isSpecial);
  }, [stages, locations, isSpecial]);

  const reset = useCallback(() => {
    localStorage.removeItem(`fw_asset_ovr:${PROJECT_ID}`);
    // ⚠️ 光删 localStorage 不够：`openProject` 见 `projectId` 没变会直接早退，
    // 内存里那份旧 `table` 还在，上一轮的 op 会跟着下一轮测试跑。
    // `adoptTable(PROJECT_ID, {})` = "就当这个项目刚建、台账空白" —— 这才是
    // 真机上"刷新页面"的效果。以前这里直接 `setState`，绕过了 store 的
    // 具名动作（连"换项目要掐掉挂着的落库定时器"这件事都要在台子里复写一遍）。
    useAssetOverride.getState().adoptTable(PROJECT_ID, {});
    setSeed((n) => n + 1);
    setToast("");
  }, []);

  /** 台子的对外接口（Playwright 侧只碰这一个对象） */
  const iface = useMemo(() => {
    const readRuns = (): DomRun[] => {
      const out: DomRun[] = [];
      document.querySelectorAll<HTMLElement>(".fw-at-run").forEach((el) => {
        const lane = el.closest<HTMLElement>(".fw-at-lane");
        const box = lane?.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const row = el.closest<HTMLElement>(".fw-at-row");
        out.push({
          id: el.dataset.runId ?? "",
          stageName: el.dataset.runStageName ?? "",
          left: box ? r.left - box.left : NaN,
          width: r.width,
          inlineWidth: el.style.width,
          inlineTransform: el.style.transform,
          inlineLeft: el.style.left,
          rowsHint: row?.dataset.rowName ?? "",
        });
      });
      return out;
    };

    return {
      projectId: PROJECT_ID,
      pxPerSec: PX_PER_SEC,
      shotSec: SHOT_SEC,
      minOrder: MIN_ORDER,
      maxOrder: MAX_ORDER,
      specialOrder: SPECIAL_ORDER,
      kind: () => kind,
      setKind: (k: AssetTrackKind) => setKind(k),
      /** 台账投影后的 order（人话：这一行现在管哪些镜头） */
      shownOf,
      /** 造型级投影：`[{stageId, shown, manual}]` —— 与组件渲染同一坐标系 */
      stageShownOf,
      /** 台账原文 */
      ops: () => JSON.parse(JSON.stringify(useAssetOverride.getState().table)),
      manualAddsOf: (name: string) => displayManualAddsOf(
        baseOfRow(name), shownOf(name), PROJECT_ID, name),
      /** 该行现在渲染出来的段（id / 区间 / 造型名），供探针做"画出来的与
       *  台账投影一致吗"这类对照 —— 单看台账数字看不出渲染层有没有漏段。 */
      domRunsOf: (name: string) => readRuns()
        .filter((r) => r.rowsHint === name)
        .map((r) => ({ id: r.id, stage: r.stageName, width: r.width })),
      /** DOM 实测 */
      runs: readRuns,
      rowCount: () => document.querySelectorAll(".fw-at-row").length,
      laneBox: (rowName: string) => {
        const row = document.querySelector<HTMLElement>(`.fw-at-row[data-row-name="${rowName}"]`);
        const lane = row?.querySelector<HTMLElement>(".fw-at-lane");
        const r = (lane ?? row)?.getBoundingClientRect();
        return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
      },
      el: (runId: string) =>
        document.querySelector<HTMLElement>(`.fw-at-run[data-run-id="${runId}"]`),
      edgeEl: (runId: string, side: "left" | "right") =>
        document.querySelector<HTMLElement>(`.fw-at-run[data-run-id="${runId}"] .fw-at-edge.${side}`),
      toast: () => toast,
      selected: () => selected,
      reset,
      clearRow: (name: string) => useAssetOverride.getState().clearRow(name),
      /** 直接往台账写（用来摆"用户先拖了几下"的场面）。台账没打开就抛，
       *  免得探针又把"被丢弃的写入"当成组件的行为。 */
      seedOps: (name: string, ops: Array<{ order: number; present: boolean; manual: boolean }>) => {
        if (!useAssetOverride.getState().record(name, ops)) {
          throw new Error("seedOps 被台账拒绝（projectId 为空？）—— 验证台状态不对");
        }
      },
      /** 键盘路径（Delete / Ctrl+C / Ctrl+V）在真机上由 App 调这三个函数；
       *  台子没有 App，直接把它们挂出来，好让探针走**同一份规则**而不是另抄一遍。 */
      // `stageId` 可选：探针要能同时测"盖了章的"（真机上组件传的）与
      // "没盖章的"（旧 localStorage 里遗留的 op）两种。
      deleteRun: (name: string, from: number, to: number, stageId?: string) =>
        deleteRunOrders(PROJECT_ID, name, from, to, shots, false, stageId),
      readRun: (name: string, from: number, to: number) =>
        readRunOrders(PROJECT_ID, name, from, to, shots),
      pasteRun: (name: string, orders: readonly number[], at: number,
        blocked: readonly number[], stageId?: string) =>
        pasteRunOrders(PROJECT_ID, name, orders, at, shots, new Set(blocked), stageId),
      /** 撤销面：把一批已应用的 op 按真机的 `inverseOps` 反过来再记一次。
       *  真机上的 Ctrl+Z 是**记账**（不是发请求），所以这里走同一个函数 —— 探针
       *  才能验"章有没有跟着逆操作活下来"。旧版 `inverseOps` 把 `stageId` 丢了，
       *  撤销一次注入会凭空冒出一条「未设阶段」兜底段。 */
      undoInverse: (name: string, ops: Array<Omit<AssetOverrideOp, "at">>) =>
        useAssetOverride.getState().record(name, inverseOps(ops)),

      /** 拖拽落点的上下文（探针想自己拼落点时用得上）。 */
      dropCtx: () => assetDropCtx,
      /** 撤销栈被推了几次（只有真注入成功才该推）。 */
      pushes: () => pushes,

      /**
       * **从资产窗拖一张卡到自己那一行**：走真的落点判定 + 真的入库链。
       *
       * 与 `LibraryPanel.dragStartAssetPointer` 松手那一刻等价，只是把
       * "指针现在落在哪个元素上"换成了"就落在这一行的第 order 格上"：真机靠
       * `elementFromPoint` 找落点，台子直接给出那一格的 x 坐标 + 那一行自己的
       * lane 元素，于是 `assetDropTargetAt` 得到的 target 与真机同形。
       *
       * `img` 传 null = "还没有图的人物资产卡"；只有落到**已存在的资产段**
       * 上才需要图，落到行/镜头轨不需要。
       */
      dropCard: (opts: {
        row: string; order: number; name: string;
        kind?: "character" | "location" | "custom"; img?: string | null;
      }) => {
        const rowEl = document.querySelector<HTMLElement>(
          `.fw-at-row[data-row-name="${opts.row}"]`);
        const lane = rowEl?.querySelector<HTMLElement>(".fw-at-lane");
        if (!lane) return Promise.resolve(false);
        const box = lane.getBoundingClientRect();
        const x = box.left + (opts.order - MIN_ORDER) * SHOT_SEC * PX_PER_SEC
          + PX_PER_SEC / 2;
        const target = {
          kind: "lane" as const, rowName: opts.row, isLocation: false, el: lane,
        };
        const data = {
          kind: opts.kind ?? "character", name: opts.name,
          imageUrl: opts.img ?? null,
        } as unknown as AssetDragData;
        return commitAssetDrop(target, data, x, assetDropCtx);
      },

      /**
       * 直接调**注入函数本身**（不经落点判定），用来看它自己的返回值与话术。
       *
       * 拖拽链 `commitAssetDrop` 的返回值是"落点接住了没有"，落到空地也返回
       * true；"这次注入有没有真的改变画面"只有注入函数自己知道 —— 探针要分开量。
       */
      injectDirect: (opts: { name: string; order: number }) => {
        // ⚠️ 走**真机那条链**（`injectAssetIntoShot`），并且底座/归属从同一个
        // 工厂取。以前这里手搓了一遍 `stages.map(...)`，与 `assetDropCtx` 里
        // 那一份是同一段代码的第二个副本 —— 探针注入与拖拽注入走两条路，
        // 测出来的结论就只对其中一条成立。
        const stageId = stageIdAt(
          stageFacts.stages, opsOf(useAssetOverride.getState().table, opts.name), opts.order);
        return injectAssetIntoShot({
          projectId: PROJECT_ID, name: opts.name, isLocation: false,
          shot: shots.find((x) => x.order === opts.order)!,
          order: opts.order, stageId,
          // ⚠️ `stageFacts.ownStageIds` 是**按行名取**的工厂（`AssetDropCtx` 要的
          // 形状），`InjectArgs` 要的是**已经取好的那一个集合**。别把工厂直接铺开
          // 传进去 —— 类型会拦（上面这行就是），但更要紧的是语义：这里问的正是
          // "opts.name 这一行自己有哪些造型"。`stages` / `ownStageIds` 必须同源，
          // 所以两者都从 `stageFacts` 取，不另算。
          stages: stageFacts.stages,
          ownStageIds: stageFacts.ownStageIds(opts.name),
          ops: opsOf(useAssetOverride.getState().table, opts.name),
          onToast: (m) => setToast(m),
          onChanged: () => {},
        });
      },

      /**
       * 把台账"关掉"（回到还没 `openProject` 的那一帧）。
       *
       * 真机上这一刻确实存在：`App.tsx` 是在拿到 `projectId` 之后的 effect 里才
       * `openProject`，首帧渲染时 store 里的 `projectId` 还是空串。此时
       * `record()` 第一行 `if (!projectId) return false` —— **什么都不该改，
       * 包括那句 toast**。老版 `injectAssetIntoShot` 把返回值丢掉、无条件报
       * 「已注入镜头 #N（Ctrl+Z 可撤销）」，于是用户看到成功提示、轨道上什么都没有。
       *
       * 返回快照，`reopenLedger` 用它原样放回去（探针不该污染后续小节）。
       */
      closeLedger: () => {
        const st = useAssetOverride.getState();
        const snap = { projectId: st.projectId, table: st.table };
        st.unloadProject();
        return snap;
      },
      reopenLedger: (snap?: { projectId: string; table: AssetOverrideTable }) => {
        useAssetOverride.getState().adoptTable(
          snap?.projectId ?? PROJECT_ID, snap?.table ?? {});
      },
    };
  }, [kind, shownOf, stageShownOf, baseOfRow, stages, shots, toast, selected,
    reset, assetDropCtx, stageFacts, pushes]);

  (window as unknown as Record<string, unknown>).__atHarness = iface;
  (window as unknown as Record<string, unknown>).__atRev = rev;
  void table;

  return (
    <div style={{ padding: 12, background: "var(--c-bg)", minHeight: "100vh" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 12, alignItems: "center" }}>
        <button data-h="reset" onClick={reset}>重置</button>
        <button data-h="kind-char" onClick={() => setKind("character")}>人物轨</button>
        <button data-h="kind-loc" onClick={() => setKind("location")}>场景轨</button>
        <button data-h="kind-ref" onClick={() => setKind("reference")}>参考轨</button>
        <span data-h="toast">{toast}</span>
        <span data-h="rev">rev={rev}</span>
        <span data-h="sel">sel={selected ?? "-"}</span>
      </div>
      <div style={{ width: 1400, overflowX: "auto", border: "1px solid #444" }}>
        <AssetTrack
          kind={kind}
          shots={shots}
          stages={stages}
          locations={locations}
          assets={assets}
          projectId={PROJECT_ID}
          pxPerSec={PX_PER_SEC}
          offsetMap={offsetMap}
          cursorOrder={null}
          rowHeight={28}
          span={{ fromPx: -1e6, toPx: 1e6 }}
          onChanged={() => {}}
          onPushUndo={() => {}}
          onToast={(m) => setToast(m)}
          onSelectRun={(r) => setSelected(r.id)}
          onRegenerate={() => {}}
          selectedRunId={selected}
        />
      </div>
    </div>
  );
}

export default Harness;
