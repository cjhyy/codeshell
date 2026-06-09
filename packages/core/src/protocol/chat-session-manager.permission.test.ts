/**
 * Integration test for the #11 SECONDARY fix (permission 档位 backend).
 *
 * Bug: ChatSessionManager.getOrCreate returned an EXISTING session early and
 * dropped slice.permissionMode, so changing the pill on an already-running
 * session was silently ignored at enforcement time — the engine kept whatever
 * mode it was first created with. Fix: re-apply slice.permissionMode (via
 * engine.setPermissionMode, which reconfigures the live backend) when it
 * differs, before returning the cached session.
 *
 * This drives the REAL ChatSessionManager.getOrCreate against a fake engine
 * that records permission-mode reads/writes.
 */
import { describe, it, expect } from "bun:test";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";
import type { PermissionMode } from "../types.js";

function fakeEngine(initial: PermissionMode) {
  let mode: PermissionMode = initial;
  const setCalls: PermissionMode[] = [];
  const engine = {
    getPermissionMode() {
      return mode;
    },
    setPermissionMode(m: PermissionMode) {
      mode = m;
      setCalls.push(m);
    },
  } as unknown as Engine;
  return { engine, setCalls, current: () => mode };
}

function makeManager(initial: PermissionMode) {
  const fakes: ReturnType<typeof fakeEngine>[] = [];
  const mgr = new ChatSessionManager({
    runtime: {} as unknown as EngineRuntime,
    engineFactory: (_slice: EngineConfigSlice) => {
      const f = fakeEngine(initial);
      fakes.push(f);
      return f.engine;
    },
  });
  return { mgr, fakes };
}

describe("ChatSessionManager.getOrCreate re-applies permissionMode (#11)", () => {
  it("applies a CHANGED permissionMode to an already-created session", () => {
    const { mgr, fakes } = makeManager("default");
    // First send creates the engine with "default".
    mgr.getOrCreate("s1", { permissionMode: "default" } as EngineConfigSlice);
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.current()).toBe("default");

    // Pill changed to bypassPermissions, user re-sends in the SAME session.
    mgr.getOrCreate("s1", { permissionMode: "bypassPermissions" } as EngineConfigSlice);
    // No new engine; the existing one was reconfigured live.
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.setCalls).toContain("bypassPermissions");
    expect(fakes[0]!.current()).toBe("bypassPermissions");
  });

  it("does NOT call setPermissionMode when the mode is unchanged", () => {
    const { mgr, fakes } = makeManager("acceptEdits");
    mgr.getOrCreate("s1", { permissionMode: "acceptEdits" } as EngineConfigSlice);
    mgr.getOrCreate("s1", { permissionMode: "acceptEdits" } as EngineConfigSlice);
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.setCalls).toHaveLength(0); // no redundant reconfigure
  });

  it("keeps modes independent across different sessions (no cross-session bleed)", () => {
    const { mgr, fakes } = makeManager("default");
    mgr.getOrCreate("s1", { permissionMode: "default" } as EngineConfigSlice);
    mgr.getOrCreate("s2", { permissionMode: "default" } as EngineConfigSlice);
    expect(fakes).toHaveLength(2);

    // Bump only s1 to bypass.
    mgr.getOrCreate("s1", { permissionMode: "bypassPermissions" } as EngineConfigSlice);
    expect(fakes[0]!.current()).toBe("bypassPermissions");
    // s2 is untouched — its engine never got a setPermissionMode call.
    expect(fakes[1]!.current()).toBe("default");
    expect(fakes[1]!.setCalls).toHaveLength(0);
  });
});
