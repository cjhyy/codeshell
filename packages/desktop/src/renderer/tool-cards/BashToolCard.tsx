import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { parsedArgs, truncate } from "./utils";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
}

export function BashToolCard({ message, onSelect, selected }: Props) {
  const a = parsedArgs(message);
  const command = typeof a.command === "string" ? a.command : "";
  const cwd = typeof a.cwd === "string" ? a.cwd : undefined;
  const description =
    typeof a.description === "string" ? a.description : undefined;

  const summary = (
    <span>
      <code className="tool-card-cmd">{truncate(command, 90)}</code>
      {description && <span className="tool-card-desc"> — {description}</span>}
    </span>
  );

  const details = (
    <div className="tool-card-detail">
      <div className="tool-card-row">
        <span className="tool-card-row-label">command</span>
        <pre className="tool-card-row-val">{command || "(empty)"}</pre>
      </div>
      {cwd && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">cwd</span>
          <span className="tool-card-row-val mono">{cwd}</span>
        </div>
      )}
      {message.result !== undefined && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">stdout</span>
          <pre className="tool-card-row-val">{message.result}</pre>
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
    />
  );
}
