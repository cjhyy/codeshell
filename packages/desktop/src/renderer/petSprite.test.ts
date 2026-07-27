import { describe, expect, test } from "bun:test";
import { DEFAULT_PET_SPRITE, petSpriteUrl } from "./petSprite";
import type { ThemePack } from "./theme-packs";

function pack(pet?: ThemePack["pet"]): ThemePack {
  return { id: "t", name: "t", swatch: "0 0% 50%", colors: { light: {}, dark: {} }, pet };
}

describe("petSpriteUrl", () => {
  test("returns the default sprite when the pack has no pet images", () => {
    expect(petSpriteUrl(pack(), "idle")).toBe(DEFAULT_PET_SPRITE);
    expect(petSpriteUrl(pack(), "running")).toBe(DEFAULT_PET_SPRITE);
  });

  test("returns the state-specific sprite when present", () => {
    const p = pack({ idle: "idle.png", running: "run.png", alert: "alert.png" });
    expect(petSpriteUrl(p, "idle")).toBe("idle.png");
    expect(petSpriteUrl(p, "running")).toBe("run.png");
    expect(petSpriteUrl(p, "alert")).toBe("alert.png");
  });

  test("falls back to idle sprite for a missing state before the default", () => {
    const p = pack({ idle: "idle.png" }); // no running/alert supplied
    expect(petSpriteUrl(p, "running")).toBe("idle.png");
    expect(petSpriteUrl(p, "alert")).toBe("idle.png");
  });
});
