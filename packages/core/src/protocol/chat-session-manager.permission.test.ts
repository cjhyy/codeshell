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
import { afterEach, describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";
import type { PermissionMode } from "../types.js";
import {
  enforcePathPolicyWithApproval,
  _resetSessionPathGrants,
} from "../tool-system/path-policy.js";
import type { ToolContext } from "../tool-system/context.js";
import { CredentialStore } from "../credentials/store.js";
import {
  useCredentialTool,
  __resetCredentialSessionAllowForTests,
} from "../credentials/use-credential-tool.js";

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

const tempDirs: string[] = [];
let previousHome: string | undefined;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function parseToolResult(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

afterEach(() => {
  _resetSessionPathGrants();
  __resetCredentialSessionAllowForTests();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  previousHome = undefined;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

describe("ChatSessionManager.close approval cleanup", () => {
  it("clears session path approvals for the closed session", async () => {
    _resetSessionPathGrants();
    const { mgr } = makeManager("default");
    mgr.getOrCreate("s1", { permissionMode: "default" } as EngineConfigSlice);
    const cwd = tempDir("cs-path-cleanup-cwd-");
    const outside = tempDir("cs-path-cleanup-outside-");
    let asks = 0;

    const allowCtx = {
      cwd,
      sessionId: "s1",
      askUser: async () => {
        asks += 1;
        return "本目录本会话允许";
      },
    } as unknown as ToolContext;
    expect(
      await enforcePathPolicyWithApproval(join(outside, "a.txt"), "read", allowCtx),
    ).toBeNull();
    expect(asks).toBe(1);

    mgr.close("s1");

    const denyCtx = {
      cwd,
      sessionId: "s1",
      askUser: async () => {
        asks += 1;
        return "拒绝";
      },
    } as unknown as ToolContext;
    const denied = await enforcePathPolicyWithApproval(join(outside, "b.txt"), "read", denyCtx);
    expect(denied).toContain("approval denied");
    expect(asks).toBe(2);
  });

  it("clears session credential approvals for the closed session", async () => {
    previousHome = process.env.HOME;
    process.env.HOME = tempDir("cs-credential-cleanup-home-");
    const cwd = tempDir("cs-credential-cleanup-cwd-");
    __resetCredentialSessionAllowForTests();
    const { mgr } = makeManager("default");
    mgr.getOrCreate("s1", { permissionMode: "default" } as EngineConfigSlice);
    new CredentialStore(cwd).save("user", {
      id: "figma",
      type: "token",
      label: "Figma",
      secret: "tok-123",
    });

    let asks = 0;
    const allowCtx = {
      cwd,
      sessionId: "s1",
      askUser: async () => {
        asks += 1;
        return "本会话都允许";
      },
    } as unknown as ToolContext;
    expect(parseToolResult(await useCredentialTool({ id: "figma" }, allowCtx))).toEqual({
      kind: "value",
      value: "tok-123",
    });
    expect(asks).toBe(1);

    const rememberedCtx = { cwd, sessionId: "s1" } as unknown as ToolContext;
    expect(parseToolResult(await useCredentialTool({ id: "figma" }, rememberedCtx))).toEqual({
      kind: "value",
      value: "tok-123",
    });

    mgr.close("s1");

    const afterClose = parseToolResult(await useCredentialTool({ id: "figma" }, rememberedCtx));
    expect(afterClose.kind).toBe("error");
    expect(String(afterClose.error)).toContain("headless");
  });
});
