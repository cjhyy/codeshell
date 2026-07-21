import { describe, expect, test } from "bun:test";
import { finalizeRunSuccess } from "./run-finalize.js";

describe("finalizeRunSuccess", () => {
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
