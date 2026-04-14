/**
 * Terminal UI utilities — spinners, markdown rendering, styled output.
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";
import { Marked } from "marked";
// @ts-ignore — marked-terminal has no up-to-date type declarations
import { markedTerminal } from "marked-terminal";
import { highlight } from "cli-highlight";

// ─── Markdown Renderer ───────────────────────────────────────────

// Force chalk to output ANSI colors — chalk v5 ESM defaults to level 0
// in non-TTY contexts (Ink rendering pipeline, piped output).
if (chalk.level === 0) {
  chalk.level = 3;
}

const marked = new Marked();
marked.use(markedTerminal() as any);

/**
 * Render markdown text to styled terminal output.
 * Falls back to raw text if rendering fails.
 */
export function renderMarkdown(text: string): string {
  if (!text.trim()) return text;
  try {
    return marked.parse(text) as string;
  } catch {
    return text;
  }
}

/**
 * Highlight a code block with syntax coloring.
 */
export function highlightCode(code: string, lang?: string): string {
  try {
    return highlight(code, { language: lang || "auto", ignoreIllegals: true });
  } catch {
    return code;
  }
}

// ─── Spinner ─────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerHandle {
  update(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
  instance: Ora;
}

/**
 * Create a spinner for long-running operations.
 */
export function createSpinner(text: string): SpinnerHandle {
  const spinner = ora({
    text: chalk.dim(text),
    spinner: { interval: 80, frames: SPINNER_FRAMES },
    prefixText: " ",
    color: "cyan",
  }).start();

  return {
    update(t: string) {
      spinner.text = chalk.dim(t);
    },
    succeed(t: string) {
      spinner.succeed(chalk.green(t));
    },
    fail(t: string) {
      spinner.fail(chalk.red(t));
    },
    stop() {
      spinner.stop();
    },
    instance: spinner,
  };
}

// ─── Styled Output Helpers ───────────────────────────────────────

/**
 * Print a styled banner box.
 */
export function printBanner(lines: { label: string; value: string }[]): void {
  const width = 56;
  const top = `  ${chalk.dim("╭" + "─".repeat(width) + "╮")}`;
  const bot = `  ${chalk.dim("╰" + "─".repeat(width) + "╯")}`;
  const empty = `  ${chalk.dim("│")}${" ".repeat(width)}${chalk.dim("│")}`;

  console.log(top);
  console.log(empty);

  // Title
  const title = "  Code Shell";
  const version = "v0.1.0";
  const titleLine = `   ${chalk.bold.cyan(title)} ${chalk.dim(version)}`;
  const pad = width - stripAnsi(titleLine).length + 4;
  console.log(`  ${chalk.dim("│")}${titleLine}${" ".repeat(Math.max(pad, 0))}${chalk.dim("│")}`);
  console.log(empty);

  // Info lines
  for (const { label, value } of lines) {
    const line = `    ${chalk.dim(label + ":")} ${value}`;
    const p = width - stripAnsi(line).length + 4;
    console.log(`  ${chalk.dim("│")}${line}${" ".repeat(Math.max(p, 0))}${chalk.dim("│")}`);
  }

  console.log(empty);

  // Help hint
  const hint = `    ${chalk.dim("type /help for commands, Ctrl+C to exit")}`;
  const hp = width - stripAnsi(hint).length + 4;
  console.log(`  ${chalk.dim("│")}${hint}${" ".repeat(Math.max(hp, 0))}${chalk.dim("│")}`);

  console.log(empty);
  console.log(bot);
}

/**
 * Format a tool call start line.
 */
export function formatToolStart(toolName: string, args: Record<string, unknown>): string {
  const argsStr = formatToolArgs(toolName, args);
  return `  ${chalk.cyan("●")} ${chalk.bold(toolName)} ${chalk.dim(argsStr)}`;
}

/**
 * Format a tool result line.
 */
export function formatToolResult(
  toolName: string,
  result?: string,
  error?: string,
): string {
  if (error) {
    return `  ${chalk.red("✗")} ${chalk.bold(toolName)} ${chalk.red(truncate(error, 100))}`;
  }
  const content = result ?? "";
  const lines = content.split("\n");
  const preview = truncate(lines[0], 100);
  const suffix = lines.length > 1 ? chalk.dim(` (+${lines.length - 1} lines)`) : "";
  return `  ${chalk.green("✓")} ${chalk.bold(toolName)} ${chalk.dim(preview)}${suffix}`;
}

/**
 * Format tool args for display — show the most relevant arg.
 */
function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
  const keyMap: Record<string, string[]> = {
    Read: ["file_path"],
    Write: ["file_path"],
    Edit: ["file_path"],
    Glob: ["pattern"],
    Grep: ["pattern", "path"],
    Bash: ["command"],
    WebSearch: ["query"],
    WebFetch: ["url"],
    Agent: ["description"],
  };
  const keys = keyMap[toolName] ?? Object.keys(args).slice(0, 2);
  const parts: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined) {
      parts.push(truncate(String(v), 60));
    }
  }
  return parts.length > 0 ? parts.join(" ") : truncate(JSON.stringify(args), 80);
}

// ─── Task List Rendering ─────────────────────────────────────────

export interface TaskDisplayInfo {
  id: string;
  subject: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "stopped";
}

/**
 * Render the task list as a compact terminal block.
 * Returns the formatted string (caller handles printing).
 */
export function renderTaskList(tasks: TaskDisplayInfo[]): string {
  if (tasks.length === 0) return "";

  const lines: string[] = [];
  lines.push(`  ${chalk.bold.cyan("Tasks")}`);

  for (const t of tasks) {
    let icon: string;
    let label: string;
    switch (t.status) {
      case "completed":
        icon = chalk.green("✓");
        label = chalk.strikethrough.dim(t.subject);
        break;
      case "in_progress":
        icon = chalk.cyan("⠋");
        label = chalk.white(t.activeForm ?? t.subject);
        break;
      case "stopped":
        icon = chalk.red("✗");
        label = chalk.strikethrough.dim(t.subject);
        break;
      default: // pending
        icon = chalk.dim("○");
        label = chalk.dim(t.subject);
        break;
    }
    lines.push(`    ${icon} ${label}`);
  }

  return lines.join("\n");
}

// ─── Utilities ───────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
