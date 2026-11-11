import { expect, test } from "bun:test";
import {
  allowNativePetAuxiliary,
  allowNativePetExtraction,
} from "./pet-native-extraction-policy.js";

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

test("auxiliary policy is independent of memory extraction preferences", () => {
  const settings = { defaults: { text: "openrouter" }, pet: { memoryAutoExtract: false } };
  expect(allowNativePetAuxiliary(settings, { provider: "openai" })).toBe(true);
  expect(allowNativePetExtraction(settings, { provider: "openai" })).toBe(false);
});

test("Mimi's explicit native override wins over the global default but not an actual external turn", () => {
  const settings = {
    sessionDefaults: { model: "codex/gpt-6.1-sol" },
    pet: { chatModelKey: "native-connection" },
  };
  expect(allowNativePetAuxiliary(settings, { provider: "openai" })).toBe(true);
  expect(allowNativePetAuxiliary(settings, { provider: "codex" })).toBe(false);
});

test("auxiliary policy rejects external defaults before any manager turn exists", () => {
  for (const settings of [
    { sessionDefaults: { model: "codex/gpt-6.1-sol" } },
    { pet: { chatModelKey: "claude-code/sonnet" } },
    { defaults: { text: "claude-code/sonnet" } },
  ])
    expect(allowNativePetAuxiliary(settings)).toBe(false);
  expect(allowNativePetAuxiliary({})).toBe(true);
});
