import { describe, it, expect } from "bun:test";
import { capabilitiesFor } from "./index.js";

describe("capability maxOutputTokens", () => {
  it("caps gpt-5.5 output at its 128k ceiling so a stale 384k value can't bleed in", () => {
    const cap = capabilitiesFor("openai", "gpt-5.5");
    expect(cap.maxOutputTokens).toBe(128_000);
  });

  it("leaves maxOutputTokens undefined for models with no known cap", () => {
    const cap = capabilitiesFor("custom" as never, "some-unknown-model");
    expect(cap.maxOutputTokens).toBeUndefined();
  });
});
