// LSP manager lifecycle.
//
// The manager used to be a single process-wide singleton created only by
// `initializeLSPManager()` — which NO host ever called. The `LSP` tool was
// registered and advertised to the agent, but its first act is `getLSPManager()`,
// so every invocation returned "LSP is not initialized". The capability was dead
// in every product surface.
//
// It is now created lazily per workspace root, which also fixes the design flaw
// behind the singleton: one process can span several workspaces (worktrees,
// sub-agents) while a language server is rooted at exactly one directory.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLSPManager,
  initializeLSPManager,
  shutdownAllLSPManagers,
  shutdownLSPManager,
} from "./manager.js";

const dirs: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "lsp-ws-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await shutdownAllLSPManagers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("LSP manager registry", () => {
  test("getLSPManager creates one on first use instead of returning undefined", async () => {
    // The whole bug: this returned undefined forever because nothing called
    // initializeLSPManager().
    const root = workspace();
    expect(getLSPManager(root, { create: false })).toBeUndefined();
    expect(getLSPManager(root)).toBeDefined();
  });

  test("the same root reuses one manager", () => {
    const root = workspace();
    const first = getLSPManager(root);
    expect(first).toBeDefined();
    expect(getLSPManager(root)).toBe(first!);
    expect(initializeLSPManager(root)).toBe(first!);
  });

  test("different roots get different managers", () => {
    // A language server is rooted at one directory; two worktrees must not share.
    const a = workspace();
    const b = workspace();
    expect(getLSPManager(a)).not.toBe(getLSPManager(b));
  });

  test("create:false observes without spawning", () => {
    const root = workspace();
    expect(getLSPManager(root, { create: false })).toBeUndefined();
    // Still nothing was registered.
    expect(getLSPManager(root, { create: false })).toBeUndefined();
  });

  test("shutdown forgets the workspace so a later call builds a fresh one", async () => {
    const root = workspace();
    const first = getLSPManager(root);
    await shutdownLSPManager(root);
    expect(getLSPManager(root, { create: false })).toBeUndefined();
    expect(getLSPManager(root)).not.toBe(first);
  });

  test("shutting down an unknown workspace is a no-op", async () => {
    await shutdownLSPManager(join(tmpdir(), "never-registered"));
  });

  test("the no-argument form resolves only when unambiguous", async () => {
    // Back-compat for call sites without workspace context.
    expect(getLSPManager()).toBeUndefined();
    const only = getLSPManager(workspace());
    expect(getLSPManager()).toBe(only);
    // With two workspaces there is no single right answer, so it declines.
    getLSPManager(workspace());
    expect(getLSPManager()).toBeUndefined();
  });

  test("a fresh manager reports its servers as stopped, not connected", () => {
    const manager = getLSPManager(workspace())!;
    expect(manager.isConnected()).toBe(false);
    // Built-in servers are registered but not started — lazy by design, so a
    // session that never uses LSP pays for no processes.
    expect(manager.listServers().length).toBeGreaterThan(0);
    expect(manager.listServers().every((s) => s.state === "stopped")).toBe(true);
  });
});
