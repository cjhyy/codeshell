/**
 * cancel_goal / complete_goal short-circuit: when the model calls one of the
 * goal-control tools, the turn loop must stop AND clear the persisted goal so a
 * later bare send does not re-inherit it. cancel_goal only counts when
 * confirm===true (the strong-intent guard); an unconfirmed call must NOT clear
 * the goal. Drives Engine.run with a scripted LLM.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../packages/core/src/engine/engine.js";
import {
  registerProvider,
  PROVIDER_REGISTRY,
} from "../packages/core/src/llm/client-factory.js";
import { LLMClientBase } from "../packages/core/src/llm/client-base.js";
import type { LLMResponse } from "../packages/core/src/types.js";
import type { CreateMessageOptions } from "../packages/core/src/llm/types.js";

// What the next non-judge turn should return. Set per-test. After emitting a
// tool call once, we flip to a plain answer so the run terminates.
let scriptedToolCall: { toolName: string; args: Record<string, unknown> } | null = null;
let judgeVerdict: "met" | "not_met" = "not_met";

class Client extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const sys = options.systemPrompt ?? "";
    if (sys.includes("目标完成度裁判")) {
      const met = judgeVerdict === "met";
      return {
        text: JSON.stringify({ met, gaps: met ? "" : "还没完成" }),
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      } as unknown as LLMResponse;
    }
    if (scriptedToolCall) {
      const tc = scriptedToolCall;
      scriptedToolCall = null; // fire once
      return {
        text: "",
        toolCalls: [{ id: "tc-1", toolName: tc.toolName, args: tc.args }],
        stopReason: "tool_use",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      } as unknown as LLMResponse;
    }
    return {
      text: "done",
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
  scriptedToolCall = null;
  judgeVerdict = "not_met";
  registerProvider("openai", Client);
});
afterEach(() => {
  PROVIDER_REGISTRY.clear();
  for (const [k, v] of savedProviders) PROVIDER_REGISTRY.set(k, v);
});

describe("goal-control tool short-circuits", () => {
  let cwd: string;
  let savedHome: string | undefined;
  let engine: Engine;
  const sid = "s-gcancel";

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "engine-gcancel-"));
    savedHome = process.env.HOME;
    process.env.HOME = cwd;
    engine = new Engine({
      llm: { provider: "openai", providerKind: "openai", model: "gpt-5", apiKey: "test", enableStreaming: false },
      cwd,
      sessionStorageDir: join(cwd, ".code-shell", "sessions"),
      enabledBuiltinTools: ["complete_goal", "cancel_goal"],
      maxTurns: 4,
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
    return engine.getSessionManager().resume(sid).state.activeGoal?.objective;
  }

  it("cancel_goal with confirm:true clears the persisted goal and stops", async () => {
    scriptedToolCall = { toolName: "cancel_goal", args: { confirm: true, reason: "用户说停" } };
    await engine.run("开工", { sessionId: sid, goal: "干到4点一直找问题" });
    expect(activeGoal()).toBeUndefined();
  });

  it("cancel_goal WITHOUT confirm does NOT clear the goal", async () => {
    scriptedToolCall = { toolName: "cancel_goal", args: { reason: "随口" } };
    await engine.run("开工", { sessionId: sid, goal: "干到4点一直找问题" });
    expect(activeGoal()).toBe("干到4点一直找问题");
  });

  it("complete_goal clears the persisted goal (so it doesn't re-arm next send)", async () => {
    scriptedToolCall = { toolName: "complete_goal", args: { summary: "全做完了" } };
    await engine.run("开工", { sessionId: sid, goal: "把任务做完" });
    expect(activeGoal()).toBeUndefined();
  });

  it("after a confirmed cancel, a later bare send does NOT re-inherit the goal", async () => {
    scriptedToolCall = { toolName: "cancel_goal", args: { confirm: true, reason: "停" } };
    await engine.run("开工", { sessionId: sid, goal: "长目标" });
    expect(activeGoal()).toBeUndefined();
    // Bare follow-up: no goal passed, none stored → plain run, goal stays absent.
    await engine.run("随便聊聊", { sessionId: sid });
    expect(activeGoal()).toBeUndefined();
  });
});
