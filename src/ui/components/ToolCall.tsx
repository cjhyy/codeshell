/**
 * Tool call display — CC-style visual blocks with dots and vertical lines.
 *
 * Layout (collapsed, default):
 *   ● Bash  git status
 *   ⎿  On branch main
 *      Changes not staged for commit:
 *      … +12 lines (ctrl+o to expand)
 *
 * Layout (expanded, in transcript mode):
 *   ● Bash  git status
 *   ⎿  On branch main
 *      Changes not staged for commit:
 *      ... (all lines shown)
 *
 * Formatting logic shared with cli/output/renderer.ts via utils/toolDisplay.ts.
 */
import { useState } from "react";
import { Box, Text } from "../../render/index.js";
import {
  TOOL_DOT_COLORS,
  formatToolArgs,
  truncate,
  singleLine,
  formatBytes,
  MAX_LINE_WIDTH,
} from "../../utils/toolDisplay.js";
import { DiffLine, classifyDiffLine } from "./DiffLine.js";

/** Max visible output lines in collapsed mode (matches CC's MAX_LINES_TO_SHOW). */
const COLLAPSED_LINES = 3;

// ─── ToolCallStart ──────────────────────────────────────────────────

interface ToolCallStartProps {
  toolName: string;
  args: Record<string, unknown>;
  nested?: boolean;
}

export function ToolCallStart({ toolName, args, nested }: ToolCallStartProps) {
  const argsStr = formatToolArgs(toolName, args);
  const dotColor = TOOL_DOT_COLORS[toolName] ?? "ansi:cyan";
  const ml = nested ? 3 : 0;

  // Top-level tool blocks get a blank line above them so back-to-back tool
  // calls don't visually fuse into one wall (matches Claude Code's spacing).
  // Nested (under Agent) stays tight because the agent block already groups.
  return (
    <Box marginLeft={ml} marginTop={nested ? 0 : 1}>
      <Text color={dotColor}>{"  ●"}</Text>
      <Text bold> {toolName}</Text>
      <Text dim>
        {"  "}
        {argsStr}
      </Text>
    </Box>
  );
}

// ─── ToolCallRunning ────────────────────────────────────────────────

interface ToolCallRunningProps {
  toolName: string;
  nested?: boolean;
}

export function ToolCallRunning({ toolName, nested }: ToolCallRunningProps) {
  const ml = nested ? 3 : 0;
  return (
    <Box marginLeft={ml}>
      <Text dim>{"  │ "}</Text>
      <Text color="ansi:cyan">{"⠹ "}</Text>
      <Text dim>{toolName}…</Text>
    </Box>
  );
}

// ─── ToolCallResult ─────────────────────────────────────────────────

interface ToolCallResultProps {
  toolName: string;
  result?: string;
  error?: string;
  nested?: boolean;
  /** When true, show full output instead of collapsed preview. */
  expanded?: boolean;
  /**
   * When true, render as a single dim line — used for transient
   * "this attempt failed and was retried" cases (e.g. Arena's
   * fail-fast endpoint check) so the feed isn't swamped with scary
   * red error cards for what was just a parameter fix-up.
   */
  compact?: boolean;
}

