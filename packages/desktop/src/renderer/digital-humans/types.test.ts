import { describe, expect, test } from "bun:test";
import { canAddDigitalHumanSkill, DIGITAL_HUMAN_PROFILE_LIMITS } from "./types";

describe("digital-human editor limits", () => {
  test("permits a valid Skill below the selection limit", () => {
    expect(
      canAddDigitalHumanSkill(
        DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount - 1,
        "s".repeat(DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName),
      ),
    ).toBe(true);
  });

  test("blocks additions at the count limit and rejects invalid names", () => {
    expect(
      canAddDigitalHumanSkill(DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount, "another-skill"),
    ).toBe(false);
    expect(canAddDigitalHumanSkill(0, "")).toBe(false);
    expect(
      canAddDigitalHumanSkill(0, "s".repeat(DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName + 1)),
    ).toBe(false);
  });
});
