import React from "react";
import type { ToolMessage } from "../types";
import { ChevronRight, ChevronDown } from "../ui/icons";
import { StatusDot, type Status } from "../ui/StatusDot";
import { formatDuration } from "./utils";

interface Props {
  message: ToolMessage;
  /** One-line summary shown on the head row. */
  summary: React.ReactNode;
  /** Optional rich detail when the card is expanded inline. */
  details?: React.ReactNode;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
}

export function ToolCardShell({ message, summary, details, onSelect, selected }: Props) {
  const [open, setOpen] = React.useState(false);
  const status: Status =
    message.status === "running"
      ? "running"
      : message.status === "failed" || message.status === "denied"
        ? "err"
        : message.status === "succeeded"
          ? "ok"
          : message.status === "cancelled"
            ? "warn"
            : "idle";
  const duration = formatDuration(message.durationMs);
  return (
    <div
      className={`tool-card status-${message.status}${selected ? " selected" : ""}`}
      onClick={() => onSelect?.(message)}
    >
      <button
        className="tool-card-head"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <StatusDot status={status} title={message.status} />
        <span className="tool-card-name">{message.toolName}</span>
        <span className="tool-card-summary">{summary}</span>
        {duration && <span className="tool-card-duration">{duration}</span>}
        {message.status === "failed" && (
          <span className="tool-card-err-badge">error</span>
        )}
      </button>
      {open && details && <div className="tool-card-body">{details}</div>}
      {message.summary && (
        <div className="tool-card-subtitle">{message.summary}</div>
      )}
    </div>
  );
}
