import { expect, test } from "bun:test";
import { sanitizeTraceValue } from "./sanitize.js";

test("deep credentials, arbitrary auth headers and bearer/query strings are scrubbed at every retained depth", () => {
  const secret = {
    apiKey: "DEEP_KEY",
    password: "DEEP_PASSWORD",
    headers: { "x-custom-auth": "CUSTOM_AUTH" },
    text: "Bearer abcdefghijklmnop https://fixture.invalid?a=1&token=QUERY_TOKEN",
  };
  let value: unknown = secret;
  for (let index = 0; index < 20; index++) value = { nested: value };
  const safe = sanitizeTraceValue(value);
  expect(safe.state).toBe("redacted");
  for (const text of [
    "DEEP_KEY",
    "DEEP_PASSWORD",
    "CUSTOM_AUTH",
    "abcdefghijklmnop",
    "QUERY_TOKEN",
  ])
    expect(JSON.stringify(safe.value)).not.toContain(text);
  expect(secret.apiKey).toBe("DEEP_KEY");
});

test("Gemini inline media and OpenAI image response bytes are omitted", () => {
  const safe = sanitizeTraceValue({
    parts: [
      { inline_data: { mime_type: "image/png", data: "GEMINI_PAYLOAD" } },
      { inlineData: { mimeType: "image/jpeg", data: "CAMEL_PAYLOAD" } },
    ],
    images: [{ b64_json: "OPENAI_PAYLOAD" }],
  });
  expect(safe.state).toBe("redacted");
  expect(JSON.stringify(safe.value)).not.toMatch(/GEMINI_PAYLOAD|CAMEL_PAYLOAD|OPENAI_PAYLOAD/);
  expect(safe.value.parts[0].inline_data.mime_type).toBe("image/png");
});

test("sensitive tool-result replacement also scrubs sibling fields", () => {
  const safe = sanitizeTraceValue(
    {
      tool_call_id: "sensitive",
      content: "SECRET_RESULT",
      password: "SECRET_PASSWORD",
      metadata: { apiKey: "SECRET_KEY" },
    },
    new Map([["sensitive", "[withheld]"]]),
  );
  expect(safe.state).toBe("redacted");
  expect(safe.value.content).toBe("[withheld]");
  expect(JSON.stringify(safe.value)).not.toMatch(/SECRET_RESULT|SECRET_PASSWORD|SECRET_KEY/);
});

test("the shared content budget and depth bound report truncation", () => {
  const safe = sanitizeTraceValue(Array.from({ length: 20 }, () => "x".repeat(64 * 1024)));
  expect(safe.state).toBe("truncated");
  expect(JSON.stringify(safe.value).length).toBeLessThan(270_000);
});

test("wire-encoded and incomplete tool argument JSON cannot leak secret values", () => {
  const safe = sanitizeTraceValue({
    tools: [
      { args: '{"nested":{"apiKey":"COMPLETE_SECRET"}}' },
      { args: '{"password":"INCOMPLETE_SECRET' },
    ],
  });
  expect(safe.state).toBe("redacted");
  expect(JSON.stringify(safe.value)).not.toMatch(/COMPLETE_SECRET|INCOMPLETE_SECRET/);
});
