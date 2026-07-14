import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileRunStore } from "./FileRunStore.js";
import { assertSafeRunId } from "./ids.js";
import type { RunSnapshot } from "./types.js";

function snapshot(runId: string): RunSnapshot {
  return {
    runId,
    objective: "x",
    preset: "general",
    cwd: "/tmp",
    status: "queued",
    createdAt: 1,
    updatedAt: 1,
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

describe("run id path safety", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-runids-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("assertSafeRunId rejects path-shaped ids", () => {
    expect(() => assertSafeRunId("../escape")).toThrow(/invalid run id/);
    expect(() => assertSafeRunId("/tmp/escape")).toThrow(/invalid run id/);
    expect(() => assertSafeRunId("a/b")).toThrow(/invalid run id/);
  });

  test("FileRunStore refuses a traversal run id before joining paths", async () => {
    const store = new FileRunStore(dir);

    await expect(store.create(snapshot("../escape"))).rejects.toThrow(/invalid run id/);
    await expect(store.delete("../escape")).rejects.toThrow(/invalid run id/);
  });

  test("FileRunStore refuses traversal approval ids before joining filenames", async () => {
    const store = new FileRunStore(dir);
    await store.create(snapshot("run-safe"));

    await expect(store.getApproval("run-safe", "../approval")).rejects.toThrow(
      /invalid approval id/,
    );
  });

  test("JSON writes do not use the fixed target.tmp path", async () => {
    const store = new FileRunStore(dir);
    await store.create(snapshot("run-safe"));
    const fixedTmp = join(dir, "run-safe", "run.json.tmp");
    writeFileSync(fixedTmp, "sentinel", "utf-8");

    const updated = { ...snapshot("run-safe"), updatedAt: 2 };
    await store.update(updated);

    expect(existsSync(fixedTmp)).toBe(true);
    expect(readFileSync(fixedTmp, "utf-8")).toBe("sentinel");
  });
});
