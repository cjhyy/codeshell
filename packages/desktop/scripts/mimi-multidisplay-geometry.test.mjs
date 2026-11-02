import { describe, expect, test } from "bun:test";
import {
  dockedAnchorForFeet as productDockedAnchorForFeet,
  dockedFeet as productDockedFeet,
  movingAnchorForFeet as productMovingAnchorForFeet,
  movingFeet as productMovingFeet,
} from "../src/main/pet/mimi-presence-state.ts";
import { clampPetWidgetWindowPosition } from "../src/main/pet/pet-widget-geometry.ts";
import {
  classifyOwnedWindow,
  clampDockedAnchor,
  clampMovingAnchor,
  displayIndexOf,
  dockedAnchorForFeet,
  dockedFeet,
  isUnclassifiedLarge,
  movingAnchorForFeet,
  movingFeet,
  movingInside,
  nearestDisplay,
  pixelBoxToGlobal,
} from "./mimi-multidisplay-geometry.mjs";

// The 2026-11-02 acceptance topology (CGDisplayBounds): a 2× 4K screen left of
// the 2× built-in panel with a negative x, and a 1× QHD screen to the right
// whose top is above the primary (negative y).
const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
  { id: 2, bounds: { x: -1920, y: 11, width: 1920, height: 1080 } },
  { id: 3, bounds: { x: 1512, y: -199, width: 2560, height: 1440 } },
];
const workAreas = [
  { x: 0, y: 38, width: 1512, height: 944 },
  { x: -1920, y: 36, width: 1920, height: 1055 },
  { x: 1512, y: -174, width: 2560, height: 1415 },
];

describe("window classification across every display", () => {
  test("a moving surface is found on any screen, including negative origins", () => {
    for (const { bounds } of displays)
      expect(classifyOwnedWindow({ ...bounds, layer: 1000, alpha: 1 }, displays)).toBe("moving");
  });

  test("an ordinary-Space panel kept below the menu bar still counts as moving", () => {
    const win = { x: 0, y: 38, width: 1512, height: 982, layer: 1000, alpha: 1 };
    expect(classifyOwnedWindow(win, displays)).toBe("moving");
    expect(displayIndexOf(win, displays)).toBe(0);
    // Only downwards and only by a menu bar's height.
    expect(classifyOwnedWindow({ ...win, y: -10 }, displays)).toBeNull();
    expect(classifyOwnedWindow({ ...win, y: 120 }, displays)).toBeNull();
    expect(isUnclassifiedLarge({ ...win, y: 120 }, displays)).toBe(true);
  });

  test("same-size screens at different origins are told apart; a size-only rule is not enough", () => {
    const twins = [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { bounds: { x: 1920, y: -300, width: 1920, height: 1080 } },
    ];
    const right = { x: 1920, y: -300, width: 1920, height: 1080, layer: 1000, alpha: 1 };
    expect(classifyOwnedWindow(right, twins)).toBe("moving");
    expect(displayIndexOf(right, twins)).toBe(1);
    // Same size but at no display's origin: not a placed surface.
    expect(classifyOwnedWindow({ ...right, x: 500 }, twins)).toBeNull();
  });

  test("normal-layer full-screen backdrops and hidden windows are not Mimi", () => {
    expect(classifyOwnedWindow({ ...displays[2].bounds, layer: 0, alpha: 1 }, displays)).toBeNull();
    expect(
      classifyOwnedWindow({ x: 3, y: 4, width: 112, height: 112, layer: 1000, alpha: 0 }, displays),
    ).toBeNull();
    expect(
      classifyOwnedWindow({ x: 3, y: 4, width: 400, height: 380, layer: 1000, alpha: 1 }, displays),
    ).toBe("docked");
  });
});

describe("expected geometry matches the production functions", () => {
  test("docked clamp equals clampPetWidgetWindowPosition on every real work area", () => {
    for (const workArea of workAreas)
      for (const x of [-5000, workArea.x - 30, workArea.x + 400, workArea.x + workArea.width, 9000])
        for (const y of [-5000, workArea.y - 30, workArea.y + 300, workArea.y + workArea.height])
          expect(clampDockedAnchor({ x, y }, workArea)).toEqual(
            clampPetWidgetWindowPosition({ x, y }, workArea),
          );
  });

  test("feet conversions equal the presence-state helpers", () => {
    for (const anchor of [
      { x: -1700, y: 40 },
      { x: 1600, y: -170 },
      { x: 300.4, y: 500.6 },
    ]) {
      expect(dockedFeet(anchor)).toEqual(productDockedFeet(anchor));
      expect(dockedAnchorForFeet(anchor)).toEqual(productDockedAnchorForFeet(anchor));
      for (const height of [160, 200, 240, 480]) {
        expect(movingFeet(anchor, height)).toEqual(productMovingFeet(anchor, height));
        expect(movingAnchorForFeet(anchor, height)).toEqual(
          productMovingAnchorForFeet(anchor, height),
        );
      }
    }
  });

  test("moving clamp keeps the 0.7h × h box inside the target work area", () => {
    for (const workArea of workAreas)
      for (const x of [-9000, workArea.x + 10, 9000])
        for (const y of [-9000, workArea.y + 10, 9000]) {
          const anchor = clampMovingAnchor({ x, y }, workArea, 200);
          expect(movingInside(anchor, workArea, 200)).toBe(true);
        }
  });
});

test("nearest display follows Electron: inside wins, otherwise the closest edge", () => {
  expect(nearestDisplay({ x: -10, y: 500 }, displays).id).toBe(2);
  expect(nearestDisplay({ x: 1600, y: -150 }, displays).id).toBe(3);
  expect(nearestDisplay({ x: 700, y: 2000 }, displays).id).toBe(1);
  // With the right-hand screen gone, a point that was on it falls back to the built-in panel.
  expect(nearestDisplay({ x: 2500, y: 600 }, displays.slice(0, 2)).id).toBe(1);
});

test("pixel boxes convert with the capture's own backing scale", () => {
  const rect = { x: 1512, y: -199, width: 112, height: 112 };
  const oneX = pixelBoxToGlobal(
    { width: 112, height: 112, box: { left: 8, top: 8, right: 103, bottom: 103 } },
    rect,
  );
  const twoX = pixelBoxToGlobal(
    { width: 224, height: 224, box: { left: 16, top: 16, right: 207, bottom: 207 } },
    rect,
  );
  expect(oneX.scale).toBe(1);
  expect(twoX.scale).toBe(2);
  expect(oneX.height).toBe(96);
  expect(twoX.height).toBe(96);
  expect(twoX.footCenter).toEqual({ x: 1512 + 56, y: -199 + 104 });
});
