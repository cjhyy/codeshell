import { describe, expect, test } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import type { ChatSession } from "./chat-session.js";
import { DecisionNotificationHooks, decisionOutcome } from "./decision-notification-hooks.js";
import type { PendingApprovalMetadata } from "./types.js";

function setup() {
  const registry = new HookRegistry();
  const seen: Array<Record<string, unknown>> = [];
  registry.register("notification", (ctx) => {
    seen.push(ctx.data);
    return {};
  });
  const session = { engine: { getHookRegistry: () => registry } } as unknown as ChatSession;
  return { hooks: new DecisionNotificationHooks(), seen, session };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function metadata(overrides: Partial<PendingApprovalMetadata> = {}): PendingApprovalMetadata {
  return {
    sessionId: "s1",
    requestId: "r1",
    workerGeneration: 1,
    kind: "ask_user",
    title: "可稍后回答的问题",
    createdAt: 1,
    surfaceable: false,
    asynchronous: true,
    ...overrides,
  };
}

describe("DecisionNotificationHooks", () => {
  test("an asynchronous question is announced resolved when it retires, with its last answer", async () => {
    const { hooks, seen, session } = setup();
    const question = metadata();
    hooks.describe("r1", { question: "Deploy now?" });
    hooks.requested(session, question);
    // A failed admission, then the accepted retry.
    hooks.decided("r1", { approved: true, answer: "first" });
    hooks.decided("r1", { approved: true, answer: "yes" });
    await flush();
    expect(seen.map((data) => data.kind)).toEqual(["ask_user_requested"]);
    hooks.retired(question, "resolved");
    await flush();
    expect(seen[1]).toEqual({
      kind: "ask_user_resolved",
      sessionId: "s1",
      requestId: "r1",
      title: "Deploy now?",
      question: "Deploy now?",
      asynchronous: true,
      message: "Deploy now?",
      decision: "answered",
      approved: true,
      status: "resolved",
    });
  });

  test("an asynchronous question closed without an answer is cancelled", async () => {
    const { hooks, seen, session } = setup();
    const question = metadata();
    hooks.requested(session, question);
    hooks.retired(question, "cancelled");
    await flush();
    expect(seen[1]).toMatchObject({ kind: "ask_user_resolved", decision: "cancelled" });
  });

  test("a blocking decision retired without a resolve still gets one resolved event", async () => {
    const { hooks, seen, session } = setup();
    const approval = metadata({ kind: "tool_approval", toolName: "Bash", asynchronous: false });
    hooks.requested(session, approval);
    hooks.retired(approval, "expired");
    await flush();
    hooks.decided("r1", { approved: false, failure: "timed_out" });
    await flush();
    expect(seen.map((data) => [data.kind, data.decision, data.status])).toEqual([
      ["approval_requested", undefined, undefined],
      ["approval_resolved", "expired", "expired"],
    ]);
  });

  test("a blocking decision retired then resolved is announced once, with its decision", async () => {
    const { hooks, seen, session } = setup();
    const approval = metadata({ kind: "tool_approval", toolName: "Bash", asynchronous: false });
    hooks.requested(session, approval);
    hooks.retired(approval, "resolved");
    hooks.decided("r1", { approved: true });
    await flush();
    expect(seen.map((data) => [data.kind, data.decision])).toEqual([
      ["approval_requested", undefined],
      ["approval_resolved", "approved"],
    ]);
  });

  test("internal loopbacks and engines without hooks are silent", async () => {
    const { hooks, seen, session } = setup();
    hooks.requested(session, metadata({ kind: "internal", toolName: "__host_action__" }));
    hooks.decided("r1", { approved: true, answer: "{}" });
    const bare = { engine: {} } as unknown as ChatSession;
    const other = metadata({ requestId: "r2" });
    hooks.requested(bare, other);
    hooks.retired(other, "resolved");
    await flush();
    expect(seen).toEqual([]);
  });

  test("outcomes", () => {
    expect(decisionOutcome(false, { approved: true })).toEqual({
      outcome: "approved",
      approved: true,
    });
    expect(decisionOutcome(false, { approved: false })).toMatchObject({ outcome: "denied" });
    expect(decisionOutcome(true, { approved: false })).toMatchObject({ outcome: "skipped" });
    expect(decisionOutcome(true, "blue")).toMatchObject({ outcome: "answered" });
    expect(decisionOutcome(true, { approved: false, failure: "timed_out" })).toMatchObject({
      outcome: "expired",
    });
    expect(decisionOutcome(false, { approved: false, failure: "owner_lost" })).toMatchObject({
      outcome: "cancelled",
    });
    expect(decisionOutcome(false, undefined, "expired")).toMatchObject({ outcome: "expired" });
  });
});
