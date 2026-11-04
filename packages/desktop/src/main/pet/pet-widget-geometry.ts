/** Pure docked-widget geometry and window-level policy (no Electron, no Core). */
export const PET_WIDGET_WINDOW_SIZE = 112;
export const PET_WIDGET_WINDOW_MARGIN = 12;
/** The chat box (renderer `PetDesktopWindow`), shared by the docked widget and the bubble. */
export const PET_CHAT_BOX = { width: 420, height: 400 } as const;
export const PET_WIDGET_EXPANDED_WIDTH = PET_CHAT_BOX.width + 20;
// Chat box + 112px pet anchor: keep the two interactive surfaces adjacent
// instead of stacking the pet on top of the composer.
export const PET_WIDGET_EXPANDED_HEIGHT = PET_CHAT_BOX.height + PET_WIDGET_WINDOW_SIZE;

export type PetWidgetSurfaceMode = "collapsed" | "expanded";

export function petWidgetSurface(mode: PetWidgetSurfaceMode): { width: number; height: number } {
  switch (mode) {
    case "expanded":
      return { width: PET_WIDGET_EXPANDED_WIDTH, height: PET_WIDGET_EXPANDED_HEIGHT };
    default:
      return { width: PET_WIDGET_WINDOW_SIZE, height: PET_WIDGET_WINDOW_SIZE };
  }
}

export interface PetWidgetWindowPosition {
  x: number;
  y: number;
}

export interface PetWidgetWorkArea extends PetWidgetWindowPosition {
  width: number;
  height: number;
}

export type PetWidgetAlwaysOnTopLevel = "floating" | "screen-saver";

export function petWidgetAlwaysOnTopLevel(
  platform: NodeJS.Platform,
  focused = false,
): PetWidgetAlwaysOnTopLevel {
  // Electron's default `floating` level can still fall behind other apps on
  // macOS. `screen-saver` is the closest BrowserWindow equivalent to the
  // native overlay panel used by desktop pets such as Codex's. While the user
  // types into Mimi her window is the key window, so `floating` is enough, and
  // `screen-saver` would cover the input method's candidate window.
  return platform === "darwin" && !focused ? "screen-saver" : "floating";
}

export function shouldSkipPetWidgetTaskbar(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

export function sanitizePetWidgetWindowPosition(value: unknown): PetWidgetWindowPosition | null {
  if (!value || typeof value !== "object") return null;
  const position = value as Partial<PetWidgetWindowPosition>;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  return { x: Math.round(position.x!), y: Math.round(position.y!) };
}

export function clampPetWidgetWindowPosition(
  position: PetWidgetWindowPosition,
  workArea: PetWidgetWorkArea,
  surface: { width: number; height: number } = {
    width: PET_WIDGET_WINDOW_SIZE,
    height: PET_WIDGET_WINDOW_SIZE,
  },
): PetWidgetWindowPosition {
  // `position` is always the 112×112 pet anchor. Expanded chat/activity content
  // grows to its left/top, so keep enough room for the entire transparent
  // surface while still persisting one stable pet coordinate.
  const minX =
    workArea.x + Math.max(0, surface.width - PET_WIDGET_WINDOW_SIZE) + PET_WIDGET_WINDOW_MARGIN;
  const minY =
    workArea.y + Math.max(0, surface.height - PET_WIDGET_WINDOW_SIZE) + PET_WIDGET_WINDOW_MARGIN;
  const maxX = Math.max(
    minX,
    workArea.x + workArea.width - PET_WIDGET_WINDOW_SIZE - PET_WIDGET_WINDOW_MARGIN,
  );
  const maxY = Math.max(
    minY,
    workArea.y + workArea.height - PET_WIDGET_WINDOW_SIZE - PET_WIDGET_WINDOW_MARGIN,
  );
  return {
    x: Math.max(minX, Math.min(Math.round(position.x), maxX)),
    y: Math.max(minY, Math.min(Math.round(position.y), maxY)),
  };
}

export function defaultPetWidgetWindowPosition(
  workArea: PetWidgetWorkArea,
): PetWidgetWindowPosition {
  return clampPetWidgetWindowPosition(
    {
      x: workArea.x + workArea.width - PET_WIDGET_WINDOW_SIZE - 24,
      y: workArea.y + workArea.height - PET_WIDGET_WINDOW_SIZE - 24,
    },
    workArea,
  );
}
