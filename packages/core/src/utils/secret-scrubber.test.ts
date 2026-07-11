import { describe, expect, it } from "bun:test";
import { scrubSecrets } from "./secret-scrubber.js";

describe("scrubSecrets", () => {
  it.each([
    ["environment", "OPENAI_API_KEY=sk-live-1234567890abcdef status=ok", ["sk-live-1234567890abcdef"]],
    ["authorization", "Authorization: Bearer header-token-secret\nHTTP 200", ["header-token-secret"]],
    ["URL userinfo", "https://alice:url-password-secret@example.test/private", ["alice", "url-password-secret"]],
    [
      "URL query",
      "https://example.test/?token=query-token-secret&api_key=query-key-secret&safe=ok",
      ["query-token-secret", "query-key-secret"],
    ],
    [
      "JSON and YAML",
      '{"password":"json-password-secret"}\napi_key: yaml-api-key-secret\nsafe: ok',
      ["json-password-secret", "yaml-api-key-secret"],
    ],
    [
      "CLI arguments",
      'deploy --token cli-token-secret --password "cli password secret" --verbose',
      ["cli-token-secret", "cli password secret"],
    ],
    ["provider token", "token is ghp_12345678901234567890", ["ghp_12345678901234567890"]],
  ] as const)("redacts %s credentials", (_label, input, secrets) => {
    const scrubbed = scrubSecrets(input);
    for (const secret of secrets) expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain("[REDACTED]");
  });
});
