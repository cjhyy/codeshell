import React from "react";

export type Status = "idle" | "running" | "ok" | "warn" | "err";

export function StatusDot({ status, title }: { status: Status; title?: string }) {
  return <span className={`status-dot status-${status}`} title={title} aria-label={status} />;
}
