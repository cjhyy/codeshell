/**
 * Transcript — JSONL event log (NOT chat history).
 * toMessages() derives Message[] from events for sending to LLM.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import type { TranscriptEvent, TranscriptEventType, Message, ContentBlock } from "../types.js";

export class Transcript {
  private events: TranscriptEvent[] = [];
  private filePath: string;
  private currentTurn = 0;

  getFilePath(): string { return this.filePath; }

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, "", "utf-8");
    }
  }

  append(type: TranscriptEventType, data: Record<string, unknown>): TranscriptEvent {
    const event: TranscriptEvent = {
      id: nanoid(12),
      type,
      timestamp: Date.now(),
      turnNumber: this.currentTurn,
      data,
    };
    this.events.push(event);
    this.flush(event);
    return event;
  }

  appendMessage(role: string, content: string | ContentBlock[]): TranscriptEvent {
    return this.append("message", { role, content });
  }

  appendToolUse(toolName: string, toolCallId: string, args: Record<string, unknown>): TranscriptEvent {
    return this.append("tool_use", { toolName, toolCallId, args });
  }

  appendToolResult(toolCallId: string, toolName: string, result?: string, error?: string): TranscriptEvent {
    return this.append("tool_result", { toolCallId, toolName, result, error });
  }

  appendTurnBoundary(): TranscriptEvent {
    this.currentTurn++;
    return this.append("turn_boundary", { turnNumber: this.currentTurn });
  }

  appendSummary(
    summary: string,
    compactedRange: { fromTurn: number; toTurn: number; eventCount: number },
  ): TranscriptEvent {
    return this.append("summary", {
      summary,
      trigger: "auto",
      compactedRange,
      preservedSegment: {
        headEventId: this.events[0]?.id,
        tailEventId: this.events[this.events.length - 1]?.id,
      },
    });
  }

  appendError(error: string, details?: Record<string, unknown>): TranscriptEvent {
    return this.append("error", { error, ...details });
  }

  /**
   * Derive Message[] from transcript events for sending to the LLM.
   * This is the critical boundary: the LLM never sees the event log directly.
   */
  toMessages(): Message[] {
    const messages: Message[] = [];

    for (const event of this.events) {
      switch (event.type) {
        case "message": {
          const { role, content } = event.data as { role: string; content: string | ContentBlock[] };
          messages.push({ role: role as Message["role"], content });
          break;
        }
        case "tool_use": {
          // Tool use is part of assistant message content blocks
          // Already included via the assistant message event
          break;
        }
        case "tool_result": {
          const { toolCallId, result, error } = event.data as {
            toolCallId: string;
            result?: string;
            error?: string;
          };
          // Find if there's already a user message with tool_results to append to
          const lastMsg = messages[messages.length - 1];
          const block: ContentBlock = {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: error ? `Error: ${error}` : result ?? "(no output)",
          };

          if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
            (lastMsg.content as ContentBlock[]).push(block);
          } else {
            messages.push({ role: "user", content: [block] });
          }
          break;
        }
        case "summary": {
          // Content replacement: inject summary as system-reminder
          const { summary } = event.data as { summary: string };
          messages.push({
            role: "user",
            content: `<system-reminder>Previous conversation was summarized:\n${summary}</system-reminder>`,
          });
          break;
        }
        // turn_boundary, session_meta, file_history, plan_operation, error
        // are not included in LLM messages
      }
    }

    return messages;
  }

  getEvents(type?: TranscriptEventType): TranscriptEvent[] {
    if (!type) return [...this.events];
    return this.events.filter((e) => e.type === type);
  }

  get turnNumber(): number {
    return this.currentTurn;
  }

  get eventCount(): number {
    return this.events.length;
  }

  private flush(event: TranscriptEvent): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf-8");
    } catch {
      // Silently fail on flush errors — events are still in memory
    }
  }

  /**
   * Repair tool_result pairing issues:
   * - Orphaned tool_results (no matching tool_use) get removed
   * - Missing tool_results (tool_use with no result) get synthetic error results
   */
  repairToolResultPairs(): void {
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const event of this.events) {
      if (event.type === "tool_use") {
        toolUseIds.add(event.data.toolCallId as string);
      } else if (event.type === "tool_result") {
        toolResultIds.add(event.data.toolCallId as string);
      }
    }

    // Find tool_use events without matching tool_result
    for (const id of toolUseIds) {
      if (!toolResultIds.has(id)) {
        // Synthesize an error result
        this.append("tool_result", {
          toolCallId: id,
          toolName: "unknown",
          error: "[Tool result missing due to interrupted session]",
        });
      }
    }

    // Remove orphaned tool_results (result without matching use)
    this.events = this.events.filter((event) => {
      if (event.type === "tool_result") {
        const id = event.data.toolCallId as string;
        return toolUseIds.has(id);
      }
      return true;
    });
  }

  static loadFromFile(filePath: string): Transcript {
    const transcript = new Transcript(filePath);
    if (!existsSync(filePath)) return transcript;

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as TranscriptEvent;
        transcript.events.push(event);
        if (event.type === "turn_boundary") {
          transcript.currentTurn = (event.data.turnNumber as number) ?? transcript.currentTurn + 1;
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Repair pairing on load
    transcript.repairToolResultPairs();

    return transcript;
  }
}
