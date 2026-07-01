import { describe, test, expect } from "bun:test";
import { redactSecrets } from "./sanitize-messages.js";

/**
 * redactSecrets is the central log-redaction applied to EVERY log line's
 * msg+data (logger.ts). It's the last line of defense against leaking API
 * keys / tokens / cookies into ~/.code-shell/logs. Pure + security-critical,
 * so its contract is pinned here directly — a future weakening of SECRET_KEY_RE
 * or the Bearer/URL scrubbers must turn this red.
 */
describe("redactSecrets", () => {
  test("redacts values of secret-named object keys", () => {
    const out = redactSecrets({
      apiKey: "sk-proj-123",
      authorization: "Bearer abc",
      access_token: "t",
      "x-api-key": "k",
      client_secret: "cs",
      cookie: "SID=x",
      password: "p",
    }) as Record<string, string>;
    for (const k of Object.keys(out)) {
      expect(out[k], `${k} must be redacted`).toBe("[redacted]");
    }
  });

  test("preserves non-secret keys", () => {
    const out = redactSecrets({ name: "alice", count: 3, model: "gpt-5" }) as Record<string, unknown>;
    expect(out.name).toBe("alice");
    expect(out.count).toBe(3);
    expect(out.model).toBe("gpt-5");
  });

  test("recurses into nested objects and arrays", () => {
    const out = redactSecrets({
      outer: { token: "secret", ok: "keep" },
      list: [{ apiKey: "sk-1" }, { label: "fine" }],
    }) as any;
    expect(out.outer.token).toBe("[redacted]");
    expect(out.outer.ok).toBe("keep");
    expect(out.list[0].apiKey).toBe("[redacted]");
    expect(out.list[1].label).toBe("fine");
  });

  test("scrubs a bare Bearer token in a free string", () => {
    const out = redactSecrets("Authorization: Bearer sk-proj-ABCDEF1234567890");
    expect(out).not.toContain("sk-proj-ABCDEF1234567890");
    expect(out).toContain("Bearer [redacted]");
  });

  test("scrubs credential query params in a URL string", () => {
    const out = redactSecrets("GET https://api.x.com/v1?api_key=SECRETVALUE&q=hello");
    expect(out).not.toContain("SECRETVALUE");
    expect(out).toContain("q=hello"); // non-secret param preserved
  });

  test("preserves presence of an empty/null secret value (distinguish present-vs-absent)", () => {
    const out = redactSecrets({ apiKey: "", token: null }) as Record<string, unknown>;
    expect(out.apiKey).toBe("");
    expect(out.token).toBeNull();
  });

  test("leaves primitives untouched", () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets("plain text")).toBe("plain text");
  });

  // A custom auth header keyed by a non-secret-looking name (e.g.
  // `x-custom-auth`) would slip through the per-key SECRET_KEY_RE match. Any
  // value inside a headers container is a header value → treat the whole
  // container as sensitive. Guards config_get("providers") from returning
  // provider.httpHeaders values in cleartext.
  test("redacts ALL values inside a headers container, incl. non-secret-named keys", () => {
    const out = redactSecrets({
      httpHeaders: { "x-custom-auth": "s3cr3t", "x-tenant": "acme-123" },
      headers: { "my-signing-key": "deadbeef" },
      defaultHeaders: { "x-app-token": "tok-xyz" },
    }) as any;
    expect(out.httpHeaders["x-custom-auth"]).toBe("[redacted]");
    expect(out.httpHeaders["x-tenant"]).toBe("[redacted]");
    expect(out.headers["my-signing-key"]).toBe("[redacted]");
    expect(out.defaultHeaders["x-app-token"]).toBe("[redacted]");
  });

  test("preserves header presence for empty/null values", () => {
    const out = redactSecrets({ headers: { "x-a": "", "x-b": null } }) as any;
    expect(out.headers["x-a"]).toBe("");
    expect(out.headers["x-b"]).toBeNull();
  });

  test("a non-headers key literally named 'header' is not blanket-redacted", () => {
    // Only the known header-container keys trip the blanket rule; an ordinary
    // field whose name merely contains 'header' recurses normally.
    const out = redactSecrets({ headerText: "visible", pageHeader: { title: "keep" } }) as any;
    expect(out.headerText).toBe("visible");
    expect(out.pageHeader.title).toBe("keep");
  });
});
