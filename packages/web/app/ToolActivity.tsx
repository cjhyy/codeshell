import React from "react";
import { ToolMessage } from "./MessageContent.js";
import type { ActivityTool } from "./toolActivityGroups.js";
import type { HistoryDetailLoader } from "./workbench-types.js";

export function ToolActivity({
  items,
  presentation = "verified",
  running = false,
  detailScope,
  loadHistoryDetail,
  reloadHistory,
}: {
  items: ActivityTool[];
  presentation?: "verified" | "records";
  running?: boolean;
  detailScope: string;
  loadHistoryDetail?: HistoryDetailLoader;
  reloadHistory?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const single = items.length === 1;
  const wasSingle = React.useRef(single);
  const openTools = React.useRef(new Set<string>());
  // A completed neighbour can turn an already expanded single card into a
  // collection. Keep that same child mounted, including its loaded detail.
  const keepExpanded = wasSingle.current && !single && openTools.current.size > 0;
  React.useLayoutEffect(() => {
    if (keepExpanded) setOpen(true);
    wasSingle.current = single;
  }, [single, keepExpanded]);
  const names = [...new Set(items.map((item) => item.name))].slice(0, 3).join(" · ");
  return (
    <details
      className={
        single
          ? "message-tool-single"
          : `message-tool-card message-tool-group${presentation === "records" ? " message-tool-records" : ""}`
      }
      open={single || open || keepExpanded}
      onToggle={(event) => {
        if (single || event.target !== event.currentTarget) return;
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) openTools.current.clear();
      }}
    >
      <summary hidden={single}>
        {!single && (
          <>
            <span className="message-tool-indicator" aria-hidden="true">
              ✓
            </span>
            <span className="message-tool-name">
              {presentation === "records"
                ? `工具记录 · ${items.length} 项已完成`
                : `已完成 ${items.length} 项操作`}
            </span>
            <span className="message-tool-summary">{names}</span>
          </>
        )}
      </summary>
      {(single || open || keepExpanded) && (
        <div className={single ? "message-tool-single-item" : "message-tool-group-items"}>
          {items.map((item) => (
            <ToolMessage
              key={item.id}
              item={item}
              running={running}
              detailScope={detailScope}
              loadHistoryDetail={loadHistoryDetail}
              reloadHistory={reloadHistory}
              onOpenChange={(expanded) => {
                if (expanded) openTools.current.add(item.id);
                else openTools.current.delete(item.id);
              }}
            />
          ))}
        </div>
      )}
    </details>
  );
}
