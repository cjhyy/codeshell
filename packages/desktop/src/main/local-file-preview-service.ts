import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { FileContent } from "./fs-service.js";

export interface LocalFilePreview extends FileContent {
  imageDataUrl?: string;
}

const MAX_TEXT_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

function assertAbsoluteFilePath(path: unknown): asserts path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 32_768 ||
    path.includes("\0") ||
    !isAbsolute(path)
  ) {
    throw new Error("Local file preview requires a bounded absolute path");
  }
}

/** Metadata only: passive transcript links never read the target's contents. */
export async function localFileExists(path: unknown): Promise<boolean> {
  try {
    assertAbsoluteFilePath(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * A single file explicitly opened by the Desktop user. This does not authorize
 * its parent directory, register a project root, or widen passive media reads.
 */
export async function readLocalFilePreview(path: unknown): Promise<LocalFilePreview> {
  assertAbsoluteFilePath(path);
  const requestedPath = path;
  const canonicalPath = await realpath(path);
  // Nonblocking open also prevents a raced replacement with a FIFO from hanging
  // Main; the descriptor check below rejects every non-regular file.
  const file = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Local file preview requires a regular file");
    const mime = IMAGE_MIME[extname(requestedPath).toLowerCase()];
    const limit = mime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (info.size > limit) {
      return { path: canonicalPath, text: null, reason: "too-large", size: info.size };
    }
    // Cap the actual read as well as the stat result, even if a file grows while
    // it is open. Reading one extra byte detects that race without unbounded IO.
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error("Local file changed while reading; refresh to retry");
    const contents = buffer.subarray(0, length);
    if (mime) {
      return {
        path: canonicalPath,
        text: null,
        reason: "binary",
        size: length,
        imageDataUrl: `data:${mime};base64,${contents.toString("base64")}`,
      };
    }
    if (contents.subarray(0, 8192).includes(0)) {
      return { path: canonicalPath, text: null, reason: "binary", size: length };
    }
    return { path: canonicalPath, text: contents.toString("utf8"), size: length };
  } finally {
    await file.close();
  }
}
