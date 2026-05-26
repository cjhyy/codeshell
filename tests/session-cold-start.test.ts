/**
 * Regression test for the `[-32603] Session not found: <sid>` bug
 * users hit on TUI cold start.
 *
 * Repro:
 *   1. TUI launches with `tuiSessionId = "tui-main"` (or any explicit sid).
 *   2. First message → AgentClient.run(task, "tui-main").
 *   3. AgentServer.handleRunMulti → chatManager.getOrCreate("tui-main")
 *      builds a fresh ChatSession + Engine.
 *   4. ChatSession.pump → engine.run(task, { sessionId: "tui-main" }).
 *   5. Engine.run used to call sessionManager.resume("tui-main") which
 *      threw SessionError("Session not found"), bubbling out as
 *      InternalError -32603 to the client.
 *
 * Fix: engine.run checks `sessionManager.exists(sid)` first. Existing
 * → resume; non-existing → create with the host-supplied sid so future
 * turns can resume.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../packages/core/src/session/session-manager.ts";

describe("SessionManager — cold start with explicit sid", () => {
  it("exists() returns false for a missing session, true after create", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-cold-"));
    try {
      const mgr = new SessionManager(dir);
      expect(mgr.exists("tui-main")).toBe(false);

      const bundle = mgr.create("/cwd", "claude-x", "anthropic", "tui-main");
      expect(bundle.state.sessionId).toBe("tui-main");
      expect(mgr.exists("tui-main")).toBe(true);
      expect(existsSync(join(dir, "tui-main", "state.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("create() with explicit sid uses it verbatim instead of nanoid", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-cold-"));
    try {
      const mgr = new SessionManager(dir);
      const bundle = mgr.create("/cwd", "m", "p", "my-logical-id");
      expect(bundle.state.sessionId).toBe("my-logical-id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("create() without explicit sid still generates a nanoid", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-cold-"));
    try {
      const mgr = new SessionManager(dir);
      const bundle = mgr.create("/cwd", "m", "p");
      // nanoid(16) → 16 chars, no spaces, no slashes.
      expect(bundle.state.sessionId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("create() with explicit sid then resume() round-trips state", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-cold-"));
    try {
      const mgr = new SessionManager(dir);
      mgr.create("/cwd", "model-a", "anthropic", "tui-main");
      const resumed = mgr.resume("tui-main");
      expect(resumed.state.sessionId).toBe("tui-main");
      expect(resumed.state.cwd).toBe("/cwd");
      expect(resumed.state.model).toBe("model-a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
