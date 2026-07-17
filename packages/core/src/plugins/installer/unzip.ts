import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { PluginInstallError } from "./types.js";
import type { ZipFile, Entry } from "yauzl";

// yauzl is CommonJS; this module compiles to ESM (tsc module: ESNext, package
// type: module). A bare `require('yauzl')` throws "require is not defined", so
// go through createRequire — same pattern as utils/lockfile.ts.
type Yauzl = typeof import("yauzl");
export const MAX_PLUGIN_ZIP_BYTES = 128 * 1024 * 1024;
export const MAX_PLUGIN_ZIP_ENTRIES = 10_000;
export const MAX_PLUGIN_ZIP_EXTRACTED_BYTES = 256 * 1024 * 1024;
export const MAX_PLUGIN_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_PLUGIN_ZIP_ENTRY_NAME = 1_024;

let _yauzl: Yauzl | undefined;
function yauzl(): Yauzl {
  if (!_yauzl) {
    _yauzl = createRequire(import.meta.url ?? __filename)("yauzl") as Yauzl;
  }
  return _yauzl;
}

/**
 * Reject path traversal ("zip slip"): a malicious archive can carry entries
 * like `../../etc/foo` that escape the extraction root. We normalize and
 * require the resolved path to stay within `destDir`.
 */
export function safeJoin(destDir: string, entryName: string): string {
  if (
    entryName.length === 0 ||
    entryName.length > MAX_PLUGIN_ZIP_ENTRY_NAME ||
    entryName.includes("\0") ||
    entryName.includes("\\") ||
    entryName.startsWith("/") ||
    /^[A-Za-z]:/.test(entryName)
  ) {
    throw new PluginInstallError(`refusing unsafe zip entry name: ${entryName}`);
  }
  // Zip entries always use forward slashes; normalize to the host separator.
  const target = normalize(join(destDir, entryName));
  const root = normalize(destDir.endsWith(sep) ? destDir : destDir + sep);
  if (target !== normalize(destDir) && !target.startsWith(root)) {
    throw new PluginInstallError(`refusing zip entry that escapes target: ${entryName}`);
  }
  return target;
}

/**
 * Extract a .zip into destDir (must already exist). Streams each entry to disk
 * so a large archive doesn't buffer in memory. Directory entries (trailing
 * "/") just create the dir; symlinks and other special entries are skipped —
 * we only materialize regular files and directories, which is all a plugin
 * needs and keeps the surface safe.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const archive = await stat(zipPath);
  if (!archive.isFile() || archive.size > MAX_PLUGIN_ZIP_BYTES) {
    throw new PluginInstallError(
      `plugin zip must be a regular file no larger than ${MAX_PLUGIN_ZIP_BYTES} bytes`,
    );
  }
  const zip = await openZip(zipPath);
  try {
    await drainEntries(zip, destDir);
  } finally {
    zip.close();
  }
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl().open(zipPath, { lazyEntries: true }, (err, z) => {
      if (err || !z) {
        reject(new PluginInstallError(`cannot open zip: ${err?.message ?? "unknown"}`));
        return;
      }
      resolve(z);
    });
  });
}

function drainEntries(zip: ZipFile, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let entryCount = 0;
    let extractedBytes = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry: Entry) => {
      entryCount += 1;
      if (entryCount > MAX_PLUGIN_ZIP_ENTRIES) {
        fail(
          new PluginInstallError(`plugin zip contains more than ${MAX_PLUGIN_ZIP_ENTRIES} entries`),
        );
        return;
      }
      if (
        entry.fileName.length > MAX_PLUGIN_ZIP_ENTRY_NAME ||
        entry.uncompressedSize > MAX_PLUGIN_ZIP_ENTRY_BYTES
      ) {
        fail(
          new PluginInstallError(
            `plugin zip entry exceeds preview/install limits: ${entry.fileName}`,
          ),
        );
        return;
      }
      extractedBytes += entry.uncompressedSize;
      if (extractedBytes > MAX_PLUGIN_ZIP_EXTRACTED_BYTES) {
        fail(
          new PluginInstallError(
            `plugin zip expands beyond ${MAX_PLUGIN_ZIP_EXTRACTED_BYTES} bytes`,
          ),
        );
        return;
      }
      const onErr = (e: unknown): void => fail(e);
      // Directory entry — yauzl signals these with a trailing slash.
      if (/\/$/.test(entry.fileName)) {
        mkdir(safeJoin(destDir, entry.fileName), { recursive: true })
          .then(() => zip.readEntry())
          .catch(onErr);
        return;
      }
      const outPath = safeJoin(destDir, entry.fileName);
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          onErr(
            new PluginInstallError(
              `cannot read zip entry ${entry.fileName}: ${err?.message ?? "unknown"}`,
            ),
          );
          return;
        }
        mkdir(dirname(outPath), { recursive: true })
          .then(() => pipeline(stream, createWriteStream(outPath)))
          .then(() => zip.readEntry())
          .catch(onErr);
      });
    });
    zip.readEntry();
  });
}
