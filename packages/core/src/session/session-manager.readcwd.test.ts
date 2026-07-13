// packages/core/src/session/session-manager.readcwd.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, sessionMainRoot } from "./session-manager.js";

// readSessionMainRoot is the cheap persisted-main-project-root probe. It reads
// only state.json — NOT the transcript like resume() does — and intentionally
// does not substitute the current worktree workspace root.
describe("SessionManager.readSessionMainRoot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns the cwd a session was created with", () => {
    const sm = new SessionManager(dir);
    sm.create("/Users/me/seedance-project", "m", "p", "s-1");
    expect(sm.readSessionMainRoot("s-1")).toBe("/Users/me/seedance-project");
  });

  test("keeps the legacy readCwd alias and pure state helper byte-compatible", () => {
    const sm = new SessionManager(dir);
    sm.create("/Users/me/project", "m", "p", "legacy-api");

    expect(sessionMainRoot({ cwd: "/Users/me/project" })).toBe("/Users/me/project");
    expect(sessionMainRoot({ cwd: "" })).toBeUndefined();
    expect(sm.readCwd("legacy-api")).toBe(sm.readSessionMainRoot("legacy-api"));
  });

  test("returns undefined for an unknown session", () => {
    const sm = new SessionManager(dir);
    expect(sm.readSessionMainRoot("does-not-exist")).toBeUndefined();
  });

  test("returns undefined (does not throw) for a traversal-shaped id", () => {
    const sm = new SessionManager(dir);
    expect(sm.readSessionMainRoot("../../etc")).toBeUndefined();
  });
});
