import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SessionManager,
  sessionsRoot,
  type ContentBlock,
  type SessionProjectBinding,
  type StreamEvent,
  type TerminalReason,
} from "@cjhyy/code-shell-core";
import {
  textWithAttachmentReferences,
  type ExternalRuntimeKind,
  type ExternalRuntimeTurnInput,
} from "@cjhyy/code-shell-capability-coding/external-runtimes";

type RecordedExternalRuntimeTurnInput = ExternalRuntimeTurnInput & { displayText?: string };

const BINDING_FILE = "external-runtime.json";
const MAX_BINDING_BYTES = 64 * 1024;

function canonicalCwd(path: string): string {
  try {
    return resolve(realpathSync(path));
  } catch {
    return resolve(path);
  }
}

export interface ExternalRuntimeBinding {
  version: 1;
  kind: ExternalRuntimeKind;
  model?: string;
  cwd: string;
  runtimeSessionId: string;
  updatedAt: number;
}

function bindingPath(sessionId: string): string {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 128 ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(sessionId)
  ) {
    throw new Error("invalid external session id");
  }
  const root = sessionsRoot();
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("invalid sessions root");
  }
  const rootReal = realpathSync(root);
  const sessionDir = join(root, sessionId);
  const sessionInfo = lstatSync(sessionDir);
  if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) {
    throw new Error("invalid external session directory");
  }
  const sessionReal = realpathSync(sessionDir);
  const rel = relative(rootReal, sessionReal);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("external session directory escapes sessions root");
  }
  const target = join(sessionDir, BINDING_FILE);
  if (existsSync(target)) {
    const fileInfo = lstatSync(target);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new Error("invalid external runtime binding file");
    }
  }
  return target;
}

function readBindingFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_BINDING_BYTES) throw new Error("binding is too large");
    const buffer = Buffer.allocUnsafe(MAX_BINDING_BYTES + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const count = readSync(fd, buffer, total, buffer.byteLength - total, total);
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_BINDING_BYTES) throw new Error("binding is too large");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseBinding(value: unknown): ExternalRuntimeBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    (raw.kind !== "codex" && raw.kind !== "claude-code") ||
    typeof raw.cwd !== "string" ||
    !raw.cwd ||
    raw.cwd.length > 32_768 ||
    raw.cwd.includes("\0") ||
    typeof raw.runtimeSessionId !== "string" ||
    !raw.runtimeSessionId ||
    raw.runtimeSessionId.length > 4_096 ||
    raw.runtimeSessionId.includes("\0") ||
    (raw.model !== undefined &&
      (typeof raw.model !== "string" || raw.model.length > 1_024 || raw.model.includes("\0"))) ||
    typeof raw.updatedAt !== "number" ||
    !Number.isFinite(raw.updatedAt) ||
    raw.updatedAt < 0
  ) {
    return undefined;
  }
  return {
    version: 1,
    kind: raw.kind,
    cwd: raw.cwd,
    runtimeSessionId: raw.runtimeSessionId,
    updatedAt: raw.updatedAt,
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
  };
}

export function readExternalRuntimeBinding(sessionId: string): ExternalRuntimeBinding | undefined {
  try {
    return parseBinding(JSON.parse(readBindingFile(bindingPath(sessionId))) as unknown);
  } catch {
    return undefined;
  }
}

export function writeExternalRuntimeBinding(
  sessionId: string,
  binding: Omit<ExternalRuntimeBinding, "version" | "updatedAt">,
): void {
  const target = bindingPath(sessionId);
  const validated = parseBinding({ version: 1, ...binding, updatedAt: Date.now() });
  if (!validated) throw new Error("invalid external runtime binding");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(validated, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
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
    projectBinding?: SessionProjectBinding,
  ) {
    const bundle = this.manager.exists(sessionId)
      ? this.manager.resume(sessionId)
      : this.manager.create(cwd, model, provider, sessionId, null, "desktop");
    if (canonicalCwd(bundle.state.cwd) !== canonicalCwd(cwd)) {
      throw new Error(`external runtime session project mismatch: ${sessionId}`);
    }
    const persistedProject = bundle.state.project;
    if (persistedProject && !projectBinding) {
      throw new Error(`external runtime session project authority is unavailable: ${sessionId}`);
    }
    if (
      persistedProject &&
      projectBinding &&
      (persistedProject.projectId !== projectBinding.projectId ||
        persistedProject.mainRootId !== projectBinding.mainRootId)
    ) {
      throw new Error(`external runtime session project binding mismatch: ${sessionId}`);
    }
    // External runtimes bypass agent/run, so Desktop must persist the same
    // stable project identity that the native Engine writes on cold start.
    // The resolver is main-owned and exact-root-only; this also safely upgrades
    // older cwd-only external sessions without trusting model/renderer input.
    if (!persistedProject && projectBinding) {
      this.manager.migrateSessionMainRoot(sessionId, projectBinding, cwd);
    }
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

  beginTurn(input: RecordedExternalRuntimeTurnInput): void {
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
      ...(input.displayText ? { displayText: input.displayText } : {}),
      ...(input.injected === true ? { injected: true } : {}),
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

  /** Whether this turn already received (or synthesized) its terminal boundary. */
  get isTurnFinished(): boolean {
    return this.outcome !== undefined;
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
