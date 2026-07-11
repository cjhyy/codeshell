import { describe, expect, it } from "bun:test";
import { scrubSecrets, scrubSecretValue } from "./secret-scrubber.js";

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

  it("preserves ordinary evidence byte-for-byte", () => {
    const input = [
      "build completed successfully",
      "https://example.test/docs?section=install",
      '{"name":"release","title":"Status","description":"all checks passed"}',
    ].join("\n");
    expect(scrubSecrets(input)).toBe(input);
  });

  it("scrubs YAML blocks and continuations while preserving sibling evidence", () => {
    const input = [
      "password: |",
      "  literal-secret-one",
      "  literal-secret-two",
      "status: healthy",
      "api_key: folded-secret-one",
      "  folded-secret-two",
      "description: retained evidence",
    ].join("\n");

    expect(scrubSecrets(input)).toBe(
      [
        "password: [REDACTED]",
        "status: healthy",
        "api_key: [REDACTED]",
        "description: retained evidence",
      ].join("\n"),
    );
  });

  it("handles large inputs without throwing or superlinear slowdown", () => {
    for (const input of [" ".repeat(40_000), `password: ${"s".repeat(40_000)}`]) {
      const startedAt = performance.now();
      const scrubbed = scrubSecrets(input);
      expect(typeof scrubbed).toBe("string");
      expect(performance.now() - startedAt).toBeLessThan(500);
    }
  });
});

describe("scrubSecretValue", () => {
  it("redacts sensitive object keys across case and separator variants", () => {
    expect(
      scrubSecretValue({
        password: "password-value",
        API_Key: "api-key-value",
        "client-secret": "client-secret-value",
        RefreshToken: "refresh-token-value",
        headers: { AUTHORIZATION: "Bearer header-value", Accept: "application/json" },
        name: "visible-name",
      }),
    ).toEqual({
      password: "[REDACTED]",
      API_Key: "[REDACTED]",
      "client-secret": "[REDACTED]",
      RefreshToken: "[REDACTED]",
      headers: { AUTHORIZATION: "[REDACTED]", Accept: "application/json" },
      name: "visible-name",
    });
  });

  it("does not redact normal business keys", () => {
    const input = {
      name: "Ada",
      title: "Release status",
      description: "Everything passed",
      metadata: { count: 3, enabled: true },
    };
    expect(scrubSecretValue(input)).toEqual(input);
  });

  it("preserves design-token business fields while redacting exact credential keys", () => {
    expect(
      scrubSecretValue({
        designToken: "spacing-large",
        color_token: "brand-blue-500",
        colorToken: "surface-muted",
        access_token: "access-value",
        refresh_token: "refresh-value",
        client_secret: "client-value",
        api_key: "api-value",
        "Access-Token": "header-access-value",
      }),
    ).toEqual({
      designToken: "spacing-large",
      color_token: "brand-blue-500",
      colorToken: "surface-muted",
      access_token: "[REDACTED]",
      refresh_token: "[REDACTED]",
      client_secret: "[REDACTED]",
      api_key: "[REDACTED]",
      "Access-Token": "[REDACTED]",
    });
  });
});
