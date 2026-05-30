import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveApiKey, PROVIDERS } from "./onboarding.js";
import { sanitizeApiKey } from "./llm/api-key-sanitize.js";

// Regression: resolveApiKey only `.trim()`'d env values, while detectEnvKeys
// sanitized them (CRLF/BOM/control chars). A key pasted with hidden chars
// reached downstream uncleaned (review-2026-05-30). resolveApiKey should use
// the same sanitizeApiKey boundary.

const ENV_KEYS = PROVIDERS.map((p) => p.envKey).filter(Boolean) as string[];

describe("resolveApiKey env sanitization", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("strips interior control chars + BOM that .trim() would miss", () => {
    // Leading BOM (U+FEFF) and an interior CR: .trim() leaves both,
    // sanitizeApiKey removes both. This is where the old trim-only path
    // diverged.
    const dirty = "﻿sk-abc\r123";
    process.env[ENV_KEYS[0]] = dirty;
    const resolved = resolveApiKey();
    expect(resolved).toBe("sk-abc123");
    expect(resolved).toBe(sanitizeApiKey(dirty).value);
    // Prove the old behavior (.trim()) would NOT have cleaned this.
    expect(dirty.trim()).not.toBe("sk-abc123");
  });

  test("explicit option key is returned as-is (precedence preserved)", () => {
    process.env[ENV_KEYS[0]] = "env-key";
    expect(resolveApiKey("opt-key")).toBe("opt-key");
  });
});
