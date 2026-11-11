import { describe, expect, test } from "bun:test";
import {
  defaultSessionModelKeyFromSettings,
  defaultSessionModelKeyFromSettingsLayers,
  sessionModelKeyFromSettings,
  sessionModelSettingsPatch,
} from "./session-model-default";

describe("session model defaults", () => {
  test("explicit session preference wins without replacing the native default", () => {
    const settings = {
      sessionDefaults: { model: "codex/gpt-6.1-sol" },
      defaults: { text: "openrouter-connection" },
    };
    expect(sessionModelKeyFromSettings(settings)).toBe("codex/gpt-6.1-sol");
    expect(defaultSessionModelKeyFromSettings(settings)).toBe("codex/gpt-6.1-sol");
    expect(settings.defaults.text).toBe("openrouter-connection");
    expect(sessionModelSettingsPatch("claude-code/sonnet")).toEqual({
      sessionDefaults: { model: "claude-code/sonnet" },
    });
    expect(sessionModelSettingsPatch(null)).toEqual({ sessionDefaults: { model: null } });
  });

  test("only the combined resolver inherits the legacy/native text default", () => {
    const settings = { defaults: { text: "native-connection" }, pet: { chatModelKey: "pet-only" } };
    expect(sessionModelKeyFromSettings(settings)).toBeNull();
    expect(defaultSessionModelKeyFromSettings(settings)).toBe("native-connection");
    expect(defaultSessionModelKeyFromSettings({ activeKey: "legacy-out-of-scope" })).toBeNull();
  });

  test("rejects malformed settings and keys instead of silently coercing them", () => {
    for (const value of [null, [], "key", { sessionDefaults: [] }, { sessionDefaults: "key" }]) {
      expect(sessionModelKeyFromSettings(value)).toBeNull();
    }
    for (const model of [null, 1, "", " padded ", "bad\nkey", "\u007f", "x".repeat(513)]) {
      expect(sessionModelKeyFromSettings({ sessionDefaults: { model } })).toBeNull();
      expect(defaultSessionModelKeyFromSettings({ defaults: { text: model } })).toBeNull();
    }
    expect(sessionModelKeyFromSettings({ sessionDefaults: { model: "x".repeat(512) } })).toBe(
      "x".repeat(512),
    );
  });

  test("project reset inherits the user default while explicit project choices take precedence", () => {
    const user = { sessionDefaults: { model: "codex/gpt-6.1-sol" }, defaults: { text: "native" } };
    expect(defaultSessionModelKeyFromSettingsLayers(user, { sessionDefaults: {} })).toBe(
      "codex/gpt-6.1-sol",
    );
    expect(
      defaultSessionModelKeyFromSettingsLayers(user, {
        sessionDefaults: { model: "claude-code/sonnet" },
      }),
    ).toBe("claude-code/sonnet");
    expect(
      defaultSessionModelKeyFromSettingsLayers(user, {
        sessionDefaults: { model: null },
        defaults: { image: "image" },
      }),
    ).toBe("native");
    expect(
      defaultSessionModelKeyFromSettingsLayers(user, { sessionDefaults: null, defaults: null }),
    ).toBeNull();
  });
});
