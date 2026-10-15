import React from "react";

export type Status = "idle" | "running" | "ok" | "warn" | "err";

const STATUS_TONE: Record<Status, string> = {
  idle: "bg-muted-foreground/60",
  running: "bg-primary motion-safe:animate-pulse",
  ok: "bg-status-ok",
  warn: "bg-status-warn",
  err: "bg-status-err",
};

export function StatusDot({ status, title }: { status: Status; title?: string }) {
  return (
    <span
      className={`status-dot status-${status} inline-block size-2 shrink-0 rounded-full ${STATUS_TONE[status]}`}
      role="img"
      title={title}
      aria-label={status}
    />
  );
}
