import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLedger } from "./store.js";
import { withUsageOwner } from "./context.js";
import { createLLMClient } from "../llm/client-factory.js";
import { LLMClientBase } from "../llm/client-base.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  LLMClientBase.onUsage = undefined;
});
const identity = { provider: "openai", model: "gpt-4o" };
const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
function directory() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-cost-"));
  roots.push(root);
  return root;
}
function bill(ledger: UsageLedger, sid: string, ancestors: string[] = []) {
  const receipt = ledger.begin(ledger.owner(sid, "run", ancestors), identity);
  ledger.settle(receipt, usage);
  ledger.finish(receipt, "completed");
  return receipt;
}
function jsonResponse(extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: "test",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      ...extra,
    }),
    { headers: { "content-type": "application/json" } },
  );
}
const options = { systemPrompt: "", messages: [{ role: "user" as const, content: "test" }] };

test("same SID in two Runtimes is isolated; restart requires its matching persisted reference", () => {
  const storageDir = directory();
  const first = new UsageLedger({ storageDir });
  const second = new UsageLedger({ storageDir });
  bill(first, "same");
  bill(second, "same");
  expect(first.summary().requests).toBe(1);
  expect(second.summary().requests).toBe(1);
  expect(first.summary({ scope: "session", sessionId: "same" }).requests).toBe(1);
  expect(second.summary({ scope: "session", sessionId: "same" }).requests).toBe(1);
  expect(first.summary({ scope: "store" }).requests).toBe(2);
  const restarted = new UsageLedger({ storageDir });
  expect(restarted.summary({ scope: "session", sessionId: "same" }).requests).toBe(0);
  expect(restarted.adoptSession("same", first.sessionState("same"))).toBe(true);
  expect(restarted.summary({ scope: "session", sessionId: "same" }).requests).toBe(1);
  expect(restarted.adoptSession("fork", first.sessionState("same"))).toBe(false);
  const foreign = new UsageLedger({ storageDir, namespace: "another-host" });
  expect(foreign.adoptSession("same", first.sessionState("same"))).toBe(false);
  expect(foreign.summary({ scope: "store" }).requests).toBe(0);
});

test("parent rollup includes each child receipt once while Runtime sums only leaves", () => {
  const ledger = new UsageLedger();
  bill(ledger, "parent");
  bill(ledger, "child", ["parent"]);
  bill(ledger, "child", ["parent"]);
  expect(ledger.summary().requests).toBe(3);
  expect(ledger.summary({ scope: "session", sessionId: "parent" }).requests).toBe(1);
  expect(
    ledger.summary({ scope: "session", sessionId: "parent", includeChildren: true }).requests,
  ).toBe(3);
  expect(ledger.summary({ scope: "session", sessionId: "child" }).requests).toBe(2);
});

test("unknown pricing, missing usage, pending and corrupt records never become free requests", () => {
  const storageDir = directory();
  const ledger = new UsageLedger({ storageDir });
  const owner = ledger.owner("source");
  const unpriced = ledger.begin(owner, { provider: "custom", model: "gpt-4o" });
  ledger.settle(unpriced, usage);
  ledger.finish(unpriced, "completed");
  ledger.begin(owner, identity);
  const summary = ledger.summary();
  expect(summary.unknownCostRequests).toBe(2);
  expect(summary.unknownUsageRequests).toBe(1);
  expect(summary.knownEstimatedCostUsd).toBe(0);
  const folder = join(storageDir, readdirSync(storageDir)[0]!);
  writeFileSync(join(folder, `${"a".repeat(64)}.json`), "broken");
  const restarted = new UsageLedger({ storageDir });
  expect(restarted.summary({ scope: "store" }).partial).toBe(true);
  expect(restarted.summary({ scope: "store" }).unknownUsageRequests).toBe(1);
  expect(restarted.summary({ scope: "store", limit: 1 }).nextCursor).toBeDefined();
});