export function ToolCallResult({
  toolName,
  result,
  error,
  nested,
  expanded: forceExpand,
  compact,
}: ToolCallResultProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = forceExpand || localExpanded;
  const ml = nested ? 3 : 0;

  if (compact) {
    const summary = singleLine(result ?? error ?? "");
    return (
      <Box marginLeft={ml}>
        <Text dim>
          {"  · "}
          {toolName}
          {" retried — "}
          {truncate(summary, 90)}
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box marginLeft={ml}>
        <Text color="ansi:red">{"  ✗ "}</Text>
        <Text dim>{toolName} </Text>
        <Text color="ansi:red">{truncate(singleLine(error), 72)}</Text>
      </Box>
    );
  }

  const content = result ?? "";
  if (!content) {
    return (
      <Box marginLeft={ml}>
        <Text color="ansi:green">{"  ✓ "}</Text>
        <Text dim>{toolName}</Text>
      </Box>
    );
  }

  // Tool-specific rendering
  const rendered = renderToolOutput(toolName, content, expanded);

  return (
    <Box flexDirection="column" marginLeft={ml}>
      <Box>
        <Text color="ansi:green">{"  ✓ "}</Text>
        <Text dim>{toolName}</Text>
        {rendered.summary ? <Text dim> {rendered.summary}</Text> : null}
      </Box>
      {rendered.lines.length > 0 && (
        <Box flexDirection="column">
          {rendered.lines.map((line, i) => (
            <DiffOrPlainRow key={i} line={clampLine(line)} />
          ))}
          {rendered.hiddenCount > 0 && (
            <Box>
              <Text dim>{"  ⎿  "}</Text>
              <Text dim>
                {"… +"}
                {rendered.hiddenCount}
                {" lines"}
                {!forceExpand ? " (ctrl+o to expand)" : ""}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

// ─── Tool Output Rendering ──────────────────────────────────────────

interface RenderedOutput {
  summary: string;
  lines: string[];
  hiddenCount: number;
}

/**
 * Strip <system-reminder>…</system-reminder> blocks from tool output before
 * rendering. The InvestigationGuard prepends these to nudge the LLM mid-loop;
 * they're context for the model, not status for the user.
 */
function stripSystemReminders(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");
}

function renderToolOutput(toolName: string, content: string, expanded: boolean): RenderedOutput {
  content = stripSystemReminders(content);
  const rawLines = content.split("\n");
  const totalLines = rawLines.length;

  switch (toolName) {
    case "Read": {
      // Read: show summary only (no preview lines)
      return {
        summary: `${totalLines} lines, ${formatBytes(content.length)}`,
        lines: [],
        hiddenCount: 0,
      };
    }

    case "Write": {
      // Write returns the raw file content. Show only the first-line summary
      // when collapsed; the rest of the body isn't useful inline — the user
      // can re-read the file if they need it.
      const summary = singleLine(rawLines[0] ?? "").slice(0, 80);
      return { summary, lines: [], hiddenCount: 0 };
    }

    case "Edit": {
      // Edit tool returns "Successfully edited <file>\n<diff>" where the
      // diff is a `  - …` / `  + …` block (see edit.ts generateCompactDiff).
      // Show the summary collapsed; expose the full diff in expanded /
      // transcript mode so additions/removals get DiffColoredLine treatment.
      const [summaryLine, ...rest] = rawLines;
      const summary = singleLine(summaryLine ?? "").slice(0, 80);
      const diffLines = rest.filter((l) => l.length > 0);
      if (expanded) {
        return { summary, lines: diffLines, hiddenCount: 0 };
      }
      if (diffLines.length === 0) {
        return { summary, lines: [], hiddenCount: 0 };
      }
      const previewCount = Math.min(diffLines.length, COLLAPSED_LINES);
      return {
        summary,
        lines: diffLines.slice(0, previewCount),
        hiddenCount: Math.max(0, diffLines.length - previewCount),
      };
    }

    case "Glob": {
      // Strip the "N files matched:" header glob.ts emits so the count is accurate.
      const files = rawLines
        .filter((l) => l.trim())
        .filter((l) => !/^\d+\s+files?\s+matched/i.test(l));
      const count = files.length;
      if (expanded) {
        return { summary: `${count} files`, lines: files, hiddenCount: 0 };
      }
      // Few results: show them inline — making the user ctrl+o for a 2-file
      // match was a regression. Many results: summary + first N + "+M lines".
      if (count <= COLLAPSED_LINES) {
        return { summary: `${count} files`, lines: files, hiddenCount: 0 };
      }
      return {
        summary: `${count} files`,
        lines: files.slice(0, COLLAPSED_LINES),
        hiddenCount: count - COLLAPSED_LINES,
      };
    }

    case "Grep": {
      const matches = rawLines.filter((l) => l.trim());
      const count = matches.length;
      if (expanded) {
        return { summary: `${count} results`, lines: matches, hiddenCount: 0 };
      }
      if (count <= COLLAPSED_LINES) {
        return { summary: `${count} results`, lines: matches, hiddenCount: 0 };
      }
      return {
        summary: `${count} results`,
        lines: matches.slice(0, COLLAPSED_LINES),
        hiddenCount: count - COLLAPSED_LINES,
      };
    }

    case "Bash": {
      // Bash: show output with fold/expand — this is the most important one
      if (totalLines <= 1 && rawLines[0]?.trim() === "") {
        return { summary: "(no output)", lines: [], hiddenCount: 0 };
      }
      if (expanded) {
        return { summary: "", lines: rawLines, hiddenCount: 0 };
      }
      if (totalLines <= COLLAPSED_LINES + 1) {
        // +1: if only 1 hidden line, just show it
        return { summary: "", lines: rawLines, hiddenCount: 0 };
      }
      return {
        summary: `${totalLines} lines`,
        lines: rawLines.slice(0, COLLAPSED_LINES),
        hiddenCount: totalLines - COLLAPSED_LINES,
      };
    }

    case "Agent": {
      return { summary: truncate(singleLine(content), 80), lines: [], hiddenCount: 0 };
    }

    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskStop":
    case "TaskGet":
    case "TaskOutput":
      return { summary: singleLine(content), lines: [], hiddenCount: 0 };

    case "WebSearch":
    case "WebFetch": {
      if (expanded) {
        return { summary: "", lines: rawLines, hiddenCount: 0 };
      }
      if (totalLines <= COLLAPSED_LINES + 1) {
        return { summary: "", lines: rawLines, hiddenCount: 0 };
      }
      return {
        summary: `${totalLines} lines`,
        lines: rawLines.slice(0, COLLAPSED_LINES),
        hiddenCount: totalLines - COLLAPSED_LINES,
      };
    }

    default: {
      if (totalLines <= 1) {
        return { summary: truncate(content, 80), lines: [], hiddenCount: 0 };
      }
      if (expanded) {
        return { summary: "", lines: rawLines, hiddenCount: 0 };
      }
      if (totalLines <= COLLAPSED_LINES + 1) {
        return { summary: "", lines: rawLines, hiddenCount: 0 };
      }
      return {
        summary: `${totalLines} lines`,
        lines: rawLines.slice(0, COLLAPSED_LINES),
        hiddenCount: totalLines - COLLAPSED_LINES,
      };
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function clampLine(s: string): string {
  return s.length > MAX_LINE_WIDTH ? s.slice(0, MAX_LINE_WIDTH - 1) + "…" : s;
}

/**
 * Renders one line of tool output. Diff lines (Edit / ApplyPatch / `git diff`
 * output) delegate to the shared <DiffLine> so every diff surface in the app
 * (PermissionPrompt previews, DiffView, ToolCall expansions) looks identical.
 *
 * Plain (non-diff) rows keep the `⎿` gutter so the result body still groups
 * visually under the `✓ ToolName` header.
 */
function DiffOrPlainRow({ line }: { line: string }) {
  const classified = classifyDiffLine(line);
  if (classified.kind === "add" || classified.kind === "remove") {
    return <DiffLine kind={classified.kind} text={classified.text} gutter={"  ⎿  "} />;
  }
  if (classified.kind === "hunk") {
    return (
      <Box>
        <Text dim>{"  ⎿  "}</Text>
        <Text color="ansi:cyan">{classified.text}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text dim>{"  ⎿  "}</Text>
      <Text>{line}</Text>
    </Box>
  );
}
