import { describe, test, expect } from "bun:test";
import { MCPManager, buildRegisteredTool } from "./mcp-manager.js";
import { ToolRegistry } from "./registry.js";
import type { MCPServerConfig } from "../types.js";

/**
 * connectAll's enabled-toggle filter. We don't spin up a real transport;
 * instead we spy on connect() (the only thing connectAll calls per entry)
 * and assert which server names reach it. This locks the Codex-style
 * `enabled: false` skip — and, by extension, the contract the Electron
 * worker depends on: every server NOT disabled must be handed to connect().
 */
class SpyManager extends MCPManager {
  connectCalls: string[] = [];
  override async connect(name: string, _config: MCPServerConfig): Promise<void> {
    this.connectCalls.push(name);
  }
}

function cfg(name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { name, transport: "stdio", command: "true", ...extra };
}

describe("MCPManager.connectAll enabled filter", () => {
  test("connects servers with enabled absent / true", async () => {
    const m = new SpyManager(new ToolRegistry());
    await m.connectAll({
      a: cfg("a"), // enabled absent → connect
      b: cfg("b", { enabled: true }), // explicit true → connect
    });
    expect(m.connectCalls.sort()).toEqual(["a", "b"]);
  });

  test("skips servers with enabled === false", async () => {
    const m = new SpyManager(new ToolRegistry());
    await m.connectAll({
      on: cfg("on"),
      off: cfg("off", { enabled: false }),
    });
    expect(m.connectCalls).toEqual(["on"]);
  });

  test("all-disabled resolves without connecting any", async () => {
    const m = new SpyManager(new ToolRegistry());
    await m.connectAll({
      x: cfg("x", { enabled: false }),
      y: cfg("y", { enabled: false }),
    });
    expect(m.connectCalls).toEqual([]);
  });
});

describe("buildRegisteredTool readOnlyHint", () => {
  test("readOnlyHint=true → concurrency-safe + read-only", () => {
    const t = buildRegisteredTool("srv", {
      name: "search",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
    expect(t.name).toBe("mcp_srv_search");
    expect(t.isConcurrencySafe).toBe(true);
    expect(t.isReadOnly).toBe(true);
    expect(t.permissionDefault).toBe("ask");
  });

  test("missing annotations → conservative defaults", () => {
    const t = buildRegisteredTool("srv", {
      name: "write",
      inputSchema: { type: "object" },
    });
    expect(t.isConcurrencySafe).toBe(false);
    expect(t.isReadOnly).toBe(false);
  });
});
