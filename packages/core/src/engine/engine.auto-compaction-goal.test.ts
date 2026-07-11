import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, TokenUsage } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-auto-compaction-goal";
const MAIN_USAGE: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const COMPACTION_USAGE: TokenUsage = {
  promptTokens: 80_000,
  completionTokens: 20_000,
  totalTokens: 100_000,
};

type Scenario = {
  responses: LLMResponse[];
  mainCalls: number;
  summaryCalls: number;
  judgeCalls: number;
  mainCallsAtFirstSummary?: number;
  judgePrompts: string[];
  mainTokens: number;
  summaryTokens: number;
  auxiliaryTokens: number;
  auxiliaryTokensAtJudge?: number;
};

const scenarios = new Map<string, Scenario>();

function response(text: string, toolCallId?: string, usage = MAIN_USAGE): LLMResponse {
  return {
    text,
    toolCalls: toolCallId ? [{ id: toolCallId, toolName: "MissingTool", args: {} }] : [],
    stopReason: toolCallId ? "tool_use" : "stop",
    usage,
  };
}

function compactionResponses(): LLMResponse[] {
  const earlyPayload = "large assistant history payload ".repeat(220);
  return [
    ...Array.from({ length: 10 }, (_, index) =>
      response(`${earlyPayload}${index}`, `missing-${index}`, {
        promptTokens: index < 9 ? 2_000 : 5_000,
        completionTokens: 1,
        totalTokens: index < 9 ? 2_001 : 5_001,
      }),
    ),
    response("finished after compaction", undefined, {
      promptTokens: 5_000,
      completionTokens: 1,
      totalTokens: 5_001,
    }),
  ];
}

class AutoCompactionGoalClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing auto-compaction scenario: ${this.model}`);

    if (options.systemPrompt.includes("conversation summarizer")) {
      scenario.summaryCalls++;
      scenario.mainCallsAtFirstSummary ??= scenario.mainCalls;
      const summary = response(
        `A factual compacted history summary. ${"condensed context ".repeat(12)}`,
        undefined,
        COMPACTION_USAGE,
      );
      scenario.summaryTokens += summary.usage!.totalTokens;
      this.recordUsage(summary.usage!, options);
      return summary;
    }

    if (options.systemPrompt.includes("目标完成度裁判")) {
      scenario.judgeCalls++;
      scenario.auxiliaryTokensAtJudge ??= scenario.auxiliaryTokens;
      scenario.judgePrompts.push(JSON.stringify(options.messages));
      const verdict = response('{"met":true,"waiting":false,"gaps":""}', undefined, MAIN_USAGE);
      this.recordUsage(verdict.usage!, options);
      return verdict;
    }

    if (!options.systemPrompt.includes("Working directory:")) {
      const auxiliary = response("auxiliary response long enough to be harmless");
      scenario.auxiliaryTokens += auxiliary.usage!.totalTokens;
      this.recordUsage(auxiliary.usage!, options);
      return auxiliary;
    }

    const result = scenario.responses[Math.min(scenario.mainCalls, scenario.responses.length - 1)]!;
    scenario.mainCalls++;
    scenario.mainTokens += result.usage!.totalTokens;
    this.recordUsage(result.usage!, options);
    return result;
  }
}

registerProvider(provider, AutoCompactionGoalClient);

function goalTokensFromJudgePrompt(prompt: string): number {
  const match = prompt.match(/Goal tokens: (\d+) \/ /);
  if (!match) throw new Error(`Goal token progress missing from judge prompt: ${prompt}`);
  return Number(match[1]);
}

describe("Engine auto-compaction Goal accounting", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    scenarios.clear();
  });

  function setup(name: string, responses: LLMResponse[]) {
    const root = mkdtempSync(join(tmpdir(), `engine-auto-compact-goal-${name}-`));
    roots.push(root);
    mkdirSync(join(root, ".code-shell"), { recursive: true });
    writeFileSync(
      join(root, ".code-shell", "settings.json"),
      JSON.stringify({
        context: {
          compactAtRatio: 0.28,
          summarizeAtRatio: 0.99,
          microcompactFloorRatio: 0.28,
        },
      }),
    );
    const model = `${provider}-${name}-${Date.now()}-${Math.random()}`;
    const scenario: Scenario = {
      responses,
      mainCalls: 0,
      summaryCalls: 0,
      judgeCalls: 0,
      judgePrompts: [],
      mainTokens: 0,
      summaryTokens: 0,
      auxiliaryTokens: 0,
    };
    scenarios.set(model, scenario);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: root,
      sessionStorageDir: join(root, "sessions"),
      enabledBuiltinTools: [],
      preset: "terminal-coding",
      headless: true,
      maxContextTokens: 10_000,
    });
    (engine as any).hooks.clear();
    return { engine, root, model, scenario };
  }

  it("accounts auto-compaction primary-model usage against the Goal budget", async () => {
    const { engine, root, scenario } = setup("accounting", compactionResponses());

    const result = await engine.run("complete a long bounded task", {
      sessionId: "auto-compact-accounting",
      cwd: root,
      goal: { objective: "finish the long task", tokenBudget: 1_000_000 },
    });

    expect(result.reason).toBe("completed");
    expect(scenario.summaryCalls).toBeGreaterThan(0);
    expect(scenario.judgeCalls).toBe(1);
    // Tool summaries are hidden from the foreground request list but are real
    // billed calls and therefore part of the Goal budget.
    expect(goalTokensFromJudgePrompt(scenario.judgePrompts[0]!)).toBe(
      scenario.mainTokens + scenario.summaryTokens + scenario.auxiliaryTokensAtJudge!,
    );
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(
      scenario.mainTokens +
        scenario.summaryTokens +
        scenario.auxiliaryTokensAtJudge! +
        MAIN_USAGE.totalTokens,
    );
  });

  it("does not issue the main request after compaction exhausts the Goal budget", async () => {
    const { engine, root, scenario } = setup("budget-stop", compactionResponses());

    const result = await engine.run("complete a tightly bounded task", {
      sessionId: "auto-compact-budget-stop",
      cwd: root,
      goal: { objective: "finish without exceeding budget", tokenBudget: 50_000 },
    });

    expect(scenario.summaryCalls).toBeGreaterThan(0);
    expect(scenario.mainCallsAtFirstSummary).toBeDefined();
    expect(scenario.mainCalls).toBe(scenario.mainCallsAtFirstSummary);
    expect(result.reason).toBe("goal_budget_exhausted");
    expect(result.goalTermination).toBe("token_budget_exhausted");
  });

  it("keeps normal Goal usage accounting unchanged when compaction does not run", async () => {
    const normalUsage: TokenUsage = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    };
    const { engine, root, scenario } = setup("normal-goal", [
      response("normal completion", undefined, normalUsage),
    ]);

    const result = await engine.run("complete a short task", {
      sessionId: "normal-goal-accounting",
      cwd: root,
      goal: { objective: "finish the short task", tokenBudget: 100 },
    });

    expect(result.reason).toBe("completed");
    expect(scenario.summaryCalls).toBe(0);
    expect(goalTokensFromJudgePrompt(scenario.judgePrompts[0]!)).toBe(normalUsage.totalTokens);
  });

  it("continues normally after auto-compaction when no Goal is active", async () => {
    const { engine, root, scenario } = setup("no-goal", compactionResponses());

    const result = await engine.run("complete a long ordinary task", {
      sessionId: "auto-compact-no-goal",
      cwd: root,
    });

    expect(result.reason).toBe("completed");
    expect(scenario.summaryCalls).toBeGreaterThan(0);
    expect(scenario.mainCalls).toBeGreaterThan(scenario.mainCallsAtFirstSummary!);
  });
});
