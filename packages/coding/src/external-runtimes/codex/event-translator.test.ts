/**
 * Codex app-server notifications → CodeShell `StreamEvent`.
 *
 * Shapes come from the generated protocol bindings of a real codex-cli 0.145.0
 * (`codex app-server generate-ts`), not from guesses.
 *
 * Two rules from §15.2/§15.2.1 drive most of these tests:
 *
 *  - Host Tool lifecycle belongs to the Runtime translator, and approval events
 *    for `mcp__codeshell_tools__*` belong to CodeShell. Each side must DROP the
 *    other's, or the UI shows one operation twice from two unsynchronised sources.
 *  - A notification for a thread this translator does not own is dropped, not
 *    guessed at.
 */
import { describe, expect, test } from "bun:test";
import { CodexEventTranslator } from "./event-translator.js";

function translator(threadId = "thread-a") {
  return new CodexEventTranslator({ threadId, sessionId: "sess-a" });
}

function tokenUsage(
  turnId: string,
  last: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number },
  total = last,
) {
  return {
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread-a", turnId, tokenUsage: { last, total } },
  };
}

describe("CodexEventTranslator", () => {
  test("turn/started opens a stream request", () => {
    const events = translator().translate({
      method: "turn/started",
      params: { threadId: "thread-a", turn: { id: "turn-1" } },
    });
    expect(events).toEqual([{ type: "stream_request_start", turnNumber: 1 }]);
  });

  test("agent message deltas become text_delta", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const events = t.translate({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-a", turnId: "t1", itemId: "i1", delta: "Hel" },
    });
    expect(events).toEqual([{ type: "text_delta", text: "Hel" }]);
  });

  test("turn numbers increment across turns", () => {
    const t = translator();
    expect(
      t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } }),
    ).toEqual([{ type: "stream_request_start", turnNumber: 1 }]);
    t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
    });
    expect(
      t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t2" } } }),
    ).toEqual([{ type: "stream_request_start", turnNumber: 2 }]);
  });

  test("turn/completed maps status to a TerminalReason", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    expect(
      t.translate({
        method: "turn/completed",
        params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
      }),
    ).toEqual([{ type: "turn_complete", reason: "completed" }]);
  });

  test("an interrupted turn reports aborted, not completed", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const events = t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "interrupted" } },
    });
    expect(events).toEqual([{ type: "turn_complete", reason: "aborted_streaming" }]);
  });

  test("a failed completed turn preserves its provider error detail", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const events = t.translate({
      method: "turn/completed",
      params: {
        threadId: "thread-a",
        turn: { id: "t1", status: "failed", error: { message: "sandbox setup failed" } },
      },
    });
    expect(events).toEqual([
      { type: "error", error: "sandbox setup failed" },
      { type: "turn_complete", reason: "model_error" },
    ]);
  });

  test("an error notification becomes a model_error turn_complete", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const events = t.translate({
      method: "error",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        willRetry: false,
        error: { message: "upstream exploded" },
      },
    });
    expect(events).toEqual([
      { type: "error", error: "upstream exploded" },
      { type: "turn_complete", reason: "model_error" },
    ]);
  });

  test("an error that WILL be retried is not a terminal event", () => {
    // Reporting turn_complete on a retryable error would close the turn in the
    // UI while Codex is still working on it.
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const events = t.translate({
      method: "error",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        willRetry: true,
        error: { message: "429, retrying" },
      },
    });
    expect(events).toEqual([]);
  });

  test("a notification for another thread is dropped, never guessed at", () => {
    const t = translator("thread-a");
    const events = t.translate({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-OTHER", turnId: "t1", itemId: "i1", delta: "leak" },
    });
    expect(events).toEqual([]);
  });

  test("a native tool call becomes a tool lifecycle pair", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const started = t.translate({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: { id: "i1", type: "commandExecution", command: "ls -la" },
        startedAtMs: 1,
      },
    });
    expect(started).toEqual([
      {
        type: "tool_use_start",
        toolCall: { id: "i1", toolName: "commandExecution", args: { command: "ls -la" } },
      },
    ]);

    const completed = t.translate({
      method: "item/completed",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: { id: "i1", type: "commandExecution", aggregatedOutput: "total 0" },
        completedAtMs: 2,
      },
    });
    expect(completed).toEqual([
      {
        type: "tool_result",
        result: { id: "i1", toolName: "commandExecution", result: "total 0" },
      },
    ]);
  });

  test("reasoning and agent messages are prose, not fake tool cards", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    expect(
      t.translate({
        method: "item/started",
        params: {
          threadId: "thread-a",
          turnId: "t1",
          item: { id: "r1", type: "reasoning", summary: [], content: [] },
        },
      }),
    ).toEqual([]);
    expect(
      t.translate({
        method: "item/completed",
        params: {
          threadId: "thread-a",
          turnId: "t1",
          item: { id: "m1", type: "agentMessage", text: "done" },
        },
      }),
    ).toEqual([]);
  });

  test("provider token usage reaches the CodeShell usage stream", () => {
    const events = translator().translate({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        tokenUsage: {
          last: {
            inputTokens: 87397,
            cachedInputTokens: 78592,
            cacheWriteInputTokens: 0,
            outputTokens: 5577,
          },
          total: {
            inputTokens: 844271,
            cachedInputTokens: 750848,
            cacheWriteInputTokens: 0,
            outputTokens: 5577,
          },
        },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "usage_update",
        promptTokens: 87397,
        cacheReadTokens: 78592,
        cumulativePromptTokens: 844271,
        cumulativeCacheReadTokens: 750848,
        completionTokens: 5577,
        cumulativeCompletionTokens: 5577,
      }),
    ]);
  });

  test("turn usage includes every model request while context usage stays on the last request", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const first = { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 100 };
    expect(t.translate(tokenUsage("t1", first))[0]).toMatchObject({
      singleTurnPromptTokens: 1000,
      singleTurnCacheReadTokens: 800,
      singleTurnCacheCreationTokens: 100,
    });
    const next = tokenUsage(
      "t1",
      { inputTokens: 1500, cachedInputTokens: 1200, cacheWriteInputTokens: 150 },
      { inputTokens: 2500, cachedInputTokens: 2000, cacheWriteInputTokens: 250 },
    );
    const expected = {
      promptTokens: 1500,
      cacheReadTokens: 1200,
      cacheCreationTokens: 150,
      singleTurnPromptTokens: 2500,
      singleTurnCacheReadTokens: 2000,
      singleTurnCacheCreationTokens: 250,
      cumulativePromptTokens: 2500,
      cumulativeCacheReadTokens: 2000,
      cumulativeCacheCreationTokens: 250,
    };
    expect(t.translate(next)[0]).toMatchObject(expected);
    expect(t.translate(next)[0]).toMatchObject(expected);
    expect(t.translate(tokenUsage("t1", first))[0]).toMatchObject({
      singleTurnPromptTokens: 2500,
      singleTurnCacheReadTokens: 2000,
      singleTurnCacheCreationTokens: 250,
    });

    // A missed intermediate notification is still included by the cumulative
    // total; summing only the observed `last` snapshots would undercount.
    expect(
      t.translate(
        tokenUsage(
          "t1",
          { inputTokens: 2000, cachedInputTokens: 1600, cacheWriteInputTokens: 200 },
          { inputTokens: 6500, cachedInputTokens: 5200, cacheWriteInputTokens: 650 },
        ),
      )[0],
    ).toMatchObject({
      promptTokens: 2000,
      singleTurnPromptTokens: 6500,
      singleTurnCacheReadTokens: 5200,
      singleTurnCacheCreationTokens: 650,
    });
  });

  test("a new turn resets its total without including the previous turn", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    t.translate(
      tokenUsage("t1", { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 100 }),
    );
    t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
    });
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t2" } } });
    const update = tokenUsage(
      "t2",
      { inputTokens: 1500, cachedInputTokens: 1200, cacheWriteInputTokens: 150 },
      { inputTokens: 2500, cachedInputTokens: 2000, cacheWriteInputTokens: 250 },
    );
    const expected = {
      singleTurnPromptTokens: 1500,
      singleTurnCacheReadTokens: 1200,
      singleTurnCacheCreationTokens: 150,
      cumulativePromptTokens: 2500,
    };
    expect(t.translate(update)[0]).toMatchObject(expected);
    // Duplicate starts must not reset the baseline partway through a turn.
    expect(
      t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t2" } } }),
    ).toEqual([]);
    expect(t.translate(update)[0]).toMatchObject(expected);
    expect(
      t.translate(
        tokenUsage("t1", {
          inputTokens: 3000,
          cachedInputTokens: 2400,
          cacheWriteInputTokens: 300,
        }),
      ),
    ).toEqual([]);
  });

  test("a resumed thread excludes historical usage from its first new turn", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    expect(
      t.translate(
        tokenUsage(
          "t1",
          { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 100 },
          { inputTokens: 11000, cachedInputTokens: 8800, cacheWriteInputTokens: 1100 },
        ),
      )[0],
    ).toMatchObject({
      singleTurnPromptTokens: 1000,
      singleTurnCacheReadTokens: 800,
      singleTurnCacheCreationTokens: 100,
      cumulativePromptTokens: 11000,
    });
    expect(
      t.translate(
        tokenUsage(
          "t1",
          { inputTokens: 1500, cachedInputTokens: 1200, cacheWriteInputTokens: 150 },
          { inputTokens: 12500, cachedInputTokens: 10000, cacheWriteInputTokens: 1250 },
        ),
      )[0],
    ).toMatchObject({
      singleTurnPromptTokens: 2500,
      singleTurnCacheReadTokens: 2000,
      singleTurnCacheCreationTokens: 250,
      cumulativePromptTokens: 12500,
    });
  });

  test("a provider accounting reset between turns establishes a fresh baseline", () => {
    const t = translator();
    t.translate(
      tokenUsage("t1", { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 100 }),
    );
    t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
    });
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t2" } } });
    const first = { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 10 };
    expect(t.translate(tokenUsage("t2", first))[0]).toMatchObject({
      singleTurnPromptTokens: 100,
      singleTurnCacheReadTokens: 80,
      singleTurnCacheCreationTokens: 10,
      cumulativePromptTokens: 100,
    });
    expect(
      t.translate(
        tokenUsage("t2", first, {
          inputTokens: 200,
          cachedInputTokens: 160,
          cacheWriteInputTokens: 20,
        }),
      )[0],
    ).toMatchObject({
      singleTurnPromptTokens: 200,
      singleTurnCacheReadTokens: 160,
      singleTurnCacheCreationTokens: 20,
      cumulativePromptTokens: 200,
    });
    t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t2", status: "completed" } },
    });
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t3" } } });
    expect(
      t.translate(
        tokenUsage("t3", first, {
          inputTokens: 300,
          cachedInputTokens: 240,
          cacheWriteInputTokens: 30,
        }),
      )[0],
    ).toMatchObject({
      singleTurnPromptTokens: 100,
      singleTurnCacheReadTokens: 80,
      singleTurnCacheCreationTokens: 10,
      cumulativePromptTokens: 300,
    });
  });

  test("usage delivered before turn/started remains part of the same turn", () => {
    const t = translator();
    const first = { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 100 };
    t.translate(tokenUsage("t1", first));
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    expect(
      t.translate(
        tokenUsage("t1", first, {
          inputTokens: 2000,
          cachedInputTokens: 1600,
          cacheWriteInputTokens: 200,
        }),
      )[0],
    ).toMatchObject({
      singleTurnPromptTokens: 2000,
      singleTurnCacheReadTokens: 1600,
      singleTurnCacheCreationTokens: 200,
    });
  });

  test("a partial usage notification is not repeatedly added as new work", () => {
    const t = translator();
    const update = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 800 } },
      },
    };
    const expected = { singleTurnPromptTokens: 1000, singleTurnCacheReadTokens: 800 };
    expect(t.translate(update)[0]).toMatchObject(expected);
    expect(t.translate(update)[0]).toMatchObject(expected);
  });

  test("a CodeShell Host Tool call is NOT re-emitted as a tool card", () => {
    // §15.2: the Host Tool already produces its own lifecycle through
    // ToolExecutor. Emitting a second card from the Runtime side would show the
    // same call twice, from two sources that are not synchronised.
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const events = t.translate({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: { id: "i9", type: "mcpToolCall", server: "codeshell_tools", tool: "Panel" },
        startedAtMs: 1,
      },
    });
    expect(events).toEqual([]);
  });

  test("a THIRD-PARTY mcp tool call still produces a card", () => {
    // Only CodeShell's own server is suppressed; other MCP servers have no
    // CodeShell-side lifecycle, so dropping them would lose the card entirely.
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const events = t.translate({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: { id: "i8", type: "mcpToolCall", server: "figma", tool: "get_file" },
        startedAtMs: 1,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tool_use_start" });
  });

  test("an unknown notification method is ignored rather than throwing", () => {
    // The app-server is experimental and adds notifications between versions; an
    // unrecognised one must not take the session down.
    const t = translator();
    expect(
      t.translate({ method: "some/futureNotification", params: { threadId: "thread-a" } }),
    ).toEqual([]);
    expect(t.translate({ method: "thread/tokenUsage/updated", params: {} })).toEqual([]);
  });

  test("a malformed notification is ignored rather than throwing", () => {
    const t = translator();
    expect(t.translate(null)).toEqual([]);
    expect(t.translate({})).toEqual([]);
    expect(t.translate({ method: "item/started" })).toEqual([]);
    expect(t.translate({ method: 42 as never, params: {} })).toEqual([]);
  });

  test("deltas arriving after the turn completed are dropped", () => {
    // §13.3: events from a finished turn must not reopen it.
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
    });
    const late = t.translate({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-a", turnId: "t1", itemId: "i1", delta: "late" },
    });
    expect(late).toEqual([]);
  });

  test("a duplicated turn/completed closes the turn only once", () => {
    // The app-server may deliver turn/completed more than once. A second
    // turn_complete would double-count usage and re-fire "done" notifications.
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const first = t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
    });
    const second = t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test("an orphan turn/started cannot reactivate a finished turn", () => {
    // The `turn/start` RPC can fail or time out while the daemon created the turn
    // anyway, and turn/completed can beat turn/started here. Either way a late
    // turn/started must not put the session back into "generating" — that is the
    // documented cause of a session hanging busy forever.
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "interrupted" } },
    });
    const orphan = t.translate({
      method: "turn/started",
      params: { threadId: "thread-a", turn: { id: "t1" } },
    });
    expect(orphan).toEqual([]);
  });

  test("an item arriving after turn/completed is dropped", () => {
    // Items are allowed to trail the completion. Without a tombstone that
    // outlives the turn, a late item re-opens a turn whose completion was
    // already consumed.
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
    });
    const late = t.translate({
      method: "item/completed",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: { id: "i1", type: "commandExecution", aggregatedOutput: "trailing" },
        completedAtMs: 9,
      },
    });
    expect(late).toEqual([]);
  });

  test("a non-retryable error tombstones the turn so later completion is ignored", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    const failed = t.translate({
      method: "error",
      params: { threadId: "thread-a", turnId: "t1", willRetry: false, error: { message: "boom" } },
    });
    expect(failed).toEqual([
      { type: "error", error: "boom" },
      { type: "turn_complete", reason: "model_error" },
    ]);
    // The turn already reported terminal; a trailing completion must not add a
    // second terminal event.
    const trailing = t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "failed" } },
    });
    expect(trailing).toEqual([]);
  });

  test("thread/started is scoped via params.thread.id, not params.threadId", () => {
    // Documented protocol asymmetry: every other notification uses the top-level
    // field. Reading only `params.threadId` would treat another thread's
    // thread/started as belonging to us.
    const t = translator("thread-a");
    // Another thread's start must be ignored even though params.threadId is absent.
    expect(
      t.translate({ method: "thread/started", params: { thread: { id: "thread-OTHER" } } }),
    ).toEqual([]);
  });

  test("a delta for a superseded turn id is dropped", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    t.translate({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "t1", status: "completed" } },
    });
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t2" } } });
    // A straggler from t1 while t2 is live.
    expect(
      t.translate({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-a", turnId: "t1", itemId: "i1", delta: "stale" },
      }),
    ).toEqual([]);
  });
});

