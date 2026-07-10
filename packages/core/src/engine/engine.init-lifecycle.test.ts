import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { EngineRuntime, type EngineRuntimeOptions } from "./runtime.js";
import { LLMClientBase } from "../llm/client-base.js";
import { ModelPool } from "../llm/model-pool.js";
import { registerProvider } from "../llm/client-factory.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, SessionState, StreamEvent } from "../types.js";

const provider = "fake-engine-init-lifecycle";

interface Scenario {
  initAttempts: number;
  initFailures: number;
  modelCalls: number;
}

const scenarios = new Map<string, Scenario>();
const tempDirs: string[] = [];

class InitLifecycleClient extends LLMClientBase {
  protected initClient(): void {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing init lifecycle scenario: ${this.model}`);
    scenario.initAttempts++;
    if (scenario.initAttempts <= scenario.initFailures) {
      throw new Error("LLM client initialization failed");
    }
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing init lifecycle scenario: ${this.model}`);
    scenario.modelCalls++;
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, options);
    return {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

registerProvider(provider, InitLifecycleClient);

class FakeMcpPool {
  connectCalls = 0;

  constructor(private readonly connectImpl: () => Promise<void>) {}

  async connectAll(): Promise<void> {
    this.connectCalls++;
    await this.connectImpl();
  }

  async disconnectAll(): Promise<void> {}
}

function makeEngine(dir: string, model: string, mcpPool: FakeMcpPool): Engine {
  const runtime = new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: new ToolRegistry({ builtinTools: [] }),
    settings: {} as EngineRuntimeOptions["settings"],
    mcpPool: mcpPool as EngineRuntimeOptions["mcpPool"],
    costTracker: {} as EngineRuntimeOptions["costTracker"],
  });
  const engine = new Engine({
    llm: { provider, model, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
    settingsScope: "isolated",
    sandbox: defaultSandboxConfig("off"),
    mcpServers: {
      test: { name: "test", transport: "inprocess" },
    },
    runtime,
  });
  (engine as any).hooks.clear();
  return engine;
}

function setup(initFailures: number, connectImpl: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "engine-init-lifecycle-"));
  tempDirs.push(dir);
  const model = `${provider}-${Date.now()}-${Math.random()}`;
  const scenario: Scenario = { initAttempts: 0, initFailures, modelCalls: 0 };
  scenarios.set(model, scenario);
  const mcpPool = new FakeMcpPool(connectImpl);
  return { dir, model, scenario, mcpPool, engine: makeEngine(dir, model, mcpPool) };
}

function readState(dir: string, sessionId: string): SessionState {
  return JSON.parse(
    readFileSync(join(dir, "sessions", sessionId, "state.json"), "utf-8"),
  ) as SessionState;
}

function readTranscript(dir: string, sessionId: string): string {
  return readFileSync(join(dir, "sessions", sessionId, "transcript.jsonl"), "utf-8");
}

async function captureUnhandled<T>(
  run: () => Promise<T>,
): Promise<{ value: T; errors: unknown[] }> {
  const errors: unknown[] = [];
  const listener = (error: unknown) => errors.push(error);
  process.on("unhandledRejection", listener);
  try {
    const value = await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { value, errors };
  } finally {
    process.off("unhandledRejection", listener);
  }
}

afterEach(() => {
  scenarios.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Engine initialization lifecycle", () => {
  it("persists model_error, handles early client rejection, and releases the run guard", async () => {
    const fixture = setup(1, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    const events: StreamEvent[] = [];

    const { value: failed, errors } = await captureUnhandled(() =>
      fixture.engine.run("first run", {
        sessionId: "client-init-failure",
        cwd: fixture.dir,
        onStream: (event) => events.push(event),
      }),
    );

    expect(failed.reason).toBe("model_error");
    expect(failed.text).toContain("LLM client initialization failed");
    expect(readState(fixture.dir, failed.sessionId).status).toBe("model_error");
    expect(readTranscript(fixture.dir, failed.sessionId)).toContain('"type":"error"');
    expect(readTranscript(fixture.dir, failed.sessionId)).toContain(
      "LLM client initialization failed",
    );
    expect(errors).toEqual([]);
    expect(events).toContainEqual({
      type: "error",
      error: "LLM client initialization failed",
    });
    expect((fixture.engine as any).runInProgress).toBe(false);

    const recovered = await fixture.engine.run("second run", {
      sessionId: "client-init-recovered",
      cwd: fixture.dir,
    });
    expect(recovered.reason).toBe("completed");
    expect(fixture.scenario.initAttempts).toBe(2);
  });

  it("persists model_error for MCP initialization failure and releases the run guard", async () => {
    const fixture = setup(0, async () => {
      throw new Error("MCP connection failed");
    });
    const events: StreamEvent[] = [];

    const { value: failed, errors } = await captureUnhandled(() =>
      fixture.engine.run("first run", {
        sessionId: "mcp-init-failure",
        cwd: fixture.dir,
        onStream: (event) => events.push(event),
      }),
    );

    expect(failed.reason).toBe("model_error");
    expect(failed.text).toContain("MCP connection failed");
    expect(readState(fixture.dir, failed.sessionId).status).toBe("model_error");
    expect(readTranscript(fixture.dir, failed.sessionId)).toContain('"type":"error"');
    expect(readTranscript(fixture.dir, failed.sessionId)).toContain("MCP connection failed");
    expect(errors).toEqual([]);
    expect(events).toContainEqual({ type: "error", error: "MCP connection failed" });
    expect((fixture.engine as any).runInProgress).toBe(false);

    const recovered = await fixture.engine.run("second run", {
      sessionId: "mcp-init-recovered",
      cwd: fixture.dir,
    });
    expect(recovered.reason).toBe("completed");
    expect(fixture.mcpPool.connectCalls).toBe(1);
  });

  it("preserves the successful initialization path", async () => {
    const fixture = setup(0, async () => {});

    const result = await fixture.engine.run("normal run", {
      sessionId: "init-success",
      cwd: fixture.dir,
    });

    expect(result).toMatchObject({
      text: "ok",
      reason: "completed",
      sessionId: "init-success",
      turnCount: 1,
    });
    expect(readState(fixture.dir, result.sessionId).status).toBe("completed");
    expect(fixture.scenario.initAttempts).toBe(1);
    expect(fixture.scenario.modelCalls).toBeGreaterThanOrEqual(1);
    expect(fixture.mcpPool.connectCalls).toBe(1);
    expect((fixture.engine as any).runInProgress).toBe(false);
  });
});
