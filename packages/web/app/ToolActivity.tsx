import React from "react";
import { ToolMessage } from "./MessageContent.js";
import type { ActivityTool } from "./toolActivityGroups.js";
import type { HistoryDetailLoader } from "./workbench-types.js";

export function ToolActivity({
  items,
  detailScope,
  loadHistoryDetail,
  reloadHistory,
}: {
  items: ActivityTool[];
  detailScope: string;
  loadHistoryDetail?: HistoryDetailLoader;
  reloadHistory?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const names = [...new Set(items.map((item) => item.name))].slice(0, 3).join(" · ");
  return (
    <details
      className="message-tool-card message-tool-group"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="message-tool-indicator" aria-hidden="true">
          ✓
        </span>
        <span className="message-tool-name">已完成 {items.length} 项操作</span>
        <span className="message-tool-summary">{names}</span>
      </summary>
      {open && (
        <div className="message-tool-group-items">
          {items.map((item) => (
            <ToolMessage
              key={item.id}
              item={item}
              running={false}
              detailScope={detailScope}
              loadHistoryDetail={loadHistoryDetail}
              reloadHistory={reloadHistory}
            />
          ))}
        </div>
      )}
    </details>
  );
}
