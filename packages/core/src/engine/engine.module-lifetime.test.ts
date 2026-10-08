import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { EngineRuntime } from "./runtime.js";
import { ModelPool } from "../llm/model-pool.js";
import { SettingsManager } from "../settings/manager.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { CostTracker } from "../cost-tracker.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import type { AgentModule } from "../composition/types.js";
import { compileComposition } from "../composition/compiler.js";
import { ChatSessionManager } from "../protocol/chat-session-manager.js";

const provider = "fake-module-lifetime";
class Client extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text: "done", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, Client);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "module-lifetime-"));
  roots.push(path);
  return path;
}
function config(cwd: string) {
  return {
    llm: { provider, model: provider, apiKey: "synthetic" } as never,
    cwd,
    settingsScope: "isolated" as const,
    sessionStorageDir: join(cwd, "sessions"),
    isSubAgent: true,
    headless: true,
    maxTurns: 1,
  };
}

describe("Engine module lifetimes through production paths", () => {
  for (const owner of ["Engine", "Runtime"] as const) {
    test(`${owner} shutdown cancels a pending activator before awaiting readiness and reclaims its late resource`, async () => {
      const cwd = root();
      const events: string[] = [];
      let started!: () => void;
      let cancel!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const registry = new ToolRegistry({ builtinTools: [] });
      const runtime = new EngineRuntime({
        modelPool: new ModelPool(),
        toolRegistry: registry,
        settings: new SettingsManager(cwd, "isolated"),
        mcpPool: new MCPManager(registry),
        costTracker: new CostTracker(),
      });
      const engine = new Engine({
        ...config(cwd),
        runtime,
        modules: [
          {
            id: "pending",
            async activateEngine(ctx) {
              ctx.own(() => {
                events.push("cancel");
                cancel();
              });
              started();
              await new Promise<void>((resolve) => {
                cancel = resolve;
              });
              return () => {
                events.push("late-release");
              };
            },
          },
          {
            id: "unreached",
            activateEngine() {
              events.push("unreached");
            },
          },
        ],
      });
      const run = engine.run("pending initialization");
      void run.catch(() => {});
      await entered;
      await (owner === "Engine" ? engine.dispose() : runtime.close());
      await expect(run).rejects.toThrow("disposed");
      expect(events).toEqual(["cancel", "late-release"]);
      expect(engine.getToolRegistry().listTools()).toEqual([]);
      await runtime.close();
    });
  }

  test("private services are created once per declared owner and released session before engine", async () => {
    const cwd = root();
    const calls: string[] = [];
    const modules: AgentModule[] = [
      {
        id: "engine-service",
        engine: {
          privateService: {
            scope: "engine",
            create: () => {
              calls.push("create-engine");
              return {};
            },
            dispose() {
              calls.push("release-engine");
            },
          },
        },
        activateEngine(ctx) {
          ctx.own(() => {
            calls.push("release-activation");
          });
        },
      },
      {
        id: "session-service",
        engine: {
          privateService: {
            scope: "session",
            async create(host) {
              calls.push(`create-${host.sessionId}`);
              return { sessionId: host.sessionId };
            },
            dispose(value: any) {
              calls.push(`release-${value.sessionId}`);
            },
          },
        },
      },
    ];
    const engine = new Engine({ ...config(cwd), modules });
    await engine.ready();
    expect(engine.buildToolContext().capabilityServices?.["engine-service"]).toBe(
      engine.buildToolContext().capabilityServices?.["engine-service"],
    );
    await engine.run("first", { sessionId: "first" });
    await engine.run("second turn", { sessionId: "first" });
    await engine.run("another session", { sessionId: "second" });
    expect(calls).toEqual(["create-engine", "create-first", "create-second"]);
    const closing = engine.dispose();
    expect(engine.dispose()).toBe(closing);
    await closing;
    expect(calls).toEqual([
      "create-engine",
      "create-first",
      "create-second",
      "release-second",
      "release-first",
      "release-activation",
      "release-engine",
    ]);
    expect(() => engine.buildToolContext()).toThrow("disposed");
    await expect(engine.run("late")).rejects.toThrow("disposed");
  });

  test("same composition in two Engines has independent services, registries, and teardown", async () => {
    const cwd = root();
    let released = 0;
    const module: AgentModule = {
      id: "service",
      engine: {
        privateService: {
          scope: "engine",
          create: () => ({}),
          dispose() {
            released++;
          },
        },
        tools: [
          {
            kind: "always",
            tool: {
              definition: {
                name: "ServiceTool",
                description: "test",
                inputSchema: { type: "object" },
                source: "builtin",
                permissionDefault: "ask",
              },
              execute: async (_args, ctx) => String(Object.keys(ctx?.capabilityServices ?? {})),
            },
          },
        ],
      },
    };
    const composition = compileComposition({
      modules: [
        module,
        {
          id: "other",
          engine: { privateService: { scope: "engine", create: () => ({ secret: "private" }) } },
        },
      ],
    });
    const a = new Engine({ ...config(cwd), composition });
    const b = new Engine({ ...config(cwd), composition });
    await Promise.all([a.ready(), b.ready()]);
    expect(a.buildToolContext().capabilityServices?.service).not.toBe(
      b.buildToolContext().capabilityServices?.service,
    );
    expect(
      (await b.getToolRegistry().executeTool("ServiceTool", {}, { ctx: b.buildToolContext() }))
        .result,
    ).toBe("service");
    await a.dispose();
    expect(a.getToolRegistry().hasTool("ServiceTool")).toBe(false);
    expect(b.getToolRegistry().hasTool("ServiceTool")).toBe(true);
    expect(released).toBe(1);
    await b.dispose();
    expect(released).toBe(2);
  });

  test("failed Engine activator rolls back the real registry, hooks and private service", async () => {
    const cwd = root();
    let released = 0;
    const module: AgentModule = {
      id: "broken",
      engine: {
        privateService: {
          scope: "engine",
          create: () => ({}),
          dispose() {
            released++;
          },
        },
        hooks: [{ event: "on_stop", handler: () => ({}) }],
        tools: [
          {
            kind: "always",
            tool: {
              definition: {
                name: "PartialTool",
                description: "test",
                inputSchema: { type: "object" },
                source: "builtin",
                permissionDefault: "ask",
              },
              execute: async () => "partial",
            },
          },
        ],
      },
      async activateEngine(ctx) {
        ctx.own(() => {
          released++;
        });
        throw new Error("cannot activate");
      },
    };
    const engine = new Engine({ ...config(cwd), modules: [module] });
    await expect(engine.ready()).rejects.toThrow("cannot activate");
    expect(engine.getToolRegistry().listTools()).toEqual([]);
    expect((engine as any).hooks.listEvents()).toEqual([]);
    expect(released).toBe(2);
    await expect(engine.dispose()).rejects.toThrow("cannot activate");
    expect(released).toBe(2);
  });

  test("run hooks and permission ownership disappear after a real run; session close releases Engine resources", async () => {
    const cwd = root();
    let released = 0;
    const registry = new ToolRegistry({ builtinTools: [] });
    const runtime = new EngineRuntime({
      modelPool: new ModelPool(),
      toolRegistry: registry,
      settings: new SettingsManager(cwd, "isolated"),
      mcpPool: new MCPManager(registry),
      costTracker: new CostTracker(),
    });
    const manager = new ChatSessionManager({
      runtime,
      engineFactory: () =>
        new Engine({
          ...config(cwd),
          runtime,
          modules: [
            {
              id: "lifecycle",
              activateEngine(ctx) {
                ctx.own(async () => {
                  await Promise.resolve();
                  released++;
                });
              },
            },
          ],
        }),
    });
    const chat = await manager.getOrCreate("managed", {} as never);
    await chat.engine.run("run", { sessionId: "managed" });
    expect((chat.engine as any).hooks.hasHooks("on_tool_start")).toBe(false);
    expect((chat.engine as any).hooks.hasHooks("on_tool_end")).toBe(false);
    expect((chat.engine as any).permissionController.activePermission).toBeUndefined();
    await manager.close("managed");
    expect(released).toBe(1);
    expect(manager.get("managed")).toBeUndefined();
    await runtime.close();
    expect(released).toBe(1);
  });

  test("Runtime close cancels and awaits an active Engine before releasing shared resources", async () => {
    const cwd = root();
    const events: string[] = [];
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    class BlockingClient extends Client {
      async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
        started();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        events.push("request-settled");
        return super.createMessage(options);
      }
    }
    registerProvider("fake-module-lifetime-blocking", BlockingClient);
    const registry = new ToolRegistry({ builtinTools: [] });
    const runtime = new EngineRuntime({
      modelPool: new ModelPool(),
      toolRegistry: registry,
      settings: new SettingsManager(cwd, "isolated"),
      mcpPool: new MCPManager(registry),
      costTracker: new CostTracker(),
    });
    runtime.lifetime.own(() => {
      events.push("shared-release");
    });
    const engine = new Engine({
      ...config(cwd),
      llm: {
        provider: "fake-module-lifetime-blocking",
        model: "blocking",
        apiKey: "synthetic",
      } as never,
      runtime,
      modules: [
        {
          id: "owned",
          activateEngine(ctx) {
            ctx.own(() => {
              events.push("engine-release");
            });
          },
        },
      ],
    });
    const run = engine.run("wait for cancellation", { sessionId: "active" });
    await entered;
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await Promise.all([closing, run]);
    expect(events).toEqual(["request-settled", "engine-release", "shared-release"]);
    expect((engine as any).permissionController.activePermission).toBeUndefined();
    await expect(engine.run("late")).rejects.toThrow("disposed");
    expect(() => new Engine({ ...config(cwd), runtime })).toThrow("disposed");
  });

  test("hook reload preserves SDK registrations whose names resemble plugin hooks", async () => {
    const cwd = root();
    let calls = 0;
    const engine = new Engine({
      ...config(cwd),
      isSubAgent: false,
      hooks: [
        {
          event: "on_stop",
          name: "plugin:external:on_stop",
          handler() {
            calls++;
            return {};
          },
        },
      ],
    });
    await engine.ready();
    for (let i = 0; i < 3; i++) engine.reloadHooks();
    await (engine as any).hooks.emit("on_stop");
    expect(calls).toBe(1);
    expect((engine as any).lifetime.children.size).toBe(2);
    await engine.dispose();
    expect((engine as any).hooks.listEvents()).toEqual([]);
  });
});
