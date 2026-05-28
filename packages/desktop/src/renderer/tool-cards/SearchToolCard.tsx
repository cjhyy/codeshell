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
      <code className="tool-card-cmd">{truncate(pattern, 70)}</code>
      {path && <span className="tool-card-desc"> in {truncate(path, 30)}</span>}
      {matchCount !== undefined && (
        <span className="tool-card-desc">
          {" "}
          — {matchCount} match{matchCount === 1 ? "" : "es"}
        </span>
      )}
    </span>
  );

  const details = (
    <div className="tool-card-detail">
      <div className="tool-card-row">
        <span className="tool-card-row-label">pattern</span>
        <span className="tool-card-row-val mono">{pattern}</span>
      </div>
      {path && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">path</span>
          <span className="tool-card-row-val mono">{path}</span>
        </div>
      )}
      {message.result !== undefined && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">results</span>
          <pre className="tool-card-row-val">{truncate(message.result, 1200)}</pre>
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
