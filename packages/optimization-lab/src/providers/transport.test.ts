import { expect, test } from "bun:test";
import { executeText, runTrial } from "../runner.js";
import { resolveSelectedConnection } from "./connection.js";
import { createMeteredFetch, type MeterAccounting } from "./metered-fetch.js";
import type { ResolvedConnection } from "./connection.js";
import type { ExperimentPlan } from "../contracts/experiment.js";
import type { EvalCase } from "../contracts/eval-case.js";

function connection(provider: "openai" | "anthropic"): ResolvedConnection {
  return {
    config: {
      provider,
      providerKind: provider,
      model: "lab-fixture",
      apiKey: "never-persist-this",
      baseUrl: "http://localhost:9001",
    },
    identity: {
      connectionId: provider,
      providerKind: provider,
      modelId: "lab-fixture",
      endpoint: "http://localhost:9001",
      configHash: "a".repeat(64),
      credentialRevision: null,
      outputCapCoversReasoning: "unknown",
      pricing: {
        inputPerMillion: null,
        outputPerMillion: null,
        cachedInputPerMillion: null,
        source: null,
        date: null,
      },
    },
    temperature: 0.3,
    wireParameters: { temperature: 0.3 },
  };
}
const limits = {
  maxRequests: 3,
  maxOutputTokens: 100,
  timeoutMs: 1000,
  inputTokenUpperBound: 4096,
};
function accounting(max = 3): MeterAccounting & { count: number; observations: unknown[] } {
  return {
    count: 0,
    observations: [],
    check() {},
    admit() {
      if (this.count >= max) throw new Error("no budget");
      this.count++;
      return { deadlineAt: Date.now() + 1000 };
    },
    dispatch() {},
    finish(observation) {
      this.observations.push(observation);
    },
  };
}

for (const provider of ["openai", "anthropic"] as const)
  test(`${provider} actual client stays tool-free and records authoritative usage`, async () => {
    const a = accounting();
    const payloads: any[] = [];
    const result = await executeText({
      connection: connection(provider),
      systemPrompt: "frozen skill",
      input: "this input only",
      limits,
      maxContextBytes: 10000,
      accounting: a,
      upstream: (async (request) => {
        payloads.push(await (request as Request).json());
        return new Response(
          JSON.stringify(
            provider === "openai"
              ? {
                  id: "resp",
                  object: "chat.completion",
                  created: 1,
                  model: "lab-fixture",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "good" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
                }
              : {
                  id: "resp",
                  type: "message",
                  model: "lab-fixture",
                  role: "assistant",
                  content: [{ type: "text", text: "good" }],
                  stop_reason: "end_turn",
                  usage: { input_tokens: 12, output_tokens: 4 },
                },
          ),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    expect(result.status).toBe("completed");
    expect(result.text).toBe("good");
    expect(a.count).toBe(1);
    expect(result.observations[0]?.usage?.inputTokens).toBe(12);
    expect(result.observations[0]?.usage?.reasoningTokens).toBeNull();
    expect(JSON.stringify(result)).not.toContain("never-persist");
    expect(payloads[0].tools).toBeUndefined();
  });

test("strict selected connection never falls back to a usable default", () => {
  const settings = {
    modelConnections: [{ id: "default", tag: "text", catalogId: "openai", model: "gpt-4.1" }],
    defaults: { text: "default" },
    credentials: [],
  } as any;
  expect(() => resolveSelectedConnection(settings, "deleted")).toThrow("missing");
});

test("actual compatibility/SDK retries each need a fresh admission and cannot change parameters", async () => {
  const a = accounting(1);
  let upstream = 0;
  const metered = createMeteredFetch({
    connection: connection("openai"),
    limits,
    maxContextBytes: 10000,
    accounting: a,
    upstream: (async () => {
      upstream++;
      return new Response(JSON.stringify({ error: { message: "no" } }), { status: 429 });
    }) as typeof fetch,
  });
  const body = {
    model: "lab-fixture",
    messages: [{ role: "user", content: "input" }],
    max_tokens: 100,
    temperature: 0.3,
  };
  await metered.fetch("http://localhost:9001/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  });
  await expect(
    metered.fetch("http://localhost:9001/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  ).rejects.toThrow("no budget");
  await expect(
    metered.fetch("http://localhost:9001/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...body, temperature: undefined }),
    }),
  ).rejects.toThrow();
  expect(upstream).toBe(1);
  expect(metered.observations[0]?.outcome).toBe("unknown");
});

test("target request cannot receive expected, rubric, sibling or holdout data", async () => {
  const item = {
    id: "dev",
    input: "current input",
    readiness: "runnable",
    fixtureRefs: [],
    expected: "SECRET_EXPECTED",
    rubric: [{ id: "sem", text: "SECRET_RUBRIC", requiresHumanGrading: true }],
    hardAssertions: [{ id: "good", kind: "contains", value: "good" }],
  } as EvalCase;
  let payload = "";
  const trial = await runTrial({
    plan: {
      planHash: "p",
      skill: { body: "frozen" },
      bounds: { trial: limits, maxContextBytes: 10000 },
    } as ExperimentPlan,
    case: item,
    body: "frozen",
    phase: "baseline",
    repeat: 0,
    connection: connection("openai"),
    accounting: accounting(),
    upstream: (async (request) => {
      payload = await (request as Request).text();
      return new Response(
        JSON.stringify({
          model: "lab-fixture",
          choices: [{ message: { content: "good" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  expect(payload).toContain("current input");
  expect(payload).not.toContain("SECRET_EXPECTED");
  expect(payload).not.toContain("SECRET_RUBRIC");
  expect(trial.semanticStatus).toBe("not_evaluated");
  expect(trial.assertions[0]?.passed).toBe(true);
});
