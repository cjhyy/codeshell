import { describe, expect, test } from "bun:test";
import { capabilitiesFor, capabilitiesForConfig } from "./index.js";

describe("current model capabilities", () => {
  test.each(["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-sol-pro", "gpt-6.1-terra"])(
    "declared cache support covers direct and gateway routes for %s",
    (model) => {
      expect(capabilitiesFor("openai", model).promptCaching).toBe("openai-hybrid");
      expect(capabilitiesFor("openrouter", `openai/${model}`).promptCaching).toBe("openai-hybrid");
    },
  );

  test("cache support does not guess capabilities from future version numbers", () => {
    expect(capabilitiesFor("openai", "gpt-99.1-sol").promptCaching).toBe("openai-implicit");
    expect(capabilitiesFor("openrouter", "openai/gpt-5.999-sol").promptCaching).toBe(
      "openai-implicit",
    );
    expect(capabilitiesFor("openrouter", "vendor/gpt-6.1-sol").promptCaching).toBe(
      "provider-managed",
    );
    expect(capabilitiesFor("custom", "gpt-6.1-sol").promptCaching).toBe("provider-managed");
    expect(capabilitiesFor("openrouter", "~anthropic/claude-sonnet-latest").promptCaching).toBe(
      "anthropic-explicit",
    );
  });

  test("catalog cache metadata is authoritative for custom model ids and opt-outs", () => {
    expect(
      capabilitiesForConfig({
        provider: "openai",
        providerKind: "custom",
        model: "production-deployment",
        promptCaching: "openai-hybrid",
      }).promptCaching,
    ).toBe("openai-hybrid");
    expect(
      capabilitiesForConfig({
        provider: "openai",
        model: "gpt-6.1-sol",
        promptCaching: "provider-managed",
      }).promptCaching,
    ).toBe("provider-managed");
  });

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
