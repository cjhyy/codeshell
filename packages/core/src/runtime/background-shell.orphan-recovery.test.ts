/**
 * Integration test for the #7 fix (background-shell card stuck running / 无输出).
 *
 * Scenario: a worker spawns a long-lived background shell that prints output,
 * then the worker process RECYCLES (between sessions / app reopen). A fresh
 * worker — modeled here by a SECOND BackgroundShellManager over the same
 * CODE_SHELL_HOME — recovers the shell from its pidfile. The bug was that the
 * recovered (orphan) entry opened a brand-new EMPTY `.orphan` ring, so the card
 * always showed "(无输出)". The fix points the orphan ring at the existing
 * `.log` (read-only), so the already-captured output is surfaced.
 *
 * This exercises the REAL runtime path (real bash, real pidfile, real .log on
 * disk, real reapOrphansFromPidfiles) — not a unit mock.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "./background-shell.js";

let home: string;
let mgrA: BackgroundShellManager;
let mgrB: BackgroundShellManager | null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bg-orphan-"));
  process.env.CODE_SHELL_HOME = home;
  mgrA = new BackgroundShellManager();
  mgrB = null;
});
afterEach(async () => {
  await mgrA.killAll().catch(() => {});
  await mgrB?.killAll().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  delete process.env.CODE_SHELL_HOME;
});

/** Poll until `fn()` is truthy or the deadline passes. */
async function waitFor(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

describe("background shell orphan recovery surfaces real .log output (#7)", () => {
  test("a recovered orphan shell reads its captured output, not an empty ring", async () => {
    const sid = "sessOrphan";
    // Long-lived so its process group is still alive when the second manager
    // recovers it (reapOrphansFromPidfiles only re-registers live groups).
    const spawn = mgrA.spawnBackground({
      command: "echo HELLO_FROM_BG; sleep 1000",
      cwd: home,
      sessionId: sid,
    });
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) return;

    // Wait until the echo line has been captured into the live ring.
    const sawOutput = await waitFor(() => {
      const r = mgrA.readOutput(spawn.shellId, "all", sid);
      return r.ok && r.text.includes("HELLO_FROM_BG");
    });
    expect(sawOutput).toBe(true);

    // --- worker recycles: a brand-new manager has an EMPTY in-memory registry.
    mgrB = new BackgroundShellManager();
    expect(mgrB.listForSession(sid)).toHaveLength(0);

    // Recover from pidfiles (the live process group is still alive).
    const orphans = mgrB.reapOrphansFromPidfiles();
    expect(orphans.some((o) => o.shellId === spawn.shellId)).toBe(true);

    // The recovered shell now lists, AND its output is the REAL captured text
    // (pre-fix this was "" → "(无输出)").
    const listed = mgrB.listForSession(sid);
    expect(listed.some((s) => s.shellId === spawn.shellId)).toBe(true);

    const out = mgrB.readOutput(spawn.shellId, "all", sid);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toContain("HELLO_FROM_BG");
    }
  });
});
