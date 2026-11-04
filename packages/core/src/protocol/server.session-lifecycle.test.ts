import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session/session-manager.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { Engine } from "../engine/engine.js";
import { EngineRuntime } from "../engine/runtime.js";
import { ModelPool } from "../llm/model-pool.js";
import { SettingsManager } from "../settings/manager.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { CostTracker } from "../cost-tracker.js";
import { hasPendingRunStarts } from "./run-start-claims.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (f()) return;
    await delay(5);
  }
  throw new Error("fixture did not settle");
}

test("close cancels a cold Goal resume waiting on migration before it can reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-close-race-"));
  const storage = join(dir, "sessions");
  const sid = "cold-goal-close";
  const disk = new SessionManager(storage);
  const bundle = disk.create(dir, "fake", "fake", sid);
  bundle.state.activeGoal = {
    objective: "finish private task",
    goalId: "goal-1",
    revision: 1,
    paused: true,
  };
  disk.saveState(bundle.state);
  let created = 0;
  const runs: string[] = [];
  const manager = new ChatSessionManager({
    runtime: {} as never,
    sessionStorageDir: storage,
    engineFactory: (_slice) => {
      ++created;
      const sessions = new SessionManager(storage);
      return {
        sessionExistsOnDisk: (id: string) => sessions.exists(id),
        getSessionManager: () => sessions,
        isHeadless: () => false,
        restoreSessionModel() {},
        setAskUser() {},
        setBrowserBridge() {},
        setInjectCredential() {},
        setSessionMessageRouter() {},
        getGoal: (id: string) => sessions.readActiveGoal(id),
        async dispose() {},
        async run() {
          runs.push(sid);
          return {
            text: "ran",
            reason: "completed",
            sessionId: sid,
            turnCount: 1,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          };
        },
      } as unknown as Engine;
    },
  });
  const replies: any[] = [];
  let deliver: (m: any) => void = () => {};
  const server = new AgentServer({
    transport: {
      send: (m) => replies.push(m),
      onMessage: (cb) => {
        deliver = cb;
      },
      close() {},
    },
    chatManager: manager,
    ownsBackgroundWakeups: false,
    notificationMailbox: new NotificationQueue(),
    readActiveGoalFromDisk: (id) => disk.readActiveGoal(id),
    updateActiveGoalOnDisk: (id, patch) => disk.updateActiveGoal(id, patch)?.goal,
  });
  manager.beginSessionMigration(sid, "fixture-migration");
  try {
    deliver({
      jsonrpc: "2.0",
      id: "resume",
      method: "agent/goalUpdate",
      params: { sessionId: sid, paused: false, expectedGoalId: "goal-1", expectedRevision: 1 },
    });
    await until(() => hasPendingRunStarts(manager, sid));
    deliver({
      jsonrpc: "2.0",
      id: "close",
      method: "agent/closeSession",
      params: { sessionId: sid },
    });
    await until(() => replies.some((m) => m.id === "close"));
    expect(replies.find((m) => m.id === "close")?.result).toEqual({ ok: true });
    expect(manager.isClosed(sid)).toBe(true);
    expect(runs).toHaveLength(0);
    manager.completeSessionMigration(sid, "fixture-migration");
    await until(() => !hasPendingRunStarts(manager, sid));
    expect(manager.isClosed(sid)).toBe(true);
    expect(manager.get(sid)).toBeUndefined();
    expect(runs).toHaveLength(0);
    expect(created).toBe(0);
  } finally {
    manager.completeSessionMigration(sid, "fixture-migration");
    server.disconnect();
    await manager.closeAllAsync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existence probes read metadata without activating Engines or modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-engine-leak-"));
  const registry = new ToolRegistry({ builtinTools: [] });
  const runtime = new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: registry,
    settings: new SettingsManager(dir, "isolated"),
    mcpPool: new MCPManager(registry),
    costTracker: new CostTracker(),
  });
  let activeResources = 0;
  const created: Engine[] = [];
  const manager = new ChatSessionManager({
    runtime,
    sessionStorageDir: join(dir, "sessions"),
    engineFactory: (slice) => {
      const engine = new Engine({
        llm: { provider: "openai", model: "unused", apiKey: "synthetic" },
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        settingsScope: "isolated",
        mcpServers: {},
        runtime,
        isSubAgent: true,
        modules: [
          {
            id: "probe-resource",
            activateEngine(ctx) {
              activeResources++;
              ctx.own(() => {
                activeResources--;
              });
            },
          },
        ],
        ...slice,
      });
      created.push(engine);
      return engine;
    },
  });
  try {
    for (let i = 0; i < 5; i++)
      expect(manager.sessionExistsOnDisk("missing", { cwd: dir })).toBe(false);
    await Promise.all(created.map((engine) => engine.ready()));
    expect(manager.sessionCount()).toBe(0);
    expect(activeResources).toBe(0);
    await manager.closeAllAsync();
    expect(activeResources).toBe(0);
    expect((runtime as any).engines.size).toBe(0);
    await runtime.close();
    expect(activeResources).toBe(0);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
