import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type EngineResult } from "../engine/engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { personalizationFrom } from "../settings/personalization.js";
import { SettingsManager } from "../settings/manager.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";
import type { PermissionMode, SessionProjectBinding, SessionWorkspace } from "../types.js";
import type { LLMResponse } from "../types.js";
import { createWorkspaceContext, type WorkspaceContext } from "../workspace/workspace-context.js";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";

const authorityProvider = "chat-session-manager-migration-authority";
const authorityCalls = new Map<
  string,
  Array<{ systemPrompt: string; tools: string; messages: string }>
>();

class AuthorityClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const calls = authorityCalls.get(this.model) ?? [];
    calls.push({
      systemPrompt: options.systemPrompt,
      tools: JSON.stringify(options.tools ?? []),
      messages: JSON.stringify(options.messages),
    });
    authorityCalls.set(this.model, calls);
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text: "ok", toolCalls: [], stopReason: "stop", usage };
  }
}

registerProvider(authorityProvider, AuthorityClient);

function result(sessionId: string): EngineResult {
  return {
    text: "ok",
    reason: "completed",
    sessionId,
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface FakeEngineState {
  mode: PermissionMode;
  runs: Array<{ task: string; sessionId: string }>;
  migrations: Array<{ sessionId: string; project: SessionProjectBinding; mainRoot: string }>;
  restored: string[];
  disposeCalls: number;
}

function fakeEngine(
  state: FakeEngineState,
  overrides: Partial<{
    run: (task: string, options: { sessionId: string }) => Promise<EngineResult>;
    migrate: (
      sessionId: string,
      project: SessionProjectBinding,
      mainRoot: string,
    ) => SessionWorkspace;
  }> = {},
): Engine {
  return {
    getPermissionMode: () => state.mode,
    setPermissionMode: (mode: PermissionMode) => {
      state.mode = mode;
    },
    restoreSessionModel: (sessionId: string) => {
      state.restored.push(sessionId);
    },
    migrateSessionMainRoot: (sessionId, project, mainRoot) => {
      state.migrations.push({ sessionId, project, mainRoot });
      return (
        overrides.migrate?.(sessionId, project, mainRoot) ?? {
          root: mainRoot,
          kind: "main",
        }
      );
    },
    run: async (task: string, options: { sessionId: string }) => {
      state.runs.push({ task, sessionId: options.sessionId });
      return overrides.run?.(task, options) ?? result(options.sessionId);
    },
    dispose: async () => {
      state.disposeCalls += 1;
    },
  } as unknown as Engine;
}

function state(mode: PermissionMode = "default"): FakeEngineState {
  return { mode, runs: [], migrations: [], restored: [], disposeCalls: 0 };
}

function targetAuthority(): {
  project: SessionProjectBinding;
  mainRoot: string;
  workspaceContext: WorkspaceContext;
  projectTrusted: boolean;
} {
  const mainRoot = "/repo/new";
  return {
    project: { projectId: "project-1", mainRootId: "root-new" },
    mainRoot,
    workspaceContext: createWorkspaceContext({
      projectId: "project-1",
      projectRevision: 7,
      sessionMainRootId: "root-new",
      roots: [
        { id: "root-old", path: "/repo/old", role: "secondary" },
        { id: "root-new", path: mainRoot, role: "primary" },
      ],
    }),
    projectTrusted: true,
  };
}

describe("ChatSessionManager resident Engine root migration", () => {
  it("atomically replaces the idle Engine while preserving ChatSession identity and permission state", async () => {
    const oldState = state("acceptEdits");
    const newState = state("default");
    const oldEngine = fakeEngine(oldState);
    const newEngine = fakeEngine(newState);
    const slices: EngineConfigSlice[] = [];
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: (slice) => {
        slices.push({ ...slice });
        return slices.length === 1 ? oldEngine : newEngine;
      },
    });
    const session = await manager.getOrCreate("resident-migrate", {
      cwd: "/repo/old",
      permissionMode: "default",
      customSystemPrompt: "keep-request-override",
      projectTrusted: false,
    } as EngineConfigSlice);
    session.lastActivityAt = 123;
    session.pendingApprovals.set("approval-1", {
      resolve: () => {},
      metadata: {} as never,
    });

    const workspace = await manager.migrateResidentSessionMainRoot(
      "resident-migrate",
      targetAuthority(),
    );

    expect(workspace).toEqual({ root: "/repo/new", kind: "main" });
    expect(manager.get("resident-migrate")).toBe(session);
    expect(session.id).toBe("resident-migrate");
    expect(session.engine).toBe(newEngine);
    expect(session.lastActivityAt).toBe(123);
    expect(session.pendingApprovals.has("approval-1")).toBe(true);
    expect(slices[1]).toMatchObject({
      cwd: "/repo/new",
      permissionMode: "acceptEdits",
      customSystemPrompt: "keep-request-override",
      projectTrusted: true,
      workspaceContext: targetAuthority().workspaceContext,
    });
    expect(oldState.migrations).toEqual([
      {
        sessionId: "resident-migrate",
        project: { projectId: "project-1", mainRootId: "root-new" },
        mainRoot: "/repo/new",
      },
    ]);
    expect(newState.restored).toEqual(["resident-migrate"]);
    expect(newState.mode).toBe("acceptEdits");
    expect(oldState.disposeCalls).toBe(1);

    await session.enqueueTurn("after migration", {});
    expect(newState.runs).toEqual([{ task: "after migration", sessionId: "resident-migrate" }]);
    expect(oldState.runs).toEqual([]);
  });

  it("rejects migration while the Session owns a running turn", async () => {
    const started = deferred();
    const release = deferred();
    const oldState = state();
    const oldEngine = fakeEngine(oldState, {
      run: async (_task, options) => {
        started.resolve();
        await release.promise;
        return result(options.sessionId);
      },
    });
    let factoryCalls = 0;
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        factoryCalls += 1;
        return oldEngine;
      },
    });
    const session = await manager.getOrCreate("running-migrate", {
      cwd: "/repo/old",
    } as EngineConfigSlice);
    const run = session.enqueueTurn("hold", {});
    await started.promise;

    await expect(
      manager.migrateResidentSessionMainRoot("running-migrate", targetAuthority()),
    ).rejects.toThrow("running");
    expect(factoryCalls).toBe(1);
    expect(oldState.migrations).toEqual([]);
    expect(session.engine).toBe(oldEngine);

    release.resolve();
    await run;
  });

  it("keeps the old durable owner when the target Engine factory fails", async () => {
    const oldState = state();
    const oldEngine = fakeEngine(oldState);
    let factoryCalls = 0;
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        factoryCalls += 1;
        if (factoryCalls === 2) throw new Error("target settings are invalid");
        return oldEngine;
      },
    });
    const session = await manager.getOrCreate("factory-failure", {
      cwd: "/repo/old",
    } as EngineConfigSlice);

    await expect(
      manager.migrateResidentSessionMainRoot("factory-failure", targetAuthority()),
    ).rejects.toThrow("target settings are invalid");
    expect(session.engine).toBe(oldEngine);
    expect(oldState.migrations).toEqual([]);
    expect(oldState.disposeCalls).toBe(0);
  });

  it("disposes the uncommitted candidate and retains the old owner when the durable commit fails", async () => {
    const oldState = state();
    const candidateState = state();
    const oldEngine = fakeEngine(oldState, {
      migrate: () => {
        throw new Error("state revision conflict");
      },
    });
    const candidate = fakeEngine(candidateState);
    let factoryCalls = 0;
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => (++factoryCalls === 1 ? oldEngine : candidate),
    });
    const session = await manager.getOrCreate("commit-failure", {
      cwd: "/repo/old",
    } as EngineConfigSlice);

    await expect(
      manager.migrateResidentSessionMainRoot("commit-failure", targetAuthority()),
    ).rejects.toThrow("state revision conflict");
    expect(session.engine).toBe(oldEngine);
    expect(candidateState.disposeCalls).toBe(1);
    expect(oldState.disposeCalls).toBe(0);
  });

  it("re-resolves every project-scoped authority from the target root before the next turn", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "chat-resident-root-migration-"));
    const oldRoot = join(fixture, "old-root");
    const newRoot = join(fixture, "new-root");
    const sessionsDir = join(fixture, "sessions");
    const hookLog = join(fixture, "hooks.log");
    const previousCodeShellHome = process.env.CODE_SHELL_HOME;
    const previousHome = process.env.HOME;
    process.env.CODE_SHELL_HOME = join(fixture, "home");
    process.env.HOME = join(fixture, "home");

    const writeRoot = (root: string, marker: "old" | "new") => {
      mkdirSync(join(root, ".code-shell", "agents"), { recursive: true });
      mkdirSync(join(root, ".code-shell", "skills", `${marker}-skill`), { recursive: true });
      writeFileSync(
        join(root, ".code-shell", "settings.json"),
        JSON.stringify({
          agent: {
            customSystemPrompt: `${marker.toUpperCase()}_SETTINGS_PROMPT`,
            userProfile: `${marker.toUpperCase()}_PROFILE_MARKER`,
          },
          mcpServers: {
            [`${marker}-mcp`]: {
              command: "unused-disabled-mcp",
              enabled: false,
            },
          },
          hooks: [
            {
              event: "on_session_start",
              command: `printf '${marker}\\n' >> ${JSON.stringify(hookLog)}`,
            },
          ],
          env: { ROOT_ENV_MARKER: marker },
          profile: { active: `${marker}-profile`, overrides: {} },
          sources: [
            {
              sourceId: `${marker}-source`,
              scopes: [`${marker}-scope`],
              readPolicy: "ask",
            },
          ],
        }),
      );
      writeFileSync(
        join(root, ".code-shell", "agents", `${marker}-agent.md`),
        `---\nname: ${marker}-agent\ndescription: ${marker.toUpperCase()}_AGENT_MARKER\n---\n${marker} agent\n`,
      );
      writeFileSync(
        join(root, ".code-shell", "skills", `${marker}-skill`, "SKILL.md"),
        `---\nname: ${marker}-skill\ndescription: ${marker.toUpperCase()}_SKILL_MARKER\n---\n${marker} skill\n`,
      );
    };

    try {
      writeRoot(oldRoot, "old");
      writeRoot(newRoot, "new");
      mkdirSync(process.env.CODE_SHELL_HOME, { recursive: true });
      writeFileSync(
        join(process.env.CODE_SHELL_HOME, "sources.json"),
        JSON.stringify({
          version: 1,
          sources: [
            { id: "old-source", kind: "mock", label: "OLD_SOURCE_MARKER", enabled: true },
            { id: "new-source", kind: "mock", label: "NEW_SOURCE_MARKER", enabled: true },
          ],
        }),
      );

      const model = `${authorityProvider}-${Date.now()}-${Math.random()}`;
      const factorySlices: EngineConfigSlice[] = [];
      const engines: Engine[] = [];
      const manager = new ChatSessionManager({
        runtime: {} as never,
        engineFactory: (slice) => {
          factorySlices.push({ ...slice });
          const settings = new SettingsManager(
            slice.cwd!,
            "project",
            slice.projectTrusted !== false,
          ).load();
          const engine = new Engine({
            llm: { provider: authorityProvider, model, apiKey: "test" } as never,
            cwd: slice.cwd,
            workspaceContext: slice.workspaceContext,
            projectTrusted: slice.projectTrusted,
            permissionMode: slice.permissionMode,
            sessionStorageDir: sessionsDir,
            settingsScope: "project",
            headless: true,
            maxTurns: 1,
            sandbox: defaultSandboxConfig("off"),
            mcpServers: settings.mcpServers,
            customSystemPrompt: settings.agent.customSystemPrompt,
            ...personalizationFrom(settings.agent),
          });
          engines.push(engine);
          return engine;
        },
      });
      const oldContext = createWorkspaceContext({
        projectId: "project-real",
        projectRevision: 1,
        sessionMainRootId: "root-old",
        roots: [
          { id: "root-old", path: oldRoot, role: "primary" },
          { id: "root-new", path: newRoot, role: "secondary" },
        ],
      });
      const newContext = createWorkspaceContext({
        projectId: "project-real",
        projectRevision: 2,
        sessionMainRootId: "root-new",
        roots: [
          { id: "root-old", path: oldRoot, role: "secondary" },
          { id: "root-new", path: newRoot, role: "primary" },
        ],
      });
      const session = await manager.getOrCreate("real-authority-migration", {
        cwd: oldRoot,
        workspaceContext: oldContext,
        projectTrusted: false,
        permissionMode: "acceptEdits",
      } as EngineConfigSlice);
      await session.enqueueTurn("first turn", { cwd: oldRoot, workspaceContext: oldContext });
      writeFileSync(hookLog, "");

      await manager.migrateResidentSessionMainRoot("real-authority-migration", {
        project: { projectId: "project-real", mainRootId: "root-new" },
        mainRoot: newRoot,
        workspaceContext: newContext,
        projectTrusted: true,
      });
      rmSync(oldRoot, { recursive: true, force: true });

      const resident = session.engine;
      expect(resident).toBe(engines[1]);
      expect(factorySlices[1]).toMatchObject({
        cwd: newRoot,
        workspaceContext: newContext,
        projectTrusted: true,
        permissionMode: "acceptEdits",
      });
      expect(resident.getConfig()).toMatchObject({
        cwd: newRoot,
        workspaceContext: newContext,
        projectTrusted: true,
        permissionMode: "acceptEdits",
        customSystemPrompt: "NEW_SETTINGS_PROMPT",
        mcpServers: { "new-mcp": { enabled: false } },
      });
      expect(resident.getConfig().mcpServers).not.toHaveProperty("old-mcp");
      expect(resident.readSetting("profile.active")).toBe("new-profile");
      expect(resident.buildToolContext().shellEnv).toEqual({ ROOT_ENV_MARKER: "new" });
      expect(resident.getHookRegistry().listHooks().get("on_session_start")).toEqual([
        expect.stringContaining("new"),
      ]);
      expect(engines[0]!.getHookRegistry().listEvents()).toEqual([]);
      await expect(
        engines[0]!.run("disposed old Engine must not run", {
          sessionId: "real-authority-migration",
        }),
      ).rejects.toThrow("disposed");

      await session.enqueueTurn("second turn", { cwd: newRoot, workspaceContext: newContext });

      expect(readFileSync(hookLog, "utf8")).toBe("new\n");
      const nextTurn = authorityCalls
        .get(model)!
        .findLast((call) => call.systemPrompt.includes("NEW_SETTINGS_PROMPT"))!;
      const nextTurnContext = `${nextTurn.systemPrompt}\n${nextTurn.messages}`;
      expect(nextTurnContext).toContain("NEW_PROFILE_MARKER");
      expect(nextTurnContext).toContain("NEW_SOURCE_MARKER");
      expect(nextTurnContext).toContain("NEW_SKILL_MARKER");
      expect(nextTurnContext).not.toContain("OLD_SETTINGS_PROMPT");
      expect(nextTurnContext).not.toContain("OLD_PROFILE_MARKER");
      expect(nextTurnContext).not.toContain("OLD_SOURCE_MARKER");
      expect(nextTurnContext).not.toContain("OLD_SKILL_MARKER");
      expect(nextTurn.tools).toContain("new-agent");
      expect(nextTurn.tools).not.toContain("old-agent");
    } finally {
      authorityCalls.clear();
      if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = previousCodeShellHome;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 15_000);
});
