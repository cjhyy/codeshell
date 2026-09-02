/**
 * Codex app-server notifications → CodeShell `StreamEvent`.
 *
 * Shapes come from the generated bindings of a real codex-cli 0.145.0
 * (`codex app-server generate-ts`). The ordering rules below are NOT inferred
 * from the schema — they are the expensive lessons recorded in the
 * `makecindy/cindy` reference implementation (design §16), which we read rather
 * than rediscover:
 *
 *  - `turn/completed` **can be delivered more than once**. Only the first may
 *    close the turn.
 *  - Items **arrive after `turn/completed`**. Clearing the current turn id is not
 *    enough; a late item would re-open a turn whose completion was already
 *    consumed, leaving the session permanently "busy".
 *  - `turn/started` for a turn can arrive **before** the `turn/start` RPC
 *    response, and so can `turn/completed`. Neither may resurrect a turn that has
 *    already reached a terminal state.
 *
 * Hence: a per-turn tombstone that outlives the turn, for completed AND errored
 * turns alike. Dropping a stale event is always preferable to reopening a turn.
 *
 * §15.2 also applies: a CodeShell Host Tool already emits its own lifecycle
 * through `ToolExecutor`, so this translator must NOT emit a second tool card for
 * it. Third-party MCP servers have no CodeShell-side lifecycle and do get cards.
 */
import type { StreamEvent, TerminalReason } from "@cjhyy/code-shell-core/extension";

/** MCP server name CodeShell advertises its own tools under. */
const CODESHELL_MCP_SERVER = "codeshell_tools";

/** Cap on remembered finished turns — a session is long-lived, the set is not. */
const MAX_TOMBSTONES = 256;

/** Thread items that represent observable runtime work rather than prose/state. */
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
]);

export interface CodexEventTranslatorOptions {
  /** The ONE Codex thread this translator serves. */
  threadId: string;
  /** CodeShell business session id, for correlating logs. */
  sessionId: string;
  /** Override the suppressed MCP server name (tests). */
  codeshellServerName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * A thread item's fields minus its identity, i.e. the tool's arguments. Output
 * fields are excluded so a completed item's arguments can be compared against
 * the ones seen when it opened.
 */
const ITEM_OUTPUT_KEYS = new Set([
  "id",
  "type",
  "aggregatedOutput",
  "output",
  "text",
  "result",
  "changes",
  "error",
  "status",
  "startedAtMs",
  "completedAtMs",
]);

function toolArgsOf(item: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (!ITEM_OUTPUT_KEYS.has(key)) args[key] = value;
  }
  return args;
}

/**
 * Map a Codex turn status onto a CodeShell `TerminalReason`.
 *
 * `interrupted` must not become `completed`: a stopped turn that reports success
 * makes downstream notifications ("done!") actively wrong.
 */
function terminalReasonFor(status: string | undefined): TerminalReason {
  switch (status) {
    case "interrupted":
    case "cancelled":
      return "aborted_streaming";
    case "failed":
      return "model_error";
    default:
      return "completed";
  }
}

export class CodexEventTranslator {
  private readonly threadId: string;
  private readonly codeshellServer: string;
  private turnNumber = 0;
  private activeTurnId: string | undefined;
  /** Turns that reached a terminal state. Late events for these are dropped. */
  private readonly finishedTurns = new Set<string>();
  /**
   * Serialized arguments each tool item was OPENED with, keyed by item id.
   * Codex allocates an item before its arguments are known (a webSearch opens
   * with `query: ""`), so on completion we compare and emit the settled values
   * when they differ — otherwise the transcript keeps the empty snapshot.
   */
  private readonly openedToolArgs = new Map<string, string>();

  constructor(options: CodexEventTranslatorOptions) {
    this.threadId = options.threadId;
    this.codeshellServer = options.codeshellServerName ?? CODESHELL_MCP_SERVER;
  }

