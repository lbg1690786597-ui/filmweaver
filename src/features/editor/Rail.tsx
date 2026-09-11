/**
 * Rail — 左侧图标导航栏（PLAN §5 + §6）
 *
 * 分两组：
 *   剪辑组（媒体/音频/文字/转场/特效/滤镜）—— 对标剪映顶部素材分类
 *   AI 组（剧本/分镜/视频/图片/配音/任务）—— FilmWeaver 差异化能力
 * 两组之间用分割线区隔，让"这是个剪辑器，只是它还能生成素材"这件事在导航上就成立。
 */

import {
  Film, Music, Type, Shuffle, Sparkles, SlidersHorizontal,
  ScrollText, Clapperboard, Video, Image, Mic, ListTodo,
} from "lucide-react";
import { useEditorStore, LeftPanelTab } from "../../stores/editorStore";
import "./Rail.css";

interface RailItem {
  tab: LeftPanelTab;
  label: string;
  Icon: typeof Film;
}

const EDIT_ITEMS: RailItem[] = [
  { tab: "media", label: "媒体", Icon: Film },
  { tab: "audio", label: "音频", Icon: Music },
  { tab: "text", label: "文本", Icon: Type },
  { tab: "transition", label: "转场", Icon: Shuffle },
  { tab: "effect", label: "特效", Icon: Sparkles },
  { tab: "filter", label: "调节", Icon: SlidersHorizontal },
];

const AI_ITEMS: RailItem[] = [
  { tab: "ai-script", label: "剧本", Icon: ScrollText },
  { tab: "ai-shots", label: "分镜", Icon: Clapperboard },
  { tab: "ai-video", label: "生视频", Icon: Video },
  { tab: "ai-image", label: "生图", Icon: Image },
  { tab: "ai-voice", label: "配音", Icon: Mic },
  { tab: "ai-tasks", label: "任务", Icon: ListTodo },
];

export default function Rail(p: { productionMode?: string | null } = {}) {
  const tab = useEditorStore((s) => s.leftPanelTab);
  const setTab = useEditorStore((s) => s.setLeftPanelTab);
  // 真人剧的 ai-voice 面板里是**角色音色**（给角色指定说话声），不是 TTS 配音。
  // 侧栏还写"配音"的话，点进去看到的东西对不上（见 AudioPanel 头注释）。
  const isNarration = p.productionMode === "narration";

  const renderItem = ({ tab: t, label, Icon }: RailItem) => (
    <button key={t}
      className={`fw-rail-btn ${tab === t ? "active" : ""}`}
      title={label}
      onClick={() => setTab(t)}>
      <Icon size={17} strokeWidth={1.75} />
      <span className="fw-rail-label">{label}</span>
    </button>
  );

  const aiItems = AI_ITEMS.map((it) =>
    it.tab === "ai-voice" && !isNarration ? { ...it, label: "音色" } : it);

  return (
    <>
      {EDIT_ITEMS.map(renderItem)}
      <div className="fw-rail-sep" />
      <div className="fw-rail-group-tag" title="FilmWeaver AI 创作">AI</div>
      {aiItems.map(renderItem)}
    </>
  );
}
