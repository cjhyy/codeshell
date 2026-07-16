import React from "react";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  default: "bg-primary text-primary-foreground",
  warn: "bg-status-warn text-white",
  err: "bg-status-err text-white",
} as const;

export function Badge({
  count,
  tone = "default",
}: {
  count: number;
  tone?: "default" | "warn" | "err";
}) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 tabular-nums",
        TONE_CLASS[tone],
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
