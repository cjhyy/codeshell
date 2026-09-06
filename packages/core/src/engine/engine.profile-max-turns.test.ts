import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-profile-turn-ceiling";
const promptMarker = "BOUND_PROFILE_TURN_CEILING_TEST";
type Scenario = {
  turns: number;
  summaries: number;
  summaryTools: number[];
  onTurn?: (turn: number) => void;
};
const scenarios = new Map<string, Scenario>();
/** Monotonic, so a model key is unique regardless of clock resolution. */
let nextScenarioId = 0;

class ProfileTurnCeilingClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    // Fail loudly rather than via `!`: a missing scenario used to surface as a
    // 30s timeout with no explanation, because the throw happened inside the
    // engine's retry loop instead of failing the test.
    if (!scenario) throw new Error(`missing profile-ceiling scenario: ${this.model}`);
    let response: LLMResponse = {
      text: "auxiliary response",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    if (options.systemPrompt.includes(promptMarker)) {
      if (JSON.stringify(options.messages).includes("Turn limit reached")) {
        scenario.summaries++;
        scenario.summaryTools.push(options.tools?.length ?? 0);
        response.text = "The request remains incomplete after repeated tool errors.";
      } else {
        scenario.turns++;
        scenario.onTurn?.(scenario.turns);
        response = {
          ...response,
          text: "",
          stopReason: "tool_use",
          toolCalls: [
            {
              id: `invalid-${scenario.turns}`,
              toolName: "UnavailableAction",
              args: { attempt: scenario.turns },
            },
          ],
        };
      }
    }
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, ProfileTurnCeilingClient);

describe("Engine behavior-profile turn ceiling", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    scenarios.clear();
  });

  function setup(profileMaxTurns: number | undefined, configMaxTurns?: number) {
    const root = mkdtempSync(join(tmpdir(), "profile-turn-ceiling-"));
    roots.push(root);
    const scenario: Scenario = { turns: 0, summaries: 0, summaryTools: [] };
    // roots.length alone repeats across tests and Date.now() has millisecond
    // resolution, so two setups in the same tick collided on one scenario key —
    // the loser's client then read a scenario another test had replaced or
    // cleared, and its run never terminated (30s timeouts in CI, where the
    // whole suite shares one process).
    const model = `${provider}-${roots.length}-${nextScenarioId++}`;
    scenarios.set(model, scenario);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: root,
      sessionStorageDir: join(root, "sessions"),
      customSystemPrompt: promptMarker,
      enabledBuiltinTools: [],
      maxTurns: configMaxTurns,
      headless: true,
      behaviorProfiles: [
        {
          id: "bounded-dispatcher",
          systemPromptAppend: promptMarker,
          maxTurns: profileMaxTurns,
          disableInstructions: true,
          disableMemoryContext: true,
          disableHooks: true,
          disableSessionTitle: true,
          disableMcp: true,
        },
      ],
    });
    (engine as any).hooks.clear();
    return { engine, root, scenario };
  }

  test("caps an endlessly retrying model and preserves one truthful max_turns terminal", async () => {
    const { engine, root, scenario } = setup(3, 20);
    const events: StreamEvent[] = [];
    const result = await engine.run("perform the requested action", {
      sessionId: "s-bounded",
      behaviorMode: "bounded-dispatcher",
      onStream: (event) => events.push(event),
    });
    expect(result.reason).toBe("max_turns");
    expect(result.text).toContain("remains incomplete");
    expect(scenario.turns).toBe(3);
    expect(scenario.summaries).toBe(1);
    expect(scenario.summaryTools).toEqual([0]);
    expect(
      events.filter((event) => event.type === "turn_complete" && event.reason === "max_turns"),
    ).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(root, "sessions/s-bounded/state.json"), "utf8"));
    expect(state.status).toBe("max_turns");
  });

  test("does not raise a stricter engine limit", async () => {
    const { engine, scenario } = setup(6, 2);
    const result = await engine.run("perform the requested action", {
      behaviorMode: "bounded-dispatcher",
    });
    expect(result.reason).toBe("max_turns");
    expect(scenario.turns).toBe(2);
  });

  test("does not raise a stricter Goal limit", async () => {
    const { engine, scenario } = setup(6);
    const result = await engine.run("perform the requested action", {
      behaviorMode: "bounded-dispatcher",
      goal: { objective: "finish the requested action", maxTurns: 2 },
    });
    expect(result.reason).toBe("max_turns");
    expect(scenario.turns).toBe(2);
  });

  test("keeps the profile ceiling when an active Goal is edited", async () => {
    const { engine, scenario } = setup(2, 20);
    let updatedObjective: string | undefined;
    scenario.onTurn = (turn) => {
      if (turn !== 1) return;
      updatedObjective = engine.updateGoal("s-edited-goal", {
        objective: "finish the corrected action",
      })?.objective;
    };
    const result = await engine.run("perform the requested action", {
      sessionId: "s-edited-goal",
      behaviorMode: "bounded-dispatcher",
      goal: { objective: "finish the requested action", maxTurns: 15 },
    });
    expect(updatedObjective).toBe("finish the corrected action");
    expect(result.reason).toBe("max_turns");
    expect(scenario.turns).toBe(2);
  });

  test("allows a live extension only up to the profile ceiling", async () => {
    const { engine, scenario } = setup(3, 1);
    let extension: ReturnType<Engine["extendGoalRun"]> = null;
    scenario.onTurn = (turn) => {
      if (turn !== 1) return;
      extension = engine.extendGoalRun({ addTurns: 50, addTokenBudget: 100 });
    };
    const result = await engine.run("perform the requested action", {
      behaviorMode: "bounded-dispatcher",
      goal: { objective: "finish the requested action", tokenBudget: 1_000 },
    });
    expect(extension).toMatchObject({ maxTurns: 3, tokenBudget: 1_100 });
    expect(result.reason).toBe("max_turns");
    expect(scenario.turns).toBe(3);
  });

  test("does not carry a profile ceiling into the next ordinary Work run", async () => {
    const { engine, scenario } = setup(1, 3);
    await engine.run("bounded request", { behaviorMode: "bounded-dispatcher" });
    expect(scenario.turns).toBe(1);
    scenario.turns = 0;
    scenario.summaries = 0;
    scenario.summaryTools = [];
    const result = await engine.run("ordinary work request");
    expect(result.reason).toBe("max_turns");
    expect(scenario.turns).toBe(3);
    expect(scenario.summaries).toBe(1);
  });

  test.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "ignores invalid or absent profile cap %s",
    async (profileMaxTurns) => {
      const { engine, scenario } = setup(profileMaxTurns, 2);
      const result = await engine.run("perform the requested action", {
        behaviorMode: "bounded-dispatcher",
      });
      expect(result.reason).toBe("max_turns");
      expect(scenario.turns).toBe(2);
      expect(scenario.summaries).toBe(1);
    },
  );
});
