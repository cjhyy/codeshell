import { describe, expect, it } from "bun:test";
import { resolveStablePrefixMessageCount } from "./stable-prefix.js";
import { assembleRunMessages, NO_HOOK_MESSAGES } from "./run-context-ledger.js";
import { Transcript } from "../session/transcript.js";
import type { Message } from "../types.js";

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

describe("resolveStablePrefixMessageCount", () => {
  const head = user("instructions");
  const old1 = user("earlier task");
  const old2 = assistant("earlier answer");
  const task = user("this run's task");
  const ledger = user("context update");
  const step = assistant("working");
  const volatile = user("runtime status");
  const isVolatile = (message: Message) => message === volatile;
  const never = () => false;

  it("ends where the run started when nothing is pending", () => {
    const messages = [head, old1, old2, task, ledger, step];
    expect(
      resolveStablePrefixMessageCount({ messages, isVolatile: never, runStartMessage: task }),
    ).toBe(3);
  });

  it("ends just before the earliest message a pending rewrite batch would touch", () => {
    const messages = [head, old1, old2, task, ledger, step];
    expect(
      resolveStablePrefixMessageCount({
        messages,
        isVolatile: never,
        pendingRewriteMessage: old2,
        runStartMessage: task,
      }),
    ).toBe(2);
    // A rewrite inside this run keeps everything before it, not just the old runs.
    expect(
      resolveStablePrefixMessageCount({
        messages,
        isVolatile: never,
        pendingRewriteMessage: step,
        runStartMessage: task,
      }),
    ).toBe(5);
  });

  it("finds the pending message by identity in the list being sent", () => {
    // The manager saw [head, old1, old2, task] (volatile stripped), where the
    // pending message sits at index 2; here it is at 3, behind a volatile one.
    const messages = [head, volatile, old1, old2, task];
    expect(
      resolveStablePrefixMessageCount({
        messages: [head, old1, volatile, old2, task],
        isVolatile,
        pendingRewriteMessage: old2,
        runStartMessage: task,
      }),
    ).toBe(2);
    expect(
      resolveStablePrefixMessageCount({
        messages,
        isVolatile,
        pendingRewriteMessage: old2,
        runStartMessage: task,
      }),
    ).toBe(1);
  });

  it("uses the smaller of the volatile index and the settled line", () => {
    expect(
      resolveStablePrefixMessageCount({
        messages: [head, old1, old2, task, ledger, volatile, step],
        isVolatile,
        runStartMessage: task,
      }),
    ).toBe(3);
    expect(
      resolveStablePrefixMessageCount({
        messages: [head, volatile, old1, old2, task],
        isVolatile,
        runStartMessage: task,
      }),
    ).toBe(1);
  });

  it("keeps tail runtime context behind the pending rewrite boundary", () => {
    const messages = [head, old1, old2, task, step, volatile];
    expect(
      resolveStablePrefixMessageCount({
        messages,
        isVolatile,
        volatileAtTail: true,
        pendingRewriteMessage: old2,
        runStartMessage: task,
      }),
    ).toBe(2);
    expect(
      resolveStablePrefixMessageCount({
        messages,
        isVolatile,
        volatileAtTail: true,
        runStartMessage: task,
      }),
    ).toBe(5);
    expect(
      resolveStablePrefixMessageCount({
        messages,
        isVolatile,
        volatileAtTail: true,
        pendingRewriteMessage: user("compacted away"),
        runStartMessage: task,
      }),
    ).toBe(5);
  });

  it("falls back to the run start when the pending message is gone", () => {
    expect(
      resolveStablePrefixMessageCount({
        messages: [head, old1, task, step],
        isVolatile: never,
        pendingRewriteMessage: old2,
        runStartMessage: task,
      }),
    ).toBe(2);
  });

  it("falls back to the whole list when the run start was compacted away", () => {
    const messages = [head, user("summary"), step];
    expect(
      resolveStablePrefixMessageCount({ messages, isVolatile: never, runStartMessage: task }),
    ).toBe(3);
    expect(resolveStablePrefixMessageCount({ messages, isVolatile: never })).toBe(3);
    expect(
      resolveStablePrefixMessageCount({
        messages: [...messages, volatile],
        isVolatile,
        runStartMessage: task,
      }),
    ).toBe(3);
  });
});

describe("assembleRunMessages run start", () => {
  const ledger = {
    sync(messages: Message[]): Message {
      const message = user("ledger");
      messages.push(message);
      return message;
    },
  };

  it("is the user task when the run appends nothing before it", () => {
    const task = user("task");
    const messages = [user("old"), assistant("old answer"), task];
    const { runStartMessage } = assembleRunMessages({
      messages,
      transcript: Transcript.inMemory("run-start-task"),
      userMessageEventId: "event-1",
      userContextMsg: user("instructions"),
      hooks: NO_HOOK_MESSAGES,
      ledger,
      volatileContextMsg: user("volatile"),
    });
    expect(runStartMessage).toBe(task);
    expect(messages.indexOf(task)).toBe(3);
  });

  it("is the hook reminder this run put before the user task", () => {
    const task = user("task");
    const messages = [user("old"), assistant("old answer"), task];
    const { runStartMessage, retained } = assembleRunMessages({
      messages,
      transcript: Transcript.inMemory("run-start-reminder"),
      userMessageEventId: "event-1",
      userContextMsg: null,
      hooks: { sessionStart: ["remember this"], promptSubmit: [] },
      ledger,
      volatileContextMsg: null,
    });
    expect(runStartMessage).toBe(messages[2]);
    expect(runStartMessage).not.toBe(task);
    expect(retained).toContain(runStartMessage!);
    expect(messages[3]).toBe(task);
  });
});
