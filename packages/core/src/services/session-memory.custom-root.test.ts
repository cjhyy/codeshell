/**
 * Task 1 (identity dimension foundations): the session-memory service must
 * honor an explicitly injected base dir (the `~/.code-shell`-equivalent root)
 * — the seam a per-identity server deployment uses instead of relocating
 * $HOME. Default (no override) behavior is covered by existing tests.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  test("rejects traversal ids and linked memory storage", () => {
    expect(() => saveSessionMemory(entry("../escape", "bad"), baseDir)).toThrow(/invalid/);
    expect(existsSync(join(baseDir, "escape.json"))).toBe(false);

    const outside = mkdtempSync(join(tmpdir(), "csh-session-mem-outside-"));
    try {
      symlinkSync(outside, join(baseDir, "session-memories"));
      expect(() => saveSessionMemory(entry("sess-linked", "bad"), baseDir)).toThrow(
        /real directory/,
      );
      expect(existsSync(join(outside, "sess-linked.json"))).toBe(false);
    } finally {
      rmSync(join(baseDir, "session-memories"), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("ignores linked or malformed memory files without replacing them", () => {
    const dir = join(baseDir, "session-memories");
    mkdirSync(dir);
    const outside = join(baseDir, "outside.json");
    writeFileSync(outside, JSON.stringify(entry("sess-link", "outside")));
    symlinkSync(outside, join(dir, "sess-link.json"));
    expect(loadSessionMemory("sess-link", baseDir)).toBeNull();
    expect(() => saveSessionMemory(entry("sess-link", "changed"), baseDir)).toThrow(
      /regular file/,
    );
    expect(JSON.parse(readFileSync(outside, "utf8")).summary).toBe("outside");

    writeFileSync(join(dir, "malformed.json"), JSON.stringify({ sessionId: "malformed" }));
    expect(listSessionMemories(50, baseDir)).toEqual([]);
  });
});
