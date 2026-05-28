import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { parsedArgs, truncate } from "./utils";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  /** "read" or "write" — affects the summary verbiage and detail layout. */
  variant: "read" | "write" | "edit";
  turnEpoch?: number;
}

export function FileToolCard({ message, onSelect, selected, variant, turnEpoch }: Props) {
  const a = parsedArgs(message);
  const path =
    (typeof a.file_path === "string" && a.file_path) ||
    (typeof a.path === "string" && a.path) ||
    "";
  const offset = typeof a.offset === "number" ? a.offset : undefined;
  const limit = typeof a.limit === "number" ? a.limit : undefined;
  const content = typeof a.content === "string" ? a.content : undefined;
  const oldStr = typeof a.old_string === "string" ? a.old_string : undefined;
  const newStr = typeof a.new_string === "string" ? a.new_string : undefined;

  const range =
    offset !== undefined && limit !== undefined
      ? `lines ${offset + 1}–${offset + limit}`
      : limit !== undefined
        ? `${limit} lines`
        : null;

  const summary = (
    <span>
      <span className="tool-card-path">{truncate(path, 70)}</span>
      {range && <span className="tool-card-desc"> {range}</span>}
      {variant === "write" && content !== undefined && (
        <span className="tool-card-desc"> ({content.length}B)</span>
      )}
    </span>
  );

  const details = (
    <div className="tool-card-detail">
      <div className="tool-card-row">
        <span className="tool-card-row-label">path</span>
        <span className="tool-card-row-val mono">{path}</span>
      </div>
      {variant === "edit" && (
        <>
          {oldStr !== undefined && (
            <div className="tool-card-row">
              <span className="tool-card-row-label">- old</span>
              <pre className="tool-card-row-val removed">{truncate(oldStr, 800)}</pre>
            </div>
          )}
          {newStr !== undefined && (
            <div className="tool-card-row">
              <span className="tool-card-row-label">+ new</span>
              <pre className="tool-card-row-val added">{truncate(newStr, 800)}</pre>
            </div>
          )}
        </>
      )}
      {variant === "write" && content !== undefined && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">content</span>
          <pre className="tool-card-row-val">{truncate(content, 800)}</pre>
        </div>
      )}
      {message.result !== undefined && variant === "read" && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">content</span>
          <pre className="tool-card-row-val">{truncate(message.result, 800)}</pre>
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
