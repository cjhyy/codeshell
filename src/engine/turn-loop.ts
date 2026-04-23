/**
 * Turn loop — state machine implementation.
 *
 * Following Claude Code's po_() pattern:
 * pre_check → model_call → post_check → tool_exec → context_mgmt → hook_notify → next turn
 */

import type { Message, ToolCall, ToolResult, StreamCallback, TerminalReason, ContentBlock } from "../types.js";
import type { TurnState } from "./turn-state.js";
import { initialTurnState } from "./turn-state.js";
import { ModelFacade } from "./model-facade.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { ContextManager } from "../context/manager.js";
import { HookRegistry } from "../hooks/registry.js";
import { Transcript } from "../session/transcript.js";
import { ContextLimitError } from "../exceptions.js";
import { logger } from "../logging/logger.js";
import { checkTokenBudget, type BudgetTracker, createBudgetTracker } from "./token-budget.js";
import { StreamingToolQueue } from "./streaming-tool-queue.js";

export interface TurnLoopConfig {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  tokenBudget?: number;
  onStream?: StreamCallback;
  signal?: AbortSignal;
}

export interface TurnLoopDeps {
  model: ModelFacade;
  toolExecutor: ToolExecutor;
  contextManager: ContextManager;
  hooks: HookRegistry;
  transcript: Transcript;
  systemPrompt: string;
  tools: import("../types.js").ToolDefinition[];
}

export class TurnLoop {
  private turnCount = 0;
  /** Tool IDs already emitted as tool_use_start during streaming (to avoid duplicates). */
  private streamedToolIds = new Set<string>();

  constructor(
    private readonly deps: TurnLoopDeps,
    private readonly config: TurnLoopConfig,
  ) {}

