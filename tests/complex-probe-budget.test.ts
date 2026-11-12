import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LIMITS,
  ROUTING,
  PRIOR_EVIDENCE_SHA256,
  costNanoUsd,
  validateBody,
  reservationForBody,
  openBudgetLedger,
  sendExact,
} from "../docs/todo/prompt-cache-probes-20261111/complex-probe-budget-20261112.mjs";

const PRIOR = resolve(
  import.meta.dir,
  "../docs/todo/prompt-cache-probes-20261111/native-tool-reference-evidence-20261111.json",
);
const KEY = "synthetic-credential-never-print-this";
const directories: string[] = [];
const ledgers: Array<Awaited<ReturnType<typeof openBudgetLedger>>> = [];
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "complex-probe-budget-"));
  directories.push(path);
  return path;
}
async function ledgerAt(path?: string) {
  path ??= join(await directory(), "ledger.json");
  const ledger = await openBudgetLedger(path, { priorEvidencePath: PRIOR });
  ledgers.push(ledger);
  return { path, ledger };
}
function body() {
  return {
    model: LIMITS.model,
    max_tokens: LIMITS.maxOutputTokens,
    stream: false,
    thinking: { type: "disabled" },
    provider: structuredClone(ROUTING),
    tools: [
      {
        name: "ToolSearch",
        description: "Inert search",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
      {
        name: "Synthetic",
        description: "Inert",
        input_schema: { type: "object" },
        defer_loading: true,
      },
    ],
    system: [{ type: "text", text: "Synthetic only", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "Return the synthetic tool call." }],
  };
}
function response(cost = 0.01) {
  return {
    type: "message",
    model: LIMITS.model,
    provider: "Anthropic",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 10,
      cost,
    },
  };
}

// The transport fixture has no socket implementation. Even valid calls cannot leave this process.
function transport(
  mode: "success" | "redirect" | "error" | "oversize" | "timeout" | "aborted" | "throw" = "success",
) {
  let calls = 0;
  const captured: any[] = [];
  const request = (endpoint, options, accept) => {
    calls++;
    captured.push({ endpoint, options });
    if (mode === "throw") throw new Error(KEY);
    const outgoing = new EventEmitter() as any;
    outgoing.destroy = () => outgoing.emit("close");
    outgoing.end = (payload) => {
      captured.at(-1).payload = payload;
      queueMicrotask(() => {
        if (mode === "timeout") return;
        if (mode === "error") return outgoing.emit("error", new Error(KEY));
        const incoming = new EventEmitter() as any;
        incoming.statusCode = mode === "redirect" ? 307 : 200;
        incoming.headers = mode === "redirect" ? { location: "https://untrusted.invalid" } : {};
        incoming.destroy = () => incoming.emit("aborted");
        accept(incoming);
        if (mode === "aborted") return incoming.emit("aborted");
        incoming.emit(
          "data",
          Buffer.from(
            mode === "oversize"
              ? "x".repeat(LIMITS.maxResponseBytes + 1)
              : JSON.stringify(response()),
          ),
        );
        incoming.emit("end");
      });
    };
    return outgoing;
  };
  return {
    request,
    captured,
    get calls() {
      return calls;
    },
  };
}

test("fixed request policy bounds serialization and places only eager cache markers", () => {
  const request = body();
  const serialized = validateBody(request);
  const reservation = reservationForBody(request);
  expect(reservation.bodyBytes).toBe(Buffer.byteLength(serialized));
  expect(reservation.bodyHash).toMatch(/^[a-f0-9]{64}$/);
  expect(reservation.reservationNanoUsd).toBe(
    ((2 * reservation.bodyBytes + 8192) * 8 + 768 * 12) * 1000,
  );
  expect(LIMITS.priorCostNanoUsd).toBe(50_524_600);
  expect(LIMITS.budgetNanoUsd - LIMITS.priorCostNanoUsd).toBe(1_949_475_400);
  request.tools[1].input_schema = {
    type: "object",
    properties: { cache_control: { type: "string" } },
  } as any;
  expect(() => validateBody(request)).not.toThrow();
});

