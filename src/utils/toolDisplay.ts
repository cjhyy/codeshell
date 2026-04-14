/**
 * Shared formatting utilities for tool call display.
 *
 * Used by both:
 * - ui/components/ToolCall.tsx (Ink REPL)
 * - cli/output/renderer.ts (headless text output)
 */

/** Maximum preview lines for tool output. */
export const MAX_PREVIEW_LINES = 4;
export const MAX_LINE_WIDTH = 88;

/** Tool name → display color for the dot indicator. */
export const TOOL_DOT_COLORS: Record<string, string> = {
  Read: "ansi:blue",
  Write: "ansi:green",
  Edit: "ansi:yellow",
  Bash: "ansi:magenta",
  Glob: "ansi:blue",
  Grep: "ansi:blue",
  Agent: "ansi:cyan",
  WebSearch: "ansi:blue",
  WebFetch: "ansi:blue",
  LSP: "ansi:cyan",
  TaskCreate: "ansi:cyan",
  TaskUpdate: "ansi:cyan",
};

/** Mapping of tool names to their most informative argument keys. */
const TOOL_ARG_KEYS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  Glob: ["pattern"],
  Grep: ["pattern", "path"],
  Bash: ["command"],
  WebSearch: ["query"],
  WebFetch: ["url"],
  Agent: ["description"],
  TaskCreate: ["subject"],
  TaskUpdate: ["taskId", "status"],
  Sleep: ["seconds"],
  EnterWorktree: ["slug"],
  SendMessage: ["to"],
  CronCreate: ["name", "schedule"],
  LSP: ["action", "file_path"],
  NotebookEdit: ["action", "file_path"],
  Config: ["action", "key"],
};

/**
 * Format tool arguments into a compact one-line summary.
 */
export function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
  const keys = TOOL_ARG_KEYS[toolName] ?? Object.keys(args).slice(0, 2);
  const parts: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && !k.startsWith("__")) {
      parts.push(truncate(String(v), 60));
    }
  }
  return parts.length > 0 ? parts.join(" ") : truncate(JSON.stringify(args), 80);
}

/** Truncate a string to max length with ellipsis. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Collapse multiline text to a single line. */
export function singleLine(s: string): string {
  return s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

/** Format byte count in human-readable form. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + "MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + "KB";
  return n + "B";
}

// ─── Compact Output ────────────────────────────────────────────────

export interface CompactResult {
  summary: string;
  preview: string[];
  moreLines: number;
}

/**
 * Produce a compact summary of tool output for display.
 */
export function compactOutput(toolName: string, content: string): CompactResult {
  const lines = content.split("\n");
  const totalLines = lines.length;

  switch (toolName) {
    case "Read":
      return { summary: `${totalLines} lines, ${formatBytes(content.length)}`, preview: [], moreLines: 0 };

    case "Bash": {
      if (totalLines <= MAX_PREVIEW_LINES) {
        return { summary: "", preview: lines.map((l) => truncate(l, MAX_LINE_WIDTH)), moreLines: 0 };
      }
      return {
        summary: `${totalLines} lines output`,
        preview: lines.slice(0, MAX_PREVIEW_LINES).map((l) => truncate(l, MAX_LINE_WIDTH)),
        moreLines: totalLines - MAX_PREVIEW_LINES,
      };
    }

    case "Glob": {
      const fileCount = lines.filter((l) => l.trim()).length;
      return {
        summary: `${fileCount} files found`,
        preview: lines.slice(0, 5).map((l) => truncate(l, MAX_LINE_WIDTH)),
        moreLines: Math.max(0, fileCount - 5),
      };
    }

    case "Grep": {
      const matchCount = lines.filter((l) => l.trim()).length;
      return {
        summary: `${matchCount} matches`,
        preview: lines.slice(0, MAX_PREVIEW_LINES).map((l) => truncate(l, MAX_LINE_WIDTH)),
        moreLines: Math.max(0, matchCount - MAX_PREVIEW_LINES),
      };
    }

    case "Write":
      return { summary: singleLine(content).slice(0, 60), preview: [], moreLines: 0 };

    case "Edit":
      return { summary: singleLine(content).slice(0, 70), preview: [], moreLines: 0 };

    case "Agent":
      return { summary: truncate(singleLine(content), 80), preview: [], moreLines: 0 };

    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskStop":
    case "TaskGet":
    case "TaskOutput":
      return { summary: singleLine(content), preview: [], moreLines: 0 };

    default: {
      if (totalLines <= 1) {
        return { summary: truncate(content, 80), preview: [], moreLines: 0 };
      }
      return {
        summary: `${totalLines} lines`,
        preview: lines.slice(0, MAX_PREVIEW_LINES).map((l) => truncate(l, MAX_LINE_WIDTH)),
        moreLines: Math.max(0, totalLines - MAX_PREVIEW_LINES),
      };
    }
  }
}
