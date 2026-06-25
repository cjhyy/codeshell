import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FileRunStore } from "./FileRunStore.js";
import type { RunSnapshot } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frs-page-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function snap(runId: string, createdAt: number): RunSnapshot {
  return {
    runId,
    objective: runId,
    preset: "general" as RunSnapshot["preset"],
    cwd: "/tmp",
    status: "completed" as RunSnapshot["status"],
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    parentRunId: null,
    sessionId: null,
    childSessionIds: [],
    attemptCount: 0,
    latestCheckpointId: null,
    latestApprovalId: null,
    summary: null,
    error: null,
    tags: [],
    metadata: {},
  };
}

describe("FileRunStore.list pagination guards", () => {
  async function seed3(): Promise<FileRunStore> {
    const store = new FileRunStore(dir);
    await store.create(snap("r1", 100));
    await store.create(snap("r2", 200));
    await store.create(snap("r3", 300)); // newest
    return store;
  }

  test("default list returns all newest-first", async () => {
    const store = await seed3();
    const runs = await store.list();
    expect(runs.map((r) => r.runId)).toEqual(["r3", "r2", "r1"]);
  });

  // Footgun: offset/limit fed straight to Array.slice(). A negative offset
  // (slice's "from the end") silently returns a surprise tail window instead
  // of a clean result. Pagination params must be clamped to sane bounds.
  test("negative offset does not return a surprise tail slice", async () => {
    const store = await seed3();
    const runs = await store.list({ offset: -1, limit: 10 });
    // negative offset clamps to 0 → full list, NOT slice(-1,9)=["r1"] (the
    // misleading "last element" the raw slice would yield).
    expect(runs.map((r) => r.runId)).toEqual(["r3", "r2", "r1"]);
  });

  test("negative limit yields an empty page, not a reversed window", async () => {
    const store = await seed3();
    const runs = await store.list({ offset: 0, limit: -1 });
    // slice(0, -1) would drop the last element (["r3","r2"]); a negative limit
    // is nonsense → empty page.
    expect(runs).toEqual([]);
  });

  test("offset past the end yields empty", async () => {
    const store = await seed3();
    expect(await store.list({ offset: 100, limit: 10 })).toEqual([]);
  });

  test("normal pagination still works", async () => {
    const store = await seed3();
    expect((await store.list({ offset: 1, limit: 1 })).map((r) => r.runId)).toEqual(["r2"]);
  });
});
