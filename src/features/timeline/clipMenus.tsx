/**
 * clipMenus — 非镜头片段的右键菜单（音频 / 字幕 / 去字幕）
 *
 * 独立文件而不是写在 Timeline.tsx 里：那边的定位是「渲染与装配」，
 * 架构守卫按「只许减」钉着它的行数。这两份菜单都是纯数据构造
 * （入参 → `MenuItem[]`），没有任何本地渲染状态，搬出来零代价。
 *
 * 镜头自己那份（11 项）仍留在 Timeline.tsx —— 它要读一堆本地状态
 * （recut 判定、选区、转场链、相邻镜头），搬出来反倒要把半个组件当参数传。
 */

import { Crosshair, Trash2, RotateCcw } from "lucide-react";
import type { Clip } from "../../types/timeline";
import type { ShotInfo } from "../../api";
import type { MenuItem } from "../../components/ContextMenu/ContextMenu";
import { hasTrim, clearTrimPatch, canDeleteFromTimeline } from "./clipEdit";
import type { ClipEditPatch } from "./clipEdit";

export interface OtherMenuDeps {
  setPlayheadSec: (sec: number) => void;
  onEditClip: (patch: ClipEditPatch) => Promise<void>;
  onDeleteClip: (clip: Clip) => void;
}

/**
 * 音频/字幕段的右键菜单（6.9）。
 *
 * ⚠️ **不能**共用镜头那份菜单。那 11 项里有 10 项的 `disabled` 判据是
 * `!clip.shotId` —— 音频段一律没有 shotId，于是右键出来的是一整屏灰掉的
 * 「重新生成 / 精品升级 / 版本历史 / 移到叠加层 / 停用镜头…」。
 * 这比没有菜单更糟：它把"这里能做的事"整个藏在了一堆做不了的事后面，
 * 用户还要逐条试才知道哪条能点。这里只列真的能做的三件事。
 *
 * 「复制」也不在其中：粘贴只会插镜头（`App.tsx` doPaste），
 * 音频复制了粘不回来，理由与 `selection.ts` 文件头 6.9 一节同源。
 */
export function otherMenuItems(clip: Clip, d: OtherMenuDeps): MenuItem[] {
  const name = clip.entity === "audio" ? "音频" : "字幕";
  return [
    { id: "playhead", label: "播放头移到此处", icon: <Crosshair size={12} />,
      onClick: () => d.setPlayheadSec(clip.startSec) },
    // 只有音频有窗口可还原。字幕的 duration 就是时长，没有"原长"这回事。
    { id: "untrim", label: "还原修剪（用回整段素材）", icon: <RotateCcw size={12} />,
      disabled: !hasTrim(clip),
      onClick: async () => {
        const patch = clearTrimPatch(clip);
        if (patch) await d.onEditClip(patch);
      } },
    { id: "sep1", label: "", separator: true },
    // 说「可撤销」是因为它真的可撤销（App.deleteTimelineClip 会重建），
    // 与镜头那条「删除（不可撤销）」是两回事，不能照抄措辞。
    { id: "delete", label: `从时间轴移除${name}段（可撤销）`,
      icon: <Trash2 size={12} />, danger: true,
      disabled: !canDeleteFromTimeline(clip),
      onClick: () => d.onDeleteClip(clip) },
  ];
}

export interface DesubMenuDeps {
  shots: ShotInfo[];
  onSelectShot: (shot: ShotInfo) => void;
  onDeleteDesub?: (shotId: string, regionId: string) => void;
  setPlayheadSec: (sec: number) => void;
}

/**
 * 去字幕标记的右键菜单。
 *
 * 与音频/字幕那份分开，理由同上：那三项里有两项（还原修剪 / 移除片段）
 * 对去字幕标记根本不成立 —— 它没有素材窗口可还原，删除也走另一条路
 * （改 transform_meta，不是删一条记录）。
 */
export function desubMenuItems(clip: Clip, d: DesubMenuDeps): MenuItem[] {
  const applied = clip.status === "done";
  return [
    { id: "playhead", label: "播放头移到此处", icon: <Crosshair size={12} />,
      onClick: () => d.setPlayheadSec(clip.startSec) },
    { id: "locate", label: "选中所属镜头", icon: <Crosshair size={12} />,
      disabled: !clip.shotId,
      onClick: () => {
        const shot = d.shots.find((s) => s.id === clip.shotId);
        if (shot) d.onSelectShot(shot);
      } },
    { id: "sep1", label: "", separator: true },
    // 措辞要说清"删的是标记不是画面"：已擦过的那一版是**不可逆**的有损重编码，
    // 删这条记录不会把画面变回去（要变回去得去版本历史切版本）。
    { id: "delete",
      label: applied ? "删除这条记录（不会还原画面）" : "删除这个去字幕标记",
      icon: <Trash2 size={12} />, danger: true,
      disabled: !clip.shotId || !d.onDeleteDesub,
      onClick: () => clip.shotId && d.onDeleteDesub?.(clip.shotId, clip.id) },
  ];
}
