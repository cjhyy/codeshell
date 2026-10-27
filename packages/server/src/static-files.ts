// packages/server/src/static-files.ts
//
// Shared static-file primitives for the two HTTP hosts (pairing host's
// /mobile static root and the headless serve SPA root). Keep this file free
// of host wiring — MIME map + helpers only.
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export function contentTypeFor(extname: string): string {
  return CONTENT_TYPES[extname.toLowerCase()] ?? "application/octet-stream";
}

/** RFC 9110 entity-tag lists allow commas inside opaque tags and empty list items. */
function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  if (typeof value !== "string") return false;
  const header = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (header === "*") return true;
  const tag = /(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")/y;
  const opaque = etag.slice(2);
  let position = 0;
  let matches = false;
  while (position < header.length) {
    while (/[ \t,]/.test(header[position] ?? "") && position < header.length) position++;
    if (position === header.length) break;
    tag.lastIndex = position;
    const item = tag.exec(header);
    if (!item) return false;
    matches ||= item[1] === opaque;
    position = tag.lastIndex;
    while (/[ \t]/.test(header[position] ?? "") && position < header.length) position++;
    if (position < header.length && header[position++] !== ",") return false;
  }
  // Validate the entire field before accepting a match, including later items.
  return matches;
}

/** Stream a pinned regular file, bounded by its opened size and the response lifetime. */
export async function streamStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  options: { rootDir: string; filePath: string; cacheControl: string },
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    if (res.destroyed || res.writableEnded) return;
    const root = await realpath(options.rootDir);
    const path = await realpath(options.filePath);
    const contained = (target: string) => {
      const rel = relative(root, target);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    if (!contained(path)) throw new Error("Static asset is outside its root");
    // Resolve aliases before opening so valid in-root symlinks remain supported.
    // O_NONBLOCK avoids hanging on a regular file replaced by a FIFO.
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error("Static asset is not a regular file");
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Static asset is too large");
    const currentPath = await realpath(options.filePath);
    const current = await stat(currentPath, { bigint: true });
    if (
      !contained(currentPath) ||
      (await realpath(options.rootDir)) !== root ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.size !== info.size ||
      current.mtimeNs !== info.mtimeNs ||
      current.ctimeNs !== info.ctimeNs
    )
      throw new Error("Static asset changed while opening");
    if (res.destroyed || res.writableEnded) return;
    // A weak validator describes the opened file's metadata, not a byte hash.
    // Include identity and change time so replacement or an equal-size rewrite
    // with a restored mtime does not reuse the previous representation's tag.
    const fingerprint = createHash("sha256")
      .update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
      .digest("base64url");
    const etag = `W/"${fingerprint}"`;
    const headers = {
      "content-type": contentTypeFor(extname(options.filePath)),
      "cache-control": options.cacheControl,
      "x-content-type-options": "nosniff",
      etag,
    };
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      matchesIfNoneMatch(req.headers["if-none-match"], etag)
    ) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, "content-length": info.size.toString() });
    if (req.method === "HEAD" || info.size === 0n) {
      res.end();
      return;
    }
    // pipeline propagates backpressure and destroys the source on disconnect.
    // The explicit end prevents a growing file from extending this response.
    await pipeline(
      handle.createReadStream({ autoClose: false, start: 0, end: Number(info.size - 1n) }),
      res,
    );
  } catch {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  } finally {
    await handle?.close().catch(() => {
      if (!res.destroyed) res.destroy();
    });
  }
}