  /**
   * Run the multi-turn agent loop until completion.
   */
  async run(initialMessages: Message[]): Promise<{ text: string; reason: TerminalReason }> {
    let messages = [...initialMessages];
    let finalText = "";
    let consecutiveToolOnlyTurns = 0;
    const budgetTracker = createBudgetTracker();

    while (this.turnCount < this.config.maxTurns) {
      this.turnCount++;
      const state = initialTurnState(this.turnCount);

      // Emit turn start
      logger.info("turn.start", { turn: this.turnCount, messageCount: messages.length });
      this.config.onStream?.({ type: "stream_request_start", turnNumber: this.turnCount });
      await this.deps.hooks.emit("on_turn_start", { turnNumber: this.turnCount });

      // Approaching max turns: inject a warning so the model can wrap up
      const turnsRemaining = this.config.maxTurns - this.turnCount;
      if (turnsRemaining === 2) {
        messages.push({
          role: "user",
          content:
            "<system-reminder>Warning: you have only 2 turns remaining before the turn limit is reached. " +
            "Start wrapping up your work and prepare a summary of what you've accomplished and what remains to be done.</system-reminder>",
        });
      } else if (turnsRemaining === 0) {
        messages.push({
          role: "user",
          content:
            "<system-reminder>This is your LAST turn. You MUST respond with a final text summary now. " +
            "Do NOT call any tools. Summarize what you have accomplished and list any remaining work.</system-reminder>",
        });
      }

      // Anti-loop: if too many consecutive tool-only turns, inject a nudge
      if (consecutiveToolOnlyTurns >= 8) {
        logger.warn("turn.anti_loop", { consecutiveToolOnlyTurns });
        messages.push({
          role: "user",
          content:
            "<system-reminder>You have used tools for many consecutive turns without providing a text response to the user. " +
            "You MUST now respond with text to answer the user's original question or summarize what you've done. " +
            "Do NOT call any more tools.</system-reminder>",
        });
        consecutiveToolOnlyTurns = 0;
      }

      // Pre-check: context management (async — may trigger LLM summarization)
      messages = await this.deps.contextManager.manageAsync(messages);

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
            logger.warn("turn.ptl_recovery", { retry, roundsToDrop: retry });
            messages = dropOldestRounds(messages, retry);
            try {
              response = await this.callModelWithFallback(messages);
              recovered = true;
              break;
            } catch (retryErr) {
              if (!(retryErr instanceof ContextLimitError)) {
                this.config.onStream?.({ type: "error", error: (retryErr as Error).message });
                return { text: finalText, reason: "model_error" };
              }
            }
          }
          if (!recovered) {
            this.patchOrphanedToolUses(messages);
            this.config.onStream?.({ type: "error", error: "Context limit exceeded after 3 recovery attempts" });
            return { text: finalText, reason: "prompt_too_long" };
          }
        } else {
          this.patchOrphanedToolUses(messages);
          this.config.onStream?.({ type: "error", error: (err as Error).message });
          return { text: finalText, reason: "model_error" };
        }
      }

      // Feed actual token usage back to the context manager so subsequent
      // compaction decisions use hybrid (actual + delta) estimation rather than
      // pure heuristics. Without this the manager falls back to char/4 estimates.
      if (response!.usage?.promptTokens !== undefined) {
        this.deps.contextManager.recordActualUsage(
          response!.usage.promptTokens,
          messages.length,
        );
      }

      // Handle max_output_tokens: if response was truncated, do continuation (up to 3 times)
      if (response.stopReason === "max_tokens" && response.toolCalls.length === 0 && response.text) {
        let combinedText = response.text;
        for (let retry = 0; retry < 3; retry++) {
          logger.info("turn.max_tokens_continuation", { retry: retry + 1 });
          const contMessages = [
            ...messages,
            { role: "assistant" as const, content: combinedText },
            { role: "user" as const, content: "<system-reminder>Your previous response was truncated due to length. Please continue from where you left off.</system-reminder>" },
          ];
          try {
            const contResponse = await this.deps.model.call(
              this.deps.systemPrompt,
              contMessages,
              this.deps.tools,
              this.config.onStream,
              this.config.signal,
            );
            combinedText += contResponse.text;
            if (contResponse.stopReason !== "max_tokens" || contResponse.toolCalls.length > 0) {
              response = { ...contResponse, text: combinedText };
              break;
            }
          } catch {
            break;
          }
        }
        response = { ...response, text: combinedText };
      }

      // Aborted?
      if (this.config.signal?.aborted) {
        return { text: finalText, reason: "aborted_streaming" };
      }

      // Accumulate text
      if (response.text) {
        finalText = response.text;
      }

      // Track consecutive tool-only turns
      if (response.toolCalls.length > 0) {
        consecutiveToolOnlyTurns++;
      } else {
        consecutiveToolOnlyTurns = 0;
      }

      // Post-check: tool calls?
      if (response.toolCalls.length === 0) {
        // No tool use — final answer
        this.config.onStream?.({
          type: "assistant_message",
          message: { role: "assistant", content: finalText },
        });
        await this.deps.hooks.emit("on_turn_end", {
          turnNumber: this.turnCount,
          hasToolUse: false,
        });
        return { text: finalText, reason: "completed" };
      }

      // Tool execution phase
      logger.info("turn.tool_use", { turn: this.turnCount, tools: response.toolCalls.map(t => t.toolName) });
      const toolCalls = response.toolCalls.slice(0, this.config.maxToolCallsPerTurn);

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
        const content = result.error
          ? `Error: ${result.error}`
          : result.result ?? "(no output)";

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: result.id,
          content,
        });

        this.deps.transcript.appendToolResult(
          result.id,
          result.toolName,
          result.result,
          result.error,
        );

        this.config.onStream?.({ type: "tool_result", result });
      }

      // Fire-and-forget tool use summary (non-blocking)
      if (this.config.onStream) {
        import("./tool-summary.js").then(({ generateToolUseSummary }) => {
          if (!this.deps.model.summarize) return;
          generateToolUseSummary(toolCalls, results, this.deps.model.summarize).then((summary) => {
            if (summary) {
              this.config.onStream?.({ type: "tool_summary", summary });
            }
          });
        });
      }

      messages.push({ role: "user", content: resultBlocks });

      // Token budget check
      const totalOutputTokens = this.deps.model.getOutputTokens?.() ?? 0;
      const budgetDecision = checkTokenBudget(
        totalOutputTokens,
        this.config.tokenBudget ?? Infinity,
        budgetTracker,
      );
      if (budgetDecision === "stop") {
        logger.info("turn.budget_stop", { outputTokens: totalOutputTokens, budget: this.config.tokenBudget });
        this.config.onStream?.({
          type: "assistant_message",
          message: { role: "assistant", content: finalText },
        });
        return { text: finalText, reason: "completed" };
      }
      if (budgetDecision === "nudge") {
        messages.push({
          role: "user",
          content: "<system-reminder>You are approaching the token budget limit. Please start wrapping up your work and provide a summary.</system-reminder>",
        });
      }

      // Hook: turn end
      await this.deps.hooks.emit("on_turn_end", {
        turnNumber: this.turnCount,
        hasToolUse: true,
        toolCallCount: toolCalls.length,
      });

      // Record turn boundary
      this.deps.transcript.appendTurnBoundary();
    }

    // Max turns reached — do one final summarization call (no tools)
    logger.warn("turn.max_turns_reached", { maxTurns: this.config.maxTurns, turnCount: this.turnCount });

    messages = this.deps.contextManager.manage(messages);
    messages.push({
      role: "user",
      content:
        "<system-reminder>Turn limit reached. Provide a final summary of what you accomplished and what remains to be done. Do NOT call any tools.</system-reminder>",
    });

    try {
      const summaryResponse = await this.deps.model.call(
        this.deps.systemPrompt,
        messages,
        [], // No tools available for summary turn
        this.config.onStream,
        this.config.signal,
      );
      if (summaryResponse.text) {
        finalText = summaryResponse.text;
      }
    } catch {
      // If even summary fails, just return what we have
      logger.warn("turn.summary_failed");
    }

    if (finalText) {
      this.config.onStream?.({
        type: "assistant_message",
        message: { role: "assistant", content: finalText },
      });
    }
    this.config.onStream?.({ type: "turn_complete", reason: "max_turns" });
    return { text: finalText, reason: "max_turns" };
  }

  /**
   * Call model with streaming fallback.
   * If streaming fails, emit tombstone and retry non-streaming.
   */
  private async callModelWithFallback(messages: Message[]) {
    // Wrap stream callback to track tool_use_start events and reactive compaction
    let streamingResponseTokens = 0;
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
          // log a warning (actual compaction happens between turns)
          if (streamingResponseTokens > 0 && streamingResponseTokens % 2000 === 0) {
            if (this.deps.contextManager.shouldReactiveCompact(messages, streamingResponseTokens)) {
              logger.warn("turn.reactive_compact_warning", {
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

      // Streaming might have partially emitted — send tombstone to revoke
      this.config.onStream?.({ type: "tombstone", messageId: `turn_${this.turnCount}` });
      logger.warn("turn.streaming_fallback", { error: (err as Error).message });

      // Retry without streaming
      return await this.deps.model.callWithoutStreaming(
        this.deps.systemPrompt,
        messages,
        this.deps.tools,
        this.config.signal,
      );
    }
  }

  /**
   * Execute tools with overlap: start concurrent-safe (read-only) tools
   * immediately in parallel while sequential (write) tools run one-by-one.
   * Both groups run simultaneously — we don't wait for safe tools to finish
   * before starting unsafe ones.
   */
  private async executeToolsOverlapped(calls: ToolCall[]): Promise<ToolResult[]> {
    if (calls.length <= 1) {
      // Single tool — no overlap needed
      return this.deps.toolExecutor.executeAll(calls);
    }

    const safe: ToolCall[] = [];
    const unsafe: ToolCall[] = [];

    for (const call of calls) {
      if (this.deps.toolExecutor.isConcurrencySafe(call.toolName)) {
        safe.push(call);
      } else {
        unsafe.push(call);
      }
    }

    // If all same type, delegate directly
    if (safe.length === 0 || unsafe.length === 0) {
      return this.deps.toolExecutor.executeAll(calls);
    }

    // Run both groups simultaneously:
    // - safe tools all in parallel
    // - unsafe tools sequentially (but started at the same time as safe group)
    const resultMap = new Map<string, ToolResult>();

    const safePromise = Promise.all(
      safe.map((c) => this.deps.toolExecutor.executeSingle(c)),
    );

    const unsafePromise = (async () => {
      const results: ToolResult[] = [];
      for (const call of unsafe) {
        results.push(await this.deps.toolExecutor.executeSingle(call));
      }
      return results;
    })();

    const [safeResults, unsafeResults] = await Promise.all([safePromise, unsafePromise]);

    for (const r of safeResults) resultMap.set(r.id, r);
    for (const r of unsafeResults) resultMap.set(r.id, r);

    // Return results in original call order for deterministic transcript
    return calls.map((c) => resultMap.get(c.id)!);
  }

  get currentTurn(): number {
    return this.turnCount;
  }

  /**
   * Generate synthetic error tool_results for any dangling tool_use blocks
   * that never received results (e.g. because the API call failed).
   * Prevents model confusion on the next turn.
   */
  private patchOrphanedToolUses(messages: Message[]): void {
    // Find the last assistant message with tool_use blocks
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

      const toolUseIds: string[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) toolUseIds.push(block.id);
      }
      if (toolUseIds.length === 0) continue;

      // Check if all tool_use IDs have corresponding tool_results
      const answeredIds = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const rm = messages[j];
        if (!Array.isArray(rm.content)) continue;
        for (const block of rm.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            answeredIds.add(block.tool_use_id);
          }
        }
      }

      const orphanedIds = toolUseIds.filter((id) => !answeredIds.has(id));
      if (orphanedIds.length === 0) return;

      // Inject synthetic error results
      const errorBlocks: ContentBlock[] = orphanedIds.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "Error: Tool execution was cancelled because the previous API call failed.",
      }));
      messages.push({ role: "user", content: errorBlocks });
      logger.warn("turn.patched_orphaned_tool_uses", { count: orphanedIds.length });
      return; // Only patch the most recent orphaned set
    }
  }
}
