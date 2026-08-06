import { describe, expect, test } from "bun:test";
import { petPersonalizationFromSettings, petPersonalizationSettingsPatch } from "./pet-settings";

describe("Mimi personalization settings", () => {
  test("reads only the dedicated pet personalization subtree", () => {
    expect(
      petPersonalizationFromSettings({
        agent: {
          responseLanguage: "Session language",
          userProfile: "Session profile",
          appendSystemPrompt: "Session instructions",
        },
        pet: {
          personalization: {
            responseLanguage: "  简体中文  ",
            userProfile: "  叫我 Maki  ",
            communicationStyle: "  简洁直接  ",
            customInstructions: "  汇报先说结论  ",
          },
        },
      }),
    ).toEqual({
      responseLanguage: "简体中文",
      userProfile: "叫我 Maki",
      communicationStyle: "简洁直接",
      customInstructions: "汇报先说结论",
    });

    expect(
      petPersonalizationFromSettings({ agent: { responseLanguage: "Session language" } }),
    ).toEqual({});
  });

  test("builds a patch that cannot overwrite Session personalization", () => {
    expect(petPersonalizationSettingsPatch({ communicationStyle: "warm and concise" })).toEqual({
      pet: { personalization: { communicationStyle: "warm and concise" } },
    });
  });
});
