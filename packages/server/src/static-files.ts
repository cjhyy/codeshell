// packages/server/src/static-files.ts
//
// Shared static-file primitives for the two HTTP hosts (pairing host's
// /mobile static root and the headless serve SPA root). Keep this file free
// of host wiring — MIME map + helpers only.
import { constants } from "node:fs";
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
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Static asset is not a regular file");
    const currentPath = await realpath(options.filePath);
    const current = await stat(currentPath);
    if (
      !contained(currentPath) ||
      (await realpath(options.rootDir)) !== root ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    )
      throw new Error("Static asset changed while opening");
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, {
      "content-type": contentTypeFor(extname(options.filePath)),
      "content-length": info.size,
      "cache-control": options.cacheControl,
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD" || info.size === 0) {
      res.end();
      return;
    }
    // pipeline propagates backpressure and destroys the source on disconnect.
    // The explicit end prevents a growing file from extending this response.
    await pipeline(
      handle.createReadStream({ autoClose: false, start: 0, end: info.size - 1 }),
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
