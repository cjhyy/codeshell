/* Pure geometry for the native Mimi acceptance scripts (no Electron, no I/O).
 * All coordinates are global Electron DIP (= macOS points, origin at the
 * primary display's top-left, y down), the same space CGWindowList reports.
 * The constants mirror the production modules named beside them; the unit test
 * pins them to those sources so a product change cannot silently drift here.
 */

/** pet-widget-geometry.ts */
export const DOCKED_SIZE = 112;
export const DOCKED_MARGIN = 12;
export const DOCKED_EXPANDED = { width: 400, height: 380 };
/** mimi-presence-state.ts: the 96×96 pet image is centred in the 112 anchor. */
const DOCKED_FEET = { x: DOCKED_SIZE / 2, y: DOCKED_SIZE - (DOCKED_SIZE - 96) / 2 };
/** shared/mimi-companion.ts */
export const COMPANION_SPRITE_BOTTOM = 25;
export const COMPANION_CELL = { width: 192, height: 208, feetY: 203 };
/** In an ordinary Space macOS keeps a panel below that display's menu bar. */
export const MENU_BAR_ALLOWANCE = 64;

const rectOf = (value) => value.bounds ?? value;

export function containsPoint(rect, point) {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

export function center(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Index of the display whose bounds contain the rect's centre, or -1. */
export function displayIndexOf(rect, displays) {
  const point = center(rect);
  return displays.findIndex((display) => containsPoint(rectOf(display), point));
}

/**
 * Classify one owned on-screen window. Docked is 112×112 or 400×380. Moving is
 * one display's full width and height above the normal layer, at that display's
 * x and at or just below its top. Every display is tried, so a stale moving
 * window on another screen, same-size screens and negative origins all count.
 */
export function classifyOwnedWindow(win, displays) {
  if (win.alpha !== undefined && win.alpha <= 0) return null;
  if (
    (win.width === DOCKED_SIZE && win.height === DOCKED_SIZE) ||
    (win.width === DOCKED_EXPANDED.width && win.height === DOCKED_EXPANDED.height)
  )
    return "docked";
  if (
    win.layer > 0 &&
    displays.some((display) => {
      const b = rectOf(display);
      return (
        b.x === win.x &&
        b.width === win.width &&
        b.height === win.height &&
        win.y >= b.y &&
        win.y - b.y <= MENU_BAR_ALLOWANCE
      );
    })
  )
    return "moving";
  return null;
}

/** An owned layer>0 surface big enough to be a character but not classified. */
export function isUnclassifiedLarge(win, displays) {
  return (
    (win.alpha === undefined || win.alpha > 0) &&
    win.layer > 0 &&
    win.width >= 300 &&
    win.height >= 300 &&
    classifyOwnedWindow(win, displays) === null
  );
}

/** clampPetWidgetWindowPosition for the collapsed widget. */
export function clampDockedAnchor(anchor, workArea) {
  const minX = workArea.x + DOCKED_MARGIN;
  const minY = workArea.y + DOCKED_MARGIN;
  const maxX = Math.max(minX, workArea.x + workArea.width - DOCKED_SIZE - DOCKED_MARGIN);
  const maxY = Math.max(minY, workArea.y + workArea.height - DOCKED_SIZE - DOCKED_MARGIN);
  return {
    x: Math.max(minX, Math.min(Math.round(anchor.x), maxX)),
    y: Math.max(minY, Math.min(Math.round(anchor.y), maxY)),
  };
}

/** mimi-companion-host normalizeAnchor / onMove: box (0.7·h × h) inside the work area. */
export function clampMovingAnchor(anchor, workArea, height) {
  return {
    x: Math.round(
      Math.max(workArea.x, Math.min(workArea.x + workArea.width - height * 0.7, anchor.x)),
    ),
    y: Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, anchor.y))),
  };
}

export function companionFeetOffset(height) {
  const sprite = (height * 0.7 * COMPANION_CELL.height) / COMPANION_CELL.width;
  return (
    COMPANION_SPRITE_BOTTOM +
    (sprite * (COMPANION_CELL.height - COMPANION_CELL.feetY)) / COMPANION_CELL.height
  );
}

export const dockedFeet = (anchor) => ({
  x: anchor.x + DOCKED_FEET.x,
  y: anchor.y + DOCKED_FEET.y,
});
export const dockedAnchorForFeet = (feet) => ({
  x: Math.round(feet.x - DOCKED_FEET.x),
  y: Math.round(feet.y - DOCKED_FEET.y),
});
export const movingFeet = (anchor, height) => ({
  x: anchor.x + height * 0.35,
  y: anchor.y + height - companionFeetOffset(height),
});
export const movingAnchorForFeet = (feet, height) => ({
  x: Math.round(feet.x - height * 0.35),
  y: Math.round(feet.y - height + companionFeetOffset(height)),
});

/** Is the docked anchor inside the work area with the widget's margin? */
export function dockedInside(anchor, workArea) {
  const clamped = clampDockedAnchor(anchor, workArea);
  return clamped.x === anchor.x && clamped.y === anchor.y;
}

/** Is the moving character box inside the work area (±1 DIP for rounding)? */
export function movingInside(anchor, workArea, height) {
  return (
    anchor.x >= workArea.x - 1 &&
    anchor.y >= workArea.y - 1 &&
    anchor.x + height * 0.7 <= workArea.x + workArea.width + 1 &&
    anchor.y + height <= workArea.y + workArea.height + 1
  );
}

/**
 * Opaque-pixel box of a per-window capture → global DIP, using the capture's
 * own pixel/point ratio (the backing scale of the display the window is on).
 */
export function pixelBoxToGlobal(capture, windowRect) {
  const scale = capture.width / windowRect.width;
  if (!capture.box) return { scale, box: null };
  const box = {
    left: windowRect.x + capture.box.left / scale,
    top: windowRect.y + capture.box.top / scale,
    right: windowRect.x + (capture.box.right + 1) / scale,
    bottom: windowRect.y + (capture.box.bottom + 1) / scale,
  };
  return {
    scale,
    box,
    width: box.right - box.left,
    height: box.bottom - box.top,
    footCenter: { x: (box.left + box.right) / 2, y: box.bottom },
  };
}

/** Nearest display to a point the way Electron picks it (inside wins, else distance). */
export function nearestDisplay(point, displays) {
  let best;
  let bestDistance = Infinity;
  for (const display of displays) {
    const b = rectOf(display);
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width - 1));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height - 1));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}
