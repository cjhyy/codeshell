import { expect, test } from "bun:test";
import { allowNativePetExtraction } from "./pet-native-extraction-policy.js";

test("an external turn selected by a project override never triggers the user's native aux model", () => {
  const user = { defaults: { text: "openrouter" } };
  expect(allowNativePetExtraction(user, { provider: "codex", model: "codex/gpt-6.1-sol" })).toBe(
    false,
  );
  expect(allowNativePetExtraction(user, { provider: "claude-code", model: "sonnet" })).toBe(false);
});

test("external defaults and Mimi overrides suppress native extraction even before the first turn", () => {
  expect(
    allowNativePetExtraction({ sessionDefaults: { model: "codex/gpt-6.1-sol" } }, undefined),
  ).toBe(false);
  expect(
    allowNativePetExtraction(
      { pet: { chatModelKey: "claude-code/sonnet" } },
      { provider: "openai" },
    ),
  ).toBe(false);
});

test("native chat retains the existing extraction preference", () => {
  expect(
    allowNativePetExtraction({ defaults: { text: "openrouter" } }, { provider: "openai" }),
  ).toBe(true);
  expect(
    allowNativePetExtraction({ pet: { memoryAutoExtract: false } }, { provider: "openai" }),
  ).toBe(false);
});
