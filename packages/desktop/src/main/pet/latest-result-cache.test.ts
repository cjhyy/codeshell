import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLatestResultCache } from "./latest-result-cache";

function writeTranscript(sessionDir: string, text: string, timestamp?: number): string {
  const transcriptPath = join(sessionDir, "transcript.jsonl");
  const event = {
    type: "message",
    ...(timestamp !== undefined ? { timestamp } : {}),
    data: { role: "assistant", content: [{ type: "text", text }] },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(event)}\n`);
  return transcriptPath;
}

describe("createLatestResultCache", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pet-latest-result-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("returns the latest assistant text of a session", async () => {
    const sessionDir = join(root, "session-a");
    mkdirSync(sessionDir);
    writeTranscript(sessionDir, "shipped the fix", 42);

    const cache = createLatestResultCache(root);
    expect(await cache.read("session-a")).toEqual({
      text: "shipped the fix",
      truncated: false,
      timestamp: 42,
    });
  });

  test("serves the cached value while the transcript mtime is unchanged and re-reads on change", async () => {
    const sessionDir = join(root, "session-a");
    mkdirSync(sessionDir);
    const transcriptPath = writeTranscript(sessionDir, "first answer");
    const frozen = new Date("2026-01-01T00:00:00Z");
    utimesSync(transcriptPath, frozen, frozen);

    const cache = createLatestResultCache(root);
    expect((await cache.read("session-a"))?.text).toBe("first answer");

    // Rewrite with a DIFFERENT text but force the SAME mtime: the cache must
    // keep serving the previously read value.
    writeTranscript(sessionDir, "second answer");
    utimesSync(transcriptPath, frozen, frozen);
    expect((await cache.read("session-a"))?.text).toBe("first answer");

    // Bump the mtime: the cache must re-read from disk.
    const later = new Date("2026-01-02T00:00:00Z");
    utimesSync(transcriptPath, later, later);
    expect((await cache.read("session-a"))?.text).toBe("second answer");
  });

  test("returns null for a missing transcript", async () => {
    mkdirSync(join(root, "session-empty"));
    const cache = createLatestResultCache(root);
    expect(await cache.read("session-missing")).toBeNull();
    expect(await cache.read("session-empty")).toBeNull();
  });

  test("does not cache a failed read, so the next read can succeed", async () => {
    const sessionDir = join(root, "session-a");
    mkdirSync(sessionDir);
    writeTranscript(sessionDir, "recovered");
    let calls = 0;
    const cache = createLatestResultCache(root, {
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { text: "recovered", truncated: false };
      },
    });

    expect(await cache.read("session-a")).toBeNull();
    // Same mtime, but the failure must not have been pinned into the cache.
    expect(await cache.read("session-a")).toEqual({ text: "recovered", truncated: false });
    expect(calls).toBe(2);
    // Third read (same mtime) is served from cache — no further reader calls.
    expect(await cache.read("session-a")).toEqual({ text: "recovered", truncated: false });
    expect(calls).toBe(2);
  });

  test("evicts the least recently used entry beyond maxEntries, refreshing on hits", async () => {
    for (const id of ["session-a", "session-b", "session-c"]) {
      const dir = join(root, id);
      mkdirSync(dir);
      writeTranscript(dir, `answer of ${id}`);
    }
    const reads: string[] = [];
    const cache = createLatestResultCache(root, {
      maxEntries: 2,
      read: async (sessionDir) => {
        reads.push(sessionDir);
        return { text: "x", truncated: false };
      },
    });

    await cache.read("session-a");
    await cache.read("session-b");
    // Hit session-a so it becomes the most recently used entry.
    await cache.read("session-a");
    expect(reads).toEqual([join(root, "session-a"), join(root, "session-b")]);

    // Inserting session-c overflows maxEntries: session-b (LRU) is evicted,
    // session-a survives because the hit refreshed its position.
    await cache.read("session-c");
    await cache.read("session-a");
    expect(reads).toEqual([
      join(root, "session-a"),
      join(root, "session-b"),
      join(root, "session-c"),
    ]);
    await cache.read("session-b");
    expect(reads).toEqual([
      join(root, "session-a"),
      join(root, "session-b"),
      join(root, "session-c"),
      join(root, "session-b"),
    ]);
  });
});
