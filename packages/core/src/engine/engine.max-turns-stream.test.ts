import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";

const fakeProvider = "fake-engine-max-turns-stream";
type Scenario = {
  calls: number;
  responses: LLMResponse[];
  afterCall?: (callNumber: number) => void;
};
const scenarios = new Map<string, Scenario>();

class FakeMaxTurnsClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    const response = scenario.responses[Math.min(scenario.calls, scenario.responses.length - 1)]!;
    scenario.calls++;
    scenario.afterCall?.(scenario.calls);
    this.recordUsage(
      response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      options,
    );
    return response;
  }
}

registerProvider(fakeProvider, FakeMaxTurnsClient);

function makeEngine(dir: string, model: string): Engine {
  const engine = new Engine({
    llm: { provider: fakeProvider, model, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
  });
  (engine as any).hooks.clear();
  return engine;
}

afterEach(() => {
  asyncAgentRegistry.reset();
  notificationQueue.reset();
});

describe("Engine max_turns stream terminal", () => {
  it("emits one turn_complete(max_turns) for a maxTurns live run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-max-turns-stream-"));
    const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
    const sessionId = "s-max-turns-stream";
    const events: StreamEvent[] = [];
    scenarios.set(model, {
      calls: 0,
      responses: [
        {
          text: "",
          toolCalls: [{ id: "c1", toolName: "NoopTool", args: {} }],
          stopReason: "tool_use",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        {
          text: "final summary",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      ],
    });

    try {
      const engine = makeEngine(dir, model);
      const result = await engine.run("go", {
        sessionId,
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });
      const persistedState = JSON.parse(
        readFileSync(join(dir, "sessions", sessionId, "state.json"), "utf-8"),
      ) as { status?: string };
      const maxTurnsCompletions = events.filter(
        (event) => event.type === "turn_complete" && event.reason === "max_turns",
      );

      expect(result.reason).toBe("max_turns");
      expect(result.text).toBe("final summary");
      expect(persistedState.status).toBe("max_turns");
      expect(maxTurnsCompletions).toHaveLength(1);
    } finally {
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps one turn_complete(max_turns) when headless drain re-enters TurnLoop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-max-turns-drain-"));
    const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
    const sessionId = "s-max-turns-drain";
    const agentId = "bg-max-turns-drain";
    const events: StreamEvent[] = [];
    let queuedBackgroundResult = false;

    asyncAgentRegistry.register({
      agentId,
      sessionId,
      description: "background verifier",
      status: "running",
      startedAt: Date.now(),
      abort() {},
    });
    scenarios.set(model, {
      calls: 0,
      responses: [
        {
          text: "",
          toolCalls: [{ id: "c1", toolName: "NoopTool", args: {} }],
          stopReason: "tool_use",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        {
          text: "final summary",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        {
          text: "drain summary",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      ],
      afterCall: (callNumber) => {
        if (callNumber !== 2 || queuedBackgroundResult) return;
        queuedBackgroundResult = true;
        asyncAgentRegistry.markCompleted(agentId);
        notificationQueue.enqueue(
          {
            agentId,
            description: "background verifier",
            status: "completed",
            finalText: "background result",
            enqueuedAt: Date.now(),
          },
          sessionId,
        );
      },
    });

    try {
      const engine = makeEngine(dir, model);
      const result = await engine.run("go", {
        sessionId,
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });
      const maxTurnsCompletions = events.filter(
        (event) => event.type === "turn_complete" && event.reason === "max_turns",
      );

      expect(result.reason).toBe("max_turns");
      expect(result.text).toBe("drain summary");
      expect(maxTurnsCompletions).toHaveLength(1);
    } finally {
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
