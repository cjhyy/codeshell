/**
 * AgentServer — wraps ChatSessionManager and exposes it over the protocol.
 *
 * Responsibilities:
 *   - Handles RPC requests from the client (run, approve, cancel, configure, query)
 *   - Forwards StreamEvents to the client as notifications with sessionId envelope
 *   - Manages per-session approval flow
 *   - Dispatches agent/run through ChatSessionManager so multiple sessions
 *     run concurrently without cross-talk
 *
 * Backward compat: an optional `engine` can be supplied for global operations
 * (model list, config reads/writes, tool registry queries, etc.) that don't
 * yet have a natural "which session" answer. When not supplied the server
 * falls back to borrowing any live session's engine for those reads.
 */

import type { Transport } from "./transport.js";
import {
  type RpcRequest,
  type RunParams,
  type RunResult,
  type ApproveParams,
  type ConfigureParams,
  type QueryParams,
  type InjectParams,
  type SteerParams,
  type UnsteerParams,
  Methods,
  ErrorCodes,
  createResponse,
  createErrorResponse,
  createNotification,
  isRequest,
} from "./types.js";
import type { Engine, EngineConfig } from "../engine/engine.js";
import { diskDefaultsFrom } from "../engine/engine.js";
import type { ValidatedSettings } from "../settings/schema.js";
import { isProtectedSettingKey } from "../settings/manager.js";
import type { ApprovalRequest, ApprovalResult, PermissionMode, StreamEvent } from "../types.js";
import { setInteractiveApprovalFn } from "../tool-system/permission.js";
import { getArenaStatus } from "../tool-system/builtin/arena.js";
import {
  agentNotificationBus,
  notificationQueue,
  buildNotificationMessage,
} from "../tool-system/builtin/agent-notifications.js";
import { backgroundShellManager } from "../runtime/background-shell.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";
import { listBackgroundWorkForUI } from "../tool-system/builtin/background-work.js";
import { logger } from "../logging/logger.js";
import { nanoid } from "nanoid";
import type { ChatSessionManager } from "./chat-session-manager.js";
import { redactLlmConfig, maskSecretValue } from "./redact.js";
import { redactSecrets } from "../logging/sanitize-messages.js";

export interface AgentServerOptions {
  /**
   * Multi-session manager. Required for the new multi-session protocol.
   * When present, agent/run dispatches through the manager.
   */
  chatManager?: ChatSessionManager;
  /**
   * Legacy single-engine mode. When chatManager is not supplied the server
   * falls back to the old single-engine behaviour (backwards compat for
   * createInProcessClient and agent-server-stdio until T11).
   */
  engine?: Engine;
  transport: Transport;
  /**
   * Reads fresh settings from disk for config hot-reload (layer 2). MUST be
   * the SAME closure the engineFactory uses for new sessions (e.g.
   * agent-server-stdio's `freshSettings`) so a reloaded running session and a
   * newly-created session converge on identical disk config — no divergence.
   * When absent, `configure({ reloadSettings })` returns an explicit error.
   */
  settingsReader?: () => ValidatedSettings;
  /**
   * Disk-only active-goal reader, used by agent/goalGet when the session is NOT
   * live in chatManager. In worker (chatManager) mode there is no legacyEngine
   * to fall back to, and a reopened-after-restart session isn't a live
   * ChatSession yet (one is only created on agent/run), so chatManager.get()
   * misses — without this the handler returned goal:null even though state.json
   * still held the goal, and the UI's goal block never re-surfaced ("goal 还在
   * 但页面不显示"). Wire it to SessionManager.readActiveGoal. Optional: legacy
   * mode already reads disk via the engine, and tests that don't exercise the
   * reopened-session path can omit it.
   */
  readActiveGoalFromDisk?: (
    sessionId: string,
  ) => import("../engine/goal.js").GoalConfig | undefined;
}

export class AgentServer {
  private readonly chatManager: ChatSessionManager | null;
  private readonly legacyEngine: Engine | null;
  private globalQueryEngine: Engine | null = null;
  private transport: Transport;
  /** Fresh-disk settings reader for config hot-reload; null when not wired. */
  private readonly settingsReader: (() => ValidatedSettings) | null;
  /** Disk-only active-goal reader for agent/goalGet on a non-live session. */
  private readonly readActiveGoalFromDisk:
    | ((sessionId: string) => import("../engine/goal.js").GoalConfig | undefined)
    | null;
  /**
   * Monotonic config-reload version, bumped per reloadSettings request so each
   * Engine.refreshRuntimeConfig can drop out-of-order (stale) deliveries (Q5).
   */
  private configVersion = 0;
  /**
   * JSON of the last disk-default patch broadcast to ALL live sessions (#6).
   * When a new reloadSettings request produces a byte-identical patch we SKIP
   * the entire forEachSession broadcast — every session's refreshRuntimeConfig
   * would otherwise unconditionally reloadHooks() (invalidate + full disk
   * re-read + hook teardown/re-register) per call, and the personalization UI
   * auto-saves on a 600ms debounce, so identical re-saves caused K× hook churn
   * per keystroke-pause. A genuine change still differs in JSON → propagates.
   * null until the first broadcast.
   */
  private lastBroadcastPatch: string | null = null;

