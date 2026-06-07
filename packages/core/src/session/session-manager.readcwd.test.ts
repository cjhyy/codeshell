// packages/core/src/session/session-manager.readcwd.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

// readCwd is the cheap "what cwd is this session bound to?" probe used by
// engine.run to recover a resumed session's project directory when the caller
// (a host whose UI repo selection drifted to null) omits options.cwd. It must
// read only state.json — NOT load the transcript like resume() does — so the
// cwd-resolution path at the top of run() stays cheap.
describe("SessionManager.readCwd", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sm-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("returns the cwd a session was created with", () => {
    const sm = new SessionManager(dir);
    sm.create("/Users/me/seedance-project", "m", "p", "s-1");
    expect(sm.readCwd("s-1")).toBe("/Users/me/seedance-project");
  });

  test("returns undefined for an unknown session", () => {
    const sm = new SessionManager(dir);
    expect(sm.readCwd("does-not-exist")).toBeUndefined();
  });

  test("returns undefined (does not throw) for a traversal-shaped id", () => {
    const sm = new SessionManager(dir);
    expect(sm.readCwd("../../etc")).toBeUndefined();
  });
});
