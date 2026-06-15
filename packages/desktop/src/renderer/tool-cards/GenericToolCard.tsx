import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { prettyJson, truncate } from "./utils";
import { detectAttachments } from "./attachments";
import { AttachmentCard } from "./AttachmentCard";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  turnEpoch?: number;
}

export function GenericToolCard({ message, onSelect, selected, turnEpoch }: Props) {
  const oneLine = summarizeArgs(message.args);
  const attachments = detectAttachments(
    message.toolName,
    message.args,
    message.result,
  );

  const summary = <span className="text-muted-foreground">{oneLine}</span>;

  const details = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">args</span>
        <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{prettyJson(message.args)}</pre>
      </div>
      {message.result !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">result</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{truncate(message.result, 1500)}</pre>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">files</span>
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentCard key={a.path} attachment={a} />
            ))}
          </div>
        </div>
      )}
      {message.error && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">error</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-status-err/10 p-2 font-mono text-xs text-status-err">{message.error}</pre>
        </div>
      )}
    </div>
  );

  return (
    <ToolCardShell
      message={message}
      summary={summary}
      details={details}
      onSelect={onSelect}
      selected={selected}
      turnEpoch={turnEpoch}
    />
  );
}

function summarizeArgs(argsJson: string): string {
  if (!argsJson || argsJson === "{}") return "";
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return truncate(argsJson, 80);
  }
  const preferred = ["command", "file_path", "url", "path", "pattern", "query", "task", "prompt"];
  for (const key of preferred) {
    if (typeof obj[key] === "string") return truncate(obj[key] as string, 80);
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string") return truncate(v, 80);
  }
  return Object.keys(obj).join(", ");
}
