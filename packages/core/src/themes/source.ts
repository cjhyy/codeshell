import { lstat, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { extname, join } from "node:path";
import { extractZip } from "../plugins/installer/unzip.js";
import { ThemeInstallError } from "./paths.js";

const MANIFEST_FILE = ".cs-theme.json";
const MAX_SOURCE_PATH = 4096;

/** Relative containment also rejects Windows paths on a different volume. */
export function isThemePathWithinRoot(
  root: string,
  target: string,
  paths: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep"> = nodePath,
): boolean {
  const relativePath = paths.relative(root, target);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relativePath)
  );
}

async function hasManifest(directory: string): Promise<boolean> {
  try {
    const metadata = await lstat(join(directory, MANIFEST_FILE));
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function findThemeRoot(directory: string): Promise<string> {
  if (await hasManifest(directory)) return directory;
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === "__MACOSX" ||
      entry.name === ".DS_Store" ||
      entry.name.startsWith("._")
    ) {
      continue;
    }
    const nested = join(directory, entry.name);
    if (await hasManifest(nested)) candidates.push(nested);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new ThemeInstallError("theme source contains multiple theme packs; select one theme");
  }
  throw new ThemeInstallError(
    `missing ${MANIFEST_FILE} at the theme root or in a single wrapping folder`,
  );
}

/**
 * Open a local directory or ZIP for one operation. ZIP previews and installs
 * each use their own bounded extraction, removed before the operation returns;
 * no source files need to survive a cancelled review or a closed window.
 */
export async function withLocalThemeSourceRoot<T>(
  sourcePath: string,
  operation: (root: string) => Promise<T>,
): Promise<T> {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length === 0 ||
    sourcePath.length > MAX_SOURCE_PATH ||
    sourcePath.includes("\0")
  ) {
    throw new ThemeInstallError("theme source path is invalid");
  }
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(sourcePath);
  } catch {
    throw new ThemeInstallError("theme source was not found");
  }
  if (metadata.isDirectory()) {
    return operation(await findThemeRoot(await realpath(sourcePath)));
  }
  if (!metadata.isFile() || extname(sourcePath).toLowerCase() !== ".zip") {
    throw new ThemeInstallError("theme source must be a directory or a ZIP file");
  }
  const temporary = await mkdtemp(join(tmpdir(), "cs-theme-zip-"));
  try {
    try {
      await extractZip(sourcePath, temporary);
    } catch (error) {
      throw new ThemeInstallError(
        `cannot load theme ZIP: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return await operation(await findThemeRoot(temporary));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
