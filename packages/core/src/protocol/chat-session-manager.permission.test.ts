/** Permission-mode lifecycle and approval cleanup integration coverage. */
import { afterEach, describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";
import type { ApprovalRequest, ApprovalResult, PermissionMode } from "../types.js";
import {
  enforcePathPolicyWithApproval,
  _resetSessionPathGrants,
} from "../tool-system/path-policy.js";
import { getInteractiveApprovalBackend } from "../tool-system/permission.js";
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

function interactiveRequest(sessionId: string, command: string): ApprovalRequest {
  return {
    sessionId,
    toolName: "Bash",
    args: { command },
    description: "",
    riskLevel: "medium",
  };
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

describe("ChatSessionManager.getOrCreate does not mutate live permission context", () => {
  it("does not apply a changed per-send mode while reusing a session", () => {
    const { mgr, fakes } = makeManager("default");
    mgr.getOrCreate("s1", { permissionMode: "default" } as EngineConfigSlice);
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.current()).toBe("default");

    mgr.getOrCreate("s1", { permissionMode: "bypassPermissions" } as EngineConfigSlice);
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.setCalls).toEqual([]);
    expect(fakes[0]!.current()).toBe("default");
  });

  it("does NOT call setPermissionMode when the mode is unchanged", () => {
    const { mgr, fakes } = makeManager("acceptEdits");
    mgr.getOrCreate("s1", { permissionMode: "acceptEdits" } as EngineConfigSlice);
    mgr.getOrCreate("s1", { permissionMode: "acceptEdits" } as EngineConfigSlice);
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.setCalls).toHaveLength(0); // no redundant reconfigure
  });

  it("does not mutate either engine when different sessions are looked up", () => {
    const { mgr, fakes } = makeManager("default");
    mgr.getOrCreate("s1", { permissionMode: "default" } as EngineConfigSlice);
    mgr.getOrCreate("s2", { permissionMode: "default" } as EngineConfigSlice);
    expect(fakes).toHaveLength(2);

    mgr.getOrCreate("s1", { permissionMode: "bypassPermissions" } as EngineConfigSlice);
    expect(fakes[0]!.current()).toBe("default");
    expect(fakes[1]!.current()).toBe("default");
    expect(fakes[0]!.setCalls).toHaveLength(0);
    expect(fakes[1]!.setCalls).toHaveLength(0);
  });
});

describe("ChatSessionManager.close approval cleanup", () => {
  it("clears interactive approval session rules for the closed session", async () => {
    const sessionId = "interactive-cleanup-s1";
    const { mgr } = makeManager("default");
    mgr.getOrCreate(sessionId, { permissionMode: "default" } as EngineConfigSlice);
    const backend = getInteractiveApprovalBackend();
    let prompts = 0;
    backend.setPromptFn(async () => {
      prompts += 1;
      return prompts === 1
        ? ({ approved: true, always: true, scope: "session" } as ApprovalResult)
        : ({ approved: false } as ApprovalResult);
    });

    const first = await backend.requestApproval(
      interactiveRequest(sessionId, "curl https://cleanup.example/a"),
    );
    expect(first.approved).toBe(true);

    const remembered = await backend.requestApproval(
      interactiveRequest(sessionId, "curl https://cleanup.example/b"),
    );
    expect(remembered.approved).toBe(true);
    expect(prompts).toBe(1);

    mgr.close(sessionId);

    const afterClose = await backend.requestApproval(
      interactiveRequest(sessionId, "curl https://cleanup.example/c"),
    );
    expect(afterClose.approved).toBe(false);
    expect(prompts).toBe(2);
  });

  it("ignores a late interactive approval that resolves after session close", async () => {
    const sessionId = "interactive-late-s1";
    const { mgr } = makeManager("default");
    mgr.getOrCreate(sessionId, { permissionMode: "default" } as EngineConfigSlice);
    const backend = getInteractiveApprovalBackend();
    let resolvePrompt!: (r: ApprovalResult) => void;
    let prompts = 0;
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    backend.setPromptFn(() => {
      prompts += 1;
      markPromptStarted();
      return new Promise<ApprovalResult>((resolve) => {
        resolvePrompt = resolve;
      });
    });

    const pending = backend.requestApproval(
      interactiveRequest(sessionId, "curl https://late.example/a"),
    );
    await promptStarted;
    mgr.close(sessionId);
    resolvePrompt({ approved: true, always: true, scope: "session" } as ApprovalResult);
    expect((await pending).approved).toBe(true);

    backend.setPromptFn(async () => {
      prompts += 1;
      return { approved: false } as ApprovalResult;
    });
    const afterClose = await backend.requestApproval(
      interactiveRequest(sessionId, "curl https://late.example/b"),
    );
    expect(afterClose.approved).toBe(false);
    expect(prompts).toBe(2);
  });

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

  it.each([
    ["session", "本目录本会话允许"],
    ["project", "本目录本项目允许"],
  ] as const)(
    "ignores an in-flight %s path approval that resolves after session close",
    async (_scope, answer) => {
      _resetSessionPathGrants();
      const { mgr } = makeManager("default");
      mgr.getOrCreate("s1", { permissionMode: "default" } as EngineConfigSlice);
      const cwd = tempDir("cs-path-late-cwd-");
      const outside = tempDir("cs-path-late-outside-");
      let resolveAsk!: (answer: string) => void;
      let asks = 0;
      let markAskStarted!: () => void;
      const askStarted = new Promise<void>((resolve) => {
        markAskStarted = resolve;
      });

      const pendingCtx = {
        cwd,
        sessionId: "s1",
        askUser: async () => {
          asks += 1;
          markAskStarted();
          return await new Promise<string>((resolve) => {
            resolveAsk = resolve;
          });
        },
      } as unknown as ToolContext;

      const pending = enforcePathPolicyWithApproval(join(outside, "a.txt"), "read", pendingCtx);
      await askStarted;
      mgr.close("s1");
      resolveAsk(answer);
      expect(await pending).toBeNull();

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
    },
  );

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
