import { describe, expect, it } from "bun:test";
import {
  createGoalStopHook,
  goalJudgeCachePlan,
  GOAL_JUDGE_CACHE_PURPOSE,
  type GoalJudgeLLM,
  type GoalJudgeRuntimeContext,
} from "./goal-stop-hook.js";
import { auxPromptCacheScope } from "../llm/aux-prompt-cache.js";
import type { PromptCacheRequestContext } from "../llm/prompt-cache.js";
import { OpenAIClient } from "../llm/providers/openai.js";
import { PromptCacheHistory } from "../llm/prompt-cache.js";
import type { LLMResponse, Message } from "../types.js";

/**
 * The goal judge is an auxiliary call with its own cache scope. Its JSON input
 * keeps what every judgment changes (previous verdict, current time) after the
 * goal and the conversation, so that prefix can be read from cache.
 */

const SID = "goal-judge-cache-session";
const VERDICT = '{"met": false, "waiting": false, "gaps": "还差测试"}';
const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

function context(renderedConversation: string, digest: string): GoalJudgeRuntimeContext {
  return {
    conversation: [],
    renderedConversation,
    digest,
    selectedRoundCount: 1,
    sourceRoundCount: 1,
    estimatedTokens: 10,
    chars: renderedConversation.length,
    truncated: false,
  };
}

interface JudgeCall {
  messages: Message[];
  promptCache?: PromptCacheRequestContext;
}

function recordingJudge(cacheStrategy?: string): GoalJudgeLLM & { calls: JudgeCall[] } {
  const calls: JudgeCall[] = [];
  return {
    calls,
    ...(cacheStrategy ? { getPromptCacheConfigIdentity: () => ({ cacheStrategy }) } : {}),
    async createMessage(options): Promise<LLMResponse> {
      calls.push({ messages: options.messages, promptCache: options.promptCache });
      return { text: VERDICT, toolCalls: [] };
    },
  };
}

const joined = (call: JudgeCall): string =>
  call.messages.map((message) => message.content as string).join("");

/** Two judgments over the same conversation, a minute apart. */
async function judgeTwice(llm: GoalJudgeLLM, sessionId: string | null = SID) {
  const data = { ...(sessionId === null ? {} : { sessionId }) };
  let clock = new Date("2026-11-17T08:00:00.000Z");
  const hook = createGoalStopHook({
    goal: { objective: "发布 1.0", setAtMs: Date.parse("2026-11-17T07:00:00.000Z") },
    llm,
    log: noopLog,
    now: () => clock,
    getJudgeContext: () => context("[round 1]\nASSISTANT:\n写完了代码", "aaaaaaaaaaaaaaaa"),
  });
  await hook({ eventName: "on_stop", data: { ...data, finalText: "one" } });
  clock = new Date("2026-11-17T08:01:00.000Z");
  await hook({ eventName: "on_stop", data: { ...data, finalText: "two" } });
}

describe("goal judge prompt cache", () => {
  it("orders the judge input stable first and per-judgment fields last", async () => {
    const llm = recordingJudge();
    await judgeTwice(llm);
    expect(llm.calls).toHaveLength(2);
    for (const call of llm.calls) {
      expect(call.messages).toHaveLength(1);
      expect(Object.keys(JSON.parse(joined(call)))).toEqual([
        "目标",
        "目标设定于",
        "最近的完整对话",
        "untrustedBackgroundTasks",
        "上一轮裁决",
        "当前时间",
        "requestedOutput",
      ]);
    }
  });

  it("sends the judge's own auxiliary scope on routes without markers", async () => {
    const llm = recordingJudge("openai-implicit");
    await judgeTwice(llm);
    for (const call of llm.calls) {
      expect(call.messages).toHaveLength(1);
      expect(call.promptCache).toEqual({
        scopeId: auxPromptCacheScope(SID, GOAL_JUDGE_CACHE_PURPOSE),
        scopeKind: "auxiliary",
      });
    }
    expect(llm.calls[0]!.promptCache!.scopeId).not.toBe(SID);
  });

  it("splits at the end of the stable fields on marker routes", async () => {
    const llm = recordingJudge("anthropic-explicit");
    await judgeTwice(llm);
    const [first, second] = llm.calls;
    for (const call of [first!, second!]) {
      expect(call.messages).toHaveLength(2);
      expect(call.promptCache).toMatchObject({
        scopeId: auxPromptCacheScope(SID, GOAL_JUDGE_CACHE_PURPOSE),
        scopeKind: "auxiliary",
        stablePrefixMessageCount: 1,
      });
      // The two messages together are still exactly one JSON object.
      expect(JSON.parse(joined(call))["当前时间"]).toBeString();
      expect(call.messages[0]!.content as string).not.toContain("上一轮裁决");
      expect(call.messages[1]!.content as string).toStartWith('\n  "上一轮裁决"');
    }
    // Same goal and conversation: the stable message is byte-identical while
    // the previous verdict and the clock change.
    expect(second!.messages[0]).toEqual(first!.messages[0]!);
    expect(second!.messages[1]).not.toEqual(first!.messages[1]!);
  });

  it("sends no scope without a session id", async () => {
    const llm = recordingJudge("anthropic-explicit");
    await judgeTwice(llm, null);
    for (const call of llm.calls) {
      expect(call.messages).toHaveLength(1);
      expect(call.promptCache).toBeUndefined();
    }
  });

  it("puts a prompt_cache_key on the OpenAI wire", async () => {
    const bodies: any[] = [];
    const client = new OpenAIClient(
      {
        provider: "openai",
        providerKind: "openrouter",
        model: "openai/gpt-5.4",
        apiKey: "test",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      { retryMaxAttempts: 1 },
      {
        promptCacheHistory: new PromptCacheHistory(),
        auxPromptCacheHistory: new PromptCacheHistory(),
      },
    );
    (client as any)._client = {
      chat: {
        completions: {
          create: async (body: any) => {
            bodies.push(structuredClone(body));
            return {
              choices: [
                { message: { role: "assistant", content: VERDICT }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
            };
          },
        },
      },
    };
    await judgeTwice(client);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].prompt_cache_key).toBeString();
    expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key);
  });
});

describe("goalJudgeCachePlan", () => {
  it("rejoins to the original content", () => {
    const stableFields = { a: "x", b: { quoted: '"}\n,' } };
    const content = JSON.stringify({ ...stableFields, c: 1 }, null, 2);
    const plan = goalJudgeCachePlan(stableFields, content);
    expect(plan.stable).toHaveLength(1);
    expect(plan.stable.join("") + plan.volatile).toBe(content);
    expect(plan.volatile).toBe('\n  "c": 1\n}');
  });

  it("keeps everything volatile when the stable fields are not the leading keys", () => {
    const content = JSON.stringify({ c: 1, a: "x" }, null, 2);
    expect(goalJudgeCachePlan({ a: "x" }, content)).toEqual({
      purpose: GOAL_JUDGE_CACHE_PURPOSE,
      stable: [],
      volatile: content,
    });
  });
});
