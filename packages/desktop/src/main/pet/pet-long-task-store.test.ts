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
});
