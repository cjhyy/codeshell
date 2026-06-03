import { describe, it, expect } from "bun:test";
import { ChatSessionManager } from "../packages/core/src/protocol/chat-session-manager.ts";

function fakeRuntime(): any { return {}; }

describe("ChatSessionManager", () => {
  it("creates and reuses sessions by id", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
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
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
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
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
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
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
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
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
      maxSessions: 4,
      idleTtlMs: 20,
    });
    const s = m.getOrCreate("A", {} as any);
    s.lastActivityAt = Date.now() - 1000;
    m.sweepIdle();
    expect(m.get("A")).toBeUndefined();
  });
});
