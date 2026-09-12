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
  onPushUndo: (
    label: string, undo: () => Promise<void>, redo: () => Promise<void>,
  ) => void;
  onToast: (m: string) => void;
  onChanged: () => void;
}

/**
 * 在指定镜头注入资产（可撤销）。返回是否真的注入了。
 *
 * 失败/被拒绝时**一律 toast 说明原因**——静默失败正是这个 bug 的本体，
 * 修完不能留下"另一种形式的静默"。
 */
export async function injectAssetIntoShot(a: InjectArgs): Promise<boolean> {
  if (a.shot.is_special) {
    a.onToast("外部素材镜头不参与 AI 参考注入");
    return false;
  }
  const opts = { isLocation: a.isLocation };
  try {
    await api.refOverrides(a.projectId, a.name, { addShotIds: [a.shot.id], ...opts });
    a.onPushUndo(`「${a.name}」注入镜头 #${a.order}`,
      async () => {
        await api.refOverrides(a.projectId, a.name, { removeShotIds: [a.shot.id], ...opts });
        a.onChanged();
      },
      async () => {
        await api.refOverrides(a.projectId, a.name, { addShotIds: [a.shot.id], ...opts });
        a.onChanged();
      });
    a.onToast(`「${a.name}」已注入镜头 #${a.order}（Ctrl+Z 可撤销）`);
    a.onChanged();
    return true;
  } catch (err) {
    a.onToast(String(err));
    return false;
  }
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
  onPushUndo: (
    label: string, undo: () => Promise<void>, redo: () => Promise<void>,
  ) => void;
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
    a.onPushUndo(label,
      async () => {
        // 归类**不在**撤销范围内：原实现也没管（undo 只回图）。要一起回退的话
        // 得先记住这张卡原来的 kind，而那个值不在本函数的入参里 —— 与其
        // 猜一个，不如明确不做，保持与原路径一致。
        await restore(prevImg); a.onChanged();
      },
      async () => { await restore(d.imageUrl); a.onChanged(); });
    a.onToast(`已用「${d.name}」替换「${a.rowName}${a.run.stageName ? `·${a.run.stageName}` : ""}」的参考图`);
    a.onChanged();
    return true;
  } catch (e) {
    a.onToast(String(e));
    return false;
  }
}
