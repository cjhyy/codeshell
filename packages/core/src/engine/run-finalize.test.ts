import { describe, expect, test } from "bun:test";
import { finalizeRunSuccess } from "./run-finalize.js";
import type { StreamEvent } from "../types.js";

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
        persistFinalRunState: () => {},
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
          },
          transcript: { flushFailed: () => false, getEvents: () => [] },
        } as never,
        result: { text: "done", reason, messages: [] },
        firstGoalTermination: undefined,
        turnCount: 3,
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
        persistFinalRunState: () => {},
        markRunAccountingFinalized: () => {},
        costStoreSerialize: undefined,
        profile: undefined,
        getProfileReportedResults: () => undefined,
      });

      expect(result.usage.promptTokens).toBe(3400);
      expect(events).toEqual([
        {
          type: "usage_update",
          promptTokens: 0,
          singleTurnPromptTokens: result.usage.promptTokens,
          singleTurnCacheReadTokens: result.usage.cacheReadTokens,
          singleTurnCacheCreationTokens: result.usage.cacheCreationTokens,
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
});
