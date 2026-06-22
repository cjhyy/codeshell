import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { PluginInstallError } from "./types.js";
import type { ZipFile, Entry } from "yauzl";

// yauzl is CommonJS; this module compiles to ESM (tsc module: ESNext, package
// type: module). A bare `require('yauzl')` throws "require is not defined", so
// go through createRequire — same pattern as utils/lockfile.ts.
type Yauzl = typeof import("yauzl");
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
    zip.on("error", (e) => reject(e));
    zip.on("end", () => resolve());
    zip.on("entry", (entry: Entry) => {
      const onErr = (e: unknown): void => reject(e);
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
          onErr(new PluginInstallError(`cannot read zip entry ${entry.fileName}: ${err?.message ?? "unknown"}`));
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
