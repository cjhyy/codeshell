import {
  companionFeetOffset,
  companionSize,
  type MimiCompanionPerch,
} from "../../shared/mimi-companion.js";
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
  /** The control under the action, when the agent addressed an element. */
  surface?: { kind: string; frame: CompanionDisplayBounds };
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
const PERCH_SINK = 6;
/** Perch only while the target is this close below the window's top edge;
 * farther down, standing beside the target reads better than a distant seat. */
export const PERCH_REACH = 520;
/** Working on a control, the character is drawn at this fraction of its size
 * so it can stand on the control's edges without covering the page. */
export const WORK_SCALE = 0.55;
/** Larger controls (rows, panes, canvases) are regions, not something to stand on. */
const SURFACE_MAX = { width: 420, height: 120 };
/** How much of the body rests over a field when sitting on its corner. */
const CORNER_OVERLAP = 0.35;
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
): ReturnType<typeof companionPlacement> & { perch: MimiCompanionPerch; size?: number } {
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
  // Element reads without a screenshot carry no window frame; the display bounds it then.
  const surface =
    target && surfacePlacement(display, size, target, window ?? display, scene.surface);
  if (surface) return surface;
  if (!target || !window || !inside(target, window)) return beside();
  const depth = target.y - window.y;
  if (depth < PERCH_SINK + 4 || depth > PERCH_REACH) return beside();
  const height = companionSize(size);
  const width = height * 0.7;
  const top = window.y - display.y;
  const y = top - height + companionFeetOffset(height) + PERCH_SINK;
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

/** Stand on the control the agent is acting on: sit on a field's top edge
 * while text goes in, or stand beside a control with feet on its bottom edge.
 * Undefined when the control is not a surface or leaves no room in the window. */
function surfacePlacement(
  display: CompanionDisplayBounds,
  size: number,
  target: Point,
  window: CompanionDisplayBounds,
  surface: CompanionScene["surface"],
):
  | (ReturnType<typeof companionPlacement> & { perch: MimiCompanionPerch; size: number })
  | undefined {
  if (!surface) return;
  const { frame, kind } = surface;
  if (frame.width > SURFACE_MAX.width + (kind === "text" ? 400 : 0)) return;
  if (frame.height > SURFACE_MAX.height) return;
  if (frame.x < window.x || frame.y < window.y) return;
  if (frame.x + frame.width > window.x + window.width) return;
  if (frame.y + frame.height > window.y + window.height) return;
  const height = Math.round(companionSize(size) * WORK_SCALE);
  const width = height * 0.7;
  const pad = companionFeetOffset(height);
  const minX = window.x + MARGIN;
  const maxX = window.x + window.width - width - MARGIN;
  let x: number;
  let y: number;
  let perch: MimiCompanionPerch;
  if (kind === "text") {
    // Ride the field's right corner: most of the body hangs past the field's
    // end, where neither its text nor the content above it usually is.
    x = Math.min(maxX, frame.x + frame.width - width * CORNER_OVERLAP);
    y = frame.y - height + pad;
    perch = "on-field";
  } else {
    const left = frame.x - width - 4;
    x = left >= minX ? left : frame.x + frame.width + 4;
    if (x > maxX) return;
    y = frame.y + frame.height - height + pad;
    perch = "on-baseline";
  }
  if (x < minX || y < window.y + MARGIN) return;
  return {
    position: { x: x - display.x, y: y - display.y },
    target: { x: target.x - display.x, y: target.y - display.y },
    perch,
    size: height,
  };
}
