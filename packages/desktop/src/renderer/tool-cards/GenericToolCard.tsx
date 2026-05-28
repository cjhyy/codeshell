import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { prettyJson, truncate } from "./utils";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  turnEpoch?: number;
}

export function GenericToolCard({ message, onSelect, selected, turnEpoch }: Props) {
  const oneLine = summarizeArgs(message.args);

  const summary = <span className="tool-card-summary-text">{oneLine}</span>;

  const details = (
    <div className="tool-card-detail">
      <div className="tool-card-row">
        <span className="tool-card-row-label">args</span>
        <pre className="tool-card-row-val">{prettyJson(message.args)}</pre>
      </div>
      {message.result !== undefined && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">result</span>
          <pre className="tool-card-row-val">{truncate(message.result, 1500)}</pre>
        </div>
      )}
      {message.error && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">error</span>
          <pre className="tool-card-row-val err">{message.error}</pre>
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
