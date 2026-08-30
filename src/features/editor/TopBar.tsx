/**
 * TopBar — 顶栏（PLAN §4）
 *
 * 三段式：
 *   左  返回 / 项目名 / 保存状态 / 撤销 / 重做
 *   中  AI 生产（主操作，含进度）/ 任务状态徽章
 *   右  比例 / 精编 / 导出 / 主题 / 用户 / 更新
 *
 * 刻意不在顶栏堆 AI 功能按钮（PLAN §4 明确要求）：一键成片之外的生产动作
 * 全部收进左侧「AI 生视频」面板，顶栏只留一个「AI 生产」主入口 + 任务态。
 */

import {
  ChevronLeft, Undo2, Redo2, Download, Scissors, Moon, Sun,
  User as UserIcon, RefreshCw, Settings, Loader2, Check,
} from "lucide-react";
import { IS_TAURI } from "../export/ExportDialog";
import WindowControls from "./WindowControls";
import "./TopBar.css";
import { productionModeLabel } from "../../lib/modelLabels";

export interface TopBarProps {
  projectTitle: string;
  appVersion: string;
  baseAspect?: string;
  productionMode?: string | null;
  backendOk: boolean | null;

  onBack: () => void;

  // 撤销 / 重做
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;

  // AI 生产主入口
  generating: boolean;
  progress: number;
  stageLabel: string;
  onProduce: () => void;

  // 任务徽章
  jobCount: number;
  onOpenTasks: () => void;

  // 精编 / 导出
  fineCutEnabled: boolean;
  onFineCut: () => void;
  /** 本机渲染进行中（云端合成已下线，导出只有本机一条路） */
  exporting: boolean;
  exportProgress: number;
  onExport: () => void;

  // 系统
  theme: string;
  onToggleTheme: () => void;
  userName: string | null;
  onLogout: () => void;
  onOpenSettings: () => void;
  // 应用内更新（Tauri 专属，浏览器预览下不显示）
  updateState: string;
  updateProgress: number;
  onCheckUpdate: () => void;
  onRelaunch: () => void;
}

/** 双击标题栏 = 最大化/还原（Windows 通用习惯）。
 *  非 Tauri 环境静默忽略——浏览器里双击顶栏不该有任何反应。 */
function onTitlebarDoubleClick(e: React.MouseEvent) {
  if (!IS_TAURI) return;
  // 只响应落在拖拽区自身的双击；双击按钮不该触发最大化
  if ((e.target as HTMLElement).closest("button")) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize())
    .catch(() => { /* runtime 不可用：忽略 */ });
}

export default function TopBar(p: TopBarProps) {
  return (
    <>
      {/* ---- 左段 ---- */}
      <button className="fw-tb-icon" title="返回项目列表" onClick={p.onBack}>
        <ChevronLeft size={17} />
      </button>

      <div className="fw-tb-brand" title={p.projectTitle}>
        <span className="fw-tb-title">{p.projectTitle}</span>
        <span className="fw-tb-ver">v{p.appVersion}</span>
      </div>

      <span className="fw-tb-saved" title="改动已自动保存到服务端">
        <Check size={11} /> 已保存
      </span>

      <div className="fw-tb-divider" />

      <button className="fw-tb-icon" title="撤销 (Ctrl+Z)"
        disabled={!p.canUndo} onClick={p.onUndo}>
        <Undo2 size={16} />
      </button>
      <button className="fw-tb-icon" title="重做 (Ctrl+Y)"
        disabled={!p.canRedo} onClick={p.onRedo}>
        <Redo2 size={16} />
      </button>

      {/* ---- 中段：生产主入口 + 窗口拖拽区 ----
          decorations:false 后没有系统标题栏可拖，中段的空白就是拖拽把手。
          ⚠️ drag region 加在容器上、内部按钮逐个 data-tauri-drag-region="false" 排除——
          不排除的话按钮会变成"拖窗口"而点不动（Tauri 把整个子树都当把手）。
          也不能像常见方案那样另插一个空 div：.fw-tb-mid 是 flex:1 的弹性区，
          再插一个会把「AI 生产」按钮挤偏。 */}
      <div className="fw-tb-mid" data-tauri-drag-region
        onDoubleClick={onTitlebarDoubleClick}>
        <button className="fw-tb-primary" data-tauri-drag-region="false"
          disabled={p.generating} onClick={p.onProduce}>
          {p.generating ? (
            <><Loader2 size={14} className="fw-spin" />
              {p.stageLabel || "生产中"} {p.progress}%</>
          ) : (
            <>▷ AI 生产</>
          )}
        </button>
        {p.jobCount > 0 && (
          <button className="fw-tb-badge" data-tauri-drag-region="false"
            title={`${p.jobCount} 个任务`} onClick={p.onOpenTasks}>
            {p.jobCount} 任务
          </button>
        )}
      </div>

      {/* ---- 右段 ---- */}
      <div className="fw-tb-right">
        <span className={`fw-tb-dot ${p.backendOk === null ? "" : p.backendOk ? "ok" : "bad"}`}
          title={p.backendOk ? "后端已连接" : "后端未连接"} />
        <span className="fw-tb-meta">
          {p.baseAspect ?? "-"} · {productionModeLabel(p.productionMode)}
        </span>

        <button className="fw-tb-btn" disabled={!p.fineCutEnabled}
          title="精编：裁剪 / 字幕 / 版本回退 / 本机导出" onClick={p.onFineCut}>
          <Scissors size={14} /> 精编
        </button>

        <button className="fw-tb-primary sm" disabled={p.exporting} onClick={p.onExport}>
          {p.exporting
            ? <><Loader2 size={13} className="fw-spin" /> 导出 {p.exportProgress}%</>
            : <><Download size={13} /> 导出</>}
        </button>

        {/* 这里原有一个「下载成片」链接，指向服务端 compose 产出的文件。
            云端合成已下线：本机渲染的成片由系统保存对话框直接落到用户选的
            目录，没有可下载的远端地址，所以这个按钮也一并去掉。 */}

        <button className="fw-tb-icon" title="设置" onClick={p.onOpenSettings}>
          <Settings size={15} />
        </button>

        <button className="fw-tb-icon" title="切换主题" onClick={p.onToggleTheme}>
          {p.theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
        </button>

        {p.userName && (
          <button className="fw-tb-icon" title={`${p.userName} · 退出登录`} onClick={p.onLogout}>
            <UserIcon size={15} />
          </button>
        )}

        {/* 更新器：Tauri 环境才有意义，浏览器预览下 updateState 恒为 idle */}
        {p.updateState === "idle" || p.updateState === "none" ? (
          <button className="fw-tb-icon" title="检查更新" onClick={p.onCheckUpdate}>
            <RefreshCw size={14} />
          </button>
        ) : p.updateState === "checking" ? (
          <span className="fw-tb-meta">检查中…</span>
        ) : p.updateState === "downloading" ? (
          <span className="fw-tb-meta">下载 {p.updateProgress}%</span>
        ) : (
          <button className="fw-tb-primary sm" onClick={p.onRelaunch}>🔄 重启安装</button>
        )}

        {/* 窗口按钮永远在最右：Web 预览下组件自身返回 null，不占位 */}
        <WindowControls />
      </div>
    </>
  );
}
