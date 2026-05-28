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

export function WebToolCard({ message, onSelect, selected, turnEpoch }: Props) {
  const a = parsedArgs(message);
  const url = typeof a.url === "string" ? a.url : undefined;
  const query = typeof a.query === "string" ? a.query : undefined;
  const target = url ?? query ?? "";

  const summary = (
    <span>
      <span className="tool-card-url">{truncate(target, 90)}</span>
    </span>
  );

  const details = (
    <div className="tool-card-detail">
      {url && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">url</span>
          <span className="tool-card-row-val mono">{url}</span>
        </div>
      )}
      {query && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">query</span>
          <span className="tool-card-row-val">{query}</span>
        </div>
      )}
      {message.result !== undefined && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">result</span>
          <pre className="tool-card-row-val">{truncate(message.result, 1500)}</pre>
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
