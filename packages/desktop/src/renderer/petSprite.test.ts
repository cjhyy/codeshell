import { describe, expect, test } from "bun:test";
import { DEFAULT_PET_SPRITE, petSpriteUrl, petWalkFrames } from "./petSprite";
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

describe("petWalkFrames", () => {
  test("returns the frames, dropping blanks; empty when none", () => {
    expect(petWalkFrames(pack())).toEqual([]);
    expect(petWalkFrames(pack({ walk: [] }))).toEqual([]);
    expect(petWalkFrames(pack({ walk: ["a.png", "", "b.png"] }))).toEqual(["a.png", "b.png"]);
  });

  test("picks direction-specific frames, falling back to walk for left", () => {
    const both = pack({ walk: ["r1.png", "r2.png"], walkLeft: ["l1.png", "l2.png"] });
    expect(petWalkFrames(both, "right")).toEqual(["r1.png", "r2.png"]);
    expect(petWalkFrames(both, "left")).toEqual(["l1.png", "l2.png"]);
    // No walkLeft → left reuses the (rightward) walk frames.
    const rightOnly = pack({ walk: ["r1.png", "r2.png"] });
    expect(petWalkFrames(rightOnly, "left")).toEqual(["r1.png", "r2.png"]);
  });

  test("the default pack rests as the static dog icon but can walk (trot/drag)", () => {
    const defaultPack = {
      id: "default",
      name: "default",
      swatch: "0 0% 50%",
      colors: { light: {}, dark: {} },
    } satisfies ThemePack;

    // At rest every state resolves to the single static icon (no idle/mood art).
    for (const state of ["idle", "running", "alert", "waving", "waiting", "failed"] as const) {
      expect(petSpriteUrl(defaultPack, state)).toBe(DEFAULT_PET_SPRITE);
    }
    // …but it DOES carry directional walk frames for the trot + drag animation.
    expect(petWalkFrames(defaultPack, "right")).toHaveLength(8);
    expect(petWalkFrames(defaultPack, "left")).toHaveLength(8);
    expect(petWalkFrames(defaultPack, "left")).not.toEqual(petWalkFrames(defaultPack, "right"));
  });
});
