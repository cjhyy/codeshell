/**
 * Persistent goal (CC /goal style): a goal set on one send is stored on the
 * session and survives across LATER bare sends (and manual interrupts) until
 * the judge says met or the user clears it. This test drives Engine.run with a
 * scripted LLM + scripted goal judge and inspects the canonical lifecycle API.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../packages/core/src/engine/engine.js";
import { registerProvider, PROVIDER_REGISTRY } from "../packages/core/src/llm/client-factory.js";
import { LLMClientBase } from "../packages/core/src/llm/client-base.js";
import type { LLMResponse, StreamEvent } from "../packages/core/src/types.js";
import type { CreateMessageOptions } from "../packages/core/src/llm/types.js";
import { backgroundJobRegistry } from "../packages/core/src/tool-system/builtin/background-jobs.js";

// Engine constructs a fresh LLM client per run via the factory, so per-instance
// counters reset between runs. Track judge state at MODULE scope so it's stable
// across runs in the same test.
let judgeCalls = 0;
let judgeVerdict: "met" | "not_met" | "waiting" = "not_met";

// Plain client: every turn returns a no-tool answer (each run ends in one
// turn). The goal JUDGE reuses the same client (engine wires llmClient as the
// judge), distinguished by its system prompt marker.
class Client extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const sys = options.systemPrompt ?? "";
    if (sys.includes("目标完成度裁判")) {
      judgeCalls += 1;
      const met = judgeVerdict === "met";
      return {
        text: JSON.stringify({
          met,
          waiting: judgeVerdict === "waiting",
          gaps: met ? "" : "还没完成",
        }),
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      } as unknown as LLMResponse;
    }
    return {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as unknown as LLMResponse;
  }
}

let savedProviders: Array<[string, new (cfg: any) => LLMClientBase]>;

beforeEach(() => {
  savedProviders = Array.from(PROVIDER_REGISTRY.entries());
  PROVIDER_REGISTRY.clear();
  judgeCalls = 0;
  judgeVerdict = "not_met";
  backgroundJobRegistry.reset();
  registerProvider("openai", Client);
});
afterEach(() => {
  backgroundJobRegistry.reset();
  PROVIDER_REGISTRY.clear();
  for (const [k, v] of savedProviders) PROVIDER_REGISTRY.set(k, v);
});

describe("persistent goal lifecycle", () => {
  let cwd: string;
  let savedHome: string | undefined;
  let engine: Engine;
  const sid = "s-pgoal";

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "engine-pgoal-"));
    savedHome = process.env.HOME;
    process.env.HOME = cwd;
    engine = new Engine({
      llm: {
        provider: "openai",
        providerKind: "openai",
        model: "gpt-5",
        apiKey: "test",
        enableStreaming: false,
      },
      cwd,
      sessionStorageDir: join(cwd, ".code-shell", "sessions"),
      enabledBuiltinTools: [],
      maxTurns: 3,
      headless: true,
      permissionMode: "bypassPermissions",
    });
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  function activeGoal(): string | undefined {
    return engine.getSessionManager().readActiveGoal(sid)?.objective;
  }

  function waitOnFiniteBackgroundWork(): void {
    judgeVerdict = "waiting";
    backgroundJobRegistry.start("finite-persistent-goal", sid, "finite test work");
  }

  it("stores the goal on the session when a send sets one", async () => {
    waitOnFiniteBackgroundWork();
    await engine.run("做第一步", { sessionId: sid, goal: "完成全部任务" });
    expect(activeGoal()).toBe("完成全部任务");
    // The judge ran (goal mode active).
    expect(judgeCalls).toBeGreaterThan(0);
  });

  it("a later BARE send (no goal) inherits the stored goal — judge still runs", async () => {
    waitOnFiniteBackgroundWork();
    await engine.run("做第一步", { sessionId: sid, goal: "完成全部任务" });
    const judgeBefore = judgeCalls;
    await engine.run("继续做", { sessionId: sid }); // no goal passed
    // Goal still active and judged again → persistence works.
    expect(activeGoal()).toBe("完成全部任务");
    expect(judgeCalls).toBeGreaterThan(judgeBefore);
  });

  it("clears the stored goal once the judge returns met", async () => {
    waitOnFiniteBackgroundWork();
    await engine.run("做第一步", { sessionId: sid, goal: "完成全部任务" });
    expect(activeGoal()).toBe("完成全部任务");
    backgroundJobRegistry.finish("finite-persistent-goal");
    judgeVerdict = "met";
    await engine.run("收尾", { sessionId: sid });
    expect(activeGoal()).toBeUndefined();
  });

  it("a new goal REPLACES the stored one", async () => {
    waitOnFiniteBackgroundWork();
    await engine.run("a", { sessionId: sid, goal: "目标一" });
    expect(activeGoal()).toBe("目标一");
    await engine.run("b", { sessionId: sid, goal: "目标二" });
    expect(activeGoal()).toBe("目标二");
  });

  it("clearGoal() wipes the active goal and a later bare send does NOT judge", async () => {
    waitOnFiniteBackgroundWork();
    await engine.run("a", { sessionId: sid, goal: "目标一" });
    expect(activeGoal()).toBe("目标一");
    const cleared = engine.clearGoal(sid);
    expect(cleared).toBe(true);
    expect(activeGoal()).toBeUndefined();
    backgroundJobRegistry.finish("finite-persistent-goal");
    const judgeBefore = judgeCalls;
    await engine.run("普通消息", { sessionId: sid });
    // No active goal → no judge call this run.
    expect(judgeCalls).toBe(judgeBefore);
  });

  it("numbers goal rounds per goal across background wakes, not per run", async () => {
    // s-mw4q76at-82b430f2: every wake parked on new background work and the
    // marker restarted at "第 1 轮" because TurnLoop counts per run.
    waitOnFiniteBackgroundWork();
    const markers: Array<Extract<StreamEvent, { type: "goal_progress" }>> = [];
    const onStream = (event: StreamEvent) => {
      if (event.type === "goal_progress") markers.push(event);
    };
    await engine.run("派出后台任务", { sessionId: sid, goal: "完成全部任务", onStream });
    await engine.run("后台完成后继续", { sessionId: sid, onStream });
    await engine.run("再继续", { sessionId: sid, onStream });

    // "Approaching the turn limit" notices (this harness caps runs at 3 turns)
    // restate the current count; only judged markers add a round.
    const waits = markers.filter((marker) => marker.status === "not_met");
    expect(markers.filter((marker) => marker.status === "approaching_limit")).toHaveLength(3);
    expect(markers.map((marker) => marker.round)).toEqual([0, 1, 1, 2, 2, 3]);
    expect(waits.map((marker) => marker.round)).toEqual([1, 2, 3]);
    for (const marker of waits) {
      expect(marker.waiting).toMatchObject({
        kind: "background_work",
        tasks: [{ kind: "job", label: "finite test work" }],
      });
    }
    expect(waits[2]!.progress?.rounds).toBe(3);
    expect(engine.getSessionManager().readGoalProgress(sid)).toMatchObject({
      rounds: 3,
      runningSinceMs: expect.any(Number),
    });
    expect(engine.getSessionManager().readSessionState(sid)?.goalLifecycle).toMatchObject({
      phase: "waiting",
      waitKind: "background",
    });
  });

  it("clearGoal() on a session with no goal is a no-op returning false", () => {
    expect(engine.clearGoal("does-not-exist")).toBe(false);
  });
});
