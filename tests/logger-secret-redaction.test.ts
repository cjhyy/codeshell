import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../packages/core/src/logging/sanitize-messages.js";

/**
 * Task 5 — logger / diagnostics must scrub secret-shaped values before
 * persisting structured entries. The redactor is the single seam: it lives
 * in logging/sanitize-messages.ts and runs on both `entry.d` (write path)
 * and the in-memory error ring (diagnostics path).
 */

describe("redactSecrets — flat objects", () => {
  test("redacts apiKey", () => {
    const out = redactSecrets({ apiKey: "sk-ant-VERY-SECRET" });
    expect(out.apiKey).toBe("[redacted]");
  });

  test("redacts a variety of common secret key names", () => {
    const out = redactSecrets({
      apiKey: "x",
      api_key: "x",
      "X-API-Key": "x",
      authorization: "Bearer x",
      Authorization: "Bearer x",
      accessToken: "x",
      access_token: "x",
      refreshToken: "x",
      bearer_token: "x",
      password: "x",
      secret: "x",
      client_secret: "x",
      cookie: "x",
      session_token: "x",
    });
    for (const key of Object.keys(out)) {
      expect(out[key as keyof typeof out]).toBe("[redacted]");
    }
  });

  test("preserves null / undefined / empty-string presence", () => {
    // We want consumers to still distinguish "key absent" from "key present
    // but empty" — only non-empty values collapse to [redacted].
    const out = redactSecrets({
      apiKey: null,
      authorization: undefined,
      password: "",
    });
    expect(out.apiKey).toBeNull();
    expect(out.authorization).toBeUndefined();
    expect(out.password).toBe("");
  });

  test("leaves non-secret fields verbatim", () => {
    const out = redactSecrets({
      provider: "anthropic",
      model: "claude-opus-4-7",
      temperature: 0.7,
      streaming: true,
      cwd: "/Users/x/proj",
    });
    expect(out).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
      temperature: 0.7,
      streaming: true,
      cwd: "/Users/x/proj",
    });
  });
});

describe("redactSecrets — nested structures", () => {
  test("recurses into nested objects", () => {
    const out = redactSecrets({
      llm: {
        provider: "anthropic",
        apiKey: "sk-secret",
        nested: { authorization: "Bearer xyz" },
      },
    });
    expect(out.llm.apiKey).toBe("[redacted]");
    expect(out.llm.nested.authorization).toBe("[redacted]");
    expect(out.llm.provider).toBe("anthropic");
  });

  test("recurses through arrays of headers / env entries", () => {
    const out = redactSecrets({
      headers: [
        { name: "authorization", value: "Bearer sk_live_DEADBEEF12345" },
        { name: "content-type", value: "application/json" },
      ],
    });
    // The key is `value`, not a secret-shaped key, so the *value* string
    // matters: the Bearer-pattern catcher must scrub it (when the token is
    // plausibly long enough — short values like "Bearer foo" pass through,
    // see the dedicated test in the string-patterns block).
    expect(out.headers[0].value).toBe("Bearer [redacted]");
    expect(out.headers[1].value).toBe("application/json");
  });

  test("redacts secret-shaped key/value pairs nested in arrays", () => {
    const out = redactSecrets([{ apiKey: "x" }, { token: "y" }, { ok: "z" }]);
    expect(out[0].apiKey).toBe("[redacted]");
    expect(out[1].token).toBe("[redacted]");
    expect(out[2].ok).toBe("z");
  });
});

describe("redactSecrets — string-level patterns", () => {
  test("scrubs Bearer tokens in free text", () => {
    expect(
      redactSecrets("auth header was: Bearer sk_live_DEADBEEF12345"),
    ).toBe("auth header was: Bearer [redacted]");
  });

  test("does not over-match short Bearer values (false positives)", () => {
    // The minimum token length (8 chars) is intentional — `Bearer foo` is
    // too short to be a credible token; we leave it alone.
    expect(redactSecrets("Bearer foo")).toBe("Bearer foo");
  });

  test("scrubs credential-looking URL query params", () => {
    const out = redactSecrets(
      "GET https://api.example.com/v1/things?api_key=DEADBEEF&id=42",
    );
    expect(out).toBe("GET https://api.example.com/v1/things?api_key=[redacted]&id=42");
  });

  test("leaves benign URL query params alone", () => {
    expect(redactSecrets("GET https://example.com/?q=hello&page=2")).toBe(
      "GET https://example.com/?q=hello&page=2",
    );
  });
});

describe("redactSecrets — Error objects", () => {
  test("Error.message has Bearer scrubbed", () => {
    const e = new Error("failed: Bearer sk_live_DEADBEEF12345");
    const out = redactSecrets(e) as { message: string; name: string };
    expect(out.message).toBe("failed: Bearer [redacted]");
    expect(out.name).toBe("Error");
  });

  test("Error with attached config object — secret-key fields are scrubbed", () => {
    const e = Object.assign(new Error("boom"), {
      config: { apiKey: "x", baseUrl: "y" },
    });
    const out = redactSecrets(e) as { config: { apiKey: string; baseUrl: string } };
    expect(out.config.apiKey).toBe("[redacted]");
    expect(out.config.baseUrl).toBe("y");
  });
});

describe("redactSecrets — guards", () => {
  test("returns primitives unchanged", () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  test("does not mutate the input", () => {
    const input = { llm: { apiKey: "secret" } };
    const out = redactSecrets(input);
    expect(input.llm.apiKey).toBe("secret"); // original intact
    expect(out.llm.apiKey).toBe("[redacted]");
  });

  test("handles deep nesting without infinite recursion", () => {
    let nested: Record<string, unknown> = { apiKey: "x" };
    for (let i = 0; i < 50; i++) nested = { layer: nested };
    // Depth-cap kicks in well before the call stack does.
    expect(() => redactSecrets(nested)).not.toThrow();
  });
});
