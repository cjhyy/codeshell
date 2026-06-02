// packages/core/src/session/session-manager.parent.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager.create — parentSessionId", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sm-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes parentSessionId into state.json when provided", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/tmp", "m", "p", "child-1", "parent-9");
    expect(b.state.parentSessionId).toBe("parent-9");
    const onDisk = JSON.parse(readFileSync(join(dir, "child-1", "state.json"), "utf8"));
    expect(onDisk.parentSessionId).toBe("parent-9");
  });

  test("omits parentSessionId for a top-level session", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/tmp", "m", "p", "top-1");
    expect(b.state.parentSessionId).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(dir, "top-1", "state.json"), "utf8"));
    expect("parentSessionId" in onDisk).toBe(false);
  });
});
