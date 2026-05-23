import React from "react";

export type RiskLevel = "low" | "medium" | "high";

export function RiskPill({ level }: { level: RiskLevel }) {
  return <span className={`risk-pill risk-${level}`}>{level} risk</span>;
}

/** Heuristic: classify risk by tool name + args content. */
export function riskFor(toolName: string, args: string): RiskLevel {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "shell" || name === "run") {
    if (/\brm\s+-rf|chmod\s+-R|chown\s+-R|sudo\b|curl\s+[^|]+\|\s*sh/i.test(args)) return "high";
    if (/\b(rm|mv|cp|chmod|chown|kill|reboot|shutdown)\b/.test(args)) return "medium";
    return "low";
  }
  if (name === "write" || name === "edit" || name === "multiedit" || name === "applypatch" || name === "apply_patch") {
    return "medium";
  }
  if (name === "webfetch" || name === "websearch" || name === "fetch") {
    return "low";
  }
  return "low";
}
