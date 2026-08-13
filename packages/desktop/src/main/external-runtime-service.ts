/**
 * Desktop wiring for external Agent Runtimes (Codex / Claude Code).
 *
 * Desktop main is the composition root the design calls for (§7.4): it is the only
 * layer that knows the window that owns a session, whether the project is trusted,
 * and which feature flags are on. Everything security-relevant is resolved HERE
 * and passed down explicitly — the layers below deliberately refuse to default it.
 *
 * Two host-side obligations that only Desktop can meet:
 *
 *  1. **Owner claim.** `Panel.invoke` refuses to broadcast, so a session with no
 *     owning renderer window cannot invoke a Panel App tool at all. An external
 *     runtime's turns never pass through `agent/run`, so nothing claims an owner
 *     implicitly — this service claims it explicitly (§9.3.2).
 *  2. **Trust.** `permissions` is the first `DANGEROUS_PROJECT_FIELD`; an
 *     untrusted project's rules must be stripped. Desktop owns the trust store,
 *     so it resolves the real value rather than letting a default decide.
 */
import type { BrowserWindow } from "electron";
import { startExternalRuntimeSession } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import type {
  ExternalRuntimeTurnInput,
  ExternalRuntimeKind,
  ExternalRuntimeSession,
} from "@cjhyy/code-shell-capability-coding/external-runtimes";
import { CODING_TOOLS } from "@cjhyy/code-shell-capability-coding/capability";
import {
  BUILTIN_AGENT_PRESETS,
  BUILTIN_TOOLS,
  ToolRegistry,
  type PermissionMode,
  type StreamEvent,
} from "@cjhyy/code-shell-core";
import { isFeatureEnabled, type FeatureFlagOverrides } from "@cjhyy/code-shell-core/extension";
import { getTrustCachedSync } from "./trust-store.js";
import { dlog } from "./desktop-logger.js";
import {
  ExternalRuntimeSessionRecorder,
  readExternalRuntimeBinding,
  writeExternalRuntimeBinding,
  type ExternalRuntimeTurnOutcome,
} from "./external-runtime-state.js";

export interface ExternalRuntimeStartRequest {
  kind: ExternalRuntimeKind;
  sessionId: string;
  cwd: string;
  model?: string;
  modelKey?: string;
  permissionMode?: PermissionMode;
  planMode?: boolean;
  hasGoal?: boolean;
  initialContext?: string;
  developerInstructions?: string;
  /** The renderer window that owns this session's host-loopback surface. */
  ownerWindow?: BrowserWindow;
}

export interface ExternalRuntimeServiceDeps {
  /** Resolved feature flags for this workspace. */
  featureFlags: () => FeatureFlagOverrides;
  /**
   * Register a session that main owns but `agent/run` never created
   * (AgentBridge.registerExternalSession): reserves the session, registers its
   * browser bucket, and claims the panel owner when there is a window.
   *
   * Paired with `releaseExternalSession` — both halves come from the same
   * object so the several registries they touch cannot be half-updated.
   */
  registerSession: (sessionId: string, cwd: string, webContentsId?: number) => void;
  /** Undo registerSession (AgentBridge.releaseExternalSession). */
  releaseSession: (sessionId: string) => void;
  /** Forward translated events to the renderer. */
  emit: (sessionId: string, event: StreamEvent) => void;
  /** Injectable for deterministic tests; production reads the fail-closed sync cache. */
  projectTrust?: (cwd: string) => "trusted" | "untrusted" | "unknown";
  /** Host seams the exposed tools need (panels, browser, …). */
  toolContextOverrides?: (sessionId: string) => Record<string, unknown>;
  /**
   * Ask the user to approve a tool call.
   *
   * Without this the host has no `approvalBackend`, and an `ask` decision fails
   * closed with no prompt — safe, but indistinguishable from "the runtime is
   * broken" for anyone watching. Supplying it is what turns a silent refusal
   * into a dialog.
   */
  requestApproval?: (
    sessionId: string,
    request: { toolName: string; [key: string]: unknown },
  ) => Promise<{ approved: boolean; reason?: string; answer?: string }>;
  /** Drop any prompt still on screen for a session that is going away. */
  cancelApprovals?: (sessionId: string) => void;
  /** Injectable sidecar writer; failure must never orphan an otherwise-live runtime. */
  writeBinding?: typeof writeExternalRuntimeBinding;
}

/**
 * Owns the live external-runtime sessions for this Desktop process.
 *
 * One session per business session id; starting a second for the same id closes
 * the first, because two runtimes writing the same session would interleave turns.
 */
