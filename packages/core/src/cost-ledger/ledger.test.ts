import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";
const network = installFixtureNetworkGuard();
afterAll(() => network.restore());
const { UsageLedger } = await import("./store.js");
const { withUsageOwner } = await import("./context.js");
const { createLLMClient } = await import("../llm/client-factory.js");
const { LLMClientBase } = await import("../llm/client-base.js");

const roots: string[] = [];
let browserGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
beforeEach(() => {
  // Bun shares a process with renderer suites. Their mini-DOM must not make
  // these real server SDK calls look like credential-bearing browser calls.
  browserGlobals = ["window", "document"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  for (const [name] of browserGlobals) Reflect.deleteProperty(globalThis, name);
});
afterEach(() => {
  for (const [name, descriptor] of browserGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  browserGlobals = [];
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
function bill(ledger: InstanceType<typeof UsageLedger>, sid: string, ancestors: string[] = []) {
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

test("ownership references do not read or summarize historical receipts", () => {
  const ledger = new UsageLedger({ storageDir: directory() });
  const scan = spyOn(ledger, "summary").mockImplementation(() => {
    throw new Error("history scan on admission");
  });
  try {
    const reference = ledger.sessionReference("one", "/scope");
    expect(reference).toMatchObject({ kind: "usage-ledger", sessionId: "one" });
    expect(reference).not.toHaveProperty("summary");
    const restarted = new UsageLedger();
    expect(restarted.adoptSession("one", reference, "/scope")).toBe(true);
    expect(restarted.adoptSession("one", reference, "/other")).toBe(false);
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
  }
});

test("fresh readers share parsed receipts without sharing runtime or Session owners", () => {
  const storageDir = directory();
  const writer = new UsageLedger({ storageDir });
  const receipt = bill(writer, "same");
  const reference = writer.sessionReference("same");
  const originalParse = JSON.parse;
  let receiptParses = 0;
  const parse = spyOn(JSON, "parse").mockImplementation((raw, reviver) => {
    if (typeof raw === "string" && raw.includes(receipt.requestId)) receiptParses++;
    return originalParse(raw, reviver);
  });
  const now = spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  try {
    const first = new UsageLedger({ storageDir });
    expect(first.adoptSession("same", reference)).toBe(true);
    expect(first.summary({ scope: "session", sessionId: "same" }).requests).toBe(1);
    expect(receiptParses).toBe(1);
    const second = new UsageLedger({ storageDir });
    expect(second.summary({ scope: "session", sessionId: "same" }).requests).toBe(0);
    expect(second.summary().requests).toBe(0);
    expect(second.adoptSession("same", reference)).toBe(true);
    expect(second.summary({ scope: "session", sessionId: "same" }).requests).toBe(1);
    expect(receiptParses).toBe(1);
    const folder = join(storageDir, readdirSync(storageDir)[0]!);
    const file = join(folder, `${receipt.requestId}.json`);
    writeFileSync(
      `${file}.tmp`,
      JSON.stringify({ ...receipt, usage: { ...usage, promptTokens: 300, totalTokens: 320 } }),
    );
    renameSync(`${file}.tmp`, file);
    const third = new UsageLedger({ storageDir });
    expect(third.adoptSession("same", reference)).toBe(true);
    expect(third.summary({ scope: "session", sessionId: "same" }).promptTokens).toBe(300);
    expect(receiptParses).toBe(2);
    rmSync(file);
    expect(first.summary({ scope: "session", sessionId: "same" }).requests).toBe(0);
    const anotherRoot = new UsageLedger({ storageDir: directory() });
    expect(anotherRoot.summary({ scope: "store" }).requests).toBe(0);
    const anotherNamespace = new UsageLedger({ storageDir, namespace: "other" });
    expect(anotherNamespace.summary({ scope: "store" }).requests).toBe(0);
    expect(anotherNamespace.adoptSession("same", reference)).toBe(false);
  } finally {
    parse.mockRestore();
    now.mockRestore();
  }
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

test("disabled nested billing clears the parent's HTTP attempt context", async () => {
  const { withUsageAttempt, usageTrackingFetch, recordOwnedUsage } = await import("./context.js");
  const ledger = new UsageLedger();
  const tracked = usageTrackingFetch((async () => jsonResponse()) as typeof fetch);
  await withUsageOwner(ledger.owner("parent"), () =>
    withUsageAttempt(identity, true, async () => {
      await tracked("http://localhost/parent");
      recordOwnedUsage(identity, usage);
      await withUsageAttempt(identity, false, () => tracked("http://localhost/unbilled"));
    }),
  );
  expect(ledger.summary().requests).toBe(1);
  expect(ledger.summary().unknownUsageRequests).toBe(0);
});

test("identical SIDs in different identity stores stay separate in one Runtime", () => {
  const ledger = new UsageLedger();
  for (const scope of ["alice", "bob"]) {
    const receipt = ledger.begin(ledger.owner("same", undefined, [], "main", scope), identity);
    ledger.settle(receipt, usage);
    ledger.finish(receipt, "completed");
  }
  expect(ledger.summary().requests).toBe(2);
  expect(ledger.summary().bySession).toHaveLength(2);
  expect(ledger.summary({ scope: "session", sessionId: "same" }, "alice").requests).toBe(1);
  expect(ledger.summary({ scope: "session", sessionId: "same" }, "bob").requests).toBe(1);
});

test("direct SDK construction accounts real localhost retry attempts and explicitly reported zero usage", async () => {
  const { OpenAIClient } = await import("../llm/providers/openai.js");
  const { currentUsageAttempt } = await import("./context.js");
  const ledger = new UsageLedger();
  const ids: string[] = [];
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      if (calls === 1)
        return new Response('{"error":{"message":"retry"}}', {
          status: 500,
          headers: { "content-type": "application/json", "retry-after-ms": "1" },
        });
      return jsonResponse({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    },
  });
  network.allowOrigin(`http://127.0.0.1:${server.port}`);
  try {
    const client = new OpenAIClient(
      { ...identity, apiKey: "synthetic", baseUrl: `http://127.0.0.1:${server.port}/v1` },
      {
        retryMaxAttempts: 1,
        fetch: ((...args: Parameters<typeof fetch>) => {
          ids.push(currentUsageAttempt()!.requestId);
          return fetch(new Request(new Request(...args), { redirect: "error" }));
        }) as typeof fetch,
      },
    );
    await withUsageOwner(ledger.owner("source"), () => client.createMessage(options));
    expect(calls).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(ledger.summary().requests).toBe(2);
    expect(ledger.summary().unknownCostRequests).toBe(1);
    expect(ledger.summary().unknownUsageRequests).toBe(1);
    expect(ledger.summary().knownEstimatedCostUsd).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("two processes cannot overwrite an external receipt after both observe it absent", async () => {
  const storageDir = directory();
  const gate = join(storageDir, "gate");
  const modulePath = fileURLToPath(new URL("./store.ts", import.meta.url));
  const code = `import { UsageLedger } from ${JSON.stringify(modulePath)};
    import { existsSync, writeFileSync } from 'node:fs';
    const [root, ready, gate] = process.argv.slice(-3);
    const ledger = new UsageLedger({storageDir:root});
    const original = ledger.begin.bind(ledger);
    ledger.begin = (...args) => {
      writeFileSync(ready, 'ready');
      const until = Date.now()+5000;
      while (!existsSync(gate)) { if(Date.now()>until) throw new Error('barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }
      return original(...args);
    };
    try { ledger.recordExternal(ledger.owner('same'), {provider:'openai',model:'gpt-4o',source:'receipt-fixture',requestId:'one',usage:{promptTokens:100,completionTokens:20,totalTokens:120}}); console.log('written'); }
    catch(error) { console.log(error.message); }`;
  const ready = [join(storageDir, "one.ready"), join(storageDir, "two.ready")];
  const processes = ready.map((file) =>
    Bun.spawn([process.execPath, "--eval", code, storageDir, file, gate], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const { existsSync } = await import("node:fs");
  try {
    const deadline = Date.now() + 5000;
    while (!ready.every(existsSync)) {
      if (Date.now() > deadline)
        throw new Error("children did not reach the external write barrier");
      await Bun.sleep(10);
    }
    writeFileSync(gate, "go");
    const outputs = await Promise.all(
      processes.map(async (child) => {
        const out = await new Response(child.stdout).text();
        const err = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        expect(err).toBe("");
        return out.trim();
      }),
    );
    expect(outputs.sort()).toEqual(["External usage identity conflict", "written"]);
    expect(new UsageLedger({ storageDir }).summary({ scope: "store" }).requests).toBe(1);
  } finally {
    for (const child of processes) child.kill();
  }
});

function foreignSessionLedger(sid: string) {
  const storageDir = directory();
  const writer = new UsageLedger({ storageDir });
  const receipt = bill(writer, sid);
  // A second Runtime (worker restart, another process) sees the receipt only on
  // disk. Its clock is past the settle window, so unchanged files are cacheable.
  const reader = new UsageLedger({ storageDir, now: () => Date.now() + 60_000 });
  expect(reader.adoptSession(sid, writer.sessionState(sid))).toBe(true);
  const folder = join(storageDir, readdirSync(storageDir)[0]!);
  return { reader, file: join(folder, `${receipt.requestId}.json`) };
}

test.skipIf(process.platform === "win32")(
  "an in-place restore that keeps inode, size and mtime still invalidates a cached receipt",
  () => {
    const { reader, file } = foreignSessionLedger("restored");
    // A fixed past mtime can be restored exactly after the rewrite below.
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(reader.summary({ scope: "session", sessionId: "restored" }).promptTokens).toBe(100);
    const before = lstatSync(file);
    // Let the coarse kernel clock advance so the rewrite gets a new ctime.
    Bun.sleepSync(50);
    const original = readFileSync(file, "utf8");
    const rewritten = original
      .replace('"promptTokens":100', '"promptTokens":300')
      .replace('"totalTokens":120', '"totalTokens":320');
    expect(rewritten.length).toBe(original.length);
    writeFileSync(file, rewritten); // same inode, same size
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    const after = lstatSync(file);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    expect(reader.summary({ scope: "session", sessionId: "restored" }).promptTokens).toBe(300);
  },
);

test("cached foreign receipts follow atomic rewrites and deletions by other ledgers", () => {
  const { reader, file } = foreignSessionLedger("rewritten");
  expect(reader.summary({ scope: "session", sessionId: "rewritten" }).promptTokens).toBe(100);
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  receipt.usage = { promptTokens: 300, completionTokens: 20, totalTokens: 320 };
  writeFileSync(`${file}.tmp`, JSON.stringify(receipt));
  renameSync(`${file}.tmp`, file);
  expect(reader.summary({ scope: "session", sessionId: "rewritten" }).promptTokens).toBe(300);
  rmSync(file);
  expect(reader.summary({ scope: "session", sessionId: "rewritten" }).requests).toBe(0);
});

test("legacy coverage gaps remain explicit after the Session reference is saved and restored", () => {
  const ledger = new UsageLedger();
  ledger.noteHistoricalGap("legacy");
  bill(ledger, "legacy");
  const reference = ledger.sessionState("legacy");
  const restarted = new UsageLedger();
  expect(restarted.adoptSession("legacy", reference)).toBe(true);
  expect(restarted.summary({ scope: "session", sessionId: "legacy" }).partial).toBe(true);
});

test("copied Session references cannot adopt the same SID in another storage scope", () => {
  const storageDir = directory();
  const ledger = new UsageLedger({ storageDir });
  const owner = ledger.owner("same", undefined, [], "main", "/private/session-scope-A");
  const receipt = ledger.begin(owner, identity);
  ledger.settle(receipt, usage);
  ledger.finish(receipt, "completed");
  const reference = ledger.sessionState("same", "/private/session-scope-A");
  expect(reference.sessionScopeId).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(reference)).not.toContain("/private/session-scope-A");
  expect(ledger.adoptSession("same", reference, "/private/session-scope-B")).toBe(false);
  expect(
    ledger.summary({ scope: "session", sessionId: "same" }, "/private/session-scope-B").requests,
  ).toBe(0);
  const restarted = new UsageLedger({ storageDir });
  expect(
    restarted.adoptSession("same", structuredClone(reference), "/private/session-scope-B"),
  ).toBe(false);
  expect(
    restarted.adoptSession("same", structuredClone(reference), "/private/session-scope-A"),
  ).toBe(true);
  expect(
    restarted.summary({ scope: "session", sessionId: "same" }, "/private/session-scope-A").requests,
  ).toBe(1);
  const unpinned = { ...reference, sessionScopeId: undefined };
  expect(
    new UsageLedger({ storageDir }).adoptSession("same", unpinned, "/private/session-scope-A"),
  ).toBe(false);
});

test("public ledger queries reject malformed scope, ownership and pagination before scanning", () => {
  const ledger = new UsageLedger({ storageDir: directory() });
  for (const invalid of [
    null,
    [],
    { scope: "bogus" },
    { scope: null },
    { sessionId: 7 },
    { sessionId: "" },
    { includeChildren: "true" },
    { includeChildren: 1 },
    { limit: null },
    { cursor: 42 },
    { since: 2, until: 1 },
  ]) {
    expect(() => ledger.summary(invalid as never)).toThrow("Invalid usage query");
  }
  expect(() => ledger.summary({ scope: "session" })).toThrow("Session is required");
  expect(ledger.summary().persistenceErrors).toBe(0);
});
