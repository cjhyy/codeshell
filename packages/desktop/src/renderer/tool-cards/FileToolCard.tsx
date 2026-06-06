import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { parsedArgs, truncate } from "./utils";
import { classifyPath } from "./attachments";
import { AttachmentCard } from "./AttachmentCard";
import { OpenWithMenu } from "../chat/OpenWithMenu";
import { MoreHorizontal } from "lucide-react";

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
        {path && (
          <OpenWithMenu path={path} align="end">
            <button
              type="button"
              className="attachment-openwith"
              title="打开方式"
              aria-label="打开方式"
              style={{ opacity: 1 }}
            >
              <MoreHorizontal size={14} />
            </button>
          </OpenWithMenu>
        )}
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
      {variant === "write" && path && writeAttachmentKind(path, message) && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">file</span>
          <div className="attachment-list">
            <AttachmentCard
              attachment={{ path, kind: writeAttachmentKind(path, message)! }}
            />
          </div>
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

/**
 * For Write tool calls, return the attachment kind iff the file
 * looks like a recognisable artifact (image / md / html) and the
 * call didn't fail. `null` means "render no attachment card",
 * keeping the existing behavior for source files.
 */
function writeAttachmentKind(
  path: string,
  message: ToolMessage,
): "image" | "markdown" | "html" | null {
  if (message.error) return null;
  if (message.status !== "succeeded") return null;
  const k = classifyPath(path);
  if (k === "file") return null;
  return k;
}
