import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPManager, type McpServerLifecycleEvent } from "./mcp-manager.js";
import { ToolRegistry } from "./registry.js";
import type { MCPServerConfig } from "../types.js";

let directory: string;
let fixture: string;
let sequence = 0;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "codeshell-mcp-startup-"));
  fixture = join(directory, "server.mjs");
  writeFileSync(
    fixture,
    `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [mode, receipt] = process.argv.slice(2);
const attempt = existsSync(receipt) ? readFileSync(receipt, "utf8").trim().split("\\n").length + 1 : 1;
const hang = mode === "timeout" || (mode === "recover" && attempt === 1);
const descendant = hang ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : undefined;
appendFileSync(receipt, JSON.stringify({ pid: process.pid, descendant: descendant?.pid }) + "\\n");
if (hang) setInterval(() => {}, 1000);
const lines = createInterface({ input: process.stdin });
lines.on("close", () => { if (!hang) process.exit(0); });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (hang || request.id === undefined) return;
  if (mode === "malformed") { process.stdout.write("invalid-json\\n"); return; }
  if (request.method === "tools/list" && (mode === "discovery_timeout" || (mode === "discovery_recover" && attempt === 1))) {
    appendFileSync(receipt + ".discovering", "waiting\\n");
    return;
  }
  if (mode === "invalid" || (mode === "discovery_invalid" && request.method === "tools/list")) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32600, message: "server-secret-must-not-enter-health" } }) + "\\n");
    return;
  }
  let result;
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: "fixture", version: "1" }
  };
  else if (request.method === "tools/list") result = { tools: [{ name: "read", inputSchema: { type: "object", properties: {} } }] };
  else if (request.method === "tools/call") {
    appendFileSync(receipt + ".calls", "called\\n");
    result = { content: [{ type: "text", text: "ok" }] };
  }
  else result = {};
  const respond = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  if (mode === "slow" && request.method === "initialize") setTimeout(respond, 150);
  else respond();
});
`,
  );
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function setup(mode: string, extra: Partial<MCPServerConfig> = {}) {
  const receipt = join(directory, `attempt-${++sequence}.jsonl`);
  const registry = new ToolRegistry({ builtinTools: [] });
  const manager = new MCPManager(registry);
  const config: MCPServerConfig = {
    name: "fixture",
    command: process.execPath,
    args: [fixture, mode, receipt],
    connectTimeoutMs: 300,
    ...extra,
  };
  return { receipt, registry, manager, config };
}

