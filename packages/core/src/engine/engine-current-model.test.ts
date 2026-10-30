import { resolveConfiguredTextModel } from "./configured-text-model.js";
import { ChatSession } from "../protocol/chat-session.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test("configured text intents use each Session's fresh workspace without mutating the shared boot pool", async () => {
    const a = fixture(),
      b = fixture(),
      home = fixture();
    const previousHome = process.env.HOME;
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "owned-global-key-must-not-leak";
    process.env.HOME = home;
    const registry = new ToolRegistry({ builtinTools: [] });
    const runtime = new EngineRuntime({
      modelPool: new ModelPool(),
      toolRegistry: registry,
      settings: new SettingsManager(a, "full"),
      mcpPool: new MCPManager(registry),
      costTracker: {} as never,
      usageStorageDir: join(a, "usage"),
    });
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "model-catalog.user.json"),
      JSON.stringify([
        {
          id: "owned-scoped",
          tag: "text",
          adapterKind: "openai",
          protocol: "openai-compat",
          displayName: "owned",
          description: "owned",
          defaultBaseUrl: "http://owned-a.invalid/v1",
          needsKey: false,
          modelPresets: [
            {
              value: "shared-model",
              params: [
                {
                  name: "temperature",
                  control: "number",
                  min: 0,
                  max: 2,
                  wire: { field: "temperature" },
                },
              ],
            },
          ],
        },
      ]),
    );
    const save = (
      cwd: string,
      endpoint: string,
      temperature: number,
      id = "shared",
      keyless = false,
    ) => {
      mkdirSync(join(cwd, ".code-shell"), { recursive: true });
      writeFileSync(
        join(cwd, ".code-shell", "settings.json"),
        JSON.stringify({
          credentials: keyless
            ? []
            : [{ id: "owned-key", catalogId: "owned-scoped", apiKey: "owned-fixture-only" }],
          modelConnections: [
            {
              id,
              credentialId: keyless ? undefined : "owned-key",
              catalogId: "owned-scoped",
              tag: "text",
              model: "shared-model",
              baseUrl: endpoint,
              paramValues: { temperature },
            },
          ],
          defaults: { text: id },
        }),
      );
    };
    save(a, "http://owned-a.invalid/v1", 0.1);
    save(b, "http://owned-b.invalid/v1", 0.2);
    runtime.reloadModelsFromSettings();
    const boot = structuredClone(runtime.modelPool.list());
    const requests: { url: string; body: any; authorization: string | null }[] = [];
    let pause: (() => Promise<void>) | undefined;
    const fetch: NonNullable<import("../types.js").ClientDefaults["fetch"]> = async (
      input,
      init,
    ) => {
      const url = String(input);
      if (
        ![
          "http://owned-a.invalid/v1/chat/completions",
          "http://owned-b.invalid/v1/chat/completions",
        ].includes(url)
      )
        throw new Error("non-owned request denied");
      requests.push({
        url,
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      await pause?.();
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"owned ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const engines: Engine[] = [];
    const make = (llm = runtime.modelPool.resolveLLMConfig()!, child = false) => {
      const engine = new Engine({
        runtime,
        llm,
        cwd: b,
        sessionStorageDir: join(b, "sessions"),
        enabledBuiltinTools: [],
        headless: true,
        isSubAgent: child,
        maxTurns: 2,
        clientDefaults: { fetch, retryMaxAttempts: 1 },
      });
      (engine as any).hooks.clear();
      engines.push(engine);
      return engine;
    };
    const intent = (id = "shared") => ({
      id,
      expectedFingerprint: resolveConfiguredTextModel(b, id).fingerprint,
    });
    const state = () =>
      JSON.parse(readFileSync(join(b, "sessions", "scope-session", "state.json"), "utf8"));
    const run = (engine: Engine, input: string, configuredModel?: ReturnType<typeof intent>) =>
      engine.run("owned fixture request", {
        sessionId: "scope-session",
        clientMessageId: input,
        configuredModel,
      });
    try {
      let engine = make();
      expect(await run(engine, "first", intent())).toMatchObject({ reason: "completed" });
      expect(requests.at(-1)).toMatchObject({
        url: "http://owned-b.invalid/v1/chat/completions",
        body: { model: "shared-model", temperature: 0.2 },
      });
      expect(state()).toMatchObject({
        provider: "openai",
        model: "shared-model",
        modelConnectionId: "shared",
      });
      expect(requests.at(-1)?.authorization).toBe("Bearer owned-fixture-only");
      expect(engine.getConfig().llm.modelKey).toBeUndefined();
      const child = make(engine.getConfig().llm, true);
      expect((await child.run("owned child request")).reason).toBe("completed");
      expect(requests.at(-1)?.url).toContain("owned-b.invalid");
      save(b, "http://owned-b.invalid/v1", 0.7, "shared", true);
      await run(engine, "fresh-params");
      expect(requests.at(-1)?.body.temperature).toBe(0.7);
      expect(requests.at(-1)?.authorization).toBe("Bearer codeshell-keyless");
      await engine.dispose();
      engine = make();
      await run(engine, "cold");
      expect(requests.at(-1)?.url).toContain("owned-b.invalid");
      const before = state(),
        count = requests.length,
        stale = intent();
      save(b, "http://owned-b.invalid/v1", 0.9);
      await expect(run(engine, "stale", stale)).rejects.toThrow("changed");
      expect(state()).toEqual(before);
      expect(requests).toHaveLength(count);
      save(b, "http://owned-b.invalid/v1", 0.9, "replacement");
      expect((await run(engine, "first", stale)).reason).toBe("completed");
      expect(requests).toHaveLength(count);
      await engine.dispose();
      engine = make();
      await expect(run(engine, "deleted")).rejects.toThrow("unavailable");
      expect(requests).toHaveLength(count);
      expect(state()).toEqual(before);
      await run(engine, "replacement", intent("replacement"));
      expect(state().modelConnectionId).toBe("replacement");
      const originalContext = engine.buildToolContext.bind(engine);
      let switchBeforeClaim = true;
      engine.buildToolContext = (...args) => {
        const context = originalContext(...args);
        if (switchBeforeClaim) {
          switchBeforeClaim = false;
          engine.switchModel("shared", { persist: false });
        }
        return context;
      };
      await run(engine, "queued-switch-still-b", intent("replacement"));
      expect(requests.at(-1)?.url).toContain("owned-b.invalid");
      expect(state().modelConnectionId).toBe("replacement");
      engine.buildToolContext = originalContext;
      await run(engine, "ordinary-switch");
      expect(requests.at(-1)?.url).toContain("owned-a.invalid");
      expect(state().modelConnectionId).toBeUndefined();
      await run(engine, "ordinary-next");
      expect(requests.at(-1)?.url).toContain("owned-a.invalid");
      switchBeforeClaim = true;
      engine.buildToolContext = (...args) => {
        const context = originalContext(...args);
        if (switchBeforeClaim) {
          switchBeforeClaim = false;
          engine.switchModel("shared", { persist: false });
        }
        return context;
      };
      await run(engine, "defer-before-new-selection", intent("replacement"));
      engine.buildToolContext = originalContext;
      await run(engine, "new-selection-replaces-old-pending", intent("replacement"));
      await run(engine, "continue-new-selection");
      expect(requests.at(-1)?.url).toContain("owned-b.invalid");
      expect(state().modelConnectionId).toBe("replacement");
      expect(
        requests.every((item) => item.authorization !== "Bearer owned-global-key-must-not-leak"),
      ).toBe(true);
      expect(runtime.modelPool.list()).toEqual(boot);
      expect(runtime.modelPool.get()?.key).toBe("shared");
      // The new explicit intent cannot replace a running or queued turn's immutable selection.
      const chat = new ChatSession({ id: "scope-session", engine });
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      pause = () => waiting;
      const first = chat.enqueueTurn("owned first concurrent", {
        clientMessageId: "concurrent-a",
        configuredModel: intent("replacement"),
      });
      await expect(
        chat.enqueueTurn("owned second concurrent", {
          clientMessageId: "concurrent-b",
          configuredModel: { id: "shared", expectedFingerprint: "0".repeat(64) },
        }),
      ).rejects.toThrow("cannot be queued");
      release();
      await first;
      pause = undefined;
      expect(requests.at(-1)?.url).toContain("owned-b.invalid");
      expect(state().clientMessageId).toBe("concurrent-a");
    } finally {
      for (const engine of engines) await engine.dispose();
      await runtime.close();
      process.env.HOME = previousHome;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

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