test.each([
  [
    "model",
    (value) => {
      value.model = "different";
    },
  ],
  [
    "output",
    (value) => {
      value.max_tokens++;
    },
  ],
  [
    "stream",
    (value) => {
      value.stream = true;
    },
  ],
  [
    "thinking",
    (value) => {
      value.thinking = { type: "enabled", budget_tokens: 1024 };
    },
  ],
  [
    "fallback",
    (value) => {
      value.provider.allow_fallbacks = true;
    },
  ],
  [
    "price",
    (value) => {
      value.provider.max_price.prompt = 5;
    },
  ],
  [
    "plugin",
    (value) => {
      value.plugins = [{ id: "web" }];
    },
  ],
  [
    "server-tool",
    (value) => {
      value.tools[0].type = "web_search_20250305";
    },
  ],
  [
    "deferred-marker",
    (value) => {
      value.tools[1].cache_control = { type: "ephemeral" };
    },
  ],
  [
    "no-marker",
    (value) => {
      delete value.tools[0].cache_control;
    },
  ],
  [
    "too-many-markers",
    (value) => {
      value.system = Array.from({ length: 4 }, () => ({
        type: "text",
        text: "x",
        cache_control: { type: "ephemeral" },
      }));
    },
  ],
  [
    "unicode",
    (value) => {
      value.messages[0].content = "测试";
    },
  ],
  [
    "oversize",
    (value) => {
      value.messages[0].content = "x".repeat(48_000);
    },
  ],
  [
    "media",
    (value) => {
      value.messages[0].content = [
        { type: "image", source: { type: "url", url: "https://example.invalid" } },
      ];
    },
  ],
])("unsafe request fails before transport construction: %s", (_name, change) => {
  const value = body();
  change(value);
  const fake = transport();
  expect(() => sendExact({ endpoint: LIMITS.endpoint, key: KEY, body: value }, fake)).toThrow();
  expect(fake.calls).toBe(0);
});

test("decimal costs round upward, include tiny charges, and reject unknown values", () => {
  expect(costNanoUsd(0.0505246)).toBe(50_524_600);
  expect(costNanoUsd(1e-10)).toBe(1);
  expect(costNanoUsd(0.0000000011)).toBe(2);
  expect(costNanoUsd(0)).toBe(0);
  for (const value of [null, undefined, "0.01", NaN, Infinity, -1])
    expect(() => costNanoUsd(value)).toThrow();
});

test("ledger reserves durably then releases only the settled difference and carries prior spend across runs", async () => {
  const { path, ledger } = await ledgerAt();
  expect(ledger.snapshot()).toMatchObject({
    priorEvidenceSha256: PRIOR_EVIDENCE_SHA256,
    exposureNanoUsd: 50_524_600,
    pendingRequests: 0,
    newRequests: 0,
    totalRequests: 7,
  });
  const reservation = await ledger.reserve("first", body(), "run-1");
  expect(JSON.parse(await readFile(path, "utf8")).records[0].status).toBe("pending");
  expect(ledger.snapshot().exposureNanoUsd).toBe(50_524_600 + reservation.reservationNanoUsd);
  const billed = await ledger.settle(reservation.id, response());
  expect(billed.usage.totalInput).toBe(150);
  expect(ledger.snapshot().exposureNanoUsd).toBe(60_524_600);
  expect(ledger.snapshot().totalRequests).toBe(8);
  const leaked = ledger.snapshot();
  leaked.records[0].costNanoUsd = 0;
  expect(ledger.snapshot().records[0].costNanoUsd).toBe(10_000_000);
  await ledger.close();
  const reopened = (await ledgerAt(path)).ledger;
  expect(reopened.snapshot().exposureNanoUsd).toBe(60_524_600);
  const second = await reopened.reserve("second", body(), "run-2");
  expect(second.id).toBe(2);
  expect(reopened.snapshot().totalRequests).toBe(9);
  expect(await readFile(path, "utf8")).not.toContain(KEY);
});

test("pending billing and an exclusive lock prevent concurrent or restarted requests", async () => {
  const { path, ledger } = await ledgerAt();
  await expect(openBudgetLedger(path, { priorEvidencePath: PRIOR })).rejects.toThrow("locked");
  const results = await Promise.allSettled([
    ledger.reserve("one", body(), "run"),
    ledger.reserve("two", body(), "run"),
  ]);
  expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
  expect(ledger.snapshot().newRequests).toBe(1);
  await expect(ledger.reserve("three", body(), "run")).rejects.toThrow("Unresolved");
  await ledger.close();
  const reopened = (await ledgerAt(path)).ledger;
  await expect(reopened.reserve("four", body(), "new-run")).rejects.toThrow("Unresolved");
  expect(reopened.snapshot().pendingRequests).toBe(1);
});

test.each([
  "missing-cost",
  "missing-cache",
  "negative-cost",
  "excess-cost",
  "excess-input",
  "excess-output",
  "provider",
  "missing-provider",
  "model",
  "byok",
  "retry",
])("uncertain or out-of-bound billing retains the full reservation: %s", async (mode) => {
  const { path, ledger } = await ledgerAt();
  const reserved = await ledger.reserve("bill", body(), "run");
  const value = response() as any;
  if (mode === "missing-cost") delete value.usage.cost;
  if (mode === "missing-cache") delete value.usage.cache_read_input_tokens;
  if (mode === "negative-cost") value.usage.cost = -1;
  if (mode === "excess-cost") value.usage.cost = reserved.reservationNanoUsd / 1e9 + 0.01;
  if (mode === "excess-input") value.usage.input_tokens = 200_000;
  if (mode === "excess-output") value.usage.output_tokens = 769;
  if (mode === "provider") value.provider = "Other";
  if (mode === "missing-provider") delete value.provider;
  if (mode === "model") value.model = "Other";
  if (mode === "byok") value.usage.is_byok = true;
  if (mode === "retry") value.openrouter_metadata = { attempt: 2 };
  await expect(ledger.settle(reserved.id, value)).rejects.toThrow();
  expect(ledger.snapshot().exposureNanoUsd).toBe(50_524_600 + reserved.reservationNanoUsd);
  expect(JSON.parse(await readFile(path, "utf8")).records[0].status).toBe("pending");
  await expect(ledger.reserve("next", body(), "run")).rejects.toThrow("Unresolved");
});

