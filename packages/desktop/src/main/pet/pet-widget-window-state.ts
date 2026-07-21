import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { codeShellHome } from "@cjhyy/code-shell-core";

export const PET_WIDGET_WINDOW_SIZE = 112;
export const PET_WIDGET_WINDOW_MARGIN = 12;
export const PET_WIDGET_EXPANDED_WIDTH = 400;
// 268px chat bubble + 112px pet anchor: keep the two interactive surfaces
// adjacent instead of stacking the pet on top of the composer.
export const PET_WIDGET_EXPANDED_HEIGHT = 380;

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

export function shouldSkipPetWidgetTaskbar(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

let positionWriteQueue = Promise.resolve();

export function petWidgetWindowStatePath(): string {
  return path.join(codeShellHome(), "desktop", "pet-widget.json");
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

export async function loadPetWidgetWindowPosition(): Promise<PetWidgetWindowPosition | null> {
  const file = petWidgetWindowStatePath();
  try {
    return sanitizePetWidgetWindowPosition(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

export function savePetWidgetWindowPosition(position: PetWidgetWindowPosition): Promise<void> {
  const snapshot = sanitizePetWidgetWindowPosition(position);
  if (!snapshot) return Promise.resolve();
  const write = positionWriteQueue.then(async () => {
    const file = petWidgetWindowStatePath();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });
  // Preserve call order even when one best-effort write fails. The returned
  // promise also resolves so drag/close paths never surface persistence errors.
  positionWriteQueue = write.catch(() => {});
  return write.catch(() => {});
}
