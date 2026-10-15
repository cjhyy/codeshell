import { afterAll, expect, test } from "bun:test";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";
const network = installFixtureNetworkGuard();
afterAll(() => network.restore());
const { validateSettings } = await import("@cjhyy/code-shell-core");
const { probeConfiguredModel } = await import("@cjhyy/code-shell-host");
const { probeConfiguredModel: legacy } = await import("../../../server/src/hub/model-probe.js");
const origin = "http://127.0.0.1:34721";
const key = "fixture-key-never-echo";
function settings() {
  return validateSettings({
    credentials: [{ id: "fixture", catalogId: "openai", apiKey: key }],
    modelConnections: [
      {
        id: "probe",
        catalogId: "openai",
        tag: "text",
        model: "fixture-model",
        baseUrl: `${origin}/v1`,
        credentialId: "fixture",
      },
    ],
    defaults: { text: "probe" },
  });
}
function transport(body: unknown, status = 200) {
  let requests = 0;
  return {
    count: () => requests,
    fetch: (async (input: any, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(new URL(request.url).origin).toBe(origin);
      expect(request.redirect).toBe("error");
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      const payload = await request.json();
      expect(payload.tools).toBeUndefined();
      expect(payload.max_tokens ?? payload.max_completion_tokens).toBe(32);
      requests++;
      return Response.json(body, { status });
    }) as typeof fetch,
  };
}

test("legacy entry forwards Host ownership and a real Core client sends only one tool-free request", async () => {
  expect(legacy).toBe(probeConfiguredModel);
  const f = transport({
    id: "fixture",
    object: "chat.completion",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const result = await probeConfiguredModel(settings(), "probe", { transport: f.fetch });
  expect(result.code).toBe("connected");
  expect(f.count()).toBe(1);
});
test("provider errors and oversized responses remain redacted and never retry", async () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [429, "rate_limited"],
    [503, "provider_error"],
    [200, "invalid_response"],
  ] as const) {
    const f = transport(
      status === 200 ? { secret: key.repeat(100_000) } : { error: { message: key } },
      status,
    );
    const result = await probeConfiguredModel(settings(), "probe", { transport: f.fetch });
    expect(result.code).toBe(code);
    expect(f.count()).toBe(1);
    expect(JSON.stringify(result)).not.toContain(key);
  }
});
test("timeout and owner cancellation settle even when the transport stalls", async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let requests = 0;
    const pending = probeConfiguredModel(settings(), "probe", {
      signal: controller.signal,
      timeoutMs: cancelled ? 2000 : 40,
      transport: (async (input: any, init?: RequestInit) => {
        expect(new URL(new Request(input, init).url).origin).toBe(origin);
        requests++;
        return new Promise(() => {});
      }) as typeof fetch,
    });
    if (cancelled) setTimeout(() => controller.abort(), 25);
    expect((await pending).code).toBe(cancelled ? "cancelled" : "timeout");
    expect(requests).toBeLessThanOrEqual(1);
  }
});