test("cumulative budget boundary blocks before dispatch rather than spending into the cap", async () => {
  const { ledger } = await ledgerAt();
  const amount = reservationForBody(body()).reservationNanoUsd;
  const count = Math.floor((LIMITS.budgetNanoUsd - LIMITS.priorCostNanoUsd) / amount);
  for (let index = 0; index < count; index++) {
    const record = await ledger.reserve("boundary", body(), "run");
    await ledger.settle(record.id, response(amount / 1e9));
  }
  const before = ledger.snapshot();
  expect(before.remainingNanoUsd).toBeLessThan(amount);
  await expect(ledger.reserve("over-budget", body(), "run")).rejects.toThrow("cap");
  expect(ledger.snapshot()).toEqual(before);
});

test("request count persists independently of inexpensive settlements", async () => {
  const { path, ledger } = await ledgerAt();
  for (let index = 0; index < 80; index++) {
    const record = await ledger.reserve("count", body(), "run");
    await ledger.settle(record.id, response(0));
  }
  await ledger.close();
  const reopened = (await ledgerAt(path)).ledger;
  expect(reopened.snapshot().newRequests).toBe(80);
  await expect(reopened.reserve("eighty-one", body(), "new-run")).rejects.toThrow("cap");
});

test("prior evidence and existing ledgers fail closed without overwriting unknown state", async () => {
  const dir = await directory();
  const prior = join(dir, "prior.json");
  await writeFile(prior, "{}");
  await expect(
    openBudgetLedger(join(dir, "new.json"), { priorEvidencePath: prior }),
  ).rejects.toThrow("digest");
  const path = join(dir, "unknown.json");
  const unknown = JSON.stringify({ version: 999, secret: "preserve" });
  await writeFile(path, unknown);
  await expect(openBudgetLedger(path, { priorEvidencePath: PRIOR })).rejects.toThrow(
    "initialization",
  );
  expect(await readFile(path, "utf8")).toBe(unknown);
  await expect(openBudgetLedger("relative.json", { priorEvidencePath: PRIOR })).rejects.toThrow(
    "Absolute",
  );
});

test("failed ledger persistence prevents admission and poisons the open instance", async () => {
  const { path, ledger } = await ledgerAt();
  await writeFile(path + ".pending", "unknown pending state");
  await expect(ledger.reserve("write-fails", body(), "run")).rejects.toThrow("write failed");
  await expect(ledger.reserve("later", body(), "run")).rejects.toThrow("failed");
  expect(await readFile(path + ".pending", "utf8")).toBe("unknown pending state");
});

test("one HTTPS request uses fixed TLS/headers, and redirects are returned without following", async () => {
  for (const mode of ["success", "redirect"] as const) {
    const fake = transport(mode);
    const result = await sendExact({ endpoint: LIMITS.endpoint, key: KEY, body: body() }, fake);
    expect(result.status).toBe(mode === "redirect" ? 307 : 200);
    expect(fake.calls).toBe(1);
    expect(fake.captured[0].options).toMatchObject({
      method: "POST",
      agent: false,
      rejectUnauthorized: true,
    });
    expect(fake.captured[0].options.headers["Content-Length"]).toBe(
      Buffer.byteLength(fake.captured[0].payload),
    );
  }
  const fake = transport();
  expect(() =>
    sendExact({ endpoint: "https://other.invalid", key: KEY, body: body() }, fake),
  ).toThrow("exact URL");
  expect(fake.calls).toBe(0);
});

test.each(["error", "oversize", "timeout", "aborted", "throw"] as const)(
  "transport %s never retries, exposes no credential, and leaves the reservation pending",
  async (mode) => {
    const { ledger } = await ledgerAt();
    const record = await ledger.reserve("transport", body(), "run");
    const fake = transport(mode);
    try {
      await sendExact({ endpoint: LIMITS.endpoint, key: KEY, body: body(), timeoutMs: 5 }, fake);
      throw new Error("Expected failed transport");
    } catch (error) {
      expect(String(error)).toContain("no retry");
      expect(String(error)).not.toContain(KEY);
    }
    expect(fake.calls).toBe(1);
    expect(ledger.snapshot().exposureNanoUsd).toBe(
      LIMITS.priorCostNanoUsd + record.reservationNanoUsd,
    );
    expect(ledger.snapshot().pendingRequests).toBe(1);
    await expect(ledger.reserve("later", body(), "run")).rejects.toThrow("Unresolved");
  },
);
