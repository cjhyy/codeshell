import { describe, it, expect } from "bun:test";
import {
  deriveModelAlias,
  deriveProviderKey,
  validateAlias,
} from "../src/ui/components/ProviderModelFlow.js";

describe("deriveModelAlias", () => {
  it("strips vendor prefix and deepseek- prefix", () => {
    expect(deriveModelAlias("deepseek/deepseek-v4-flash", [])).toBe("v4-flash");
    expect(deriveModelAlias("anthropic/claude-opus-4-6", [])).toBe("claude-opus-4-6");
    expect(deriveModelAlias("gpt-4o", [])).toBe("gpt-4o");
  });
  it("suffixes -2/-3 on collisions", () => {
    expect(deriveModelAlias("gpt-4o", ["gpt-4o"])).toBe("gpt-4o-2");
    expect(deriveModelAlias("gpt-4o", ["gpt-4o", "gpt-4o-2"])).toBe("gpt-4o-3");
  });
});

describe("deriveProviderKey", () => {
  it("returns kind name when unused", () => {
    expect(deriveProviderKey("deepseek", [])).toBe("deepseek");
  });
  it("suffixes on conflict", () => {
    expect(deriveProviderKey("deepseek", ["deepseek"])).toBe("deepseek-2");
  });
  it("derives from URL host for custom kind", () => {
    expect(deriveProviderKey("https://my.local/v1", [])).toBe("my-local");
  });
});

describe("validateAlias", () => {
  it("rejects empty", () => {
    expect(validateAlias("", [])).toBeTruthy();
  });
  it("rejects duplicates", () => {
    expect(validateAlias("foo", ["foo"])).toBeTruthy();
  });
  it("accepts new unique values", () => {
    expect(validateAlias("foo", ["bar"])).toBeNull();
  });
  it("rejects whitespace-containing", () => {
    expect(validateAlias("with space", [])).toBeTruthy();
  });
});
