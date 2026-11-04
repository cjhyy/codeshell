import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});
globalThis.fetch = async () => {
  throw Error("network forbidden in review");
};
const { Engine } = await import("../engine/engine.js");
const { EngineRuntime } = await import("../engine/runtime.js");
const { SettingsManager } = await import("../settings/manager.js");
const { ModelPool } = await import("../llm/model-pool.js");
const { ToolRegistry } = await import("../tool-system/registry.js");
const { MCPManager } = await import("../tool-system/mcp-manager.js");
const { ChatSessionManager } = await import("./chat-session-manager.js");
const { AgentServer } = await import("./server.js");
const { resolveConfiguredTextModel } = await import("../engine/configured-text-model.js");
test("model keys resolve the current project connection without changing the shared pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "project-model-review-"));
  const a = join(dir, "a"),
    b = join(dir, "b");
  for (const [cwd, suffix] of [
    [a, "a"],
    [b, "b"],
  ]) {
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(
      join(cwd, ".code-shell/settings.json"),
      JSON.stringify({
        credentials: [{ id: "shared-key", catalogId: "openai", apiKey: "synthetic-" + suffix }],
        modelConnections: [
          {
            id: "openai-1",
            catalogId: "openai",
            tag: "text",
            model: "gpt-4o-mini",
            baseUrl: "https://review-" + suffix + ".invalid/v1",
            credentialId: "shared-key",
          },
        ],
        defaults: { text: "openai-1" },
      }),
    );
  }
  const registry = new ToolRegistry({ builtinTools: [] });
  const runtime = new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: registry,
    settings: new SettingsManager(a, "full"),
    mcpPool: new MCPManager(registry),
    costTracker: {} as any,
    usageStorageDir: join(dir, "usage"),
  });
  runtime.reloadModelsFromSettings();
  const requests: any[] = [];
  const fetchFn = async (input: any, init: any) => {
    const url = String(input);
    if (
      ![
        "https://review-a.invalid/v1/chat/completions",
        "https://review-b.invalid/v1/chat/completions",
      ].includes(url)
    )
      throw Error("Unexpected network " + url);
    requests.push({ url, key: new Headers(init?.headers).get("authorization") });
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"fixture ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const manager = new ChatSessionManager({
    runtime,
    engineFactory: (slice: any) =>
      new Engine({
        runtime,
        llm: runtime.modelPool.resolveLLMConfig()!,
        cwd: slice.cwd,
        headless: true,
        enabledBuiltinTools: [],
        sessionStorageDir: join(dir, "sessions"),
        clientDefaults: { fetch: fetchFn, retryMaxAttempts: 1 },
      }),
  });
  let receive: any;
  const sent: any[] = [];
  new AgentServer({
    transport: {
      send: (v: any) => sent.push(v),
      onMessage: (fn: any) => {
        receive = fn;
      },
      close() {},
    } as any,
    chatManager: manager,
  });
  const request = async (id: number, params: any) => {
    receive({
      jsonrpc: "2.0",
      id,
      method: "agent/run",
      params: { task: "Respond fixture ok", cwd: b, ...params },
    });
    const end = Date.now() + 8000;
    while (!sent.some((v) => v.id === id)) {
      if (Date.now() > end) throw Error("timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    const response = sent.find((v) => v.id === id);
    if (response.error) throw Error(JSON.stringify(response.error));
    expect(response.result.reason).toBe("completed");
  };
  try {
    await request(1, { sessionId: "desktop-b", model: "openai-1" });
    expect(requests[0]).toEqual({
      url: "https://review-b.invalid/v1/chat/completions",
      key: "Bearer synthetic-b",
    });
    await request(2, {
      sessionId: "mobile-b",
      configuredModel: {
        id: "openai-1",
        expectedFingerprint: resolveConfiguredTextModel(b, "openai-1").fingerprint,
      },
    });
    expect(runtime.modelPool.get("openai-1")?.apiKey).toBe("synthetic-a");
    expect(requests.at(-1)).toEqual({
      url: "https://review-b.invalid/v1/chat/completions",
      key: "Bearer synthetic-b",
    });
  } finally {
    await manager.close("desktop-b");
    await manager.close("mobile-b");
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
