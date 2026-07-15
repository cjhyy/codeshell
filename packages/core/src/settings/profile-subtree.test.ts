import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "./schema.js";

describe("settings profile subtree", () => {
  test("accepts a full profile subtree", () => {
    const settings = SettingsSchema.parse({
      profile: {
        active: "seedance",
        preset: "general",
        overrides: { plugins: { "seedance-pack": "on" } },
      },
    });
    expect(settings.profile?.active).toBe("seedance");
    expect(settings.profile?.overrides?.plugins?.["seedance-pack"]).toBe("on");
  });

  test("absent profile subtree stays undefined", () => {
    expect(SettingsSchema.parse({}).profile).toBeUndefined();
  });

  test("rejects a subtree without active", () => {
    expect(() => SettingsSchema.parse({ profile: { preset: "general" } })).toThrow();
  });
});
