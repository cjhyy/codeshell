import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const PET_WIDGET_WINDOW_SIZE = 112;
export const PET_WIDGET_WINDOW_MARGIN = 12;
export const PET_WIDGET_EXPANDED_WIDTH = 400;
// 268px chat bubble + 112px pet anchor: keep the two interactive surfaces
// adjacent instead of stacking the pet on top of the composer.
export const PET_WIDGET_EXPANDED_HEIGHT = 380;

export interface PetWidgetWindowPosition {
  x: number;
  y: number;
}

export interface PetWidgetWorkArea extends PetWidgetWindowPosition {
  width: number;
  height: number;
}

export function shouldSkipPetWidgetTaskbar(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

const FILE = path.join(os.homedir(), ".code-shell", "desktop", "pet-widget.json");

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
  // `position` is always the 112×112 pet anchor. An expanded speech bubble
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

export async function loadPetWidgetWindowPosition(): Promise<PetWidgetWindowPosition | null> {
  try {
    return sanitizePetWidgetWindowPosition(JSON.parse(await fs.readFile(FILE, "utf8")));
  } catch {
    return null;
  }
}

export async function savePetWidgetWindowPosition(
  position: PetWidgetWindowPosition,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(position, null, 2), "utf8");
  } catch {
    // Best effort: the current desktop window can still be dragged.
  }
}
