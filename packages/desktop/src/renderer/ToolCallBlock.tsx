import React, { useState } from "react";
import type { Message } from "./types";

type ToolMessage = Extract<Message, { kind: "tool" }>;

/**
 * Tool call display. Collapsed by default — one row showing the tool
 * name and a short summary derived from its args. Click anywhere on the
 * summary row (or the chevron) to expand and see args + result.
 *
 * Streaming tool calls (no result yet) show "running…" inline and
 * remain clickable so the user can peek at the args while the tool
 * still executes.
 */
export function ToolCallBlock({ message }: { message: ToolMessage }) {
  const [expanded, setExpanded] = useState(false);
  const running = message.result === undefined && !message.error;
  const hasError = Boolean(message.error);

  return (
    <div className={`tool-block ${expanded ? "expanded" : "collapsed"} ${hasError ? "has-error" : ""}`}>
      <button
        className="tool-head"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="tool-name">{message.toolName}</span>
        <span className="tool-summary">{summarizeArgs(message.args)}</span>
        {running && <span className="tool-spin">running…</span>}
        {hasError && !expanded && <span className="tool-err-badge">error</span>}
      </button>

      {expanded && (
        <div className="tool-body">
          <div className="tool-body-label">args</div>
          <pre className="tool-args">{prettyJson(message.args)}</pre>
          {(message.result !== undefined || message.error !== undefined) && (
            <>
              <div className="tool-body-label">{hasError ? "error" : "result"}</div>
              <pre className={hasError ? "tool-err" : "tool-out"}>
                {message.error ?? message.result}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One-line preview of the tool's args. Tries hard to surface the most
 * useful field (command for Bash, file_path for Read/Edit, url for
 * WebFetch, etc.) without parsing every tool's schema.
 */
function summarizeArgs(argsJson: string): string {
  if (!argsJson || argsJson === "{}") return "";
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return truncate(argsJson, 80);
  }
  // Prefer the human-readable single key when present, in priority order.
  const preferred = ["command", "file_path", "url", "path", "pattern", "query", "task", "prompt"];
  for (const key of preferred) {
    if (typeof obj[key] === "string") {
      return truncate(obj[key] as string, 80);
    }
  }
  // Fall back to the first string-valued field.
  for (const v of Object.values(obj)) {
    if (typeof v === "string") return truncate(v, 80);
  }
  // No string fields — show keys.
  return Object.keys(obj).join(", ");
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
