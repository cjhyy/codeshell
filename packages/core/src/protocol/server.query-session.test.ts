import { describe, expect, test } from "bun:test";
import type { Engine } from "../engine/engine.js";
import type { EngineConfigSlice } from "./chat-session-manager.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentClient } from "./client.js";
import { AgentServer } from "./server.js";
import { createInProcessTransport } from "./transport.js";

function fakeEngine(slice: EngineConfigSlice): Engine {
  const marker = slice.cwd ?? "global";
  const permissionMode = marker === "/project-b" ? "plan" : "default";
  return {
    planMode: permissionMode === "plan",
    setAskUser() {},
    setPlanMode() {},
    setPermissionMode() {},
    isHeadless: () => false,
    getToolRegistry: () => ({
      listToolsDetailed: () => [{ name: `tool:${marker}`, description: marker }],
    }),
    getConfig: () => ({
      cwd: marker,
      permissionMode,
      llm: { provider: "noop", model: `model:${marker}` },
    }),
    getFeatureFlags: () => ({ [`feature:${marker}`]: true }),
    getPermissionRules: () => [{ tool: `tool:${marker}`, decision: "allow" }],
  } as unknown as Engine;
}

describe("AgentServer session-scoped queries", () => {
  test("tools and config resolve the requested session instead of the first live engine", async () => {
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: fakeEngine,
    });
    await manager.getOrCreate("session-a", { cwd: "/project-a" } as EngineConfigSlice);
    await manager.getOrCreate("session-b", { cwd: "/project-b" } as EngineConfigSlice);

    const [serverTransport, clientTransport] = createInProcessTransport();
    const server = new AgentServer({ transport: serverTransport, chatManager: manager });
    const client = new AgentClient({ transport: clientTransport });

    const tools = await client.query("tools", "session-b");
    expect(tools.data).toEqual([{ name: "tool:/project-b", description: "/project-b" }]);

    const config = await client.query("config", "session-b");
    expect(config.data).toMatchObject({
      cwd: "/project-b",
      model: "model:/project-b",
      permissionMode: "plan",
      planMode: true,
      featureFlags: { "feature:/project-b": true },
    });

    server.close();
  });

  test("a global query uses a detached neutral engine, not a live project's policy", async () => {
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: fakeEngine,
    });
    await manager.getOrCreate("session-b", { cwd: "/project-b" } as EngineConfigSlice);

    const [serverTransport, clientTransport] = createInProcessTransport();
    const server = new AgentServer({ transport: serverTransport, chatManager: manager });
    const client = new AgentClient({ transport: clientTransport });

    const config = await client.query("config");
    expect(config.data).toMatchObject({
      cwd: "global",
      model: "model:global",
      permissionMode: "default",
      planMode: false,
    });

    server.close();
  });
});
