import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PanelAppPackagePinSchema, type PanelAppPackagePin } from "./bindings.js";
import {
  assertSafePanelAppId,
  panelAppInstallDir,
  panelAppsRoot,
  PanelAppInstallError,
} from "./paths.js";

const Baseline = z
  .object({ schemaVersion: z.literal(1), pin: PanelAppPackagePinSchema.nullable() })
  .strict();
const MAX_BYTES = 4096;
function location(id: string): string {
  assertSafePanelAppId(id);
  return join(panelAppsRoot(), ".versions", id, "legacy-projects.json");
}
function checkedParents(id: string): void {
  for (const directory of [
    panelAppsRoot(),
    join(panelAppsRoot(), ".versions"),
    dirname(location(id)),
  ]) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new PanelAppInstallError("Legacy Panel package store requires ordinary directories");
  }
}

/** Undefined: not captured yet. Null: the old bytes could not be recovered; never use latest. */
export function readLegacyPanelAppPackagePin(id: string): PanelAppPackagePin | null | undefined {
  let fd: number | undefined;
  try {
    checkedParents(id);
    const path = location(id),
      info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES)
      throw new PanelAppInstallError(
        "Legacy Panel package baseline must be a bounded regular file",
      );
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_BYTES)
      throw new PanelAppInstallError("Legacy Panel package baseline is too large");
    return Baseline.parse(JSON.parse(readFileSync(fd, "utf8"))).pin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The installed metadata mirrors the baseline so a partial restore cannot select latest.
 * Absence in an old pre-migration installation is still legitimate.
 */
export function legacyPanelAppPackageSelection(id: string): PanelAppPackagePin | null | undefined {
  const saved = readLegacyPanelAppPackagePin(id);
  if (saved !== undefined) return saved;
  let fd: number | undefined;
  try {
    const directory = panelAppInstallDir(id);
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new PanelAppInstallError("Legacy Panel catalog must be an ordinary directory");
    const path = join(directory, ".cs-panel-app-meta.json");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
      throw new PanelAppInstallError(
        "Legacy Panel catalog metadata must be a bounded regular file",
      );
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 64 * 1024)
      throw new PanelAppInstallError("Legacy Panel catalog metadata is too large");
    const metadata = JSON.parse(readFileSync(fd, "utf8"));
    return z
      .object({ legacyProjectPin: PanelAppPackagePinSchema.nullable().optional() })
      .parse(metadata).legacyProjectPin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Caller holds the per-app installer mutation lock and has published the retained bytes.
 * First record wins forever, including across uninstall/reinstall. Project pins override it.
 */
export async function rememberLegacyPanelAppPackagePin(
  id: string,
  pin: PanelAppPackagePin | null,
): Promise<void> {
  if (readLegacyPanelAppPackagePin(id) !== undefined) return;
  await mkdir(dirname(location(id)), { recursive: true, mode: 0o700 });
  checkedParents(id);
  const path = location(id),
    temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(Baseline.parse({ schemaVersion: 1, pin })) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    checkedParents(id);
    if (readLegacyPanelAppPackagePin(id) === undefined) await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
