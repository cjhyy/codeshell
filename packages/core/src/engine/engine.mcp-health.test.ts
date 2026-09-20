import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-engine-mcp-health";
const requests = new Map<string, Message[][]>();

class McpHealthClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    requests.get(this.model)!.push(structuredClone(options.messages));
    const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
    this.recordUsage(usage, options);
    return { text: "Acknowledged.", toolCalls: [], stopReason: "stop", usage };
  }
}

registerProvider(provider, McpHealthClient);

describe("Engine per-run MCP health context", () => {
  it("reports initialization failure to the model without persisting it or leaking it after recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-mcp-health-"));
    const readyFile = join(dir, "ready");
    const server = join(dir, "server.mjs");
    const model = `${provider}-${crypto.randomUUID()}`;
    const sessionId = "s-mcp-health-recovery";
    requests.set(model, []);
    // Exercise the real MCP connection path. The same server configuration
    // fails on the first run, then successfully initializes after repair.
    writeFileSync(
      server,
      `
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
if (!existsSync(process.argv[2])) process.exit(2);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize" ? {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "health-fixture", version: "1" }
  } : request.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
    );
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      settingsScope: "isolated",
      enabledBuiltinTools: [],
      maxTurns: 3,
      headless: true,
      permissionMode: "bypassPermissions",
      mcpServers: {
        "repairable-fixture": {
          name: "repairable-fixture",
          transport: "stdio",
          command: process.execPath,
          args: [server, readyFile],
          connectTimeoutMs: 2_000,
          connectRetries: 0,
        },
      },
    });
    (engine as any).hooks.clear();
    const transcript = () =>
      readFileSync(join(dir, "sessions", sessionId, "transcript.jsonl"), "utf8");
    const state = () => readFileSync(join(dir, "sessions", sessionId, "state.json"), "utf8");

    try {
      expect(
        (await engine.run("Inspect available capabilities.", { sessionId, cwd: dir })).reason,
      ).toBe("completed");
      const first = JSON.stringify(requests.get(model)![0]);
      expect(first).toContain("MCP connection status for this run:");
      expect(first).toContain("repairable-fixture");
      expect(first).toContain("tools are unavailable in this run");
      expect(transcript()).not.toContain("MCP connection status for this run:");
      expect(state()).not.toContain("MCP connection status for this run:");

      writeFileSync(readyFile, "ready");
      requests.set(model, []);
      expect(
        (await engine.run("Try the repaired capabilities.", { sessionId, cwd: dir })).reason,
      ).toBe("completed");
      const recovered = JSON.stringify(requests.get(model)![0]);
      expect(recovered).toContain("Inspect available capabilities.");
      expect(recovered).not.toContain("MCP connection status for this run:");
      expect(recovered).not.toContain("tools are unavailable in this run");
      expect(transcript()).not.toContain("MCP connection status for this run:");
      expect(state()).not.toContain("MCP connection status for this run:");
    } finally {
      await engine.dispose();
      requests.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
