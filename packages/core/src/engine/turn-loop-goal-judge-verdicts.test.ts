import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { GoalJudgeRuntimeContext } from "../hooks/goal-stop-hook.js";
import type { HookResult } from "../hooks/events.js";
import {
  contextMessageMark,
  goalJudgeConversation,
  markContextMessage,
  readHookReminderData,
} from "../session/context-messages.js";
import { Transcript } from "../session/transcript.js";
import type { LLMResponse, Message } from "../types.js";
import { buildGoalJudgeRuntimeContext } from "./goal-judge-context.js";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";
import { installPromptPrefixGuard } from "../testing/prompt-prefix-guard.js";

installPromptPrefixGuard({ beforeEach, afterEach });

const VERDICT = "GOAL_NOT_MET: the integration test still fails";
const TURN_START_REMINDER = "TURN_START_HOOK_REMINDER";

function finalAnswer(text: string): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function makeDeps(
  transcript: Transcript,
  responses: LLMResponse[],
  onStop: (call: number) => HookResult,
  snapshots: GoalJudgeRuntimeContext[],
): TurnLoopDeps {
  let responseIndex = 0;
  let stopCalls = 0;
  const call = async (): Promise<LLMResponse> =>
    responses[Math.min(responseIndex++, responses.length - 1)]!;
  return {
    model: {
      call,
      callWithoutStreaming: call,
      getOutputTokens: () => 0,
    } as unknown as TurnLoopDeps["model"],
    toolExecutor: {
      setLogger() {},
      isConcurrencySafe: () => false,
    } as unknown as TurnLoopDeps["toolExecutor"],
    contextManager: {
      manageAsync: async (messages: Message[]) => messages,
      manage: (messages: Message[]) => messages,
      recordActualUsage: () => undefined,
      shouldReactiveCompact: () => false,
    } as unknown as TurnLoopDeps["contextManager"],
    hooks: {
      async emit(event: string): Promise<HookResult> {
        if (event === "on_turn_start") return { messages: [TURN_START_REMINDER] };
        if (event === "on_stop") return onStop(++stopCalls);
        return {};
      },
    } as unknown as TurnLoopDeps["hooks"],
    transcript,
    systemPrompt: "system",
    tools: [],
    sessionId: "goal-judge-verdicts",
    publishGoalJudgeContext: (context) => snapshots.push(context),
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };
}

describe("goal judge sees its own earlier verdicts", () => {
  it("keeps a stop-block verdict in the judge's view while other engine context stays out", async () => {
    const transcript = Transcript.inMemory("goal-judge-verdicts");
    const snapshots: GoalJudgeRuntimeContext[] = [];
    const ledger: Message = { role: "user", content: "LEDGER_CONTEXT_SNAPSHOT" };
    markContextMessage(ledger, { kind: "ledger", eventId: "ledger-event" });

    const result = await new TurnLoop(
      makeDeps(
        transcript,
        [finalAnswer("first attempt"), finalAnswer("second attempt")],
        (call) =>
          call === 1
            ? { continueSession: true, messages: [VERDICT] }
            : { data: { goalVerdict: { met: true, gaps: "" } } },
        snapshots,
      ),
      {
        maxTurns: 4,
        maxToolCallsPerTurn: 10,
        goal: { objective: "make the integration test pass" },
      },
    ).run([{ role: "user", content: "go" }, ledger]);

    expect(result.reason).toBe("completed");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.renderedConversation).not.toContain(VERDICT);
    const second = snapshots[1]!.renderedConversation;
    // Rendered exactly as before the reminder was persisted as engine context:
    // a USER turn carrying the wrapped hook message.
    expect(second).toContain(`USER:\n<system-reminder>\n${VERDICT}\n</system-reminder>`);
    expect(second.indexOf("first attempt")).toBeLessThan(second.indexOf(VERDICT));
    expect(second.indexOf(VERDICT)).toBeLessThan(second.indexOf("second attempt"));
    expect(second).not.toContain("LEDGER_CONTEXT_SNAPSHOT");
    expect(second).not.toContain(TURN_START_REMINDER);

    // The verdict is still engine context everywhere else, marked structurally.
    const verdictMessage = result.messages.find(
      (message) => typeof message.content === "string" && message.content.includes(VERDICT),
    )!;
    const mark = contextMessageMark(verdictMessage);
    expect(mark?.kind).toBe("hook-reminder");
    expect(mark?.kind === "hook-reminder" && mark.reminder.goalStopBlock).toBe(true);
  });

  it("keeps the verdict marked for the judge after a replay of the transcript", async () => {
    const transcript = Transcript.inMemory("goal-judge-verdicts-replay");
    transcript.appendMessage("user", "go");
    await new TurnLoop(
      makeDeps(
        transcript,
        [finalAnswer("first attempt"), finalAnswer("second attempt")],
        (call) =>
          call === 1
            ? { continueSession: true, messages: [VERDICT] }
            : { data: { goalVerdict: { met: true, gaps: "" } } },
        [],
      ),
      {
        maxTurns: 4,
        maxToolCallsPerTurn: 10,
        goal: { objective: "make the integration test pass" },
      },
    ).run([{ role: "user", content: "go" }]);

    const verdictEvent = transcript
      .getEvents("message")
      .find((event) => readHookReminderData(event)?.goalStopBlock === true);
    expect(verdictEvent).toBeDefined();

    const replayed = transcript.toMessages();
    const rendered = buildGoalJudgeRuntimeContext(
      goalJudgeConversation(replayed),
    ).renderedConversation;
    expect(rendered).toContain(`USER:\n<system-reminder>\n${VERDICT}\n</system-reminder>`);
    expect(rendered).not.toContain(TURN_START_REMINDER);
    // Other readers still treat it as engine context.
    expect(replayed.some((message) => contextMessageMark(message) === undefined)).toBe(true);
    const verdictMessage = replayed.find(
      (message) => typeof message.content === "string" && message.content.includes(VERDICT),
    )!;
    expect(contextMessageMark(verdictMessage)?.kind).toBe("hook-reminder");
  });

  it("ignores a non-boolean goalStopBlock in stored reminder data", () => {
    const transcript = Transcript.inMemory("goal-judge-verdicts-legacy");
    const event = transcript.appendMessage("user", "<system-reminder>\nx\n</system-reminder>", {
      hookReminder: { goalStopBlock: "yes" } as never,
    });
    expect(readHookReminderData(event)).toEqual({});
  });
});
