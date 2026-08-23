/**
 * LeftPanel — 左侧内容面板容器（PLAN Phase 1）
 *
 * 按 editorStore.leftPanelTab 切换内容。Phase 1 把现有 LibraryPanel / ShotsPanel
 * 原样迁进来（外观适配 token，交互不动）。当前 12 个 Tab 全部有实现，
 * Placeholder 仅作为将来新增 Tab 时的兜底。
 * 各 Tab 的真实内容由 Phase 3 / Phase 4 逐个填充——这里只负责路由和标题栏。
 */

import { ReactNode } from "react";
import { useEditorStore, LeftPanelTab } from "../../stores/editorStore";
import Placeholder from "../../components/Panel/Placeholder";
import "./LeftPanel.css";

const TITLES: Record<LeftPanelTab, string> = {
  media: "媒体",
  audio: "音频",
  text: "文本 / 字幕",
  transition: "转场",
  effect: "特效",
  filter: "滤镜 / 调节",
  "ai-script": "剧本",
  "ai-shots": "AI 分镜",
  "ai-video": "AI 视频",
  "ai-image": "AI 图片 / 资产",
  "ai-voice": "AI 配音",
  "ai-tasks": "AI 任务",
  assets: "资产",
  script: "剧本",
};

/** 未实现 Tab 的说明文案。当前为空——12 个 Tab 都已实现。 */
const PENDING: Partial<Record<LeftPanelTab, { phase: string; desc: string }>> = {
  // Phase 6 收尾后已无待实现 Tab；保留此表是为了将来新增 Tab 时
  // 有个统一的"还没做"出口，而不是让用户看到空白面板。
};

interface Props {
  /** 已实现的 Tab 内容（Phase 1 只有 media / ai-shots）*/
  panels: Partial<Record<LeftPanelTab, ReactNode>>;
  /** 面板标题栏右侧的操作区（随 Tab 变化）*/
  actions?: Partial<Record<LeftPanelTab, ReactNode>>;
}

export default function LeftPanel({ panels, actions }: Props) {
  const tab = useEditorStore((s) => s.leftPanelTab);
  const content = panels[tab];
  const pending = PENDING[tab];

  return (
    <>
      <div className="fw-lp-head">
        <span className="fw-lp-title">{TITLES[tab]}</span>
        <span className="fw-lp-actions">{actions?.[tab]}</span>
      </div>
      <div className="fw-lp-body">
        {content ?? (
          <Placeholder title={TITLES[tab]} desc={pending?.desc} />
        )}
      </div>
    </>
  );
}
