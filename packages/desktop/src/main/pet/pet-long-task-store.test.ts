import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PetLongTaskStore } from "./pet-long-task-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store() {
  const root = await mkdtemp(join(tmpdir(), "pet-long-task-"));
  roots.push(root);
  return { root, value: new PetLongTaskStore(join(root, "tasks.json"), () => 1_000) };
}

describe("PetLongTaskStore", () => {
  test("persists before publishing and reloads the event journal", async () => {
    const { root, value } = await store();
    const snapshots: number[] = [];
    value.subscribe((snapshot) => snapshots.push(snapshot.revision));
    const task = await value.create({
      id: "task-1",
      originClientMessageId: "message-1",
      objective: "Finish the durable task",
      workspacePath: "/work/app",
      sessionId: "session-1",
      at: 100,
    });
    await value.transition(task.id, { kind: "started", at: 200 });
    await value.transition(task.id, {
      kind: "completed",
      at: 300,
      summary: "Verified complete",
    });

    expect(snapshots).toEqual([1, 2, 3]);
    expect(JSON.parse(await readFile(join(root, "tasks.json"), "utf8"))).toMatchObject({
      version: 1,
      revision: 3,
    });

    const reloaded = new PetLongTaskStore(join(root, "tasks.json"));
    await reloaded.load();
    expect(reloaded.get("task-1")).toMatchObject({
      status: "completed",
      summary: "Verified complete",
    });
    expect(reloaded.get("task-1")?.events.map((event) => event.kind)).toEqual([
      "created",
      "started",
      "completed",
    ]);
  });

  test("deduplicates launch intents by the originating message", async () => {
    const { value } = await store();
    const input = {
      id: "task-1",
      originClientMessageId: "message-1",
      objective: "Do work",
      workspacePath: null,
      sessionId: "session-1",
      at: 100,
    } as const;
    const first = await value.create(input);
    const second = await value.create({ ...input, id: "task-2", sessionId: "session-2" });
    expect(second.id).toBe(first.id);
    expect(value.getSnapshot().tasks).toHaveLength(1);
  });

  test("ignores corrupt rows while preserving valid tasks", async () => {
    const { root, value } = await store();
    const task = await value.create({
      id: "task-1",
      originClientMessageId: "message-1",
      objective: "Do work",
      workspacePath: null,
      sessionId: "session-1",
      at: 100,
    });
    const raw = JSON.parse(await readFile(join(root, "tasks.json"), "utf8"));
    raw.tasks.push({ invalid: true });
    await writeFile(join(root, "tasks.json"), JSON.stringify(raw), "utf8");
    const reloaded = new PetLongTaskStore(join(root, "tasks.json"));
    await reloaded.load();
    expect(reloaded.getSnapshot().tasks.map((entry) => entry.id)).toEqual([task.id]);
  });

  test("atomically clears all ended tasks after their closure is recorded", async () => {
    const { root, value } = await store();
    const completed = await value.create({
      id: "task-completed",
      originClientMessageId: "message-completed",
      objective: "Complete this",
      workspacePath: "/work/app",
      sessionId: "session-completed",
      at: 100,
    });
    const finalizing = await value.create({
      id: "task-finalizing",
      originClientMessageId: "message-finalizing",
      objective: "Still finalizing",
      workspacePath: "/work/app",
      sessionId: "session-finalizing",
      at: 110,
    });
    const failed = await value.create({
      id: "task-failed",
      originClientMessageId: "message-failed",
      objective: "Keep failed task",
      workspacePath: "/work/app",
      sessionId: "session-failed",
      at: 120,
    });
    await value.transition(completed.id, { kind: "completed", at: 200, summary: "Done" });
    await value.transition(completed.id, { kind: "closure-recorded", at: 210 });
    await value.transition(finalizing.id, { kind: "completed", at: 220, summary: "Closing" });
    await value.transition(failed.id, { kind: "failed", at: 230, error: "Keep me" });
    await value.transition(failed.id, { kind: "closure-recorded", at: 240 });

    const snapshot = await value.clearTerminal();

    expect(snapshot.tasks.map((task) => task.id)).toEqual(["task-finalizing"]);
    const persisted = JSON.parse(await readFile(join(root, "tasks.json"), "utf8"));
    expect(persisted.tasks.map((task: { id: string }) => task.id)).toEqual(["task-finalizing"]);
  });

  test("removes one ended task without touching another", async () => {
    const { value } = await store();
    const first = await value.create({
      id: "task-first",
      originClientMessageId: "message-first",
      objective: "First task",
      workspacePath: null,
      sessionId: "session-first",
      at: 100,
    });
    const second = await value.create({
      id: "task-second",
      originClientMessageId: "message-second",
      objective: "Second task",
      workspacePath: null,
      sessionId: "session-second",
      at: 110,
    });
    await value.transition(first.id, { kind: "cancelled", at: 200 });
    await value.transition(first.id, { kind: "closure-recorded", at: 210 });
    await value.transition(second.id, { kind: "completed", at: 220 });
    await value.transition(second.id, { kind: "closure-recorded", at: 230 });

    const snapshot = await value.removeTerminal(first.id);

    expect(snapshot.tasks.map((task) => task.id)).toEqual([second.id]);
  });
});
