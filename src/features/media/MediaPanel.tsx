/**
 * MediaPanel — 媒体面板（PLAN §5.1，Phase 3）
 *
 * 相对旧 LibraryPanel「资产」页签的改进：
 *  - 按 kind 分类（视频/音频/图片/其他）+ 搜索
 *  - 网格 / 列表两种密度（长片项目素材上百条时，列表更好扫）
 *  - 拖到时间轴（HTML5 DnD，payload 走 dataTransfer）
 *  - 「已使用」筛选：素材是否已作为 is_special 镜头入轨
 */

import { useMemo, useRef, useState } from "react";
import {
  Upload, Search, Grid3x3, List, Film, Music, Image as ImageIcon,
  File, Plus, Trash2, Play, Check, FolderOpen, Pencil,
} from "lucide-react";
import { api } from "../../api";
import type { AssetInfo, ShotInfo } from "../../api";
import { LibClip, fmtTime } from "../../types";
import { useMediaPipeline, type MediaPipeline } from "../../hooks/useMediaPipeline";
import "./MediaPanel.css";

type Filter = "all" | "video" | "audio" | "image" | "used";
type Density = "grid" | "list";

const FILTERS: { id: Filter; label: string; Icon?: typeof Film }[] = [
  { id: "all", label: "全部" },
  { id: "video", label: "视频", Icon: Film },
  { id: "audio", label: "音频", Icon: Music },
  { id: "image", label: "图片", Icon: ImageIcon },
  { id: "used", label: "已使用", Icon: Check },
];

interface Props {
  projectId: string;
  clips: LibClip[];
  shots: ShotInfo[];
  inserting: boolean;
  onAddClips: (c: LibClip[]) => void;
  onAddToTimeline: (c: LibClip) => void;
  onPreview: (c: LibClip) => void;
  onDeleteClip: (id: string) => void;
  /** R2 重命名素材（只改展示名，不影响 url 与镜头关联） */
  onRenameClip: (id: string, name: string) => void;
  onToast: (m: string) => void;
  /** 归属确认要用：已有资产做候选池。**不强求**——不传时只是不能归属到资产，
   *  素材池本身照常工作（图片仍可上传、可拖轨）。 */
  assets?: AssetInfo[];
  /** 归属落库后父级重拉资产（让资产页立刻出现新归属的图） */
  onAssetsChanged?: () => void;
  /** 归属时把某张图改判成"挂到资产"，它先前那个池片段要撤掉——
   *  否则同一张图既在资产页又在时间轴上，用户会以为是两张。 */
  onRemoveClips?: (ids: string[]) => void;
  /** 上传管道。App 顶层已经建了一个（系统拖入要用），传进来就复用它——
   *  两边各建一个的话，归属面板会变成两个实例，图片拖进来弹的是 A、
   *  点上传弹的是 B，用户会看到"有时候弹有时候不弹"。 */
  mediaPipeline?: MediaPipeline;
}

