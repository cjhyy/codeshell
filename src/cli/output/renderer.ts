/**
 * Output renderers for different formats.
 */

import chalk from "chalk";
import type { StreamEvent, TerminalReason } from "../../types.js";
import {
  formatToolArgs,
  truncate,
  singleLine,
  formatBytes,
} from "../../utils/toolDisplay.js";

export type OutputFormat = "text" | "json" | "jsonl" | "stream-json";

export interface OutputRenderer {
  onEvent(event: StreamEvent): void;
  onComplete(text: string, reason: TerminalReason, meta: Record<string, unknown>): void;
}

export class TextRenderer implements OutputRenderer {
  private activeAgents = new Set<string>();

  onEvent(event: StreamEvent): void {
    const agentId = (event as any).agentId as string | undefined;
    const indent = agentId ? "    " : "";
    const prefix = agentId ? chalk.dim("│ ") : "";

    switch (event.type) {
      case "text_delta":
        // Only show main agent text in headless mode
        if (!agentId) {
          process.stdout.write(event.text);
        }
        break;

      case "agent_start": {
        const ev = event as any;
        this.activeAgents.add(ev.agentId);
        process.stderr.write(`\n${indent}${chalk.magenta("▸")} ${chalk.bold("Agent")} ${chalk.dim(ev.description)}\n`);
        break;
      }

      case "agent_end": {
        const ev = event as any;
        this.activeAgents.delete(ev.agentId);
        if (ev.error) {
          process.stderr.write(`${indent}${chalk.red("✗")} ${chalk.dim(`Agent ${ev.description}: ${ev.error}`)}\n`);
        } else {
          process.stderr.write(`${indent}${chalk.green("✓")} ${chalk.dim(`Agent ${ev.description}`)}\n`);
        }
        break;
      }

      case "tool_use_start": {
        const tc = event.toolCall;
        const argsStr = formatToolArgs(tc.toolName, tc.args);
        process.stderr.write(`${indent}${prefix}${chalk.cyan("●")} ${chalk.bold(tc.toolName)} ${chalk.dim(argsStr)}\n`);
        break;
      }

      case "tool_result": {
        const r = event.result;
        if (r.error) {
          process.stderr.write(`${indent}${prefix}${chalk.red("✗")} ${chalk.bold(r.toolName)} ${chalk.red(truncate(singleLine(r.error), 80))}\n`);
        } else {
          const content = r.result ?? "";
          const summary = compactSummary(r.toolName, content);
          process.stderr.write(`${indent}${prefix}${chalk.green("✓")} ${chalk.bold(r.toolName)} ${chalk.dim(summary)}\n`);
        }
        break;
      }

      case "error":
        process.stderr.write(`${indent}${prefix}${chalk.red("✗")} ${event.error}\n`);
        break;
    }
  }

  onComplete(_text: string, reason: TerminalReason): void {
    if (reason !== "completed") {
      process.stdout.write(`\n${chalk.yellow(`[${reason}]`)}\n`);
    } else {
      process.stdout.write("\n");
    }
  }
}

export class JsonRenderer implements OutputRenderer {
  private text = "";
  onEvent(event: StreamEvent): void {
    if (event.type === "text_delta") this.text += event.text;
  }
  onComplete(text: string, reason: TerminalReason, meta: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ result: text || this.text, reason, ...meta }, null, 2) + "\n");
  }
}

export class JsonlRenderer implements OutputRenderer {
  onEvent(event: StreamEvent): void {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  onComplete(text: string, reason: TerminalReason, meta: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ type: "result", text, reason, ...meta }) + "\n");
  }
}

export class StreamJsonRenderer implements OutputRenderer {
  onEvent(event: StreamEvent): void {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  onComplete(text: string, reason: TerminalReason, meta: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ type: "result", text, reason, ...meta }) + "\n");
  }
}

export function createRenderer(format: OutputFormat): OutputRenderer {
  switch (format) {
    case "json": return new JsonRenderer();
    case "jsonl": return new JsonlRenderer();
    case "stream-json": return new StreamJsonRenderer();
    default: return new TextRenderer();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function compactSummary(toolName: string, content: string): string {
  const lines = content.split("\n");
  const total = lines.length;

  switch (toolName) {
    case "Read":
      return `${total} lines, ${formatBytes(content.length)}`;
    case "Glob":
      return `${lines.filter((l) => l.trim()).length} files`;
    case "Grep":
      return `${lines.filter((l) => l.trim()).length} matches`;
    case "Write":
    case "Edit":
      return truncate(singleLine(content), 60);
    case "Bash": {
      if (total <= 1) return truncate(singleLine(content), 80);
      const preview = truncate(lines[0], 60);
      return `${preview} (+${total - 1} lines)`;
    }
    default:
      if (total <= 1) return truncate(content, 80);
      return `${truncate(lines[0], 60)} (+${total - 1} lines)`;
  }
}
