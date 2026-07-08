/**
 * Turn loop — state machine implementation.
 *
 * Following Claude Code's po_() pattern:
 * pre_check → model_call → post_check → tool_exec → context_mgmt → hook_notify → next turn
 */

import type {
  Message,
  StreamCallback,
  TerminalReason,
  ContentBlock,
  ToolResult,
  LLMResponse,
  TokenUsage,
  ContextUsageAnchor,
} from "../types.js";
import type { TurnState } from "./turn-state.js";
import type { SteerItem } from "./steer-queue.js";
import { initialTurnState, newTurnId } from "./turn-state.js";
import { ModelFacade } from "./model-facade.js";
import { formatFriendlyError } from "./friendly-error.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { ContextManager } from "../context/manager.js";
import { HookRegistry } from "../hooks/registry.js";
import type { HookEventName, HookResult } from "../hooks/events.js";
import { wrapHookMessages } from "../hooks/inject.js";
import { Transcript } from "../session/transcript.js";
import { ContextLimitError } from "../exceptions.js";
import { logger } from "../logging/logger.js";
import { checkTokenBudget, type BudgetTracker, createBudgetTracker } from "./token-budget.js";
import { StreamingToolQueue } from "./streaming-tool-queue.js";
import {
  downgradeImagePayloadsInHistory,
  estimateTokens,
  messageHasBase64ImagePayload,
} from "../context/compaction.js";
import { isTruncatedStop } from "../llm/stop-reason.js";
import { isAbortError } from "../llm/client-base.js";
import { crossedReactiveThreshold } from "./reactive-threshold.js";
import { COMPLETE_GOAL_TOOL_NAME } from "../tool-system/builtin/complete-goal.js";
import { CANCEL_GOAL_TOOL_NAME } from "../tool-system/builtin/cancel-goal.js";
import {
  addTokenUsage,
  cacheHitRateFromUsage,
  cumulativeCacheHitRate,
  type CumulativeUsageCounters,
} from "./session-usage.js";
import {
  type GoalConfig,
  type GoalBudgetTracker,
  type GoalExtension,
  createGoalBudgetTracker,
  recordGoalUsage,
  goalBudgetExceeded,
  applyGoalExtension,
  limitProximity,
  GOAL_DEFAULT_MAX_STOP_BLOCKS,
} from "./goal.js";

export interface TurnLoopConfig {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  tokenBudget?: number;
  onStream?: StreamCallback;
  signal?: AbortSignal;
  /**
   * Image-bearing messages added for the current request and not yet consumed
   * by the model. TurnLoop preserves their base64 for one successful model
   * response, then downgrades them to placeholders in the working history.
   */
  freshImageMessages?: Iterable<Message>;
  /**
   * Fired after each turn boundary is recorded. Lets the engine flush an
   * up-to-date snapshot to state.json mid-run, so a long run doesn't leave
   * the on-disk turnCount/status frozen at the last completion.
   */
  onTurnBoundary?: (turnCount: number) => void;
  /**
   * Goal mode: the normalized GoalConfig (objective + optional token/time
   * budgets), passed to on_stop handlers via ctx.data.goal so the
   * GoalStopHook can judge completion. The run-scoped budget tracker reads
   * the budgets to force-stop an unattended run. Undefined when no goal is
   * set (on_stop still fires but built-in Goal handler is a no-op without it).
   */
  goal?: GoalConfig;
  /**
   * Max consecutive times an on_stop handler may block termination before
   * the loop forces a stop, mirroring Claude Code's stop-hook block cap.
   * Resets to 0 whenever a turn completes without being blocked. Defaults
   * to GOAL_DEFAULT_MAX_STOP_BLOCKS. Independent of maxTurns, which still
   * bounds total turns.
   */
  maxStopBlocks?: number;
}

export interface CtxOverheadStore {
  /** Tokens for system prompt + tool defs, derived from provider's promptTokens. */
  get(sid: string): number;
  set(sid: string, tokens: number): void;
}

export interface TurnLoopDeps {
  model: ModelFacade;
  toolExecutor: ToolExecutor;
  contextManager: ContextManager;
  hooks: HookRegistry;
  transcript: Transcript;
  systemPrompt: string;
  tools: import("../types.js").ToolDefinition[];
  /** Per-sid overhead cache so the ctx bar doesn't drop between turns. */
  ctxOverheadStore: CtxOverheadStore;
  /** Current session id, used to key the overhead store. */
  sessionId: string;
  /**
   * Carried into every hook emit's `ctx.data.isSubAgent` so handlers can
   * skip noisy injections for spawned children. Set by Engine from
   * EngineConfig.isSubAgent (engine.ts:119).
   */
  isSubAgent?: boolean;
  /**
   * Reads/clears the most recent compaction event emitted by
   * ContextManager since the last call. Returns `null` if no compaction
   * fired since the previous check. The Engine wires this up so the
   * turn loop can `post_compact` emit + inject hook messages without
   * the ContextManager itself depending on HookRegistry.
   */
  consumePendingCompactInfo?: () => {
    strategy: string;
    before: number;
    after: number;
  } | null;
  /**
   * Records one LLM response into the session-monotonic cumulative counters.
   * Returns the updated counters so usage_update can carry both metric scopes.
   */
  recordCumulativeUsage?: (usage: TokenUsage) => CumulativeUsageCounters;
  /** Persist the latest context-estimation anchor derived from provider usage. */
  recordContextUsageAnchor?: (anchor: ContextUsageAnchor) => void;
  /**
   * Reads/clears any user messages queued for THIS session via the steering
   * channel (Engine.enqueueSteer) while a run is in flight. Consumed at the top
   * of each turn so the messages join the next LLM request WITHOUT aborting the
   * current run — the "不打断、步间隙注入" path (vs the relay abort+resend).
   * Returns [] when nothing is queued. Wired by Engine; absent in standalone
   * tests (turn loop tolerates undefined).
   */
  consumeSteer?: (source?: "normal_step" | "finalize_backfill") => SteerItem[];
  /**
   * Execution-level idempotency guard for host-supplied user/steer intents.
   * Returns false only when a present clientMessageId has already entered this
   * run or the persisted transcript. Messages without an id bypass this guard.
   */
  claimClientMessageId?: (clientMessageId: string, source: "steer") => boolean;
  /**
   * Clear this session's PERSISTED goal (state.activeGoal) and drop the
   * in-flight goal-stop hook, so a user-initiated cancel_goal both stops the
   * current run AND prevents the goal from re-inheriting on the next bare send.
   * Wired by Engine (delegates to Engine.clearGoal for the running session);
   * absent in standalone tests (turn loop tolerates undefined — the local
   * goalTracker short-circuit still stops the run).
   */
  clearPersistedGoal?: () => void;
}

export interface TurnLoopResult {
  text: string;
  reason: TerminalReason;
  messages: Message[];
}

/**
 * 把一个 ToolResult 映射成发给 LLM 的 tool_result ContentBlock。
 * 有 contentBlocks(view_image 的图片块)就原样用作 content;否则
 * 用文本(成功用 result,失败用 "Error: ...")。抽成纯函数以便单测。
 */
