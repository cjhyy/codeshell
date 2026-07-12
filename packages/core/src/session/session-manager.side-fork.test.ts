import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { SessionError } from "../exceptions.js";

describe("SessionManager side snapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-side-fork-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not copy the user message already persisted by an in-flight parent run", () => {
    const manager = new SessionManager(dir);
    const source = manager.create("/project", "model", "provider", "parent");
    source.transcript.appendMessage("user", "completed request");
    source.transcript.appendMessage("assistant", "completed response");
    const completedBoundary = source.transcript.appendTurnBoundary();
    Object.assign(source.state, { completedThroughEventId: completedBoundary.id });
    manager.saveState(source.state);

    // Engine.run() persists this before starting the model call. A tail fork
    // copies it and creates the dead user bubble reported in quick chat.
    source.transcript.appendMessage("user", "parent request still running", {
      clientMessageId: "parent-in-flight",
    });

    const forked = manager.fork("parent", {
      targetSessionId: "side-child",
      snapshotMode: "completed",
      ephemeral: true,
    } as never);
    const copiedMessages = forked.bundle.transcript.getEvents("message");

    expect(copiedMessages.map((event) => event.data.content)).toEqual([
      "completed request",
      "completed response",
    ]);
    expect(copiedMessages.some((event) => event.data.clientMessageId === "parent-in-flight")).toBe(
      false,
    );
    expect(forked.lineage.throughEventId).toBe(completedBoundary.id);
    expect(forked.bundle.state.ephemeral).toBe(true);
    const blankQuickChat = manager.create("/project", "model", "provider", "qchat-blank");
    expect(blankQuickChat.state.ephemeral).toBe(true);
    expect(manager.list(10).map((session) => session.sessionId)).toEqual(["parent"]);
  });

  test("cuts all paired assistant and tool tail events after the completed cursor", () => {
    const manager = new SessionManager(dir);
    const source = manager.create("/project", "model", "provider", "parent-tools");
    source.transcript.appendMessage("user", "stable question");
    source.transcript.appendMessage("assistant", "stable answer");
    const completedBoundary = source.transcript.appendTurnBoundary();
    Object.assign(source.state, { completedThroughEventId: completedBoundary.id });
    manager.saveState(source.state);

    source.transcript.appendMessage("user", "live tool request");
    source.transcript.appendMessage("assistant", [
      { type: "tool_use", id: "live-tool", name: "Read", input: { file_path: "live.ts" } },
    ]);
    source.transcript.appendToolUse("Read", "live-tool", { file_path: "live.ts" });
    source.transcript.appendToolResult("live-tool", "Read", "late result");

    const forked = manager.fork("parent-tools", {
      targetSessionId: "side-tools",
      snapshotMode: "completed",
    } as never);
    const copied = forked.bundle.transcript.getEvents();

    expect(
      copied.filter((event) => event.type === "message").map((event) => event.data.content),
    ).toEqual(["stable question", "stable answer"]);
    expect(copied.some((event) => event.type === "tool_use" || event.type === "tool_result")).toBe(
      false,
    );
  });

  test("copies no parent events when no completed conversation turn exists", () => {
    const manager = new SessionManager(dir);
    const source = manager.create("/project", "model", "provider", "parent-empty");
    source.transcript.appendMessage("user", "first request is still running");

    const forked = manager.fork("parent-empty", {
      targetSessionId: "side-empty",
      snapshotMode: "completed",
    } as never);

    expect(forked.copiedEventCount).toBe(0);
    expect(forked.bundle.transcript.getEvents("message")).toEqual([]);
    expect(forked.lineage.throughEventId).toBeUndefined();
  });

  test("uses the stable tail of a legacy session whose persisted status is completed", () => {
    const manager = new SessionManager(dir);
    const source = manager.create("/project", "model", "provider", "parent-legacy");
    source.transcript.appendMessage("user", "legacy completed request");
    source.transcript.appendMessage("assistant", "legacy completed response");
    const legacyTail = source.transcript.appendTurnBoundary();
    source.state.status = "completed";
    manager.saveState(source.state);

    const forked = manager.fork("parent-legacy", {
      targetSessionId: "side-legacy",
      snapshotMode: "completed",
    } as never);

    expect(forked.copiedEventCount).toBe(3);
    expect(forked.lineage.throughEventId).toBe(legacyTail.id);
  });

  test("fails closed when the persisted completed cursor is not in the transcript", () => {
    const manager = new SessionManager(dir);
    const source = manager.create("/project", "model", "provider", "parent-bad-cursor");
    source.transcript.appendMessage("user", "stable request");
    Object.assign(source.state, { completedThroughEventId: "missing-event" });
    manager.saveState(source.state);

    expect(() =>
      manager.fork("parent-bad-cursor", {
        targetSessionId: "side-bad-cursor",
        snapshotMode: "completed",
      } as never),
    ).toThrow(SessionError);
  });

  test("does not inherit the parent's active goal or control state", () => {
    const manager = new SessionManager(dir);
    const source = manager.create("/project", "model", "provider", "parent-goal");
    source.transcript.appendMessage("user", "stable request");
    source.transcript.appendMessage("assistant", "stable answer");
    const completedBoundary = source.transcript.appendTurnBoundary();
    Object.assign(source.state, {
      completedThroughEventId: completedBoundary.id,
      activeGoal: { objective: "parent-only goal", setAtMs: 1 },
    });
    manager.saveState(source.state);

    const forked = manager.fork("parent-goal", {
      targetSessionId: "side-goal",
      snapshotMode: "completed",
    } as never);

    expect(forked.bundle.state.activeGoal).toBeUndefined();
    expect(forked.bundle.state.parentSessionId).toBeNull();
  });
});
