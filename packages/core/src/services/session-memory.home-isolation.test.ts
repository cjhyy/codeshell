import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSessionMemory } from "./session-memory.js";

// BUG (homedir audit): MEMORY_DIR was a module-level const built from raw
// homedir() — frozen at import, ignoring $HOME. saveSessionMemory wrote into the
// REAL ~/.code-shell/session-memories on every call (the existing sort test even
// hand-cleans real disk). Resolving per-call from $HOME fixes the pollution.

let prevHome: string | undefined;
let home: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "cs-sessmem-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("session-memory honors $HOME (no real-disk pollution)", () => {
  test("saveSessionMemory writes under $HOME, not the real home", () => {
    saveSessionMemory({
      sessionId: "sess-iso-1",
      summary: "s",
      keyTopics: [],
      decisions: [],
      createdAt: new Date(0).toISOString(),
    });
    expect(existsSync(join(home, ".code-shell", "session-memories", "sess-iso-1.json"))).toBe(true);
  });
});
