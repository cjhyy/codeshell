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

export function SearchToolCard({ message, onSelect, selected, turnEpoch }: Props) {
  const a = parsedArgs(message);
  const pattern =
    (typeof a.pattern === "string" && a.pattern) ||
    (typeof a.query === "string" && a.query) ||
    (typeof a.glob === "string" && a.glob) ||
    "";
  const path = typeof a.path === "string" ? a.path : undefined;
  const matchCount =
    message.result !== undefined
      ? message.result.split("\n").filter(Boolean).length
      : undefined;

  const summary = (
    <span>
      <code className="font-mono text-foreground">{truncate(pattern, 70)}</code>
      {path && <span className="text-muted-foreground"> in {truncate(path, 30)}</span>}
      {matchCount !== undefined && (
        <span className="text-muted-foreground">
          {" "}
          — {matchCount} match{matchCount === 1 ? "" : "es"}
        </span>
      )}
    </span>
  );

  const details = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">pattern</span>
        <span className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{pattern}</span>
      </div>
      {path && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">path</span>
          <span className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{path}</span>
        </div>
      )}
      {message.result !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">results</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{truncate(message.result, 1200)}</pre>
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
