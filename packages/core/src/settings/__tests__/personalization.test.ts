import { describe, it, expect } from "bun:test";
import { personalizationFrom } from "../personalization.js";

describe("personalizationFrom", () => {
  it("returns all three fields verbatim when set", () => {
    const agent = {
      responseLanguage: "中文",
      userProfile: "I am a backend engineer.",
      instructions: { compatClaude: true, compatCodex: false },
    };
    expect(personalizationFrom(agent)).toEqual({
      responseLanguage: "中文",
      userProfile: "I am a backend engineer.",
      instructions: { compatClaude: true, compatCodex: false },
    });
  });

  it("returns all-undefined for an empty agent object", () => {
    expect(personalizationFrom({})).toEqual({
      responseLanguage: undefined,
      userProfile: undefined,
      instructions: undefined,
    });
  });

  it("does not invent fields beyond the personalization subset", () => {
    const out = personalizationFrom({
      responseLanguage: "en",
      userProfile: "x",
      instructions: { compatClaude: true, compatCodex: true },
    });
    expect(Object.keys(out).sort()).toEqual(
      ["instructions", "responseLanguage", "userProfile"].sort(),
    );
  });
});