describe("codex tool arguments that only appear on completion", () => {
  test("emits the settled arguments when item/started carried none", () => {
    // Codex allocates a webSearch item before the query is known: item/started
    // reports `query: ""` and the real query only appears on item/completed.
    // Without a follow-up args event the transcript keeps the empty snapshot,
    // which is what made `webSearch {"query": ""}` unauditable in real
    // sessions.
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    t.translate({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: { id: "w1", type: "webSearch", query: "" },
      },
    });

    const completed = t.translate({
      method: "item/completed",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: { id: "w1", type: "webSearch", query: "紫金矿业 2026 半年报" },
      },
    });

    expect(completed).toEqual([
      {
        type: "tool_use_args_delta",
        toolCallId: "w1",
        args: { query: "紫金矿业 2026 半年报" },
      },
      { type: "tool_result", result: { id: "w1", toolName: "webSearch" } },
    ]);
  });

  test("does not emit an args delta when the arguments never changed", () => {
    const t = translator();
    t.translate({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "t1" } } });
    t.translate({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: { id: "c1", type: "commandExecution", command: "ls -la" },
      },
    });
    const completed = t.translate({
      method: "item/completed",
      params: {
        threadId: "thread-a",
        turnId: "t1",
        item: {
          id: "c1",
          type: "commandExecution",
          command: "ls -la",
          aggregatedOutput: "total 0",
        },
      },
    });
    expect(completed).toEqual([
      {
        type: "tool_result",
        result: { id: "c1", toolName: "commandExecution", result: "total 0" },
      },
    ]);
  });
});
