import { test, expect } from "bun:test";
globalThis.fetch = (() => { throw new Error("audit denies all network"); }) as typeof fetch;
const { AgentServer } = await import("../../../packages/core/src/protocol/server.ts");
const { AgentClient } = await import("../../../packages/core/src/protocol/client.ts");
const { ChatSessionManager } = await import("../../../packages/core/src/protocol/chat-session-manager.ts");
const { createInProcessTransport } = await import("../../../packages/core/src/protocol/transport.ts");
const { permissionsCommand } = await import("../../../packages/tui/src/cli/commands/builtin/permissions-command.ts");

test("A07 /permissions mutates detached engine and reports live success while session keeps old mode", async () => {
  const created: any[] = [];
  const manager = new ChatSessionManager({
    runtime: {} as any,
    engineFactory: () => {
      let mode = "acceptEdits";
      const engine = {
        getPermissionMode: () => mode,
        setPermissionMode: (value: string) => { mode = value; },
        getConfig: () => ({ permissionMode: mode, llm: { provider: "openai", model: "audit" } }),
        getFeatureFlags: () => ({}), getPermissionRules: () => [],
        setAskUser() {}, setPlanMode() {}, isHeadless: () => false,
        async dispose() {}, async close() {},
      };
      created.push(engine);
      return engine as any;
    },
  });
  const [serverTransport, clientTransport] = createInProcessTransport();
  const server = new AgentServer({ chatManager: manager, transport: serverTransport });
  const client = new AgentClient({ transport: clientTransport });
  try {
    const session = await manager.getOrCreate("audit-live", {} as any);
    const statuses: string[] = [];
    await permissionsCommand.execute("plan", {
      client, sessionId: "audit-live", addStatus: (s: string) => statuses.push(s),
    } as any);
    expect(statuses.join("\n")).toContain("acceptEdits → plan (live)");
    expect(session.engine.getPermissionMode()).toBe("acceptEdits");
    expect(created).toHaveLength(2);
    expect(created[1].getPermissionMode()).toBe("plan");
    expect((await client.query("config", "audit-live")).data).toMatchObject({ permissionMode: "acceptEdits" });
  } finally { await server.close(); client.close(); }
});
