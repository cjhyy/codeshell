import { describe, test, expect } from "bun:test";
import {
  MCPManager,
  buildRegisteredTool,
  stripInternalToolArgs,
  readRequiredEnv,
  buildStdioEnv,
  buildHttpHeaders,
  inferTransportType,
} from "./mcp-manager.js";
import { ToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
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

class ReconcileSpyManager extends MCPManager {
  connected = new Set<string>();
  connectCalls: string[] = [];
  disconnectCalls: string[] = [];

  override listServers(): string[] {
    return [...this.connected];
  }

  override async connect(name: string, _config: MCPServerConfig): Promise<void> {
    this.connectCalls.push(name);
    this.connected.add(name);
  }

  override async disconnect(name: string): Promise<void> {
    this.disconnectCalls.push(name);
    this.connected.delete(name);
  }
}

describe("MCPManager.reconcile", () => {
  test("disconnects removed/disabled servers and connects added enabled servers", async () => {
    const m = new ReconcileSpyManager(new ToolRegistry());
    m.connected = new Set(["old", "stay", "disabled"]);

    await m.reconcile({
      stay: cfg("stay"),
      added: cfg("added"),
      disabled: cfg("disabled", { enabled: false }),
    });

    expect(m.disconnectCalls.sort()).toEqual(["disabled", "old"]);
    expect(m.connectCalls.sort()).toEqual(["added", "stay"]);
    expect(m.listServers().sort()).toEqual(["added", "stay"]);
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

/**
 * Codex-style env-secret handling: the MCP config stores the NAME of an env
 * var; the secret value is read from process.env at connect time so it never
 * has to be persisted as plaintext. The env/header building is extracted into
 * pure helpers (buildStdioEnv / buildHttpHeaders) so we can unit-test them
 * without spawning a real transport. Always clean up process.env so tests
 * don't leak across the suite.
 */
describe("readRequiredEnv", () => {
  test("returns the value when the env var is set", () => {
    process.env.MCP_TEST_SECRET = "s3cr3t";
    try {
      expect(readRequiredEnv("srv", "envVars", "MCP_TEST_SECRET")).toBe("s3cr3t");
    } finally {
      delete process.env.MCP_TEST_SECRET;
    }
  });

  test("throws with the exact message format when undefined", () => {
    delete process.env.MCP_TEST_MISSING;
    expect(() => readRequiredEnv("srv", "envVars", "MCP_TEST_MISSING")).toThrow(
      'MCP server "srv": env var "MCP_TEST_MISSING" (from envVars) is not set',
    );
  });

  test("throws when the env var is an empty string", () => {
    process.env.MCP_TEST_EMPTY = "";
    try {
      expect(() => readRequiredEnv("srv", "bearerTokenEnvVar", "MCP_TEST_EMPTY")).toThrow(
        'MCP server "srv": env var "MCP_TEST_EMPTY" (from bearerTokenEnvVar) is not set',
      );
    } finally {
      delete process.env.MCP_TEST_EMPTY;
    }
  });
});

describe("buildStdioEnv", () => {
  test("returns undefined when neither env nor envVars present", () => {
    expect(buildStdioEnv("srv", cfg("srv"))).toBeUndefined();
  });

  test("forwards an envVars-named var from process.env", () => {
    process.env.MCP_FOO = "foo-value";
    try {
      const env = buildStdioEnv("srv", cfg("srv", { envVars: ["MCP_FOO"] }));
      expect(env?.MCP_FOO).toBe("foo-value");
      // process.env is still merged in as the base.
      expect(env?.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.MCP_FOO;
    }
  });

  test("explicit config.env overrides an envVars-forwarded value of the same key", () => {
    process.env.MCP_FOO = "forwarded";
    try {
      const env = buildStdioEnv(
        "srv",
        cfg("srv", { envVars: ["MCP_FOO"], env: { MCP_FOO: "explicit" } }),
      );
      expect(env?.MCP_FOO).toBe("explicit");
    } finally {
      delete process.env.MCP_FOO;
    }
  });

  test("throws when an envVars-named var is missing", () => {
    delete process.env.MCP_MISSING;
    expect(() => buildStdioEnv("srv", cfg("srv", { envVars: ["MCP_MISSING"] }))).toThrow(
      'MCP server "srv": env var "MCP_MISSING" (from envVars) is not set',
    );
  });
});

describe("buildHttpHeaders", () => {
  function httpCfg(name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig {
    return { name, transport: "streamable-http", url: "https://example.com", ...extra };
  }

  test("bearerTokenEnvVar → Authorization: Bearer <value>", () => {
    process.env.MCP_TOKEN = "tok-123";
    try {
      const headers = buildHttpHeaders("srv", httpCfg("srv", { bearerTokenEnvVar: "MCP_TOKEN" }));
      expect(headers.Authorization).toBe("Bearer tok-123");
    } finally {
      delete process.env.MCP_TOKEN;
    }
  });

  test("envHeaders maps header name → env value", () => {
    process.env.MCP_API_KEY = "key-xyz";
    try {
      const headers = buildHttpHeaders(
        "srv",
        httpCfg("srv", { envHeaders: { "X-Api-Key": "MCP_API_KEY" } }),
      );
      expect(headers["X-Api-Key"]).toBe("key-xyz");
    } finally {
      delete process.env.MCP_API_KEY;
    }
  });

  test("env-sourced secrets override static headers of the same name", () => {
    process.env.MCP_TOKEN = "from-env";
    try {
      const headers = buildHttpHeaders(
        "srv",
        httpCfg("srv", {
          headers: { Authorization: "Bearer static" },
          bearerTokenEnvVar: "MCP_TOKEN",
        }),
      );
      expect(headers.Authorization).toBe("Bearer from-env");
    } finally {
      delete process.env.MCP_TOKEN;
    }
  });

  test("missing env var → throws", () => {
    delete process.env.MCP_MISSING;
    expect(() =>
      buildHttpHeaders("srv", httpCfg("srv", { envHeaders: { "X-Api-Key": "MCP_MISSING" } })),
    ).toThrow('MCP server "srv": env var "MCP_MISSING" (from envHeaders) is not set');
  });
});

describe("inferTransportType (url-only configs are HTTP, not stdio)", () => {
  test("url-only (plugin .mcp.json convention) → streamable-http", () => {
    expect(inferTransportType({ name: "s", url: "https://mcp.synta.io/mcp" })).toBe(
      "streamable-http",
    );
  });
  test("explicit transport always wins", () => {
    expect(
      inferTransportType({ name: "s", url: "https://x/mcp", transport: "sse" }),
    ).toBe("sse");
  });
  test("command-only / command+url / neither → stdio", () => {
    expect(inferTransportType({ name: "s", command: "npx" })).toBe("stdio");
    expect(inferTransportType({ name: "s", command: "npx", url: "https://x" })).toBe("stdio");
    expect(inferTransportType({ name: "s" })).toBe("stdio");
  });
});

describe("reconcile shared-pool union (per-session hot-reload must not thrash)", () => {
  class PoolSpy extends MCPManager {
    connected: string[] = [];
    disconnected: string[] = [];
    live: string[] = [];
    override async connect(name: string): Promise<void> {
      this.connected.push(name);
      if (!this.live.includes(name)) this.live.push(name);
    }
    override async disconnect(name: string): Promise<void> {
      this.disconnected.push(name);
      this.live = this.live.filter((n) => n !== name);
    }
    override listServers(): string[] {
      return [...this.live];
    }
  }
  const cfg = (names: string[]): Record<string, MCPServerConfig> =>
    Object.fromEntries(names.map((n) => [n, { name: n, url: `https://${n}/mcp` }]));

  test("another owner's servers survive a narrower reconcile", async () => {
    const pool = new PoolSpy(new ToolRegistry());
    const a = { id: "session-a" };
    const b = { id: "session-b" };
    await pool.connectAll(cfg(["x", "y"]), a); // session A wants x+y
    expect(pool.live.sort()).toEqual(["x", "y"]);

    await pool.reconcile(cfg(["x"]), b); // session B only wants x
    // y is still desired by A — must NOT be disconnected.
    expect(pool.disconnected).toEqual([]);
    expect(pool.live.sort()).toEqual(["x", "y"]);
  });

  test("a server NO owner wants anymore is disconnected", async () => {
    const pool = new PoolSpy(new ToolRegistry());
    const a = { id: "session-a" };
    await pool.connectAll(cfg(["x", "y"]), a);
    await pool.reconcile(cfg(["x"]), a); // A itself drops y; no other owners
    expect(pool.disconnected).toEqual(["y"]);
    expect(pool.live).toEqual(["x"]);
  });

  test("ownerless reconcile keeps the legacy disconnect-stale behavior", async () => {
    const pool = new PoolSpy(new ToolRegistry());
    await pool.connectAll(cfg(["x", "y"]));
    await pool.reconcile(cfg(["x"]));
    expect(pool.disconnected).toEqual(["y"]);
  });
});

describe("executor gate: MCP tool from a server this session didn't enable", () => {
  test("call is rejected with a no-retry error", async () => {
    const registry = new ToolRegistry();
    registry.registerTool({
      name: "mcp_other_srv_doit",
      description: "[other:srv] do it",
      inputSchema: { type: "object", properties: {} },
      source: "mcp",
      serverName: "other:srv",
      handler: async () => ({ ok: true }),
    } as never);
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier({ mode: "bypassPermissions" } as never),
      new HookRegistry(),
    );
    executor.setContext({ allowedMcpServers: new Set(["mine:srv"]) } as never);
    const result = await executor.executeSingle({ id: "c1", toolName: "mcp_other_srv_doit", args: {} } as never);
    expect(result.isError).toBe(true);
    expect(String(result.error)).toContain("not enabled for this project");
  });
});

describe("buildHttpHeaders credentialRef", () => {
  test("resolves credentialRef to a Bearer token via the resolver", () => {
    const headers = buildHttpHeaders(
      "figma",
      { name: "figma", transport: "streamable-http", credentialRef: "my-figma-token" },
      (id) => (id === "my-figma-token" ? "figd_secret" : undefined),
    );
    expect(headers["Authorization"]).toBe("Bearer figd_secret");
  });

  test("missing credential throws a friendly error", () => {
    expect(() =>
      buildHttpHeaders(
        "figma",
        { name: "figma", transport: "streamable-http", credentialRef: "nope" },
        () => undefined,
      ),
    ).toThrow(/credential "nope"/);
  });

  test("no credentialRef behaves as before", () => {
    process.env.MCP_TOKEN = "t";
    const headers = buildHttpHeaders("s", {
      name: "s",
      transport: "streamable-http",
      bearerTokenEnvVar: "MCP_TOKEN",
    });
    expect(headers["Authorization"]).toBe("Bearer t");
  });
});