export class ExternalRuntimeService {
  private readonly sessions = new Map<
    string,
    {
      session: ExternalRuntimeSession;
      recorder: ExternalRuntimeSessionRecorder;
      kind: ExternalRuntimeKind;
      cwd: string;
      model?: string;
      ownerWebContentsId?: number;
      forwardEvent: (event: StreamEvent) => void;
      /** Serializes turns so one recorder can never be reset by an overlapping send. */
      turnTail: Promise<void>;
      /** Invalidated before close so late provider events cannot enter a replacement session. */
      lifecycle: { active: boolean; turnActive: boolean };
    }
  >();
  /** Serializes start/stop for one business id, including concurrent IPC calls. */
  private readonly lifecycleTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: ExternalRuntimeServiceDeps) {}

  /** Whether the product currently permits an external runtime at all. */
  isEnabled(): boolean {
    return isFeatureEnabled(this.deps.featureFlags(), "external_agent_runtime");
  }

  /** Whether CodeShell tools may be exposed to it. Separate flag, on purpose. */
  areHostToolsEnabled(): boolean {
    return isFeatureEnabled(this.deps.featureFlags(), "external_host_tools");
  }

  get(sessionId: string): ExternalRuntimeSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /** Canonical project root for validating renderer-supplied turn attachments. */
  getCwd(sessionId: string, callerWebContentsId?: number): string | undefined {
    this.assertOwner(sessionId, callerWebContentsId);
    return this.sessions.get(sessionId)?.cwd;
  }

  private assertOwner(sessionId: string, callerWebContentsId?: number): void {
    if (callerWebContentsId === undefined) return; // trusted main-process caller
    const entry = this.sessions.get(sessionId);
    // An existing ownerless session was created by trusted main-process code;
    // renderer IPC must not claim it merely because its owner field is absent.
    if (entry && entry.ownerWebContentsId !== callerWebContentsId) {
      throw new Error(`external runtime session is owned by another window: ${sessionId}`);
    }
  }

  private enqueueLifecycle<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.lifecycleTails.get(sessionId) === tail) this.lifecycleTails.delete(sessionId);
    });
    return result;
  }

  private emitSafely(sessionId: string, event: StreamEvent): void {
    try {
      this.deps.emit(sessionId, event);
    } catch (error) {
      dlog("external-runtime", "event.emit_failed", {
        sessionId,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persistBindingSafely(
    sessionId: string,
    binding: Parameters<typeof writeExternalRuntimeBinding>[1],
  ): void {
    try {
      (this.deps.writeBinding ?? writeExternalRuntimeBinding)(sessionId, binding);
    } catch (error) {
      dlog("external-runtime", "binding.write_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Always attempt both registry and approval cleanup; return the first failure. */
  private releaseHostSession(sessionId: string): unknown {
    let firstError: unknown;
    try {
      this.deps.releaseSession(sessionId);
    } catch (error) {
      firstError = error;
    }
    try {
      this.deps.cancelApprovals?.(sessionId);
    } catch (error) {
      firstError ??= error;
    }
    return firstError;
  }

  /**
   * Start (or restart) an external-runtime session.
   *
   * Refuses when the feature flag is off rather than silently falling back to the
   * native Engine: a caller that asked for Codex and got the native engine without
   * being told would be debugging the wrong thing.
   */
  start(request: ExternalRuntimeStartRequest): Promise<ExternalRuntimeSession> {
    return this.enqueueLifecycle(request.sessionId, () => this.startExclusive(request));
  }

  private async startExclusive(
    request: ExternalRuntimeStartRequest,
  ): Promise<ExternalRuntimeSession> {
    if (!this.isEnabled()) {
      throw new Error(
        "External Agent Runtimes are disabled. Enable the `external_agent_runtime` " +
          "feature flag to run a session on Codex or Claude Code.",
      );
    }

    const ownerId = request.ownerWindow?.webContents.id;
    this.assertOwner(request.sessionId, ownerId);

    // Replacing an existing session: close the old one first so two runtimes
    // cannot interleave turns on the same business session.
    await this.stopExclusive(request.sessionId);

    // Trust is resolved HERE, from the store Desktop owns. `permissions` is the
    // first DANGEROUS_PROJECT_FIELD, so an untrusted project's rules must be
    // stripped — and the layers below deliberately have no default for this.
    const projectTrusted = (this.deps.projectTrust ?? getTrustCachedSync)(request.cwd) === "trusted";

    // Host tools are gated by their OWN flag, so the runtime can be trialled with
    // no tool surface at all (§20). An empty allowlist is the honest expression of
    // "off" — the bridge still exists, it just advertises nothing.
    const exposure = this.areHostToolsEnabled()
      ? undefined // the reviewed first-phase allowlist
      : { mode: "allowlist" as const, toolNames: new Set<string>() };

    // The registry must actually CONTAIN the tools the exposure policy allows.
    // `new ToolRegistry({})` registers none, which would make the allowlist
    // moot in the quietest possible way: `listTools()` returns [], the runtime
    // advertises nothing, and it looks like the policy denied everything.
    // Built from the policy so the two cannot drift — a name added to the
    // allowlist is registered by that same edit.
    const registry = new ToolRegistry({ toolCatalog: [...BUILTIN_TOOLS, ...CODING_TOOLS] });
    const hostPermissionMode =
      request.permissionMode === "acceptEdits" || request.permissionMode === "bypassPermissions"
        ? "acceptEdits"
        : "default";
    const sandbox = request.planMode
      ? "read-only"
      : request.permissionMode === "bypassPermissions"
        ? "danger-full-access"
        : "workspace-write";
    const approvalPolicy =
      request.permissionMode === "bypassPermissions" || request.permissionMode === "dontAsk"
        ? "never"
        : "on-request";
    const mayRequestToolApproval =
      request.permissionMode !== "dontAsk" && this.deps.requestApproval !== undefined;
    const developerInstructions = [
      "You are running as an Agent Runtime inside CodeShell. Prefer the " +
        "mcp__codeshell_tools__* host tools for CodeShell panels, browser state, " +
        "credentials, memory, skills, and DriveAgent delegation. Do not use the " +
        "Codex desktop in-app-browser plugin: this host provides browser_navigate, " +
        "browser_observe, and browser_act with the owning CodeShell session. Never " +
        "claim that a sub-agent was dispatched unless DriveAgent returned success.",
      request.developerInstructions,
    ]
      .filter(Boolean)
      .join("\n\n");
    const persisted = readExternalRuntimeBinding(request.sessionId);
    const resumeRuntimeSessionId =
      persisted?.kind === request.kind &&
      persisted.cwd === request.cwd &&
      persisted.model === request.model
        ? persisted.runtimeSessionId
        : undefined;
    const recorder = new ExternalRuntimeSessionRecorder(
      request.sessionId,
      request.cwd,
      request.modelKey ?? `${request.kind}/${request.model ?? "default"}`,
      request.kind,
    );
    const lifecycle = { active: true, turnActive: false };
    const forwardEvent = (event: StreamEvent): void => {
      // A provider process may flush buffered output while close() is in flight.
      // Once this concrete runtime has been stopped/replaced, its events belong
      // to the old generation and must not enter the new business-session stream.
      if (!lifecycle.active) return;
      // Once a turn has reached its terminal boundary, buffered provider output
      // belongs to that closed generation and must not bleed into the next turn.
      if (!lifecycle.turnActive && recorder.isTurnFinished && event.type !== "session_started") {
        return;
      }
      // Provider thread/session ids are resume keys, not CodeShell identities.
      // Normalize at the Desktop boundary as defense-in-depth even though each
      // translator should already honor this contract.
      const normalized: StreamEvent =
        event.type === "session_started" && event.sessionId !== request.sessionId
          ? { ...event, sessionId: request.sessionId }
          : event;
      try {
        recorder.onEvent(normalized);
      } finally {
        this.emitSafely(request.sessionId, normalized);
        if (normalized.type === "turn_complete") lifecycle.turnActive = false;
      }
    };
    const contextOverrides = {
      ...(this.deps.toolContextOverrides?.(request.sessionId) ?? {}),
      streamCallback: forwardEvent,
      ...(this.deps.requestApproval
        ? {
            askUser: async (question: string, options?: Record<string, unknown>) => {
              const decision = await this.deps.requestApproval!(request.sessionId, {
                toolName: "__ask_user__",
                question,
                ...(options ?? {}),
              });
              return (
                decision.answer ?? decision.reason ?? (decision.approved ? "approved" : "denied")
              );
            },
          }
        : {}),
    };

    let session: ExternalRuntimeSession;
    // Register immediately before the runtime starts: a host tool call on the
    // first turn needs its bucket, while all fallible preparation above should
    // happen before this externally visible reservation is made.
    this.deps.registerSession(request.sessionId, request.cwd, ownerId);
    try {
      session = await startExternalRuntimeSession({
        kind: request.kind,
        cwd: request.cwd,
        businessSessionId: request.sessionId,
        registry,
        permissionMode: hostPermissionMode,
        presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
        projectTrusted,
        planMode: request.planMode === true,
        visibility: {
          cwd: request.cwd,
          hasGoal: request.hasGoal === true,
          host: "desktop",
          isSubAgent: false,
          sessionId: request.sessionId,
        },
        ...(exposure ? { exposure } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(resumeRuntimeSessionId ? { resumeRuntimeSessionId } : {}),
        ...(request.initialContext ? { initialContext: request.initialContext } : {}),
        developerInstructions,
        sandbox,
        approvalPolicy,
        ...(mayRequestToolApproval
          ? {
              approvalBackend: {
                requestApproval: (approvalRequest: { toolName: string }) =>
                  this.deps.requestApproval!(request.sessionId, approvalRequest),
              } as never,
            }
          : {}),
        contextOverrides: contextOverrides as never,
        hooks: {
          onEvent: forwardEvent,
          ...(mayRequestToolApproval
            ? {
                onNativeApproval: async (nativeRequest) => {
                  const decision = await this.deps.requestApproval!(request.sessionId, {
                    toolName: "Codex native tool",
                    method: nativeRequest.method,
                    params: nativeRequest.params,
                  });
                  return decision.approved ? "accept" : "decline";
                },
              }
            : {}),
          ...(this.deps.requestApproval
            ? {
                onUserInput: async (inputRequest) => {
                  const params =
                    inputRequest.params && typeof inputRequest.params === "object"
                      ? (inputRequest.params as Record<string, unknown>)
                      : {};
                  const questions = Array.isArray(params.questions) ? params.questions : [];
                  const answers: Record<string, { answers: string[] }> = {};
                  for (const value of questions) {
                    if (!value || typeof value !== "object") continue;
                    const question = value as Record<string, unknown>;
                    const id = typeof question.id === "string" ? question.id : "";
                    const text = typeof question.question === "string" ? question.question : "";
                    if (!id || !text) continue;
                    const options = Array.isArray(question.options)
                      ? question.options.flatMap((option) => {
                          if (!option || typeof option !== "object") return [];
                          const item = option as Record<string, unknown>;
                          return typeof item.label === "string"
                            ? [
                                {
                                  label: item.label,
                                  description:
                                    typeof item.description === "string" ? item.description : "",
                                },
                              ]
                            : [];
                        })
                      : undefined;
                    const decision = await this.deps.requestApproval!(request.sessionId, {
                      toolName: "__ask_user__",
                      question: text,
                      ...(typeof question.header === "string" ? { header: question.header } : {}),
                      ...(options && options.length > 0 ? { options } : {}),
                    });
                    if (decision.answer) answers[id] = { answers: [decision.answer] };
                  }
                  return { answers };
                },
              }
            : {}),
        },
        log: (event, data) => dlog("external-runtime", event, data),
      });
    } catch (error) {
      lifecycle.active = false;
      const cleanupError = this.releaseHostSession(request.sessionId);
      if (cleanupError) {
        dlog("external-runtime", "session.start_cleanup_failed", {
          sessionId: request.sessionId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }

    if (request.ownerWindow?.isDestroyed?.()) {
      lifecycle.active = false;
      try {
        await session.close();
      } finally {
        this.releaseHostSession(request.sessionId);
      }
      throw new Error(`external runtime owner window closed while starting: ${request.sessionId}`);
    }

    this.sessions.set(request.sessionId, {
      session,
      recorder,
      kind: request.kind,
      cwd: request.cwd,
      turnTail: Promise.resolve(),
      lifecycle,
      forwardEvent,
      ...(ownerId !== undefined ? { ownerWebContentsId: ownerId } : {}),
      ...(request.model ? { model: request.model } : {}),
    });
    if (session.runtimeSessionId) {
      this.persistBindingSafely(request.sessionId, {
        kind: request.kind,
        cwd: request.cwd,
        runtimeSessionId: session.runtimeSessionId,
        ...(request.model ? { model: request.model } : {}),
      });
    }
    dlog("external-runtime", "session.started", {
      kind: request.kind,
      sessionId: request.sessionId,
      projectTrusted,
      hostToolsEnabled: this.areHostToolsEnabled(),
      exposedToolCount: session.listTools().length,
      hasOwnerWindow: ownerId !== undefined,
    });
    return session;
  }

  async send(
    sessionId: string,
    input: ExternalRuntimeTurnInput | string,
    callerWebContentsId?: number,
  ): Promise<ExternalRuntimeTurnOutcome> {
    this.assertOwner(sessionId, callerWebContentsId);
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`no external runtime session for ${sessionId}`);
    const turnInput = typeof input === "string" ? { text: input } : input;
    const runTurn = async (): Promise<ExternalRuntimeTurnOutcome> => {
      if (this.sessions.get(sessionId) !== entry) {
        throw new Error(
          `external runtime session was replaced before its queued turn: ${sessionId}`,
        );
      }
      entry.lifecycle.turnActive = true;
      try {
        try {
          entry.recorder.beginTurn(turnInput);
          const turn = await entry.session.send(turnInput);
          await turn.done;
        } catch (error) {
          if (!entry.lifecycle.active || this.sessions.get(sessionId) !== entry) {
            return entry.recorder.finishIfMissing();
          }
          const detail = error instanceof Error ? error.message : String(error);
          const errorEvent = { type: "error" as const, error: detail };
          const terminalEvent = { type: "turn_complete" as const, reason: "model_error" as const };
          entry.forwardEvent(errorEvent);
          entry.forwardEvent(terminalEvent);
          return entry.recorder.finishIfMissing();
        }
        if (!entry.lifecycle.active || this.sessions.get(sessionId) !== entry) {
          return entry.recorder.finishIfMissing();
        }
        if (entry.session.runtimeSessionId) {
          this.persistBindingSafely(sessionId, {
            kind: entry.kind,
            cwd: entry.cwd,
            runtimeSessionId: entry.session.runtimeSessionId,
            ...(entry.model ? { model: entry.model } : {}),
          });
        }
        if (!entry.recorder.isTurnFinished) {
          // Keep `streamed: true` honest even for a provider that resolves `done`
          // without delivering its documented terminal callback.
          entry.forwardEvent({ type: "turn_complete", reason: "completed" });
        }
        return entry.recorder.finishIfMissing();
      } finally {
        entry.lifecycle.turnActive = false;
      }
    };
    const outcome = entry.turnTail.then(runTurn, runTurn);
    entry.turnTail = outcome.then(
      () => undefined,
      () => undefined,
    );
    return outcome;
  }

  async interrupt(sessionId: string, callerWebContentsId?: number): Promise<void> {
    this.assertOwner(sessionId, callerWebContentsId);
    await this.sessions.get(sessionId)?.session.interrupt();
  }

  /** Close one session. Safe when there is none. */
  async stop(sessionId: string, callerWebContentsId?: number): Promise<void> {
    await this.enqueueLifecycle(sessionId, () => {
      // Ownership must be checked after earlier lifecycle work has settled. A
      // renderer can enqueue stop() while start() is awaiting provider startup,
      // before the new entry is visible in `sessions`; checking only at call
      // time would let that queued request close another window's fresh runtime.
      this.assertOwner(sessionId, callerWebContentsId);
      return this.stopExclusive(sessionId);
    });
  }

  private async stopExclusive(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.lifecycle.turnActive) {
      // Persist and stream an explicit terminal boundary before invalidating the
      // provider callbacks. Otherwise app shutdown / deletion can leave Session
      // state "active" forever and the next launch restores a phantom busy turn.
      const terminalEvent = {
        type: "turn_complete" as const,
        reason: "aborted_streaming" as const,
      };
      try {
        entry.recorder.onEvent(terminalEvent);
      } catch (error) {
        dlog("external-runtime", "session.stop_record_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.emitSafely(sessionId, terminalEvent);
        entry.lifecycle.turnActive = false;
      }
    }
    // Invalidate callbacks before awaiting close(): close may itself trigger a
    // final provider event, and a restart can claim the same business id as soon
    // as this method returns.
    entry.lifecycle.active = false;
    this.sessions.delete(sessionId);
    let closeError: unknown;
    try {
      await entry.session.close();
    } catch (error) {
      closeError = error;
    }
    // A close failure must not skip host cleanup, and a registry cleanup failure
    // must not skip approval cancellation.
    const cleanupError = this.releaseHostSession(sessionId);
    if (closeError) throw closeError;
    if (cleanupError) throw cleanupError;
    dlog("external-runtime", "session.stopped", { sessionId });
  }

  /**
   * Close every session. Must run on app quit: each session holds a child process
   * and a listening port, and neither dies with the parent on Windows.
   */
  async stopAll(): Promise<void> {
    const ids = [...new Set([...this.sessions.keys(), ...this.lifecycleTails.keys()])];
    const results = await Promise.allSettled(ids.map((id) => this.stop(id)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, "failed to stop external runtimes");
  }

  /** Reap every runtime whose renderer disappeared (notably on macOS, where the app stays alive). */
  async stopOwnedBy(ownerWebContentsId: number): Promise<void> {
    const ids = [...this.sessions]
      .filter(([, entry]) => entry.ownerWebContentsId === ownerWebContentsId)
      .map(([sessionId]) => sessionId);
    await Promise.allSettled(ids.map((sessionId) => this.stop(sessionId)));
  }
}
