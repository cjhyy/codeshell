import { describe, it, expect } from "bun:test";
import { ChatSessionManager } from "../packages/core/src/protocol/chat-session-manager.ts";

function fakeRuntime(): any { return {}; }

// A fake engine that honors the parts of the Engine contract ChatSessionManager
// actually touches — including getPermissionMode/setPermissionMode, which
// getOrCreate calls to re-apply a pill change on a reused session.
function fakeEngine(initialMode: string = "default"): any {
  let mode = initialMode;
  return {
    run: async () => ({}),
    planMode: false,
    getPermissionMode: () => mode,
    setPermissionMode: (m: string) => {
      mode = m;
    },
  };
}

describe("ChatSessionManager", () => {
  it("creates and reuses sessions by id", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => fakeEngine(),
      maxSessions: 4,
      idleTtlMs: 60_000,
    });
    const s1 = m.getOrCreate("A", { permissionMode: "default" } as any);
    const s2 = m.getOrCreate("A", { permissionMode: "default" } as any);
    expect(s1).toBe(s2);
    expect(m.sessionCount()).toBe(1);
  });

  it("rejects with Overloaded when new session exceeds ceiling", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => fakeEngine(),
      maxSessions: 2,
      idleTtlMs: 60_000,
    });
    m.getOrCreate("A", {} as any);
    m.getOrCreate("B", {} as any);
    expect(() => m.getOrCreate("C", {} as any)).toThrow(/Overloaded/);
    // Existing session still accessible:
    expect(m.get("A")).toBeDefined();
  });

  it("close() removes the session", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => fakeEngine(),
      maxSessions: 4,
      idleTtlMs: 60_000,
    });
    m.getOrCreate("A", {} as any);
    m.close("A");
    expect(m.get("A")).toBeUndefined();
  });

  it("forEachSession iterates every live session once", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => fakeEngine(),
      maxSessions: 4,
      idleTtlMs: 60_000,
    });
    m.getOrCreate("A", {} as any);
    m.getOrCreate("B", {} as any);
    const seen: string[] = [];
    m.forEachSession((s) => seen.push(s.id));
    expect(seen.sort()).toEqual(["A", "B"]);
  });

  it("evicts idle sessions older than idleTtlMs", async () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => fakeEngine(),
      maxSessions: 4,
      idleTtlMs: 20,
    });
    const s = m.getOrCreate("A", {} as any);
    s.lastActivityAt = Date.now() - 1000;
    m.sweepIdle();
    expect(m.get("A")).toBeUndefined();
  });

  it("re-applies a changed permissionMode on a reused session", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => fakeEngine("default"),
      maxSessions: 4,
      idleTtlMs: 60_000,
    });
    const s = m.getOrCreate("A", { permissionMode: "default" } as any);
    expect(s.engine.getPermissionMode()).toBe("default");
    // Pill changed to plan on the next send for the same session.
    m.getOrCreate("A", { permissionMode: "plan" } as any);
    expect(s.engine.getPermissionMode()).toBe("plan");
  });

  it("tolerates an engine without permission-mode methods (no crash)", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      // Minimal engine missing getPermissionMode/setPermissionMode.
      engineFactory: () => ({ run: async () => ({}), planMode: false } as any),
      maxSessions: 4,
      idleTtlMs: 60_000,
    });
    m.getOrCreate("A", { permissionMode: "default" } as any);
    // Reuse with a changed mode must not throw even though the engine lacks
    // the methods (defense-in-depth: engineFactory is caller-supplied).
    expect(() => m.getOrCreate("A", { permissionMode: "plan" } as any)).not.toThrow();
  });
});
