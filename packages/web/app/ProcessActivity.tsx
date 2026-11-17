import React from "react";
import { MessageContent, ToolMessage } from "./MessageContent.js";
import { currentProcessItems, type ProcessActivityGroup } from "./processActivityProjection.js";
import type { HistoryDetailLoader } from "./workbench-types.js";
import "./process-activity.css";

export function ProcessActivity({
  group,
  detailScope,
  onOpenFile,
  loadHistoryDetail,
  reloadHistory,
}: {
  group: ProcessActivityGroup;
  detailScope: string;
  onOpenFile?: (path: string) => void;
  loadHistoryDetail?: HistoryDetailLoader;
  reloadHistory?: () => void;
}) {
  // Automatic live preview is separate from the reader's disclosure choice.
  // Completion removes the preview; an explicit expansion survives every update.
  const [open, setOpen] = React.useState(false);
  const bodyId = React.useId();
  const tools = group.items.filter((item) => item.kind === "tool");
  const completed = group.items.every((item) => item.done);
  const label = group.running ? "正在处理" : completed ? "处理完成" : "处理未完成";
  const attention = group.items.filter(
    (item) => item.kind === "tool" && (!item.done || item.error),
  );
  const visible = open ? group.items : group.running ? currentProcessItems(group.items) : attention;
  const latest = tools.at(-1);
  return (
    <div className="message-process" data-state={group.running ? "running" : "settled"}>
      <button
        type="button"
        className="message-process-heading"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${label}，${open ? "收起" : "展开"}全部过程`}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span>{label}</span>
        {tools.length ? <span>· {tools.length} 项操作</span> : <span>· 思考</span>}
        {group.running && latest ? (
          <span className="message-process-latest">{latest.name}</span>
        ) : null}
      </button>
      <div id={bodyId} className="message-process-body" hidden={!visible.length}>
        {visible.map((item) => {
          if (item.kind === "assistant") {
            return (
              <MessageContent
                key={item.id}
                text={item.text}
                reasoning={item.reasoning}
                reasoningDetailRef={item.reasoningDetailRef}
                textDetailRef={item.textDetailRef}
                detailScope={detailScope}
                loadHistoryDetail={loadHistoryDetail}
                reloadHistory={reloadHistory}
                streaming={!item.done}
                onOpenFile={onOpenFile}
                showCopy={false}
                onReasoningOpen={() => setOpen(true)}
              />
            );
          }
          return (
            <ToolMessage
              key={item.id}
              item={item}
              running={group.running}
              detailScope={detailScope}
              loadHistoryDetail={loadHistoryDetail}
              reloadHistory={reloadHistory}
              onOpenChange={(expanded) => {
                if (expanded) setOpen(true);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
