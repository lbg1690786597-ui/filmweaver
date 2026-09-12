/**
 * useMediaPipeline — 把一批文件**上传并入库**的单一入口（3.11 P0-b/A2）
 *
 * ## 为什么要有它
 *
 * 在此之前，"把文件弄进素材池"这件事有三份实现：媒体面板的上传按钮、
 * 资产页的上传按钮、以及（本次新增的）从资源管理器拖进来。三份实现必然漂移——
 * 压缩策略、时长探测、图片要不要走归属确认、失败怎么报，任何一处改了另外两处
 * 不会跟着改。用户看到的就会是"拖进来的图不在资产里、点上传的却在"。
 *
 * 所以收敛成一个 hook：**谁拿到文件都交给它**。面板拿到是本地 `File`，
 * 从系统拖进来拿到的是路径（先经 `osDrop.readDropped` 读成 `File`），
 * 到这里已经统一成 `File[]`，不再分来源。
 *
 * ## 为什么归属确认面板也跟着它走
 *
 * 归属面板是"这批图片要不要顺便记进资产页"的那一步，它必须**紧跟着上传**，
 * 而不是由各个调用方自己记得去弹。放进 pipeline 里，三条入口自动一致。
 *
 * ## 它不认识 React 组件
 *
 * 本 hook 只持有"素材池里多了什么"这些状态，不渲染任何东西——
 * 渲染交给返回的 `attributionDialog` 节点，由调用方决定挂在哪。
 * 这样媒体面板、资产页、以及 App 顶层的拖放，三处都能用同一份。
 */
import { useCallback, useRef, useState } from "react";
import { api } from "../api";
import type { AssetInfo } from "../api";
import { LibClip, clipKind, probeDuration } from "../types";
import { useAttribution } from "../features/assets/useAttribution";

interface Opts {
  projectId: string;
  /** 上传开始/结束（面板用它禁用按钮、显示"上传中…"） */
  onBusy?: (busy: boolean) => void;
  onToast: (m: string) => void;
  /** 素材池多了几段（含从资产页传上来的图） */
  onAddClips: (c: LibClip[]) => void;
  /** 归属改判成"挂资产"时，撤掉先前进池的那张图 */
  onRemoveClips?: (ids: string[]) => void;
  /** 资产页的候选池 */
  assets?: AssetInfo[];
  onAssetsChanged?: () => void;
}

/** 上传管道的对外形状。App 顶层建一份传给各面板，避免多实例。 */
export interface MediaPipeline {
  uploadFiles: (files: File[]) => Promise<void>;
  uploading: boolean;
  attributionDialog: React.ReactNode;
}

export function useMediaPipeline(o: Opts): MediaPipeline {
  const [uploading, setUploading] = useState(false);
  /** 本轮已上传并挂进池的**图片**：`文件名 → {url, 池中 clip id}`。
   *  归属面板里若把某个文件改判成挂资产，靠它撤掉那张图的时间轴片段；
   *  若用户确认「只进池」，则直接复用这次上传、不再传第二遍。 */
  const poolUploads = useRef(new Map<string, { url: string; id: string }>());

  const attr = useAttribution({
    projectId: o.projectId,
    assets: o.assets ?? [],
    onToast: o.onToast,
    onChanged: () => o.onAssetsChanged?.(),
    onToPool: (items) => {
      o.onAddClips(items.map((it) => ({
        id: it.url, name: it.name, url: it.url, size: it.file.size,
        kind: "image", duration: 0,
      })));
      o.onToast(`已加入素材池 ${items.length} 张`);
    },
    poolUploads: poolUploads.current,
    onRemoveClips: o.onRemoveClips,
  });

  /**
   * 上传一批文件到素材池。图片会额外弹出归属确认。
   *
   * 失败**不吞**：逐个记下来，最后一次性说清楚是哪几个失败了——
   * 拖十个文件进来只上传成功七个、却报"已上传 10 个"是最坏的一种谎。
   */
  const uploadFiles = useCallback(async (files: File[]): Promise<void> => {
    if (!files.length) return;
    setUploading(true);
    o.onBusy?.(true);
    const added: LibClip[] = [];
    const imgs: File[] = [];
    const failed: string[] = [];
    try {
      for (const f of files) {
        try {
          const kind = clipKind(f.name);
          // 先本地探测时长的意义在于：上传是单请求，时长随上传一起落库；
          // 「上传完再补一次 patch」会在中途断网时留下时长缺失的素材（旧 bug）。
          const blobUrl = URL.createObjectURL(f);
          const duration = await probeDuration(blobUrl, kind)
            .finally(() => URL.revokeObjectURL(blobUrl));
          const b = await api.uploadMedia(f, o.projectId, duration);
          const clip: LibClip = {
            id: b.file_id, name: f.name, url: b.url, size: f.size, kind, duration,
          };
          added.push(clip);
          // 图片先照旧进池（拖进来半天没反应，用户会以为功能死了），
          // 归属是**随后**的一步，用于决定要不要再记进资产页。
          if (kind === "image") {
            imgs.push(f);
            poolUploads.current.set(f.name, { url: b.url, id: clip.id });
          }
        } catch (e) {
          failed.push(`${f.name}：${String(e).slice(0, 60)}`);
        }
      }
      if (added.length) o.onAddClips(added);
      if (failed.length) {
        o.onToast(`⚠️ ${added.length} 个上传成功，${failed.length} 个失败 —— ${failed[0]}`);
      } else if (imgs.length) {
        o.onToast(`已上传 ${added.length} 个素材，正在识别图片归属…`);
        attr.openFiles(imgs);
      } else {
        o.onToast(`已上传 ${added.length} 个素材`);
      }
    } finally {
      setUploading(false);
      o.onBusy?.(false);
    }
  }, [o, attr]);

  return { uploadFiles, uploading, attributionDialog: attr.dialog };
}
