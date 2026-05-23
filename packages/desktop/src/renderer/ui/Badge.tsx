import React from "react";

export function Badge({ count, tone = "default" }: { count: number; tone?: "default" | "warn" | "err" }) {
  if (count <= 0) return null;
  return <span className={`badge badge-${tone}`}>{count > 99 ? "99+" : count}</span>;
}
