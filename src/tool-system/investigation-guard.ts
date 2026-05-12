/**
 * Investigation Guard — runtime enforcement of read budgets.
 *
 * Background: prompt rules in coding.md ("never re-read the same file",
 * "after ~3 read-only calls, change strategy") describe a behavior the model
 * frequently violates under context pressure. This module turns those soft
 * rules into in-loop reminders/blocks delivered through tool results.
 *
 * Three independent counters share one guard instance per Engine:
 *   A) dedupe          — same Read offset hit ≥2 times → reminder; ≥3 times → block
 *   B) read-budget     — N consecutive read-only tools with no side-effecting
 *                        tool in between → reminder on the next read
 *   C) silent turns    — N consecutive turns of only read-only tools with no
 *                        text output → injected into the *next* turn's user
 *                        message by turn-loop (the guard just tracks state).
 *
 * Everything decays naturally on any write/Bash/AskUser tool (state reset).
 */

import type { ToolCall, ToolResult } from "../types.js";

const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch"]);

const READ_BUDGET = 3;
const SILENT_TURN_BUDGET = 3;
const DEDUPE_OFFSET_BUCKET = 50;
// Cap readHistory so a long-running session can't grow it unbounded.
// 512 distinct read signatures is far above what any real investigation
// touches; once exceeded, evict oldest insertion-order entries.
const READ_HISTORY_MAX = 512;

interface ReadKey {
  tool: string;
  signature: string;
}

export interface GuardDecision {
  block?: string;
  prepend?: string;
}

export class InvestigationGuard {
  private readHistory = new Map<string, number>();
  private consecutiveReads = 0;
  private silentTurns = 0;
  private turnHasText = false;
  private turnHasSideEffect = false;
  private lastReminderSilent = -1;

  preToolCheck(call: ToolCall): GuardDecision | undefined {
    const tool = call.toolName;
    if (!READ_ONLY_TOOLS.has(tool)) {
      if (this.isMutatingTool(tool)) {
        this.consecutiveReads = 0;
        this.turnHasSideEffect = true;
      }
      return undefined;
    }

    const key = this.buildKey(call);
    if (!key) return undefined;
    const hits = (this.readHistory.get(key.signature) ?? 0) + 1;
    this.readHistory.set(key.signature, hits);
    if (this.readHistory.size > READ_HISTORY_MAX) {
      const oldest = this.readHistory.keys().next().value;
      if (oldest !== undefined) this.readHistory.delete(oldest);
    }
    this.consecutiveReads += 1;

    const prependParts: string[] = [];

    if (hits >= 3) {
      return {
        block:
          `Investigation guard: ${tool} on this exact target has been called ${hits} times in this session. ` +
          `Re-reading the same content will not produce new information. ` +
          `Switch strategy: run a command with side effects (Bash, debug log, repro), make a code change, or ask the user a specific question. ` +
          `If you genuinely need this content, summarize what you already know about it from prior reads instead of re-fetching.`,
      };
    }
    if (hits === 2) {
      prependParts.push(
        `<system-reminder>Investigation guard: you already read this target once in this session. ` +
          `Re-reading rarely yields new information. After this result, change strategy (Bash side-effect, edit, or ask user) rather than reading further.</system-reminder>`,
      );
    }

    if (this.consecutiveReads > READ_BUDGET) {
      prependParts.push(
        `<system-reminder>Investigation guard: ${this.consecutiveReads} consecutive read-only calls with no action taken. ` +
          `Per coding.md, change strategy now — make a code change, run a command with side effects, or ask the user.</system-reminder>`,
      );
    }

    return prependParts.length ? { prepend: prependParts.join("\n") } : undefined;
  }

  noteText(text: string | undefined): void {
    if (text && text.trim().length > 0) this.turnHasText = true;
  }

  noteToolResult(_call: ToolCall, _result: ToolResult): void {}

  turnEnded(turnNumber: number): string | undefined {
    if (!this.turnHasText && !this.turnHasSideEffect) {
      this.silentTurns += 1;
    } else {
      this.silentTurns = 0;
    }
    const wasSilent = this.silentTurns;
    this.turnHasText = false;
    this.turnHasSideEffect = false;

    if (wasSilent >= SILENT_TURN_BUDGET && turnNumber !== this.lastReminderSilent) {
      this.lastReminderSilent = turnNumber;
      return (
        `<system-reminder>Investigation guard: you have taken ${wasSilent} consecutive turns of read-only investigation ` +
          `without any text update to the user or side-effecting action. ` +
          `Either surface a status update (what have you ruled out, what's your current hypothesis?), ` +
          `or change tactic — verify at runtime (logs, repro, Bash) instead of reading further.</system-reminder>`
      );
    }
    return undefined;
  }

  private isMutatingTool(name: string): boolean {
    if (name === "Bash") return true;
    if (name === "Edit" || name === "Write" || name === "NotebookEdit") return true;
    if (name === "AskUserQuestion") return true;
    if (name === "TaskCreate" || name === "TaskUpdate") return false;
    return false;
  }

  private buildKey(call: ToolCall): ReadKey | undefined {
    const tool = call.toolName;
    const args = (call.args ?? {}) as Record<string, unknown>;
    if (tool === "Read") {
      const fp = typeof args.file_path === "string" ? args.file_path : "";
      if (!fp) return undefined;
      const off = typeof args.offset === "number" ? args.offset : 0;
      const bucket = Math.floor(off / DEDUPE_OFFSET_BUCKET);
      return { tool, signature: `Read::${fp}::${bucket}` };
    }
    if (tool === "Grep") {
      const pat = typeof args.pattern === "string" ? args.pattern : "";
      const path = typeof args.path === "string" ? args.path : "";
      const glob = typeof args.glob === "string" ? args.glob : "";
      if (!pat) return undefined;
      return { tool, signature: `Grep::${pat}::${path}::${glob}` };
    }
    if (tool === "Glob") {
      const pat = typeof args.pattern === "string" ? args.pattern : "";
      const path = typeof args.path === "string" ? args.path : "";
      if (!pat) return undefined;
      return { tool, signature: `Glob::${pat}::${path}` };
    }
    return undefined;
  }
}
