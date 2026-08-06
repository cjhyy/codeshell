import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SessionManager,
  sessionsRoot,
  type ContentBlock,
  type StreamEvent,
  type TerminalReason,
} from "@cjhyy/code-shell-core";
import {
  textWithAttachmentReferences,
  type ExternalRuntimeKind,
  type ExternalRuntimeTurnInput,
} from "@cjhyy/code-shell-capability-coding/external-runtimes";

const BINDING_FILE = "external-runtime.json";

export interface ExternalRuntimeBinding {
  version: 1;
  kind: ExternalRuntimeKind;
  model?: string;
  cwd: string;
  runtimeSessionId: string;
  updatedAt: number;
}

function bindingPath(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error("invalid external session id");
  return join(sessionsRoot(), sessionId, BINDING_FILE);
}

export function readExternalRuntimeBinding(sessionId: string): ExternalRuntimeBinding | undefined {
  try {
    const value = JSON.parse(
      readFileSync(bindingPath(sessionId), "utf8"),
    ) as Partial<ExternalRuntimeBinding>;
    if (
      value.version !== 1 ||
      (value.kind !== "codex" && value.kind !== "claude-code") ||
      typeof value.cwd !== "string" ||
      typeof value.runtimeSessionId !== "string" ||
      !value.runtimeSessionId
    ) {
      return undefined;
    }
    return value as ExternalRuntimeBinding;
  } catch {
    return undefined;
  }
}

export function writeExternalRuntimeBinding(
  sessionId: string,
  binding: Omit<ExternalRuntimeBinding, "version" | "updatedAt">,
): void {
  const target = bindingPath(sessionId);
  if (!existsSync(join(sessionsRoot(), sessionId))) return;
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({ version: 1, ...binding, updatedAt: Date.now() }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporary, target);
}

export function removeExternalRuntimeBinding(sessionId: string): void {
  try {
    rmSync(bindingPath(sessionId), { force: true });
  } catch {
    // Deletion of the canonical Session still proceeds; this sidecar is best effort.
  }
}

interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ExternalRuntimeTurnOutcome {
  ok: boolean;
  reason: TerminalReason;
  text?: string;
  /** The terminal/error events were already delivered to the shared stream. */
  streamed: true;
}

/**
 * Persists an externally-driven turn into the same transcript/state files the
 * native Engine owns, so replay, switching backends and app restart all see one
 * canonical conversation instead of a renderer-only shadow.
 */
