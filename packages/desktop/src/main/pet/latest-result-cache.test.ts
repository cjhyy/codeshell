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
});
