import { describe, expect, test } from "bun:test";
import { capabilitiesForConfig } from "./index.js";

describe("current model capabilities", () => {
  test.each(["openai/gpt-6.1-sol", "vendor/future-model"])("explicit true admits %s", (model) => {
    expect(
      capabilitiesForConfig({
        provider: "openai",
        providerKind: "openrouter",
        model,
        supportsVision: true,
      }).supportsVision,
    ).toBe(true);
  });
  test("explicit false overrides a known family without changing request-shape rules", () => {
    const cap = capabilitiesForConfig({
      provider: "openai",
      providerKind: "openrouter",
      model: "openai/gpt-5.6-sol",
      supportsVision: false,
    });
    expect(cap.supportsVision).toBe(false);
    expect(cap.reasoning.kind).toBe("openrouter-reasoning");
  });
  test("rules are only the fallback, with unknown and missing identity closed", () => {
    expect(
      capabilitiesForConfig({
        provider: "openai",
        providerKind: "openrouter",
        model: "openai/gpt-5.6-sol",
      }).supportsVision,
    ).toBe(true);
    expect(
      capabilitiesForConfig({
        provider: "openai",
        providerKind: "openrouter",
        model: "openai/gpt-6.1-sol",
      }).supportsVision,
    ).toBe(false);
    expect(capabilitiesForConfig({ provider: "openai", model: "future" }).supportsVision).toBe(
      false,
    );
    expect(capabilitiesForConfig(undefined).supportsVision).toBe(false);
    expect(capabilitiesForConfig({ supportsVision: true } as never).supportsVision).toBe(false);
  });
});