export class ExternalRuntimeSessionRecorder {
  private readonly manager = new SessionManager();
  private readonly transcript;
  private textBuffer = "";
  private finalText = "";
  private pendingToolBlocks: ContentBlock[] = [];
  private readonly unresolvedTools = new Map<string, string>();
  private usage: UsageSnapshot = {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  private usageAtTurnStart: UsageSnapshot = { ...this.usage };
  private contextAnchorPromptTokens = 0;
  private lastError: string | undefined;
  private outcome: ExternalRuntimeTurnOutcome | undefined;

  constructor(
    private readonly sessionId: string,
    cwd: string,
    private readonly model: string,
    private readonly provider: ExternalRuntimeKind,
  ) {
    const bundle = this.manager.exists(sessionId)
      ? this.manager.resume(sessionId)
      : this.manager.create(cwd, model, provider, sessionId, null, "desktop");
    this.transcript = bundle.transcript;
    const sameModel = bundle.state.model === model && bundle.state.provider === provider;
    this.usage = sameModel
      ? {
          promptTokens: bundle.state.tokenUsage.promptTokens ?? 0,
          completionTokens: bundle.state.tokenUsage.completionTokens ?? 0,
          cacheReadTokens: bundle.state.tokenUsage.cacheReadTokens ?? 0,
          cacheCreationTokens: bundle.state.tokenUsage.cacheCreationTokens ?? 0,
        }
      : { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    this.usageAtTurnStart = { ...this.usage };
    if (!sameModel) {
      this.manager.updateSessionState(this.sessionId, {
        model,
        provider,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
    }
  }

  beginTurn(input: ExternalRuntimeTurnInput): void {
    this.textBuffer = "";
    this.finalText = "";
    this.pendingToolBlocks = [];
    this.unresolvedTools.clear();
    this.usageAtTurnStart = { ...this.usage };
    this.contextAnchorPromptTokens = 0;
    this.lastError = undefined;
    this.outcome = undefined;
    const persistedText = textWithAttachmentReferences(input);
    this.transcript.appendMessage("user", persistedText, {
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    });
    const state = this.manager.readSessionState(this.sessionId);
    this.manager.updateSessionState(this.sessionId, {
      status: "active",
      model: this.model,
      provider: this.provider,
      lastCompletionKind: undefined,
      ...(!state?.summary && input.text.trim()
        ? { summary: input.text.trim().replace(/\s+/g, " ").slice(0, 200) }
        : {}),
    });
  }

  onEvent(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        this.flushToolUseMessage();
        this.textBuffer += event.text;
        this.finalText += event.text;
        break;
      case "tool_use_start":
        this.flushAssistantText();
        this.transcript.appendToolUse(
          event.toolCall.toolName,
          event.toolCall.id,
          event.toolCall.args,
        );
        this.pendingToolBlocks.push({
          type: "tool_use",
          id: event.toolCall.id,
          name: event.toolCall.toolName,
          input: event.toolCall.args,
        });
        this.unresolvedTools.set(event.toolCall.id, event.toolCall.toolName);
        break;
      case "tool_result":
        this.flushToolUseMessage();
        this.transcript.appendToolResult(
          event.result.id,
          event.result.toolName,
          event.result.result,
          event.result.error,
          event.result.contentBlocks,
        );
        this.unresolvedTools.delete(event.result.id);
        break;
      case "usage_update":
        if (
          event.cumulativePromptTokens !== undefined &&
          event.cumulativePromptTokens < this.usageAtTurnStart.promptTokens
        ) {
          this.usageAtTurnStart.promptTokens = 0;
        }
        if (
          event.cumulativeCompletionTokens !== undefined &&
          event.cumulativeCompletionTokens < this.usageAtTurnStart.completionTokens
        ) {
          this.usageAtTurnStart.completionTokens = 0;
        }
        if (
          event.cumulativeCacheReadTokens !== undefined &&
          event.cumulativeCacheReadTokens < this.usageAtTurnStart.cacheReadTokens
        ) {
          this.usageAtTurnStart.cacheReadTokens = 0;
        }
        if (
          event.cumulativeCacheCreationTokens !== undefined &&
          event.cumulativeCacheCreationTokens < this.usageAtTurnStart.cacheCreationTokens
        ) {
          this.usageAtTurnStart.cacheCreationTokens = 0;
        }
        this.usage = {
          promptTokens:
            event.cumulativePromptTokens ?? this.usage.promptTokens + event.promptTokens,
          completionTokens:
            event.cumulativeCompletionTokens ??
            this.usage.completionTokens + (event.completionTokens ?? 0),
          cacheReadTokens:
            event.cumulativeCacheReadTokens ??
            this.usage.cacheReadTokens + (event.cacheReadTokens ?? 0),
          cacheCreationTokens:
            event.cumulativeCacheCreationTokens ??
            this.usage.cacheCreationTokens + (event.cacheCreationTokens ?? 0),
        };
        this.contextAnchorPromptTokens = event.promptTokens;
        break;
      case "error":
        this.lastError = event.error;
        this.transcript.appendError(event.error, { source: "external-runtime" });
        break;
      case "turn_complete":
        this.finish(event.reason);
        break;
    }
  }

  finishIfMissing(): ExternalRuntimeTurnOutcome {
    if (!this.outcome) this.finish(this.lastError ? "model_error" : "completed");
    return this.outcome!;
  }

  private flushAssistantText(): void {
    if (!this.textBuffer) return;
    this.transcript.appendMessage("assistant", this.textBuffer);
    this.textBuffer = "";
  }

  private flushToolUseMessage(): void {
    if (this.pendingToolBlocks.length === 0) return;
    this.transcript.appendMessage("assistant", this.pendingToolBlocks);
    this.pendingToolBlocks = [];
  }

  private finish(reason: TerminalReason): void {
    if (this.outcome) return;
    this.flushAssistantText();
    this.flushToolUseMessage();
    for (const [toolCallId, toolName] of this.unresolvedTools) {
      this.transcript.appendToolResult(
        toolCallId,
        toolName,
        undefined,
        "External runtime turn ended before this tool returned a result.",
      );
    }
    this.unresolvedTools.clear();
    const boundary = this.transcript.appendTurnBoundary();
    const state = this.manager.readSessionState(this.sessionId);
    const promptTokens = this.usage.promptTokens;
    const completionTokens = this.usage.completionTokens;
    const turnPromptTokens = Math.max(0, promptTokens - this.usageAtTurnStart.promptTokens);
    const turnCacheReadTokens = Math.max(
      0,
      this.usage.cacheReadTokens - this.usageAtTurnStart.cacheReadTokens,
    );
    const turnCacheCreationTokens = Math.max(
      0,
      this.usage.cacheCreationTokens - this.usageAtTurnStart.cacheCreationTokens,
    );
    this.manager.updateSessionState(this.sessionId, {
      status: reason,
      turnCount: (state?.turnCount ?? 0) + 1,
      turnSeq: (state?.turnSeq ?? 0) + 1,
      tokenUsage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        cacheReadTokens: this.usage.cacheReadTokens,
        cacheCreationTokens: this.usage.cacheCreationTokens,
      },
      cumulativePromptTokens: (state?.cumulativePromptTokens ?? 0) + turnPromptTokens,
      cumulativeCacheReadTokens: (state?.cumulativeCacheReadTokens ?? 0) + turnCacheReadTokens,
      cumulativeCacheCreationTokens:
        (state?.cumulativeCacheCreationTokens ?? 0) + turnCacheCreationTokens,
      ...(this.contextAnchorPromptTokens > 0
        ? {
            contextUsageAnchor: {
              promptTokens: this.contextAnchorPromptTokens,
              messageCount: this.transcript.toMessages().length,
              recordedAt: Date.now(),
              provider: this.provider,
              model: this.model,
            },
          }
        : {}),
      ...(reason === "completed"
        ? { completedSnapshotVersion: 1, completedThroughEventId: boundary.id }
        : {}),
    });
    this.outcome = {
      ok: reason === "completed",
      reason,
      streamed: true,
      ...(this.lastError
        ? { text: this.lastError }
        : this.finalText
          ? { text: this.finalText }
          : {}),
    };
  }
}
