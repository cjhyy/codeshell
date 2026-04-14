/**
 * ArtifactTracker — records meaningful artifact refs during run execution.
 *
 * Listens to StreamEvents and identifies:
 *   - Files written or edited (Write / Edit tool results)
 *   - Files created by Bash commands (mkdir, touch, cp, git commit, etc.)
 *   - Structured outputs (e.g., generated configs, test results)
 *
 * Design constraint (§14):
 *   - Only record artifacts valuable for recovery, display, evaluation, or audit
 *   - Do NOT record every Read or every tool output
 *   - Judgment: file writes are artifacts, reads are not
 */

import { nanoid } from "nanoid";
import type { StreamEvent, ToolCall } from "../types.js";
import type { RunStore } from "./RunStore.js";
import type { RunArtifactRef, ArtifactKind, ArtifactRole } from "./types.js";

export interface ArtifactTrackerConfig {
  runId: string;
  store: RunStore;
}

/** Pending tool call — we need the call args to determine artifact details. */
interface PendingToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export class ArtifactTracker {
  private readonly config: ArtifactTrackerConfig;
  private readonly pendingCalls = new Map<string, PendingToolCall>();
  private readonly recordedPaths = new Set<string>();

  constructor(config: ArtifactTrackerConfig) {
    this.config = config;
  }

  /**
   * Feed a StreamEvent to the tracker.
   */
  async onStreamEvent(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "tool_use_start":
        this.pendingCalls.set(event.toolCall.id, {
          toolName: event.toolCall.toolName,
          args: event.toolCall.args,
        });
        break;

      case "tool_result": {
        const call = this.pendingCalls.get(event.result.id);
        if (!call) break;
        this.pendingCalls.delete(event.result.id);

        // Only track successful results
        if (event.result.isError || event.result.error) break;

        await this.processToolResult(call, event.result.result);
        break;
      }
    }
  }

  /** Get all recorded artifact paths. */
  getRecordedPaths(): string[] {
    return [...this.recordedPaths];
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async processToolResult(
    call: PendingToolCall,
    resultText?: string,
  ): Promise<void> {
    switch (call.toolName) {
      case "Write":
        await this.recordFileArtifact(
          call.args.file_path as string,
          "output",
          "file",
        );
        break;

      case "Edit":
        await this.recordFileArtifact(
          call.args.file_path as string,
          "output",
          "file",
        );
        break;

      case "Bash":
        await this.extractBashArtifacts(
          call.args.command as string,
          resultText,
        );
        break;

      case "NotebookEdit":
        if (call.args.notebook_path) {
          await this.recordFileArtifact(
            call.args.notebook_path as string,
            "output",
            "document",
          );
        }
        break;
    }
  }

  private async recordFileArtifact(
    filePath: string,
    role: ArtifactRole,
    kind: ArtifactKind,
  ): Promise<void> {
    if (!filePath) return;
    // Reject path traversal attempts
    if (filePath.includes("..")) return;
    // Deduplicate — only record each path once per run
    if (this.recordedPaths.has(filePath)) return;
    this.recordedPaths.add(filePath);

    const ref: RunArtifactRef = {
      artifactRefId: nanoid(12),
      runId: this.config.runId,
      kind,
      title: extractFileName(filePath),
      locator: filePath,
      role,
      version: null,
      metadata: {},
    };

    await this.config.store.appendArtifactRef(ref);
  }

  /**
   * Extract artifact refs from Bash commands.
   * Only track commands that clearly produce files.
   */
  private async extractBashArtifacts(
    command: string,
    _resultText?: string,
  ): Promise<void> {
    if (!command) return;
    const trimmed = command.trim();

    // git commit — the commit itself is an artifact
    if (/^git\s+commit\b/.test(trimmed)) {
      const ref: RunArtifactRef = {
        artifactRefId: nanoid(12),
        runId: this.config.runId,
        kind: "resource",
        title: "git commit",
        locator: "git:HEAD",
        role: "output",
        version: null,
        metadata: { command: trimmed.slice(0, 200) },
      };
      await this.config.store.appendArtifactRef(ref);
      return;
    }

    // Redirect output: command > file or command >> file
    const redirectMatch = trimmed.match(/>\s*(\S+)\s*$/);
    if (redirectMatch) {
      await this.recordFileArtifact(redirectMatch[1], "output", "file");
      return;
    }

    // cp / mv — destination is an artifact
    const cpMvMatch = trimmed.match(/^(?:cp|mv)\s+.*\s+(\S+)\s*$/);
    if (cpMvMatch) {
      await this.recordFileArtifact(cpMvMatch[1], "output", "file");
      return;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function extractFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}
