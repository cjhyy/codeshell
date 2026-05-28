import { describe, expect, test } from "bun:test";
import {
  redactLlmConfig,
  maskSecretValue,
  isSecretKeyPath,
  makeApiKeyPreview,
} from "../packages/core/src/protocol/redact.js";

/**
 * Task 1 — `query("config")` must never return raw `apiKey` (or other secrets)
 * to a protocol client. Verified at the helper level here; the helper is wired
 * into server.ts:541 and server.ts:707.
 */

describe("redactLlmConfig", () => {
  test("does not include raw apiKey", () => {
    const out = redactLlmConfig({
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "sk-ant-api03-VERY-SECRET-VALUE",
      baseUrl: "https://api.anthropic.com",
    });
    // Property must be absent — not undefined, not empty string.
    expect("apiKey" in out).toBe(false);
    // And no field anywhere holds the raw secret.
    expect(JSON.stringify(out)).not.toContain("VERY-SECRET-VALUE");
  });

  test("surfaces hasApiKey + apiKeyPreview when key is present", () => {
    const out = redactLlmConfig({
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "sk-ant-api03-VERY-SECRET-VALUE",
    });
    expect(out.hasApiKey).toBe(true);
    // Preview reveals the first 3 + last 4 chars only — enough to disambiguate
    // multiple keys in a UI without leaking the secret.
    expect(out.apiKeyPreview).toBe("sk-…ALUE");
  });

  test("hasApiKey is false and no preview when key is missing or empty", () => {
    expect(redactLlmConfig({ provider: "x", model: "y" }).hasApiKey).toBe(false);
    expect(redactLlmConfig({ provider: "x", model: "y" }).apiKeyPreview).toBeUndefined();
    expect(redactLlmConfig({ provider: "x", model: "y", apiKey: "" }).hasApiKey).toBe(false);
  });

  test("forwards non-secret fields verbatim", () => {
    const out = redactLlmConfig({
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "sk-secret",
      baseUrl: "https://example.com",
      temperature: 0.7,
      maxTokens: 4096,
      enableStreaming: true,
    });
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe("claude-opus-4-7");
    expect(out.baseUrl).toBe("https://example.com");
    expect(out.temperature).toBe(0.7);
    expect(out.maxTokens).toBe(4096);
    expect(out.enableStreaming).toBe(true);
  });
});

describe("makeApiKeyPreview", () => {
  test("returns undefined for missing / empty inputs", () => {
    expect(makeApiKeyPreview(undefined)).toBeUndefined();
    expect(makeApiKeyPreview(null)).toBeUndefined();
    expect(makeApiKeyPreview("")).toBeUndefined();
  });

  test("collapses very short keys to a single ellipsis so length isn't leaked", () => {
    // Short keys have too little entropy to safely preview a prefix/suffix.
    expect(makeApiKeyPreview("abc")).toBe("…");
    expect(makeApiKeyPreview("12345678")).toBe("…");
  });

  test("shows prefix + suffix for normal-length keys", () => {
    expect(makeApiKeyPreview("sk-ant-api03-VERY-SECRET-VALUE")).toBe("sk-…ALUE");
  });
});

describe("isSecretKeyPath", () => {
  // The matcher protects config_get from being used as an exfiltration channel
  // by passing dotted paths to secret fields. Anything that ends in apiKey /
  // token / secret / password (in common casing variants) is masked.
  const secrets = [
    "apiKey",
    "llm.apiKey",
    "llm.api_key",
    "providers.anthropic.apiKey",
    "headers.authorization",
    "headers.x-api-key",
    "auth.bearer_token",
    "creds.access_token",
    "creds.refresh_token",
    "secret",
    "db.password",
    "github.client_secret",
  ];
  for (const key of secrets) {
    test(`treats "${key}" as secret`, () => {
      expect(isSecretKeyPath(key)).toBe(true);
    });
  }

  const safe = ["model", "llm.model", "permissionMode", "cwd", "preset", "temperature"];
  for (const key of safe) {
    test(`treats "${key}" as non-secret`, () => {
      expect(isSecretKeyPath(key)).toBe(false);
    });
  }
});

describe("maskSecretValue", () => {
  test("masks the value for a secret key path", () => {
    expect(maskSecretValue("llm.apiKey", "sk-ant-api03-XYZ")).toBe("[redacted]");
    expect(maskSecretValue("headers.authorization", "Bearer xyz")).toBe("[redacted]");
  });

  test("passes through non-secret scalar values unchanged", () => {
    expect(maskSecretValue("model", "claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(maskSecretValue("temperature", 0.7)).toBe(0.7);
    expect(maskSecretValue("permissionMode", "acceptEdits")).toBe("acceptEdits");
  });

  // Regression: pre-fix, masker only inspected the top-level key string.
  // config_get("llm") and config_get("providers") returned objects whose
  // nested apiKey fields were untouched.
  test("recurses into object values (config_get('llm'))", () => {
    const out = maskSecretValue("llm", {
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "sk-ant-LEAKED",
      baseUrl: "https://api.example.com",
    });
    expect(typeof out).toBe("object");
    expect((out as { apiKey: string }).apiKey).toBe("[redacted]");
    expect((out as { provider: string }).provider).toBe("anthropic");
    expect(JSON.stringify(out)).not.toContain("LEAKED");
  });

  test("recurses into arrays of objects (config_get('providers'))", () => {
    const providers = [
      { key: "anthropic", apiKey: "sk-ant-LEAKED-A", baseUrl: "x" },
      { key: "openai", apiKey: "sk-LEAKED-B", baseUrl: "y" },
    ];
    const out = maskSecretValue("providers", providers) as Array<{ apiKey: string }>;
    expect(out[0].apiKey).toBe("[redacted]");
    expect(out[1].apiKey).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("LEAKED");
  });

  test("primitive non-secret values still pass straight through", () => {
    // Sanity: the object-recurse branch must not accidentally walk
    // primitives.
    expect(maskSecretValue("count", 42)).toBe(42);
    expect(maskSecretValue("enabled", true)).toBe(true);
    expect(maskSecretValue("nothing", null)).toBeNull();
  });
});
