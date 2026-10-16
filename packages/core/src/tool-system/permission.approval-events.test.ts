import { describe, expect, test } from "bun:test";
import {
  HeadlessApprovalBackend,
  PermissionClassifier,
  type ApprovalLifecycleEvent,
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
