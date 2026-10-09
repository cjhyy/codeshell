import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetContextLinkStore, petContextOriginForSource } from "./pet-context-links.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function pathForTest() {
  const root = await mkdtemp(join(tmpdir(), "mimi-context-links-"));
  roots.push(root);
  return join(root, "context-links.json");
}
const task = {
  taskId: "task-1",
  sessionId: "session-1",
  objective: "Verify original invoice checksum",
};

describe("Mimi source/task associations", () => {
  test("source keys bind channel, target and sender without disclosing raw platform IDs", async () => {
    const source = { channel: "wechat", target: "private-target", senderId: "private-owner" };
    const originRef = petContextOriginForSource(source);
    expect(originRef).toEqual(petContextOriginForSource(source));
    expect(originRef.id).not.toBe(petContextOriginForSource({ ...source, senderId: "other" }).id);
    const path = await pathForTest();
    await new PetContextLinkStore(path).record({
      clientMessageId: "input-1",
      originRef,
      eventKind: "chat",
      at: 1,
      tasks: [task],
    });
    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain(source.target);
    expect(disk).not.toContain(source.senderId);
    expect(petContextOriginForSource({ channel: "wechat" }, "a").id).not.toBe(
      petContextOriginForSource({ channel: "wechat" }, "b").id,
    );
    expect(petContextOriginForSource({ channel: "wechat" }, "a").kind).toBe("unknown");
  });

  test("persists source/task lookup, merges accepted task links and preserves the original turn clock", async () => {
    const path = await pathForTest();
    const store = new PetContextLinkStore(path);
    const originRef = petContextOriginForSource();
    await store.record({
      clientMessageId: "input-1",
      originRef,
      eventKind: "chat",
      at: 1,
      tasks: [],
    });
    await store.record({
      clientMessageId: "input-1",
      originRef,
      eventKind: "chat",
      at: 9,
      tasks: [task],
    });
    await store.record({
      clientMessageId: "input-2",
      originRef,
      eventKind: "chat",
      at: 2,
      tasks: [],
    });
    const restarted = new PetContextLinkStore(path);
    expect((await restarted.query({ taskId: "task-1" })).entries).toEqual([
      { clientMessageId: "input-1", originRef, eventKind: "chat", at: 1, tasks: [task] },
    ]);
    expect((await restarted.query({ originId: originRef.id, limit: 1 })).truncated).toBe(true);
    expect((await restarted.query({ query: "INVOICE" })).totalCount).toBe(1);
    const result = await restarted.query();
    result.entries[0]!.originRef.channel = "forged";
    expect((await restarted.query()).entries[0]!.originRef.channel).toBe("mimi");
  });

  test("rejects source reassignment and bad selectors without overwriting corrupt state", async () => {
    const path = await pathForTest();
    const store = new PetContextLinkStore(path);
    const entry = {
      clientMessageId: "input-1",
      originRef: petContextOriginForSource(),
      eventKind: "chat" as const,
      at: 1,
      tasks: [],
    };
    await store.record(entry);
    await expect(
      store.record({ ...entry, originRef: { ...entry.originRef, id: "origin-other" } }),
    ).rejects.toThrow("cannot change");
    await expect(store.query({ taskId: "../private" })).rejects.toThrow("selector");
    await expect(store.query({ limit: 101 })).rejects.toThrow("limit");
    await writeFile(path, "{broken");
    await expect(new PetContextLinkStore(path).record(entry)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});
