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

  // F2: a short UseCredential token rides inside a STRING value under a benign
  // key (the bridge logs a whole JSON-RPC line under `raw`). Key-name redaction
  // misses it; content scrubbing must catch it.
  test("scrubs a secret embedded in a JSON string under a benign key (raw)", () => {
    const raw = JSON.stringify({
      method: "agent/streamEvent",
      result: { kind: "value", value: "ghp_abc123DEF456ghi789" },
    });
    const out = redactSecrets({ raw }) as { raw: string };
    expect(out.raw).not.toContain("ghp_abc123DEF456ghi789");
    expect(out.raw).toContain("[REDACTED]");
    // Structure/keys preserved for debugging — only the secret is gone.
    expect(out.raw).toContain("agent/streamEvent");
  });

  test('scrubs "value":"…"/"token":"…" pairs and prefixed tokens in a raw line', () => {
    const raw = 'x {"token":"s3cr3t-XYZ"} and Bearer aGVsbG8gd29ybGQ= and sk-liveKEY12345';
    const out = redactSecrets({ raw }) as { raw: string };
    expect(out.raw).not.toContain("s3cr3t-XYZ");
    expect(out.raw).not.toContain("aGVsbG8gd29ybGQ=");
    expect(out.raw).not.toContain("sk-liveKEY12345");
  });

  test("does NOT mangle ordinary log strings", () => {
    const out = redactSecrets({ msg: "opened file src/a.ts:12 and ran 3 tools" }) as {
      msg: string;
    };
    expect(out.msg).toBe("opened file src/a.ts:12 and ran 3 tools");
  });
});
