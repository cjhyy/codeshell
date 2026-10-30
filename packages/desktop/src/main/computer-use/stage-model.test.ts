import { describe, expect, test } from "bun:test";
import { companionFeetOffset } from "../../shared/mimi-companion";
import { PERCH_REACH, WORK_SCALE, clearsFieldAtOnce, stagePlacement } from "./stage-model";

const display = { x: 0, y: 0, width: 1920, height: 1080 };
const window = { x: 400, y: 420, width: 1000, height: 600 };
const height = 320;
const width = height * 0.7;

describe("stagePlacement", () => {
  test("sits on the target window's title bar beside the target column", () => {
    const result = stagePlacement(display, height, { target: { x: 900, y: 480 }, window });
    expect(result.perch).toBe("title-bar");
    // Feet rest just inside the window's top edge; the body stays above the content.
    const feet = result.position.y + height - companionFeetOffset(height);
    expect(feet).toBeGreaterThan(window.y);
    expect(feet).toBeLessThanOrEqual(window.y + 10);
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

describe("clearsFieldAtOnce", () => {
  const frame = { x: 300, y: 300, width: 200, height: 40 };
  test("only a field receiving text makes the character leave at once", () => {
    expect(clearsFieldAtOnce(frame, "text")).toBe(true);
    // An editor's backing textarea may report no kind; keep it clear too.
    expect(clearsFieldAtOnce(frame, undefined)).toBe(true);
    // A button or link is walked to like any other target.
    expect(clearsFieldAtOnce(frame, "button")).toBe(false);
    expect(clearsFieldAtOnce(frame, "link")).toBe(false);
    expect(clearsFieldAtOnce(undefined, "text")).toBe(false);
  });
});

describe("stagePlacement on element surfaces", () => {
  const page = { x: 160, y: 70, width: 1280, height: 820 };
  const screen = { x: 0, y: 38, width: 1512, height: 982 };
  const working = Math.round(320 * WORK_SCALE);
  const feet = (result: ReturnType<typeof stagePlacement>) => {
    const size = result.size ?? 320;
    return result.position.y + screen.y + size - companionFeetOffset(size);
  };

  test("sits on a text field's right corner while text goes in", () => {
    const field = { x: 420, y: 454, width: 760, height: 35 };
    const result = stagePlacement(screen, 320, {
      target: { x: 800, y: 471 },
      window: page,
      surface: { kind: "text", frame: field },
    });
    expect(result.perch).toBe("on-field");
    expect(result.size).toBe(working);
    // Feet on the field's top edge; the body above the field, never inside it.
    expect(Math.abs(feet(result) - field.y)).toBeLessThanOrEqual(1);
    // Riding the field's right corner: most of the body hangs past the field's
    // end, so it covers little of the field's neighbours above it.
    const overField = field.x + field.width - result.position.x;
    expect(overField).toBeGreaterThan(0);
    expect(overField).toBeLessThanOrEqual(working * 0.7 * 0.4);
  });

  test("stands beside a button with its feet on the button's baseline", () => {
    const button = { x: 420, y: 649, width: 80, height: 37 };
    const result = stagePlacement(screen, 320, {
      target: { x: 460, y: 667 },
      window: page,
      surface: { kind: "button", frame: button },
    });
    expect(result.perch).toBe("on-baseline");
    expect(Math.abs(feet(result) - (button.y + button.height))).toBeLessThanOrEqual(1);
    const right = result.position.x + working * 0.7;
    // Beside the button, not over it.
    expect(right <= button.x || result.position.x >= button.x + button.width).toBe(true);
  });

  test("falls back when the surface leaves no room inside the window", () => {
    // A field right under the window's top edge: sitting on it would leave the window.
    const field = { x: 600, y: 90, width: 200, height: 30 };
    const result = stagePlacement(screen, 320, {
      target: { x: 700, y: 105 },
      window: page,
      surface: { kind: "text", frame: field },
    });
    expect(result.perch).not.toBe("on-field");
    expect(result.size).toBeUndefined();
  });

  test("uses the display as the bounds when the window frame is unknown", () => {
    // Element reads without a screenshot carry no window frame.
    const button = { x: 420, y: 649, width: 80, height: 37 };
    const result = stagePlacement(screen, 320, {
      target: { x: 460, y: 667 },
      surface: { kind: "button", frame: button },
    });
    expect(result.perch).toBe("on-baseline");
  });

  test("a wide row or a large region is not a surface", () => {
    const row = { x: 200, y: 400, width: 1100, height: 40 };
    const result = stagePlacement(screen, 320, {
      target: { x: 900, y: 420 },
      window: page,
      surface: { kind: "list", frame: row },
    });
    expect(result.perch).not.toBe("on-baseline");
  });
});
