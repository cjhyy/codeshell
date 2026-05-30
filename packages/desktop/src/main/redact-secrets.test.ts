import { describe, test, expect } from "bun:test";
import { redactSecrets } from "./redact-secrets.js";

// Regression: renderer log data was written to the log file verbatim, which
// could persist secrets (review-2026-05-30, security/low). redactSecrets masks
// values whose KEY name looks secret-bearing, recursively, leaving other data
// intact for debugging.

describe("redactSecrets", () => {
  test("masks values of secret-named keys", () => {
    expect(redactSecrets({ apiKey: "sk-123", token: "abc", password: "p" })).toEqual({
      apiKey: "[REDACTED]",
      token: "[REDACTED]",
      password: "[REDACTED]",
    });
  });

  test("keeps non-secret keys untouched", () => {
    expect(redactSecrets({ user: "bob", count: 3 })).toEqual({ user: "bob", count: 3 });
  });

  test("is case-insensitive and matches substrings (accessToken, refresh_token)", () => {
    const out = redactSecrets({ accessToken: "x", refresh_token: "y", APISecret: "z" });
    expect(out).toEqual({ accessToken: "[REDACTED]", refresh_token: "[REDACTED]", APISecret: "[REDACTED]" });
  });

  test("recurses into nested objects and arrays", () => {
    const out = redactSecrets({ a: { password: "p", ok: 1 }, list: [{ token: "t" }] });
    expect(out).toEqual({ a: { password: "[REDACTED]", ok: 1 }, list: [{ token: "[REDACTED]" }] });
  });

  test("returns undefined unchanged", () => {
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  test("does NOT redact 'author'/'authors' (auth matches only as a segment)", () => {
    const out = redactSecrets({ author: "Alice", authors: ["Bob"], authToken: "x", authorization: "y" });
    expect(out).toEqual({
      author: "Alice",
      authors: ["Bob"],
      authToken: "[REDACTED]",
      authorization: "[REDACTED]",
    });
  });

  test("handles circular references without infinite recursion", () => {
    const obj: Record<string, unknown> = { name: "x" };
    obj.self = obj;
    const out = redactSecrets(obj) as Record<string, unknown>;
    expect(out.name).toBe("x");
    expect(out.self).toBe("[CIRCULAR]");
  });
});