  /**
   * Translate one notification. Returns zero or more events — zero is a normal,
   * common outcome (unknown method, other thread, stale turn), never an error.
   *
   * Deliberately total: the app-server is experimental and adds notifications
   * between versions, so an unrecognised or malformed one must not take a session
   * down.
   */
  translate(notification: unknown): StreamEvent[] {
    const envelope = asRecord(notification);
    if (!envelope) return [];
    const method = str(envelope.method);
    const params = asRecord(envelope.params);
    if (!method || !params) return [];

    // Thread scoping. `thread/started` is the documented exception: it carries
    // the id at `params.thread.id` rather than the usual top-level field.
    const nestedThread = asRecord(params.thread);
    const threadId = str(params.threadId) ?? str(nestedThread?.id);
    if (threadId && threadId !== this.threadId) return [];

    switch (method) {
      case "turn/started":
        return this.onTurnStarted(params);
      case "turn/completed":
        return this.onTurnCompleted(params);
      case "error":
        return this.onError(params);
      case "item/agentMessage/delta":
        return this.onAgentDelta(params);
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return this.onReasoningDelta(params);
      case "thread/tokenUsage/updated":
        return this.onTokenUsage(params);
      case "item/started":
        return this.onItemStarted(params);
      case "item/completed":
        return this.onItemCompleted(params);
      default:
        // Rate limits, plan updates and MCP status are not chat events.
        return [];
    }
  }

  /** True when an event belongs to a turn that has already finished. */
  private isStale(turnId: string | undefined): boolean {
    if (!turnId) return false;
    if (this.finishedTurns.has(turnId)) return true;
    // A turn id we have never seen, while another turn is live, is a straggler
    // from a superseded turn — not an implicit new turn.
    return this.activeTurnId !== undefined && turnId !== this.activeTurnId;
  }

  private remember(turnId: string): void {
    this.finishedTurns.add(turnId);
    if (this.finishedTurns.size > MAX_TOMBSTONES) {
      const oldest = this.finishedTurns.values().next().value;
      if (oldest !== undefined) this.finishedTurns.delete(oldest);
    }
    // A tool item opened but never completed (interrupt, crash) would otherwise
    // keep its entry forever on this long-lived translator.
    this.openedToolArgs.clear();
  }

  private onTurnStarted(params: Record<string, unknown>): StreamEvent[] {
    const turn = asRecord(params.turn);
    const turnId = str(turn?.id) ?? str(params.turnId);
    // A `turn/started` for an already-finished turn is an orphan (its RPC failed
    // and the daemon created the turn anyway, or completion beat it here). It
    // must not reactivate the session.
    if (turnId && this.finishedTurns.has(turnId)) return [];
    this.activeTurnId = turnId;
    this.turnNumber += 1;
    return [{ type: "stream_request_start", turnNumber: this.turnNumber }];
  }

  private onTurnCompleted(params: Record<string, unknown>): StreamEvent[] {
    const turn = asRecord(params.turn);
    const turnId = str(turn?.id) ?? str(params.turnId);
    // Duplicate delivery is expected; only the first completion closes the turn.
    if (turnId && this.finishedTurns.has(turnId)) return [];
    if (turnId) this.remember(turnId);
    this.activeTurnId = undefined;
    const reason = terminalReasonFor(str(turn?.status));
    if (reason === "model_error") {
      const error = asRecord(turn?.error);
      const detail = str(error?.message) ?? str(error?.additionalDetails);
      if (detail) {
        return [
          { type: "error", error: detail },
          { type: "turn_complete", reason },
        ];
      }
    }
    return [{ type: "turn_complete", reason }];
  }

  private onError(params: Record<string, unknown>): StreamEvent[] {
    // A retryable error is not terminal. Reporting completion here would close
    // the turn in the UI while Codex is still working on it — and 401 retries in
    // particular fire about once a second, so this would also storm.
    if (params.willRetry === true) return [];
    const turnId = str(params.turnId);
    if (turnId && this.finishedTurns.has(turnId)) return [];
    if (turnId) this.remember(turnId);
    this.activeTurnId = undefined;
    const error = asRecord(params.error);
    const message = str(error?.message) ?? str(error?.additionalDetails) ?? "Codex turn failed";
    return [
      { type: "error", error: message },
      { type: "turn_complete", reason: "model_error" },
    ];
  }

  private onAgentDelta(params: Record<string, unknown>): StreamEvent[] {
    if (this.isStale(str(params.turnId))) return [];
    const delta = str(params.delta);
    return delta ? [{ type: "text_delta", text: delta }] : [];
  }

  private onReasoningDelta(params: Record<string, unknown>): StreamEvent[] {
    if (this.isStale(str(params.turnId))) return [];
    const delta = str(params.delta);
    return delta ? [{ type: "thinking_delta", text: delta }] : [];
  }

