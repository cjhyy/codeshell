import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { validateSettings } from "@cjhyy/code-shell-core";
import { probeConfiguredModel } from "./model-probe.js";

// Browser hook suites install a miniature DOM in the shared Bun process. These
// integration tests exercise a native server host; retain the SDK browser guard
// in production and restore the inherited test environment after this file.
const nativeHostGlobals = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const name of ["window", "document"]) {
    nativeHostGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Reflect.deleteProperty(globalThis, name);
  }
});
afterAll(() => {
  for (const [name, descriptor] of nativeHostGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const servers: Server[] = [];
const key = "probe-fixture-secret-never-return";
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function modelServer(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
function settings(baseUrl: string, apiKey: string | undefined = key) {
  return validateSettings({
    credentials: [{ id: "fixture", catalogId: "openai", apiKey }],
    modelConnections: [
      {
        id: "test",
        catalogId: "openai",
        tag: "text",
        model: "fixture-model",
        baseUrl,
        credentialId: "fixture",
      },
    ],
    defaults: { text: "test" },
  });
}
function completion() {
  return {
    id: "fixture-reply",
    object: "chat.completion",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

test("a connection probe uses the real Core client with one bounded tool-free request", async () => {
  let requests = 0;
  const baseUrl = await modelServer(async (req, res) => {
    requests++;
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.model).toBe("fixture-model");
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(32);
    expect(body.tools).toBeUndefined();
    expect(body.stream).not.toBe(true);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion()));
  });
  const result = await probeConfiguredModel(settings(baseUrl), "test");
  expect(result).toMatchObject({
    ok: true,
    connectionId: "test",
    model: "fixture-model",
    code: "connected",
  });
  expect(requests).toBe(1);
  expect(JSON.stringify(result)).not.toContain(key);
});

test("reports provider auth/model/limit errors without echoing bodies or retrying requests", async () => {
  let status = 401;
  let requests = 0;
  const baseUrl = await modelServer((_req, res) => {
    requests++;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `secret echoed ${key}`, type: "provider_error" } }));
  });
  for (const [nextStatus, code] of [
    [401, "unauthorized"],
    [404, "model_unavailable"],
    [429, "rate_limited"],
    [503, "provider_error"],
  ] as const) {
    status = nextStatus;
    const before = requests;
    const result = await probeConfiguredModel(settings(baseUrl), "test");
    expect(result).toMatchObject({ ok: false, code, status });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(requests - before).toBe(1);
  }
});

test("times out a stalled request and supports cancellation without starting fallback models", async () => {
  let requests = 0;
  const baseUrl = await modelServer(() => {
    requests++;
  });
  const result = await probeConfiguredModel(settings(baseUrl), "test", { timeoutMs: 60 });
  expect(result.code).toBe("timeout");
  expect(result.latencyMs).toBeLessThan(1000);
  const controller = new AbortController();
  controller.abort();
  expect(
    (await probeConfiguredModel(settings(baseUrl), "test", { signal: controller.signal })).code,
  ).toBe("cancelled");
  expect(requests).toBe(1);
  expect((await probeConfiguredModel(settings(baseUrl), "missing")).code).toBe(
    "invalid_configuration",
  );
  expect((await probeConfiguredModel({ ...settings(baseUrl), credentials: [] }, "test")).code).toBe(
    "missing_key",
  );
  expect(requests).toBe(1);
});

test("rejects invalid or excessive upstream responses and URL-embedded secrets", async () => {
  let content = "not JSON " + key;
  const baseUrl = await modelServer((_req, res) => {
    res.writeHead(200);
    res.end(content);
  });
  expect((await probeConfiguredModel(settings(baseUrl), "test")).code).toBe("invalid_response");
  content = "x".repeat(1024 * 1024 + 1);
  expect((await probeConfiguredModel(settings(baseUrl), "test")).code).toBe("invalid_response");
  expect((await probeConfiguredModel(settings(baseUrl + "?api_key=secret"), "test")).code).toBe(
    "invalid_configuration",
  );
});

test("Anthropic connections use Core's Anthropic client and message format", async () => {
  let requests = 0;
  const baseUrl = await modelServer(async (req, res) => {
    requests++;
    expect(req.url).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe(key);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.max_tokens).toBe(32);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "anthropic-fixture",
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
  });
  const value = settings(baseUrl.replace(/\/v1$/, ""));
  value.modelConnections[0]!.catalogId = "anthropic";
  value.credentials[0]!.catalogId = "anthropic";
  expect((await probeConfiguredModel(value, "test")).code).toBe("connected");
  expect(requests).toBe(1);
});

test("keyless local connections never inherit an unrelated environment API key", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ambient-fixture-key-must-stay-local";
  try {
    const baseUrl = await modelServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer codeshell-no-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion()));
    });
    const value = settings(baseUrl);
    value.modelConnections[0]!.catalogId = "ollama";
    value.modelConnections[0]!.credentialId = undefined;
    value.credentials = [];
    expect((await probeConfiguredModel(value, "test")).code).toBe("connected");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
