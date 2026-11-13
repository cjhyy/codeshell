import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateMessageOptions } from "../llm/types.js";
import { ModelPool } from "../llm/model-pool.js";
import type { SettingsManager } from "../settings/manager.js";
import type { ToolContext } from "../tool-system/context.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { contextMessageMark, isContextMessageEvent } from "../session/context-messages.js";
import { Transcript } from "../session/transcript.js";
import type { Message, StreamEvent } from "../types.js";
import { AuxiliaryPipeline, type EngineLlmClient } from "./auxiliary-pipeline.js";
import { drainHeadlessBackgroundAgents, finalizeRunSuccess } from "./run-finalize.js";

let root: string;
let previousHome: string | undefined;
let previousCodeShellHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "headless-background-notice-"));
  previousHome = process.env.HOME;
  previousCodeShellHome = process.env.CODE_SHELL_HOME;
  process.env.HOME = root;
  process.env.CODE_SHELL_HOME = join(root, ".code-shell");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousCodeShellHome;
  rmSync(root, { recursive: true, force: true });
});

const usage = { promptTokens: 20, completionTokens: 10, totalTokens: 30 };

/** A headless one-shot run whose background agent finished: the drain injects its result. */
async function drainOneNotice(sid: string, transcript: Transcript, history: Message[]) {
  notificationQueue.reset(sid);
  notificationQueue.enqueue(
    {
      agentId: "finished-child",
      description: "collected evidence",
      finalText: "BACKGROUND_RESULT",
      status: "completed",
      enqueuedAt: 1,
    },
    sid,
  );
  let sent: Message[] = [];
  try {
    await drainHeadlessBackgroundAgents({
      sid,
      session: { state: {}, transcript } as never,
      signal: undefined,
      initialResult: { text: "first answer", reason: "completed", messages: history } as never,
      runTurnLoop: async (messages) => {
        sent = messages;
        const reply: Message = { role: "assistant", content: "summarized" };
        transcript.appendMessage("assistant", "summarized");
        return { text: "summarized", reason: "completed", messages: [...messages, reply] } as never;
      },
      applyGoalTermination() {},
      waitForBackgroundAgentChange: async () => false,
      waitForBackgroundAgentChangeOrTimeout: async () => false,
      getFirstGoalTermination: () => undefined,
      setFirstGoalTermination() {},
    });
  } finally {
    notificationQueue.reset(sid);
  }
  return sent;
}

function oneShotTranscript(name: string): { transcript: Transcript; history: Message[] } {
  const transcript = Transcript.inMemory(name);
  transcript.appendMessage("user", "the only task");
  transcript.appendMessage("assistant", "first answer");
  return {
    transcript,
    history: [
      { role: "user", content: "the only task" },
      { role: "assistant", content: "first answer" },
    ],
  };
}

test("the background notice is stored as engine context and replays as it was sent", async () => {
  const { transcript, history } = oneShotTranscript("background-notice-replay");
  const sent = await drainOneNotice("background-notice-replay", transcript, history);
  const notice = sent.at(-1)!;
  expect(JSON.stringify(notice)).toContain("BACKGROUND_RESULT");
  expect(contextMessageMark(notice)?.kind).toBe("hook-reminder");

  const stored = transcript.getEvents("message").find((event) => isContextMessageEvent(event))!;
  expect(stored.data).toMatchObject({ role: "user", injected: true, hookReminder: {} });
  expect(stored.data.clientMessageId).toBeUndefined();

  const replay = transcript.toMessages();
  expect(replay.slice(0, sent.length)).toEqual(sent);
  expect(contextMessageMark(replay[sent.length - 1]!)?.kind).toBe("hook-reminder");
});

test("a one-shot run with a background notice still gets its title", async () => {
  const { transcript, history } = oneShotTranscript("background-notice-title");
  await drainOneNotice("background-notice-title", transcript, history);
  const titled: string[] = [];
  const events: StreamEvent[] = [];
  const state = {
    sessionId: "background-notice-title",
    status: "active",
    turnCount: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  await finalizeRunSuccess({
    session: { state, transcript } as never,
    result: { reason: "completed", text: "summarized", messages: [] },
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
    options: { onStream: (event) => events.push(event) },
    emitHook: async () => ({}),
    cwd: root,
    llmClient: {} as never,
    auxSummaryClient: {
      createMessage: async (options: CreateMessageOptions) => {
        titled.push(JSON.stringify(options.messages));
        return { text: "Background title", toolCalls: [], stopReason: "stop", usage };
      },
    } as never,
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
  for (let tick = 0; tick < 20 && titled.length === 0; tick += 1) await Promise.resolve();
  expect(titled).toHaveLength(1);
  expect(titled[0]).toContain("the only task");
  expect(titled[0]).not.toContain("BACKGROUND_RESULT");
});

test("memory extraction does not read the background notice as user input", async () => {
  const { transcript, history } = oneShotTranscript("background-notice-memory");
  for (let index = 0; index < 4; index += 1) {
    transcript.appendMessage("user", `follow-up ${index}`);
    transcript.appendMessage("assistant", `answer ${index}`);
  }
  await drainOneNotice("background-notice-memory", transcript, history);
  const calls: CreateMessageOptions[] = [];
  const client = {
    createMessage: async (options: CreateMessageOptions) => {
      calls.push(options);
      return { text: "[]", toolCalls: [], stopReason: "stop", usage };
    },
  } as EngineLlmClient;
  const pipeline = new AuxiliaryPipeline({
    config: () => ({ llm: { provider: "fixture", model: "memory-fixture" } }),
    settings: () =>
      ({
        invalidate: () => {},
        get: () => ({ memories: { autoExtract: true } }),
      }) as unknown as SettingsManager,
    modelPool: () => new ModelPool([]),
    toolRegistry: () => ({}) as ToolRegistry,
    toolContext: () => ({}) as ToolContext,
  });
  await pipeline.runMemoryPipeline(transcript, "background-notice-memory", root, client);
  expect(calls.length).toBeGreaterThan(0);
  const sent = JSON.stringify(calls);
  expect(sent).toContain("summarized");
  expect(sent).not.toContain("BACKGROUND_RESULT");
});
