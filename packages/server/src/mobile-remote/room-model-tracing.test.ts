import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import { RoomManager, type RoomAgent } from "./room-manager.js";
import type { ResidentAgentEvent } from "./resident-agent.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(captureContent = true) {
  const root = mkdtempSync(join(tmpdir(), "room-model-trace-"));
  roots.push(root);
  const storageDir = join(root, ".model-traces");
  const store = new ModelTraceStore({ storageDir });
  store.setConfig({ captureContent });
  let emit!: (event: ResidentAgentEvent) => void;
  let accept = true;
  let running = false;
  const agent: RoomAgent = {
    start() {
      running = true;
    },
    send(text) {
      if (!accept) return false;
      emit({ type: "text", text: `visible: ${text}\n` });
      return true;
    },
    stop() {
      running = false;
    },
    isRunning: () => running,
  };
  const manager = new RoomManager({
    rootDir: join(root, "rooms"),
    modelTracing: {
      storageDir,
      parameters: () => ({ appendSystemPrompt: "known Host CLI instructions" }),
    },
    createAgent: (_room, onEvent) => {
      emit = onEvent;
      return agent;
    },
    onMessage: () => {},
  });
  const room = manager.createRoom({ cwd: root });
  return {
    root,
    store,
    manager,
    room,
    emit: (event: ResidentAgentEvent) => emit(event),
    setAccept: (value: boolean) => {
      accept = value;
    },
  };
}

test("accepted overlapping room inputs share a finite CLI batch with ordered visible output and explicit attribution limits", () => {
  const { root, store, manager, room, emit, setAccept } = fixture();
  expect(manager.send(room.id, "first input")).toBe(true);
  expect(manager.send(room.id, "second input")).toBe(true);
  setAccept(false);
  expect(manager.send(room.id, "rejected input")).toBe(false);
  emit({ type: "turn_end", reason: "completed" });
  expect(store.list().items[0]!.status).toBe("running");
  emit({ type: "tool", id: "read-1", tool: "Read", summary: "file", input: { path: "file" } });
  emit({ type: "tool_result", id: "read-1", summary: "visible tool result", isError: false });
  emit({ type: "turn_end", reason: "completed" });
  expect(store.list().total).toBe(1);
  const record = store.get(store.list().items[0]!.id)!;
  expect(record).toMatchObject({
    workspacePath: root,
    purpose: "external_room_batch",
    status: "completed",
    input: {
      messages: [
        { role: "user", content: "first input" },
        { role: "user", content: "second input" },
      ],
      parameters: { submissionCount: 2, outputAttribution: "accepted-room-batch-visible-output" },
    },
    output: { text: "visible: first input\nvisible: second input\n" },
  });
  expect(record.sessionId).toBeUndefined();
  expect(record.runId).toBeUndefined();
  expect(record.attempts[0]!.coverage).toBe("external-cli-input");
  expect(store.events(record.traceId).find((event) => event.kind === "tool")).toMatchObject({
    status: "completed",
    output: "visible tool result",
  });
  expect(JSON.stringify(record)).not.toContain("rejected input");
  manager.closeAll();
});

test("metadata-only room capture persists no body, and closing a live room closes its trace as cancelled", () => {
  const { store, manager, room } = fixture(false);
  expect(manager.send(room.id, "PRIVATE_ROOM_INPUT")).toBe(true);
  manager.close(room.id);
  const record = store.get(store.list().items[0]!.id)!;
  expect(record.status).toBe("cancelled");
  expect(record.inputState).toBe("not-recorded");
  expect(record.outputState).toBe("not-recorded");
  expect(JSON.stringify(record)).not.toContain("PRIVATE_ROOM_INPUT");
});

test("room input and output received while capture is paused cannot leak into a later enabled batch update", () => {
  const { store, manager, room, emit } = fixture();
  manager.send(room.id, "first captured input");
  store.setConfig({ captureContent: false });
  manager.send(room.id, "NEVER_CAPTURE_PAUSED_ROOM_INPUT");
  store.setConfig({ captureContent: true });
  manager.send(room.id, "last captured input");
  emit({
    type: "tool",
    id: "late",
    tool: "Read",
    summary: "Read",
    input: "NEVER_CAPTURE_LATE_TOOL",
  });
  emit({ type: "tool_result", id: "late", summary: "NEVER_CAPTURE_LATE_RESULT", isError: false });
  for (let index = 0; index < 3; index++) emit({ type: "turn_end", reason: "completed" });
  const record = store.get(store.list().items[0]!.id)!;
  expect(record.inputState).toBe("truncated");
  expect(record.input!.parameters.submissionCount).toBe(1);
  expect(JSON.stringify(record)).not.toContain("NEVER_CAPTURE_PAUSED_ROOM_INPUT");
  expect(record.outputState).toBe("not-recorded");
  expect(JSON.stringify(record)).not.toContain("last captured input");
  const events = store.events(record.traceId);
  expect(events.find((event) => event.kind === "tool")).toMatchObject({
    inputState: "not-recorded",
    outputState: "not-recorded",
  });
  expect(JSON.stringify(events)).not.toContain("NEVER_CAPTURE_LATE_");
  manager.closeAll();
});

test("observe-only rooms never fabricate a submitted prompt trace", () => {
  const { manager, root, store } = fixture();
  const room = manager.createRoom({
    cwd: root,
    claudeSessionId: "external-session",
    linkedSessionMode: "observe-only",
  });
  expect(manager.send(room.id, "must not reach a CLI")).toBe(false);
  expect(store.list().total).toBe(0);
  manager.closeAll();
});

test.each(["model_error", "aborted_streaming"])(
  "a later successful room boundary cannot erase earlier %s in the batch",
  (reason) => {
    const { store, manager, room, emit } = fixture();
    manager.send(room.id, "first");
    manager.send(room.id, "second");
    emit({ type: "turn_end", reason });
    emit({ type: "turn_end", reason: "completed" });
    expect(store.list().items[0].status).toBe(reason === "model_error" ? "failed" : "cancelled");
    manager.closeAll();
  },
);
