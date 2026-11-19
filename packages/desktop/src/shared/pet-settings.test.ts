import { describe, expect, test } from "bun:test";
import {
  petDelegatedPermissionFromSettings,
  petDelegatedPermissionSettingsPatch,
  petPersonalizationFromSettings,
  petPersonalizationSettingsPatch,
  resolvePetDelegatedPermissionMode,
} from "./pet-settings";

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

describe("Mimi delegated Work Session permission mode", () => {
  const user = (pet: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
    ...rest,
    pet,
  });

  test("a missing or unknown setting means inherit", () => {
    expect(petDelegatedPermissionFromSettings(null)).toBe("inherit");
    expect(petDelegatedPermissionFromSettings({})).toBe("inherit");
    expect(petDelegatedPermissionFromSettings(user({ delegatedPermissionMode: "yolo" }))).toBe(
      "inherit",
    );
    expect(petDelegatedPermissionFromSettings(user({ delegatedPermissionMode: "auto" }))).toBe(
      "auto",
    );
    expect(petDelegatedPermissionSettingsPatch("ask")).toEqual({
      pet: { delegatedPermissionMode: "ask" },
    });
  });

  test("auto and ask ignore the owner's default mode", () => {
    const rest = { permissionMode: "bypass" };
    expect(
      resolvePetDelegatedPermissionMode({ user: user({ delegatedPermissionMode: "auto" }, rest) }),
    ).toBe("auto");
    expect(
      resolvePetDelegatedPermissionMode({ user: user({ delegatedPermissionMode: "ask" }, rest) }),
    ).toBe("default");
  });

  test.each([
    [undefined, "default"],
    ["default", "default"],
    ["accept_edits", "acceptEdits"],
    ["acceptEdits", "acceptEdits"],
    ["bypass", "bypassPermissions"],
    ["bypassPermissions", "bypassPermissions"],
    // Plan would block the delegated work entirely.
    ["plan", "default"],
    // Legacy values the composer also downgrades.
    ["auto", "default"],
    ["goal", "default"],
    ["dontAsk", "default"],
  ])("inherit maps the owner's default %s to %s", (mode, expected) => {
    const settings = mode === undefined ? {} : { permissionMode: mode };
    expect(resolvePetDelegatedPermissionMode({ user: settings })).toBe(expected);
    expect(
      resolvePetDelegatedPermissionMode({
        user: user({ delegatedPermissionMode: "inherit" }, settings),
      }),
    ).toBe(expected);
  });

  test("inherit reads permissions.defaultMode and the project layer like the composer", () => {
    expect(
      resolvePetDelegatedPermissionMode({ user: { permissions: { defaultMode: "acceptEdits" } } }),
    ).toBe("acceptEdits");
    expect(
      resolvePetDelegatedPermissionMode({
        user: { permissionMode: "accept_edits" },
        project: { permissionMode: "plan" },
      }),
    ).toBe("default");
    expect(
      resolvePetDelegatedPermissionMode({ user: null, project: { permissionMode: "bypass" } }),
    ).toBe("bypassPermissions");
    expect(resolvePetDelegatedPermissionMode({ user: null, project: null })).toBe("default");
  });

  test("the delegated setting itself is read only from the user layer", () => {
    expect(
      resolvePetDelegatedPermissionMode({
        user: {},
        project: { pet: { delegatedPermissionMode: "auto" } },
      }),
    ).toBe("default");
  });
});
