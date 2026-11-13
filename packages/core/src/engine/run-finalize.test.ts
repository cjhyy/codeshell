import { describe, expect, test } from "bun:test";
import {
  buildRunFailureResult,
  drainHeadlessBackgroundAgents,
  finalizeRunSuccess,
} from "./run-finalize.js";
import type { StreamEvent } from "../types.js";
import { armGoalLifecycle, createGoalLifecycle, waitGoalLifecycle } from "../goal/lifecycle.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";

test("headless user waits keep background results queued until a real reply re-arms the goal", async () => {
  const sid = "headless-user-wait-results";
  notificationQueue.reset(sid);
  const original = notificationQueue.enqueue(
    {
      agentId: "finished-child",
      description: "collected evidence",
      finalText: "saved result",
      status: "completed",
      enqueuedAt: 1,
    },
    sid,
  );
  const stored: unknown[] = [];
  const session = {
    state: {
      goalLifecycle: waitGoalLifecycle(createGoalLifecycle({ objective: "finish" }), 1_000, "user"),
    },
    transcript: {
      appendMessage(role: string, content: unknown, opts: unknown) {
        stored.push({ role, opts, content });
        return { id: `event-${stored.length}`, type: "message", data: { role, content } };
      },
    },
  };
  const result = { text: "请确认", reason: "completed", messages: [] } as const;
  let summarized = 0;
  const args = {
    sid,
    session: session as never,
    signal: undefined,
    initialResult: result as never,
    runTurnLoop: async () => {
      summarized++;
      return result as never;
    },
    applyGoalTermination() {},
    waitForBackgroundAgentChange: async () => false,
    waitForBackgroundAgentChangeOrTimeout: async () => false,
    getFirstGoalTermination: () => undefined,
    setFirstGoalTermination() {},
  };
  try {
    await drainHeadlessBackgroundAgents(args);
    expect(summarized).toBe(0);
    expect(notificationQueue.getSnapshot(sid)).toEqual([original]);
    session.state.goalLifecycle = armGoalLifecycle(session.state.goalLifecycle!, 2_000);
    await drainHeadlessBackgroundAgents(args);
    expect(summarized).toBe(1);
    expect(notificationQueue.getSnapshot(sid)).toHaveLength(0);
    // The notification the model is sent is stored as engine context.
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ role: "user", opts: { hookReminder: {} } });
  } finally {
    notificationQueue.reset(sid);
  }
});

