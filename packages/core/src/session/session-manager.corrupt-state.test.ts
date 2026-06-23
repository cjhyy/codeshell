import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { SessionError } from "../exceptions.js";

/**
 * A corrupt state.json (external tampering, disk corruption, or a crash during
 * the one-time create() write) must surface as a clean SessionError on resume —
 * NOT a raw SyntaxError that escapes callers that only catch SessionError.
 * (saveState already writes atomically; create() now does too.)
 */
describe("SessionManager.resume on corrupt state.json", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sm-corrupt-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("throws SessionError (not raw SyntaxError) on a torn/garbage state.json", () => {
    const sm = new SessionManager(dir);
    sm.create("/tmp/proj", "m", "p", "s-corrupt");
    // Simulate a torn write: truncated JSON.
    writeFileSync(join(dir, "s-corrupt", "state.json"), '{"sessionId":"s-corrupt", "cw');

    let caught: unknown;
    try {
      sm.resume("s-corrupt");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionError);
    expect(String((caught as Error).message)).toContain("corrupt");
  });

  test("a normally-created session still resumes fine", () => {
    const sm = new SessionManager(dir);
    sm.create("/tmp/proj", "m", "p", "s-ok");
    const bundle = sm.resume("s-ok");
    expect(bundle.state.sessionId).toBe("s-ok");
    expect(bundle.state.cwd).toBe("/tmp/proj");
  });
});