function attempts(receipt: string): Array<{ pid: number; descendant?: number }> {
  try {
    return readFileSync(receipt, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function started(receipt: string) {
  const deadline = Date.now() + 2_000;
  while (!attempts(receipt).length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(attempts(receipt)).toHaveLength(1);
}
async function discovering(receipt: string) {
  const deadline = Date.now() + 2_000;
  while (!existsSync(`${receipt}.discovering`) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(`${receipt}.discovering`)).toBe(true);
}

describe("bounded MCP initialization", () => {
  test("retries one timed-out handshake only after wrapper and descendant exit", async () => {
    const { receipt, registry, manager, config } = setup("recover");
    try {
      await manager.connect("fixture", config);
      const records = attempts(receipt);
      expect(records).toHaveLength(2);
      expect(alive(records[0].pid)).toBe(false);
      expect(alive(records[0].descendant!)).toBe(false);
      expect(registry.hasTool("mcp_fixture_read")).toBe(true);
      // Initialization never replays a tool call.
      expect(existsSync(`${receipt}.calls`)).toBe(false);
    } finally {
      await manager.disconnectAll();
    }
    for (const record of attempts(receipt)) expect(alive(record.pid)).toBe(false);
  });

  test("exhaustion is bounded and leaves no initialized tools or process tree", async () => {
    const { receipt, registry, manager, config } = setup("timeout", { connectRetries: 2 });
    const events: McpServerLifecycleEvent[] = [];
    try {
      await manager.connectAll({ fixture: config }, undefined, (event) => events.push(event));
      expect(attempts(receipt)).toHaveLength(3);
      expect(events).toHaveLength(1);
      expect(events[0].error).toContain("attempt 3");
      expect(events[0].error).toContain("spawned");
      expect(registry.hasTool("mcp_fixture_read")).toBe(false);
      for (const record of attempts(receipt)) {
        expect(alive(record.pid)).toBe(false);
        expect(alive(record.descendant!)).toBe(false);
      }
    } finally {
      await manager.disconnectAll();
    }
  });

  test("protocol failures are not retried and server errors do not enter health text", async () => {
    const { receipt, manager, config } = setup("invalid");
    const events: McpServerLifecycleEvent[] = [];
    try {
      await manager.connectAll({ fixture: config }, undefined, (event) => events.push(event));
      expect(attempts(receipt)).toHaveLength(1);
      expect(events[0].type).toBe("mcp_server_failed");
      expect(events[0].error).not.toContain("server-secret");
      expect(alive(attempts(receipt)[0].pid)).toBe(false);
    } finally {
      await manager.disconnectAll();
    }
  });

  test("malformed protocol frames fail immediately without timeout retries", async () => {
    const { receipt, manager, config } = setup("malformed", { connectTimeoutMs: 5_000 });
    try {
      const began = Date.now();
      await expect(manager.connect("fixture", config)).rejects.toThrow();
      expect(Date.now() - began).toBeLessThan(2_000);
      expect(attempts(receipt)).toHaveLength(1);
      expect(alive(attempts(receipt)[0].pid)).toBe(false);
    } finally {
      await manager.disconnectAll();
    }
  });

  test("post-handshake discovery failure cleans up without publishing tools or retrying", async () => {
    const { receipt, registry, manager, config } = setup("discovery_invalid");
    try {
      await expect(manager.connect("fixture", config)).rejects.toThrow();
      expect(attempts(receipt)).toHaveLength(1);
      expect(alive(attempts(receipt)[0].pid)).toBe(false);
      expect(manager.listServers()).toEqual([]);
      expect(registry.hasTool("mcp_fixture_read")).toBe(false);
    } finally {
      await manager.disconnectAll();
    }
  });

  test("tool discovery is inside the startup deadline and retries without publishing partial tools", async () => {
    const { receipt, registry, manager, config } = setup("discovery_recover");
    const connection = manager.connect("fixture", config);
    try {
      await discovering(receipt);
      expect(manager.listServers()).toEqual([]);
      expect(registry.hasTool("mcp_fixture_read")).toBe(false);
      await connection;
      expect(attempts(receipt)).toHaveLength(2);
      expect(alive(attempts(receipt)[0].pid)).toBe(false);
      expect(registry.hasTool("mcp_fixture_read")).toBe(true);
    } finally {
      await manager.disconnectAll();
    }
  });

  test("cancel during tools/list cleans startup promptly without retrying", async () => {
    const { receipt, registry, manager, config } = setup("discovery_timeout", {
      connectTimeoutMs: 5_000,
    });
    const abort = new AbortController();
    const result = manager
      .connect("fixture", config, { cwd: directory, signal: abort.signal })
      .then(
        () => undefined,
        (error) => error,
      );
    await discovering(receipt);
    const cancelledAt = Date.now();
    abort.abort();
    expect((await result)?.name).toBe("AbortError");
    expect(Date.now() - cancelledAt).toBeLessThan(2_000);
    expect(attempts(receipt)).toHaveLength(1);
    expect(alive(attempts(receipt)[0].pid)).toBe(false);
    expect(manager.listServers()).toEqual([]);
    expect(registry.hasTool("mcp_fixture_read")).toBe(false);
    await manager.disconnectAll();
  });

  test("cancellation cleans a pending process and suppresses retries", async () => {
    const { receipt, manager, config } = setup("timeout", { connectTimeoutMs: 5_000 });
    const abort = new AbortController();
    const result = manager
      .connect("fixture", config, { cwd: directory, signal: abort.signal })
      .then(
        () => undefined,
        (error) => error,
      );
    await started(receipt);
    abort.abort();
    expect((await result)?.name).toBe("AbortError");
    expect(attempts(receipt)).toHaveLength(1);
    expect(alive(attempts(receipt)[0].pid)).toBe(false);
    expect(alive(attempts(receipt)[0].descendant!)).toBe(false);
    await manager.disconnectAll();
  });

  test("one cancelled waiter does not cancel a same-scope caller", async () => {
    const { receipt, manager, config } = setup("slow", { connectTimeoutMs: 2_000 });
    const abort = new AbortController();
    const first = manager.connect("fixture", config, { cwd: directory, signal: abort.signal }).then(
      () => undefined,
      (error) => error,
    );
    const second = manager.connect("fixture", config, { cwd: directory });
    try {
      await started(receipt);
      abort.abort();
      expect((await first)?.name).toBe("AbortError");
      await second;
      expect(attempts(receipt)).toHaveLength(1);
      expect(manager.listServers()).toEqual(["fixture"]);
    } finally {
      await manager.disconnectAll();
    }
  });

  test("closing the initiating owner retains a peer's coalesced authority", async () => {
    const { receipt, manager, config } = setup("slow", { connectTimeoutMs: 2_000 });
    const firstOwner = {};
    const secondOwner = {};
    const first = manager.connectAll({ fixture: config }, firstOwner, undefined, {
      cwd: directory,
    });
    const second = manager.connectAll({ fixture: config }, secondOwner, undefined, {
      cwd: directory,
    });
    try {
      await started(receipt);
      await manager.unregisterOwner(firstOwner);
      await Promise.all([first, second]);
      expect(attempts(receipt)).toHaveLength(1);
      expect(manager.listServers()).toEqual(["fixture"]);
    } finally {
      await manager.disconnectAll();
    }
  });

  test("closing the last owner reaps only that workspace's pending transport", async () => {
    const first = setup("timeout", { connectTimeoutMs: 5_000 });
    const secondReceipt = join(directory, `attempt-${++sequence}.jsonl`);
    const firstOwner = {};
    const secondOwner = {};
    const a = first.manager.connectAll({ fixture: first.config }, firstOwner, undefined, {
      cwd: directory,
    });
    const b = first.manager.connectAll(
      {
        fixture: {
          ...first.config,
          args: [fixture, "slow", secondReceipt],
        },
      },
      secondOwner,
      undefined,
      { cwd: tmpdir() },
    );
    try {
      await started(first.receipt);
      await first.manager.unregisterOwner(firstOwner);
      await Promise.all([a, b]);
      expect(attempts(first.receipt)).toHaveLength(1);
      expect(alive(attempts(first.receipt)[0].descendant!)).toBe(false);
      expect(alive(attempts(secondReceipt)[0].pid)).toBe(true);
    } finally {
      await first.manager.disconnectAll();
    }
  });

  test("an owner's new workspace cannot publish its superseded pending scope", async () => {
    const { receipt, manager, config } = setup("slow", { connectTimeoutMs: 2_000 });
    const secondReceipt = join(directory, `attempt-${++sequence}.jsonl`);
    const owner = {};
    const firstContext = { cwd: directory };
    const secondContext = { cwd: tmpdir() };
    const first = manager.connectAll({ fixture: config }, owner, undefined, firstContext);
    try {
      await started(receipt);
      await manager.connectAll(
        { fixture: { ...config, args: [fixture, "slow", secondReceipt] } },
        owner,
        undefined,
        secondContext,
      );
      await first;
      expect(alive(attempts(receipt)[0].pid)).toBe(false);
      expect(alive(attempts(secondReceipt)[0].pid)).toBe(true);
      expect(() => MCPManager.forContext(firstContext)).toThrow("no longer active");
      expect(MCPManager.forContext(secondContext)).toBe(manager);
    } finally {
      await manager.disconnectAll();
    }
  });

  test("disconnect stops a pending initialization before returning", async () => {
    const { receipt, manager, config } = setup("timeout", { connectTimeoutMs: 5_000 });
    const result = manager.connect("fixture", config).then(
      () => undefined,
      (error) => error,
    );
    await started(receipt);
    await manager.disconnect("fixture");
    expect((await result)?.name).toBe("AbortError");
    expect(attempts(receipt)).toHaveLength(1);
    expect(alive(attempts(receipt)[0].descendant!)).toBe(false);
    await manager.disconnectAll();
  });

  test("direct SDK config obeys bounds without spawning", async () => {
    const { receipt, manager, config } = setup("timeout", { connectRetries: 3 });
    await expect(manager.connect("fixture", config)).rejects.toThrow("connectRetries");
    expect(attempts(receipt)).toHaveLength(0);
    await manager.disconnectAll();
  });
});
