/**
 * Placeholder — 面板兜底空态
 *
 * 正常路径下不会出现：Rail 的 12 个 Tab 现在全部有实现。
 * 保留它是为了将来新增 Tab 时有个统一出口，而不是让用户看到一片空白。
 *
 * ⚠️ 早期版本这里显示"Phase 6 · 完成度 83%"之类的开发进度，
 * 已移除——开发进度不属于正式产品 UI，只该在 docs 里。
 */
import { PackageOpen } from "lucide-react";
import "./Placeholder.css";

interface Props {
  title: string;
  desc?: string;
}

export default function Placeholder({ title, desc }: Props) {
  return (
    <div className="fw-ph">
      <PackageOpen size={28} className="fw-ph-icon" />
      <div className="fw-ph-title">{title}</div>
      {desc && <div className="fw-ph-desc">{desc}</div>}
    </div>
  );
}
