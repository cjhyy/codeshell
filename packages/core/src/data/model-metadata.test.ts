import { describe, it, expect } from "bun:test";
import {
  KNOWN_MAX_OUTPUT,
  KNOWN_CONTEXT_WINDOWS,
  OPENROUTER_VENDORS,
} from "./model-metadata.js";
import { resolveMaxOutput, resolveContextWindow } from "../onboarding.js";

/**
 * Phase-1 extraction guard: the model-metadata tables moved out of
 * onboarding.ts into data/model-metadata.json. These pin the values so a
 * typo in the JSON (or an accidental drop during a future edit) is caught,
 * and confirm onboarding's resolvers still read them.
 */
describe("model-metadata data layer", () => {
  it("loads the known-max-output table (direct-provider ids)", () => {
    // Representative entries spanning vendors + both id forms.
    expect(KNOWN_MAX_OUTPUT["claude-opus-4-7"]).toBe(32000);
    expect(KNOWN_MAX_OUTPUT["anthropic/claude-opus-4-7"]).toBe(32000);
    expect(KNOWN_MAX_OUTPUT["gpt-5-nano"]).toBe(16000);
    expect(KNOWN_MAX_OUTPUT["o3"]).toBe(100000);
    expect(KNOWN_MAX_OUTPUT["deepseek-v4-pro"]).toBe(65536);
  });

  it("loads the known-context-window table", () => {
    expect(KNOWN_CONTEXT_WINDOWS["deepseek-v4-pro"]).toBe(1_000_000);
    expect(KNOWN_CONTEXT_WINDOWS["deepseek/deepseek-chat"]).toBe(1_000_000);
  });

  it("loads the curated OpenRouter vendor order", () => {
    expect(OPENROUTER_VENDORS.map((v) => v.prefix)).toEqual([
      "anthropic/",
      "openai/",
      "google/",
      "deepseek/",
      "x-ai/",
      "qwen/",
      "meta-llama/",
      "mistralai/",
    ]);
    expect(OPENROUTER_VENDORS[0]).toEqual({ prefix: "anthropic/", take: 4 });
  });

  it("onboarding resolvers read the extracted tables (direct-provider lookup)", () => {
    // resolveMaxOutput/resolveContextWindow hit the KNOWN_* tables first for
    // ids without a vendor snapshot entry; these are direct-provider ids.
    expect(resolveMaxOutput("claude-opus-4-7")).toBe(32000);
    expect(resolveMaxOutput("o4-mini")).toBe(100000);
    expect(resolveContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    // An id known to neither table nor a plausible snapshot id → undefined
    // (so callers can use `?? default`).
    expect(resolveMaxOutput("totally-unknown-model-xyz")).toBeUndefined();
  });
});
