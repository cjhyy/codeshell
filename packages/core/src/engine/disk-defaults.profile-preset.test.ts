import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../settings/schema.js";
import { diskDefaultsFrom } from "./disk-defaults.js";

describe("diskDefaultsFrom profile preset fallback", () => {
  test("agent.preset wins over profile.preset", () => {
    const settings = SettingsSchema.parse({
      agent: { preset: "harness-min" },
      profile: { active: "x", preset: "general" },
    });
    expect(diskDefaultsFrom(settings).preset).toBe("harness-min");
  });

  test("profile.preset used when agent.preset unset", () => {
    const settings = SettingsSchema.parse({
      profile: { active: "x", preset: "general" },
    });
    expect(diskDefaultsFrom(settings).preset).toBe("general");
  });

  test("both unset → undefined (capability default downstream)", () => {
    const settings = SettingsSchema.parse({});
    expect(diskDefaultsFrom(settings).preset).toBeUndefined();
  });
});
