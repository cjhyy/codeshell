import { describe, expect, test } from "bun:test";
import {
  companionLocomotion,
  HOP_DISTANCE,
  WALK_MAX_MS,
  WALK_MIN_MS,
} from "./companion-locomotion";

const motion = { reducedMotion: false, immediate: false };

describe("companionLocomotion", () => {
  test("walks toward the destination, longer trips taking longer within bounds", () => {
    const near = companionLocomotion({ x: 100, y: 100 }, { x: 160, y: 100 }, motion);
    const far = companionLocomotion({ x: 100, y: 100 }, { x: 900, y: 100 }, motion);
    expect(near).toEqual({ kind: "walk", duration: WALK_MIN_MS, facing: "right" });
    expect(far.kind).toBe("walk");
    if (far.kind !== "walk") throw new Error("expected a walk");
    expect(far.duration).toBeGreaterThan(WALK_MIN_MS);
    expect(far.duration).toBeLessThanOrEqual(WALK_MAX_MS);
    expect(companionLocomotion({ x: 500, y: 0 }, { x: 200, y: 0 }, motion)).toMatchObject({
      facing: "left",
    });
  });

  test("hops across long distances instead of trailing the real action", () => {
    expect(companionLocomotion({ x: 0, y: 0 }, { x: HOP_DISTANCE + 1, y: 0 }, motion).kind).toBe(
      "hop",
    );
  });

  test("stays put for tiny, first, immediate or reduced-motion moves", () => {
    expect(companionLocomotion({ x: 0, y: 0 }, { x: 2, y: 2 }, motion).kind).toBe("none");
    expect(companionLocomotion(undefined, { x: 500, y: 0 }, motion).kind).toBe("none");
    expect(
      companionLocomotion({ x: 0, y: 0 }, { x: 500, y: 0 }, { ...motion, immediate: true }).kind,
    ).toBe("none");
    expect(
      companionLocomotion({ x: 0, y: 0 }, { x: 500, y: 0 }, { ...motion, reducedMotion: true })
        .kind,
    ).toBe("none");
    expect(companionLocomotion({ x: 0, y: 0 }, { x: NaN, y: 0 }, motion).kind).toBe("none");
  });
});
