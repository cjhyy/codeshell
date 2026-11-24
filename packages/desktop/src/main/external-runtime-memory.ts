import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  SettingsManager,
  SessionManager,
  UsageLedger,
  createLLMClient,
  resolveLLMConfigForTag,
  sessionsRoot,
  withUsageOwner,
  type TranscriptEvent,
} from "@cjhyy/code-shell-core";
import {
  MEMORY_CLOSURE_IDLE_MS,
  MemoryOrchestrator,
  auxCachedRequest,
  planMemoryClosure,
  recordExternalModelTrace,
  recordModelTraceEvent,
  withModelTraceContext,
  type MemoryOrchestratorOptions,
} from "@cjhyy/code-shell-core/internal";
import { isFeatureEnabled, type FeatureFlagOverrides } from "@cjhyy/code-shell-core/extension";
import {
  runClaudeTextInference,
  type ExternalRuntimeKind,
} from "@cjhyy/code-shell-capability-coding/external-runtimes";
import { dlog } from "./desktop-logger.js";

type Settings = ReturnType<SettingsManager["get"]>;
export type ExternalMemoryTextRequest = {
  cwd?: string;
  systemPrompt: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
};
type TextResponse = Awaited<ReturnType<typeof runClaudeTextInference>>;

/** A frozen, durable completion; its guard never borrows a later foreground run. */
export interface ExternalMemorySnapshot {
  sessionId: string;
  runId: string;
  cwd: string;
  kind: ExternalRuntimeKind;
  model?: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
  /** The transcript's raw events at the same moment; read by a segment closure. */
  events: ReadonlyArray<TranscriptEvent>;
  assertCurrent(): void;
}

type MemoryJob = { abort: AbortController; done: Promise<void> };
type ExternalMemoryCachePlan = NonNullable<
  Parameters<MemoryOrchestratorOptions["callLLM"]>[2]
>["cache"];
/** External-runtime memory calls are cached apart from core's own memory calls. */
export const EXTERNAL_MEMORY_CACHE_PURPOSE_PREFIX = "external-runtime-";
const MAINTENANCE_TIMEOUT_MS = 180_000;
/**
 * With segment closure turned off, maintenance re-reads the whole transcript
 * window, so it at least waits until the session has been quiet this long; any
 * newer turn restarts the wait.
 */
const DEFAULT_IDLE_DELAY_MS = 5 * 60_000;
/** Skip a rerun until the transcript has grown by this many messages. */
const DEFAULT_MIN_NEW_MESSAGES = 8;

/** Release the queue on cancellation even if an injected transport settles late. */
function untilAborted<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Memory maintenance cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function memorySettingsFingerprint(settings: Settings): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        memories: settings.memories,
        auxiliary: settings.defaults?.auxText,
        connections: settings.modelConnections,
        credentials: settings.credentials,
      }),
    )
    .digest("hex");
}

/** Unlike the bootstrap resolver, an explicit override must never pick another account. */
export function resolveExternalMemoryModel(
  settings: Settings,
):
  | { kind: "current-runtime" }
  | { kind: "api"; config: NonNullable<ReturnType<typeof resolveLLMConfigForTag>> } {
  const key = settings.memories?.extractionModel || settings.defaults?.auxText;
  if (!key) return { kind: "current-runtime" };
  const connections = settings.modelConnections?.filter((entry) => entry.id === key) ?? [];
  const config = resolveLLMConfigForTag(
    { ...settings, modelConnections: connections, defaults: { ...settings.defaults, text: key } },
    "text",
    key,
  );
  if (!config) throw new Error(`Memory model connection is unavailable: ${key}`);
  return { kind: "api", config };
}