  // ── Legacy single-engine state (used when chatManager is null) ──
  private running = false;
  private abortController: AbortController | null = null;
  /** Pending approval requests: requestId → resolve function (legacy path) */
  private pendingApprovals = new Map<string, (result: ApprovalResult) => void>();
  /** Timers for approval timeouts */
  private approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Default approval timeout: 5 minutes */
  private static readonly APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * Unsubscribe handle for the process-local `agentNotificationBus`
   * subscription set up in the constructor. Called from `close()` so a
   * shut-down server stops forwarding completion events even if the bus
   * itself outlives the server (it's a process-local singleton).
   */
  private bgAgentBusUnsubscribe: (() => void) | null = null;

  constructor(options: AgentServerOptions) {
    this.chatManager = options.chatManager ?? null;
    this.legacyEngine = options.engine ?? null;
    this.settingsReader = options.settingsReader ?? null;
    this.readActiveGoalFromDisk = options.readActiveGoalFromDisk ?? null;

    if (!this.chatManager && !this.legacyEngine) {
      throw new Error("AgentServer: either chatManager or engine must be supplied");
    }

    this.transport = options.transport;

    // Wire up incoming messages
    this.transport.onMessage((msg) => {
      if (isRequest(msg)) {
        this.handleRequest(msg).catch((err) => {
          this.transport.send(
            createErrorResponse(msg.id, ErrorCodes.InternalError, (err as Error).message),
          );
        });
      }
    });

    setInteractiveApprovalFn((request: ApprovalRequest) => {
      return this.requestApprovalFromClient(request);
    });

    if (this.legacyEngine) {
      // Only wire an interactive askUser when a human is present. For
      // unattended (headless) runs we leave askUser undefined so
      // AskUserQuestion hits its headless-error branch and returns immediately
      // instead of suspending until the tool-exec timeout (~300s).
      if (!this.legacyEngine.isHeadless()) {
        this.legacyEngine.setAskUser((question, opts) => {
          return this.requestAskUserFromClient(question, opts);
        });
      }
    }

    // B2.2 — forward background sub-agent completion events through the
    // protocol so Desktop / SDK / remote AgentClients see them too. The
    // bus is fed from `NotificationQueue.enqueue`, so this single
    // subscription covers every enqueue site — background sub-agents
    // (agent.ts), background shells (background-shell.ts), and video/job
    // polls (background-jobs.ts). The bus now guarantees a real sessionId
    // (no more legacy-bucket coercion to ""), so we forward whatever sid it
    // hands us.
    this.bgAgentBusUnsubscribe = agentNotificationBus.subscribe((sessionId, event) => {
      this.notify(Methods.StreamEvent, { sessionId, event });
      // Background work that finishes while the session is IDLE (a
      // run_in_background Bash like a download, a background sub-agent, or a
      // video poll — the engine no longer parks on any of them) would otherwise
      // leave its completion sitting in the queue until the user manually sends.
      // Wake the session with one run carrying the notification so the model
      // reads "download complete" and continues on its own (the persisted goal
      // is judged that turn). If the work finishes while a run is still in
      // flight, the idle guard below skips it and the run-boundary re-check
      // (trigger B) drains it at end-of-turn instead. A never-exiting dev server
      // emits no completion, so it never wakes anything (no task/service
      // classification needed).
      this.maybeWakeIdleSession(sessionId);
    });

    // Notify client we're ready
    this.notify(Methods.Status, { status: "ready" });
  }

  /**
   * Wake an IDLE chatManager session that has pending background-completion
   * notifications, by enqueueing one turn whose task is the drained
   * notification(s). The model then sees the completion and continues; the
   * session's persisted goal (if any) is judged on that turn.
   *
   * Guards:
   * - chatManager path only (the legacy single-engine / headless path drives
   *   its own loop and has no idle-session-resume concept).
   * - Session must exist AND be idle. If it's busy, we do nothing: the in-flight
   *   run's end-of-turn `drainAll` already collects every pending notification,
   *   so a second run would be redundant — and `enqueueTurn` while busy would
   *   queue a spurious extra turn.
   * - We `drainAll` exactly here and feed the items into the woken turn. This
   *   also merges a burst of near-simultaneous completions into one wakeup:
   *   the first drains all currently-pending items; subsequent bus events for
   *   the same session find it busy (or find an empty queue) and no-op.
   *
   * INVARIANT (the burst-merge correctness depends on it): the merge only
   * holds because (a) the bus fans out to subscribers SYNCHRONOUSLY, and (b)
   * `enqueueTurn` sets the session's `active` (→ isBusy()===true) SYNCHRONOUSLY
   * before its first await. So when bus events #2..N arrive — still on the same
   * synchronous fan-out as #1 — they already see the session as busy and no-op.
   * If either path is ever made async (e.g. an await is added inside
   * enqueueTurn before `active` is set, or the bus starts deferring delivery),
   * this degrades into N concurrent wakeups for N completions. Keep both
   * synchronous, or replace this comment's assumption with an explicit
   * "wakeup in flight" guard flag.
   */
  private maybeWakeIdleSession(sessionId: string): void {
    if (!this.chatManager) return;
    const session = this.chatManager.get(sessionId);
    if (!session || session.isBusy()) return;
    // Headless / automation runs are one-shot: the caller takes result.text and
    // is gone, so there's no consumer for a woken continuation turn. Headless
    // already drained its background sub-agents inside engine.run before
    // returning; any remaining queued notification (video/shell) must NOT spin
    // an orphan turn. Only the interactive path auto-continues.
    if (session.engine.isHeadless()) return;
    // Don't resurrect a session the user just Stopped: cancel() leaves it idle
    // (active=null) so isBusy() reads false, but auto-running a fresh turn here
    // would defeat the Stop. The flag clears the moment the user sends again.
    if (session.wasCancelledSinceLastTurn()) return;
    const pending = notificationQueue.drainAll(sessionId);
    if (pending.length === 0) return;
    const task = `<system-reminder>\n${buildNotificationMessage(pending)}\n</system-reminder>`;
    void session
      .enqueueTurn(task, {
        // Synthetic notification, not the user's own input: persisted with an
        // `injected` flag so a disk rebuild doesn't render it as a phantom user
        // bubble (the live UI shows only the woken assistant's reply).
        injected: true,
        onStream: (event: StreamEvent) =>
          this.notify(Methods.StreamEvent, { sessionId, event }),
      })
      .catch((err) => {
        // A wakeup turn failing must not crash the bus fan-out. The drained
        // notifications are already in the transcript via the run's messages;
        // log and move on.
        logger.warn("bg_wakeup.turn_failed", {
          sessionId,
          error: (err as Error).message,
        });
        // Belt-and-braces, mirroring the send() path's run().then(clear-busy):
        // the renderer set the composer "working" spinner on this run's
        // session_started, and clears it on turn_complete/error. A failure
        // BEFORE the turn-loop runs (e.g. a setup error) emits neither, which
        // would leave the spinner stuck. Emit a terminal `error` (NOT a
        // turn_complete) so the renderer clears busy AND a woken automation
        // session's runStatus flips to "failed" rather than being mislabeled
        // "completed". If the turn-loop already emitted its own `error`, this is
        // a harmless duplicate (busy already cleared, status already failed).
        this.notify(Methods.StreamEvent, {
          sessionId,
          event: { type: "error", error: (err as Error)?.message ?? "background wakeup failed" },
        });
      })
      .finally(() => {
        // Run-boundary re-check (trigger B): the woken summarize turn may have
        // spawned NEW background work (e.g. goal "generate 2 videos" → after #1
        // completes, this turn submits #2). When #2 finishes its notification
        // arrives while we're idle again — but if it arrived DURING this turn
        // (busy), trigger A skipped it. Re-checking at the run boundary drains
        // anything that landed while busy, chaining wakeups until the queue is
        // truly empty. Replaces the old engine for(;;) outer loop.
        this.maybeWakeIdleSession(sessionId);
      });
  }

  // ─── Request Dispatch ───────────────────────────────────────────

  private async handleRequest(req: RpcRequest): Promise<void> {
    switch (req.method) {
      case Methods.Run:
        await this.handleRun(req);
        break;
      case Methods.Approve:
        this.handleApprove(req);
        break;
      case Methods.Cancel:
        this.handleCancel(req);
        break;
      case Methods.Configure:
        this.handleConfigure(req);
        break;
      case Methods.Query:
        await this.handleQuery(req);
        break;
      case Methods.Inject:
        this.handleInject(req);
        break;
      case Methods.Steer:
        this.handleSteer(req);
        break;
      case Methods.Unsteer:
        this.handleUnsteer(req);
        break;
      case Methods.CloseSession:
        this.handleCloseSession(req);
        break;
      case Methods.GoalExtend:
        this.handleGoalExtend(req);
        break;
      case Methods.GoalClear:
        this.handleGoalClear(req);
        break;
      case Methods.GoalGet:
        this.handleGoalGet(req);
        break;
      case Methods.BackgroundShells:
        this.handleBackgroundShells(req);
        break;
      case Methods.BackgroundWork:
        this.handleBackgroundWork(req);
        break;
      default:
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.MethodNotFound, `Unknown method: ${req.method}`),
        );
    }
  }

  // ─── Run ────────────────────────────────────────────────────────

  private async handleRun(req: RpcRequest): Promise<void> {
    // ── ChatSessionManager path (multi-session) ──────────────────
    if (this.chatManager) {
      return this.handleRunMulti(req);
    }
    // ── Legacy single-engine path ────────────────────────────────
    return this.handleRunLegacy(req);
  }

  private async handleRunMulti(req: RpcRequest): Promise<void> {
    const cm = this.chatManager!;
    const params = (req.params ?? {}) as unknown as RunParams;

    if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    if (!params.task) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "task is required"),
      );
      return;
    }

    let session;
    try {
      session = cm.getOrCreate(params.sessionId, {
        permissionMode: params.permissionMode,
        cwd: params.cwd,
        projectTrusted: params.projectTrusted,
      } as any);
    } catch (err: any) {
      const code = err.code ?? ErrorCodes.InternalError;
      this.transport.send(createErrorResponse(req.id, code, err.message));
      return;
    }

    // `requireExisting`: reject if the target session isn't on disk rather than
    // running the prompt against a freshly-created blank session. A cron
    // "continue this conversation" job whose session the user deleted must fail
    // loudly here (SessionNotFound) so the scheduler can auto-disable it,
    // instead of silently executing with no transcript/goal/context.
    if (params.requireExisting === true && !session.engine.sessionExistsOnDisk(params.sessionId)) {
      this.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.SessionNotFound,
          `session ${params.sessionId} does not exist`,
        ),
      );
      return;
    }

    if (params.model !== undefined) {
      if (typeof params.model !== "string" || params.model.length === 0) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, "model must be a non-empty string"),
        );
        return;
      }
      try {
        session.requestModelSwitch(params.model);
      } catch (err) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, (err as Error).message),
        );
        return;
      }
    }

    if (typeof params.planMode === "boolean") {
      session.engine.setPlanMode(params.planMode);
    }

    const sid = params.sessionId;

    // Wire AskUserQuestion for this interactive session. The chatManager path
    // builds a fresh per-session Engine via engineFactory, which (unlike the
    // legacy single-engine path) never had askUser wired — so AskUserQuestion
    // always fell into its "not available in headless mode" branch in normal
    // chat (and in a resumed automation session). Route it to the client with
    // this session's id so the renderer attributes the question to the right
    // tab, resolving via the session's own pendingApprovals. Skip genuinely
    // headless engines (no human to answer).
    if (!session.engine.isHeadless()) {
      session.engine.setAskUser((question, opts) =>
        this.requestAskUserForSession(session, sid, question, opts),
      );
      // Browser automation bridge: each method routes a browser action to the
      // client (Electron main drives the webview via CDP) over the SAME
      // request/response channel as askUser (pendingApprovals + requestId),
      // reusing its proven resolve/timeout/cleanup. The main-side handler
      // replies with the action's JSON result.
      session.engine.setBrowserBridge(this.makeBrowserBridge(session, sid));
      // Cookie→browser injection (InjectCredential tool): same cross-process
      // channel; main restores the cookie jar into the built-in browser.
      session.engine.setInjectCredential((credentialId) =>
        this.requestCredentialInjectForSession(session, sid, credentialId),
      );
    }
    try {
      const result = await session.enqueueTurn(params.task, {
        cwd: params.cwd,
        goal:
          typeof params.goal === "string" ||
          (params.goal != null && typeof params.goal === "object")
            ? (params.goal as string | import("../engine/goal.js").GoalConfig)
            : undefined,
        onStream: (event: StreamEvent) =>
          this.notify(Methods.StreamEvent, { sessionId: sid, event }),
        clientMessageId:
          typeof params.clientMessageId === "string" ? params.clientMessageId : undefined,
      });

      const runResult: RunResult = {
        text: result.text,
        reason: result.reason,
        sessionId: result.sessionId ?? sid,
        turnCount: result.turnCount,
        usage: result.usage,
      };
      this.transport.send(createResponse(req.id, runResult));
      // Run-boundary re-check (trigger B): the session is idle now. If a
      // background task (shell/video) completed DURING this run, its bus event
      // fired while we were busy and trigger A skipped it — drain it now and
      // wake a continuation turn. Interactive path only; headless already
      // drained its sub-agents inside engine.run before returning.
      this.maybeWakeIdleSession(sid);
    } catch (err) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
      );
      // Even on a failed run the session goes idle — re-check so a background
      // completion that landed during the failed run isn't orphaned.
      this.maybeWakeIdleSession(sid);
    }
  }

  private async handleRunLegacy(req: RpcRequest): Promise<void> {
    if (this.running) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.Overloaded, "Agent is already running"),
      );
      return;
    }

    const params = (req.params ?? {}) as unknown as RunParams;
    if (!params.task) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "task is required"),
      );
      return;
    }
    if (params.cwd !== undefined && (typeof params.cwd !== "string" || params.cwd.length === 0)) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "cwd must be a non-empty string"),
      );
      return;
    }

    if (params.permissionMode !== undefined) {
      const mode = params.permissionMode;
      if (!isValidPermissionMode(mode)) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, `invalid permission mode: ${mode}`),
        );
        return;
      }
      this.legacyEngine!.setPermissionMode(mode);
      // setRuntimeBypass / setInPlanMode singletons were removed in T4/T5;
      // Engine.setPermissionMode now keeps this.permissionMode + this.planMode
      // in sync and tools read them via ToolContext.permissionMode/planMode.
    }

    if (params.model !== undefined) {
      if (typeof params.model !== "string" || params.model.length === 0) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, "model must be a non-empty string"),
        );
        return;
      }
      try {
        this.legacyEngine!.switchModel(params.model);
      } catch (err) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, (err as Error).message),
        );
        return;
      }
    }

    this.running = true;
    this.abortController = new AbortController();
    this.notify(Methods.Status, { status: "running" });

    const streamToClient = (event: StreamEvent) => {
      this.notify(Methods.StreamEvent, { sessionId: params.sessionId ?? "", event });
    };

    // TodoWrite emits task_update directly through ToolContext.streamCallback;
    // no module singleton wiring needed anymore.

    // Snapshot the controller for the catch block — `this.abortController`
    // is nulled in the `finally`, so by the time we'd want to check
    // `signal.aborted` below it's already gone.
    const runController = this.abortController!;
    try {
      const result = await this.legacyEngine!.run(params.task, {
        cwd: params.cwd,
        sessionId: params.sessionId,
        signal: runController.signal,
        onStream: streamToClient,
        clientMessageId:
          typeof params.clientMessageId === "string" ? params.clientMessageId : undefined,
        goal:
          typeof params.goal === "string" ||
          (params.goal != null && typeof params.goal === "object")
            ? (params.goal as string | import("../engine/goal.js").GoalConfig)
            : undefined,
      });

      const runResult: RunResult = {
        text: result.text,
        reason: result.reason,
        sessionId: result.sessionId,
        turnCount: result.turnCount,
        usage: result.usage,
      };

      this.transport.send(createResponse(req.id, runResult));
    } catch (err) {
      // ESC / Stop path. If the user cancelled, the engine's
      // in-flight LLM call or Bash spawn rejects with an AbortError
      // that bubbles up here. Don't surface it as InternalError —
      // the user already knows they pressed stop; clients should
      // just clear busy.
      const errName = (err as { name?: string }).name;
      const aborted =
        runController.signal.aborted ||
        errName === "AbortError" ||
        errName === "APIUserAbortError";
      if (aborted) {
        const cancelledResult: RunResult = {
          text: "",
          reason: "aborted_streaming",
          sessionId: params.sessionId ?? "",
          turnCount: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
        this.transport.send(createResponse(req.id, cancelledResult));
      } else {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
        );
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.notify(Methods.Status, { status: "ready" });
    }
  }

  // ─── Approve ────────────────────────────────────────────────────

  private handleApprove(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as ApproveParams;

    // ChatSessionManager path: look up per-session pendingApprovals
    if (this.chatManager && typeof params.sessionId === "string") {
      const s = this.chatManager.get(params.sessionId);
      if (!s) {
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.SessionClosed,
            `No such session: ${params.sessionId}`,
          ),
        );
        return;
      }
      const resolve = s.pendingApprovals.get(params.requestId);
      if (!resolve) {
        // Tool approvals still resolve through the interactive backend's
        // legacy pending map; the sessionId on their envelope is UI routing
        // metadata. Accept a session-tagged response for those requests too.
        const legacyResolve = this.pendingApprovals.get(params.requestId);
        if (!legacyResolve) {
          this.transport.send(
            createErrorResponse(
              req.id,
              ErrorCodes.InvalidParams,
              `No pending approval: ${params.requestId}`,
            ),
          );
          return;
        }
        this.pendingApprovals.delete(params.requestId);
        this.clearApprovalTimer(params.requestId);
        legacyResolve(params.decision);
        this.transport.send(createResponse(req.id, { ok: true }));
        return;
      }
      s.pendingApprovals.delete(params.requestId);
      // Cancel the pending timeout for THIS request (the ask path armed one).
      // The legacy single-engine branch below already does this; without it
      // here a decided request leaves a live timer that fires at
      // APPROVAL_TIMEOUT_MS and churns a dead map entry.
      this.clearApprovalTimer(params.requestId);
      resolve(params.decision);
      this.transport.send(createResponse(req.id, { ok: true }));
      return;
    }

    // Legacy path
    const resolve = this.pendingApprovals.get(params.requestId);
    if (!resolve) {
      this.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.InvalidParams,
          `No pending approval: ${params.requestId}`,
        ),
      );
      return;
    }

    this.pendingApprovals.delete(params.requestId);
    this.clearApprovalTimer(params.requestId);
    resolve(params.decision);
    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── Cancel ─────────────────────────────────────────────────────

  private handleCancel(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as import("./types.js").CancelParams;

    // ChatSessionManager path: cancel a specific session
    if (this.chatManager) {
      if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
        );
        return;
      }
      const s = this.chatManager.get(params.sessionId);
      if (!s) {
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.SessionClosed,
            `No such session: ${params.sessionId}`,
          ),
        );
        return;
      }
      s.cancel();
      // s.cancel() only aborts the engine controller + drains queued turns. The
      // session's pendingApprovals (askUser / browser_action / tool approvals)
      // are NOT driven by the abort signal — they only settle on a client reply
      // or the 5-minute APPROVAL_TIMEOUT_MS. Left alone, the awaiting tool call
      // hangs until that timeout (delaying run wind-down) and the server-side
      // approvalTimers entry leaks. Resolve them as cancelled now and clear the
      // matching timers, mirroring the legacy path below.
      this.cancelSessionApprovals(s);
      this.transport.send(createResponse(req.id, { ok: true }));
      return;
    }

    // Legacy path
    if (!this.running || !this.abortController) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.SessionClosed, "Agent is not running"),
      );
      return;
    }

    this.abortController.abort();

    for (const [, resolve] of this.pendingApprovals) {
      resolve({ approved: false, reason: "cancelled" });
    }
    this.pendingApprovals.clear();
    this.clearAllApprovalTimers();

    this.transport.send(createResponse(req.id, { ok: true }));
  }

  /**
   * Extend a running goal's turn/budget ceilings mid-run (TODO 3.1). Routed to
   * a specific session (multi-session path). Returns the resulting effective
   * limits, or an error if no session / no active run.
   */
  private handleGoalExtend(req: RpcRequest): void {
    const params = (req.params ?? {}) as {
      sessionId?: string;
      addTurns?: number;
      addTokenBudget?: number;
      addTimeBudgetMs?: number;
      addStopBlocks?: number;
    };
    const ext = {
      addTurns: params.addTurns,
      addTokenBudget: params.addTokenBudget,
      addTimeBudgetMs: params.addTimeBudgetMs,
      addStopBlocks: params.addStopBlocks,
    };
    // Multi-session path: route to the named session.
    const session =
      this.chatManager && typeof params.sessionId === "string"
        ? this.chatManager.get(params.sessionId)
        : undefined;
    // Legacy single-engine path (no chatManager): extend the one engine's run,
    // mirroring handleCancel which also supports both paths. Without this a
    // legacy host can cancel but never extend a goal.
    const result = session
      ? session.extendGoalRun(ext)
      : this.legacyEngine
        ? this.legacyEngine.extendGoalRun(ext)
        : undefined;
    if (result === undefined) {
      // Couldn't even resolve a target (no session and no legacy engine).
      if (!session && !this.legacyEngine) {
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.SessionClosed,
            params.sessionId ? `No such session: ${params.sessionId}` : "sessionId is required",
          ),
        );
        return;
      }
    }
    if (!result) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "No active run to extend"),
      );
      return;
    }
    this.transport.send(createResponse(req.id, { ok: true, limits: result }));
  }

  /**
   * Clear a session's persisted active goal (CC /goal clear). Routes to the
   * named session, falling back to the legacy single engine (mirrors
   * handleGoalExtend / handleCancel's dual path). Returns { ok, cleared }.
   */
  private handleGoalClear(req: RpcRequest): void {
    const params = (req.params ?? {}) as { sessionId?: string };
    const session =
      this.chatManager && typeof params.sessionId === "string"
        ? this.chatManager.get(params.sessionId)
        : undefined;
    if (!session && !this.legacyEngine) {
      this.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.SessionClosed,
          params.sessionId ? `No such session: ${params.sessionId}` : "sessionId is required",
        ),
      );
      return;
    }
    const cleared = session
      ? session.clearGoal()
      : params.sessionId
        ? (this.legacyEngine!.clearGoal(params.sessionId) ?? false)
        : false;
    this.transport.send(createResponse(req.id, { ok: true, cleared }));
  }

  /**
   * Read a session's persisted active goal so the host can re-surface the goal
   * block + Cancel button on session load. A persistent goal lives only in
   * state.activeGoal and is never replayed from the transcript, so a reloaded
   * (or disk-rebuilt) session has no other way to learn it. Prefers a live
   * chatManager session, else falls through to a disk read (readActiveGoalFromDisk
   * in worker mode, or the legacy engine's disk read in single-engine mode) — the
   * bug case is an aborted/reloaded session that is NOT live. Returns { ok, goal } where goal
   * is the objective string, or null when there's no goal / unknown session.
   * Never errors on "no goal" — null is the normal "nothing to show" answer.
   */
  private handleGoalGet(req: RpcRequest): void {
    const params = (req.params ?? {}) as { sessionId?: string };
    if (typeof params.sessionId !== "string" || !params.sessionId) {
      // Missing/empty param is InvalidParams, not SessionClosed (no session was
      // ever named) — matches handleSteer/handleUnsteer/handleBackgroundShells.
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    // Prefer the live session; otherwise read straight off disk. The goal we
    // want to recover belongs to a session that is, by definition of this bug,
    // usually NOT currently live: reopening after restart doesn't create a
    // ChatSession (that only happens on a send), so chatManager.get() misses.
    // In worker (chatManager) mode there is no legacyEngine, so the disk read
    // MUST come from readActiveGoalFromDisk — relying on legacyEngine there
    // silently returned null and the UI goal block never re-surfaced.
    const live = this.chatManager ? this.chatManager.get(params.sessionId) : undefined;
    const goal = live
      ? live.getGoal()
      : (this.readActiveGoalFromDisk?.(params.sessionId) ??
        this.legacyEngine?.getGoal(params.sessionId) ??
        undefined);
    this.transport.send(
      createResponse(req.id, { ok: true, goal: goal ? goal.objective : null }),
    );
  }

  /**
   * Query/control a session's background shells for the desktop UI panel (TODO
   * 3.2). Reads the singleton BackgroundShellManager directly (shells outlive
   * the run that spawned them, so we don't need a live ChatSession). Actions:
   *   - (default) list  → the session's shells
   *   - output          → full retained output of one shell
   *   - kill            → terminate one shell's process group
   * All scoped by sessionId (manager enforces ownership on output/kill).
   */
  private handleBackgroundShells(req: RpcRequest): void {
    const params = (req.params ?? {}) as {
      sessionId?: string;
      action?: "list" | "output" | "kill";
      shellId?: string;
    };
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    const action = params.action ?? "list";
    if (action === "list") {
      const shells = backgroundShellManager.listForSession(sessionId);
      this.transport.send(createResponse(req.id, { shells }));
      return;
    }
    if (!params.shellId) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "shellId is required"),
      );
      return;
    }
    if (action === "output") {
      const res = backgroundShellManager.readOutput(params.shellId, "all", sessionId);
      if (!res.ok) {
        this.transport.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, res.error));
        return;
      }
      this.transport.send(createResponse(req.id, { header: res.header, text: res.text }));
      return;
    }
    if (action === "kill") {
      void backgroundShellManager.kill(params.shellId, sessionId).then((res) => {
        if (!res.ok) {
          this.transport.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, res.error));
        } else {
          this.transport.send(createResponse(req.id, { ok: true }));
        }
      });
      return;
    }
    this.transport.send(
      createErrorResponse(req.id, ErrorCodes.InvalidParams, `unknown action: ${action}`),
    );
  }

  /**
   * BackgroundWork — unified, list-only view of a session's background work
   * across all three registries (shells + sub-agents + jobs) for the desktop
   * background panel. Per-shell output/kill still flow through BackgroundShells
   * (by shellId); this just answers "what's running in the background right now".
   */
  private handleBackgroundWork(req: RpcRequest): void {
    const params = (req.params ?? {}) as { sessionId?: string };
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    const items = listBackgroundWorkForUI(sessionId);
    this.transport.send(createResponse(req.id, { items }));
  }

  // ─── CloseSession ───────────────────────────────────────────────

  private handleCloseSession(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as import("./types.js").CloseSessionParams;
    if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    if (this.chatManager) {
      this.chatManager.close(params.sessionId);
    }
    // Explicit session teardown — reap that session's background shells
    // (design §6 "session 被显式删除 → killSession"). This is the RPC path
    // (agent/closeSession from the host on delete), distinct from the idle
    // sweeper's chatManager.close() which must NOT kill (§6). Fire-and-forget.
    void backgroundShellManager.killSession(params.sessionId);
    // Drop this session's retained background jobs too (#2/#5): finished jobs
    // are kept for the panel, so explicit teardown is where they're released.
    backgroundJobRegistry.dropForSession(params.sessionId);
    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── Configure ──────────────────────────────────────────────────

  private handleConfigure(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as ConfigureParams;

    // If a sessionId is present, mutate that specific session's engine
    if (this.chatManager && typeof params.sessionId === "string") {
      const sid = params.sessionId;
      const s = this.chatManager.get(sid);
      if (!s) {
        // Session not found (already cleaned by idle sweeper, or never created).
        // Don't create one just for configure — let the subsequent run() do it
        // with proper per-session config. Return OK since there's nothing to
        // configure on a non-existent session.
        this.transport.send(createResponse(req.id, { ok: true }));
        return;
      }
      if (typeof params.planMode === "boolean") s.engine.setPlanMode(params.planMode);
      if (typeof params.permissionMode === "string") {
        s.engine.setPermissionMode(params.permissionMode as NonNullable<EngineConfig["permissionMode"]>);
      }
      if (params.clearModels) {
        this.chatManager.runtime.clearModels();
      }
      if (params.reloadModels) {
        try {
          this.chatManager.runtime.reloadModelsFromSettings();
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
          return;
        }
      }
      // Per-session model switch — the missing piece that made model changes
      // worker-global (session-isolation research §3). requestModelSwitch
      // applies immediately when idle, defers to the run boundary when busy
      // so it never swaps the model under a running LLM client.
      if (typeof params.model === "string") {
        try {
          const entry = s.requestModelSwitch(params.model);
          this.transport.send(
            createResponse(req.id, {
              ok: true,
              model: entry.model,
              key: entry.key,
              maxContextTokens: entry.maxContextTokens,
            }),
          );
          return;
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InvalidParams, (err as Error).message),
          );
          return;
        }
      }
      // Hot-reload disk-default config onto this one session (layer 2).
      if (params.reloadSettings === true) {
        if (!this.settingsReader) {
          this.transport.send(
            createErrorResponse(
              req.id,
              ErrorCodes.InvalidParams,
              "reloadSettings is not supported by this AgentServer: no settingsReader is wired",
            ),
          );
          return;
        }
        const settings = this.settingsReader();
        const version = ++this.configVersion;
        s.engine.refreshRuntimeConfig(
          diskDefaultsFrom(settings, s.engine.getEffectiveDisabledLists().disabledPlugins),
          version,
        );
      }
      this.transport.send(createResponse(req.id, { ok: true }));
      return;
    }

    // Global configure — delegate to legacyEngine if available,
    // or to any session's engine from chatManager for settings ops
    const engine = this.legacyEngine ?? this.anyEngine();

    if (params.clearModels) {
      if (this.chatManager) {
        this.chatManager.runtime.clearModels();
      } else {
        this.legacyEngine?.getModelPool().clear();
        this.globalQueryEngine?.getModelPool().clear();
      }
    }

    if (params.reloadModels) {
      try {
        if (this.chatManager) {
          this.chatManager.runtime.reloadModelsFromSettings();
        } else {
          const seen = new Set<Engine>();
          const reload = (target: Engine | null | undefined) => {
            if (!target || seen.has(target)) return;
            seen.add(target);
            target.reloadModelPool();
          };
          reload(this.legacyEngine);
          reload(this.globalQueryEngine);
          if (seen.size === 0) reload(engine);
        }
      } catch (err) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
        );
        return;
      }
    }
    if (params.model !== undefined && engine) {
      try {
        const entry = engine.switchModel(params.model);
        this.transport.send(
          createResponse(req.id, {
            ok: true,
            model: entry.model,
            key: entry.key,
            maxContextTokens: entry.maxContextTokens,
          }),
        );
        return;
      } catch (err) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InvalidParams, (err as Error).message),
        );
        return;
      }
    }
    if (params.planMode !== undefined && engine) {
      engine.setPlanMode(params.planMode);
    }

    // Config hot-reload layer 2: re-read disk settings once and push the
    // disk-default config patch (+ settings-hook reload + incremental MCP
    // connect) onto every live session. Parallel to reloadModels; no new
    // protocol method. In-flight turns are untouched — refreshRuntimeConfig
    // only mutates this.config, picked up at the next turn boundary.
    if (params.reloadSettings === true) {
      if (!this.settingsReader) {
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.InvalidParams,
            "reloadSettings is not supported by this AgentServer: no settingsReader is wired",
          ),
        );
        return;
      }
      if (!this.chatManager) {
        // Single-engine host (legacyEngine / anyEngine, no chatManager): there
        // are no sessions to fan out to, but the one engine must still pick up
        // the reload — otherwise we'd report ok:true while silently dropping it.
        // Mirrors how reloadModels/model/planMode above act on `engine`.
        if (engine) {
          const settings = this.settingsReader();
          engine.refreshRuntimeConfig(
            diskDefaultsFrom(settings, engine.getEffectiveDisabledLists().disabledPlugins),
            ++this.configVersion,
          );
        }
        this.transport.send(createResponse(req.id, { ok: true }));
        return;
      }
      const settings = this.settingsReader();
      // The MCP merge folds each session's PROJECT capabilityOverrides (a
      // project-level "on" must override the global disabledPlugins), so the
      // patch is cwd-dependent — compute it per session, not once.
      const perSession: Array<{ apply: (version: number) => void; patch: unknown }> = [];
      this.chatManager.forEachSession((s) => {
        const patch = diskDefaultsFrom(
          settings,
          s.engine.getEffectiveDisabledLists().disabledPlugins,
        );
        perSession.push({ apply: (v) => s.engine.refreshRuntimeConfig(patch, v), patch });
      });
      // #6: content short-circuit — now keyed on ALL per-session patches, so a
      // change visible to only one session (e.g. its project's overrides)
      // still propagates while a true no-op skips the reloadHooks churn.
      const patchJson = JSON.stringify(perSession.map((p) => p.patch));
      if (patchJson !== this.lastBroadcastPatch) {
        this.lastBroadcastPatch = patchJson;
        const version = ++this.configVersion;
        for (const p of perSession) p.apply(version);
      }
    }

    this.transport.send(createResponse(req.id, { ok: true }));
  }

  // ─── Query ──────────────────────────────────────────────────────

  private async handleQuery(req: RpcRequest): Promise<void> {
    const params = (req.params ?? {}) as unknown as QueryParams;
    // For query operations we prefer the legacyEngine; if absent borrow any
    // session engine from the manager (model pool, settings are shared).
    const engine = this.legacyEngine ?? this.anyEngine();

    switch (params.type) {
      case "tools": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for tools query"),
          );
          return;
        }
        const registry = engine.getToolRegistry();
        const tools =
          typeof registry.listToolsDetailed === "function"
            ? registry
                .listToolsDetailed()
                .map((t: any) => ({ name: t.name, description: t.description ?? "" }))
            : registry.listTools().map((name: string) => ({ name, description: "" }));
        this.transport.send(createResponse(req.id, { type: "tools", data: tools }));
        break;
      }
      case "sessions": {
        if (this.chatManager) {
          // Return the ChatSessionManager's live sessions
          const sessions: Array<{
            sessionId: string;
            busy: boolean;
            queueDepth: number;
            lastActivityAt: number;
          }> = [];
          this.chatManager.forEachSession((s) => {
            sessions.push({
              sessionId: s.id,
              busy: s.isBusy(),
              queueDepth: s.queueDepth(),
              lastActivityAt: s.lastActivityAt,
            });
          });
          this.transport.send(createResponse(req.id, { type: "sessions", data: sessions }));
        } else if (engine) {
          const sessions = engine.getSessionManager().list();
          this.transport.send(createResponse(req.id, { type: "sessions", data: sessions }));
        } else {
          this.transport.send(createResponse(req.id, { type: "sessions", data: [] }));
        }
        break;
      }
      case "config": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for config query"),
          );
          return;
        }
        const config = engine.getConfig();
        this.transport.send(
          createResponse(req.id, {
            type: "config",
            data: {
              permissionMode: config.permissionMode ?? "default",
              planMode: engine.planMode ?? false,
              preset: config.preset,
              model: config.llm.model,
              cwd: config.cwd,
              maxContextTokens: config.maxContextTokens,
              // apiKey is redacted at this boundary: clients only get
              // hasApiKey + optional apiKeyPreview. See protocol/redact.ts.
              llm: redactLlmConfig(config.llm),
              // Resolved feature flags (defaults merged with settings overlay)
              // so the /features command can list current state.
              featureFlags: engine.getFeatureFlags(),
              // Effective permission rules so /permissions can list them (TODO 5.1).
              permissionRules: engine.getPermissionRules(),
            },
          }),
        );
        break;
      }
      case "session_detail": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for session_detail query"),
          );
          return;
        }
        if (params.sessionId) {
          try {
            const bundle = engine.getSessionManager().resume(params.sessionId);
            const data = {
              state: bundle.state,
              transcript: bundle.transcript.getEvents(),
            };
            this.transport.send(createResponse(req.id, { type: "session_detail", data }));
          } catch (err) {
            this.transport.send(
              createErrorResponse(req.id, ErrorCodes.SessionNotFound, (err as Error).message),
            );
          }
        } else {
          this.transport.send(
            createErrorResponse(
              req.id,
              ErrorCodes.InvalidParams,
              "sessionId required for session_detail",
            ),
          );
        }
        break;
      }
      case "compact": {
        const compactSessionId =
          typeof params.sessionId === "string" && params.sessionId.length > 0
            ? params.sessionId
            : undefined;
        let compactEngine: Engine | null | undefined = engine;

        if (this.chatManager) {
          if (compactSessionId) {
            let session = this.chatManager.get(compactSessionId);
            if (!session) {
              const probeEngine = this.anyEngine();
              if (!probeEngine?.sessionExistsOnDisk(compactSessionId)) {
                this.transport.send(
                  createErrorResponse(
                    req.id,
                    ErrorCodes.SessionNotFound,
                    `Session not found: ${compactSessionId}`,
                  ),
                );
                return;
              }
              try {
                session = this.chatManager.getOrCreate(compactSessionId, {
                  cwd: probeEngine.getSessionManager().readCwd(compactSessionId),
                } as any);
              } catch (err: any) {
                this.transport.send(
                  createErrorResponse(
                    req.id,
                    err.code ?? ErrorCodes.InternalError,
                    err.message,
                  ),
                );
                return;
              }
            }
            compactEngine = session.engine;
          } else {
            compactEngine = this.anyEngine();
          }
        }

        if (!compactEngine) {
          this.transport.send(
            createErrorResponse(
              req.id,
              ErrorCodes.InternalError,
              "No engine available for compact query",
            ),
          );
          return;
        }
        try {
          const result = await compactEngine.forceCompact(compactSessionId);
          if (result.strategy === "compacted" && result.before > result.after) {
            const event = {
              type: "context_compact",
              strategy: result.strategy,
              before: result.before,
              after: result.after,
            } satisfies StreamEvent;
            this.notify(Methods.StreamEvent, {
              sessionId: compactSessionId ?? "",
              event,
            });
          }
          this.transport.send(
            createResponse(req.id, {
              type: "compact",
              data: result,
            }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "models": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for models query"),
          );
          return;
        }
        const pool = engine.getModelPool();
        const models: import("./types.js").ProtocolModelEntry[] = pool.list().map((m) => ({
          key: m.key,
          label: m.label ?? m.key,
          model: m.model,
          protocol: m.provider,
          providerKey: m.providerKey,
          active: m.key === pool.getActiveKey(),
          maxOutputTokens: m.maxOutputTokens,
          maxContextTokens: m.maxContextTokens,
        }));
        this.transport.send(createResponse(req.id, { type: "models", data: models }));
        break;
      }
      case "providers": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for providers query"),
          );
          return;
        }
        try {
          const providersRaw = engine.readSetting("providers") as unknown;
          const modelsRaw = engine.readSetting("models") as unknown;
          const providerList = Array.isArray(providersRaw)
            ? (providersRaw as Array<Record<string, unknown>>)
            : [];
          const modelsList = Array.isArray(modelsRaw)
            ? (modelsRaw as Array<Record<string, unknown>>)
            : [];
          const counts = new Map<string, number>();
          for (const m of modelsList) {
            const pk = typeof m.providerKey === "string" ? m.providerKey : "";
            if (!pk) continue;
            counts.set(pk, (counts.get(pk) ?? 0) + 1);
          }
          const { readCache } = await import("../llm/model-cache.js");
          const { defaultCacheDir } = await import("../llm/model-cache.js");
          const cacheDir = defaultCacheDir();
          const enriched = providerList.map((p) => {
            const key = typeof p.key === "string" ? p.key : "";
            const cache = key ? readCache(cacheDir, key) : undefined;
            return {
              ...p,
              modelCount: counts.get(key) ?? 0,
              cachedModels: cache ? cache.models.length : undefined,
              cachedAt: cache ? cache.fetchedAt : undefined,
            };
          });
          // Strip apiKey / other secret-shaped fields from each provider
          // before sending. `...p` above spreads the whole provider record,
          // which includes apiKey verbatim — without this redact pass, any
          // protocol client could call query("providers") and harvest
          // credentials. The shared redactor preserves
          // presence-without-value (hasApiKey-style consumers still see the
          // field shape, just with [redacted] in place of the secret).
          const safe = redactSecrets(enriched);
          this.transport.send(createResponse(req.id, { type: "providers", data: safe }));
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "arena_status": {
        const status = getArenaStatus();
        this.transport.send(createResponse(req.id, { type: "arena_status", data: status }));
        break;
      }
      case "config_set": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for config_set"),
          );
          return;
        }
        try {
          const { key, value } = params;
          if (!key) throw new Error("key is required for config_set");
          // Refuse writes to trust-root fields via the generic config path. A
          // protocol peer (external driver, paired phone, compromised renderer)
          // could otherwise self-authorize tools or inject env/hooks/MCP servers,
          // which is equivalent to remotely bypassing workspace trust. Legit
          // writes to these go through the dedicated settings UI, not config_set;
          // provider/model edits use provider_add / models handlers below.
          if (isProtectedSettingKey(key)) {
            throw new Error(
              `config_set refused: "${key}" is a protected trust/permission field and cannot be written through this path.`,
            );
          }
          engine.updateConfig(key, value);
          // Echo back through the same secret-aware masker as config_get so
          // a `config_set("llm.apiKey", "...")` confirmation doesn't ship
          // the new secret through the response/log path.
          const safeValue = maskSecretValue(key, value);
          this.transport.send(createResponse(req.id, { type: "config_set", data: { key, value: safeValue } }));
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "config_get": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for config_get"),
          );
          return;
        }
        try {
          const { key } = params;
          if (!key) throw new Error("key is required for config_get");
          const value = engine.readSetting(key);
          // Mask secret-looking keys (apiKey/token/secret/…) at the boundary.
          const safeValue = maskSecretValue(key, value);
          this.transport.send(createResponse(req.id, { type: "config_get", data: { key, value: safeValue } }));
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "permission_set": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for permission_set"),
          );
          return;
        }
        try {
          const value = params.value as string | undefined;
          const valid = ["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan"];
          if (!value || !valid.includes(value)) {
            throw new Error(`invalid permission mode: ${value}`);
          }
          engine.setPermissionMode(value as NonNullable<EngineConfig["permissionMode"]>);
          this.transport.send(
            createResponse(req.id, {
              type: "permission_set",
              data: { mode: value },
            }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "provider_add": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for provider_add"),
          );
          return;
        }
        try {
          const cfg = params.provider as Record<string, unknown> | undefined;
          if (
            !cfg ||
            typeof cfg.key !== "string" ||
            typeof cfg.kind !== "string" ||
            typeof cfg.baseUrl !== "string"
          ) {
            throw new Error("provider_add: requires {key, kind, baseUrl, ...}");
          }
          const current = (engine.readSetting("providers") as unknown[] | undefined) ?? [];
          const next = [...current, cfg];
          engine.updateConfig("providers", next);
          this.transport.send(
            createResponse(req.id, { type: "provider_add", data: { ok: true, key: cfg.key } }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "provider_refresh": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for provider_refresh"),
          );
          return;
        }
        try {
          const key = params.key;
          if (!key) throw new Error("provider_refresh: key required");
          const providers =
            (engine.readSetting("providers") as Array<Record<string, unknown>> | undefined) ??
            [];
          const p = providers.find((x) => x.key === key);
          if (!p) throw new Error(`provider not found: ${key}`);
          const { fetchModelList } = await import("../llm/model-fetcher.js");
          const { defaultCacheDir } = await import("../llm/model-cache.js");
          const res = await fetchModelList(
            {
              key: p.key as string,
              kind: p.kind as never,
              baseUrl: p.baseUrl as string,
              apiKey: p.apiKey as string | undefined,
            },
            { cacheDir: defaultCacheDir(), refresh: true },
          );
          this.transport.send(
            createResponse(req.id, {
              type: "provider_refresh",
              data: { count: res.models.length, error: res.error },
            }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "provider_delete": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for provider_delete"),
          );
          return;
        }
        try {
          const key = params.key;
          if (!key) throw new Error("provider_delete: key required");
          const models =
            (engine.readSetting("models") as Array<Record<string, unknown>> | undefined) ?? [];
          const refs = models.filter((m) => m.providerKey === key).map((m) => m.key as string);
          if (refs.length > 0) {
            throw new Error(`provider ${key} referenced by models: ${refs.join(", ")}`);
          }
          const providers =
            (engine.readSetting("providers") as Array<Record<string, unknown>> | undefined) ??
            [];
          const next = providers.filter((p) => p.key !== key);
          engine.updateConfig("providers", next);
          this.transport.send(
            createResponse(req.id, { type: "provider_delete", data: { ok: true } }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "model_add": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for model_add"),
          );
          return;
        }
        try {
          const entry = params.model as Record<string, unknown> | undefined;
          if (!entry || typeof entry.key !== "string" || typeof entry.model !== "string") {
            throw new Error("model_add: requires {key, model, providerKey}");
          }
          const current = (engine.readSetting("models") as unknown[] | undefined) ?? [];
          const next = [...current, entry];
          engine.updateConfig("models", next);
          this.transport.send(
            createResponse(req.id, { type: "model_add", data: { ok: true, key: entry.key } }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      case "model_delete": {
        if (!engine) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for model_delete"),
          );
          return;
        }
        try {
          const key = params.key;
          if (!key) throw new Error("model_delete: key required");
          const current =
            (engine.readSetting("models") as Array<Record<string, unknown>> | undefined) ?? [];
          const next = current.filter((m) => m.key !== key);
          engine.updateConfig("models", next);
          this.transport.send(
            createResponse(req.id, { type: "model_delete", data: { ok: true } }),
          );
        } catch (err) {
          this.transport.send(
            createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
          );
        }
        break;
      }
      default:
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.InvalidParams,
            `Unknown query type: ${params.type}`,
          ),
        );
    }
  }

  // ─── Inject ─────────────────────────────────────────────────────

  private handleInject(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as InjectParams;
    if (!params.content || !params.sessionId) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "content and sessionId required"),
      );
      return;
    }
    // In the chatManager path, inject into the session's engine
    if (this.chatManager) {
      const s = this.chatManager.get(params.sessionId);
      if (!s) {
        this.transport.send(
          createErrorResponse(
            req.id,
            ErrorCodes.SessionClosed,
            `No such session: ${params.sessionId}`,
          ),
        );
        return;
      }
      try {
        s.engine.injectContext(params.sessionId, params.content);
        this.transport.send(createResponse(req.id, { ok: true }));
      } catch (err) {
        this.transport.send(
          createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
        );
      }
      return;
    }
    try {
      this.legacyEngine!.injectContext(params.sessionId, params.content);
      this.transport.send(createResponse(req.id, { ok: true }));
    } catch (err) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
      );
    }
  }

  // ─── Steer ──────────────────────────────────────────────────────
  // Queue a user message into the in-flight run's turn loop (不打断). Unlike
  // Inject (appends an assistant context msg for the NEXT run), Steer feeds a
  // user message to the CURRENT run's next step. No abort, no LLM trigger by
  // itself — the running loop picks it up at its next step boundary.
  private handleSteer(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as SteerParams;
    if (!params.text || !params.sessionId) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "text and sessionId required"),
      );
      return;
    }
    const engine = this.chatManager
      ? this.chatManager.get(params.sessionId)?.engine
      : this.legacyEngine;
    if (!engine) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.SessionClosed, `No such session: ${params.sessionId}`),
      );
      return;
    }
    try {
      const result = engine.enqueueSteer(
        params.sessionId,
        params.text,
        params.id,
        params.clientMessageId,
      );
      this.transport.send(createResponse(req.id, { ok: true, ...result }));
    } catch (err) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
      );
    }
  }

  private handleUnsteer(req: RpcRequest): void {
    const params = (req.params ?? {}) as unknown as UnsteerParams;
    if (!params.id || !params.sessionId) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "id and sessionId required"),
      );
      return;
    }
    const engine = this.chatManager
      ? this.chatManager.get(params.sessionId)?.engine
      : this.legacyEngine;
    if (!engine) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.SessionClosed, `No such session: ${params.sessionId}`),
      );
      return;
    }
    try {
      // removed=false means the loop already consumed it — not an error, the
      // host just learns it couldn't be revoked (it will arrive as a bubble).
      const removed = engine.unsteer(params.sessionId, params.id);
      this.transport.send(createResponse(req.id, { ok: true, removed }));
    } catch (err) {
      this.transport.send(
        createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
      );
    }
  }

  // ─── Client Communication ───────────────────────────────────────

  /**
   * Ask the client to approve a tool operation (legacy single-engine path).
   */
  private requestApprovalFromClient(request: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      const requestId = nanoid(12);
      const sessionId = typeof request.sessionId === "string" ? request.sessionId : undefined;
      this.pendingApprovals.set(requestId, resolve);

      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          this.approvalTimers.delete(requestId);
          resolve({ approved: false, reason: "approval timed out" });
        }
      }, AgentServer.APPROVAL_TIMEOUT_MS);
      this.approvalTimers.set(requestId, timer);

      this.notify(Methods.ApprovalRequest, {
        ...(sessionId ? { sessionId } : {}),
        requestId,
        request,
      });
    });
  }

  /**
   * Ask the client to answer a question from the agent (legacy single-engine path).
   */
  /**
   * Per-session AskUserQuestion for the chatManager path. Mirrors
   * requestAskUserFromClient but resolves via the SESSION's pendingApprovals
   * (the chatManager approve handler looks there, keyed by sessionId+requestId)
   * and tags the notify with sessionId so the renderer routes the question to
   * the right chat tab.
   */
  private requestAskUserForSession(
    session: import("./chat-session.js").ChatSession,
    sessionId: string,
    question: string,
    opts?: import("../tool-system/context.js").AskUserOptions,
  ): Promise<string> {
    return new Promise((resolve) => {
      const requestId = nanoid(12);
      session.pendingApprovals.set(requestId, (decision: unknown) => {
        this.clearApprovalTimer(requestId);
        const result = decision as ApprovalResult;
        if (result && typeof result === "object" && "approved" in result) {
          resolve(result.approved ? (result.answer ?? "") : (result.reason ?? "(user declined to answer)"));
        } else {
          // chatManager approve handler resolves with the raw decision value.
          resolve(typeof decision === "string" ? decision : "");
        }
      });

      const timer = setTimeout(() => {
        if (session.pendingApprovals.has(requestId)) {
          session.pendingApprovals.delete(requestId);
          this.approvalTimers.delete(requestId);
          resolve("(approval timed out)");
        }
      }, AgentServer.APPROVAL_TIMEOUT_MS);
      this.approvalTimers.set(requestId, timer);

      const args: Record<string, unknown> = { question };
      if (opts?.header !== undefined) args.header = opts.header;
      if (opts?.options !== undefined) args.options = opts.options;
      if (opts?.multiSelect !== undefined) args.multiSelect = opts.multiSelect;
      if (opts?.optionsOnly !== undefined) args.optionsOnly = opts.optionsOnly;

      this.notify(Methods.ApprovalRequest, {
        sessionId,
        requestId,
        request: {
          toolName: "__ask_user__",
          args,
          description: question,
          riskLevel: "low" as const,
        },
      });
    });
  }

  /**
   * Build a BrowserBridge whose every method routes a browser action to the
   * client over the session's pendingApprovals channel (same as askUser). The
   * client (Electron main) drives the webview via CDP and replies with a JSON
   * result string we parse back into the typed result. On timeout / malformed
   * reply we degrade to a safe error result rather than throwing.
   */
  private makeBrowserBridge(
    session: import("./chat-session.js").ChatSession,
    sessionId: string,
  ): import("../tool-system/browser-bridge.js").BrowserBridge {
    const call = (action: string, payload: Record<string, unknown>): Promise<any> =>
      this.requestBrowserActionForSession(session, sessionId, action, payload);
    return {
      snapshot: () => call("snapshot", {}),
      click: (ref) => call("click", { ref }),
      type: (ref, text) => call("type", { ref, text }),
      navigate: (url) => call("navigate", { url }),
      scroll: (dir, amount) => call("scroll", { dir, amount }),
      readContent: () => call("readContent", {}),
      extractLinks: () => call("extractLinks", {}),
      waitForLoad: (timeoutMs) => call("waitForLoad", { timeoutMs }),
      hover: (ref) => call("hover", { ref }),
      selectOption: (ref, value) => call("selectOption", { ref, value }),
      pressKey: (key, ref) => call("pressKey", { key, ref }),
      fetchImages: (refs) => call("fetchImages", { refs }),
      screenshot: (ref) => call("screenshot", { ref }),
      listTabs: () => call("listTabs", {}),
      switchTab: (tabId) => call("switchTab", { tabId }),
    };
  }

  private requestBrowserActionForSession(
    session: import("./chat-session.js").ChatSession,
    sessionId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<any> {
    return new Promise((resolve) => {
      const requestId = nanoid(12);
      session.pendingApprovals.set(requestId, (decision: unknown) => {
        this.clearApprovalTimer(requestId);
        // Main replies with { approved:true, answer:<json string> } (reusing the
        // ApprovalResult shape) or a raw json string. Parse → typed result.
        let raw: string | undefined;
        if (decision && typeof decision === "object" && "approved" in decision) {
          const r = decision as ApprovalResult;
          raw = r.approved ? r.answer : undefined;
        } else if (typeof decision === "string") {
          raw = decision;
        }
        if (raw === undefined) {
          resolve({ ok: false, detail: "browser action declined or unavailable" });
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ ok: false, detail: "malformed browser action result" });
        }
      });

      const timer = setTimeout(() => {
        if (session.pendingApprovals.has(requestId)) {
          session.pendingApprovals.delete(requestId);
          this.approvalTimers.delete(requestId);
          resolve({ ok: false, detail: "browser action timed out" });
        }
      }, AgentServer.APPROVAL_TIMEOUT_MS);
      this.approvalTimers.set(requestId, timer);

      this.notify(Methods.ApprovalRequest, {
        sessionId,
        requestId,
        request: {
          toolName: "__browser_action__",
          args: { action, ...payload },
          description: `browser:${action}`,
          riskLevel: "low" as const,
        },
      });
    });
  }

  /**
   * Ask the client (Electron main) to inject a cookie credential into the
   * built-in browser. Same pendingApprovals channel as browser actions; main
   * calls restoreCookiesToBrowser and replies with a JSON result string we
   * parse into { ok, count?, error? }. Degrades to ok:false on timeout/malformed.
   */
  private requestCredentialInjectForSession(
    session: import("./chat-session.js").ChatSession,
    sessionId: string,
    credentialId: string,
  ): Promise<{ ok: boolean; count?: number; error?: string }> {
    return new Promise((resolve) => {
      const requestId = nanoid(12);
      session.pendingApprovals.set(requestId, (decision: unknown) => {
        this.clearApprovalTimer(requestId);
        let raw: string | undefined;
        if (decision && typeof decision === "object" && "approved" in decision) {
          const r = decision as ApprovalResult;
          raw = r.approved ? r.answer : undefined;
        } else if (typeof decision === "string") {
          raw = decision;
        }
        if (raw === undefined) {
          resolve({ ok: false, error: "credential inject declined or unavailable" });
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ ok: false, error: "malformed credential inject result" });
        }
      });

      const timer = setTimeout(() => {
        if (session.pendingApprovals.has(requestId)) {
          session.pendingApprovals.delete(requestId);
          this.approvalTimers.delete(requestId);
          resolve({ ok: false, error: "credential inject timed out" });
        }
      }, AgentServer.APPROVAL_TIMEOUT_MS);
      this.approvalTimers.set(requestId, timer);

      this.notify(Methods.ApprovalRequest, {
        sessionId,
        requestId,
        request: {
          toolName: "__credential_action__",
          args: { action: "injectCookie", credentialId },
          description: `credential:inject:${credentialId}`,
          riskLevel: "low" as const,
        },
      });
    });
  }

  private requestAskUserFromClient(
    question: string,
    opts?: import("../tool-system/context.js").AskUserOptions,
  ): Promise<string> {
    return new Promise((resolve) => {
      const requestId = nanoid(12);
      this.pendingApprovals.set(requestId, (result: ApprovalResult) => {
        this.clearApprovalTimer(requestId);
        if (result.approved) {
          resolve(result.answer ?? "");
        } else {
          resolve(result.reason ?? "(user declined to answer)");
        }
      });

      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          this.approvalTimers.delete(requestId);
          resolve("(approval timed out)");
        }
      }, AgentServer.APPROVAL_TIMEOUT_MS);
      this.approvalTimers.set(requestId, timer);

      const args: Record<string, unknown> = { question };
      if (opts?.header !== undefined) args.header = opts.header;
      if (opts?.options !== undefined) args.options = opts.options;
      if (opts?.multiSelect !== undefined) args.multiSelect = opts.multiSelect;
      if (opts?.optionsOnly !== undefined) args.optionsOnly = opts.optionsOnly;

      this.notify(Methods.ApprovalRequest, {
        requestId,
        request: {
          toolName: "__ask_user__",
          args,
          description: question,
          riskLevel: "low" as const,
        },
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.transport.send(createNotification(method, params));
  }

  /**
   * Get any available engine — used for global query/configure ops when
   * chatManager is present but no legacyEngine was supplied. Prefer a live chat
   * session; before the first user turn, lazily build a detached engine through
   * the manager's factory so global UI surfaces (/login, model manager, model
   * selector) can query models/providers without requiring a chat session first.
   */
  private anyEngine(): Engine | null {
    if (!this.chatManager) return null;
    const sessions: Map<string, any> = (this.chatManager as any).sessions;
    const first = sessions.values().next().value;
    if (first) return first.engine as Engine;
    if (this.globalQueryEngine) return this.globalQueryEngine;

    const factory = (this.chatManager as any).factory as
      | ((slice: Partial<EngineConfig>) => Engine)
      | undefined;
    if (typeof factory !== "function") return null;
    this.globalQueryEngine = factory({});
    return this.globalQueryEngine;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  close(): void {
    // Detach the bg-agent bus subscription first so a final flurry of
    // completions during shutdown can't race the `shutdown` status
    // notify below. Safe to call repeatedly — the unsubscribe is a
    // single-shot Set.delete.
    if (this.bgAgentBusUnsubscribe) {
      try {
        this.bgAgentBusUnsubscribe();
      } catch {
        // swallow
      }
      this.bgAgentBusUnsubscribe = null;
    }

    if (this.chatManager) {
      this.chatManager.closeAll();
    }

    // Legacy path cleanup
    if (this.abortController) {
      try {
        this.abortController.abort("server closing");
      } catch {
        // swallow
      }
    }

    for (const [, resolve] of this.pendingApprovals) {
      resolve({ approved: false, reason: "server closing" });
    }
    this.pendingApprovals.clear();
    this.clearAllApprovalTimers();

    this.notify(Methods.Status, { status: "shutdown" });
    this.transport.close();
  }

  private clearApprovalTimer(requestId: string): void {
    const timer = this.approvalTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.approvalTimers.delete(requestId);
    }
  }

  /**
   * Resolve all of a chat session's pending approvals as cancelled and clear
   * the matching server-side approval timers. Used by handleCancel's
   * per-session path so a Stop while a tool is awaiting approval doesn't leave
   * the tool hanging until APPROVAL_TIMEOUT_MS (and leak the timer). Each
   * requestId in the session map has a same-keyed entry in this.approvalTimers
   * (see requestAskUserForSession / makeBrowserBridge).
   */
  private cancelSessionApprovals(session: import("./chat-session.js").ChatSession): void {
    for (const [requestId, resolve] of session.pendingApprovals) {
      this.clearApprovalTimer(requestId);
      try {
        resolve({ approved: false, reason: "cancelled" });
      } catch {
        /* a resolver must never break cancel cleanup */
      }
    }
    session.pendingApprovals.clear();
  }

  private clearAllApprovalTimers(): void {
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
  }
}

function isValidPermissionMode(value: unknown): value is PermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "dontAsk" ||
    value === "bypassPermissions" ||
    value === "auto" ||
    value === "plan"
  );
}
