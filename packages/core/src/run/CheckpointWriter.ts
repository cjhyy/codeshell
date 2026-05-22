/**
 * CheckpointWriter — extracts structured checkpoints from Engine execution.
 *
 * Checkpoint sources (per design doc §12):
 *   1. Lifecycle — run started, resumed, completed (handled by RunManager)
 *   2. Phase boundary — detected from assistant messages via keyword heuristics
 *   3. Waiting — entering waiting_input / waiting_approval (handled by RunManager)
 *   4. Final — terminal state (handled by RunManager)
 *
 * This writer handles #2 (phase boundary) and periodic turn-based checkpoints.
 * It listens to StreamEvents and writes checkpoints to RunStore when triggered.
 *
 * Design constraints (§12.1):
 *   - Do NOT checkpoint every tool call
 *   - Do NOT depend on model real-time summarization
 *   - Checkpoint = "state summary + pointers", not "full text copy"
 */

import { nanoid } from "nanoid";
import type { StreamEvent } from "../types.js";
import type { RunStore } from "./RunStore.js";
import type { RunCheckpoint } from "./types.js";

export interface CheckpointWriterConfig {
  runId: string;
  objective: string;
  store: RunStore;
  /** Write a periodic checkpoint every N turns. 0 = disabled. Default: 10 */
  turnInterval?: number;
}

/**
 * Known phase keywords — when an assistant message contains these patterns,
 * we infer a phase transition and write a boundary checkpoint.
 */
const PHASE_PATTERNS: Array<{ pattern: RegExp; phase: string }> = [
  { pattern: /\bplan\b.*\b(ready|complete|done|finalized)\b/i, phase: "plan_ready" },
  { pattern: /\bresearch\b.*\b(complete|done|finished)\b/i, phase: "research_complete" },
  { pattern: /\banalysis\b.*\b(complete|done|finished)\b/i, phase: "analysis_complete" },
  { pattern: /\bimplementation\b.*\b(complete|done|finished)\b/i, phase: "implementation_complete" },
  { pattern: /\bdraft\b.*\b(generated|ready|complete)\b/i, phase: "draft_generated" },
  { pattern: /\btests?\b.*\b(pass|passing|green|complete)\b/i, phase: "tests_passing" },
  { pattern: /\breview\b.*\b(complete|done|finished)\b/i, phase: "review_complete" },
  { pattern: /\brefactor\b.*\b(complete|done|finished)\b/i, phase: "refactor_complete" },
];

export class CheckpointWriter {
  private readonly config: CheckpointWriterConfig;
  private readonly turnInterval: number;

  private currentTurn = 0;
  private lastCheckpointTurn = 0;
  private touchedTools = new Set<string>();
  private lastAssistantText = "";
  private sessionId: string | null = null;
  private detectedPhases = new Set<string>();

  constructor(config: CheckpointWriterConfig) {
    this.config = config;
    this.turnInterval = config.turnInterval ?? 10;
  }

  /**
   * Feed a StreamEvent to the writer. Called for every event during execution.
   */
  async onStreamEvent(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "stream_request_start":
        this.currentTurn = event.turnNumber;
        break;

      case "tool_use_start":
        this.touchedTools.add(event.toolCall.toolName);
        break;

      case "assistant_message": {
        const text =
          typeof event.message.content === "string"
            ? event.message.content
            : event.message.content
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join("");
        this.lastAssistantText = text;

        // Check for phase boundary
        await this.checkPhaseBoundary(text);
        break;
      }

      case "turn_complete":
        // Periodic checkpoint
        if (
          this.turnInterval > 0 &&
          this.currentTurn - this.lastCheckpointTurn >= this.turnInterval
        ) {
          await this.writePeriodicCheckpoint();
        }
        break;
    }
  }

  /** Set the linked session ID (called once known after Engine.run starts). */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Get accumulated touched tools for use in final checkpoint. */
  getTouchedTools(): string[] {
    return [...this.touchedTools];
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async checkPhaseBoundary(text: string): Promise<void> {
    for (const { pattern, phase } of PHASE_PATTERNS) {
      if (pattern.test(text) && !this.detectedPhases.has(phase)) {
        this.detectedPhases.add(phase);
        await this.writeCheckpoint(phase, this.extractSummary(text));
        break; // One phase per message
      }
    }
  }

  private async writePeriodicCheckpoint(): Promise<void> {
    this.lastCheckpointTurn = this.currentTurn;
    await this.writeCheckpoint(
      `turn_${this.currentTurn}`,
      this.extractSummary(this.lastAssistantText),
    );
  }

  private async writeCheckpoint(phase: string, summary: string): Promise<void> {
    const checkpoint: RunCheckpoint = {
      checkpointId: nanoid(12),
      runId: this.config.runId,
      createdAt: Date.now(),
      phase,
      objective: this.config.objective,
      summary,
      nextAction: null,
      linkedSessionId: this.sessionId,
      touchedTools: [...this.touchedTools],
      touchedArtifacts: [],
      waitingFor: null,
      evaluator: null,
      metadata: { turn: this.currentTurn },
    };

    await this.config.store.saveCheckpoint(checkpoint);
  }

  /**
   * Extract a short summary from assistant text.
   * Takes the first ~300 chars, truncated at sentence boundary.
   */
  private extractSummary(text: string): string {
    if (!text) return "(no summary available)";
    const truncated = text.slice(0, 400);
    // Try to break at last sentence boundary
    const lastPeriod = truncated.lastIndexOf(".");
    const lastNewline = truncated.lastIndexOf("\n");
    const breakPoint = Math.max(lastPeriod, lastNewline);
    if (breakPoint > 100) {
      return truncated.slice(0, breakPoint + 1).trim();
    }
    return truncated.trim() + (text.length > 400 ? "..." : "");
  }
}
