import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { EngineRuntime } from "./runtime.js";
import { ModelPool } from "../llm/model-pool.js";
import { SettingsManager } from "../settings/manager.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { viewImageTool } from "../tool-system/builtin/view-image.js";
import type { LLMConfig } from "../types.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "current-model-"));
  fixtures.push(cwd);
  return cwd;
}

describe("shared current model configuration", () => {
  test("an inherited child/SDK snapshot does not require ownership of the parent's pool", async () => {
    const cwd = fixture();
    const pool = new ModelPool([
      {
        key: "parent-only",
        provider: "openai",
        model: "future",
        supportsVision: true,
        apiKey: "fixture-only",
        baseUrl: "http://child-model.invalid/v1",
      },
    ]);
    for (const isSubAgent of [false, true]) {
      const engine = new Engine({
        llm: pool.resolveLLMConfig()!,
        isSubAgent,
        cwd,
        sessionStorageDir: join(cwd, "sessions"),
        enabledBuiltinTools: [],
        clientDefaults: {
          fetch: async (input) => {
            expect(String(input)).toBe("http://child-model.invalid/v1/chat/completions");
            return new Response(
              'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      });
      (engine as any).hooks.clear();
      try {
        expect(engine.buildToolContext().llmConfig.model).toBe("future");
        expect(engine.buildToolContext().llmConfig.supportsVision).toBe(true);
        expect((await engine.run("check fixture")).text).toBe("ok");
      } finally {
        await engine.dispose();
      }
    }
  });
  test("A to B replaces all model metadata and leaves permissions unchanged", async () => {
    const cwd = fixture();
    const engine = new Engine({
      llm: { provider: "openai", model: "seed" },
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      enabledBuiltinTools: [],
      permissionMode: "default",
    });
    const pool = engine.getModelPool();
    pool.register({
      key: "a",
      provider: "openai",
      providerKind: "openrouter",
      model: "openai/gpt-6.1-sol",
      supportsVision: true,
      maxOutputTokens: 1234,
      extraBody: { temperature: 0.8 },
    });
    pool.register({
      key: "b",
      provider: "openai",
      providerKind: "openrouter",
      model: "openai/gpt-5.6-sol",
      supportsVision: false,
    });
    try {
      engine.switchModel("a", { persist: false });
      const a = engine.buildToolContext();
      expect(a.llmConfig.supportsVision).toBe(true);
      engine.switchModel("b", { persist: false });
      const b = engine.buildToolContext();
      expect(b.llmConfig.supportsVision).toBe(false);
      expect(b.llmConfig.maxTokens).toBeUndefined();
      expect(b.llmConfig.extraBody).toBeUndefined();
      expect(a.llmConfig.model).toBe("openai/gpt-6.1-sol");
      expect(b.permissionMode).toBe(a.permissionMode);
      expect(engine.getPermissionMode()).toBe("default");
      pool.register({ key: "b", provider: "openai", model: "future" });
      expect(engine.buildToolContext().llmConfig.model).toBe("future");
      expect(engine.buildToolContext().llmConfig.supportsVision).toBeUndefined();
      pool.clear();
      expect(() => engine.buildToolContext()).toThrow("no longer configured");
    } finally {
      await engine.dispose();
    }
  });

  test("catalog and connection hot reload reach every tool and the actual request at the next run", async () => {
    const cwd = fixture();
    const home = fixture();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const registry = new ToolRegistry({ builtinTools: [] });
    const mcpPool = new MCPManager(registry);
    const runtime = new EngineRuntime({
      modelPool: new ModelPool(),
      toolRegistry: registry,
      settings: new SettingsManager(cwd, "project"),
      mcpPool,
      costTracker: {} as never,
      usageStorageDir: join(cwd, "usage"),
    });
    const catalogFile = join(home, ".code-shell", "model-catalog.user.json");
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    const save = (model: string, supportsVision?: boolean) => {
      writeFileSync(
        catalogFile,
        JSON.stringify([
          {
            id: "fixture",
            tag: "text",
            adapterKind: "openrouter",
            protocol: "openai-compat",
            displayName: "fixture",
            description: "fixture",
            defaultBaseUrl: "http://current-model.invalid/v1",
            needsKey: false,
            modelPresets: [{ value: model, supportsVision }],
          },
        ]),
      );
      writeFileSync(
        join(cwd, ".code-shell", "settings.json"),
        JSON.stringify({
          credentials: [{ id: "fixture-key", catalogId: "fixture", apiKey: "fixture-only" }],
          modelConnections: [
            {
              id: "selected",
              catalogId: "fixture",
              tag: "text",
              model,
              credentialId: "fixture-key",
            },
          ],
          defaults: { text: "selected" },
        }),
      );
      runtime.reloadModelsFromSettings();
    };
    save("openai/gpt-6.1-sol", true);
    const standalone = new Engine({
      llm: runtime.modelPool.resolveLLMConfig()!,
      cwd,
      sessionStorageDir: join(cwd, "standalone-sessions"),
      enabledBuiltinTools: [],
    });
    const bodies: any[] = [];
    const contexts: LLMConfig[] = [];
    let requestInRun = 0;
    let duringRequest: (() => void) | undefined;
    const imagePath = join(cwd, "sample.png");
    writeFileSync(imagePath, Buffer.from(PNG, "base64"));
    const engine = new Engine({
      llm: runtime.modelPool.resolveLLMConfig()!,
      runtime,
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      enabledBuiltinTools: [],
      headless: true,
      permissionMode: "bypassPermissions",
      clientDefaults: {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://current-model.invalid/v1/chat/completions");
          bodies.push(JSON.parse(String(init?.body)));
          duringRequest?.();
          duringRequest = undefined;
          const first = requestInRun++ === 0;
          const chunk = {
            choices: [
              {
                index: 0,
                delta: first
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: "inspect",
                          type: "function",
                          function: { name: "InspectCurrentModel", arguments: "{}" },
                        },
                      ],
                    }
                  : { content: "ok" },
                finish_reason: first ? "tool_calls" : "stop",
              },
            ],
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    });
    (engine as any).hooks.clear();
    engine.registerCustomTool(
      {
        name: "InspectCurrentModel",
        description: "inspect fixture",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "allow",
      },
      async (_args, ctx) => {
        contexts.push(structuredClone(ctx!.llmConfig));
        return viewImageTool({ path: imagePath }, ctx);
      },
    );
    const run = async (attachImage = false) => {
      requestInRun = 0;
      const start = bodies.length;
      const task = attachImage
        ? `inspect fixture\n<codeshell-image mime="image/png" name="sample.png">\ndata:image/png;base64,${PNG}\n</codeshell-image>`
        : "inspect fixture";
      const result = await engine.run(task);
      expect(result.text).toBe("ok");
      expect(result.reason).toBe("completed");
      const requests = bodies
        .slice(start)
        .filter((body) =>
          body.tools?.some((tool: any) => tool.function.name === "InspectCurrentModel"),
        );
      expect(requests).toHaveLength(2);
      return requests;
    };
    try {
      // A reload during a provider request must not mutate this run's tool/client snapshot.
      duringRequest = () => save("openai/gpt-6.1-sol", false);
      const a = await run(true);
      expect(contexts[0].supportsVision).toBe(true);
      expect(JSON.stringify(a[0].messages)).toContain(`data:image/png;base64,${PNG}`);
      expect(JSON.stringify(a[1].messages)).toContain(`data:image/png;base64,${PNG}`);
      const updated = await run();
      standalone.reloadModelPool();
      expect(standalone.buildToolContext().llmConfig.supportsVision).toBe(false);
      expect(contexts[1].supportsVision).toBe(false);
      expect(JSON.stringify(updated[1].messages)).not.toContain("image_url");
      save("openai/gpt-5.6-sol", false);
      const b = await run();
      standalone.reloadModelPool();
      expect(standalone.buildToolContext().llmConfig.model).toBe("openai/gpt-5.6-sol");
      expect(contexts[2].model).toBe("openai/gpt-5.6-sol");
      expect(b.map((body) => body.model)).toEqual([contexts[2].model, contexts[2].model]);
      expect(JSON.stringify(b[1].messages)).not.toContain("image_url");
      save("vendor/unknown");
      const unknown = await run();
      expect(contexts[3].supportsVision).toBeUndefined();
      expect(JSON.stringify(unknown[1].messages)).not.toContain("image_url");
      runtime.modelPool.register({ key: "pending", provider: "openai", model: "pending" });
      runtime.modelPool.register({ key: "latest", provider: "openai", model: "latest" });
      duringRequest = () => {
        engine.switchModel("pending", { persist: false });
      };
      const unchanged = await run();
      expect(contexts[4].model).toBe("vendor/unknown");
      expect(unchanged.every((body) => body.model === "vendor/unknown")).toBe(true);
      engine.switchModel("latest", { persist: false });
      expect(engine.buildToolContext().llmConfig.model).toBe("latest");
      expect(engine.getPermissionMode()).toBe("bypassPermissions");
      writeFileSync(
        join(cwd, ".code-shell", "settings.json"),
        JSON.stringify({ modelConnections: [] }),
      );
      standalone.reloadModelPool();
      expect(() => standalone.buildToolContext()).toThrow("no longer configured");
    } finally {
      await standalone.dispose();
      await runtime.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
