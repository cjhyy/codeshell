import { describe, it, expect } from "bun:test";
import { capabilitiesFor } from "./index.js";

describe("capability supportsVision — OpenAI gpt-4o family", () => {
  // Regression: gpt-4o and friends previously had no matching rule and fell
  // through to DEFAULT_CAPABILITY (supportsVision:false), so a famous vision
  // model got its history images stripped / new attachments rejected.
  it.each([
    "gpt-4o",
    "gpt-4o-2024-08-06",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-4-turbo-2024-04-09",
    "gpt-4-vision-preview",
    "gpt-4.1",
    "gpt-4.1-mini",
  ])("treats %s as vision-capable", (model) => {
    expect(capabilitiesFor("openai", model).supportsVision).toBe(true);
  });

  it("does NOT classify gpt-3.5-turbo as vision-capable", () => {
    expect(capabilitiesFor("openai", "gpt-3.5-turbo").supportsVision).toBe(false);
  });

  it("keeps gpt-4o on classic max_tokens (it is not a reasoning model)", () => {
    const cap = capabilitiesFor("openai", "gpt-4o");
    expect(cap.tokenLimitField).toBe("max_tokens");
    expect(cap.reasoning.kind).toBe("none");
  });

  it("still routes gpt-5+ to the reasoning rule (not masked by the gpt-4 rule)", () => {
    const cap = capabilitiesFor("openai", "gpt-5");
    expect(cap.supportsVision).toBe(true);
    expect(cap.tokenLimitField).toBe("max_completion_tokens");
  });
});