export default function MediaPanel(p: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [density, setDensity] = useState<Density>("grid");
  const [q, setQ] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 上传 + 归属确认收敛在 useMediaPipeline 里（与资产页、系统拖放共用同一份），
  // 面板这里只负责"按钮点了把文件递过去"。
  const own = useMediaPipeline({
    projectId: p.projectId,
    onToast: p.onToast,
    onAddClips: p.onAddClips,
    onRemoveClips: p.onRemoveClips,
    assets: p.assets,
    onAssetsChanged: p.onAssetsChanged,
  });
  const { uploadFiles, uploading, attributionDialog } = p.mediaPipeline ?? own;

  /** 素材是否已入轨：外部素材镜头的 video_url 与素材 url 相同 */
  const usedUrls = useMemo(
    () => new Set(p.shots.filter((s) => s.is_special && s.video_url).map((s) => s.video_url!)),
    [p.shots]);

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return p.clips.filter((c) => {
      if (kw && !c.name.toLowerCase().includes(kw)) return false;
      if (filter === "all") return true;
      if (filter === "used") return usedUrls.has(c.url);
      return c.kind === filter;
    });
  }, [p.clips, filter, q, usedUrls]);

  const doUpload = (files: FileList) => { void uploadFiles(Array.from(files)); };

  /** 拖到时间轴：payload 与 TimelineDock/Timeline 的 onDrop 约定一致 */
  const onDragStart = (e: React.DragEvent, c: LibClip) => {
    e.dataTransfer.setData("application/x-fw-clip", JSON.stringify({
      id: c.id, name: c.name, url: c.url, kind: c.kind, duration: c.duration,
    }));
    e.dataTransfer.effectAllowed = "copy";
  };

  const KindIcon = ({ kind }: { kind: LibClip["kind"] }) =>
    kind === "video" ? <Film size={13} />
      : kind === "audio" ? <Music size={13} />
        : kind === "image" ? <ImageIcon size={13} /> : <File size={13} />;

  return (
    <div className="fw-media">
      {/* 工具条：上传 + 搜索 + 密度 */}
      <div className="fw-media-bar">
        <button className="fw-media-upload" disabled={uploading}
          onClick={() => fileRef.current?.click()}>
          <Upload size={13} /> {uploading ? "上传中…" : "导入素材"}
        </button>
        <input ref={fileRef} type="file" multiple hidden
          accept="video/*,audio/*,image/*"
          onChange={(e) => { if (e.target.files?.length) doUpload(e.target.files); e.target.value = ""; }} />
        <button className="fw-media-dens" title={density === "grid" ? "切换列表视图" : "切换网格视图"}
          onClick={() => setDensity((d) => (d === "grid" ? "list" : "grid"))}>
          {density === "grid" ? <List size={13} /> : <Grid3x3 size={13} />}
        </button>
      </div>

      <div className="fw-media-search">
        <Search size={12} />
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="搜索素材名…" spellCheck={false} />
      </div>

      {/* 分类筛选 */}
      <div className="fw-media-filters">
        {FILTERS.map((f) => {
          const n = f.id === "all" ? p.clips.length
            : f.id === "used" ? p.clips.filter((c) => usedUrls.has(c.url)).length
              : p.clips.filter((c) => c.kind === f.id).length;
          return (
            <button key={f.id} className={`fw-media-filter ${filter === f.id ? "on" : ""}`}
              onClick={() => setFilter(f.id)}>
              {f.Icon && <f.Icon size={11} />} {f.label}
              <span className="fw-media-count">{n}</span>
            </button>
          );
        })}
      </div>

      {/* 素材列表 */}
      {shown.length === 0 ? (
        p.clips.length === 0 ? (
          <div className="fw-media-empty">
            <FolderOpen size={30} className="fw-media-empty-icon" />
            <div className="fw-media-empty-title">还没有媒体素材</div>
            <div className="fw-media-empty-desc">
              导入视频、图片或音频，<br />也可以从 AI 生成结果中添加。
            </div>
            <button className="fw-media-empty-btn" disabled={uploading}
              onClick={() => fileRef.current?.click()}>
              <Upload size={13} /> 导入素材
            </button>
          </div>
        ) : (
          <div className="fw-media-empty">
            <div className="fw-media-empty-desc">没有匹配的素材</div>
          </div>
        )
      ) : (
        <div className={`fw-media-list ${density}`}>
          {shown.map((c) => {
            const used = usedUrls.has(c.url);
            return (
              <div key={c.id} className={`fw-media-card ${used ? "used" : ""}`}
                draggable onDragStart={(e) => onDragStart(e, c)}
                onDoubleClick={() => p.onPreview(c)}
                title={`${c.name}${used ? " · 已入轨" : ""}\n双击预览 · 拖到时间轴插入`}>

                <div className="fw-media-thumb">
                  {c.kind === "image" ? (
                    <img src={api.mediaUrl(c.url)} alt="" loading="lazy" draggable={false} />
                  ) : c.kind === "video" ? (
                    <video src={api.mediaUrl(c.url)} preload="metadata" muted />
                  ) : (
                    <span className="fw-media-icon"><KindIcon kind={c.kind} /></span>
                  )}
                  {c.duration > 0 && (
                    <span className="fw-media-dur">{fmtTime(c.duration)}</span>
                  )}
                  {used && <span className="fw-media-used" title="已插入镜头轨"><Check size={10} /></span>}

                  {/* hover 操作 */}
                  <div className="fw-media-acts">
                    <button title="预览" onClick={(e) => { e.stopPropagation(); p.onPreview(c); }}>
                      <Play size={11} />
                    </button>
                    {c.kind === "video" && (
                      <button title="插入镜头轨" disabled={p.inserting}
                        onClick={(e) => { e.stopPropagation(); p.onAddToTimeline(c); }}>
                        <Plus size={11} />
                      </button>
                    )}
                    <button title="重命名" onClick={(e) => {
                      e.stopPropagation();
                      const next = window.prompt("素材名称", c.name);
                      // null = 用户取消；与原名相同则不必发请求
                      if (next != null && next.trim() && next.trim() !== c.name) {
                        p.onRenameClip(c.id, next.trim());
                      }
                    }}>
                      <Pencil size={11} />
                    </button>
                    <button title="从素材池删除" className="danger"
                      onClick={(e) => { e.stopPropagation(); p.onDeleteClip(c.id); }}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>

                <div className="fw-media-meta">
                  <span className="fw-media-kind"><KindIcon kind={c.kind} /></span>
                  <span className="fw-media-name">{c.name}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 上传后的归属确认（图片才有）。放在面板内部而不是 App 顶层：
          它归属的是"这一批刚上传的图"，状态跟面板走，面板不在了它就该没了。 */}
      {attributionDialog}
    </div>
  );
}
