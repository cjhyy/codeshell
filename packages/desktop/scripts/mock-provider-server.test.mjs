import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockProviderServer } from "./mock-provider-server.mjs";

let mock;

beforeAll(async () => {
  mock = await startMockProviderServer();
});

afterAll(async () => {
  await mock.close();
});

async function post(path, body, headers = {}) {
  return fetch(`${mock.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function openAiText(wire) {
  return wire
    .split("\n")
    .filter((line) => line.startsWith("data: {") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)).choices?.[0]?.delta?.content ?? "")
    .join("");
}

describe("mock provider server", () => {
  test("streams OpenAI text and cache usage over real SSE", async () => {
    const response = await post("/v1/chat/completions", {
      model: "usage-with-cache",
      stream: true,
      messages: [{ role: "user", content: "smoke" }],
    });
    const wire = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(wire).toContain("chat.completion.chunk");
    expect(wire).toContain("cached_tokens");
    expect(wire).toContain("data: [DONE]");
  });

  test("streams a partial OpenAI tool call then completes after a tool result", async () => {
    const first = await post("/v1/chat/completions", {
      model: "tool-call",
      stream: true,
      messages: [{ role: "user", content: "use a tool" }],
    });
    const firstWire = await first.text();
    expect(firstWire).toContain("call_codeshell_smoke");
    expect(firstWire).toContain("tool_calls");

    const second = await post("/v1/chat/completions", {
      model: "tool-call",
      stream: true,
      messages: [{ role: "tool", tool_call_id: "call_codeshell_smoke", content: "ok" }],
    });
    expect(openAiText(await second.text())).toContain("smoke tool call completed");
  });

  test("serves the scripted retry failure once and then succeeds", async () => {
    await post("/__mock/reset", {});
    const body = {
      model: "error-then-ok",
      stream: true,
      messages: [{ role: "user", content: "retry" }],
    };
    const first = await post("/v1/chat/completions", body);
    const second = await post("/v1/chat/completions", body);
    expect(first.status).toBe(429);
    expect(second.status).toBe(200);
    expect(openAiText(await second.text())).toContain("retry smoke response completed");
  });

  test("emits the raw Anthropic event sequence", async () => {
    const response = await post("/v1/messages", {
      model: "usage-with-cache",
      stream: true,
      messages: [{ role: "user", content: "smoke" }],
    });
    const wire = await response.text();
    expect(wire).toContain("event: message_start");
    expect(wire).toContain("event: content_block_delta");
    expect(wire).toContain("cache_read_input_tokens");
    expect(wire).toContain("event: message_stop");
  });
});
