import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { parsedArgs, truncate } from "./utils";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  turnEpoch?: number;
}

export function AgentToolCard({ message, onSelect, selected, turnEpoch }: Props) {
  const a = parsedArgs(message);
  const subagent =
    typeof a.subagent_type === "string" ? a.subagent_type : undefined;
  const description =
    typeof a.description === "string" ? a.description : undefined;
  const prompt = typeof a.prompt === "string" ? a.prompt : undefined;

  const summary = (
    <span>
      <span className="font-medium text-foreground">{subagent ?? "agent"}</span>
      {description && <span className="text-muted-foreground"> — {truncate(description, 80)}</span>}
    </span>
  );

  const details = (
    <div className="flex flex-col gap-2">
      {subagent && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">type</span>
          <span className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{subagent}</span>
        </div>
      )}
      {description && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">desc</span>
          <span className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{description}</span>
        </div>
      )}
      {prompt && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">prompt</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{truncate(prompt, 1500)}</pre>
        </div>
      )}
      {message.result !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">result</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{truncate(message.result, 1500)}</pre>
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
