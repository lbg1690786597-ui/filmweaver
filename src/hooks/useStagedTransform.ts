/**
 * useStagedTransform — 把 `stagedWrite` 接到 React 与 `detail.shots` 上（2.2）
 *
 * ## 为什么"乐观值"是必需的、不是可选的优化
 *
 * 画布拖拽（`CropZoomOverlay`）的取景框几何**全部从 `transform` prop 派生**
 * （`fw/fh/fl/ft`，见该文件 127-130 行）；播放器的画面也读同一份
 * `transform_meta`。也就是说画面之所以跟手，靠的是"每帧提交 → 父组件刷新 →
 * prop 变了"这条回路。单纯给提交加防抖，会让拖动期间画面**冻住不动**，
 * 只在松手 250ms 后跳到终点 —— 那是把一个性能问题换成一个更严重的手感问题。
 *
 * 所以防抖必须与"本地先生效"配对：`stage()` 立刻把新值记进内存并触发重渲染，
 * `applyPending()` 在 `detail.shots` 上盖一层，落库延后。
 *
 * ## 为什么盖在 `shots` 这一层
 *
 * `App.tsx` 里 `const shots = detail?.shots ?? []` 是**唯一的派生点**，
 * 播放器、特效面板×3、CropZoomOverlay、MosaicOverlay、ClipProperties
 * 全都从它取 `transform_meta`。在这里盖一层，六个读取方一次性受益，
 * 且**零调用点改动** —— 不需要给每个面板再传一份"本地值"，
 * 那种做法必然出现"某个面板忘了用本地值、于是只有它不跟手"的漂移。
 *
 * ## 待写项什么时候消失
 *
 * 落库成功且 `refreshDetail()` 回来之后（`commit` 回调里两步都 await 完），
 * 由 `stagedWrite` 清掉 —— 此时服务端值已经进了 `detail`，撤掉这层盖子
 * 画面不动。若提前清（例如 PATCH 一返回就清），会有一帧显示服务端旧值，
 * 表现为松手瞬间画面闪回。
 *
 * 落库失败则**保留**本地值：用户看到的仍是自己调的画面，顶栏（2.1）
 * 会明确显示「未保存」。悄悄回滚等于在用户不知情时丢掉他的操作。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createStagedWriter, overlayPending } from "../lib/stagedWrite";
import type { ShotInfo, TransformMeta, TransformPatchOpts } from "../api";

export type TransformValue = TransformMeta | Record<string, never>;

export interface StagedTransform {
  /** 写 transform_meta。`opts.staged` 见 api.ts 的 TransformPatchOpts */
  patch: (shotId: string, tm: TransformValue, opts?: TransformPatchOpts) => void;
  /** 在服务端 shots 上盖一层未落库的值 */
  applyPending: (shots: ShotInfo[]) => ShotInfo[];
  /** 该镜头是否有未落库的本地改动。
   *  2.3 的乐观锁靠它决定「详情刷新回来时要不要采纳服务端版本号」——
   *  有未落库改动时屏幕上是用户自己的值，版本号必须保留旧的，
   *  否则冲突检不出来（详见 lib/shotRev.ts 文件头）。 */
  hasPending: (shotId: string) => boolean;
  /** 立刻落库所有待写项（导出前 / 卸载前） */
  flush: () => Promise<void>;
}

export function useStagedTransform(
  commit: (shotId: string, tm: TransformValue) => Promise<void>,
): StagedTransform {
  // 待写集合变化 → 强制重渲染。拖动中每帧一次 setState，
  // 与改动前"每帧一次 PATCH + 一次 refreshDetail 引发的重渲染"相比是净减少。
  const [, bump] = useState(0);

  // commit 闭包每次渲染都是新的（捕获 refreshDetail / say），
  // 而 writer 只能建一次（否则拖动中重建会丢掉计时器和待写项）。
  // 用 ref 存最新回调，writer 每次调用时现取。
  const ref = useRef(commit);
  ref.current = commit;

  const writer = useMemo(() => createStagedWriter<TransformValue>({
    commit: (shotId, tm) => ref.current(shotId, tm),
    onChange: () => bump((n) => n + 1),
    // 失败的用户提示由 commit 自己负责（App 里 catch 后 say + 顶栏保存状态），
    // 这里不再重复提示，否则断网时会弹两遍。
  }), []);

  // 卸载前把没落库的补上。真实场景是关窗口/切项目，
  // 250ms 的兜底计时器可能等不到，这里补一次尽力而为的落库。
  useEffect(() => () => { void writer.flush(); }, [writer]);

  const patch = useCallback((
    shotId: string, tm: TransformValue, opts?: TransformPatchOpts,
  ) => {
    if (opts?.staged) writer.stage(shotId, tm);
    else void writer.writeNow(shotId, tm);
  }, [writer]);

  // 盖层逻辑本身是纯函数（lib/stagedWrite.ts 的 overlayPending），
  // 这样"没有待写项时返回同一个引用""只盖有待写值的镜头"这两条能在 node 下被验证脚本测到。
  const applyPending = useCallback((shots: ShotInfo[]) => overlayPending(
    writer, shots,
    (s, v) => ({ ...s, transform_meta: v as TransformMeta }),
  ) as ShotInfo[], [writer]);

  const hasPending = useCallback(
    (shotId: string) => writer.peek(shotId) !== undefined, [writer]);

  return { patch, applyPending, hasPending, flush: writer.flush };
}
