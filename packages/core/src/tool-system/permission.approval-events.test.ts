import { describe, expect, test } from "bun:test";
import {
  ApprovalRouter,
  HeadlessApprovalBackend,
  InteractiveApprovalBackend,
  PermissionClassifier,
  type ApprovalLifecycleEvent,
  type ApprovalRequestOptions,
} from "./permission.js";

describe("PermissionClassifier approval lifecycle events", () => {
  test("emits requested then resolved(approved) around the backend prompt", async () => {
    const classifier = new PermissionClassifier(
      [],
      "default",
      new HeadlessApprovalBackend("approve-all"),
    );
    const events: ApprovalLifecycleEvent[] = [];
    classifier.setApprovalEventListener((event) => events.push(event));

    const approved = await classifier.handleAsk("Bash", { command: "ls" }, undefined, {
      sessionId: "s-1",
    });

    expect(approved).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(["requested", "resolved"]);
    expect(events[0]).toMatchObject({ toolName: "Bash", sessionId: "s-1" });
    expect(events[1]).toMatchObject({ toolName: "Bash", approved: true, sessionId: "s-1" });
  });

  test("emits resolved(denied) and never throws when the listener throws", async () => {
    const classifier = new PermissionClassifier(
      [],
      "default",
      new HeadlessApprovalBackend("deny-all"),
    );
    const phases: string[] = [];
    classifier.setApprovalEventListener((event) => {
      phases.push(event.phase + (event.approved === undefined ? "" : `:${event.approved}`));
      throw new Error("observer boom");
    });

    const approved = await classifier.handleAsk("Write", { file_path: "/x" });

    expect(approved).toBe(false);
    expect(phases).toEqual(["requested", "resolved:false"]);
  });

  test("does not emit for auto-allow / auto-deny modes (no interactive wait)", async () => {
    const classifier = new PermissionClassifier(
      [],
      "bypassPermissions",
      new HeadlessApprovalBackend("deny-all"),
    );
    const events: ApprovalLifecycleEvent[] = [];
    classifier.setApprovalEventListener((event) => events.push(event));

    expect(await classifier.handleAsk("Bash", {})).toBe(true);
    expect(events).toEqual([]);
  });
});

test("parallel same-tool approval waits retain their identity when resolved out of order", async () => {
  const resolvers: Array<(value: { approved: boolean }) => void> = [];
  const classifier = new PermissionClassifier([], "default", {
    requestApproval: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  const events: ApprovalLifecycleEvent[] = [];
  classifier.setApprovalEventListener((event) => events.push(event));
  const first = classifier.handleAsk("Bash", { command: "first" });
  const second = classifier.handleAsk("Bash", { command: "second" });
  expect(events[0].observationId).not.toBe(events[1].observationId);
  resolvers[1]({ approved: false });
  await second;
  resolvers[0]({ approved: true });
  await first;
  expect(events[2]).toMatchObject({
    observationId: events[1].observationId,
    phase: "resolved",
    approved: false,
  });
  expect(events[3]).toMatchObject({
    observationId: events[0].observationId,
    phase: "resolved",
    approved: true,
  });
});

test("a backend failure closes the exact approval observation", async () => {
  const classifier = new PermissionClassifier([], "default", {
    requestApproval: async () => {
      throw new Error("fixture backend unavailable");
    },
  });
  const events: ApprovalLifecycleEvent[] = [];
  classifier.setApprovalEventListener((event) => events.push(event));
  await expect(classifier.handleAsk("Bash", {})).rejects.toThrow("fixture backend unavailable");
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    observationId: events[0].observationId,
    phase: "resolved",
    error: "fixture backend unavailable",
  });
});

describe("a withdrawn approval request", () => {
  test("the classifier hands the withdraw signal to its backend and never asks once aborted", async () => {
    const seen: Array<ApprovalRequestOptions | undefined> = [];
    const classifier = new PermissionClassifier([], "default", {
      requestApproval: async (_request, options) => {
        seen.push(options);
        return { approved: true };
      },
    });
    const events: ApprovalLifecycleEvent[] = [];
    classifier.setApprovalEventListener((event) => events.push(event));
    const live = new AbortController();
    expect(
      await classifier.handleAskResult("Bash", { command: "ls" }, "why", { signal: live.signal }),
    ).toEqual({ approved: true });
    expect(seen).toEqual([{ signal: live.signal }]);
    // An ordinary ask carries no options at all.
    await classifier.handleAskResult("Bash", { command: "ls" });
    expect(seen[1]).toBeUndefined();

    const gone = new AbortController();
    gone.abort();
    events.length = 0;
    expect(
      await classifier.handleAskResult("Bash", { command: "ls" }, "why", { signal: gone.signal }),
    ).toMatchObject({ approved: false, failure: "cancelled" });
    expect(seen).toHaveLength(2);
    expect(events).toEqual([]);
  });

  test("a withdrawal is not a user denial: it never trips the repeated-denial guard", async () => {
    const classifier = new PermissionClassifier([], "default", {
      requestApproval: (_request, options) =>
        new Promise((resolve) =>
          options!.signal!.addEventListener("abort", () =>
            resolve({ approved: false, failure: "cancelled", reason: "withdrawn" }),
          ),
        ),
    });
    for (let index = 0; index < 6; index += 1) {
      const controller = new AbortController();
      const pending = classifier.handleAskResult("Bash", { command: "ls" }, undefined, {
        signal: controller.signal,
      });
      controller.abort();
      expect(await pending).toMatchObject({ approved: false, failure: "cancelled" });
    }
    expect(classifier.getDenialWarning("Bash")).toBeUndefined();
  });

  test("the interactive backend passes the signal to its prompt and skips a queued withdrawn ask", async () => {
    const backend = new InteractiveApprovalBackend(new ApprovalRouter());
    const prompts: Array<{ tool: string; options?: ApprovalRequestOptions }> = [];
    let answerFirst!: (value: { approved: boolean }) => void;
    backend.setPromptFn((request, options) => {
      prompts.push({ tool: request.toolName, ...(options ? { options } : {}) });
      return new Promise((resolve) => {
        if (prompts.length === 1) answerFirst = resolve;
        else resolve({ approved: true });
      });
    });
    const ask = (toolName: string, options?: ApprovalRequestOptions) =>
      backend.requestApproval(
        { sessionId: "s-1", toolName, args: {}, description: toolName, riskLevel: "high" },
        options,
      );
    const shown = new AbortController();
    const queued = new AbortController();
    const first = ask("First", { signal: shown.signal });
    // Prompts are serialized per session: this one waits behind the first.
    const second = ask("Second", { signal: queued.signal });
    await Promise.resolve();
    expect(prompts).toEqual([{ tool: "First", options: { signal: shown.signal } }]);
    queued.abort();
    answerFirst({ approved: true });
    expect(await first).toMatchObject({ approved: true });
    expect(await second).toMatchObject({ approved: false, failure: "cancelled" });
    // The withdrawn ask never reached the user.
    expect(prompts).toHaveLength(1);
  });
});
