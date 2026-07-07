import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveMaxContextTokens } from "./max-context-tokens.js";

describe("resolveMaxContextTokens", () => {
  test("prefers the model connection maxContextTokens over settings.context.maxTokens", () => {
    expect(resolveMaxContextTokens({ maxContextTokens: 128_000 }, 64_000)).toBe(128_000);
  });

  test("falls back to settings.context.maxTokens when the model connection omits it", () => {
    expect(resolveMaxContextTokens({}, 64_000)).toBe(64_000);
  });

  test("falls back to 200_000 when both values are missing", () => {
    expect(resolveMaxContextTokens({}, undefined)).toBe(200_000);
  });

  test("REPL uses the shared resolver instead of duplicating fallback logic", () => {
    const replSource = readFileSync(new URL("./repl.ts", import.meta.url), "utf-8");

    expect(replSource).toContain(
      'import { resolveMaxContextTokens } from "./max-context-tokens.js";',
    );
    expect(replSource).toContain(
      "const maxContextTokens = resolveMaxContextTokens(llmConfig, settings.context.maxTokens);",
    );
    expect(replSource).not.toContain(
      "llmConfig.maxContextTokens ?? settings.context.maxTokens ?? 200_000",
    );
  });
});
