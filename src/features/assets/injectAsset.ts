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
import type { ShotInfo } from "../../api";

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
