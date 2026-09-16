/**
 * 资产注入的**唯一**实现：把一张人物/场景资产卡片拖到时间轴上 = 在落点镜头注入它。
 *
 * ## 为什么单独抽出来
 *
 * 原先这段逻辑只长在 `AssetTrack.onLaneDrop` 里，而 AssetTrack 只渲染在**资产轨**
 * 那条 lane 上。用户实际会把卡片拖到眼前最显眼的那条轨——**镜头轨**，
 * 而镜头轨的 `onDragOver` 只认 `application/x-fw-clip`，不认就直接 return、
 * 连 `preventDefault()` 都不调。浏览器于是拒绝放置：鼠标一路显示"禁止"，
 * 松手什么都不发生，**没有任何报错、也没有任何提示**。
 * 用户看到的就是"人物、场景资产图卡片无法拖动到轨道上"。
 *
 * 修法不是把逻辑复制一份到 Timeline（两份注入逻辑必然漂移：撤销标签、
 * is_special 判定、场景/人物分支各改各的），而是抽到这里，两条 lane 共用。
 *
 * ## 落点吸附
 *
 * 注入是**按镜头**算的，不是按秒。拖到"第 12.5 秒"没有意义，必须吸附到镜头
 * 边界，否则用户以为改了、实际没改（AssetTrack 头注释里的老约束，这里沿用）。
 */
import { api } from "../../api";
import type { AssetDragData, ShotInfo } from "../../api";
import type { CommandDraft } from "../../lib/command";
import type { AssetOverrideOp } from "./assetOverrides";
import { recordWithUndo, useAssetOverride } from "../../stores/assetOverrideStore";
import { opsOf, projectStages, shownForStage, stageIdAt } from "./assetOverrides";
import type { StageBasis } from "./assetOverrides";

/** 资产轨的行/段在本模块里只用到这几个字段，用结构化子集声明，
 *  免得让这个通用模块反过来依赖 AssetTrack 的完整类型。 */
export interface RunRef {
  id: string;
  stageId?: string;
  stageName?: string;
  imageUrl?: string | null;
}


/** 秒坐标 → 最近的镜头 order（拖拽落点吸附用）。offsetMap: order → 绝对起始秒 */
export function snapSecToOrder(
  offsetMap: Map<number, number>, sec: number,
): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const [order, start] of offsetMap) {
    const d = Math.abs(start - sec);
    if (d < bestD) { bestD = d; best = order; }
  }
  return best;
}

export interface InjectArgs {
  projectId: string;
  /** 角色名 / 归一场景名 */
  name: string;
  isLocation: boolean;
  shot: ShotInfo;
  order: number;
  /**
   * 这次注入该记在哪套造型名下（`AssetStage.id`；场景轨 / 公共空地传 undefined）。
   *
   * ⚠️ 不传就退回"无主的加法"，投影层任何造型都不认领，只能画到兜底段上 ——
   * 那正是用户看到的「人工注入」。所有**人物轨**的调用方都该传
   * （`stageIdAt(p.stages, opsOf(table, name), order)`），场景轨没有造型概念，
   * 传 undefined 是对的。
   */
  stageId?: string;
  /**
   * 台账（`opsOf(table, name)`）—— 只在 `stageId` 没给时用来补推断
   * （"先缩掉、再把卡片拖回来"那一格靠它认出原作者）。没有台账就退化成
   * "只看底座"，仍然比无主强。**纯读，不写。**
   */
  ops?: readonly AssetOverrideOp[];
  /** 造型底座（人物轨传 `p.stages.map(...)`；场景轨不传） */
  stages?: readonly StageBasis[];
  /**
   * **本行（这个角色）自己**的造型 id。`stages` 是全量的（`App.tsx` 传的是
   * 整条轨所有角色的造型），投影时得先筛出属于这个角色的那些 —— 否则一个
   * 刚拖进来、服务端还没有造型行的角色会被当成"有造型"，于是它落在公共空地上
   * 的那一格投影出来是空集，被误判成"没能画上去"。
   *
   * 不传 = 不筛（所有 `stages` 都算本行的）。
   */
  ownStageIds?: ReadonlySet<string>;
  onToast: (m: string) => void;
  onChanged: () => void;
}

/**
 * 在指定镜头注入资产（可撤销）。返回是否真的注入了。
 *
 * 3.13：**只写本地台账**，不发请求。整条注入链（AssetTrack 的落点、指针拖拽的
 * 落点、镜头轨的落点）都走这里，落库由 store 的防抖队列在"要调后端能力"时统一上传。
 *
 * 失败/被拒绝时**一律 toast 说明原因**——静默失败正是这个 bug 的本体，
 * 修完不能留下"另一种形式的静默"。
 */
