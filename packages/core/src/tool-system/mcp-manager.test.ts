import { describe, test, expect } from "bun:test";
import { MCPManager, buildRegisteredTool, stripInternalToolArgs } from "./mcp-manager.js";
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

/**
 * #5: concurrent connect(name) calls for the SAME server must collapse to a
 * SINGLE underlying handshake. The broadcast config reload fans connectAll out
 * across K sessions onto one shared pool; without coalescing each would start a
 * fresh handshake (connections.has() only flips true after the handshake
 * completes). We spy on the protected performConnect (the real handshake) and
 * keep it pending so both connect() calls overlap.
 */
class CoalesceSpyManager extends MCPManager {
  performCalls: string[] = [];
  private releaseFns: Array<() => void> = [];
  protected override async performConnect(name: string, _config: MCPServerConfig): Promise<void> {
    this.performCalls.push(name);
    // Stay pending until released so the second connect() overlaps with this one.
    await new Promise<void>((resolve) => this.releaseFns.push(resolve));
  }
  releaseAll(): void {
    for (const fn of this.releaseFns) fn();
    this.releaseFns = [];
  }
}

describe("MCPManager.connect coalescing (#5)", () => {
  test("two concurrent connect(name) → ONE underlying handshake", async () => {
    const m = new CoalesceSpyManager(new ToolRegistry());
    const p1 = m.connect("srv", cfg("srv"));
    const p2 = m.connect("srv", cfg("srv"));
    // Only one handshake started despite two overlapping connect() calls.
    expect(m.performCalls).toEqual(["srv"]);
    m.releaseAll();
    await Promise.all([p1, p2]);
    expect(m.performCalls).toEqual(["srv"]);
  });

  test("two concurrent connectAll for the same added server → ONE handshake", async () => {
    const m = new CoalesceSpyManager(new ToolRegistry());
    // Simulate K=2 sessions each calling connectAll for the same server.
    const p1 = m.connectAll({ srv: cfg("srv") });
    const p2 = m.connectAll({ srv: cfg("srv") });
    expect(m.performCalls).toEqual(["srv"]);
    m.releaseAll();
    await Promise.all([p1, p2]);
    expect(m.performCalls).toEqual(["srv"]);
  });

  test("after the in-flight connect resolves, a later connect can retry", async () => {
    const m = new CoalesceSpyManager(new ToolRegistry());
    const p1 = m.connect("srv", cfg("srv"));
    expect(m.performCalls).toEqual(["srv"]);
    m.releaseAll();
    await p1;
    // performConnect (the spy) never populates `connections`, so a fresh
    // connect re-runs the handshake — proving the inflight map was cleared.
    const p2 = m.connect("srv", cfg("srv"));
    expect(m.performCalls).toEqual(["srv", "srv"]);
    m.releaseAll();
    await p2;
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

  test("sanitizes server and MCP tool names for OpenAI function names", () => {
    const t = buildRegisteredTool("chrome-devtools:chrome-devtools", {
      name: "take-screenshot.v1",
      inputSchema: { type: "object" },
    });
    expect(t.name).toBe("mcp_chrome-devtools_chrome-devtools_take-screenshot_v1");
  });
});

describe("stripInternalToolArgs", () => {
  test("removes executor-only signal before forwarding MCP arguments", () => {
    const ac = new AbortController();
    expect(stripInternalToolArgs({ __signal: ac.signal, value: 1 })).toEqual({ value: 1 });
  });

  test("returns empty args for no-argument MCP tools", () => {
    const ac = new AbortController();
    expect(stripInternalToolArgs({ __signal: ac.signal })).toEqual({});
  });
});
