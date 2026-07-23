import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMtimeSessionCache } from "./mtime-session-cache";

function writeTranscript(sessionDir: string, timestamp?: number): string {
  const transcriptPath = join(sessionDir, "transcript.jsonl");
  writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", timestamp })}\n`);
  return transcriptPath;
}

describe("createMtimeSessionCache", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mtime-session-cache-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("reads the value for a session and passes the session directory to the reader", async () => {
    const sessionDir = join(root, "session-a");
    mkdirSync(sessionDir);
    writeTranscript(sessionDir);
    const seen: string[] = [];
    const cache = createMtimeSessionCache(root, async (dir) => {
      seen.push(dir);
      return "value-a";
    });
    expect(await cache.get("session-a")).toBe("value-a");
    expect(seen).toEqual([join(root, "session-a")]);
  });

  test("returns null for a missing transcript without calling the reader", async () => {
    mkdirSync(join(root, "session-empty"));
    let calls = 0;
    const cache = createMtimeSessionCache(root, async () => {
      calls += 1;
      return "x";
    });
    expect(await cache.get("session-missing")).toBeNull();
    expect(await cache.get("session-empty")).toBeNull();
    expect(calls).toBe(0);
  });

  test("serves the cached value while the transcript mtime is unchanged and re-reads on change", async () => {
    const sessionDir = join(root, "session-a");
    mkdirSync(sessionDir);
    const transcriptPath = writeTranscript(sessionDir);
    const frozen = new Date("2026-01-01T00:00:00Z");
    utimesSync(transcriptPath, frozen, frozen);

    let calls = 0;
    const cache = createMtimeSessionCache(root, async () => {
      calls += 1;
      return `read-${calls}`;
    });

    expect(await cache.get("session-a")).toBe("read-1");
    // Same mtime: cache serves the previously read value, reader not called.
    expect(await cache.get("session-a")).toBe("read-1");
    expect(calls).toBe(1);

    // Bump the mtime: the cache must re-read from disk.
    const later = new Date("2026-01-02T00:00:00Z");
    utimesSync(transcriptPath, later, later);
    expect(await cache.get("session-a")).toBe("read-2");
    expect(calls).toBe(2);
  });

  test("does not cache a failed read, so the next get can succeed on the same mtime", async () => {
    const sessionDir = join(root, "session-a");
    mkdirSync(sessionDir);
    const transcriptPath = writeTranscript(sessionDir);
    const frozen = new Date("2026-01-01T00:00:00Z");
    utimesSync(transcriptPath, frozen, frozen);

    let calls = 0;
    const cache = createMtimeSessionCache(root, async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "recovered";
    });

    expect(await cache.get("session-a")).toBeNull();
    // Same mtime, but the failure must not have been pinned into the cache.
    expect(await cache.get("session-a")).toBe("recovered");
    expect(calls).toBe(2);
    // Third get (same mtime) is served from cache — no further reader calls.
    expect(await cache.get("session-a")).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("evicts the least recently used entry beyond maxEntries, refreshing on hits", async () => {
    for (const id of ["session-a", "session-b", "session-c"]) {
      const dir = join(root, id);
      mkdirSync(dir);
      writeTranscript(dir);
    }
    const reads: string[] = [];
    const cache = createMtimeSessionCache(
      root,
      async (dir) => {
        reads.push(dir);
        return "x";
      },
      { maxEntries: 2 },
    );

    await cache.get("session-a");
    await cache.get("session-b");
    // Hit session-a so it becomes the most recently used entry.
    await cache.get("session-a");
    expect(reads).toEqual([join(root, "session-a"), join(root, "session-b")]);

    // Inserting session-c overflows maxEntries: session-b (LRU) is evicted,
    // session-a survives because the hit refreshed its position.
    await cache.get("session-c");
    await cache.get("session-a");
    expect(reads).toEqual([
      join(root, "session-a"),
      join(root, "session-b"),
      join(root, "session-c"),
    ]);
    await cache.get("session-b");
    expect(reads).toEqual([
      join(root, "session-a"),
      join(root, "session-b"),
      join(root, "session-c"),
      join(root, "session-b"),
    ]);
  });
});
