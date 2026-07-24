import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPetSummaryStore, type PetSummaryStore } from "./pet-summary-store.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pet-summary-store-"));
  filePath = join(dir, "summaries.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function loaded(path: string): Promise<PetSummaryStore> {
  const store = createPetSummaryStore(path);
  await store.load();
  return store;
}

describe("createPetSummaryStore", () => {
  test("set/get roundtrip returns the stored terminalAt + text", async () => {
    const store = await loaded(filePath);
    store.set("session-a", 1_000, "did the thing; want me to also do X?");
    expect(store.get("session-a")).toEqual({
      terminalAt: 1_000,
      text: "did the thing; want me to also do X?",
    });
    expect(store.get("missing")).toBeUndefined();
  });

  test("stores an empty-marker text and returns it", async () => {
    const store = await loaded(filePath);
    store.set("session-a", 1_000, "");
    expect(store.get("session-a")).toEqual({ terminalAt: 1_000, text: "" });
  });

  test("a newer terminalAt overwrites the entry", async () => {
    const store = await loaded(filePath);
    store.set("session-a", 1_000, "first");
    store.set("session-a", 2_000, "second");
    expect(store.get("session-a")).toEqual({ terminalAt: 2_000, text: "second" });
  });

  test("evicts oldest-written entries beyond the bound", async () => {
    const store = createPetSummaryStore(filePath, { maxEntries: 3 });
    await store.load();
    store.set("a", 1, "a");
    store.set("b", 2, "b");
    store.set("c", 3, "c");
    store.set("d", 4, "d");
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toEqual({ terminalAt: 2, text: "b" });
    expect(store.get("c")).toEqual({ terminalAt: 3, text: "c" });
    expect(store.get("d")).toEqual({ terminalAt: 4, text: "d" });
  });

  test("re-setting an existing key refreshes its eviction position", async () => {
    const store = createPetSummaryStore(filePath, { maxEntries: 3 });
    await store.load();
    store.set("a", 1, "a");
    store.set("b", 2, "b");
    store.set("c", 3, "c");
    // Touch "a" so it is no longer the oldest, then push a fourth key.
    store.set("a", 10, "a2");
    store.set("d", 4, "d");
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toEqual({ terminalAt: 10, text: "a2" });
    expect(store.get("d")).toEqual({ terminalAt: 4, text: "d" });
  });

  test("reloads persisted entries from disk", async () => {
    const store = await loaded(filePath);
    store.set("session-a", 1_000, "persisted");
    store.set("session-b", 2_000, "");
    await store.flush();

    const reloaded = await loaded(filePath);
    expect(reloaded.get("session-a")).toEqual({ terminalAt: 1_000, text: "persisted" });
    expect(reloaded.get("session-b")).toEqual({ terminalAt: 2_000, text: "" });
  });

  test("persists as valid JSON on disk", async () => {
    const store = await loaded(filePath);
    store.set("session-a", 1_000, "persisted");
    await store.flush();
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed.version).toBe(1);
  });

  test("missing file loads as an empty store", async () => {
    const store = await loaded(join(dir, "does-not-exist.json"));
    expect(store.get("anything")).toBeUndefined();
  });

  test("corrupt file loads as an empty store without throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "{not json", "utf8");
    const store = await loaded(filePath);
    expect(store.get("anything")).toBeUndefined();
  });
});
