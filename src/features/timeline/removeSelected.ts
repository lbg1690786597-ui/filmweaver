/**
 * removeSelected — Delete / 工具条 🗑 / Ctrl+X 共用的「把选中的拿掉」
 *
 * ## 为什么从 App.tsx 搬出来
 *
 * 它不是渲染，是**一张分派表**：同一个 Delete 键，对四类选中物做四件不同的事
 * （资产段真删 / 外部素材真删 / AI 镜头停用 / 音频·字幕·去字幕标记各自的删法）。
 * 这类"按实体分语义"的判断与 `features/timeline/clipEdit.ts` 是同一族，理应和
 * 它们住在一起；留在 App.tsx 里只会让每加一类可选中的东西，就往巨石里再塞一支。
 *
 * 搬家时**一行逻辑都没改**——它挡住的那些坑（多选只处理第一个、AI 镜头按下去
 * 毫无动静、资产段没有键盘路径）全部原样保留在下面的注释里。
 *
 * ## 依赖为什么用注入的
 *
 * 四条删法各自要走 App 里那套「发请求 + 入撤销栈 + patchDetail」的通路
 * （`deleteSpecialShot` / `deleteTimelineClip` / `patchTimeline` / 去字幕的
 * `commitTransform`），那些是 App 的 hook 闭包，搬不动也不该搬。
 * 这里只接口子，不关心它们怎么落库。
 */

import { useTimelineStore } from "../../stores/timelineStore";
import { deleteRunOrders } from "../../stores/assetOverrideStore";
import type { Clip } from "../../types/timeline";
import type { ShotInfo } from "../../api";
import type { AssetRun, AssetTrackKind } from "../assets/AssetTrack";

export type AssetRunSel = AssetRun & { rowName: string; kind: AssetTrackKind };

export interface RemoveSelectedDeps {
  projectId: string | null;
  /** 取当前镜头表。用函数而不是值：App 里 `shots` 是 `applyPending` 的派生量，
   *  声明在本工厂的调用点**之后**，直接传值会撞 TDZ。 */
  getShots: () => ShotInfo[];
  assetRun: AssetRunSel | null;
  setAssetRun: (v: AssetRunSel | null) => void;
  say: (msg: string) => void;
  /** 外部素材：后端硬删，不可撤销（所以调用前问一句） */
  deleteSpecialShot: (shotId: string) => Promise<void>;
  /** 音频/字幕段：各自的 DELETE 端点，可撤销（重建） */
  deleteTimelineClip: (clip: Clip) => Promise<void>;
  /** AI 镜头：停用而不是删 */
  patchTimeline: (shotId: string, patch: { disabled?: boolean }) => Promise<void>;
  /** 去字幕标记：改 transform_meta，见 features/desub/desubEdit.ts */
  removeDesubs: (targets: Array<{ shotId: string; regionId: string }>) => Promise<void>;
}

export interface RemoveSelectedOpts { silent?: boolean; shotsOnly?: boolean }

export function makeRemoveSelected(d: RemoveSelectedDeps) {
  const tlStore = () => useTimelineStore.getState();

  return (o?: RemoveSelectedOpts) => {
    // ⚠️ 侧栏里选中了**资产段**时，Delete 删的是那个段，不是时间轴上的片子。
    //
    // 选中一个资产段会把 Inspector 切成资产视图（见 App 的 `assetRun`），
    // 时间轴上的选中集此时通常也是空的 —— 不先处理这一支，按 Delete 会得到
    // "先选中时间轴上的片段"，而屏幕上明明选着东西。用户报的「快捷键删除」
    // 就是这一条：资产段此前**根本没有**键盘路径，只能右键。
    const run = d.assetRun;
    if (!o?.shotsOnly && run) {
      const n = deleteRunOrders(
        d.projectId, run.rowName, run.from, run.to,
        d.getShots(), run.kind === "location", run.stageId);
      if (n.length) {
        d.setAssetRun(null);
        d.say(`已删除「${run.rowName}」#${run.from}-#${run.to} 注入段（Ctrl+Z 可撤销）`);
      } else {
        d.say(`「${run.rowName}」这一段上本来就没有生效的镜头`);
      }
      return;
    }
    const st = tlStore();
    const all = st.selection.clipIds
      .map((id) => st.findClip(id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    if (!all.length) { d.say("先选中时间轴上的片段"); return; }

    // 6.9：选中集里现在可能有音频/字幕段（`selection.ts` 放开了判据）。
    // 它们既不是"外部素材真删"也不是"AI 镜头停用"，是第三种删法 ——
    // 各自的 DELETE 端点，可撤销（重建）。分开处理，不混进下面两类。
    const others = o?.shotsOnly ? []
      : all.filter((c) => c.entity === "audio" || c.entity === "subtitle");
    // 去字幕标记是第四类：它既不是"删素材"也不是"停用镜头"，删的是
    // `transform_meta.desub` 里的一条记录。不接这一支的话，明明选着一个蓝块
    // 按 Delete 会得到「先选中时间轴上的片段」—— 正是本函数开头那段注释
    // 反复批判的"屏幕上明明选着东西"。
    const desubs = o?.shotsOnly ? []
      : all.filter((c) => c.entity === "desub" && !!c.shotId);
    const clips = all.filter((c) => c.entity === "shot" && !!c.shotId);
    if (!clips.length && !others.length && !desubs.length) {
      d.say("先选中时间轴上的片段"); return;
    }

    const specials = clips.filter((c) => c.isSpecial);
    const aiShots = clips.filter((c) => !c.isSpecial && !c.disabled);

    if (specials.length) {
      const names = specials.map((c) => c.label).join("、");
      if (!window.confirm(
        `确定从镜头轨移除 ${specials.length} 个外部素材吗？\n\n${names}\n\n`
        + "可以按 Ctrl+Z 撤销，取片范围、画面调整、叠加层位置都会一并还原；"
        + "但一个素材算一次撤销，撤 N 个要按 N 次。")) return;
      void (async () => {
        for (const c of specials) await d.deleteSpecialShot(c.shotId!);
      })();
    }

    if (others.length) {
      // 逐条串行删：每条各自入一条撤销记录（与外部素材同款），
      // 并行发的话撤销栈顺序会跟着网络先后走，Ctrl+Z 撤回来的顺序就不确定了。
      void (async () => {
        for (const c of others) await d.deleteTimelineClip(c);
      })();
    }

    if (desubs.length) {
      // 一次性交给 removeDesubs 按镜分组发（同一镜的多条只发一次 PATCH，
      // 理由见 desubEdit.ts）。删标记不还原已擦过的画面，文案里要说清楚。
      void (async () => {
        try {
          await d.removeDesubs(
            desubs.map((c) => ({ shotId: c.shotId!, regionId: c.id })));
          if (!o?.silent) {
            const done = desubs.filter((c) => c.status === "done").length;
            d.say(`已删除 ${desubs.length} 个去字幕标记`
              + (done ? `（其中 ${done} 个已擦除过，画面不会因此还原）` : ""));
          }
        } catch { /* commitTransform 里已经报过错 */ }
      })();
    }

    for (const c of aiShots) void d.patchTimeline(c.shotId!, { disabled: true });
    if (aiShots.length && !o?.silent) {
      d.say(`AI 镜头不能删除，已停用 ${aiShots.length} 个（不参与导出，Ctrl+Z 可撤销）`);
    }
  };
}
