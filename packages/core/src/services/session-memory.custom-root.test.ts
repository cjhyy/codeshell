/**
 * Task 1 (identity dimension foundations): the session-memory service must
 * honor an explicitly injected base dir (the `~/.code-shell`-equivalent root)
 * — the seam a per-identity server deployment uses instead of relocating
 * $HOME. Default (no override) behavior is covered by existing tests.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSessionMemory,
  loadSessionMemory,
  listSessionMemories,
  searchSessionMemories,
  type SessionMemoryEntry,
} from "./session-memory.js";

function entry(sessionId: string, summary: string): SessionMemoryEntry {
  return {
    sessionId,
    summary,
    keyTopics: ["topic"],
    decisions: ["decision"],
    createdAt: new Date().toISOString(),
  };
}

describe("session-memory service — injected base dir", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "csh-session-mem-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("save/load/list/search round-trip inside the injected root", () => {
    saveSessionMemory(entry("sess-custom", "custom-root summary about widgets"), baseDir);

    expect(existsSync(join(baseDir, "session-memories", "sess-custom.json"))).toBe(true);
    expect(loadSessionMemory("sess-custom", baseDir)?.summary).toContain("widgets");
    expect(listSessionMemories(50, baseDir).map((m) => m.sessionId)).toEqual(["sess-custom"]);
    expect(searchSessionMemories("widgets", baseDir)).toHaveLength(1);

    // A different injected root is fully isolated.
    const otherDir = mkdtempSync(join(tmpdir(), "csh-session-mem-other-"));
    try {
      expect(loadSessionMemory("sess-custom", otherDir)).toBeNull();
      expect(listSessionMemories(50, otherDir)).toEqual([]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