export function injectAssetIntoShot(a: InjectArgs): boolean {
  if (a.shot.is_special) {
    a.onToast("外部素材镜头不参与 AI 参考注入");
    return false;
  }
  if (!a.name) { a.onToast("这条轨需要先有角色/场景行"); return false; }
  // ⚠️ 必须**盖章**（`stageId`）。不盖的话这条 op 在投影层是"无主的加法"，
  // 任何造型都不认领它，界面只能把它画成兜底段（旧名「人工注入」）——
  // 用户从资产窗拖一张卡到自己那行的造型区间里，看到的却是系统生成的口气。
  // 归属推断见 `stageIdAt`；人物轨的调用方会把 `stageId` 直接传来。
  const stageId = a.stageId ?? (a.stages
    ? stageIdAt(a.stages, a.ops ?? [], a.order)
    : undefined);
  // ⚠️ **返回值必须看**。`recordWithUndo` 返回 false = 台账根本没接受这批 op
  // （没 openProject / 空 op）。老写法把它丢掉、无条件报成功，于是"台账一条没写、
  // toast 说已注入" —— 那正是用户看到的"提示注入成功，轨道上什么都没有"。
  if (!recordWithUndo(
    `「${a.name}」注入镜头 #${a.order}`,
    a.name,
    [{ order: a.order, present: true, manual: true, stageId }],
    [a.shot.id])) {
    a.onToast("台账尚未就绪，这次注入没有保存 —— 请稍后重试");
    return false;
  }

  // ⚠️ 台账收下了 ≠ 用户看得见。这是同一个 bug 的第二次现身。
  //
  // 落点那一格**本来就在这套造型的底座里**时，注入是**空操作**：造型段的宽度
  // 一格不变，用户盯着轨道找不到"刚出现的那一段"，而 toast 已经在替他宣布
  // 成功了。另一种情形是写进去了、但投影层把它判给了别的造型（`stageIdAt` 认的
  // 作者与渲染层认的不是同一套），那一格画在另一段里。两种情况都不该说"已注入"
  // —— 那是在替一个没发生的变化背书。
  const outcome = injectionOutcome(a);
  if (outcome === "already") {
    a.onToast(`镜头 #${a.order} 上「${a.name}」本来就已经生效 —— 轨道上没有新块可看`);
    return false;
  }
  if (outcome === "invisible") {
    a.onToast(`「${a.name}」没能画到镜头 #${a.order} 上（这一段归了别的造型）—— 请刷新后重试`);
    return false;
  }
  a.onToast(`「${a.name}」已注入镜头 #${a.order}（Ctrl+Z 可撤销）`);
  return true;
}

/**
 * 这次注入之后，用户在轨道上会看到什么。三种结果：
 *
 *   · `"shown"` —— 这一格确实画在某一段里（正常）。
 *   · `"already"` —— 写之前它就已经在这一段里了（底座就声明过 / 台账里已生效）。
 *     注入是空操作，宽度不变。**这不是报错**，但不能说"已注入"。
 *   · `"invisible"` —— 写进去了，可投影层没在任何一段里画出这一格。
 *
 * 判据必须与渲染层同源：拿**刚写进台账的最新的 op**（`opsOf` 现读 store，
 * 不能用手里的 `a.ops` —— 那是落点判定时的旧快照）重跑一次投影。没有造型
 * （场景轨 / 空轨）时退化成兜底段那一次投影（`stageId: undefined`），与
 * `AssetTrack` 画 `local:` 段的口径一致。
 */
function injectionOutcome(
  a: InjectArgs,
): "shown" | "already" | "invisible" {
  const isSpecial = (o: number) => !!a.shot.is_special && o === a.order;
  const before = project(a, a.ops ?? [], isSpecial);
  const after = project(a, opsOf(useAssetOverride.getState().table, a.name), isSpecial);
  if (!after) return "invisible";
  if (!before) return "shown";
  return "already";
}

