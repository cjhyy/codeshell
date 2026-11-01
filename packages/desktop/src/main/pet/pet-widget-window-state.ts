import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { codeShellHome } from "@cjhyy/code-shell-core";
import {
  sanitizePetWidgetWindowPosition,
  type PetWidgetWindowPosition,
} from "./pet-widget-geometry.js";

export * from "./pet-widget-geometry.js";

let positionWriteQueue = Promise.resolve();

/**
 * Legacy docked position file. Since the unified Mimi presence owner it is only
 * read once for migration into mimi-presence.json and left in place for rollback.
 */
export function petWidgetWindowStatePath(): string {
  return path.join(codeShellHome(), "desktop", "pet-widget.json");
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
