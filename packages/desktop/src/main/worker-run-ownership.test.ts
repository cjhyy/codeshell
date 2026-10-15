import { expect, test } from "bun:test";
import { WorkerRunOwnership } from "./worker-run-ownership";
import { SessionSnapshotStore } from "./SessionSnapshotStore";

test("worker exit owns admitted runs even before their first stream event", () => {
  const ownership = new WorkerRunOwnership();
  ownership.beginWorker();
  ownership.beginRun("setup", "message-setup");
  ownership.beginRun("running", "message-running");
  ownership.observeWorker("running", {
    type: "session_started",
    runId: "run",
    clientMessageId: "message-running",
  });
  ownership.observeExternal("separate-external", { type: "session_started" });
  expect(ownership.sessionIds()).toEqual(["setup", "running"]);
  expect(ownership.endWorker()).toEqual(["setup", "running"]);
  expect(ownership.endWorker()).toEqual([]);
});

test("completed native Sessions and a Session transferred to another producer survive worker exit", () => {
  const ownership = new WorkerRunOwnership();
  ownership.beginRun("completed");
  ownership.observeWorker("completed", { type: "session_started", runId: "completed-run" });
  ownership.observeWorker("completed", { type: "turn_complete", runId: "completed-run" });
  ownership.beginRun("switched");
  ownership.observeWorker("switched", { type: "session_started", runId: "native-run" });
  ownership.observeExternal("switched", { type: "session_started", runId: "external-run" });
  ownership.observeWorker("switched", { type: "text_delta", text: "late native text" });
  ownership.observeWorker("switched", { type: "turn_complete", runId: "native-run" });
  expect(ownership.sessionIds()).toEqual([]);
});

test("an old relay run cannot retire its admitted or running successor", () => {
  const ownership = new WorkerRunOwnership();
  ownership.beginRun("relay", "old-message");
  ownership.observeWorker("relay", {
    type: "session_started",
    runId: "old-run",
    clientMessageId: "old-message",
  });
  ownership.beginRun("relay", "new-message");
  ownership.observeWorker("relay", {
    type: "turn_complete",
    runId: "old-run",
    clientMessageId: "old-message",
  });
  ownership.observeWorker("relay", { type: "turn_complete", runId: "old-run" });
  expect(ownership.sessionIds()).toEqual(["relay"]);
  ownership.observeWorker("relay", {
    type: "session_started",
    runId: "new-run",
    clientMessageId: "new-message",
  });
  ownership.observeWorker("relay", { type: "error", runId: "old-run" });
  expect(ownership.sessionIds()).toEqual(["relay"]);
  ownership.observeWorker("relay", {
    type: "turn_complete",
    runId: "new-run",
    clientMessageId: "new-message",
  });
  expect(ownership.sessionIds()).toEqual([]);
});

test("child terminal events do not retire the parent and a respawn drops old ownership", () => {
  const ownership = new WorkerRunOwnership();
  ownership.beginRun("parent");
  ownership.observeWorker("parent", { type: "session_started", runId: "parent-run" });
  ownership.observeWorker("parent", { type: "error", agentId: "child" });
  ownership.observeExternal("parent", { type: "session_started", agentId: "child" });
  expect(ownership.sessionIds()).toEqual(["parent"]);
  ownership.beginWorker();
  expect(ownership.sessionIds()).toEqual([]);
  ownership.observeWorker("wakeup", { type: "session_started" });
  expect(ownership.sessionIds()).toEqual(["wakeup"]);
  ownership.observeWorker("wakeup", { type: "turn_complete" });
  expect(ownership.sessionIds()).toEqual([]);
});

test("a worker-driven continuation establishes its own identity without renderer admission", () => {
  const ownership = new WorkerRunOwnership();
  ownership.beginRun("goal", "initial-message");
  ownership.observeWorker("goal", {
    type: "session_started",
    runId: "initial-run",
    clientMessageId: "initial-message",
  });
  ownership.observeWorker("goal", {
    type: "session_started",
    runId: "continuation-run",
    clientMessageId: "continuation-message",
  });
  ownership.observeWorker("goal", {
    type: "turn_complete",
    runId: "initial-run",
    clientMessageId: "initial-message",
  });
  expect(ownership.sessionIds()).toEqual(["goal"]);
  ownership.observeWorker("goal", {
    type: "turn_complete",
    runId: "continuation-run",
    clientMessageId: "continuation-message",
  });
  expect(ownership.sessionIds()).toEqual([]);
});

test("worker exit leaves transferred external and independent Main snapshot liveness intact", () => {
  const ownership = new WorkerRunOwnership();
  const snapshots = new SessionSnapshotStore();
  for (const sessionId of ["native", "transferred"]) {
    const event = { type: "session_started", runId: `worker-${sessionId}` };
    ownership.observeWorker(sessionId, event);
    snapshots.append(sessionId, event);
  }
  for (const sessionId of ["main", "external", "transferred"]) {
    const event = { type: "session_started", runId: `external-${sessionId}` };
    ownership.observeExternal(sessionId, event);
    snapshots.append(sessionId, event);
  }
  snapshots.onWorkerExit(ownership.sessionIds());
  expect(snapshots.get("native").topLevelRunning).toBe(false);
  for (const sessionId of ["main", "external", "transferred"])
    expect(snapshots.get(sessionId).topLevelRunning).toBe(true);
});