  private onTokenUsage(params: Record<string, unknown>): StreamEvent[] {
    if (this.isStale(str(params.turnId))) return [];
    const usage = asRecord(params.tokenUsage);
    const total = asRecord(usage?.total);
    const last = asRecord(usage?.last);
    const number = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const promptTokens = number(last?.inputTokens);
    if (promptTokens === undefined) return [];
    const cacheReadTokens = number(last?.cachedInputTokens);
    const cumulativePromptTokens = number(total?.inputTokens);
    const cumulativeCacheReadTokens = number(total?.cachedInputTokens);
    const cacheCreationTokens = number(last?.cacheWriteInputTokens);
    const cumulativeCacheCreationTokens = number(total?.cacheWriteInputTokens);
    const completionTokens = number(last?.outputTokens);
    const cumulativeCompletionTokens = number(total?.outputTokens);
    return [
      {
        type: "usage_update",
        promptTokens,
        promptTokensSource: "provider_usage",
        promptTokensConfidence: "high",
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
        singleTurnPromptTokens: promptTokens,
        ...(cacheReadTokens !== undefined ? { singleTurnCacheReadTokens: cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined
          ? { singleTurnCacheCreationTokens: cacheCreationTokens }
          : {}),
        ...(cumulativePromptTokens !== undefined ? { cumulativePromptTokens } : {}),
        ...(cumulativeCacheReadTokens !== undefined ? { cumulativeCacheReadTokens } : {}),
        ...(cumulativeCacheCreationTokens !== undefined ? { cumulativeCacheCreationTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(cumulativeCompletionTokens !== undefined ? { cumulativeCompletionTokens } : {}),
      },
    ];
  }

  /**
   * A CodeShell Host Tool call must not produce a card here — `ToolExecutor`
   * already emits one, and two unsynchronised sources for one operation is
   * exactly what §15.2 forbids. Only OUR server is suppressed; a third-party MCP
   * server has no CodeShell-side lifecycle, so dropping it would lose the card.
   */
  private isCodeshellHostTool(item: Record<string, unknown> | undefined): boolean {
    if (!item) return false;
    if (str(item.type) !== "mcpToolCall") return false;
    return str(item.server) === this.codeshellServer;
  }

  private onItemStarted(params: Record<string, unknown>): StreamEvent[] {
    if (this.isStale(str(params.turnId))) return [];
    const item = asRecord(params.item);
    const id = str(item?.id);
    const type = str(item?.type);
    if (!item || !id || !type) return [];
    if (!TOOL_ITEM_TYPES.has(type)) return [];
    if (this.isCodeshellHostTool(item)) return [];
    const args = toolArgsOf(item);
    this.openedToolArgs.set(id, JSON.stringify(args));
    return [{ type: "tool_use_start", toolCall: { id, toolName: type, args } }];
  }

  private onItemCompleted(params: Record<string, unknown>): StreamEvent[] {
    if (this.isStale(str(params.turnId))) return [];
    const item = asRecord(params.item);
    const id = str(item?.id);
    const type = str(item?.type);
    if (!item || !id || !type) return [];
    if (!TOOL_ITEM_TYPES.has(type)) return [];
    if (this.isCodeshellHostTool(item)) return [];
    const rawOutput =
      item.aggregatedOutput ?? item.output ?? item.text ?? item.result ?? item.changes;
    let output: string | undefined;
    if (typeof rawOutput === "string") output = rawOutput;
    else if (rawOutput !== undefined && rawOutput !== null) {
      try {
        output = JSON.stringify(rawOutput);
      } catch {
        output = String(rawOutput);
      }
    }
    const error = asRecord(item.error);
    const errorMessage = str(error?.message) ?? str(item.error);
    const events: StreamEvent[] = [];
    // Correct the arguments first when they only materialized now, so the
    // recorded call shows what actually ran before its result.
    const openedArgs = this.openedToolArgs.get(id);
    this.openedToolArgs.delete(id);
    if (openedArgs !== undefined) {
      const settledArgs = toolArgsOf(item);
      if (Object.keys(settledArgs).length > 0 && JSON.stringify(settledArgs) !== openedArgs) {
        events.push({ type: "tool_use_args_delta", toolCallId: id, args: settledArgs });
      }
    }
    events.push({
      type: "tool_result",
      result: {
        id,
        toolName: type,
        ...(output !== undefined ? { result: output } : {}),
        ...(errorMessage ? { error: errorMessage, isError: true } : {}),
      },
    });
    return events;
  }
}
