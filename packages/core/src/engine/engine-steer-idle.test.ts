import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";

const fakeProvider = "fake-steer-order";
const fakeScenarios = new Map<string, { calls: number; responses: LLMResponse[] }>();

class FakeSteerOrderClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = fakeScenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    const response = scenario.responses[Math.min(scenario.calls, scenario.responses.length - 1)]!;
    scenario.calls++;
    this.recordUsage(response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, options);
    return response;
  }
}

registerProvider(fakeProvider, FakeSteerOrderClient);

function bareEngine(): Engine {
  const engine = Object.create(Engine.prototype) as any;
  engine.steerQueueBySid = new Map();
  engine.activeRunSession = null;
  engine.activeTurnLoop = null;
  return engine as Engine;
}

describe("Engine.enqueueSteer active-run gate", () => {
  it("rejects idle steer without queueing it", () => {
    const engine = bareEngine();

    const result = engine.enqueueSteer("s1", "hello", "steer-1", "client-1");

    expect(result).toEqual({ accepted: false, id: "steer-1" });
    expect((engine as any).steerQueueBySid.get("s1")).toBeUndefined();
  });

  it("accepts steer only for the currently active session", () => {
    const engine = bareEngine();
    (engine as any).activeRunSession = { state: { sessionId: "s1" } };
    (engine as any).activeTurnLoop = {};

    expect(engine.enqueueSteer("s2", "wrong session", "steer-2")).toEqual({
      accepted: false,
      id: "steer-2",
    });
    expect(engine.enqueueSteer("s1", "right session", "steer-3", "client-3")).toEqual({
      accepted: true,
      id: "steer-3",
    });
    expect((engine as any).steerQueueBySid.get("s1")).toEqual([
      { id: "steer-3", text: "right session", clientMessageId: "client-3" },
    ]);
    expect((engine as any).steerQueueBySid.get("s2")).toBeUndefined();
  });

  it("accepts and consumes shutdown steer before activeRunSession is cleared", async () => {
    const sessionId = "s-finalize-order";
    const model = `${fakeProvider}-${Date.now()}`;
    const dir = mkdtempSync(join(tmpdir(), "engine-steer-order-"));
    fakeScenarios.set(model, {
      calls: 0,
      responses: [
        {
          text: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        {
          text: "continued",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      ],
    });
    const engine = new Engine({
      llm: { provider: fakeProvider, model, apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      headless: true,
    });
    (engine as any).hooks.clear();
    const events: StreamEvent[] = [];
    let enqueueResult: ReturnType<Engine["enqueueSteer"]> | undefined;

    try {
      const result = await engine.run("go", {
        sessionId,
        cwd: dir,
        onStream: (event) => {
          events.push(event);
          if (
            event.type === "assistant_message" &&
            event.message.content === "done" &&
            enqueueResult === undefined
          ) {
            enqueueResult = engine.enqueueSteer(
              sessionId,
              "queued during shutdown",
              "steer-final",
              "client-final",
            );
          }
        },
      });

      expect(enqueueResult).toEqual({ accepted: true, id: "steer-final" });
      expect(events).toContainEqual({
        type: "steer_injected",
        text: "queued during shutdown",
        id: "steer-final",
      });
      expect(result.reason).toBe("completed");
      expect(result.text).toBe("continued");
      expect(engine.enqueueSteer(sessionId, "idle now", "steer-idle")).toEqual({
        accepted: false,
        id: "steer-idle",
      });
    } finally {
      fakeScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
