/**
 * Regression: tests (and any host) must be able to redirect the default
 * sessions dir away from ~/.code-shell via CODE_SHELL_HOME — otherwise unit
 * tests that `new Engine()` / `new SessionManager()` with no explicit
 * storageDir write real session dirs into the user's ~/.code-shell/sessions,
 * polluting the desktop sidebar (the rm-usage/test-model junk). Mirrors Codex's
 * CODEX_HOME isolation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager — CODE_SHELL_HOME isolation", () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "csh-"));
    prev = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  test("default sessions dir lives under CODE_SHELL_HOME, not ~/.code-shell", () => {
    const sm = new SessionManager(); // no explicit storageDir
    sm.create("/tmp", "m", "p", "sess-x");
    // The session must be written under our temp home, never the real home.
    expect(existsSync(join(home, "sessions", "sess-x", "state.json"))).toBe(true);
  });

  test("explicit storageDir still wins over the env", () => {
    const explicit = mkdtempSync(join(tmpdir(), "csh-explicit-"));
    const sm = new SessionManager(join(explicit, "sessions"));
    sm.create("/tmp", "m", "p", "sess-y");
    expect(existsSync(join(explicit, "sessions", "sess-y", "state.json"))).toBe(true);
    rmSync(explicit, { recursive: true, force: true });
  });
});
