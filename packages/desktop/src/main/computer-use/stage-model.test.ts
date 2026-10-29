import { describe, expect, test } from "bun:test";
import { PERCH_REACH, stagePlacement } from "./stage-model";

const display = { x: 0, y: 0, width: 1920, height: 1080 };
const window = { x: 400, y: 420, width: 1000, height: 600 };
const height = 320;
const width = height * 0.7;

describe("stagePlacement", () => {
  test("sits on the target window's title bar beside the target column", () => {
    const result = stagePlacement(display, height, { target: { x: 900, y: 480 }, window });
    expect(result.perch).toBe("title-bar");
    // Feet rest on the window's top edge; the body stays above the content.
    expect(result.position.y + height).toBeGreaterThan(window.y);
    expect(result.position.y + height).toBeLessThanOrEqual(window.y + 20);
    expect(result.position.x + width).toBeLessThanOrEqual(900);
    expect(result.position.x).toBeGreaterThanOrEqual(window.x);
  });

  test("near the window's left edge it sits on the other side of the target", () => {
    const result = stagePlacement(display, height, { target: { x: 420, y: 480 }, window });
    expect(result.perch).toBe("title-bar");
    expect(result.position.x).toBeGreaterThan(420);
    expect(result.position.x + width).toBeLessThanOrEqual(window.x + window.width);
  });

  test("works in display-local points on a display with a negative origin", () => {
    const left = { x: -1920, y: -200, width: 1920, height: 1080 };
    const win = { x: -1500, y: 200, width: 900, height: 600 };
    const result = stagePlacement(left, height, { target: { x: -1100, y: 260 }, window: win });
    expect(result.perch).toBe("title-bar");
    expect(result.target).toEqual({ x: 820, y: 460 });
    expect(result.position.y + height).toBeGreaterThan(win.y - left.y);
  });

  test("falls back to standing beside the target when perching would not read", () => {
    const beside = (scene: Parameters<typeof stagePlacement>[2]) =>
      stagePlacement(display, height, scene).perch;
    // No window observed, or the target lies outside it.
    expect(beside({ target: { x: 900, y: 480 } })).toBe("beside-target");
    expect(beside({ target: { x: 100, y: 100 }, window })).toBe("beside-target");
    // Too far down the window, or on the title bar itself.
    expect(beside({ target: { x: 900, y: window.y + PERCH_REACH + 1 }, window })).toBe(
      "beside-target",
    );
    expect(beside({ target: { x: 900, y: window.y + 4 }, window })).toBe("beside-target");
    // A maximized window leaves no room above its edge.
    expect(
      beside({ target: { x: 900, y: 120 }, window: { x: 0, y: 25, width: 1920, height: 1055 } }),
    ).toBe("beside-target");
  });

  test("never covers the input receiving the action", () => {
    // A field reaching up into the title bar (an address bar) blocks the perch.
    const field = { x: 600, y: 410, width: 600, height: 40 };
    const result = stagePlacement(display, height, {
      target: { x: 900, y: 440 },
      window,
      avoidRect: field,
    });
    expect(result.perch).toBe("beside-target");
    const inside = { x: 700, y: 520, width: 400, height: 30 };
    const perched = stagePlacement(display, height, {
      target: { x: 900, y: 535 },
      window,
      avoidRect: inside,
    });
    expect(perched.perch).toBe("title-bar");
    expect(perched.position.y + height + 8).toBeLessThanOrEqual(inside.y);
  });

  test("an app profile can keep the character beside the target or out of the way", () => {
    const scene = { target: { x: 900, y: 480 }, window };
    expect(stagePlacement(display, height, { ...scene, prefer: "beside-target" }).perch).toBe(
      "beside-target",
    );
    const corner = stagePlacement(display, height, { ...scene, prefer: "screen-corner" });
    expect(corner.perch).toBe("screen-corner");
    expect(corner.position.x + width).toBeGreaterThan(display.width - 60);
    expect(corner.target).toEqual({ x: 900, y: 480 });
    // The title bar stays conditional even when an app prefers it.
    expect(
      stagePlacement(display, height, { target: { x: 900, y: 480 }, prefer: "title-bar" }).perch,
    ).toBe("beside-target");
  });
});