export function toolResultToBlock(result: ToolResult): ContentBlock {
  const block: ContentBlock = {
    type: "tool_result",
    tool_use_id: result.id,
    content: result.error
      ? `Error: ${result.error}`
      : (result.contentBlocks ?? result.result ?? "(no output)"),
  };
  if (result.isError || result.error) block.is_error = true;
  return block;
}

export class TurnLoop {
  private turnCount = 0;
  /** Tool IDs already emitted as tool_use_start during streaming (to avoid duplicates). */
  private streamedToolIds = new Set<string>();
  /**
   * Turn-scoped child logger set at the top of each loop iteration. Class
   * methods invoked inside the iteration (callModelWithFallback,
   * executeToolCall, ...) read it instead of using the root `logger`, so
   * every line they write is tagged with the current turn/turnId.
   */
  private currentTurnLog: ReturnType<typeof logger.child> = logger;

  /** Last emitted ctx token estimate; used to skip no-op usage_update events. */
  private lastCtxEmit = -1;
  private currentTurnUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  private currentCumulativeUsage: CumulativeUsageCounters | undefined;
  private readonly pendingImageMessages = new Set<Message>();

  /**
   * Consecutive on_stop blocks (Goal mode kept the agent going). Reset to 0
   * on any unblocked completion. When it reaches config.maxStopBlocks the
   * loop forces a stop so a stuck goal can't loop forever.
   */
  private stopBlockCount = 0;

  /**
   * Run-scoped goal budget tracker (Goal mode). Hoisted to an instance field
   * (not a run() local) so extend() can bump its budgets mid-run. Null when no
   * goal or between runs.
   */
  private goalTracker: GoalBudgetTracker | null = null;

  /**
   * Whether an approaching_limit marker was already emitted for the current
   * ceiling. Reset when the run advances past the moment (a fresh extension, or
   * the goal completing) so the next approach re-announces. Prevents the marker
   * being re-emitted every turn while still within the approach threshold.
   */
  private approachAnnounced = false;

  /**
   * Extend the in-flight run's limits (TODO 3.1 — 运行中续轮/加预算). Mutates
   * the maxTurns ceiling, the maxStopBlocks cap, and/or the live goal budgets;
   * the loop re-reads all of them each turn so the change takes effect on the
   * next iteration. No-op for fields not supplied. Returns the resulting
   * effective limits.
   */
  extend(opts: GoalExtension): {
    maxTurns: number;
    tokenBudget?: number;
    timeBudgetMs?: number;
    maxStopBlocks: number;
  } {
    const elapsedMs = this.goalTracker ? Date.now() - this.goalTracker.startedAtMs : 0;
    const next = applyGoalExtension(
      this.config.maxTurns,
      this.goalTracker?.goal,
      this.goalTracker?.tokensUsed ?? 0,
      elapsedMs,
      opts,
    );
    this.config = { ...this.config, maxTurns: next.maxTurns };
    if (this.goalTracker) {
      // Replace the goal object rather than mutating its fields: the tracker's
      // goal may be a shared/frozen reference, and goalBudgetExceeded reads
      // tracker.goal.{tokenBudget,timeBudgetMs} live, so a fresh object with the
      // new caps takes effect on the next turn either way.
      this.goalTracker.goal = {
        ...this.goalTracker.goal,
        tokenBudget: next.tokenBudget,
        timeBudgetMs: next.timeBudgetMs,
      };
    }
    // Raise the consecutive-stop-block cap — for a re-blocked goal this is the
    // limit that actually bites, so an extend that only bumped maxTurns/budgets
    // couldn't keep it going. Resolve the current cap the same way the loop does.
    const curCap = this.config.maxStopBlocks ?? GOAL_DEFAULT_MAX_STOP_BLOCKS;
    const nextCap =
      typeof opts.addStopBlocks === "number" && opts.addStopBlocks > 0
        ? curCap + Math.floor(opts.addStopBlocks)
        : curCap;
    this.config = { ...this.config, maxStopBlocks: nextCap };

    // ANY extension resets the consecutive stop-block streak: the user just
    // asked to keep going, so a goal that was repeatedly re-blocked shouldn't be
    // immediately re-capped. (Previously only addTurns reset it, leaving a
    // budget-only extension unable to un-stick a capped goal.)
    const extended =
      (opts.addTurns ?? 0) > 0 ||
      (opts.addStopBlocks ?? 0) > 0 ||
      (opts.addTokenBudget ?? 0) > 0 ||
      (opts.addTimeBudgetMs ?? 0) > 0;
    if (extended) {
      this.stopBlockCount = 0;
      // Let the next approach re-announce against the raised ceilings.
      this.approachAnnounced = false;
    }
    return { ...next, maxStopBlocks: nextCap };
  }

  /**
   * Goal mode only: if the run is nearing EITHER stop ceiling (maxTurns or
   * maxStopBlocks) and we haven't announced it yet, emit one approaching_limit
   * marker so the UI can offer a "再续" button while the run is still live.
   * Watches both limits because a re-blocked goal hits the stop-block cap long
   * before maxTurns. Idempotent within an approach window via approachAnnounced.
   */
  private maybeAnnounceApproachingLimit(): void {
    if (!this.config.goal || this.approachAnnounced) return;
    const cap = this.config.maxStopBlocks ?? GOAL_DEFAULT_MAX_STOP_BLOCKS;
    const prox = limitProximity(this.turnCount, this.config.maxTurns, this.stopBlockCount, cap);
    if (!prox.approaching) return;
    this.approachAnnounced = true;
    this.config.onStream?.({
      type: "goal_progress",
      status: "approaching_limit",
      round: this.stopBlockCount,
      turnsRemaining: prox.turnsRemaining,
      stopBlocksRemaining: prox.stopBlocksRemaining,
      nearest: prox.nearest,
    });
  }

  constructor(
    private readonly deps: TurnLoopDeps,
    // Not readonly: extend() bumps maxTurns mid-run (TODO 3.1), and the
    // constructor below rewrites onStream. The loop reads config fields fresh
    // each turn so mutations take effect on the next iteration.
    private config: TurnLoopConfig,
  ) {
    for (const msg of this.config.freshImageMessages ?? []) {
      this.pendingImageMessages.add(msg);
    }

    // Wrap onStream so a single throwing handler can't silently break
    // the channel for the rest of the run. A 2026-05-25 incident saw a
    // sub-agent's events stop reaching the renderer ~23s into its run —
    // the engine kept executing tools, but every subsequent stream emit
    // was happening into a dead pipe. With this guard the failure shows
    // up in ~/.code-shell/logs/engine-*.log with the offending event
    // type, instead of presenting as a frozen UI.
    //
    // We replace `config.onStream` so the wrap covers BOTH direct calls
    // (`this.config.onStream?.({...})` inside this class) AND places
    // where the reference is passed onward (ModelFacade, StreamingToolQueue).
    if (this.config.onStream) {
      const inner = this.config.onStream;
      this.config = {
        ...this.config,
        onStream: (event) => {
          try {
            inner(event);
          } catch (err) {
            // Use root logger, not currentTurnLog — this can fire from
            // outside a turn iteration (e.g. ModelFacade after run() resolves).
            logger.warn("stream.handler_threw", {
              eventType: (event as { type?: string }).type,
              error: (err as Error).message,
              stack: (err as Error).stack?.split("\n").slice(0, 4).join("\n"),
            });
          }
        },
      };
    }
  }

