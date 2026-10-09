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
import { SessionOutputJournal, outputUserMessage } from "@cjhyy/code-shell-core/internal";
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
  private readonly directoryIdentity: { dev: number; ino: number };
  private readonly cwd: string;
  private readonly startedAt: number;
  private readonly accountingSessionId: string | undefined;
  private journal: SessionOutputJournal | undefined;
  private runId: string | undefined;
  private runClosed = true;
  private persistenceFailed = false;
  private boundaryId: string | undefined;

  private textBuffer = "";
  private finalText = "";
  private pendingToolBlocks: ContentBlock[] = [];
  /**
   * Tool calls opened but not yet written to the append-only transcript, keyed
   * by tool call id. Held until the arguments settle (a tool_use_args_delta, or
   * the tool resolving) so the persisted record carries the real input rather
   * than the runtime's empty opening snapshot.
   */
  private readonly deferredToolUses = new Map<
    string,
    { toolName: string; args: Record<string, unknown>; block: ContentBlock }
  >();
  private readonly unresolvedTools = new Map<string, string>();
  private usage: UsageSnapshot = {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  private usageAtTurnStart: UsageSnapshot = { ...this.usage };
  private providerCumulative: Partial<UsageSnapshot> = {};
  private providerBaseline: Partial<UsageSnapshot> = {};
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
    this.cwd = bundle.state.cwd;
    this.startedAt = bundle.state.startedAt;
    this.accountingSessionId = bundle.state.costState?.accountingSessionId;
    this.manager.registerSessionGeneration(sessionId);
    const directory = lstatSync(join(this.manager.getStorageDir(), sessionId));
    this.directoryIdentity = { dev: directory.dev, ino: directory.ino };
    const sameModel = bundle.state.model === model && bundle.state.provider === provider;
    if (!sameModel) {
      this.manager.updateSessionState(this.sessionId, {
        model,
        provider,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
    }
  }

  assertNewSubmission(input: RecordedExternalRuntimeTurnInput): void {
    if (input.clientMessageId && this.transcript.hasClientMessageId(input.clientMessageId))
      throw new Error(
        "External submission clientMessageId was already recorded; refusing to repeat it",
      );
  }

  recordControlOutput(event: StreamEvent): StreamEvent {
    if (this.runClosed) throw new Error("Session output run is closed");
    return this.appendOutput(event);
  }

  beginTurn(input: RecordedExternalRuntimeTurnInput, continueRun = false): StreamEvent {
    this.assertNewSubmission(input);
    this.assertOwner(continueRun);
    if (this.persistenceFailed) throw new Error("Session output recovery is incomplete");
    this.textBuffer = "";
    this.finalText = "";
    this.pendingToolBlocks = [];
    this.unresolvedTools.clear();
    this.usageAtTurnStart = { ...this.usage };
    this.providerBaseline = { ...this.providerCumulative };
    this.contextAnchorPromptTokens = 0;
    this.lastError = undefined;
    this.outcome = undefined;
    const persistedText = textWithAttachmentReferences(input);
    const user = this.transcript.appendMessage("user", persistedText, {
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      ...(input.displayText ? { displayText: input.displayText } : {}),
      ...(input.injected === true ? { injected: true } : {}),
    });
    if (!continueRun) {
      const state = this.manager.readSessionState(this.sessionId);
      if (!state) throw new Error("Session no longer exists");
      this.runId = user.id;
      this.runClosed = false;
      this.manager.startSessionRun(state, user.id, input.clientMessageId);
    }
    // A failed user write must stop the physical CLI request, even though the
    // ordinary Transcript append API deliberately reports failures as sticky state.
    this.transcript.sync();
    this.manager.updateSessionRunState(this.sessionId, this.runId!, (state) => ({
      status: "active",
      model: this.model,
      provider: this.provider,
      lastCompletionKind: undefined,
      ...(!state.summary && input.text.trim()
        ? { summary: input.text.trim().replace(/\s+/g, " ").slice(0, 200) }
        : {}),
    }));
    if (!continueRun) {
      const events = this.transcript.getEvents();
      const index = events.findIndex((event) => event.id === user.id);
      this.journal = new SessionOutputJournal(
        this.manager.getStorageDir(),
        this.sessionId,
        this.runId!,
        index > 0 ? events[index - 1].id : undefined,
      );
    }
    return this.appendOutput(outputUserMessage(user.data, this.sessionId, this.cwd));
  }

  get isCurrentOutputOwner(): boolean {
    try {
      this.assertOwner(true, true);
      return true;
    } catch {
      return false;
    }
  }

  startEvent(): StreamEvent {
    return this.appendOutput({
      type: "session_started",
      sessionId: this.sessionId,
      runId: this.runId,
      promptTokens: 0,
    });
  }

  get outputFailed(): boolean {
    return this.persistenceFailed;
  }
  get outputRunId(): string | undefined {
    return this.runId;
  }

  get hasOpenRun(): boolean {
    return !!this.runId && !this.runClosed && this.isCurrentOutputOwner;
  }

  /** Sticky even when a CLI adapter catches its consumer's callback exception. */
  failOutput(): ExternalRuntimeTurnOutcome {
    this.persistenceFailed = true;
    this.runClosed = true;
    this.outcome = {
      ok: false,
      reason: "model_error",
      streamed: true,
      text: "Session output recovery is incomplete; no further CLI request was started.",
    };
    try {
      // The journal may already have persisted its sticky barrier before its
      // exception reached us. Its actual owner must still publish failed status.
      this.assertOwner(true, true);
      this.manager.updateSessionState(
        this.sessionId,
        {
          status: "model_error",
          outputRecoveryIncomplete: true,
        },
        this.runId,
      );
    } catch {
      /* A stale owner or unavailable disk cannot weaken the live fence. */
    }
    return this.outcome;
  }

  private assertOwner(requireRun = true, allowIncomplete = false): void {
    if (!this.manager.isSessionGenerationCurrent(this.sessionId))
      throw new Error("Session output owner was closed");
    const directory = lstatSync(join(this.manager.getStorageDir(), this.sessionId));
    const state = this.manager.readSessionState(this.sessionId);
    if (
      directory.isSymbolicLink() ||
      directory.dev !== this.directoryIdentity.dev ||
      directory.ino !== this.directoryIdentity.ino ||
      !state ||
      state.sessionId !== this.sessionId ||
      state.startedAt !== this.startedAt ||
      (this.accountingSessionId !== undefined &&
        state.costState?.accountingSessionId !== this.accountingSessionId) ||
      (requireRun && (!this.runId || state.runId !== this.runId))
    )
      throw new Error("Session output owner was superseded or deleted");
    if (state.outputRecoveryIncomplete && !allowIncomplete)
      throw new Error("Session output recovery is incomplete");
  }

  private appendOutput(event: StreamEvent): StreamEvent {
    this.assertOwner();
    if (this.persistenceFailed || !this.journal)
      throw new Error("Session output recovery is incomplete");
    if (this.transcript.flushFailed()) throw new Error("Transcript persistence is incomplete");
    if (event.type === "session_started") event = { ...event, runId: this.runId };
    return { ...event, outputCursor: this.journal.append(event) };
  }

  /** One terminal for the whole logical submission, including Goal continuations. */
  completeRun(reason: TerminalReason): StreamEvent | undefined {
    if (this.runClosed) return undefined;
    this.assertOwner();
    this.manager.updateSessionState(
      this.sessionId,
      {
        status: reason,
        ...(reason === "completed" && this.boundaryId
          ? { completedSnapshotVersion: 1, completedThroughEventId: this.boundaryId }
          : {}),
      },
      this.runId,
    );
    const event = this.appendOutput({ type: "turn_complete", reason });
    this.runClosed = true;
    this.outcome = { ...this.outcome, ok: reason === "completed", reason, streamed: true };
    return event;
  }

  onEvent(event: StreamEvent, providerTerminalOnly = false): StreamEvent | undefined {
    if (!this.runId && event.type === "session_started") return event;
    this.assertOwner();
    if (this.persistenceFailed) throw new Error("Session output recovery is incomplete");
    if (this.outcome || this.runClosed) return undefined;
    switch (event.type) {
      case "text_delta":
        // Assistant prose after a tool call closes that call's block, so settle
        // any held tool_use first to keep transcript order faithful.
        this.commitAllDeferredToolUses();
        this.flushToolUseMessage();
        this.textBuffer += event.text;
        this.finalText += event.text;
        break;
      case "tool_use_start": {
        this.flushAssistantText();
        // Do NOT write the transcript record yet. Both external runtimes open a
        // tool before its arguments are known (codex reports `query: ""` on
        // item/started; claude-code opens with `{}` and streams the input as a
        // later tool_use_args_delta). The transcript is append-only, so a record
        // written now cannot be corrected — persisting it here is what produced
        // unauditable `webSearch {"query": ""}` / `Bash {}` history. Hold the
        // opening args and commit once they settle.
        const block: ContentBlock = {
          type: "tool_use",
          id: event.toolCall.id,
          name: event.toolCall.toolName,
          input: event.toolCall.args,
        };
        this.pendingToolBlocks.push(block);
        this.deferredToolUses.set(event.toolCall.id, {
          toolName: event.toolCall.toolName,
          args: event.toolCall.args,
          block,
        });
        this.unresolvedTools.set(event.toolCall.id, event.toolCall.toolName);
        break;
      }
      case "tool_use_args_delta": {
        // The runtime now knows the real input. Overwrite the held args and the
        // assistant block that a resumed turn replays back to the model.
        const deferred = this.deferredToolUses.get(event.toolCallId);
        if (deferred) {
          deferred.args = event.args;
          deferred.block.input = event.args;
        }
        break;
      }
      case "tool_result":
        this.commitDeferredToolUse(event.result.id);
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
      case "usage_update": {
        // Provider totals belong to its thread, not Session aggregate accounting
        // (which can include another producer or auxiliary requests). A cold
        // resume's first total-last establishes only that provider's old history.
        const count = (value: number | undefined) =>
          value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
        const update = (key: keyof UsageSnapshot, last?: number, total?: number, turn?: number) => {
          last = count(last);
          total = count(total);
          turn = count(turn);
          let own: number;
          if (turn !== undefined) {
            own = this.usageAtTurnStart[key] + turn;
          } else if (total !== undefined) {
            const first = this.usage[key] === this.usageAtTurnStart[key];
            if (
              first &&
              this.providerBaseline[key] !== undefined &&
              total < this.providerBaseline[key]!
            ) {
              this.providerBaseline[key] = 0;
              this.providerCumulative[key] = 0;
            }
            this.providerBaseline[key] ??= Math.max(0, total - (last ?? 0));
            own = this.usageAtTurnStart[key] + Math.max(0, total - this.providerBaseline[key]!);
          } else {
            own = this.usage[key] + (last ?? 0);
          }
          this.usage[key] = Math.max(this.usage[key], own);
          if (total !== undefined)
            this.providerCumulative[key] = Math.max(this.providerCumulative[key] ?? 0, total);
        };
        update(
          "promptTokens",
          event.promptTokens,
          event.cumulativePromptTokens,
          event.singleTurnPromptTokens,
        );
        update(
          "completionTokens",
          event.completionTokens,
          event.cumulativeCompletionTokens,
          // A partial provider notification with a per-turn prompt snapshot
          // also has only a completion snapshot, not a new request identity.
          event.cumulativeCompletionTokens === undefined &&
            event.singleTurnPromptTokens !== undefined
            ? event.completionTokens
            : undefined,
        );
        update(
          "cacheReadTokens",
          event.cacheReadTokens,
          event.cumulativeCacheReadTokens,
          event.singleTurnCacheReadTokens,
        );
        update(
          "cacheCreationTokens",
          event.cacheCreationTokens,
          event.cumulativeCacheCreationTokens,
          event.singleTurnCacheCreationTokens,
        );
        this.contextAnchorPromptTokens = event.promptTokens;
        break;
      }
      case "error":
        this.lastError = event.error;
        this.transcript.appendError(event.error, { source: "external-runtime" });
        break;
      case "turn_complete":
        this.finish(event.reason, !providerTerminalOnly);
        break;
    }
    if (event.type === "turn_complete" && providerTerminalOnly) return undefined;
    const published = this.appendOutput(event);
    if (event.type === "turn_complete") this.runClosed = true;
    return published;
  }

  finishIfMissing(): ExternalRuntimeTurnOutcome {
    if (!this.outcome)
      this.onEvent({ type: "turn_complete", reason: this.lastError ? "model_error" : "completed" });
    return this.outcome!;
  }

  /** Whether this turn already received (or synthesized) its terminal boundary. */
  get isTurnFinished(): boolean {
    return this.outcome !== undefined;
  }

  /** Provider usage for this turn, also available before its terminal event. */
  get turnTokensUsed(): number {
    return (
      Math.max(0, this.usage.promptTokens - this.usageAtTurnStart.promptTokens) +
      Math.max(0, this.usage.completionTokens - this.usageAtTurnStart.completionTokens)
    );
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

  /**
   * Write one held tool_use record with its settled arguments. Idempotent, so a
   * tool that both streams args and resolves is recorded exactly once.
   */
  private commitDeferredToolUse(toolCallId: string): void {
    const deferred = this.deferredToolUses.get(toolCallId);
    if (!deferred) return;
    this.deferredToolUses.delete(toolCallId);
    this.transcript.appendToolUse(deferred.toolName, toolCallId, deferred.args);
  }

  /**
   * Commit every still-held tool call, in open order. A turn can end while a
   * tool is unresolved (interrupt, crash, a runtime that never reports a
   * result); those calls must still appear in history rather than vanish.
   */
  private commitAllDeferredToolUses(): void {
    for (const toolCallId of [...this.deferredToolUses.keys()]) {
      this.commitDeferredToolUse(toolCallId);
    }
  }

  private finish(reason: TerminalReason, terminalRun: boolean): void {
    if (this.outcome) return;
    this.flushAssistantText();
    // Before the synthetic results below: a tool_use record must precede its
    // tool_result in the transcript.
    this.commitAllDeferredToolUses();
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
    this.transcript.sync();
    this.boundaryId = boundary.id;
    const promptTokens = this.usage.promptTokens;
    const completionTokens = this.usage.completionTokens;
    const turnPromptTokens = Math.max(0, promptTokens - this.usageAtTurnStart.promptTokens);
    const turnCompletionTokens = Math.max(
      0,
      completionTokens - this.usageAtTurnStart.completionTokens,
    );
    const turnCacheReadTokens = Math.max(
      0,
      this.usage.cacheReadTokens - this.usageAtTurnStart.cacheReadTokens,
    );
    const turnCacheCreationTokens = Math.max(
      0,
      this.usage.cacheCreationTokens - this.usageAtTurnStart.cacheCreationTokens,
    );
    this.manager.updateSessionRunState(this.sessionId, this.runId!, (state) => ({
      status: terminalRun ? reason : "active",
      turnCount: (state.turnCount ?? 0) + 1,
      tokenUsage: {
        promptTokens: state.tokenUsage.promptTokens + turnPromptTokens,
        completionTokens: state.tokenUsage.completionTokens + turnCompletionTokens,
        totalTokens: state.tokenUsage.totalTokens + turnPromptTokens + turnCompletionTokens,
        cacheReadTokens: (state.tokenUsage.cacheReadTokens ?? 0) + turnCacheReadTokens,
        cacheCreationTokens: (state.tokenUsage.cacheCreationTokens ?? 0) + turnCacheCreationTokens,
      },
      cumulativePromptTokens:
        (state.cumulativePromptTokens ?? state.tokenUsage.promptTokens) + turnPromptTokens,
      cumulativeCacheReadTokens:
        (state.cumulativeCacheReadTokens ?? state.tokenUsage.cacheReadTokens ?? 0) +
        turnCacheReadTokens,
      cumulativeCacheCreationTokens:
        (state.cumulativeCacheCreationTokens ?? state.tokenUsage.cacheCreationTokens ?? 0) +
        turnCacheCreationTokens,
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
      ...(terminalRun && reason === "completed"
        ? { completedSnapshotVersion: 1, completedThroughEventId: boundary.id }
        : {}),
    }));
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