/** Per-session latest-snapshot queue, separate from the foreground runtime and tool lease. */
export class ExternalRuntimeMemory {
  private readonly jobs = new Map<string, MemoryJob>();
  /** Debounced snapshots waiting for the session to go quiet. */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Transcript length of each session's last completed maintenance in this process. */
  private readonly processed = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      readSettings?: (cwd: string) => Settings;
      createClient?: typeof createLLMClient;
      infer?: (request: ExternalMemoryTextRequest) => Promise<TextResponse>;
      storageDir?: string;
      /** Test/host seam; the real pipeline still owns all persistence guards. */
      run?: (
        snapshot: ExternalMemorySnapshot,
        signal: AbortSignal,
        assertCurrent: () => void,
      ) => Promise<void>;
      onError?: (snapshot: ExternalMemorySnapshot, error: unknown) => void;
      /** Quiet period before maintenance starts; 0 starts immediately. */
      idleDelayMs?: number;
      minNewMessages?: number;
      /** `settings.featureFlags`; absent leaves every flag at its default. */
      featureFlags?: () => FeatureFlagOverrides | undefined;
      /** Quiet period before a work segment closes; 0 closes immediately. */
      closureIdleMs?: number;
    } = {},
  ) {}

  /**
   * Segment closure (the default): a session's memories are read once its work
   * segment ends, from what follows the session's memory cursor, and only with
   * a model the user picked. Off restores maintenance over the whole window.
   */
  private closureEnabled(): boolean {
    return isFeatureEnabled(this.deps.featureFlags?.(), "memory_segment_closure");
  }

  schedule(snapshot: ExternalMemorySnapshot): void {
    const closure = this.closureEnabled();
    if (!closure) {
      if (snapshot.messages.length < 8) return;
      const last = this.processed.get(snapshot.sessionId);
      const length = snapshot.messages.length;
      // A shorter transcript was rewritten (compaction/restore): treat it as new.
      if (
        last !== undefined &&
        length >= last &&
        length - last < (this.deps.minNewMessages ?? DEFAULT_MIN_NEW_MESSAGES)
      )
        return;
    }
    this.clearPending(snapshot.sessionId);
    // A closure decides what is worth reading when it runs, from the cursor.
    const delay = closure
      ? (this.deps.closureIdleMs ?? MEMORY_CLOSURE_IDLE_MS)
      : (this.deps.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS);
    if (delay <= 0) return this.start(snapshot);
    // A session closed during the wait fails its snapshot guard and is skipped;
    // the next completed turn after it resumes schedules the full transcript.
    const timer = setTimeout(() => {
      if (this.pending.get(snapshot.sessionId) !== timer) return;
      this.pending.delete(snapshot.sessionId);
      this.start(snapshot);
    }, delay);
    timer.unref?.();
    this.pending.set(snapshot.sessionId, timer);
  }

  private clearPending(sessionId: string): void {
    const timer = this.pending.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pending.delete(sessionId);
  }

  private start(snapshot: ExternalMemorySnapshot): void {
    const previous = this.jobs.get(snapshot.sessionId);
    previous?.abort.abort();
    const abort = new AbortController();
    const job: MemoryJob = { abort, done: Promise.resolve() };
    this.jobs.set(snapshot.sessionId, job);
    const assertCurrent = () => {
      abort.signal.throwIfAborted();
      if (this.jobs.get(snapshot.sessionId) !== job)
        throw new Error("Memory maintenance superseded");
      snapshot.assertCurrent();
    };
    job.done = (previous?.done ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const timer = setTimeout(
          () => abort.abort(new Error("Memory maintenance timed out")),
          MAINTENANCE_TIMEOUT_MS,
        );
        timer.unref?.();
        try {
          assertCurrent();
          const operation = Promise.resolve().then(() =>
            this.deps.run
              ? this.deps.run(snapshot, abort.signal, assertCurrent)
              : this.run(snapshot, abort.signal, assertCurrent),
          );
          this.inFlight.add(operation);
          void operation.then(
            () => this.inFlight.delete(operation),
            () => this.inFlight.delete(operation),
          );
          await untilAborted(abort.signal, () => operation);
          this.processed.set(snapshot.sessionId, snapshot.messages.length);
        } catch (error) {
          if (!abort.signal.aborted) {
            withModelTraceContext(
              {
                storageDir: join(this.deps.storageDir ?? sessionsRoot(), ".model-traces"),
                sessionId: snapshot.sessionId,
                runId: snapshot.runId,
                parentSessionId: undefined,
                workspacePath: snapshot.cwd,
                source: "desktop-memory",
                ephemeral: false,
              },
              () =>
                recordModelTraceEvent({
                  traceId: snapshot.runId,
                  sessionId: snapshot.sessionId,
                  runId: snapshot.runId,
                  workspacePath: snapshot.cwd,
                  kind: "lifecycle",
                  name: "Automatic memory maintenance",
                  startedAt: Date.now(),
                  endedAt: Date.now(),
                  status: "failed",
                  error: error instanceof Error ? error.message : "Memory maintenance failed",
                }),
            );
            try {
              if (this.deps.onError) this.deps.onError(snapshot, error);
              else
                dlog("external-runtime", "memory.failed", {
                  sessionId: snapshot.sessionId,
                  error: String(error),
                });
            } catch {
              /* Reporting must not orphan the maintenance queue. */
            }
          }
        } finally {
          clearTimeout(timer);
          if (this.jobs.get(snapshot.sessionId) === job) this.jobs.delete(snapshot.sessionId);
        }
      });
  }

  cancel(sessionId: string): void {
    this.clearPending(sessionId);
    this.jobs.get(sessionId)?.abort.abort();
  }

  async idle(sessionId: string): Promise<void> {
    await this.jobs.get(sessionId)?.done;
  }

  async dispose(): Promise<void> {
    for (const sessionId of [...this.pending.keys()]) this.clearPending(sessionId);
    for (const job of this.jobs.values()) job.abort.abort();
    await Promise.all([...this.jobs.values()].map((job) => job.done));
    // Cancellation releases the queue first, but process-group cleanup still
    // needs time to finish before Electron exits. A broken transport is bounded.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(
    snapshot: ExternalMemorySnapshot,
    signal: AbortSignal,
    assertOwner: () => void,
  ): Promise<void> {
    const readSettings =
      this.deps.readSettings ?? ((cwd: string) => new SettingsManager(cwd, "full").get());
    const settings = readSettings(snapshot.cwd);
    const fingerprint = memorySettingsFingerprint(settings);
    const assertCurrent = () => {
      assertOwner();
      if (memorySettingsFingerprint(readSettings(snapshot.cwd)) !== fingerprint)
        throw new Error("Memory model settings changed");
    };
    assertCurrent();
    const selected = resolveExternalMemoryModel(settings);
    const closure = this.closureEnabled();
    if (closure && selected.kind === "current-runtime") {
      // Only a model the user picked reads an external session for memories;
      // the session's own model is never borrowed for it. The cursor stays
      // put, so the stretch is read once a model is selected.
      dlog("external-runtime", "memory.closure", {
        sessionId: snapshot.sessionId,
        skipped: "no-model",
      });
      return;
    }
    if (selected.kind === "current-runtime" && snapshot.kind === "codex") {
      throw new Error(
        "Codex CLI does not expose a verified tool-free memory request. Select an API background or extraction model explicitly; the current API default was not used.",
      );
    }
    const storage = this.deps.storageDir ?? sessionsRoot();
    const ledger = new UsageLedger({ storageDir: join(storage, ".usage-ledger") });
    const sessions = new SessionManager(storage);
    const state = sessions.readSessionState(snapshot.sessionId);
    if (!state || !ledger.adoptSession(snapshot.sessionId, state.costState, storage))
      throw new Error("Memory accounting owner is unavailable");
    const plan = closure ? planMemoryClosure(snapshot.events, state.memoryCursor) : undefined;
    const window = plan?.window;
    if (plan && !plan.run) {
      dlog("external-runtime", "memory.closure", {
        sessionId: snapshot.sessionId,
        skipped: plan.reason,
        freshCount: plan.window.fresh.length,
        humanCount: plan.window.humanCount,
      });
      return;
    }
    const transcript = plan?.run ? plan.transcript : [...snapshot.messages];
    const client =
      selected.kind === "api"
        ? await (this.deps.createClient ?? createLLMClient)(selected.config, {
            retryMaxAttempts: 1,
            timeout: 60_000,
          })
        : undefined;
    assertCurrent();
    const callLLM = async (
      systemPrompt: string,
      userMessage: string,
      options?: { maxTokens: number; cache?: ExternalMemoryCachePlan },
    ) => {
      assertCurrent();
      if (client) {
        const response = await client.createMessage({
          systemPrompt,
          // Same segmented, cacheable request as core's memory pipeline, in a
          // scope of its own: this session's main conversation and core's own
          // memory calls never share these prefixes.
          ...auxCachedRequest({
            client,
            sessionId: snapshot.sessionId,
            prompt: userMessage,
            plan: options?.cache && {
              ...options.cache,
              purpose: `${EXTERNAL_MEMORY_CACHE_PURPOSE_PREFIX}${options.cache.purpose}`,
            },
          }),
          tools: [],
          maxTokens: options?.maxTokens ?? 1024,
          signal,
          billingEnabled: true,
          requestVisible: false,
          usagePurpose: "aux_summary",
          reasoning: { mode: "off" },
        });
        assertCurrent();
        if (response.stopReason === "length" || response.stopReason === "max_tokens")
          throw new Error("Memory response exceeded its output token budget");
        return response.text;
      }
      const startedAt = Date.now();
      const common = {
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        traceId: snapshot.runId,
        workspacePath: snapshot.cwd,
        provider: "claude",
        model: snapshot.model ?? "CLI default",
        source: "desktop-memory",
        purpose: "aux_summary",
        startedAt,
        coverage: "external-cli-input" as const,
      };
      const trace = recordExternalModelTrace({
        ...common,
        status: "running",
        input: { systemPrompt, messages: [{ role: "user", content: userMessage }], tools: [] },
      });
      const requestId = randomUUID();
      const owner = ledger.owner(snapshot.sessionId, snapshot.runId, [], "aux_summary", storage);
      const receiptInput = {
        source: "external-cli-memory",
        requestId,
        provider: "claude",
        model: snapshot.model ?? "CLI default",
      };
      let billed = false;
      try {
        const response = await (this.deps.infer ?? runClaudeTextInference)({
          cwd: snapshot.cwd,
          systemPrompt,
          userMessage,
          model: snapshot.model,
          maxTokens: options?.maxTokens ?? 1024,
          signal,
        });
        ledger.recordExternal(owner, { ...receiptInput, usage: response.usage });
        billed = true;
        assertCurrent();
        if (response.stopReason === "length" || response.stopReason === "max_tokens")
          throw new Error("Memory response exceeded its output token budget");
        if (trace)
          recordExternalModelTrace({
            ...common,
            id: trace.id,
            status: "completed",
            endedAt: Date.now(),
            output: { text: response.text, stopReason: response.stopReason },
            usage: response.usage,
          });
        ledger.noteHistoricalGap(snapshot.sessionId, storage);
        return response.text;
      } catch (error) {
        if (!billed) ledger.finish(ledger.recordExternal(owner, receiptInput), "failed");
        if (trace)
          recordExternalModelTrace({
            ...common,
            id: trace.id,
            status: signal.aborted ? "cancelled" : "failed",
            endedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    };
    const result = await withModelTraceContext(
      {
        storageDir: join(storage, ".model-traces"),
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        parentSessionId: undefined,
        workspacePath: snapshot.cwd,
        source: "desktop-memory",
        purpose: "aux_summary",
        ephemeral: false,
      },
      () =>
        withUsageOwner(
          ledger.owner(snapshot.sessionId, snapshot.runId, [], "aux_summary", storage),
          () =>
            new MemoryOrchestrator({
              projectDir: snapshot.cwd,
              baseDir: dirname(storage),
              autoExtract: settings.memories?.autoExtract,
              maxCount: settings.memories?.maxCount,
              assertCurrent,
              callLLM,
            }).run(transcript, snapshot.sessionId),
        ),
    );
    if (!window) return;
    // A failed extraction keeps the cursor, so the next closure reads the same stretch.
    if (result.completed && window.through) {
      assertCurrent();
      sessions.updateSessionState(snapshot.sessionId, {
        memoryCursor: { v: 1, ...window.through, closedAt: Date.now() },
      });
    }
    dlog("external-runtime", "memory.closure", {
      sessionId: snapshot.sessionId,
      anchor: window.anchor,
      freshCount: window.fresh.length,
      humanCount: window.humanCount,
      extracted: result.extracted,
      changed: result.changed,
      completed: result.completed,
    });
  }
}
