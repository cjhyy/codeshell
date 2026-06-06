/**
 * Regression for design §难点5 — a never-ending background shell must NOT
 * stall Engine.run's wait-for-background loop.
 *
 * Engine.run (engine.ts ~1700) blocks turn completion while
 * `asyncAgentRegistry.hasRunningForSession(sid)` is true. Background *agents*
 * finish, so that's fine. Background *shells* (a dev server) never finish —
 * if they were ever tracked by the same registry, the turn would hang
 * forever (the "卡住" class of bug). They live in a SEPARATE manager that the
 * wait loop never consults.
 *
 * This test pins the invariant: starting a long-lived background shell leaves
 * the asyncAgentRegistry's per-session "is anything running" predicate false,
 * so the wait loop's exit condition is immediately satisfiable.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "./background-shell.js";
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";

let home: string;
let mgr: BackgroundShellManager;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bgreg-"));
  process.env.CODE_SHELL_HOME = home;
  mgr = new BackgroundShellManager();
  asyncAgentRegistry.reset();
});
afterEach(async () => {
  await mgr.killAll();
  asyncAgentRegistry.reset();
  rmSync(home, { recursive: true, force: true });
  delete process.env.CODE_SHELL_HOME;
});

describe("background shell does not enter the Engine wait loop", () => {
  test("a never-ending bg shell leaves asyncAgentRegistry idle for its session", async () => {
    const sid = "sessRegression";
    const r = mgr.spawnBackground({ command: "sleep 1000", cwd: home, sessionId: sid });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The shell is genuinely running...
    expect(mgr.get(r.shellId)?.status).toBe("running");

    // ...but the registry the wait loop polls knows nothing about it, so the
    // loop's `while (hasRunningForSession(sid))` would not even iterate.
    expect(asyncAgentRegistry.hasRunningForSession(sid)).toBe(false);
    expect(asyncAgentRegistry.hasRunning()).toBe(false);
  });
});
