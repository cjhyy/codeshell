import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { parsedArgs, truncate } from "./utils";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
}

export function AgentToolCard({ message, onSelect, selected }: Props) {
  const a = parsedArgs(message);
  const subagent =
    typeof a.subagent_type === "string" ? a.subagent_type : undefined;
  const description =
    typeof a.description === "string" ? a.description : undefined;
  const prompt = typeof a.prompt === "string" ? a.prompt : undefined;

  const summary = (
    <span>
      <span className="tool-card-name">{subagent ?? "agent"}</span>
      {description && <span className="tool-card-desc"> — {truncate(description, 80)}</span>}
    </span>
  );

  const details = (
    <div className="tool-card-detail">
      {subagent && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">type</span>
          <span className="tool-card-row-val">{subagent}</span>
        </div>
      )}
      {description && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">desc</span>
          <span className="tool-card-row-val">{description}</span>
        </div>
      )}
      {prompt && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">prompt</span>
          <pre className="tool-card-row-val">{truncate(prompt, 1500)}</pre>
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
    />
  );
}
