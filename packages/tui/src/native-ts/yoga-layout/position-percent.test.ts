import { describe, test, expect } from "bun:test";
import { Node } from "./index.js";
import { Edge, PositionType } from "./enums.js";

// Regression: percentage TOP/BOTTOM position insets must resolve against the
// container's HEIGHT, not its width (review-2026-05-30, two high-severity yoga
// findings at index.ts:958 and :1859-1865). Use a deliberately non-square
// container (width 200, height 100) so a wrong-dimension resolve is visible:
// 50% of height = 50 (correct) vs 50% of width = 100 (bug).

describe("yoga percentage position resolves TOP/BOTTOM against height", () => {
  test("relative flex child: top:50% offsets by half the container HEIGHT", () => {
    const root = new Node();
    root.setWidth(200);
    root.setHeight(100);

    const child = new Node();
    child.setWidth(20);
    child.setHeight(10);
    child.setPositionType(PositionType.Relative);
    child.setPositionPercent(Edge.Top, 50);
    root.insertChild(child, 0);

    root.calculateLayout(200, 100);

    // 50% of height (100) = 50, NOT 50% of width (200) = 100.
    expect(child.getComputedTop()).toBe(50);
  });

  test("relative flex child: left:50% still offsets by half the container WIDTH", () => {
    // Guard the companion axis so the fix doesn't accidentally swap both.
    const root = new Node();
    root.setWidth(200);
    root.setHeight(100);

    const child = new Node();
    child.setWidth(20);
    child.setHeight(10);
    child.setPositionType(PositionType.Relative);
    child.setPositionPercent(Edge.Left, 50);
    root.insertChild(child, 0);

    root.calculateLayout(200, 100);

    expect(child.getComputedLeft()).toBe(100);
  });

  test("root node: top:50% offsets by half the root's own HEIGHT", () => {
    const root = new Node();
    root.setWidth(200);
    root.setHeight(100);
    root.setPositionPercent(Edge.Top, 50);

    root.calculateLayout(200, 100);

    expect(root.getComputedTop()).toBe(50);
  });
});
