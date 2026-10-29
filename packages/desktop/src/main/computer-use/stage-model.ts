import { companionSize, type MimiCompanionPerch } from "../../shared/mimi-companion.js";
import { companionPlacement, type CompanionDisplayBounds } from "./companion-layout.js";

type Point = { x: number; y: number };

export interface CompanionScene {
  target?: Point;
  /** Frame of the input receiving the action; never covered. */
  avoidRect?: CompanionDisplayBounds;
  /** Frame of the target's window, when the agent observed it. */
  window?: CompanionDisplayBounds;
  /** The app profile's preferred place; the title bar remains conditional. */
  prefer?: MimiCompanionPerch;
}

/** A field receiving text must be uncovered before the next keystroke, so the
 * character leaves it at once. Any other reserved control (a button, a link) is
 * walked to like an ordinary target; it is only kept uncovered. */
export function clearsFieldAtOnce(
  reserved: CompanionDisplayBounds | undefined,
  element: string | undefined,
): boolean {
  return !!reserved && (element === undefined || element === "text");
}

/** How far the character's feet rest into the window's top edge (title bar). */
const PERCH_SINK = 14;
/** Perch only while the target is this close below the window's top edge;
 * farther down, standing beside the target reads better than a distant seat. */
export const PERCH_REACH = 520;
const MARGIN = 12;
const GAP = 16;

const inside = (point: Point, rect: CompanionDisplayBounds) =>
  point.x >= rect.x &&
  point.y >= rect.y &&
  point.x <= rect.x + rect.width &&
  point.y <= rect.y + rect.height;

/** Where the character stands for the current action. Sits on the target
 * window's title bar when it can do so without covering the target or its
 * input; otherwise stands beside the target (companionPlacement). All inputs
 * are global logical points; the result is local to `display`. */
export function stagePlacement(
  display: CompanionDisplayBounds,
  size: number,
  scene: CompanionScene,
): ReturnType<typeof companionPlacement> & { perch: MimiCompanionPerch } {
  const beside = () => ({
    ...companionPlacement(display, size, scene.target, scene.avoidRect),
    perch: "beside-target" as const,
  });
  const { target, window } = scene;
  if (scene.prefer === "screen-corner") {
    // Out of the way entirely, still looking toward the action.
    const corner = companionPlacement(display, size);
    return {
      position: corner.position,
      ...(target ? { target: { x: target.x - display.x, y: target.y - display.y } } : {}),
      perch: "screen-corner",
    };
  }
  if (scene.prefer === "beside-target") return beside();
  if (!target || !window || !inside(target, window)) return beside();
  const depth = target.y - window.y;
  if (depth < PERCH_SINK + 4 || depth > PERCH_REACH) return beside();
  const height = companionSize(size);
  const width = height * 0.7;
  const top = window.y - display.y;
  const y = top - height + PERCH_SINK;
  // A maximized or fullscreen window leaves no room above its edge.
  if (y < MARGIN) return beside();
  const local = { x: target.x - display.x, y: target.y - display.y };
  const left = window.x - display.x;
  const right = left + window.width;
  const minX = Math.max(MARGIN, left);
  const maxX = Math.min(display.width - width - MARGIN, right - width);
  if (maxX < minX) return beside();
  // Sit just to one side of the target's column so the gaze reads as a look down.
  const preferred = local.x - width - GAP >= minX ? local.x - width - GAP : local.x + GAP;
  const x = Math.max(minX, Math.min(maxX, preferred));
  if (scene.avoidRect) {
    const box = {
      x: scene.avoidRect.x - display.x,
      y: scene.avoidRect.y - display.y,
      width: scene.avoidRect.width,
      height: scene.avoidRect.height,
    };
    const clear =
      x + width + 8 <= box.x ||
      x >= box.x + box.width + 8 ||
      y + height + 8 <= box.y ||
      y >= box.y + box.height + 8;
    if (!clear) return beside();
  }
  return { position: { x, y }, target: local, perch: "title-bar" };
}
