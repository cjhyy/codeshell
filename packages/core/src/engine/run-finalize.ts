/**
 * Run finalize — the headless background-agent drain loop, the success-path
 * epilogue (persistence, hooks, memory pipeline trigger, session title,
 * result assembly) and the initialization-failure terminal result.
 */
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
import {
  buildNotificationMessage,
  notificationQueue,
} from "../tool-system/builtin/agent-notifications.js";
import { logger } from "../logging/logger.js";
import { recordSessionEnd } from "../logging/session-recorder.js";
import {
  isEphemeralSessionState,
  type SessionBundle,
  type SessionStateFieldPatch,
} from "../session/session-manager.js";
import { foldRunUsage, type CumulativeUsageCounters } from "../session/usage.js";
import type { GoalTerminationReason } from "../goal/lifecycle.js";
import type { LegacyPetWorkDelegation, Message, TokenUsage } from "../types.js";
import type { LLMUsageTracker } from "../llm/types.js";
import type { LLMClientBase } from "../llm/client-base.js";
import type { HookEventName, HookResult } from "../hooks/events.js";
import { buildSessionTitle } from "./session-title.js";
import { formatFriendlyError } from "./friendly-error.js";
import { stripInjectedContextMessages } from "./injected-context-cache.js";
import type { TurnLoop } from "./turn-loop.js";
import type { EngineResult } from "./types.js";
import type { EngineRunOptions, RunBehaviorProfile } from "./run-types.js";

type TurnLoopRunResult = Awaited<ReturnType<TurnLoop["run"]>>;

/** engine.ts:headless 一次性 run 的后台子代理排水循环。 */
export async function drainHeadlessBackgroundAgents(args: {
  sid: string;
  session: SessionBundle;
  signal: AbortSignal | undefined;
  initialResult: TurnLoopRunResult;
  runTurnLoop: (messages: Message[]) => Promise<TurnLoopRunResult>;
  applyGoalTermination: (
    termination: GoalTerminationReason | undefined,
    round: number | undefined,
  ) => void;
  waitForBackgroundAgentChange: (sid: string, signal?: AbortSignal) => Promise<boolean>;
  waitForBackgroundAgentChangeOrTimeout: (sid: string, ms: number) => Promise<boolean>;
  getFirstGoalTermination: () => GoalTerminationReason | undefined;
  setFirstGoalTermination: (t: GoalTerminationReason | undefined) => void;
}): Promise<TurnLoopRunResult> {
  const { sid, session } = args;
  let result = args.initialResult;
  let aborted = args.signal?.aborted === true;
  // Loop: a summarize turn can spawn a NEW background sub-agent; keep
  // draining + summarizing until none remain. turnCount accumulates, so
  // the turn-loop's maxTurns still bounds runaway re-summarization.
  for (;;) {
    while (!aborted && asyncAgentRegistry.hasRunningForSession(sid)) {
      aborted = await args.waitForBackgroundAgentChange(sid, args.signal);
    }
    let pending = notificationQueue.drainAll(sid);
    if (aborted && pending.length === 0) {
      // Abort race: an agent calls markCompleted (registry notify) and only
      // THEN enqueue (queue notify) as two separate statements. If the abort
      // fired before that agent's completion `.then` ran, the while above
      // exited on `aborted`, this drainAll caught nothing, and a naive
      // `break` here would drop the agent's output. Give still-settling
      // agents a bounded window to finish enqueuing, then drain once more.
      // Each wait is timeout-bounded so a genuinely stuck (never-completing)
      // agent can't hang abort cleanup forever — we'd rather lose nothing in
      // the common case and not hang in the pathological one.
      for (let i = 0; i < 20 && asyncAgentRegistry.hasRunningForSession(sid); i++) {
        const changed = await args.waitForBackgroundAgentChangeOrTimeout(sid, 25);
        if (!changed) break; // timed out with no state change → stop waiting
      }
      pending = notificationQueue.drainAll(sid);
      if (pending.length === 0) break;
    } else if (pending.length === 0) {
      break;
    }
    const injected: Message = {
      role: "user",
      content: `<system-reminder>\n${buildNotificationMessage(pending)}\n</system-reminder>`,
    };
    if (aborted || args.getFirstGoalTermination()) {
      // Mark injected: a synthetic notification, not the user's own input —
      // the disk reader drops it on replay so no phantom user bubble.
      // A goal termination is also a hard boundary: retain the notification
      // for recovery, but never re-enter TurnLoop (which would reset its
      // run-scoped goal budget tracker and could overwrite the first reason).
      session.transcript.appendMessage(injected.role, injected.content, { injected: true });
      result = { ...result, messages: [...result.messages, injected] };
      break;
    }
    result = await args.runTurnLoop([...result.messages, injected]);
    args.setFirstGoalTermination(args.getFirstGoalTermination() ?? result.goalTermination);
    args.applyGoalTermination(result.goalTermination, result.goalTerminationRound);
  }
  return result;
}

