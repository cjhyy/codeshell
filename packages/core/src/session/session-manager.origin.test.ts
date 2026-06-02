import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager.create — origin", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "smo-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes origin into state.json when provided", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/tmp", "m", "p", "s1", null, "desktop");
    expect(b.state.origin).toBe("desktop");
    const onDisk = JSON.parse(readFileSync(join(dir, "s1", "state.json"), "utf8"));
    expect(onDisk.origin).toBe("desktop");
  });

  test("omits origin when not provided", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/tmp", "m", "p", "s2");
    expect(b.state.origin).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(dir, "s2", "state.json"), "utf8"));
    expect("origin" in onDisk).toBe(false);
  });
});
