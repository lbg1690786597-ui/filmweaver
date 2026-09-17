/**
 * desubEdit — 去字幕标记的四个写入口（改区间 / 删 / 删单条 / 定位）
 *
 * ## 为什么不放在 App.tsx 里
 *
 * 它们是纯函数式的编辑逻辑：读一份 `shots`、算出新的 `transform_meta`、
 * 交给注入进来的 `commitTransform` 发出去。不依赖任何 React 状态，
 * 所以按架构守卫钉的那条线（App.tsx「只许减」）外置到这里。
 *
 * ## 为什么不走 `onEditClip`（`clipEdit.ts` 那张分派表）
 *
 * 那张表是「实体 → 后端端点」的映射，镜头/音频/字幕各有自己的 PATCH。
 * 去字幕标记**没有自己的端点** —— 它住在 `shot.transform_meta.desub` 里，
 * 写它就是写这一镜的 transform。所以「读出整个 transform_meta、换掉数组里的
 * 一项、整体发回去」这一步只能在拿得到那个口袋的地方做。
 *
 * ## 为什么用 `commitTransform` 而不是 `doPatchTransform`
 *
 * 时间轴的手势层要 `await` 这次提交，好让 DOM 预览一直挂到数据回来（3.12 F4）。
 * `doPatchTransform` 走的是暂存写，`patch()` 返回 void、立刻就回 ——
 * `await` 一个 void 等于没等，松手瞬间块会按旧位置闪一帧。
 * 顺带白拿一条撤销记录（标签「去字幕」，见 lib/transformLabel.ts）。
 */

import type { ShotInfo, TransformMeta } from "../../api";
import { buildOrderOffsetMap } from "../../adapters/shotToClip";
import { shotSecOf } from "../../lib/keyframeEdit";

export interface DesubEditDeps {
  /** 当前这次渲染看到的镜头列表（已叠加 stagedTransform 的待写项）。 */
  shots: ShotInfo[];
  /** 真落库 + 入撤销栈。失败会抛，调用方自己决定要不要提示。 */
  commitTransform: (shotId: string, tm: TransformMeta) => Promise<void>;
  say: (msg: string) => void;
  setSelectedShotId: (id: string) => void;
  movePlayheadTo: (sec: number) => void;
}

export interface DesubEditors {
  /** 改区间（时间轴上拖块两端 / 整块平移，松手时调一次）。 */
  editRange: (shotId: string, regionId: string,
    range: { t0: number; t1: number }) => Promise<void>;
  /** 批量删（多选删除走这里）。 */
  removeMany: (targets: Array<{ shotId: string; regionId: string }>) => Promise<void>;
  /** 删单条：同步签名，自己吞掉 Promise 与提示。 */
  deleteOne: (shotId: string, regionId: string) => void;
  /** 面板里点「定位」：播放头跳到这条标记的起点，并选中所属镜头。 */
  locate: (shotId: string, t0: number) => void;
}

export function makeDesubEditors(d: DesubEditDeps): DesubEditors {
  const editRange = async (
    shotId: string, regionId: string, range: { t0: number; t1: number },
  ) => {
    const tm = d.shots.find((s) => s.id === shotId)?.transform_meta;
    const list = tm?.desub;
    if (!list?.length) return;
    const next = list.map((r) =>
      (r.id === regionId ? { ...r, t0: range.t0, t1: range.t1 } : r));
    await d.commitTransform(shotId, { ...tm, desub: next });
  };

  /**
   * ⚠️ 按镜头分组后**每镜只发一次 PATCH**。逐条串行发是错的：`shots` 是本次
   * 渲染的闭包快照，同一镜删第二条时读到的仍是删第一条之前的数组，
   * 于是刚删掉的那条会被原样写回去 —— 表现为"多选删除只删掉了一条"。
   *
   * 删标记**不会**还原已经擦过的画面：那一版已经落成了新的 ShotVersion，
   * 要回到原片得去检查器的版本区切。这里只是把记录去掉。
   */
  const removeMany = async (
    targets: Array<{ shotId: string; regionId: string }>,
  ) => {
    const byShot = new Map<string, Set<string>>();
    for (const t of targets) {
      const set = byShot.get(t.shotId) ?? new Set<string>();
      set.add(t.regionId);
      byShot.set(t.shotId, set);
    }
    for (const [shotId, ids] of byShot) {
      const tm = d.shots.find((s) => s.id === shotId)?.transform_meta;
      const list = tm?.desub;
      if (!list?.length) continue;
      const next = list.filter((r) => !ids.has(r.id));
      if (next.length === list.length) continue;
      // 留一个空数组而不是删键：`{}` 在这条通路上是"清除全部画面调整"的意思
      // （见 api.ts TransformMeta 的注释），而这里只想去掉几条标记。
      await d.commitTransform(shotId, { ...tm, desub: next });
    }
  };

  const deleteOne = (shotId: string, regionId: string) => {
    void (async () => {
      try {
        await removeMany([{ shotId, regionId }]);
        d.say("已删除这个去字幕标记");
      } catch { /* 失败的提示 commitTransform 里已经给过，不重复弹 */ }
    })();
  };

  /**
   * `t0` 是**镜头输出秒**，要先换回源秒再加上该镜的绝对起点 ——
   * 变速镜头上少这一步，跳过去的位置会离字幕越来越远。
   * 绝对起点走 `buildOrderOffsetMap`（与画线同源），不自己累加时长。
   */
  const locate = (shotId: string, t0: number) => {
    const sh = d.shots.find((s) => s.id === shotId);
    if (!sh) { d.say("该镜头已不存在（可能已被删除）"); return; }
    const base = buildOrderOffsetMap(d.shots).get(sh.order) ?? 0;
    d.setSelectedShotId(sh.id);
    d.movePlayheadTo(base + shotSecOf(t0, sh.transform_meta?.speed));
  };

  return { editRange, removeMany, deleteOne, locate };
}