/** engine.ts:成功路径收尾(缓存/日志/钩子/记忆/标题/终态/结果)。 */
export async function finalizeRunSuccess(args: {
  session: SessionBundle;
  result: TurnLoopRunResult;
  firstGoalTermination: GoalTerminationReason | undefined;
  turnCount: number; // turnLoop.currentTurn
  getRunUsage: () => LLMUsageTracker;
  usageBaseline: TokenUsage;
  userContextMsg: Message | null;
  dynamicContextMsg: Message | null;
  setCompactedMessages: (sid: string, messages: Message[]) => void;
  setLastMessages: (messages: Message[]) => void;
  options: EngineRunOptions | undefined;
  emitHook: (
    event: HookEventName,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<HookResult>;
  cwd: string;
  llmClient: LLMClientBase;
  auxSummaryClient: LLMClientBase;
  recordExternalBilledUsage: (usage: TokenUsage) => CumulativeUsageCounters;
  runMemoryPipeline: (
    transcript: SessionBundle["transcript"],
    sessionId: string,
    cwd: string,
    llmClient: LLMClientBase,
    recordExternalBilledUsage: (usage: TokenUsage) => CumulativeUsageCounters,
  ) => Promise<void> | void;
  updatePersistedSessionState: (sid: string, patch: SessionStateFieldPatch) => void;
  persistFinalRunState: (state: SessionBundle["state"]) => void;
  markRunAccountingFinalized: () => void;
  costStoreSerialize: (() => Record<string, unknown>) | undefined;
  profile: RunBehaviorProfile | undefined;
  getProfileReportedResults: () => Record<string, unknown> | undefined;
}): Promise<EngineResult> {
  const {
    session,
    result,
    firstGoalTermination,
    turnCount,
    getRunUsage,
    usageBaseline,
    userContextMsg,
    dynamicContextMsg,
    options,
    cwd,
    llmClient,
    auxSummaryClient,
    recordExternalBilledUsage,
    profile,
  } = args;
  args.setLastMessages(result.messages);
  const cachedMessages = stripInjectedContextMessages(
    result.messages,
    userContextMsg,
    dynamicContextMsg,
  );
  args.setCompactedMessages(session.state.sessionId, cachedMessages);

  logger.info("engine.done", {
    sessionId: session.state.sessionId,
    reason: result.reason,
    turns: turnCount,
    tokens: getRunUsage().totalTokens,
  });
  recordSessionEnd(session.state.sessionId, {
    reason: result.reason,
    turns: turnCount,
    cost: getRunUsage(),
  });

  // Session-level hook: fired symmetrically with on_session_start once
  // the turn loop has resolved (completion, error, or abort). Handlers
  // are notify-only — any returned messages are dropped because the run
  // is already over and there's no next turn to inject into.
  await args.emitHook(
    "on_session_end",
    {
      sessionId: session.state.sessionId,
      reason: result.reason,
      turnCount,
    },
    options?.signal,
  );

  // Ephemeral side chats must never leak into durable memory, even after
  // the user explicitly elevates tool permissions for a turn. Lifecycle
  // isolation is independent of the run-scoped behavior/permission mode.
  if (!isEphemeralSessionState(session.state)) {
    // Fire-and-forget memory pipeline: extract durable memories from the
    // transcript, save a session summary, and conditionally trigger
    // auto-dream consolidation. Doesn't block the Engine result.
    void args.runMemoryPipeline(
      session.transcript,
      session.state.sessionId,
      cwd,
      llmClient,
      recordExternalBilledUsage,
    );
  }

  // Fire-and-forget session title generation — only after the FIRST turn.
  // Reuses the already-resolved auxSummaryClient (aux model, cheap). Best-
  // effort: failures never touch the run result. The renderer writes the
  // title into the sidebar on receipt of the session_title stream event.
  {
    const messageEvents = session.transcript.getEvents("message");
    const userMsgEvents = messageEvents.filter(
      (e) => (e.data as { role?: string }).role === "user",
    );
    const userMsgCount = userMsgEvents.length;
    const onStream = options?.onStream;
    if (userMsgCount === 1 && onStream && result.text) {
      const sessionId = session.state.sessionId;
      const rawContent = (userMsgEvents[0]?.data as { content?: unknown })?.content;
      const firstUserText =
        typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
      void buildSessionTitle(
        auxSummaryClient,
        firstUserText,
        result.text,
        recordExternalBilledUsage,
      )
        .then((title) => {
          if (title) {
            // Persist the title so it survives a localStorage wipe / disk
            // rebuild — it used to live only in the renderer's localStorage
            // index. Read the latest persisted state at callback time and
            // merge only title; the completed run's session.state snapshot
            // may already be stale after later serial session updates.
            args.updatePersistedSessionState(sessionId, { title });
            onStream({
              type: "session_title",
              sessionId,
              title,
            });
          }
        })
        .catch(() => {});
    }
  }

  // Update session state. Persist the raw terminal reason as the status so
  // callers can distinguish user-cancelled (aborted_streaming) from real
  // failures (model_error, prompt_too_long, ...) — previously every
  // non-completed outcome collapsed to "errored", which threw away the
  // distinction and misled anyone reading state.json.
  const transcriptFlushFailed = session.transcript.flushFailed();
  if (transcriptFlushFailed) {
    const failure = session.transcript.getFlushFailure();
    logger.error("engine.transcript_persistence_failed", {
      sessionId: session.state.sessionId,
      terminalReason: result.reason,
      degraded: true,
      ...failure,
    });
  }
  options?.onAgentProgress?.({ type: "phase", phase: "finalizing" });
  session.state.turnCount = turnCount;
  session.state.status = result.reason;
  if (result.reason === "completed" && result.completionKind) {
    session.state.lastCompletionKind = result.completionKind;
  } else {
    delete session.state.lastCompletionKind;
  }
  if (result.reason === "completed") {
    session.state.completedSnapshotVersion = 1;
    if (!transcriptFlushFailed) {
      session.state.completedThroughEventId = session.transcript.getEvents().at(-1)?.id;
    }
  }
  // Session-cumulative (baseline + this run) for persistence...
  const usage = getRunUsage();
  session.state.tokenUsage = foldRunUsage(usageBaseline, usage);
  if (args.costStoreSerialize) {
    session.state.costState = args.costStoreSerialize();
  }
  args.persistFinalRunState(session.state);
  args.markRunAccountingFinalized();

  // Hook: agent end
  await args.emitHook(
    "on_agent_end",
    {
      sessionId: session.state.sessionId,
      reason: result.reason,
      turnCount,
    },
    options?.signal,
  );

  // Emit completion
  options?.onStream?.({
    type: "turn_complete",
    reason: result.reason,
    ...(result.completionKind ? { completionKind: result.completionKind } : {}),
  });

  // Structured results the active profile's run services reported, keyed
  // by profile id. petWorkDelegation stays as a compat mirror of
  // extensions.pet?.workDelegation until pet-aware hosts migrate.
  const profileReportedResults = args.getProfileReportedResults();
  const runExtensions =
    profile && profileReportedResults ? { [profile.id]: profileReportedResults } : undefined;
  const petWorkDelegationMirror = (
    runExtensions?.pet as { workDelegation?: LegacyPetWorkDelegation } | undefined
  )?.workDelegation;

  return {
    text: result.text,
    reason: result.reason,
    goalTermination: firstGoalTermination,
    sessionId: session.state.sessionId,
    turnCount,
    usage: {
      promptTokens: usage.totalPromptTokens,
      completionTokens: usage.totalCompletionTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.totalCacheReadTokens,
      cacheCreationTokens: usage.totalCacheCreationTokens,
    },
    ...(runExtensions ? { extensions: runExtensions } : {}),
    ...(petWorkDelegationMirror ? { petWorkDelegation: petWorkDelegationMirror } : {}),
  };
}

/** engine.ts catch 体:初始化失败 → model_error 终态 + 错误结果。 */
export function buildRunFailureResult(args: {
  err: unknown;
  session: SessionBundle;
  options: EngineRunOptions | undefined;
  persistFinalRunState: (state: SessionBundle["state"]) => void;
}): EngineResult {
  const { err, session, options } = args;
  // The session is already persisted as active before runWithSid starts.
  // Initialization failures (client creation, MCP connection, prompt/hooks)
  // therefore need the same terminal lifecycle treatment as turn-loop errors.
  const error = formatFriendlyError(err);
  session.state.status = "model_error";
  delete session.state.lastCompletionKind;
  args.persistFinalRunState(session.state);
  session.transcript.appendError(error, { phase: "initialization" });
  logger.error("engine.run_lifecycle_failed", {
    sessionId: session.state.sessionId,
    error: err instanceof Error ? err.message : String(err),
  });
  recordSessionEnd(session.state.sessionId, {
    reason: "model_error",
    turns: session.state.turnCount,
  });
  options?.onStream?.({ type: "error", error });
  options?.onStream?.({ type: "turn_complete", reason: "model_error" });

  const usage = session.state.tokenUsage;
  return {
    text: `ERROR: ${error}`,
    reason: "model_error",
    sessionId: session.state.sessionId,
    turnCount: session.state.turnCount,
    usage: {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    },
  };
}