/**
 * 这一格在给定 op 集合下有没有被画出来（哪一段里都行）。
 *
 * ⚠️ **有造型 ≠ 这个角色有造型**。`a.stages` 是整条轨所有角色的造型，所以
 * 判据必须是"这个角色**自己的**造型里有没有画出这一格"，没有的话还要再问一次
 * 兜底段（`AssetTrack` 给"谁都没声明过的公共空地"合成的那条「未设阶段」段，
 * 它的投影就是 `shownForStage([], ops, 别人的覆盖, …)`）。
 * 只判 `a.stages` 非空、或只判兜底段，都会得出相反的结论：
 *   · 往公共空地上拖 → 造型段全是别家的 → 被误判 "没能画上去"
 *   · 往自己造型区间里拖 → 兜底段空 → 被误判 "没能画上去"
 * 两种误判都会让用户看见一段已经画出来的注入，却收到一句"没画上"。
 */
function project(
  a: InjectArgs, ops: readonly AssetOverrideOp[], isSpecial: (o: number) => boolean,
): boolean {
  const all = a.stages ?? [];
  const mine = all.filter((s) => !a.ownStageIds || a.ownStageIds.has(s.stageId ?? ""));
  if (mine.length && projectStages(mine, ops, isSpecial)
    .some((p) => p.shown.includes(a.order))) return true;
  const covered = new Set<number>();
  for (const s of all) for (const o of s.base ?? []) covered.add(o);
  return shownForStage([], ops, covered, isSpecial, undefined)
    .shown.includes(a.order);
}

export interface ReplaceRunArgs {
  projectId: string;
  /** 行名：角色名 / 归一场景名 */
  rowName: string;
  /** 拖进来的卡片 */
  d: AssetDragData;
  run: RunRef;
  /** 这条轨是场景轨吗（决定 kind 归类） */
  isLocation: boolean;
  /** C2：改收 `CommandDraft`（与整条资产链一致，`run` 必填）。 */
  onPushUndo: (draft: CommandDraft) => void;
  onToast: (m: string) => void;
  onChanged: () => void;
}

/**
 * 把一张图**换到某个造型段上**（拖卡片到段的落点）。
 *
 * 这是从 `AssetTrack.replaceStageImage` 原样搬过来的 —— 搬家的理由不是"想
 * 复用"，而是 3.11 之后它有了**第二个调用方**：指针拖拽的落点判定在
 * `useAssetDrop.ts` 里，也认 `.fw-at-run`。两份实现并存的话，"拖到段上"
 * 会随拖拽通道不同而行为不同（撤销标签、virtual 段分支、custom 归类
 * 三处都会漂），这是最难查的一类 bug。
 *
 * `virtual`（没有 AssetStage 行的服务端合成段）没有 stage 可 patch，
 * 只能走 `upsertAssetImage`；这个分支必须留着，场景轨的段多半是 virtual。
 */
export async function replaceRunImage(a: ReplaceRunArgs): Promise<boolean> {
  const d = a.d;
  if (!d.imageUrl) {
    // 没有图的自定义素材拖进来，意义是**归类**而不是换图
    if (d.kind === "custom" && d.assetId) {
      await api.patchAsset(d.assetId, { kind: a.isLocation ? "location" : "character" });
      a.onToast(`「${d.name}」已归类，可在「AI 图片」里生成图`);
      a.onChanged();
      return true;
    }
    a.onToast(`「${d.name}」还没有图——先在「AI 图片」里生成`);
    return true;
  }

  const kind = a.isLocation ? "location" : "character";
  const stageId = a.run.stageId;
  const isVirtual = !stageId || a.run.id.startsWith("loc:");
  const prevImg = a.run.imageUrl ?? null;
  const label = `替换「${a.rowName}${a.run.stageName ? `·${a.run.stageName}` : ""}」参考图`;
  try {
    const restore = async (img: string | null) => {
      if (isVirtual) {
        if (img) await api.upsertAssetImage(a.projectId, kind, a.rowName, img);
      } else {
        await api.patchStage(stageId!, { image_url: img ?? "" });
      }
    };
    await restore(d.imageUrl);
    if (d.kind === "custom" && d.assetId) {
      await api.patchAsset(d.assetId, { kind });
    }
    a.onPushUndo({
      label,
      kind: "asset",
      unrun: async () => {
        // 归类**不在**撤销范围内：原实现也没管（undo 只回图）。要一起回退的话
        // 得先记住这张卡原来的 kind，而那个值不在本函数的入参里 —— 与其
        // 猜一个，不如明确不做，保持与原路径一致。
        await restore(prevImg); a.onChanged();
      },
      run: async () => { await restore(d.imageUrl); a.onChanged(); },
    });
    a.onToast(`已用「${d.name}」替换「${a.rowName}${a.run.stageName ? `·${a.run.stageName}` : ""}」的参考图`);
    a.onChanged();
    return true;
  } catch (e) {
    a.onToast(String(e));
    return false;
  }
}
