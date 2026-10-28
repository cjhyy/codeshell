import { expect, test } from "bun:test";
import { companionPlacement } from "./companion-layout";

test("native points map correctly on a display with a negative origin", () => {
  const result = companionPlacement({ x: -1920, y: -100, width: 1920, height: 1080 }, 320, {
    x: -1500,
    y: 200,
  });
  expect(result.target).toEqual({ x: 420, y: 300 });
  expect(result.position.x + 320 * 0.7).toBeLessThan(420);
});

test("placement stays inside the display at edges and with invalid sizes", () => {
  for (const size of [NaN, Infinity, 1, 900, 320]) {
    for (const target of [
      { x: 0, y: 0 },
      { x: 1024, y: 768 },
    ]) {
      const result = companionPlacement({ x: 0, y: 0, width: 1024, height: 768 }, size, target);
      expect(Number.isFinite(result.position.x)).toBe(true);
      expect(result.position.x).toBeGreaterThanOrEqual(12);
      expect(result.position.y).toBeGreaterThanOrEqual(12);
      expect(result.position.x).toBeLessThan(1024);
      expect(result.position.y).toBeLessThan(768);
    }
  }
});
