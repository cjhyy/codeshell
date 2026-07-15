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

    const approved = await classifier.handleAsk(
      "Bash",
      { command: "ls" },
      undefined,
      { sessionId: "s-1" },
    );

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
