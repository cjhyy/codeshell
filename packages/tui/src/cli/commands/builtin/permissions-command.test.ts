import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentClient,
  AgentServer,
  ChatSessionManager,
  createInProcessTransport,
  type PermissionMode,
} from "@cjhyy/code-shell-core";
import type { CommandContext } from "../registry.js";
import { permissionsCommand } from "./permissions-command.js";

// Records the permission mode it was configured with; no model or tools run.
function fakeEngine() {
  let mode: PermissionMode = "acceptEdits";
  return {
    getPermissionMode: () => mode,
    setPermissionMode: (value: PermissionMode) => {
      mode = value;
    },
    getConfig: () => ({ permissionMode: mode, llm: { provider: "openai", model: "fixture" } }),
    getFeatureFlags: () => ({}),
    getPermissionRules: () => [],
    setAskUser() {},
    setPlanMode() {},
    isHeadless: () => false,
    async dispose() {},
    async close() {},
  };
}

describe("/permissions", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function harness() {
    const engines: ReturnType<typeof fakeEngine>[] = [];
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        const engine = fakeEngine();
        engines.push(engine);
        return engine as never;
      },
    });
    const [serverTransport, clientTransport] = createInProcessTransport();
    const server = new AgentServer({ chatManager: manager, transport: serverTransport });
    const client = new AgentClient({ transport: clientTransport });
    cleanups.push(() => client.close());
    cleanups.push(() => server.close());
    return { manager, client, engines };
  }

  test("switches the active session's mode and reports the confirmed mode", async () => {
    const { manager, client } = harness();
    const session = await manager.getOrCreate("live", {} as never);
    const statuses: string[] = [];
    const ctx = {
      client,
      sessionId: "live",
      addStatus: (text: string) => statuses.push(text),
    } as unknown as CommandContext;

    await permissionsCommand.execute("plan", ctx);

    expect(session.engine.getPermissionMode()).toBe("plan");
    expect((await client.query("config", "live")).data).toMatchObject({ permissionMode: "plan" });
    expect(statuses.join("\n")).toContain("acceptEdits → plan");
  });
});
