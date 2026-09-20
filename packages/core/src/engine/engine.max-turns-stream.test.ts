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

function makeEngine(dir: string, model: string, maxTurns = 1): Engine {
  const engine = new Engine({
    llm: { provider: fakeProvider, model, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    enabledBuiltinTools: [],
    maxTurns,
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
  it("does not advance an earlier completed snapshot after forced last-turn text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-forced-summary-snapshot-"));
    const model = `${fakeProvider}-${crypto.randomUUID()}`;
    const sessionId = "s-forced-summary-snapshot";
    const response: LLMResponse = {
      text: "Completed the first request.",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    scenarios.set(model, { calls: 0, responses: [response] });
    const readState = () =>
      JSON.parse(readFileSync(join(dir, "sessions", sessionId, "state.json"), "utf-8")) as {
        status?: string;
        completedThroughEventId?: string;
      };

    try {
      const engine = makeEngine(dir, model, 2);
      const initial = await engine.run("answer a simple question", { sessionId, cwd: dir });
      const completedCursor = readState().completedThroughEventId;
      expect(initial.reason).toBe("completed");
      expect(completedCursor).toBeString();
      scenarios.set(model, {
        calls: 0,
        responses: [
          {
            ...response,
            text: "",
            toolCalls: [{ id: "continue-check", toolName: "NoopTool", args: {} }],
            stopReason: "tool_use",
          },
          { ...response, text: "More checks remain." },
        ],
      });

      const limited = await engine.run("verify several more sources", { sessionId, cwd: dir });

      expect(limited.reason).toBe("max_turns");
      expect(readState()).toMatchObject({
        status: "max_turns",
        completedThroughEventId: completedCursor,
      });
    } finally {
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists and emits max_turns when the last-turn instruction produces plain final text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-forced-summary-"));
    const model = `${fakeProvider}-${crypto.randomUUID()}`;
    const sessionId = "s-forced-summary";
    const events: StreamEvent[] = [];
    scenarios.set(model, {
      calls: 0,
      responses: [
        {
          text: "Checked one source; remaining sources still need verification.",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      ],
    });

    try {
      const result = await makeEngine(dir, model).run("verify every source", {
        sessionId,
        cwd: dir,
        onStream: (event) => events.push(event),
      });
      const state = JSON.parse(
        readFileSync(join(dir, "sessions", sessionId, "state.json"), "utf-8"),
      ) as { status?: string; completedThroughEventId?: string; lastCompletionKind?: string };

      expect(result.reason).toBe("max_turns");
      expect(result.text).toContain("still need verification");
      expect(state.status).toBe("max_turns");
      expect(state.completedThroughEventId).toBeUndefined();
      expect(state.lastCompletionKind).toBeUndefined();
      const terminals = events.filter((event) => event.type === "turn_complete");
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ reason: "max_turns" });
    } finally {
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            cacheReadTokens: 11,
            cacheCreationTokens: 3,
          },
        },
        {
          text: "final summary",
          toolCalls: [],
          stopReason: "stop",
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            cacheReadTokens: 13,
            cacheCreationTokens: 7,
          },
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
      expect(result.usage.totalTokens).toBeGreaterThanOrEqual(4);
      expect(result.usage.cacheReadTokens).toBeGreaterThanOrEqual(24);
      expect(result.usage.cacheCreationTokens).toBeGreaterThanOrEqual(10);
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
