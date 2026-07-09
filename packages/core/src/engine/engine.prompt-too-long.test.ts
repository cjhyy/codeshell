import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLimitError } from "../exceptions.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import { Engine } from "./engine.js";

const fakeProvider = "fake-engine-prompt-too-long";
const scenarios = new Map<string, { calls: number }>();

class PromptTooLongClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    scenario.calls++;
    throw new ContextLimitError(this.provider);
  }
}

registerProvider(fakeProvider, PromptTooLongClient);

function uniqueModel(): string {
  return `${fakeProvider}-${Date.now()}-${Math.random()}`;
}

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

describe("Engine prompt_too_long terminal event", () => {
  it("emits turn_complete and persists status when TurnLoop cannot recover context limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-prompt-too-long-"));
    const model = uniqueModel();
    const scenario = { calls: 0 };
    const events: StreamEvent[] = [];
    scenarios.set(model, scenario);

    try {
      const engine = makeEngine(dir, model);
      const result = await engine.run("keep going", {
        sessionId: "prompt-too-long-session",
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });

      expect(result.reason).toBe("prompt_too_long");
      expect(scenario.calls).toBe(4);
      expect(events).toContainEqual({
        type: "error",
        error: "Context limit exceeded after 3 recovery attempts",
      });
      expect(events).toContainEqual({ type: "turn_complete", reason: "prompt_too_long" });

      const statePath = join(dir, "sessions", result.sessionId, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as { status?: string };
      expect(state.status).toBe("prompt_too_long");
    } finally {
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
