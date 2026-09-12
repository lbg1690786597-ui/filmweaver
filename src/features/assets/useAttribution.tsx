/**
 * useAttribution — 上传归属确认的接线（3.11 A2）
 *
 * ## 为什么抽成 hook
 *
 * 归属确认要在**两个入口**弹出：资产页的「上传图片」和媒体面板的「上传」。
 * 复制两份接线的话，两边迟早会漂移——而"两种拖法/两种上传方式给出的归属
 * 结果不一样"正是用户最容易学会的坏习惯（§2.4 已经点过这条）。
 * 规则本身在 `attribute.ts`（纯函数），执行在 `AttributeDialog`，这里只管
 * **把状态接起来**。
 *
 * ## 为什么是 hook 而不是组件包一层
 *
 * 两个入口的文件来源不同（一个是 `customFileRef` 的单选，一个是素材池的多选），
 * 包的组件要么被迫接受一堆回调，要么两边各留一份 state。hook 只交出
 * `openFiles(files)` 与 `dialog`（交给 JSX 直接渲染），耦合最小。
 */
import { useCallback, useState } from "react";
import type { AssetInfo } from "../../api";
import { api } from "../../api";
import AttributeDialog from "./AttributeDialog";
import type { AttributeContext } from "./attribute";

interface Opts {
  projectId: string;
  assets: AssetInfo[];
  onToast: (m: string) => void;
  /** 落库完成后父级要重拉资产 */
  onChanged: () => void;
  /** 选了「只进素材池」的文件（**已上传**，带 url）→ 父级加进 clips */
  onToPool?: (items: { file: File; url: string; name: string }[]) => void;
  /** 父级在**弹窗之前**就已经传完并挂进池的文件 → `文件名 → {url, 池中 clip id}`。
   *  用于媒体池那条路（见 `AttributeDialog.poolUploads` 的注释）。 */
  poolUploads?: Map<string, { url: string; id: string }>;
  /** 上面那些已挂池、却被改判成挂资产的文件 → 父级撤掉它们的临时片段 */
  onRemoveClips?: (ids: string[]) => void;
}

/** 归一字典里真正参与别名匹配的部分。`listScenes` 下发的成员还带
 *  shots / source / time_of_day 等字段，归属用不上——**刻意收窄**成
 *  这个形状，免得把别处的展示字段当成判据（§2.4 的漂移就是这么来的）。 */
type AliasDict = Pick<AttributeContext, "characterGroups" | "sceneGroups">;

export function useAttribution(o: Opts) {
  const [files, setFiles] = useState<File[] | null>(null);
  /** 归一字典（角色别名 + 场景别名）：别名匹配要用，缺了只是少一条规则 */
  const [groups, setGroups] = useState<AliasDict>({});

  const openFiles = useCallback((fs: File[]) => {
    if (!fs.length) return;
    setFiles(fs);
    // 归一字典每次打开都重拉：用户可能刚在场景归一面板里改过映射，
    // 缓存住会让它按旧写法归属——而归属是"猜"，猜的依据必须是当下这一份。
    void (async () => {
      try {
        const [chars, scenes] = await Promise.all([
          api.listCharacterAliases(o.projectId),
          api.listScenes(o.projectId),
        ]);
        setGroups({
          characterGroups: chars.groups.map((g) => ({
            canonical: g.canonical,
            members: g.members.map((m) => ({ raw_name: m.raw_name })),
          })),
          sceneGroups: scenes.scenes.map((g) => ({
            canonical: g.canonical,
            members: g.members.map((m) => ({ raw_name: m.raw_name })),
          })),
        });
      } catch {
        // 拉不到就是不按别名匹配，其余规则照常 —— 不该因为一次读失败就挡住上传
      }
    })();
  }, [o.projectId]);

  const close = useCallback(() => setFiles(null), []);

  const dialog = files ? (
    <AttributeDialog
      projectId={o.projectId}
      files={files}
      assets={o.assets}
      characterGroups={groups.characterGroups}
      sceneGroups={groups.sceneGroups}
      poolUploads={o.poolUploads}
      onRemoveClips={o.onRemoveClips}
      onClose={close}
      onToast={o.onToast}
      onAddClips={(items) => o.onToPool?.(items)}
      onDone={o.onChanged} />
  ) : null;

  return { openFiles, dialog };
}