  /**
   * Emit a lifecycle hook with isSubAgent + sessionId auto-merged into data.
   * Returns the aggregated HookResult so callers can consume `messages` /
   * `decision` / `stop`. Use this instead of `deps.hooks.emit` directly so
   * every emit carries the same context envelope.
   */
  /**
   * Persist a turn_stopped marker on a user Stop so a resume can rebuild the
   * renderer's "你在 Ns 后停止了" line (the in-memory turn_end is lost on reload,
   * which makes the interrupted turn fold behind the process-card header).
   * Skipped for sub-agents — their signal.aborted is usually a parent abort,
   * not a user Stop, and sub-agent turns aren't shown as interruptible. The
   * underlying append is idempotent, so calling this at several abort returns
   * for one Stop still writes a single marker.
   */
  private markStopped(): void {
    if (this.deps.isSubAgent === true) return;
    this.deps.transcript.appendTurnStopped();
  }

  private prepareMessagesForModel(messages: Message[]): Message[] {
    const preserveMessages =
      this.pendingImageMessages.size > 0 ? this.pendingImageMessages : undefined;
    const result = downgradeImagePayloadsInHistory(messages, { preserveMessages });
    if (result.replacedCount > 0) {
      this.currentTurnLog.info("context.image_payload_downgrade", {
        cat: "context",
        images: result.replacedCount,
        pendingFresh: this.pendingImageMessages.size,
      });
    }
    return result.messages;
  }

  private markPendingImagesConsumed(messages: Message[]): Message[] {
    if (this.pendingImageMessages.size === 0) return messages;
    const consumedMessages = this.pendingImageMessages.size;
    this.pendingImageMessages.clear();
    const result = downgradeImagePayloadsInHistory(messages);
    if (result.replacedCount > 0) {
      this.currentTurnLog.info("context.image_payload_consumed", {
        cat: "context",
        images: result.replacedCount,
        messages: consumedMessages,
      });
    }
    return result.messages;
  }

  private trackFreshImageMessage(message: Message): void {
    if (messageHasBase64ImagePayload(message)) {
      this.pendingImageMessages.add(message);
    }
  }

  private async emitHook(
    event: HookEventName,
    data: Record<string, unknown> = {},
  ): Promise<HookResult> {
    return this.deps.hooks.emit(event, {
      ...data,
      isSubAgent: this.deps.isSubAgent === true,
      sessionId: this.deps.sessionId,
      // The run's abort signal, so handlers that make their own LLM calls
      // (e.g. the Goal stop-judge) can be cut short when the user hits Stop
      // mid-call instead of blocking until the sub-call returns.
      signal: this.config.signal,
    });
  }

  /**
   * Emit a usage_update so the UI ctx bar reflects current message-array
   * size. Called at every point where messages mutate: after a tool_result
   * is appended, after context management (which may shrink), and after an
   * LLM response (which we also feed through with the provider's authoritative
   * promptTokens to override our estimate).
   */
  private emitCtxFromMessages(messages: Message[]): void {
    if (!this.config.onStream) return;
    // Messages-only estimate is missing system prompt + tool defs (typically
    // ~16k tokens). Pull the cached overhead derived from the previous LLM
    // response to keep the ctx bar in the same ballpark as the real prompt.
    // Without this, the bar drops to ~1k every time tool results land.
    const msgsEstimate = estimateTokens(messages);
    const overhead = this.deps.ctxOverheadStore.get(this.deps.sessionId);
    const ctx = msgsEstimate + overhead;
    this.currentTurnLog.info("debug.ctx.emit", {
      src: "messages",
      value: ctx,
      msgsEstimate,
      overhead,
      msgCount: messages.length,
      prev: this.lastCtxEmit,
    });
    if (ctx === this.lastCtxEmit) return;
    this.lastCtxEmit = ctx;
    this.config.onStream({ type: "usage_update", promptTokens: ctx });
  }

  private recordResponseUsage(usage: NonNullable<LLMResponse["usage"]>): void {
    this.currentTurnUsage = addTokenUsage(this.currentTurnUsage, usage);
    this.currentCumulativeUsage = this.deps.recordCumulativeUsage?.(usage);
  }

