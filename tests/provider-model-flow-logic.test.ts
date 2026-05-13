import { describe, it, expect } from "bun:test";
import {
  deriveModelAlias,
  deriveProviderKey,
  validateAlias,
} from "../src/ui/components/ProviderModelFlow.js";

describe("deriveModelAlias", () => {
  it("strips vendor prefix; without providerKind keeps base id", () => {
    expect(deriveModelAlias("deepseek/deepseek-v4-flash", [])).toBe("deepseek-v4-flash");
    expect(deriveModelAlias("anthropic/claude-opus-4-6", [])).toBe("claude-opus-4-6");
    expect(deriveModelAlias("gpt-4o", [])).toBe("gpt-4o");
  });
  it("prepends providerKind unless model id already carries it", () => {
    expect(deriveModelAlias("v4-flash", [], "deepseek")).toBe("deepseek-v4-flash");
    // model id already starts with provider name — don't duplicate
    expect(deriveModelAlias("deepseek-v4-pro", [], "deepseek")).toBe("deepseek-v4-pro");
    expect(deriveModelAlias("openai/gpt-5", [], "openai")).toBe("openai-gpt-5");
    expect(deriveModelAlias("claude-opus-4-6", [], "anthropic")).toBe(
      "anthropic-claude-opus-4-6",
    );
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