test("initialization failure still attempts its terminal when the error publication fails", () => {
  const events: StreamEvent[] = [];
  expect(() =>
    buildRunFailureResult({
      err: new Error("initialization failed"),
      session: {
        state: {
          sessionId: "initialization-publication-failed",
          status: "active",
          turnCount: 0,
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
        transcript: { appendError() {} },
      } as never,
      persistFinalRunState() {},
      options: {
        onStream(event) {
          events.push(event);
          if (event.type === "error") throw new Error("error publication failed");
        },
      },
    }),
  ).toThrow("error publication failed");
  expect(events.map((event) => event.type)).toEqual(["error", "turn_complete"]);
  expect(events.at(-1)).toEqual({ type: "turn_complete", reason: "model_error" });
});

describe("finalizeRunSuccess", () => {
  test.each(["completed", "aborted_tools", "model_error"] as const)(
    "%s with an unresolved write never feeds memory/title or claims completion",
    async (reason) => {
      const events: StreamEvent[] = [],
        hooks: Array<Record<string, unknown>> = [];
      const persistedMessages: unknown[] = [];
      let cachedMessages: unknown[] = [],
        lastMessages: unknown[] = [];
      let memory = 0,
        titles = 0,
        sealed = 0;
      const state = {
        sessionId: "unverified-session",
        status: "active",
        turnCount: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
      const result = await finalizeRunSuccess({
        session: {
          state,
          transcript: {
            appendMessage: (role: string, content: string, options: unknown) => {
              persistedMessages.push({ role, content, options });
            },
            flushFailed: () => false,
            getEvents: () => [
              { id: "user-event", data: { role: "user", content: "synthetic fixture" } },
            ],
          },
        } as never,
        result: {
          reason,
          text: "model claims success",
          completionKind: "background_wait",
          messages: [{ role: "assistant", content: "model claims success" }],
        },
        hasUnverifiedWrites: () => {
          sealed++;
          return true;
        },
        firstGoalTermination: undefined,
        turnCount: 1,
        getRunCacheUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
        getRunUsage: () => ({
          records: [],
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          requestCount: 0,
        }),
        usageBaseline: state.tokenUsage,
        userContextMsg: null,
        dynamicContextMsg: null,
        setCompactedMessages: (_sid, messages) => {
          cachedMessages = messages;
        },
        setLastMessages: (messages) => {
          lastMessages = messages;
        },
        options: { onStream: (event) => events.push(event) },
        emitHook: async (_event, payload) => {
          hooks.push(payload);
          return {};
        },
        cwd: "/synthetic",
        llmClient: {} as never,
        auxSummaryClient: {
          createMessage: async () => {
            titles++;
            return { text: "forbidden title" };
          },
        } as never,
        recordExternalBilledUsage: () => ({
          cumulativePromptTokens: 0,
          cumulativeCacheReadTokens: 0,
          cumulativeCacheCreationTokens: 0,
        }),
        runMemoryPipeline: () => {
          memory++;
        },
        updatePersistedSessionState: () => {},
        persistFinalRunState: () => true,
        markRunAccountingFinalized: () => {},
        costStoreSerialize: undefined,
        profile: undefined,
        getProfileReportedResults: () => undefined,
      });
      const terminal = reason === "completed" ? "unverified_write" : reason;
      expect(result.reason).toBe(terminal);
      expect(state.status).toBe(terminal);
      expect(events.at(-1)).toMatchObject({ type: "turn_complete", reason: terminal });
      expect(hooks.every((event) => event.reason === terminal)).toBe(true);
      expect({ memory, titles, sealed }).toEqual({ memory: 0, titles: 0, sealed: 1 });
      expect(persistedMessages).toEqual([
        {
          role: "assistant",
          content: expect.stringContaining("尚未通过独立回读验证"),
          options: { authority: "system" },
        },
      ]);
      expect(cachedMessages.at(-1)).toMatchObject({
        content: expect.stringContaining("尚未通过独立回读验证"),
      });
      expect(lastMessages).toEqual(cachedMessages);
      if (reason === "completed") {
        expect(result.completionKind).toBeUndefined();
        expect(result.text).not.toContain("model claims success");
      }
    },
  );
  test.each(["completed", "aborted_streaming", "model_error"] as const)(
    "settles all billed run usage before %s without including previous turns",
    async (reason) => {
      const events: StreamEvent[] = [];
      const result = await finalizeRunSuccess({
        session: {
          state: {
            sessionId: "usage-settlement",
            tokenUsage: { promptTokens: 9000, completionTokens: 900, totalTokens: 9900 },
            cacheUsageVersion: 1,
            cumulativePromptTokens: 8000,
            cumulativeCacheReadTokens: 4000,
            cumulativeCacheCreationTokens: 0,
          },
          transcript: { flushFailed: () => false, getEvents: () => [] },
        } as never,
        result: { text: "done", reason, messages: [] },
        firstGoalTermination: undefined,
        turnCount: 3,
        getRunCacheUsage: () => ({
          promptTokens: 3000,
          completionTokens: 100,
          totalTokens: 3100,
          cacheReadTokens: 2550,
          cacheCreationTokens: 120,
        }),
        getRunUsage: () => ({
          records: [],
          totalPromptTokens: 3400,
          totalCompletionTokens: 120,
          totalTokens: 3520,
          totalCacheReadTokens: 2550,
          totalCacheCreationTokens: 120,
          requestCount: 4,
        }),
        usageBaseline: { promptTokens: 9000, completionTokens: 900, totalTokens: 9900 },
        userContextMsg: null,
        dynamicContextMsg: null,
        setCompactedMessages: () => {},
        setLastMessages: () => {},
        options: { onStream: (event) => events.push(event) },
        emitHook: async () => ({}),
        cwd: "/work/app",
        llmClient: {} as never,
        auxSummaryClient: {} as never,
        recordExternalBilledUsage: () => ({
          cumulativePromptTokens: 0,
          cumulativeCacheReadTokens: 0,
          cumulativeCacheCreationTokens: 0,
        }),
        runMemoryPipeline: () => {},
        updatePersistedSessionState: () => {},
        persistFinalRunState: () => true,
        markRunAccountingFinalized: () => {},
        costStoreSerialize: undefined,
        profile: undefined,
        getProfileReportedResults: () => undefined,
      });

      expect(result.usage.promptTokens).toBe(3400);
      expect(events).toEqual([
        expect.objectContaining({
          type: "usage_update",
          promptTokensSource: "session_cumulative",
          cumulativePromptTokens: 8000,
          cumulativeCacheReadTokens: 4000,
          cumulativeCacheCreationTokens: 0,
        }),
        {
          type: "usage_update",
          promptTokens: 0,
          cacheUsageVersion: 1,
          singleTurnPromptTokens: 3000,
          singleTurnCacheReadTokens: 2550,
          singleTurnCacheCreationTokens: 120,
        },
        { type: "turn_complete", reason, text: "done" },
      ]);
    },
  );

  test("persists the exceptional completion kind with the terminal state", async () => {
    let persisted: Record<string, unknown> | undefined;
    const session = {
      state: {
        sessionId: "session-background-wait",
        cwd: "/work/app",
        status: "active",
        turnCount: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
      transcript: {
        flushFailed: () => false,
        getEvents: () => [],
      },
    } as never;

    await finalizeRunSuccess({
      session,
      result: {
        text: "",
        reason: "completed",
        completionKind: "background_wait",
        messages: [],
      },
      firstGoalTermination: undefined,
      turnCount: 1,
      getRunCacheUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      getRunUsage: () => ({
        records: [],
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        requestCount: 0,
      }),
      usageBaseline: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      userContextMsg: null,
      dynamicContextMsg: null,
      setCompactedMessages: () => undefined,
      setLastMessages: () => undefined,
      options: undefined,
      emitHook: async () => ({}),
      cwd: "/work/app",
      llmClient: {} as never,
      auxSummaryClient: {} as never,
      recordExternalBilledUsage: () => ({
        cumulativePromptTokens: 0,
        cumulativeCacheReadTokens: 0,
        cumulativeCacheCreationTokens: 0,
      }),
      runMemoryPipeline: () => undefined,
      updatePersistedSessionState: () => undefined,
      persistFinalRunState: (state) => {
        persisted = structuredClone(state) as unknown as Record<string, unknown>;
        return true;
      },
      markRunAccountingFinalized: () => undefined,
      costStoreSerialize: undefined,
      profile: undefined,
      getProfileReportedResults: () => undefined,
    });

    expect(persisted).toMatchObject({
      status: "completed",
      lastCompletionKind: "background_wait",
    });
  });

  async function runVerified(profile: unknown): Promise<number> {
    let memory = 0;
    const state = {
      sessionId: "verified-session",
      status: "active",
      turnCount: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    await finalizeRunSuccess({
      session: {
        state,
        transcript: {
          appendMessage: () => {},
          flushFailed: () => false,
          getEvents: () => [{ id: "user-event", data: { role: "user", content: "hi" } }],
        },
      } as never,
      result: {
        reason: "completed",
        text: "done",
        messages: [{ role: "assistant", content: "done" }],
      },
      hasUnverifiedWrites: () => false,
      firstGoalTermination: undefined,
      turnCount: 1,
      getRunCacheUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      getRunUsage: () => ({
        records: [],
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        requestCount: 0,
      }),
      usageBaseline: state.tokenUsage,
      userContextMsg: null,
      dynamicContextMsg: null,
      setCompactedMessages: () => {},
      setLastMessages: () => {},
      options: { onStream: () => {} },
      emitHook: async () => ({}),
      cwd: "/synthetic",
      llmClient: {} as never,
      auxSummaryClient: { createMessage: async () => ({ text: "title" }) } as never,
      recordExternalBilledUsage: () => ({
        cumulativePromptTokens: 0,
        cumulativeCacheReadTokens: 0,
        cumulativeCacheCreationTokens: 0,
      }),
      runMemoryPipeline: () => {
        memory++;
      },
      updatePersistedSessionState: () => {},
      persistFinalRunState: () => true,
      markRunAccountingFinalized: () => {},
      costStoreSerialize: undefined,
      profile: profile as never,
      getProfileReportedResults: () => undefined,
    });
    return memory;
  }

  test("disableMemoryPipeline skips the post-run memory pipeline", async () => {
    expect(await runVerified({ id: "pet", disableMemoryPipeline: true })).toBe(0);
  });

  test("verified runs without the flag still run the memory pipeline", async () => {
    expect(await runVerified(undefined)).toBe(1);
  });
});