  private emitCtxFromUsage(usage: NonNullable<LLMResponse["usage"]>, messages: Message[]): void {
    if (!this.config.onStream) return;
    const promptTokens = usage.promptTokens;
    // Reverse-derive overhead from this authoritative reading so the next
    // estimate-based emit (post-tool-result) is calibrated.
    const msgsEstimate = estimateTokens(messages);
    const overhead = Math.max(0, promptTokens - msgsEstimate);
    this.deps.ctxOverheadStore.set(this.deps.sessionId, overhead);
    this.currentTurnLog.info("debug.ctx.emit", {
      src: "usage",
      value: promptTokens,
      msgsEstimate,
      derivedOverhead: overhead,
      prev: this.lastCtxEmit,
    });
    const promptChanged = promptTokens !== this.lastCtxEmit;
    if (promptChanged) this.lastCtxEmit = promptTokens;
    // Forward the provider's cache counts so the UI can show a hit rate. Only
    // attach fields the provider actually reported — a spread keeps them off
    // the event entirely when undefined, so the renderer can tell "no cache
    // info this turn" from "0 cached". Estimate-path emits don't call this and
    // so carry no cache fields (correct: an estimate has no cache reading).
    const singleTurnCacheHitRate = cacheHitRateFromUsage(this.currentTurnUsage);
    const cumulative = this.currentCumulativeUsage;
    const cumulativeHitRate = cumulative ? cumulativeCacheHitRate(cumulative) : undefined;
    if (!promptChanged && singleTurnCacheHitRate === undefined && cumulativeHitRate === undefined) {
      return;
    }
    this.config.onStream({
      type: "usage_update",
      promptTokens,
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: usage.cacheCreationTokens }
        : {}),
      singleTurnPromptTokens: this.currentTurnUsage.promptTokens,
      singleTurnCacheReadTokens: this.currentTurnUsage.cacheReadTokens ?? 0,
      singleTurnCacheCreationTokens: this.currentTurnUsage.cacheCreationTokens ?? 0,
      ...(singleTurnCacheHitRate !== undefined ? { singleTurnCacheHitRate } : {}),
      ...(cumulative
        ? {
            cumulativePromptTokens: cumulative.cumulativePromptTokens,
            cumulativeCacheReadTokens: cumulative.cumulativeCacheReadTokens,
            cumulativeCacheCreationTokens: cumulative.cumulativeCacheCreationTokens,
            ...(cumulativeHitRate !== undefined
              ? { cumulativeCacheHitRate: cumulativeHitRate }
              : {}),
            // Legacy aliases for existing renderer builds. New UI code reads the
            // cumulative* fields above.
            sessionPromptTokens: cumulative.cumulativePromptTokens,
            sessionCacheReadTokens: cumulative.cumulativeCacheReadTokens,
            sessionCacheCreationTokens: cumulative.cumulativeCacheCreationTokens,
          }
        : {}),
    });
  }

  /**
   * Run the multi-turn agent loop until completion.
   */
  async run(initialMessages: Message[]): Promise<TurnLoopResult> {
    let messages = [...initialMessages];
    let finalText = "";
    const budgetTracker = createBudgetTracker();

    // Goal-mode run-scoped budget tracker (P0). Null when no goal. Stamps a
    // wall-clock start now and accumulates prompt+completion tokens across
    // every turn; the guardrail below force-stops the run once any configured
    // budget is blown — the unattended-safety backstop.
    this.goalTracker = this.config.goal
      ? createGoalBudgetTracker(this.config.goal, Date.now())
      : null;
    const goalTracker = this.goalTracker;
    // Fresh run: re-arm the approaching-limit announcement.
    this.approachAnnounced = false;

    // run() must never reject: the engine's post-run bookkeeping (saveState
    // with the terminal reason, on_session_end hook) runs AFTER this call and
    // outside the engine's try, so a throw here would leave the session
    // frozen at status "active" on disk. Per-turn errors are already turned
    // into return-reasons by callModelWithFallback; this outer guard catches
    // throws from the surrounding scaffolding (contextManager.manageAsync,
    // hook emits, guards) and surfaces them as a model_error result.
    try {
      while (this.turnCount < this.config.maxTurns) {
        this.turnCount++;
        this.currentTurnUsage = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };

        // Abort fast-path: bail at the loop TOP before doing any per-turn work.
        // Without this, an aborted child (parent abort, or the 30min per-call
        // registry timeout) would run a full contextManager.manageAsync (itself
        // an LLM summarization call) + model call + tool batch before the
        // post-model check at the bottom of the loop noticed — exactly the
        // sub-agent leak where a synchronous child kept burning turns/tokens for
        // minutes after the parent Agent call already returned. The model call's
        // own signal check only fires AFTER the call resolves; this guards the
        // boundary between turns. (Mirrors Claude Code's query.ts, where the
        // aborted check short-circuits before re-entering the streaming loop.)
        if (this.config.signal?.aborted) {
          this.markStopped();
          return { text: finalText, reason: "aborted_streaming", messages };
        }

        // Step-gap steering: messages the host queued via Engine.enqueueSteer
        // while the previous step was running. Splice them in as user messages so
        // they join THIS step's request — no abort, no lost in-flight work. Same
        // loop-top user-push pattern as turnStartInjection / turn-limit warnings
        // below. Push to transcript too so they persist + survive resume.
        this.consumeQueuedSteer(messages, "normal_step");

        const state = initialTurnState(this.turnCount);

        // Per-turn correlation ID. Every log written through `tlog` (or any
        // child derived from it) is stamped with `turn` + `turnId`, so
        // `jq 'select(.turnId == "...")'` reconstructs one turn's timeline.
        // Span is *not* used for the loop itself because there are 6+ early
        // returns; instead, each return-causing branch logs its own terminal
        // event (model_error, completed, etc.).
        const turnId = newTurnId();
        const tlog = logger.child({ turn: this.turnCount, turnId });
        this.currentTurnLog = tlog;

        const turnStartedAt = Date.now();
        tlog.info("turn.start", { cat: "turn", messageCount: messages.length });

        // Tag downstream tool-exec / permission lines with this turn's IDs.
        this.deps.toolExecutor.setLogger(tlog);
        this.config.onStream?.({ type: "stream_request_start", turnNumber: this.turnCount });
        const turnStartHook = await this.emitHook("on_turn_start", {
          turnNumber: this.turnCount,
        });
        const turnStartInjection = wrapHookMessages(turnStartHook.messages);
        if (turnStartInjection) {
          messages.push(turnStartInjection);
        }

        // Approaching max turns: inject a warning so the model can wrap up.
        // (Model-facing only — the user-facing "再续" marker is handled by
        // maybeAnnounceApproachingLimit below, which also watches the stop-block
        // cap, the limit a re-blocked goal actually hits first.)
        const turnsRemaining = this.config.maxTurns - this.turnCount;
        if (turnsRemaining === 2) {
          messages.push({
            role: "user",
            content:
              "<system-reminder>Warning: you have only 2 turns remaining before the turn limit is reached. " +
              "Start wrapping up your work and prepare a summary of what you've accomplished and what remains to be done.</system-reminder>",
          });
        } else if (turnsRemaining === 1) {
          messages.push({
            role: "user",
            content:
              "<system-reminder>Warning: you have only 1 turn remaining before the turn limit is reached. " +
              "Wrap up your work now — your next turn will be your last.</system-reminder>",
          });
        } else if (turnsRemaining === 0) {
          messages.push({
            role: "user",
            content:
              "<system-reminder>This is your LAST turn. You MUST respond with a final text summary now. " +
              "Do NOT call any tools. Summarize what you have accomplished and list any remaining work.</system-reminder>",
          });
        }

        // Goal mode: announce once when nearing EITHER stop ceiling (turns or
        // stop-blocks) so the UI can offer a "再续" button while still live.
        this.maybeAnnounceApproachingLimit();

        // Pre-check: downgrade image payloads that have already had their one
        // model-consumption turn, then run context management. Fresh images in
        // pendingImageMessages are preserved through this next model request.
        messages = this.prepareMessagesForModel(messages);

        // Context management (async — may trigger LLM summarization)
        messages = await this.deps.contextManager.manageAsync(messages);

        // manageAsync can itself issue an LLM summarization call lasting several
        // seconds; if the signal aborted during it, stop here rather than
        // proceeding into the (expensive) main model call. Belt to the loop-top
        // brace: this catches an abort that landed *inside* context management.
        if (this.config.signal?.aborted) {
          this.markStopped();
          return { text: finalText, reason: "aborted_streaming", messages };
        }
        // No pre-llm ctx emit here: the messages-only estimate would be ~16k
        // smaller than the real prompt (system + tools not included), making
        // the bar visibly drop on every submit. Post-llm/post-tool-result
        // events carry an accurate value; if compaction shrank the array, the
        // dedicated context_compact event has already informed the UI.

        // post_compact hook: ContextManager just finished a manage() pass.
        // If any non-micro tier fired, give handlers a chance to inject a
        // <system-reminder> ("context was compacted — recall earlier
        // decisions from the transcript") into THIS turn before the model
        // call. Microcompact is lossless (just clearing redundant
        // tool_results) so we suppress hook emits for it to keep token
        // overhead down.
        const pending = this.deps.consumePendingCompactInfo?.();
        if (pending && pending.strategy !== "micro") {
          const compactHook = await this.emitHook("post_compact", {
            strategy: pending.strategy,
            beforeTokens: pending.before,
            afterTokens: pending.after,
          });
          const compactInjection = wrapHookMessages(compactHook.messages);
          if (compactInjection) {
            messages.push(compactInjection);
          }
        }

        // Model call (with streaming fallback and max_output_tokens continuation)
        // Track tool IDs streamed during this turn to avoid duplicate UI events
        this.streamedToolIds.clear();
        // Streaming tool queue: start concurrency-safe tools during streaming
        const streamingQueue = new StreamingToolQueue(this.deps.toolExecutor);
        let response;
        try {
          response = await this.callModelWithFallback(messages);
        } catch (err) {
          if (err instanceof ContextLimitError) {
            // Progressive recovery: drop oldest API rounds, up to 3 retries
            const { dropOldestRounds } = await import("../context/compaction.js");
            let recovered = false;
            for (let retry = 1; retry <= 3; retry++) {
              tlog.warn("turn.ptl_recovery", { cat: "turn", retry, roundsToDrop: retry });
              messages = dropOldestRounds(messages, retry);
              try {
                response = await this.callModelWithFallback(messages);
                recovered = true;
                break;
              } catch (retryErr) {
                if (!(retryErr instanceof ContextLimitError)) {
                  this.config.onStream?.({ type: "error", error: formatFriendlyError(retryErr) });
                  return { text: finalText, reason: "model_error", messages };
                }
              }
            }
            if (!recovered) {
              this.patchOrphanedToolUses(messages);
              this.config.onStream?.({
                type: "error",
                error: "Context limit exceeded after 3 recovery attempts",
              });
              return { text: finalText, reason: "prompt_too_long", messages };
            }
          } else if (isAbortError(err) || this.config.signal?.aborted) {
            // User pressed Stop: the in-flight model call rejected with an
            // AbortError. This is NOT a failure — the UI already shows the
            // "你在 Ns 后停止了" line, so emitting an error event would stack a
            // spurious red "Error:" block on top of an intentional stop.
            // Persist a turn_stopped marker so a resume can rebuild that line
            // (the renderer's turn_end is in-memory only; without this the
            // interrupted turn folds behind the process-card header on reload).
            this.patchOrphanedToolUses(messages);
            this.markStopped();
            return { text: finalText, reason: "aborted_streaming", messages };
          } else {
            this.patchOrphanedToolUses(messages);
            this.config.onStream?.({ type: "error", error: formatFriendlyError(err) });
            return { text: finalText, reason: "model_error", messages };
          }
        }

        // Record the response once into current-turn and whole-session counters.
        if (response!.usage?.promptTokens !== undefined) {
          this.recordResponseUsage(response!.usage);
          this.emitCtxFromUsage(response!.usage, messages);
        }

        // Feed actual token usage back to the context manager so subsequent
        // compaction decisions use hybrid (actual + delta) estimation rather than
        // pure heuristics. Without this the manager falls back to char/4 estimates.
        if (response!.usage?.promptTokens !== undefined) {
          const anchor = this.deps.contextManager.recordActualUsage(
            response!.usage.promptTokens,
            messages.length,
            messages,
          );
          if (anchor) this.deps.recordContextUsageAnchor?.(anchor);
        }

        messages = this.markPendingImagesConsumed(messages);

        // Truncation that cut off a TOOL CALL: the model overflowed
        // max_output_tokens mid tool-call, so the arg JSON is incomplete (e.g. a
        // Write whose `content` was clipped, leaving file_path unset). Executing
        // it raised a misleading "Missing required parameter: file_path". Instead,
        // tell the model its output was truncated and let the next turn retry —
        // bounded by the outer maxTurns loop.
        if (isTruncatedStop(response.stopReason) && response.toolCalls.length > 0) {
          tlog.info("turn.truncated_tool_call", {
            cat: "turn",
            toolCount: response.toolCalls.length,
          });
          if (response.text) {
            messages.push({ role: "assistant", content: response.text });
          }
          messages.push({
            role: "user",
            content:
              "<system-reminder>Your previous response was truncated by the max output token limit before the tool call finished, so its arguments are incomplete. Do not assume it ran. Either retry with a smaller/more focused tool call (e.g. write the file in sections via Edit), or raise this model's maxOutputTokens.</system-reminder>",
          });
          continue;
        }

        // Handle max_output_tokens: if response was truncated, do continuation
        // (up to 3 times). Truncation is reported as finish_reason "length"
        // (OpenAI) or stop_reason "max_tokens" (Anthropic) — isTruncatedStop
        // accepts both, so the OpenAI streaming path triggers continuation too.
        if (
          isTruncatedStop(response.stopReason) &&
          response.toolCalls.length === 0 &&
          response.text
        ) {
          let combinedText = response.text;
          let continuedResponse = false;
          for (let retry = 0; retry < 3; retry++) {
            // Don't fire another continuation call if the user cancelled — without
            // this an abort during a truncated response could still issue up to 3
            // more model calls, emitting text after Stop.
            if (this.config.signal?.aborted) break;
            tlog.info("turn.max_tokens_continuation", { cat: "turn", retry: retry + 1 });
            const contMessages = [
              ...messages,
              { role: "assistant" as const, content: combinedText },
              {
                role: "user" as const,
                content:
                  "<system-reminder>Your previous response was truncated due to length. Please continue from where you left off.</system-reminder>",
              },
            ];
            try {
              const contResponse = await this.deps.model.call(
                this.deps.systemPrompt,
                this.prepareMessagesForModel(contMessages),
                this.deps.tools,
                this.config.onStream,
                this.config.signal,
              );
              if (contResponse.usage?.promptTokens !== undefined) {
                this.recordResponseUsage(contResponse.usage);
                continuedResponse = true;
              }
              combinedText += contResponse.text;
              if (!isTruncatedStop(contResponse.stopReason) || contResponse.toolCalls.length > 0) {
                response = { ...contResponse, text: combinedText };
                break;
              }
            } catch {
              break;
            }
          }
          response = { ...response, text: combinedText };
          if (continuedResponse && response.usage?.promptTokens !== undefined) {
            this.emitCtxFromUsage(response.usage, messages);
          }
        }

        // Goal-mode run-scoped accounting: add this turn's total token usage
        // (prompt + completion) to the running total. Done after continuation so
        // continued output is counted against the budget.
        if (goalTracker && response.usage) {
          const used = (response.usage.promptTokens ?? 0) + (response.usage.completionTokens ?? 0);
          recordGoalUsage(goalTracker, used);
        }

        // Aborted?
        if (this.config.signal?.aborted) {
          this.markStopped();
          return { text: finalText, reason: "aborted_streaming", messages };
        }

        // Accumulate text
        if (response.text) {
          finalText = response.text;
        }

        // Goal budget guardrail (P0): a run that has blown its token/time budget
        // is force-stopped regardless of what the model wants to do next (stop OR
        // continue with tool calls). This is the unattended-safety backstop, so
        // it sits BEFORE the "tool calls?" branch — both paths pass the gate.
        if (goalTracker && goalBudgetExceeded(goalTracker, Date.now())) {
          tlog.info("turn.goal_budget_exhausted", {
            cat: "goal",
            tokensUsed: goalTracker.tokensUsed,
            tokenBudget: this.config.goal?.tokenBudget,
            timeBudgetMs: this.config.goal?.timeBudgetMs,
          });
          this.config.onStream?.({
            type: "assistant_message",
            message: {
              role: "assistant",
              content: "（Goal 预算已耗尽，强制停止。）",
            },
          });
          return { text: finalText, reason: "goal_budget_exhausted", messages };
        }

        // Post-check: tool calls?
        if (response.toolCalls.length === 0) {
          // No tool use — final answer
          this.config.onStream?.({
            type: "assistant_message",
            message: { role: "assistant", content: finalText },
          });
          await this.emitHook("on_turn_end", {
            turnNumber: this.turnCount,
            hasToolUse: false,
          });
          messages.push({ role: "assistant", content: finalText });
          if (this.consumeQueuedSteer(messages, "finalize_backfill")) {
            continue;
          }

          // on_stop seam: the model wants to stop. Give handlers (Goal mode)
          // a chance to BLOCK termination and keep the agent working. A
          // handler returning continueSession=true injects its messages and
          // we run another turn instead of returning. Bounded by
          // maxStopBlocks (consecutive) and the outer maxTurns ceiling.
          const maxStopBlocks = this.config.maxStopBlocks ?? GOAL_DEFAULT_MAX_STOP_BLOCKS;
          const stopHook = await this.emitHook("on_stop", {
            goal: this.config.goal,
            finalText,
            turnCount: this.turnCount,
          });
          // The judge's structured verdict (set by GoalStopHook in result.data)
          // rides back here so we can show goal progress WITHOUT a second LLM
          // call — `gaps` is whatever the judge already computed.
          const goalVerdict = stopHook.data?.goalVerdict as
            | { met: boolean; gaps: string }
            | undefined;
          if (stopHook.continueSession && this.stopBlockCount < maxStopBlocks) {
            this.stopBlockCount++;
            // Goal visibility: one not_met marker per re-prompt. round counts
            // up with stopBlockCount so the UI can show "第 N 轮".
            this.config.onStream?.({
              type: "goal_progress",
              status: "not_met",
              round: this.stopBlockCount,
              gaps: goalVerdict?.gaps || undefined,
            });
            // The streak just grew — we may now be nearing the stop-block cap.
            // Announce here (before the next turn's top check) so the "再续"
            // button shows up against the limit that's actually about to bite.
            this.maybeAnnounceApproachingLimit();
            const injection = wrapHookMessages(stopHook.messages);
            if (injection) {
              messages.push(injection);
            } else {
              // No guidance from the handler — inject a generic nudge so the
              // model knows it must keep going rather than re-emitting the
              // same final answer.
              messages.push({
                role: "user",
                content:
                  "<system-reminder>The goal is not yet complete. Continue working toward it.</system-reminder>",
              });
            }
            tlog.info("turn.stop_blocked", {
              cat: "turn",
              stopBlockCount: this.stopBlockCount,
              maxStopBlocks,
              hasGuidance: !!injection,
            });
            continue;
          }
          if (stopHook.continueSession && this.stopBlockCount >= maxStopBlocks) {
            // Cap hit: stop anyway, but tell the user why we're not looping
            // forever on an unsatisfiable goal.
            tlog.info("turn.stop_block_cap", {
              cat: "turn",
              stopBlockCount: this.stopBlockCount,
              maxStopBlocks,
            });
            this.config.onStream?.({
              type: "goal_progress",
              status: "exhausted",
              round: this.stopBlockCount,
            });
            this.config.onStream?.({
              type: "assistant_message",
              message: {
                role: "assistant",
                content: `（Goal 续跑已达 ${maxStopBlocks} 次上限，先停下。）`,
              },
            });
          } else if (this.config.goal && goalVerdict?.met) {
            // Goal run completed cleanly: the judge says met. round = total
            // rounds = prior blocks + this accepted final round.
            this.config.onStream?.({
              type: "goal_progress",
              status: "met",
              round: this.stopBlockCount + 1,
            });
          }
          this.stopBlockCount = 0;
          if (this.consumeQueuedSteer(messages, "finalize_backfill")) {
            continue;
          }
          return { text: finalText, reason: "completed", messages };
        }

        // Tool execution phase
        tlog.info("turn.tool_use", {
          cat: "turn",
          tools: response.toolCalls.map((t) => t.toolName),
        });
        const toolCalls = response.toolCalls.slice(0, this.config.maxToolCallsPerTurn);
        // Per-turn cap: any calls beyond maxToolCallsPerTurn are NOT executed and
        // NOT added to the assistant message below, so the model never sees a
        // result for them. Without a heads-up it assumes all ran (acting on
        // tool output that never happened). Remember the dropped ones so we can
        // inject a reminder after the executed batch's results. (B-3)
        const droppedToolCalls = response.toolCalls.slice(this.config.maxToolCallsPerTurn);

        // Add assistant message with tool_use blocks to messages
        const assistantBlocks: ContentBlock[] = [];
        if (response.text) {
          assistantBlocks.push({ type: "text", text: response.text });
        }
        for (const tc of toolCalls) {
          assistantBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.toolName,
            input: tc.args,
          });
          // Only emit tool_use_start if not already emitted during streaming
          if (!this.streamedToolIds.has(tc.id)) {
            this.config.onStream?.({ type: "tool_use_start", toolCall: tc });
          }
          // Record in transcript
          this.deps.transcript.appendToolUse(tc.toolName, tc.id, tc.args);
        }
        messages.push({ role: "assistant", content: assistantBlocks });

        // Execute tools — enqueue concurrency-safe tools for early start,
        // drain remaining (unsafe) tools sequentially.
        for (const tc of toolCalls) {
          streamingQueue.enqueue(tc);
        }
        const results = await streamingQueue.drain();

        // Record results in transcript and stream
        const resultBlocks: ContentBlock[] = [];
        for (const result of results) {
          resultBlocks.push(toolResultToBlock(result));

          this.deps.transcript.appendToolResult(
            result.id,
            result.toolName,
            result.result,
            result.error,
            result.contentBlocks,
          );

          this.config.onStream?.({ type: "tool_result", result });
        }

        // Fire-and-forget tool use summary (non-blocking). The whole chain is
        // best-effort observability — a thrown onStream handler, a failed dynamic
        // import, or a rejecting summarize must never surface as an unhandled
        // rejection (Node can treat those as fatal). Swallow at the tail. (B-2)
        if (this.config.onStream) {
          void import("./tool-summary.js")
            .then(({ generateToolUseSummary }) => {
              if (!this.deps.model.summarize) return;
              return generateToolUseSummary(toolCalls, results, this.deps.model.summarize).then(
                (summary) => {
                  if (summary) {
                    this.config.onStream?.({ type: "tool_summary", summary });
                  }
                },
              );
            })
            .catch((err) => {
              this.currentTurnLog.warn("tool_summary.dispatch_failed", {
                cat: "turn",
                error: (err as Error).message,
              });
            });
        }

        const toolResultMessage: Message = { role: "user", content: resultBlocks };
        messages.push(toolResultMessage);
        this.trackFreshImageMessage(toolResultMessage);

        // B-3: tell the model which of its requested tool calls were dropped by
        // the per-turn cap so it can re-issue them, instead of silently assuming
        // they ran. Appended to the same user message that carries the results.
        if (droppedToolCalls.length > 0) {
          tlog.info("turn.tool_calls_capped", {
            cat: "turn",
            executed: toolCalls.length,
            dropped: droppedToolCalls.length,
            cap: this.config.maxToolCallsPerTurn,
          });
          const droppedNames = droppedToolCalls.map((t) => t.toolName).join(", ");
          // Separate user message (not folded into the tool_result blocks) so the
          // OpenAI converter — which lifts tool_results into standalone role:tool
          // messages — keeps the reminder as a plain user turn after them.
          messages.push({
            role: "user",
            content:
              `<system-reminder>Only the first ${toolCalls.length} of your ${response.toolCalls.length} ` +
              `tool calls ran this turn (per-turn limit is ${this.config.maxToolCallsPerTurn}). ` +
              `These were NOT executed and produced no result — do NOT assume they ran: ${droppedNames}. ` +
              `Re-issue the ones you still need in the next turn.</system-reminder>`,
          });
        }

        // Tool results just pushed; recompute ctx so the bar updates *before*
        // the next model round-trip — large tool outputs can move it sharply.
        this.emitCtxFromMessages(messages);

        // Goal mode P0: explicit completion. If the model called complete_goal,
        // it has DECLARED the goal done — short-circuit to "completed" WITHOUT
        // running the judge hook. The tool's result is already in `messages`
        // above so the summary lands in the transcript. Reset the stop-block
        // counter so a prior judge-driven block streak doesn't leak out. Also
        // clear the PERSISTED goal so a later bare send doesn't re-inherit a goal
        // the model just declared finished (the judge's onMet does this when IT
        // decides; a self-report must do the same, else the goal outlives its
        // completion and re-arms every follow-up turn).
        if (goalTracker && toolCalls.some((tc) => tc.toolName === COMPLETE_GOAL_TOOL_NAME)) {
          tlog.info("turn.goal_self_reported_complete", { cat: "goal" });
          this.stopBlockCount = 0;
          this.deps.clearPersistedGoal?.();
          if (this.consumeQueuedSteer(messages, "finalize_backfill")) {
            continue;
          }
          return { text: finalText, reason: "completed", messages };
        }

        // Goal mode: user-initiated cancellation. cancel_goal is the "strong
        // intent" escape hatch — honor it ONLY when confirm===true (the guard the
        // tool advertises). A confirmed cancel stops the run AND clears the
        // persisted goal so it never re-arms; an unconfirmed call is a no-op here
        // (the tool's own result string already told the model it was ignored).
        const confirmedCancel = toolCalls.some(
          (tc) => tc.toolName === CANCEL_GOAL_TOOL_NAME && tc.args?.confirm === true,
        );
        if (goalTracker && confirmedCancel) {
          tlog.info("turn.goal_user_cancelled", { cat: "goal" });
          this.stopBlockCount = 0;
          this.deps.clearPersistedGoal?.();
          if (this.consumeQueuedSteer(messages, "finalize_backfill")) {
            continue;
          }
          return { text: finalText, reason: "completed", messages };
        }

        // Token budget check
        const totalOutputTokens = this.deps.model.getOutputTokens?.() ?? 0;
        const budgetDecision = checkTokenBudget(
          totalOutputTokens,
          this.config.tokenBudget ?? Infinity,
          budgetTracker,
        );
        if (budgetDecision === "stop") {
          tlog.info("turn.budget_stop", {
            cat: "turn",
            outputTokens: totalOutputTokens,
            budget: this.config.tokenBudget,
          });
          this.config.onStream?.({
            type: "assistant_message",
            message: { role: "assistant", content: finalText },
          });
          messages.push({ role: "assistant", content: finalText });
          if (this.consumeQueuedSteer(messages, "finalize_backfill")) {
            continue;
          }
          return { text: finalText, reason: "completed", messages };
        }
        if (budgetDecision === "nudge") {
          messages.push({
            role: "user",
            content:
              "<system-reminder>You are approaching the token budget limit. Please start wrapping up your work and provide a summary.</system-reminder>",
          });
        }

        // Investigation guard: end-of-turn check. If too many consecutive
        // read-only turns went by without any user-visible text or side-effecting
        // tool, inject a reminder that will land at the top of the next turn.
        const guard = this.deps.toolExecutor.getInvestigationGuard();
        if (guard) {
          guard.noteText(response.text);
          const turnReminder = guard.turnEnded(this.turnCount);
          if (turnReminder) {
            messages.push({ role: "user", content: turnReminder });
            tlog.info("guard.silent_turn", { cat: "guard", turn: this.turnCount });
          }
        }

        // Task guard: nudge the model if it has an in_progress task that
        // hasn't moved in several turns. TaskCreate is sticky in working
        // memory for the first few turns only; without this, the spinner
        // runs forever on tasks the model has mentally finished.
        const taskGuard = this.deps.toolExecutor.getTaskGuard();
        if (taskGuard) {
          const taskReminder = taskGuard.turnEnded(this.turnCount);
          if (taskReminder) {
            messages.push({ role: "user", content: taskReminder });
            tlog.info("guard.stale_task", { cat: "guard", turn: this.turnCount });
          }
        }

        // Hook: turn end
        await this.emitHook("on_turn_end", {
          turnNumber: this.turnCount,
          hasToolUse: true,
          toolCallCount: toolCalls.length,
        });

        // Record turn boundary
        this.deps.transcript.appendTurnBoundary();
        this.config.onTurnBoundary?.(this.turnCount);

        tlog.info("turn.end", {
          cat: "turn",
          duration_ms: Date.now() - turnStartedAt,
          outcome: "continue",
        });
      }
    } catch (err) {
      // Unexpected throw from the per-turn scaffolding (manageAsync, hooks,
      // guards). Patch any dangling tool_use so a later resume isn't poisoned,
      // surface the error to the UI, and return a terminal reason so the
      // engine's post-run saveState records model_error instead of leaving
      // the session stuck at "active".
      this.patchOrphanedToolUses(messages);
      // A user-initiated Stop also bubbles here (an AbortError thrown from the
      // per-turn scaffolding). Treat it as a clean abort, not a model_error —
      // no error event, so the UI shows only the "你停止了本轮" line.
      if (isAbortError(err) || this.config.signal?.aborted) {
        this.markStopped();
        return { text: finalText, reason: "aborted_streaming", messages };
      }
      this.currentTurnLog.error("turn.unhandled_error", {
        cat: "turn",
        error: (err as Error).message,
        stack: (err as Error).stack?.split("\n").slice(0, 4).join("\n"),
      });
      this.config.onStream?.({ type: "error", error: formatFriendlyError(err) });
      return { text: finalText, reason: "model_error", messages };
    }

    // Max turns reached — do one final summarization call (no tools)
    logger.warn("turn.max_turns_reached", {
      cat: "turn",
      maxTurns: this.config.maxTurns,
      turnCount: this.turnCount,
    });

    this.consumeQueuedSteer(messages, "finalize_backfill");
    messages = this.prepareMessagesForModel(messages);
    messages = this.deps.contextManager.manage(messages);
    messages.push({
      role: "user",
      content:
        "<system-reminder>Turn limit reached. Provide a final summary of what you accomplished and what remains to be done. Do NOT call any tools.</system-reminder>",
    });
    this.emitCtxFromMessages(messages);

    try {
      const summaryResponse = await this.deps.model.call(
        this.deps.systemPrompt,
        this.prepareMessagesForModel(messages),
        [], // No tools available for summary turn
        this.config.onStream,
        this.config.signal,
      );
      messages = this.markPendingImagesConsumed(messages);
      if (summaryResponse.text) {
        finalText = summaryResponse.text;
      }
    } catch {
      // If even summary fails, just return what we have
      this.currentTurnLog.warn("turn.summary_failed", { cat: "turn" });
    }

    if (finalText) {
      this.config.onStream?.({
        type: "assistant_message",
        message: { role: "assistant", content: finalText },
      });
      messages.push({ role: "assistant", content: finalText });
    }
    this.config.onStream?.({ type: "turn_complete", reason: "max_turns" });
    return { text: finalText, reason: "max_turns", messages };
  }

  /**
   * Call model with streaming fallback.
   * If streaming fails, emit tombstone and retry non-streaming.
   */
  private async callModelWithFallback(messages: Message[]) {
    // Wrap stream callback to track tool_use_start events and reactive compaction
    let streamingResponseTokens = 0;
    let reactiveBucket = -1;
    const wrappedStream: StreamCallback | undefined = this.config.onStream
      ? (event) => {
          if (event.type === "tool_use_start" && event.toolCall?.id) {
            this.streamedToolIds.add(event.toolCall.id);
          }
          // Track accumulating response size for reactive compaction
          if (event.type === "text_delta" && event.text) {
            streamingResponseTokens += Math.ceil(event.text.length / 4);
          }
          // Reactive compaction warning: if nearing context limit mid-stream,
          // log a warning (actual compaction happens between turns). Gated to
          // fire once per 2000-token bucket crossed — the old `% 2000 === 0`
          // check essentially never matched the running accumulator.
          const probe = crossedReactiveThreshold(streamingResponseTokens, reactiveBucket);
          if (probe.crossed) {
            reactiveBucket = probe.bucket;
            if (this.deps.contextManager.shouldReactiveCompact(messages, streamingResponseTokens)) {
              this.currentTurnLog.warn("turn.reactive_compact_warning", {
                cat: "turn",
                responseTokens: streamingResponseTokens,
                turn: this.turnCount,
              });
            }
          }
          return this.config.onStream!(event);
        }
      : undefined;

    try {
      return await this.deps.model.call(
        this.deps.systemPrompt,
        messages,
        this.deps.tools,
        wrappedStream,
        this.config.signal,
      );
    } catch (err) {
      // If it's a context or rate limit error, don't fallback — propagate
      if (err instanceof ContextLimitError) throw err;

      // User cancelled (ESC / Stop / run signal). Falling back to a
      // non-streaming call here re-sends the whole request the user just
      // aborted. Propagate so the run unwinds cleanly instead of doing
      // more work after cancellation.
      //
      // Check the run signal too, not only isAbortError(err): when a streaming
      // request is aborted the error sometimes surfaces as a generic
      // `Error: Request was aborted.` whose `name` is NOT "AbortError"
      // (wrapping strips it), so isAbortError misses it and we'd fall back —
      // re-issuing the cancelled request, which then throws "Aborted before
      // LLM request" from withRetry and surfaces as a scary error on what was
      // really just a cancel. The signal is the authoritative cancel source.
      if (isAbortError(err) || this.config.signal?.aborted) throw err;

      // Streaming might have partially emitted — send tombstone to revoke
      this.config.onStream?.({ type: "tombstone", messageId: `turn_${this.turnCount}` });
      this.currentTurnLog.warn("turn.streaming_fallback", {
        cat: "turn",
        error: (err as Error).message,
      });

      // Retry without streaming
      return await this.deps.model.callWithoutStreaming(
        this.deps.systemPrompt,
        messages,
        this.deps.tools,
        this.config.signal,
      );
    }
  }

  get currentTurn(): number {
    return this.turnCount;
  }

  private consumeQueuedSteer(
    messages: Message[],
    source: "normal_step" | "finalize_backfill",
  ): boolean {
    const steered = this.deps.consumeSteer?.(source) ?? [];
    let consumed = false;
    for (const { id, text, clientMessageId } of steered) {
      if (!text) continue;
      if (clientMessageId && this.deps.claimClientMessageId?.(clientMessageId, "steer") === false) {
        logger.info("steer.submit.duplicate_ignored", {
          clientMessageId,
          steerId: id,
          sessionId: this.deps.sessionId,
          source,
        });
        continue;
      }
      consumed = true;
      messages.push({ role: "user", content: text });
      this.deps.transcript.appendMessage("user", text, { steerId: id, clientMessageId });
      this.config.onStream?.({ type: "steer_injected", text, id });
    }
    return consumed;
  }

  /**
   * Generate synthetic error tool_results for any dangling tool_use blocks
   * that never received results (e.g. because the API call failed).
   * Prevents model confusion on the next turn.
   */
  private patchOrphanedToolUses(messages: Message[]): void {
    // Pre-compute every answered tool_use id across the WHOLE array, then scan
    // forward and patch EVERY assistant message with a gap — not just the most
    // recent one. The old version scanned backward and returned at the first
    // all-answered assistant message, so when several earlier turns each left
    // orphaned tool_uses (multi-turn API failures) only the latest got patched
    // and the rest stayed unpaired → a 400 on the next call / on resume.
    const answeredIds = new Set<string>();
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          answeredIds.add(block.tool_use_id);
        }
      }
    }

    let totalPatched = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

      const orphanedIds: string[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id && !answeredIds.has(block.id)) {
          orphanedIds.push(block.id);
        }
      }
      if (orphanedIds.length === 0) continue;

      // Synthetic error results, spliced in RIGHT AFTER the offending assistant
      // message (not appended to the end) so each tool_use is paired in place.
      // is_error must be set: the Anthropic provider only emits is_error when
      // the flag is present, otherwise the model reads the cancellation as plain
      // text output and assumes the tool succeeded.
      const errorBlocks: ContentBlock[] = orphanedIds.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "Error: Tool execution was cancelled because the previous API call failed.",
        is_error: true,
      }));
      messages.splice(i + 1, 0, { role: "user", content: errorBlocks });
      for (const id of orphanedIds) answeredIds.add(id);
      totalPatched += orphanedIds.length;
      i += 1; // skip the message we just spliced in
    }

    if (totalPatched > 0) {
      this.currentTurnLog.warn("turn.patched_orphaned_tool_uses", {
        cat: "turn",
        count: totalPatched,
      });
    }
  }
}
