import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderProxy, normalizeUsage, redact } from "../evals/harness/provider-proxy.mjs";
import { loadModelConnection, selectConnection } from "../evals/harness/model-config.mjs";

const resources = [];
afterEach(async () => {
  for (const proxy of resources.splice(0)) await proxy.close();
});
const model = {
  model: "fixture-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "upstream-secret",
};
async function proxyWith(fetchImpl, budget) {
  const proxy = await createProviderProxy({ model, fetchImpl, budget });
  resources.push(proxy);
  return proxy;
}
const send = (proxy, body = {}) =>
  fetch(`${proxy.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${proxy.apiKey}` },
    body: JSON.stringify({
      model: model.model,
      messages: [{ role: "user", content: "synthetic task" }],
      ...body,
    }),
  });
const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;

test("passes real content, clamps output budget, captures usage but never authentication", async () => {
  let request;
  const proxy = await proxyWith(
    async (url, init) => {
      request = { url, ...init, body: JSON.parse(init.body) };
      return Response.json({
        model: "actual-model",
        choices: [{ message: { content: "provider answer" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.01 },
      });
    },
    { maxOutputTokens: 256 },
  );
  expect((await (await send(proxy, { max_tokens: 10000 })).json()).choices[0].message.content).toBe(
    "provider answer",
  );
  expect(request.url).toBe("https://provider.example/v1/chat/completions");
  expect(request.headers.authorization).toBe("Bearer upstream-secret");
  expect(request.body.max_tokens).toBe(256);
  expect(proxy.requests[0].usage).toEqual({
    inputTokens: 12,
    outputTokens: 3,
    totalTokens: 15,
    costUsd: 0.01,
  });
  expect(proxy.requests[0].responseModels).toEqual(["actual-model"]);
  expect(JSON.stringify(proxy.requests)).not.toContain("upstream-secret");
  expect(JSON.stringify(proxy.requests)).not.toContain(proxy.apiKey);
});

test("gate delivers actual fragmented unicode SSE before pausing and resumes unchanged", async () => {
  const content =
    sse({ choices: [{ delta: { content: "真实文字" } }] }) +
    sse({ choices: [{ delta: { content: "继续" } }], usage: { total_tokens: 8 } }) +
    "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(content);
  const proxy = await proxyWith(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const ticket = proxy.holdNextText({ minTextChars: 4 });
  const response = await send(proxy, { stream: true });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("真实文字");
  expect(first).not.toContain("继续");
  expect((await proxy.waitForHold(ticket)).deliveredText).toBe("真实文字");
  expect(proxy.requests[0].finished).toBe(false);
  proxy.release(ticket);
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += new TextDecoder().decode(chunk.value);
  }
  expect(first + rest).toBe(content);
  expect(proxy.requests[0].faultInjection.kind).toBe("pause_after_real_text");
  expect(proxy.requests[0].usage.costUsd).toBe(null);
});

test("concurrent requests reserve the budget before upstream calls", async () => {
  let count = 0;
  const proxy = await proxyWith(
    async () => {
      count++;
      return Response.json({ choices: [] });
    },
    { maxRequests: 1 },
  );
  const responses = await Promise.all([send(proxy), send(proxy)]);
  await Promise.all(responses.map((response) => response.text()));
  expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
  expect(count).toBe(1);
});

test("rejects wrong routes/models/auth and records provider failures without keys", async () => {
  let count = 0;
  const proxy = await proxyWith(async () => {
    count++;
    throw new Error("provider upstream-secret failed");
  });
  expect((await fetch(`${proxy.baseUrl}/chat/completions`)).status).toBe(401);
  expect((await send(proxy, { model: "unrequested-model" })).status).toBe(502);
  const result = await send(proxy);
  expect(await result.text()).not.toContain("upstream-secret");
  expect(count).toBe(1);
  expect(JSON.stringify(proxy.requests)).not.toContain("upstream-secret");
});

test("aborting a held downstream cancels upstream and reports unknown usage", async () => {
  // The live CLI runs on Node. Bun 1.3's node:http shim does not deliver a
  // disconnected held response's close event; verify cancellation on Node.
  const output = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
    import { createProviderProxy } from ${JSON.stringify(new URL("../evals/harness/provider-proxy.mjs", import.meta.url).href)};
    let signal;
    const proxy = await createProviderProxy({model:${JSON.stringify(model)},fetchImpl:async (_url,init)=>{
      signal=init.signal;
      return new Response(${JSON.stringify(sse({ choices: [{ delta: { content: "partial" } }] }) + "data: [DONE]\n\n")},{headers:{"content-type":"text/event-stream"}});
    }});
    try {
      const ticket=proxy.holdNextText(); const abort=new AbortController();
      await fetch(proxy.baseUrl+"/chat/completions",{method:"POST",headers:{authorization:"Bearer "+proxy.apiKey},body:JSON.stringify({model:${JSON.stringify(model.model)},stream:true}),signal:abort.signal});
      await proxy.waitForHold(ticket); abort.abort();
      for(let i=0;i<100&&!signal.aborted;i++) await new Promise(resolve=>setTimeout(resolve,5));
      console.log(JSON.stringify({aborted:signal.aborted,recordAborted:proxy.requests[0].aborted,usage:proxy.requests[0].usage}));
    } finally { await proxy.close(); }
  `,
    ],
    { timeout: 5000, encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual({ aborted: true, recordAborted: true, usage: null });
});

test("missing usage remains unknown and redaction preserves token counts", () => {
  expect(normalizeUsage()).toBe(null);
  expect(normalizeUsage({ completion_tokens: 0 }).outputTokens).toBe(0);
  expect(normalizeUsage({ completion_tokens: 0 }).inputTokens).toBe(null);
  expect(normalizeUsage({ cost: -10 }).costUsd).toBe(null);
  expect(redact({ apiKey: "abc", max_tokens: 20, text: "contains abc" }, ["abc"])).toEqual({
    apiKey: "[REDACTED]",
    max_tokens: 20,
    text: "contains [REDACTED]",
  });
});

test("malformed settings errors never quote a credential fragment", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "eval-config-test-"));
  try {
    await writeFile(join(settingsHome, "settings.json"), '{"apiKey":SYNTHETIC_PRIVATE_FRAGMENT}');
    await expect(loadModelConnection({ settingsHome })).rejects.toThrow(
      "Could not read or parse model settings",
    );
    try {
      await loadModelConnection({ settingsHome });
    } catch (error) {
      expect(error.message).not.toContain("SYNTHETIC_PRIVATE_FRAGMENT");
    }
  } finally {
    await rm(settingsHome, { recursive: true, force: true });
  }
});

test("request deadline releases a held stream and closes the downstream", async () => {
  const proxy = await proxyWith(
    async () =>
      new Response(sse({ choices: [{ delta: { content: "held" } }] }) + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    { requestTimeoutMs: 100 },
  );
  const ticket = proxy.holdNextText();
  const response = await send(proxy, { stream: true });
  await proxy.waitForHold(ticket);
  await response.text().catch(() => {});
  expect(proxy.requests[0].error).toBe("request_timeout");
  expect(proxy.requests[0].aborted).toBe(true);
});

test("connection selection uses endpoint precedence without copying settings", () => {
  const settings = {
    defaults: { text: "selected" },
    hooks: { private: true },
    modelConnections: [
      {
        id: "selected",
        tag: "text",
        catalogId: "fixture",
        model: "fixture-model",
        credentialId: "cred",
        baseUrl: "https://connection.example/v1",
      },
    ],
    credentials: [
      {
        id: "cred",
        catalogId: "fixture",
        apiKey: "secret",
        baseUrl: "https://credential.example/v1",
      },
    ],
  };
  const catalog = [
    {
      id: "fixture",
      protocol: "openai-compat",
      adapterKind: "openrouter",
      defaultBaseUrl: "https://default.example/v1",
    },
  ];
  expect(selectConnection(settings, catalog).baseUrl).toBe("https://connection.example/v1");
  expect(selectConnection(settings, catalog).hooks).toBeUndefined();
  settings.credentials[0].catalogId = "wrong";
  expect(() => selectConnection(settings, catalog)).toThrow("Cross-catalog");
});
