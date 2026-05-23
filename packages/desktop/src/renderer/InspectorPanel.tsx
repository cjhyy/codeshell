import React from "react";
import { PanelRight } from "./ui/icons";
import { IconButton } from "./ui/IconButton";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export function InspectorPanel({ collapsed, onToggle }: Props) {
  if (collapsed) return null;
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span className="inspector-title">详情</span>
        <IconButton label="折叠详情" onClick={onToggle}>
          <PanelRight size={14} />
        </IconButton>
      </div>
      <div className="inspector-body">
        <div className="inspector-empty">
          <div className="inspector-empty-title">未选中</div>
          <div className="inspector-empty-hint">
            在左侧点击一条消息、工具或 diff 来查看详情
          </div>
        </div>
      </div>
    </aside>
  );
}