test("external receipts deduplicate across restart and reject conflicting usage/owners", () => {
  const storageDir = directory();
  const ledger = new UsageLedger({ storageDir });
  const input = { ...identity, source: "external-test", requestId: "physical-call-1", usage };
  const reference = ledger.sessionState("source");
  ledger.recordExternal(ledger.owner("source"), input);
  ledger.recordExternal(ledger.owner("source"), input);
  expect(ledger.summary().requests).toBe(1);
  const restarted = new UsageLedger({ storageDir });
  restarted.adoptSession("source", reference);
  restarted.recordExternal(restarted.owner("source"), input);
  expect(restarted.summary({ scope: "session", sessionId: "source" }).requests).toBe(1);
  expect(() => ledger.recordExternal(ledger.owner("other"), input)).toThrow("conflict");
  expect(() =>
    ledger.recordExternal(ledger.owner("source"), {
      ...input,
      usage: { ...usage, promptTokens: 200 },
    }),
  ).toThrow("conflict");
  const folder = join(storageDir, readdirSync(storageDir)[0]!);
  const raw = readFileSync(join(folder, readdirSync(folder)[0]!), "utf8");
  expect(raw).not.toContain("test-secret");
  expect(JSON.parse(raw).pricing.source).toBe("model-metadata");
});

test("ledger and legacy observer exceptions cannot cause additional paid provider attempts", async () => {
  const storageDir = directory();
  const ledger = new UsageLedger({ storageDir });
  // A regular file at the configured root forces all durable writes to fail.
  rmSync(storageDir, { recursive: true });
  writeFileSync(storageDir, "blocked");
  let calls = 0;
  const client = await createLLMClient(
    { ...identity, apiKey: "test-secret", baseUrl: "http://localhost:1/v1" },
    {
      retryMaxAttempts: 3,
      fetch: (async () => {
        calls++;
        return jsonResponse();
      }) as typeof fetch,
    },
  );
  LLMClientBase.onUsage = () => {
    throw new Error("observer unavailable");
  };
  const response = await withUsageOwner(ledger.owner("source"), () =>
    client.createMessage(options),
  );
  expect(response.text).toBe("ok");
  expect(calls).toBe(1);
  expect(ledger.summary().requests).toBe(1);
  expect(ledger.summary().partial).toBe(true);
  expect(ledger.summary().persistenceErrors).toBeGreaterThan(0);
});

test("physical SDK retries are separate receipts; missing provider usage remains unknown", async () => {
  const ledger = new UsageLedger();
  let calls = 0;
  const client = await createLLMClient(
    { ...identity, apiKey: "test-secret", baseUrl: "http://localhost:1/v1" },
    {
      retryMaxAttempts: 1,
      fetch: (async () => {
        calls++;
        return calls === 1
          ? new Response('{"error":{"message":"retry"}}', {
              status: 500,
              headers: { "content-type": "application/json", "retry-after-ms": "1" },
            })
          : jsonResponse({ usage: undefined });
      }) as typeof fetch,
    },
  );
  await withUsageOwner(ledger.owner("source"), () => client.createMessage(options));
  expect(calls).toBe(2);
  expect(ledger.summary().requests).toBe(2);
  expect(ledger.summary().unknownUsageRequests).toBe(2);
});

test("reported usage survives response parsing failure", async () => {
  const ledger = new UsageLedger();
  let calls = 0;
  const client = await createLLMClient(
    { ...identity, apiKey: "test-secret", baseUrl: "http://localhost:1/v1" },
    {
      retryMaxAttempts: 1,
      fetch: (async () => {
        calls++;
        return jsonResponse({ choices: [] });
      }) as typeof fetch,
    },
  );
  await expect(
    withUsageOwner(ledger.owner("source"), () => client.createMessage(options)),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(ledger.summary().requests).toBe(1);
  expect(ledger.summary().unknownUsageRequests).toBe(0);
  expect(ledger.summary().promptTokens).toBe(100);
});

test("streamed billing survives a consumer error and a later fallback gets its own receipt", async () => {
  const ledger = new UsageLedger();
  let calls = 0;
  const client = await createLLMClient(
    { ...identity, apiKey: "test-secret", baseUrl: "http://localhost:1/v1" },
    {
      retryMaxAttempts: 1,
      fetch: (async () => {
        calls++;
        if (calls > 1) return jsonResponse();
        const chunk = {
          id: "test",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    },
  );
  await withUsageOwner(ledger.owner("source"), async () => {
    await expect(
      client.createMessage({
        ...options,
        stream: true,
        onChunk: () => {
          throw new Error("consumer failed");
        },
      }),
    ).rejects.toThrow();
    await client.createMessage(options);
  });
  expect(calls).toBe(2);
  expect(ledger.summary().requests).toBe(2);
  expect(ledger.summary().promptTokens).toBe(200);
  expect(ledger.summary().unknownUsageRequests).toBe(0);
});
