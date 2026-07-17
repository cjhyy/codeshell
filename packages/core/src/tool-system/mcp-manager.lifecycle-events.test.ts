import { describe, expect, test } from "bun:test";
import { MCPManager, type McpServerLifecycleEvent } from "./mcp-manager.js";
import { ToolRegistry } from "./registry.js";

describe("MCPManager connectAll lifecycle events", () => {
  test("a spawn-failing stdio server reports mcp_server_failed to the observer", async () => {
    const manager = new MCPManager(new ToolRegistry({ builtinTools: [] }));
    const events: McpServerLifecycleEvent[] = [];

    await manager.connectAll(
      {
        broken: {
          name: "broken",
          command: "/nonexistent-codeshell-test-binary",
          args: [],
          transport: "stdio",
        },
      },
      undefined,
      (event) => events.push(event),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("mcp_server_failed");
    expect(events[0].server).toBe("broken");
    expect(events[0].error).toBeTruthy();
    await manager.disconnectAll();
  });

  test("servers disabled in settings emit nothing", async () => {
    const manager = new MCPManager(new ToolRegistry({ builtinTools: [] }));
    const events: McpServerLifecycleEvent[] = [];
    await manager.connectAll(
      { off: { name: "off", command: "/bin/echo", transport: "stdio", enabled: false } },
      undefined,
      (event) => events.push(event),
    );
    expect(events).toEqual([]);
    await manager.disconnectAll();
  });
});
